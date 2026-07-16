import 'dotenv/config';

import { spawn, execFile as _execFile } from 'node:child_process';
import util from 'node:util';
const execFile = util.promisify(_execFile);
import readline from 'node:readline';

import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createHash } from 'node:crypto';

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '50mb' }));

// Express 4 does not automatically forward rejected promises from async route
// handlers. Register routes through this wrapper so validation and runtime
// failures reach the central error handler instead of terminating Node.js.
function asyncHandler(handler) {
  return function wrappedAsyncHandler(req, res, next) {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (err) {
      next(err);
    }
  };
}

const route = Object.fromEntries(
  ['get', 'post', 'put', 'patch', 'delete'].map((method) => [
    method,
    (routePath, ...handlers) => app[method](
      routePath,
      ...handlers.map((handler) => asyncHandler(handler)),
    ),
  ]),
);

// --- CORS ---
const defaultAllowedOrigins = [
  'http://127.0.0.1:3000',
  'http://localhost:3000',
];
const configuredAllowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = configuredAllowedOrigins.length > 0
  ? configuredAllowedOrigins
  : defaultAllowedOrigins;
app.use(cors({ origin: allowedOrigins }));

// --- Rate limiter ---
app.use(
  '/api/',
  rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false }),
);

// --- API key auth ---
const API_KEY = process.env.API_KEY || '';
function authMiddleware(req, res, next) {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ ok: false, message: 'Unauthorized: invalid or missing x-api-key' });
  }
  next();
}
app.use('/api/', authMiddleware);

const projectRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(projectRoot, '..');
const pipelineRoot = process.env.PIPELINE_ROOT
  ? path.resolve(process.env.PIPELINE_ROOT)
  : workspaceRoot;
const tasksRoot = process.env.PIPELINE_TASKS_ROOT
  ? path.resolve(process.env.PIPELINE_TASKS_ROOT)
  : path.join(workspaceRoot, 'tasks');
const defaultWorkDir = process.env.PIPELINE_WORK_DIR
  ? path.resolve(process.env.PIPELINE_WORK_DIR)
  : path.join(tasksRoot, 'default');

const RESERVED_TASK_IDS = new Set(['default', 'hmmer-default', 'blast-default']);

const pythonBin = process.env.PIPELINE_PYTHON || process.env.PYTHON_BIN || 'python3';
const mmseqsBin = process.env.MMSEQS_BIN || 'mmseqs';
const mmseqsThreadsRaw = Number(process.env.MMSEQS_THREADS || 8);
const mmseqsThreads = Number.isFinite(mmseqsThreadsRaw)
  ? Math.max(1, Math.floor(mmseqsThreadsRaw))
  : 8;
const apiHost = String(process.env.API_HOST || '127.0.0.1').trim() || '127.0.0.1';
const apiPort = Number(process.env.API_PORT || 8787);
const runtimeStaleMs = Number(process.env.RUNTIME_STALE_MS || 45 * 60 * 1000);
const uniprotFillTimeoutMs = Number(process.env.UNIPROT_FILL_TIMEOUT_MS || 30 * 60 * 1000);
const ebiSearchUrl = 'https://www.ebi.ac.uk/Tools/hmmer/api/v1/search/hmmsearch';
const ebiResultUrl = 'https://www.ebi.ac.uk/Tools/hmmer/api/v1/result';
const ebiDatabasesUrl = process.env.EBI_HMMER_DATABASES_URL || 'https://www.ebi.ac.uk/Tools/hmmer/api/v1/search/databases';
const ebiDatabaseCacheTtlMs = 6 * 60 * 60 * 1000;
let ebiDatabaseCache = { fetchedAt: 0, databases: [] };

// The database metadata endpoint currently omits sequence counts. These values
// were read from result.stats.nseqs after one low-result probe search per exact
// EMBL-EBI database release on 2026-07-16. Keying by id + version prevents a
// future release from inheriting a stale count.
const ebiDatabaseSequenceCountsByRelease = new Map([
  ['refprot@2025_01', 89_460_830],
  ['swissprot@2025_01', 503_053],
  ['uniprot@2025_01', 245_001_337],
  ['pdb@03.25', 170_694],
  ['rp15@2024_04', 5_866_326],
  ['rp35@2024_04', 14_873_234],
  ['rp55@2024_04', 27_065_347],
  ['rp75@2024_04', 37_698_713],
  ['mgnify30_c2@2026_07', 128_674_267],
  ['mgnify30_c5_fl@2026_07', 20_911_652],
  ['mgnify30_c5_ppfam@2026_07', 18_155_509],
]);

const uniprotSeqCache = new Map();
const runtimeContext = new AsyncLocalStorage();

const runtimeStates = new Map();

function getRuntimeState(taskId = 'default') {
  if (!runtimeStates.has(taskId)) {
    runtimeStates.set(taskId, {
      active: false,
      task: 'idle',
      startedAt: null,
      updatedAt: null,
      lines: [],
      meta: {},
    });
  }
  return runtimeStates.get(taskId);
}

function getCurrentTaskId() {
  return runtimeContext.getStore()?.taskId || 'default';
}

function normalizeTaskId(raw) {
  const taskId = String(raw || '').trim().toLowerCase();
  if (!taskId) {
    return 'default';
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(taskId)) {
    const err = new Error('Invalid taskId, only [a-z0-9_-] is allowed and max length is 64');
    err.status = 400;
    throw err;
  }
  return taskId;
}

function generateTaskId() {
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 7);
  return `task-${ts}-${rand}`;
}

function getTaskIdFromReq(req) {
  const raw = req.query?.taskId || req.headers['x-task-id'] || req.body?.taskId;
  return normalizeTaskId(raw);
}

async function runInTaskContext(taskId, fn) {
  return runtimeContext.run({ taskId }, fn);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

function createHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Resolve a path for a boundary check while following any existing symlinked
 * parent directories. This also protects paths whose final file does not yet
 * exist.
 */
function resolveRealPathForBoundaryCheck(targetPath) {
  const absoluteTarget = path.resolve(targetPath);
  let existingAncestor = absoluteTarget;
  while (!fsSync.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const realAncestor = fsSync.realpathSync(existingAncestor);
  return path.resolve(realAncestor, path.relative(existingAncestor, absoluteTarget));
}

/** Assert that a path remains inside an allowed directory after symlink resolution. */
function assertPathInsideDir(resolvedPath, allowedDir) {
  const realAllowed = fsSync.realpathSync(allowedDir);
  const realTarget = resolveRealPathForBoundaryCheck(resolvedPath);
  const relative = path.relative(realAllowed, realTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw createHttpError(400, `Path outside allowed directory: ${resolvedPath}`);
  }
  return realTarget;
}

/**
 * Resolve a user-supplied input path. Cross-task inputs remain supported, but
 * access is limited to tasksRoot rather than the whole project workspace.
 */
function resolveAndValidatePath(userPath, workDir, defaultPath) {
  const resolved = userPath
    ? (path.isAbsolute(String(userPath)) ? path.resolve(String(userPath)) : path.resolve(workDir, String(userPath)))
    : path.resolve(defaultPath);
  assertPathInsideDir(resolved, tasksRoot);
  return resolved;
}

function normalizeFilePrefix(raw, fallback = 'ref') {
  const prefix = String(raw || fallback).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(prefix)) {
    throw createHttpError(400, 'prefix may only contain letters, numbers, _ or - and must be at most 64 characters');
  }
  return prefix;
}

function resolveTaskArtifactPath(userPath, workDir, defaultName, allowedNames) {
  const resolved = userPath
    ? (path.isAbsolute(String(userPath)) ? path.resolve(String(userPath)) : path.resolve(workDir, String(userPath)))
    : path.join(workDir, defaultName);
  assertPathInsideDir(resolved, workDir);
  if (!allowedNames.includes(path.basename(resolved))) {
    throw createHttpError(400, `Unsupported artifact: ${path.basename(resolved)}`);
  }
  return resolved;
}

/** Validate email format. */
function validateEmail(email) {
  if (typeof email !== 'string' || !email) {
    throw new Error('email is required');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Invalid email format');
  }
  if (email.length > 254) {
    throw new Error('Email too long');
  }
  return email;
}

const MAX_CSV_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

async function resolveWorkDirByTaskId(taskId) {
  const normalizedTaskId = normalizeTaskId(taskId);
  await ensureDir(tasksRoot);
  const workDir = normalizedTaskId === 'default'
    ? defaultWorkDir
    : path.join(tasksRoot, normalizedTaskId);
  assertPathInsideDir(workDir, tasksRoot);
  return ensureDir(workDir);
}

async function resolveWorkDirForReq(req) {
  const taskId = getTaskIdFromReq(req);
  const workDir = await resolveWorkDirByTaskId(taskId);
  return { taskId, workDir };
}

async function listTasks() {
  await resolveWorkDirByTaskId('default');
  // Ensure module-specific default tasks exist
  for (const modDefault of ['hmmer-default', 'blast-default']) {
    const dir = path.join(tasksRoot, modDefault);
    await ensureDir(dir);
    const metaPath = path.join(dir, 'task.json');
    try { await fs.access(metaPath); } catch {
      const mod = modDefault.replace('-default', '');
      await fs.writeFile(metaPath, JSON.stringify({
        id: modDefault,
        createdAt: Date.now(),
        name: `${mod.toUpperCase()} Default`,
        note: '',
        module: mod,
      }, null, 2), 'utf-8');
    }
  }
  const entries = await fs.readdir(tasksRoot, { withFileTypes: true });
  const taskEntries = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const dir = path.join(tasksRoot, e.name);
        const stat = await fs.stat(dir);
        let module = null;
        let name = '';
        try {
          const raw = await fs.readFile(path.join(dir, 'task.json'), 'utf-8');
          const meta = JSON.parse(raw);
          if (meta && typeof meta === 'object') {
            module = meta.module || null;
            name = meta.name || '';
          }
        } catch { /* task.json may not exist for legacy tasks */ }
        return {
          id: e.name,
          workDir: dir,
          module,
          name,
          createdAt: stat.birthtimeMs || stat.ctimeMs || Date.now(),
          updatedAt: stat.mtimeMs || Date.now(),
        };
      }),
  );

  taskEntries.sort((a, b) => b.updatedAt - a.updatedAt);
  return taskEntries;
}

function beginRuntimeTaskOrReject(res, task, taskId) {
  const runtimeState = getRuntimeState(taskId);
  if (runtimeState.active) {
    const lastBeat = Number(runtimeState.updatedAt || runtimeState.startedAt || 0);
    const stale = lastBeat > 0 && Date.now() - lastBeat > runtimeStaleMs;
    if (stale) {
      runtimeState.active = false;
      runtimeState.task = 'idle';
      runtimeState.updatedAt = Date.now();
      pushRuntimeLine('[runtime] stale active lock detected, auto released', taskId);
    }
  }
  if (runtimeState.active) {
    res.status(409).json({
      ok: false,
      message: `Another task is still running: ${runtimeState.task}`,
      details: 'Please wait for the current task to finish before starting a new one.',
    });
    return false;
  }
  startRuntimeTask(task, taskId);
  return true;
}

function pushRuntimeLine(line, taskId = getCurrentTaskId()) {
  if (!line) {
    return;
  }
  const runtimeState = getRuntimeState(taskId);
  const stamp = new Date().toISOString();
  runtimeState.lines.push(`[${stamp}] ${line}`);
  if (runtimeState.lines.length > 1500) {
    runtimeState.lines.splice(0, runtimeState.lines.length - 1500);
  }
  runtimeState.updatedAt = Date.now();
}

function appendRuntimeChunk(prefix, chunk) {
  const text = String(chunk || '');
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.trimEnd())
    .filter(Boolean);
  lines.forEach((line) => pushRuntimeLine(`${prefix} ${line}`));
}

function startRuntimeTask(task, taskId = getCurrentTaskId()) {
  const runtimeState = getRuntimeState(taskId);
  runtimeState.active = true;
  runtimeState.task = task;
  runtimeState.startedAt = Date.now();
  runtimeState.updatedAt = Date.now();
  runtimeState.lines = [];
  runtimeState.meta = {};
  pushRuntimeLine(`[task] ${task} started`, taskId);
}

function finishRuntimeTask(task, ok, taskId = getCurrentTaskId()) {
  const runtimeState = getRuntimeState(taskId);
  pushRuntimeLine(`[task] ${task} ${ok ? 'completed' : 'failed'}`, taskId);
  runtimeState.active = false;
  runtimeState.updatedAt = Date.now();
}

function setRuntimeMeta(patch, taskId = getCurrentTaskId()) {
  const runtimeState = getRuntimeState(taskId);
  runtimeState.meta = {
    ...(runtimeState.meta || {}),
    ...(patch || {}),
  };
  runtimeState.updatedAt = Date.now();
}

function updateNetworkAlignProgress(patch, taskId = getCurrentTaskId()) {
  const runtimeState = getRuntimeState(taskId);
  const prevMeta = runtimeState.meta || {};
  const prevStages = (prevMeta.networkAlignStages && typeof prevMeta.networkAlignStages === 'object')
    ? prevMeta.networkAlignStages
    : {};

  const stageCurrent = Number(patch?.stageCurrent);
  const stageTotal = Number(patch?.stageTotal);
  const overallCurrent = Number(patch?.overallCurrent);
  const overallTotal = Number(patch?.overallTotal);
  const phase = String(patch?.phase || '').trim();

  const nextStages = { ...prevStages };
  if ((phase === 'reference-links' || phase === 'candidate-pairwise') && Number.isFinite(stageCurrent) && Number.isFinite(stageTotal)) {
    nextStages[phase] = {
      current: Math.max(0, stageCurrent),
      total: Math.max(1, stageTotal),
    };
  }

  runtimeState.meta = {
    ...prevMeta,
    networkAlignProgress: {
      phase,
      current: Number.isFinite(overallCurrent) ? Math.max(0, overallCurrent) : 0,
      total: Number.isFinite(overallTotal) ? Math.max(1, overallTotal) : 1,
    },
    networkAlignStages: nextStages,
  };
  runtimeState.updatedAt = Date.now();
}

function completeNetworkAlignProgress(taskId = getCurrentTaskId()) {
  const runtimeState = getRuntimeState(taskId);
  const prevMeta = runtimeState.meta || {};
  const prevProgress = prevMeta.networkAlignProgress;
  const prevStages = (prevMeta.networkAlignStages && typeof prevMeta.networkAlignStages === 'object')
    ? prevMeta.networkAlignStages
    : {};
  const completedStages = Object.fromEntries(
    Object.entries(prevStages).map(([phase, value]) => {
      const total = Math.max(1, Number(value?.total) || 1);
      return [phase, { current: total, total }];
    }),
  );

  runtimeState.meta = {
    ...prevMeta,
    networkAlignProgress: prevProgress
      ? {
          ...prevProgress,
          current: Math.max(1, Number(prevProgress.total) || 1),
          total: Math.max(1, Number(prevProgress.total) || 1),
        }
      : prevProgress,
    networkAlignStages: completedStages,
  };
  runtimeState.updatedAt = Date.now();
}

function updateAlignmentProgress(patch, taskId = getCurrentTaskId()) {
  const runtimeState = getRuntimeState(taskId);
  const prevMeta = runtimeState.meta || {};
  const current = Number(patch?.current);
  const total = Number(patch?.total);
  const phase = String(patch?.phase || '').trim();

  runtimeState.meta = {
    ...prevMeta,
    alignmentProgress: {
      current: Number.isFinite(current) ? Math.max(0, current) : 0,
      total: Number.isFinite(total) ? Math.max(1, total) : 1,
      phase,
    },
  };
  runtimeState.updatedAt = Date.now();
}

function jsonError(res, message, error = '') {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const details = status >= 500 && error ? String(error) : '';
  res.status(status).json({
    ok: false,
    message: status < 500 ? String(error?.message || message) : message,
    ...(details ? { details } : {}),
  });
}

function runCmd(cmd, args, cwd = pipelineRoot, opts = {}) {
  return new Promise((resolve, reject) => {
    pushRuntimeLine(`[cmd] ${cmd} ${args.join(' ')}`);
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;

    if (Number(opts.timeoutMs || 0) > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        pushRuntimeLine(`[cmd] timeout after ${opts.timeoutMs}ms, killing process`);
        p.kill('SIGKILL');
      }, Number(opts.timeoutMs));
    }

    p.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      appendRuntimeChunk('[stdout]', text);
      if (opts.onStdout) opts.onStdout(text);
    });
    p.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      appendRuntimeChunk('[stderr]', text);
      if (opts.onStderr) opts.onStderr(text);
    });

    p.on('close', (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (timedOut) {
        reject(new Error(`${cmd} ${args.join(' ')} timed out after ${opts.timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code})\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runMafftAuto(inputFastaPath) {
  try {
    // --quiet avoids MAFFT writing progress logs to /dev/stderr, which can fail
    // in some non-interactive runtimes (for example, backend child process context).
    return await runCmd('mafft', ['--auto', '--anysymbol', '--quiet', inputFastaPath]);
  } catch (err) {
    const msg = String(err);
    if (!msg.includes('/dev/stderr')) {
      throw err;
    }

    // Fallback retry without --quiet to preserve behavior if the quiet path fails
    // for environment-specific reasons.
    return await runCmd('mafft', ['--auto', '--anysymbol', inputFastaPath]);
  }
}

function parseCsvLine(line) {
  const out = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      out.push(cell);
      cell = '';
      continue;
    }

    cell += ch;
  }
  out.push(cell);
  return out;
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function readCsvPreview(csvPath, limit = 10, offset = 0) {
  const text = await fs.readFile(csvPath, 'utf-8');
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = parseCsvLine(lines[0]);
  const dataLines = lines.slice(1);
  const start = Math.max(0, offset);
  const end = Math.min(dataLines.length, start + limit);
  const rows = dataLines.slice(start, end).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? '';
    });
    return row;
  });
  return { headers, rows, total: dataLines.length };
}

async function countCsvDataRows(csvPath) {
  const text = await fs.readFile(csvPath, 'utf-8');
  const trimmed = text.trim();
  if (!trimmed) return 0;
  let count = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed.charCodeAt(i) === 10) count++;
  }
  return count;
}

async function readCsvRows(csvPath) {
  const stat = await fs.stat(csvPath);
  if (stat.size > MAX_CSV_FILE_SIZE) {
    throw new Error(`CSV file too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max 100 MB)`);
  }
  const text = await fs.readFile(csvPath, 'utf-8');
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) {
    return { headers: [], rows: [] };
  }
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? '';
    });
    return row;
  });
  return { headers, rows };
}

async function writeCsvRows(csvPath, headers, rows) {
  const lines = [headers.map(csvEscape).join(',')]
    .concat(rows.map((row) => headers.map((h) => csvEscape(row[h] ?? '')).join(',')));
  await fs.writeFile(csvPath, lines.join('\n'), 'utf-8');
}

// ── External prediction service configuration ─────────────────────────────
const CATAPRO_URL = process.env.CATAPRO_URL || 'http://localhost:8003';
const SOL_URL     = process.env.SOL_URL     || 'http://localhost:8004';
const EC_URL      = process.env.EC_URL      || 'http://localhost:8000';
const TM_URL      = process.env.TM_URL      || 'http://localhost:8005';

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

// The external batch APIs accept at most 256 items by default. A smaller
// application-level batch keeps progress observable and avoids a single very
// long HTTP request for large candidate sets.
const PREDICTION_BATCH_SIZE = boundedPositiveInteger(process.env.PREDICTION_BATCH_SIZE, 64, 256);
const PREDICTION_REQUEST_TIMEOUT_MS = boundedPositiveInteger(
  process.env.PREDICTION_REQUEST_TIMEOUT_MS,
  10 * 60 * 1000,
  24 * 60 * 60 * 1000,
);

// Service health cache: { url: { online: bool, lastCheck: number } }
const serviceHealthCache = new Map();
const HEALTH_CHECK_TTL = 30_000; // 30 seconds

async function checkServiceHealth(baseUrl) {
  const cached = serviceHealthCache.get(baseUrl);
  if (cached && Date.now() - cached.lastCheck < HEALTH_CHECK_TTL) {
    return cached.online;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`${baseUrl}/docs`, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    const online = resp.ok || resp.status === 200;
    serviceHealthCache.set(baseUrl, { online, lastCheck: Date.now() });
    return online;
  } catch {
    serviceHealthCache.set(baseUrl, { online: false, lastCheck: Date.now() });
    return false;
  }
}

async function checkAllPredictionServices() {
  const [cataPro, sol, ec, tm] = await Promise.all([
    checkServiceHealth(CATAPRO_URL),
    checkServiceHealth(SOL_URL),
    checkServiceHealth(EC_URL),
    checkServiceHealth(TM_URL),
  ]);
  return { cataPro, sol, ec, tm };
}

// ── Mock hash function (used for fallback) ────────────────────────────────
function hashSeqToUnit(seq, salt) {
  let hash = 2166136261;
  const s = `${salt}:${seq}`;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000000) / 1000000;
}

// ── Batched external prediction clients ──────────────────────────────────
function splitIntoBatches(items, batchSize = PREDICTION_BATCH_SIZE) {
  const batches = [];
  for (let start = 0; start < items.length; start += batchSize) {
    batches.push(items.slice(start, start + batchSize));
  }
  return batches;
}

async function fetchPredictionJson(url, payload) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(PREDICTION_REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    let details = '';
    try {
      details = String(await resp.text()).trim().slice(0, 500);
    } catch { /* ignore response body errors */ }
    throw new Error(`HTTP ${resp.status}${details ? `: ${details}` : ''}`);
  }
  return resp.json();
}

// Returns Map<candidate id, { kcat: number, km: number }> for successful rows.
// Results are matched by the service-provided index, not by fasta_id, because
// CataPro appends suffixes such as "_wild" to identifiers.
async function predictCataProBatch(items, smiles) {
  const data = await fetchPredictionJson(
    `${CATAPRO_URL}/predict/batch`,
    items.map((item) => ({ id: item.id, sequence: item.sequence, smiles })),
  );
  const resultMap = new Map();
  const results = Array.isArray(data?.results) ? data.results : [];
  for (const result of results) {
    const index = Number(result?.index);
    const item = Number.isInteger(index) ? items[index] : null;
    if (!item || result?.status !== 'success') continue;
    const kcat = Number(result.kcat_value);
    const km = Number(result.km_value);
    if (Number.isFinite(kcat) && kcat > 0 && Number.isFinite(km) && km > 0) {
      resultMap.set(item.id, { kcat, km });
    }
  }
  return resultMap;
}

// Fallback mock for kcat
async function predictKcatMock(seq) {
  return Number((0.01 + hashSeqToUnit(seq, 'kcat') * 99.99).toFixed(3));
}

// Fallback mock for Km
async function predictKmMock(seq) {
  return Number((0.1 + hashSeqToUnit(seq, 'km') * 99.9).toFixed(3));
}

// Returns Map<candidate id, { soluble: boolean, score: number }> for successful rows.
async function predictSolubilityBatch(items) {
  const data = await fetchPredictionJson(
    `${SOL_URL}/predict/batch`,
    items.map((item) => ({ name: item.id, sequence: item.sequence })),
  );
  const resultMap = new Map();
  const results = Array.isArray(data?.results) ? data.results : [];
  for (const result of results) {
    const index = Number(result?.index);
    const item = Number.isInteger(index) ? items[index] : null;
    if (!item || result?.status !== 'success') continue;
    const raw = Number(result.score);
    if (!Number.isFinite(raw)) continue;
    const score = Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw));
    resultMap.set(item.id, {
      soluble: result.prediction === 'Soluble',
      score,
    });
  }
  return resultMap;
}

// Fallback mock for solubility (returns 0-1 probability)
async function predictSolubilityMock(seq) {
  return Number(hashSeqToUnit(seq, 'solubility').toFixed(4));
}

// ── Tm prediction (single-item API; no batch endpoint is documented) ──────
function extractTmPrediction(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = extractTmPrediction(item, depth + 1);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  const directKeys = ['tm', 'Tm', 'TM', 'temperature', 'melting_temperature', 'meltingTemperature'];
  for (const key of directKeys) {
    if (Object.hasOwn(value, key)) {
      const parsed = extractTmPrediction(value[key], depth + 1);
      if (parsed !== null) return parsed;
    }
  }
  const containerKeys = ['prediction', 'result', 'results', 'data', 'output'];
  for (const key of containerKeys) {
    if (Object.hasOwn(value, key)) {
      const parsed = extractTmPrediction(value[key], depth + 1);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

async function predictTmReal(seq) {
  try {
    const data = await fetchPredictionJson(`${TM_URL}/predict`, { name: 'candidate', sequence: seq });
    return extractTmPrediction(data);
  } catch {
    return null;
  }
}

async function predictTmMock(seq) {
  return Number((30 + hashSeqToUnit(seq, 'tm') * 60).toFixed(2));
}

function normalizeEcEntries(raw) {
  if (!Array.isArray(raw)) return null;
  const normalised = raw.map((result) => ({
    ec: String(result?.ec || result?.EC || result?.ec_number || result?.label || '').trim(),
    score: Number(result?.score ?? result?.probability ?? result?.confidence ?? 0),
  })).filter((result) => result.ec);
  return normalised.length
    ? normalised.sort((a, b) => b.score - a.score).slice(0, 3)
    : null;
}

// Returns Map<candidate id, [{ ec, score }]> for successful rows.
async function predictECBatch(items) {
  const data = await fetchPredictionJson(
    `${EC_URL}/predict/batch`,
    items.map((item) => ({ name: item.id, sequence: item.sequence })),
  );
  const resultMap = new Map();
  const results = Array.isArray(data?.results) ? data.results : [];
  for (const result of results) {
    const index = Number(result?.index);
    const item = Number.isInteger(index) ? items[index] : null;
    if (!item || result?.status !== 'success') continue;
    const entries = normalizeEcEntries(result.results);
    if (entries) resultMap.set(item.id, entries);
  }
  return resultMap;
}

// Fallback mock for EC
async function predictECMock(seq) {
  const ecs = ['3.2.1.17', '1.1.1.1', '2.7.1.1', '4.2.1.1', '5.3.1.9'];
  const idx = Math.floor(hashSeqToUnit(seq, 'ec') * ecs.length);
  const score = Number((0.3 + hashSeqToUnit(seq, 'ec_score') * 0.7).toFixed(4));
  return [{ ec: ecs[idx], score }];
}

function createPredictionProgressTracker(itemsByPredictor, modes) {
  const predictorNames = ['cataPro', 'solubility', 'ec', 'tm'];
  const startedAt = Date.now();
  const emaMsPerItem = {};
  const itemCount = (name) => Array.isArray(itemsByPredictor?.[name])
    ? itemsByPredictor[name].length
    : 0;
  const batchCount = (name) => {
    const totalItems = itemCount(name);
    if (!totalItems) return 0;
    if (!modes[name]) return 1;
    return name === 'tm'
      ? totalItems
      : Math.ceil(totalItems / PREDICTION_BATCH_SIZE);
  };
  const predictors = Object.fromEntries(
    predictorNames.map((name) => {
      const totalItems = itemCount(name);
      return [name, {
        current: 0,
        total: totalItems,
        completedBatches: 0,
        totalBatches: batchCount(name),
        status: totalItems ? 'pending' : 'done',
        mode: modes[name] ? 'real' : 'mock',
        elapsedMs: 0,
        estimatedRemainingMs: totalItems ? null : 0,
      }];
    }),
  );
  const totalItems = predictorNames.reduce((sum, name) => sum + itemCount(name), 0);
  const state = {
    current: 0,
    total: totalItems,
    done: totalItems === 0,
    startedAt,
    elapsedMs: 0,
    estimatedRemainingMs: totalItems ? null : 0,
    predictors,
  };

  const publish = () => {
    state.current = Object.values(predictors).reduce((sum, value) => sum + value.current, 0);
    state.elapsedMs = Date.now() - startedAt;
    state.done = Object.values(predictors).every((value) => value.status === 'done');
    const unfinished = Object.values(predictors).filter((value) => value.status !== 'done');
    if (!unfinished.length) {
      state.estimatedRemainingMs = 0;
    } else if (unfinished.some((value) => !Number.isFinite(value.estimatedRemainingMs))) {
      // Do not invent an overall ETA before every concurrently running service
      // has completed at least one real unit of work.
      state.estimatedRemainingMs = null;
    } else {
      state.estimatedRemainingMs = Math.max(...unfinished.map((value) => value.estimatedRemainingMs));
    }
    setRuntimeMeta({ predictProgress: JSON.parse(JSON.stringify(state)) });
  };

  const start = (name) => {
    predictors[name].status = predictors[name].total ? 'running' : 'done';
    publish();
  };

  const completeBatch = (name, itemCount, durationMs) => {
    const predictor = predictors[name];
    const completed = Math.max(0, Math.min(itemCount, predictor.total - predictor.current));
    predictor.current += completed;
    predictor.completedBatches = Math.min(predictor.totalBatches, predictor.completedBatches + 1);
    predictor.elapsedMs = Date.now() - startedAt;
    if (completed > 0) {
      const latestMsPerItem = Math.max(0, durationMs) / completed;
      emaMsPerItem[name] = Number.isFinite(emaMsPerItem[name])
        ? emaMsPerItem[name] * 0.7 + latestMsPerItem * 0.3
        : latestMsPerItem;
    }
    const remainingItems = Math.max(0, predictor.total - predictor.current);
    predictor.estimatedRemainingMs = remainingItems === 0
      ? 0
      : Number.isFinite(emaMsPerItem[name])
        ? Math.round(emaMsPerItem[name] * remainingItems)
        : null;
    predictor.status = remainingItems === 0 ? 'done' : 'running';
    publish();
  };

  publish();
  return { start, completeBatch, snapshot: () => JSON.parse(JSON.stringify(state)) };
}

async function runCataProPredictions(items, smiles, useReal, progress) {
  const output = new Map();
  progress.start('cataPro');
  const batches = useReal ? splitIntoBatches(items) : [items];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const batchStartedAt = Date.now();
    let realResults = new Map();
    if (useReal) {
      try {
        realResults = await predictCataProBatch(batch, smiles);
      } catch (err) {
        pushRuntimeLine(`[predict-metrics] kcat/Km batch ${batchIndex + 1}/${batches.length} failed; using mock fallback: ${err.message}`);
      }
    }
    let realCount = 0;
    for (const item of batch) {
      const real = realResults.get(item.id);
      if (real) {
        output.set(item.id, { ...real, source: 'real' });
        realCount++;
      } else {
        const [kcat, km] = await Promise.all([
          predictKcatMock(item.sequence),
          predictKmMock(item.sequence),
        ]);
        output.set(item.id, { kcat, km, source: 'mock' });
      }
    }
    progress.completeBatch('cataPro', batch.length, Date.now() - batchStartedAt);
    pushRuntimeLine(`[predict-metrics] kcat/Km batch ${batchIndex + 1}/${batches.length} complete (${realCount} real, ${batch.length - realCount} mock)`);
  }
  return output;
}

async function runSolubilityPredictions(items, useReal, progress) {
  const output = new Map();
  progress.start('solubility');
  const batches = useReal ? splitIntoBatches(items) : [items];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const batchStartedAt = Date.now();
    let realResults = new Map();
    if (useReal) {
      try {
        realResults = await predictSolubilityBatch(batch);
      } catch (err) {
        pushRuntimeLine(`[predict-metrics] solubility batch ${batchIndex + 1}/${batches.length} failed; using mock fallback: ${err.message}`);
      }
    }
    let realCount = 0;
    for (const item of batch) {
      const real = realResults.get(item.id);
      if (real) {
        output.set(item.id, { score: real.score, source: 'real' });
        realCount++;
      } else {
        output.set(item.id, { score: await predictSolubilityMock(item.sequence), source: 'mock' });
      }
    }
    progress.completeBatch('solubility', batch.length, Date.now() - batchStartedAt);
    pushRuntimeLine(`[predict-metrics] solubility batch ${batchIndex + 1}/${batches.length} complete (${realCount} real, ${batch.length - realCount} mock)`);
  }
  return output;
}

async function runECPredictions(items, useReal, progress) {
  const output = new Map();
  progress.start('ec');
  const batches = useReal ? splitIntoBatches(items) : [items];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const batchStartedAt = Date.now();
    let realResults = new Map();
    if (useReal) {
      try {
        realResults = await predictECBatch(batch);
      } catch (err) {
        pushRuntimeLine(`[predict-metrics] EC batch ${batchIndex + 1}/${batches.length} failed; using mock fallback: ${err.message}`);
      }
    }
    let realCount = 0;
    for (const item of batch) {
      const real = realResults.get(item.id);
      if (real) {
        output.set(item.id, { entries: real, source: 'real' });
        realCount++;
      } else {
        output.set(item.id, { entries: await predictECMock(item.sequence), source: 'mock' });
      }
    }
    progress.completeBatch('ec', batch.length, Date.now() - batchStartedAt);
    pushRuntimeLine(`[predict-metrics] EC batch ${batchIndex + 1}/${batches.length} complete (${realCount} real, ${batch.length - realCount} mock)`);
  }
  return output;
}

async function runTmPredictions(items, useReal, progress) {
  const output = new Map();
  progress.start('tm');
  if (!useReal) {
    const startedAt = Date.now();
    for (const item of items) {
      output.set(item.id, { value: await predictTmMock(item.sequence), source: 'mock' });
    }
    progress.completeBatch('tm', items.length, Date.now() - startedAt);
    pushRuntimeLine(`[predict-metrics] Tm mock predictions complete (${items.length} item(s))`);
    return output;
  }

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const startedAt = Date.now();
    const real = await predictTmReal(item.sequence);
    if (Number.isFinite(real)) {
      output.set(item.id, { value: real, source: 'real' });
    } else {
      output.set(item.id, { value: await predictTmMock(item.sequence), source: 'mock' });
    }
    progress.completeBatch('tm', 1, Date.now() - startedAt);
    if ((index + 1) % 5 === 0 || index + 1 === items.length) {
      pushRuntimeLine(`[predict-metrics] Tm ${index + 1}/${items.length} complete`);
    }
  }
  return output;
}

function resolvePredictedMetricsPath(workDir) {
  return path.join(workDir, 'predicted_metrics.csv');
}

const PREDICTION_CACHE_VERSION = 2;

function resolvePredictedMetricsMetaPath(workDir) {
  return path.join(workDir, 'predicted_metrics.meta.json');
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function buildPredictionCacheContext({ candidateIds, seqLookup, smiles, modes }) {
  const sequences = candidateIds
    .map((id) => [id, seqLookup.get(id) ? sha256(seqLookup.get(id)) : null])
    .sort(([a], [b]) => a.localeCompare(b));
  const context = {
    version: PREDICTION_CACHE_VERSION,
    smiles,
    sequences,
    predictors: {
      cataPro: { mode: modes.cataPro ? 'real' : 'mock', url: CATAPRO_URL },
      solubility: { mode: modes.solubility ? 'real' : 'mock', url: SOL_URL },
      ec: { mode: modes.ec ? 'real' : 'mock', url: EC_URL },
      tm: { mode: modes.tm ? 'real' : 'mock', url: TM_URL },
    },
  };
  return { ...context, fingerprint: sha256(JSON.stringify(context)) };
}

async function loadPredictionCacheMeta(workDir) {
  try {
    return JSON.parse(await fs.readFile(resolvePredictedMetricsMetaPath(workDir), 'utf-8'));
  } catch {
    return null;
  }
}

async function writePredictionCacheMeta(workDir, context) {
  const metaPath = resolvePredictedMetricsMetaPath(workDir);
  const tempPath = `${metaPath}.tmp-${process.pid}`;
  await fs.writeFile(tempPath, `${JSON.stringify({ ...context, generatedAt: new Date().toISOString() }, null, 2)}
`, 'utf-8');
  await fs.rename(tempPath, metaPath);
}

function catalyticEfficiency(row) {
  const kcat = Number(row?.kcat);
  const km = Number(row?.km);
  return Number.isFinite(kcat) && kcat > 0 && Number.isFinite(km) && km > 0
    ? kcat / km
    : NaN;
}

// Normalizes log10(kcat/Km), solubility, and Tm values into [0, 1] scores and
// combines them into a single weighted "predictedScore" per candidate id.
// Log scaling prevents a single extreme catalytic-efficiency prediction from
// dominating the min-max range. Tm is scored by closeness to `tmTarget`.
function computePredictedNormalization(rows, subWeights, tmTarget) {
  const minMaxScaler = (values) => {
    const finite = values.filter((v) => Number.isFinite(v));
    if (!finite.length) return () => 0.5;
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    const span = max - min;
    return (v) => {
      if (!Number.isFinite(v)) return 0;
      return span > 1e-9 ? (v - min) / span : 0.5;
    };
  };

  const efficiencyLogs = rows.map((r) => {
    const efficiency = catalyticEfficiency(r);
    return efficiency > 0 ? Math.log10(efficiency) : NaN;
  });
  const efficiencyScaler = minMaxScaler(efficiencyLogs);
  const solubilityScaler = minMaxScaler(rows.map((r) => r.solubility));
  const tmDiffScaler = minMaxScaler(rows.map((r) => -Math.abs(r.tm - tmTarget)));

  const wSum = (subWeights.kcat + subWeights.solubility + subWeights.tm) || 1;
  const out = new Map();
  rows.forEach((r, index) => {
    const efficiency = catalyticEfficiency(r);
    const efficiencyNorm = Number(efficiencyScaler(efficiencyLogs[index]).toFixed(4));
    const solubilityNorm = Number(solubilityScaler(r.solubility).toFixed(4));
    const tmNorm = Number(tmDiffScaler(-Math.abs(r.tm - tmTarget)).toFixed(4));
    const predictedScore = Number((
      (subWeights.kcat * efficiencyNorm + subWeights.solubility * solubilityNorm + subWeights.tm * tmNorm) / wSum
    ).toFixed(4));
    out.set(r.id, {
      catalyticEfficiency: Number.isFinite(efficiency) ? efficiency : 0,
      catalyticEfficiencyNorm: efficiencyNorm,
      // Backward-compatible alias: this field now correctly represents kcat/Km.
      kcatNorm: efficiencyNorm,
      solubilityNorm,
      tmNorm,
      predictedScore,
    });
  });
  return out;
}

function normalizePredictedSubWeights(raw) {
  const kcat = Number.isFinite(Number(raw?.kcat)) ? Math.max(0, Number(raw.kcat)) : 1 / 3;
  const solubility = Number.isFinite(Number(raw?.solubility)) ? Math.max(0, Number(raw.solubility)) : 1 / 3;
  const tm = Number.isFinite(Number(raw?.tm)) ? Math.max(0, Number(raw.tm)) : 1 / 3;
  return { kcat, solubility, tm };
}

async function loadPredictedMetricsMap(workDir) {
  try {
    const { rows } = await readCsvRows(resolvePredictedMetricsPath(workDir));
    const map = new Map();
    for (const r of rows) {
      map.set(r.id, {
        id: r.id,
        kcat: Number(r.kcat),
        km: Number(r.km) || 0,
        solubility: Number(r.solubility),
        tm: Number(r.tm),
        ec_top1: r.ec_top1 || '',
        ec_score1: Number(r.ec_score1) || 0,
        ec_top2: r.ec_top2 || '',
        ec_score2: Number(r.ec_score2) || 0,
        ec_top3: r.ec_top3 || '',
        ec_score3: Number(r.ec_score3) || 0,
        cataPro_source: r.cataPro_source || '',
        solubility_source: r.solubility_source || '',
        tm_source: r.tm_source || '',
        ec_source: r.ec_source || '',
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

const PREDICTION_NAMES = ['cataPro', 'solubility', 'ec', 'tm'];

function hasValidPredictionSource(value) {
  return value === 'real' || value === 'mock';
}

function predictionRowHasValidValue(row, predictor) {
  if (!row) return false;
  if (predictor === 'cataPro') {
    return hasValidPredictionSource(row.cataPro_source)
      && Number.isFinite(Number(row.kcat))
      && Number.isFinite(Number(row.km));
  }
  if (predictor === 'solubility') {
    return hasValidPredictionSource(row.solubility_source)
      && Number.isFinite(Number(row.solubility));
  }
  if (predictor === 'tm') {
    return hasValidPredictionSource(row.tm_source)
      && Number.isFinite(Number(row.tm));
  }
  if (predictor === 'ec') {
    return hasValidPredictionSource(row.ec_source)
      && Boolean(String(row.ec_top1 || '').trim())
      && Number.isFinite(Number(row.ec_score1));
  }
  return false;
}

function sequenceHashMapFromCacheContext(context) {
  return new Map(Array.isArray(context?.sequences) ? context.sequences : []);
}

function predictionInputContextMatches({
  predictor,
  id,
  cachedContext,
  currentContext,
  cachedSequenceHashes,
  currentSequenceHashes,
}) {
  if (!cachedContext || cachedContext.version !== currentContext.version) return false;

  const currentSequenceHash = currentSequenceHashes.get(id);
  if (!currentSequenceHash || cachedSequenceHashes.get(id) !== currentSequenceHash) return false;

  if (predictor === 'cataPro' && String(cachedContext.smiles || '') !== String(currentContext.smiles || '')) {
    return false;
  }

  const cachedUrl = String(cachedContext.predictors?.[predictor]?.url || '');
  const currentUrl = String(currentContext.predictors?.[predictor]?.url || '');
  return Boolean(cachedUrl && currentUrl && cachedUrl === currentUrl);
}

function predictionNeedsRecompute({
  predictor,
  id,
  row,
  cachedContext,
  currentContext,
  cachedSequenceHashes,
  currentSequenceHashes,
  forceRecompute,
}) {
  if (forceRecompute) return true;
  return !predictionInputContextMatches({
    predictor,
    id,
    cachedContext,
    currentContext,
    cachedSequenceHashes,
    currentSequenceHashes,
  }) || !predictionRowHasValidValue(row, predictor);
}

function sanitizeFastaId(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.|:-]/g, '_');
}

function normalizeScoringRules(rawRules) {
  if (rawRules === undefined || rawRules === null) {
    return null;
  }
  if (!Array.isArray(rawRules) || rawRules.length === 0) {
    throw new Error('rules must be a non-empty array');
  }
  if (rawRules.length > 200) {
    throw new Error('rules array too large (max 200)');
  }

  return rawRules.map((rule, idx) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`rule #${idx + 1} must be an object`);
    }

    const pos = Number(rule.pos);
    if (!Number.isInteger(pos) || pos <= 0) {
      throw new Error(`rule #${idx + 1} has invalid pos`);
    }

    const allowedRaw = rule.allowed;
    if (!Array.isArray(allowedRaw) || allowedRaw.length === 0) {
      throw new Error(`rule #${idx + 1} allowed must be a non-empty array`);
    }

    const allowed = Array.from(
      new Set(
        allowedRaw
          .map((x) => String(x ?? '').trim())
          .filter(Boolean)
          .map((x) => (x.toUpperCase() === 'UNI' ? 'Uni' : x.toUpperCase())),
      ),
    );
    if (!allowed.length) {
      throw new Error(`rule #${idx + 1} allowed must contain at least one non-empty token`);
    }

    const score = Number(rule.score);
    if (!Number.isFinite(score)) {
      throw new Error(`rule #${idx + 1} has invalid score`);
    }

    const label = String(rule.label ?? '').trim();
    if (!label) {
      throw new Error(`rule #${idx + 1} label is required`);
    }

    return { pos, allowed, score, label };
  });
}

function normalizeScoringPositionMode(rawMode) {
  const mode = String(rawMode || 'pre').trim().toLowerCase();
  if (mode === 'pre' || mode === 'aligned') {
    return mode;
  }
  throw new Error('positionMode must be one of: pre, aligned');
}

async function writeFastaFromCsv(csvPath, fastaPath, fetchMissing = false) {
  const text = await fs.readFile(csvPath, 'utf-8');
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) {
    await fs.writeFile(fastaPath, '', 'utf-8');
    return 0;
  }

  const headers = parseCsvLine(lines[0]);
  const targetCol = headers.findIndex((h) => h === 'target');
  const seqCol = headers.findIndex((h) => h === 'sequence');
  if (targetCol < 0 || seqCol < 0) {
    await fs.writeFile(fastaPath, '', 'utf-8');
    return 0;
  }

  const out = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) {
      continue;
    }
    const cols = parseCsvLine(line);
    const rawTarget = String(cols[targetCol] || '').trim();
    const id = sanitizeFastaId(rawTarget);
    let seq = String(cols[seqCol] || '').replace(/\s+/g, '').toUpperCase();
    if (!seq && fetchMissing) {
      seq = await fetchUniprotSequence(rawTarget);
    }
    if (!id || !seq) {
      continue;
    }
    out.push(`>${id}`);
    out.push(seq);
  }

  await fs.writeFile(fastaPath, out.join('\n'), 'utf-8');
  return out.length / 2;
}

async function fetchJson(url, init = {}) {
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${url}\n${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  } catch (err) {
    pushRuntimeLine(`[net] fetch failed, fallback to curl: ${String(err)}`);

    const method = String(init.method || 'GET').toUpperCase();
    const headers = { ...(init.headers || {}) };
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept')) {
      headers.Accept = 'application/json';
    }

    const args = ['-sS', '-L', '-f', '-X', method, url];
    for (const [k, v] of Object.entries(headers)) {
      args.push('-H', `${k}: ${String(v)}`);
    }
    let bodyFile = null;
    if (init.body != null) {
      const tmpDir = await ensureDir(defaultWorkDir);
      bodyFile = path.join(tmpDir, `.curl-body-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      await fs.writeFile(bodyFile, String(init.body), 'utf-8');
      args.push('--data-binary', `@${bodyFile}`);
    }

    let stdout = '';
    try {
      const ret = await runCmd('curl', args, pipelineRoot);
      stdout = ret.stdout;
    } finally {
      if (bodyFile) {
        await fs.rm(bodyFile, { force: true });
      }
    }
    try {
      return JSON.parse(stdout || '{}');
    } catch {
      return {};
    }
  }
}

async function fetchJsonViaCurl(url, init = {}, opts = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const headers = { ...(init.headers || {}) };
  const retries = Number(opts.retries ?? 3);
  const retryDelayMs = Number(opts.retryDelayMs ?? 1000);
  const label = String(opts.label || 'net');
  const curlRetries = Math.max(0, Number(opts.curlRetries ?? 2));
  const connectTimeoutSec = Math.max(1, Number(opts.connectTimeoutSec ?? 30));
  const maxTimeSec = Math.max(connectTimeoutSec, Number(opts.maxTimeSec ?? 120));

  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept')) {
    headers.Accept = 'application/json';
  }

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let bodyFile = null;
    try {
      const args = [
        '-sS',
        '-L',
        '-f',
        '--connect-timeout',
        String(connectTimeoutSec),
        '--max-time',
        String(maxTimeSec),
        '--retry',
        String(curlRetries),
        '--retry-delay',
        '1',
        '-X',
        method,
        url,
      ];
      for (const [k, v] of Object.entries(headers)) {
        args.push('-H', `${k}: ${String(v)}`);
      }
      if (init.body != null) {
        const tmpDir = await ensureDir(defaultWorkDir);
        bodyFile = path.join(tmpDir, `.curl-body-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        await fs.writeFile(bodyFile, String(init.body), 'utf-8');
        args.push('--data-binary', `@${bodyFile}`);
      }

      const ret = await runCmd('curl', args, pipelineRoot);
      let parsed = {};
      try {
        parsed = JSON.parse(ret.stdout || '{}');
      } catch (err) {
        throw new Error(`invalid json from ${url}: ${String(err)}`);
      }
      return parsed;
    } catch (err) {
      pushRuntimeLine(`[${label}] curl request failed attempt=${attempt}/${retries}: ${String(err)}`);
      if (attempt >= retries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    } finally {
      if (bodyFile) {
        await fs.rm(bodyFile, { force: true });
      }
    }
  }

  throw new Error(`curl request failed after retries: ${url}`);
}

async function fetchUniprotSequence(accessionOrId) {
  const key = String(accessionOrId || '').trim();
  if (!key) {
    return '';
  }
  if (uniprotSeqCache.has(key)) {
    return uniprotSeqCache.get(key) || '';
  }
  try {
    let fasta = '';
    try {
      const response = await fetch(`https://rest.uniprot.org/uniprotkb/${encodeURIComponent(key)}.fasta`);
      if (response.ok) {
        fasta = await response.text();
      }
    } catch {
      // ignore and fallback to curl
    }

    if (!fasta) {
      const { stdout } = await runCmd(
        'curl',
        ['-sS', '-L', '-f', `https://rest.uniprot.org/uniprotkb/${encodeURIComponent(key)}.fasta`],
        pipelineRoot,
      );
      fasta = stdout;
    }

    const seq = fasta
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('>'))
      .join('')
      .trim()
      .toUpperCase();
    uniprotSeqCache.set(key, seq);
    return seq;
  } catch {
    uniprotSeqCache.set(key, '');
    return '';
  }
}

async function submitEbiHmmsearch(hmmFile, database) {
  const hmmContent = await fs.readFile(hmmFile, 'utf-8');
  pushRuntimeLine(`[ebi] submit database=${database}`);
  const submit = await fetchJsonViaCurl(ebiSearchUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ database, input: hmmContent }),
  }, {
    retries: 1,
    retryDelayMs: 0,
    label: 'ebi-net',
    curlRetries: 0,
    connectTimeoutSec: 15,
    maxTimeSec: 60,
  });

  const jobId = submit.id || submit.job_id || submit.uuid;
  if (!jobId) {
    throw new Error(`EBI did not return job id: ${JSON.stringify(submit).slice(0, 500)}`);
  }

  setRuntimeMeta({ ebiJobId: String(jobId), ebiDatabase: String(database || '') });
  pushRuntimeLine(`[ebi] job id=${jobId}`);
  return { jobId: String(jobId) };
}

async function pollEbiHmmsearchUntilSuccess(jobId) {
  setRuntimeMeta({ ebiJobId: String(jobId) });

  let results = null;
  const maxAttempts = 915;
  for (let i = 0; i < maxAttempts; i += 1) {
    let statusRes = {};
    try {
      statusRes = await fetchJsonViaCurl(`${ebiResultUrl}/${jobId}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      }, {
        // Notebook parity: one request per poll tick, no hidden retry amplification.
        retries: 1,
        retryDelayMs: 0,
        label: 'ebi-net',
        curlRetries: 0,
        connectTimeoutSec: 10,
        maxTimeSec: 30,
      });
    } catch (err) {
      pushRuntimeLine(`[ebi] status request failed attempt=${i + 1}/${maxAttempts}: ${String(err)}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    const status = String(statusRes.status || '').toUpperCase();
    if (status === 'SUCCESS') {
      results = statusRes;
      break;
    }
    if (status === 'FAILURE' || status === 'ERROR') {
      throw new Error(`EBI job failed: ${JSON.stringify(statusRes).slice(0, 800)}`);
    }

    if (status === 'RETRY') {
      pushRuntimeLine(`[ebi] status=RETRY attempt=${i + 1}/${maxAttempts} (EBI queue busy, still waiting)`);
    } else {
      pushRuntimeLine(`[ebi] status=${status || 'PENDING'} attempt=${i + 1}/${maxAttempts}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  if (!results) {
    throw new Error('EBI job polling timeout');
  }

  const pageCount = Number(results.page_count || 1);
  pushRuntimeLine(`[ebi] job ready page_count=${pageCount}`);
  return {
    jobId: String(jobId),
    pageCount,
    status: 'SUCCESS',
  };
}

async function downloadEbiHmmsearchResults(jobId) {
  const statusRes = await fetchJsonViaCurl(`${ebiResultUrl}/${jobId}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  }, {
    retries: 1,
    retryDelayMs: 0,
    label: 'ebi-net',
    curlRetries: 0,
    connectTimeoutSec: 10,
    maxTimeSec: 30,
  });
  const status = String(statusRes.status || '').toUpperCase();
  if (status !== 'SUCCESS') {
    throw new Error(`EBI job is not ready, current status=${status || 'UNKNOWN'}`);
  }

  const pageCount = Number(statusRes.page_count || 1);
  const allHits = [];
  const failedPages = [];
  let downloadedCount = 1;

  setRuntimeMeta({ ebiJobId: String(jobId), ebiDownloadProgress: { current: downloadedCount, total: pageCount } });

  if (statusRes?.result?.hits && Array.isArray(statusRes.result.hits)) {
    allHits.push(...statusRes.result.hits);
  }

  if (pageCount > 1) {
    const pages = Array.from({ length: pageCount - 1 }, (_, idx) => idx + 2);
    const maxWorkers = 20;

    async function fetchPage(pageNum) {
      const maxRetry = 1;
      for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
        try {
          const pageData = await fetchJsonViaCurl(`${ebiResultUrl}/${jobId}?page=${pageNum}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
          }, {
            retries: 1,
            retryDelayMs: 0,
            label: 'ebi-net',
            curlRetries: 0,
            connectTimeoutSec: 10,
            maxTimeSec: 30,
          });
          if (pageData?.result?.hits && Array.isArray(pageData.result.hits)) {
            return pageData.result.hits;
          }
          return [];
        } catch (err) {
          pushRuntimeLine(`[ebi] page=${pageNum} fetch failed attempt=${attempt}/${maxRetry}: ${String(err)}`);
          if (attempt < maxRetry) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          }
        }
      }

      failedPages.push(pageNum);
      pushRuntimeLine(`[ebi] page=${pageNum} skipped after retries`);
      return [];
    }

    let cursor = 0;
    const workers = Array.from({ length: Math.min(maxWorkers, pages.length) }, async () => {
      while (cursor < pages.length) {
        const idx = cursor;
        cursor += 1;
        const pageNum = pages[idx];
        const hits = await fetchPage(pageNum);
        allHits.push(...hits);
        downloadedCount += 1;
        setRuntimeMeta({ ebiDownloadProgress: { current: downloadedCount, total: pageCount } });
      }
    });

    await Promise.all(workers);
  }

  pushRuntimeLine(`[ebi] fetched hits=${allHits.length} pages=${pageCount} failed_pages=${failedPages.length}`);
  return { jobId: String(jobId), pageCount, allHits, failedPages };
}

async function runEbiHmmsearch(hmmFile, database) {
  const { jobId } = await submitEbiHmmsearch(hmmFile, database);
  await pollEbiHmmsearchUntilSuccess(jobId);
  return downloadEbiHmmsearchResults(jobId);
}

function mapEbiHitsToRows(allHits) {
  return allHits.map((h) => {
    const meta = h.metadata || {};
    const accession = meta.uniprot_accession || meta.accession || '';
    const identifier = meta.uniprot_identifier || meta.identifier || '';
    const description = meta.description || h.desc || '';
    const length = Number(meta.length || h.length || 0) || '';
    const target = accession || identifier || h.acc || h.name || '';

    return {
      target,
      hmm_score: h.score ?? h.sum_score ?? h.pre_score ?? '',
      evalue: h.evalue ?? h.pvalue ?? '',
      length,
      sequence: '',
      uniprot_accession: accession,
      uniprot_identifier: identifier,
      taxonomy_id: meta.taxonomy_id || '',
      kingdom: meta.kingdom || '',
      phylum: meta.phylum || '',
      class: meta['class'] || '',
      species: meta.species || '',
      description,
      external_link: meta.external_link || (accession ? `https://www.uniprot.org/uniprotkb/${accession}/entry` : ''),
    };
  });
}

async function writeEbiHitsCsv(allHits, outputCsv) {
  const headers = [
    'target',
    'hmm_score',
    'evalue',
    'length',
    'sequence',
    'uniprot_accession',
    'uniprot_identifier',
    'taxonomy_id',
    'kingdom',
    'phylum',
    'class',
    'species',
    'description',
    'external_link',
  ];

  const rows = mapEbiHitsToRows(allHits);

  const lines = [headers.map(csvEscape).join(',')]
    .concat(rows.map((row) => headers.map((h) => csvEscape(row[h] ?? '')).join(',')));
  await fs.writeFile(outputCsv, lines.join('\n'), 'utf-8');
}

async function writeEbiDownloadMeta(workDir, meta) {
  const metaPath = path.join(workDir, 'ebi_download_meta.json');
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

async function readEbiDownloadMeta(workDir) {
  const metaPath = path.join(workDir, 'ebi_download_meta.json');
  try {
    const raw = await fs.readFile(metaPath, 'utf-8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function pipelineStateFilename(module) {
  if (module === 'hmmer' || module === 'blast' || module === 'compare') return `${module}_state.json`;
  return 'pipeline_state.json';
}

async function readPipelineState(workDir, module) {
  // Try module-specific file first, fall back to legacy pipeline_state.json
  const candidates = module
    ? [pipelineStateFilename(module), 'pipeline_state.json']
    : ['pipeline_state.json'];
  for (const filename of candidates) {
    const statePath = path.join(workDir, filename);
    try {
      const raw = await fs.readFile(statePath, 'utf-8');
      const state = JSON.parse(raw);
      if (state && typeof state === 'object') {
        return { exists: true, state, source: filename };
      }
    } catch { /* try next */ }
  }
  return { exists: false, state: null, source: null };
}

async function writePipelineState(workDir, state, module) {
  const filename = pipelineStateFilename(module);
  const statePath = path.join(workDir, filename);
  await fs.writeFile(statePath, JSON.stringify(state || {}, null, 2), 'utf-8');
}

async function retryFailedEbiPages({ jobId, failedPages }) {
  const recoveredHits = [];
  const stillFailedPages = [];

  async function fetchPageWithRetry(pageNum) {
    const maxRetry = 1;
    for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
      try {
        const pageData = await fetchJsonViaCurl(`${ebiResultUrl}/${jobId}?page=${pageNum}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        }, {
          retries: 1,
          retryDelayMs: 0,
          label: 'ebi-net',
          curlRetries: 0,
          connectTimeoutSec: 10,
          maxTimeSec: 30,
        });
        if (pageData?.result?.hits && Array.isArray(pageData.result.hits)) {
          return pageData.result.hits;
        }
        return [];
      } catch (err) {
        pushRuntimeLine(`[ebi] retry-failed page=${pageNum} attempt=${attempt}/3: ${String(err)}`);
        if (attempt < maxRetry) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
    stillFailedPages.push(pageNum);
    return [];
  }

  for (const pageNum of failedPages) {
    const hits = await fetchPageWithRetry(pageNum);
    recoveredHits.push(...hits);
  }

  return { recoveredHits, stillFailedPages };
}

async function mergeEbiRecoveredRows(csvPath, recoveredHits) {
  const { headers, rows } = await readCsvRows(csvPath);
  if (!headers.length) {
    throw new Error('hits_all.csv is missing, please run download first');
  }

  const incoming = mapEbiHitsToRows(recoveredHits);
  const keyOf = (row) => [row.target, row.hmm_score, row.evalue, row.description].map((x) => String(x ?? '')).join('|');
  const existingKey = new Set(rows.map((r) => keyOf(r)));

  let inserted = 0;
  for (const row of incoming) {
    const k = keyOf(row);
    if (!existingKey.has(k)) {
      rows.push(row);
      existingKey.add(k);
      inserted += 1;
    }
  }

  await writeCsvRows(csvPath, headers, rows);
  return { inserted, total: rows.length };
}

function parseFastaRecords(text) {
  const records = [];
  let current = null;
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith('>')) {
      if (current) {
        records.push(current);
      }
      const header = line.slice(1).trim();
      const id = header.split(/\s+/)[0] || header;
      current = { id, header, seq: '' };
      continue;
    }
    if (current) {
      current.seq += line;
    }
  }
  if (current) {
    records.push(current);
  }
  return records;
}

function parseBooleanLike(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

async function buildScoringPassedFasta(scoreCsvPath, alignmentPath, outputFastaPath) {
  const { rows } = await readCsvRows(scoreCsvPath);
  const passIds = new Set(
    rows
      .filter((r) => parseBooleanLike(r.pass_rule))
      .map((r) => String(r.id || '').trim())
      .filter(Boolean),
  );

  const alnText = await fs.readFile(alignmentPath, 'utf-8');
  const alnRecords = parseFastaRecords(alnText);
  const selected = [];
  for (const rec of alnRecords) {
    const id = String(rec.id || '').trim();
    if (!id || !passIds.has(id)) {
      continue;
    }
    const seq = String(rec.seq || '').replace(/-/g, '').toUpperCase();
    if (!seq) {
      continue;
    }
    selected.push(`>${rec.header || rec.id}`);
    selected.push(seq);
  }

  await fs.writeFile(outputFastaPath, selected.join('\n'), 'utf-8');
  return {
    passedInCsv: passIds.size,
    written: Math.floor(selected.length / 2),
    missingInAlignment: Math.max(0, passIds.size - Math.floor(selected.length / 2)),
    fasta: outputFastaPath,
  };
}

function fastaRecordMatchesIdentifier(record, identifier) {
  const needle = String(identifier || '').trim();
  if (!needle) return false;

  const recordId = String(record?.id || '').trim();
  const recordHeader = String(record?.header || '').trim();
  if (recordId === needle || recordHeader === needle) return true;

  const needleTokens = new Set(normalizeIdTokens(needle).map((token) => token.toLowerCase()));
  if (!needleTokens.size) needleTokens.add(needle.toLowerCase());
  return [recordId, recordHeader]
    .flatMap((value) => normalizeIdTokens(value))
    .some((token) => needleTokens.has(token.toLowerCase()));
}

async function prepareScoringAutoAlignment({ filteredFasta, referenceFasta, refId, outInputFasta, outAlignment }) {
  const totalSteps = 5;

  updateAlignmentProgress({ current: 1, total: totalSteps, phase: '读取候选 FASTA' });
  const filteredText = await fs.readFile(filteredFasta, 'utf-8');
  const filteredRecords = parseFastaRecords(filteredText);
  if (!filteredRecords.length) {
    throw new Error(`No sequences found in filtered FASTA: ${filteredFasta}`);
  }

  updateAlignmentProgress({ current: 2, total: totalSteps, phase: '读取参考 FASTA' });
  const refText = await fs.readFile(referenceFasta, 'utf-8');
  const refRecords = parseFastaRecords(refText);
  if (!refRecords.length) {
    throw new Error(`No reference sequences found in ${referenceFasta}`);
  }
  const token = String(refId || '').trim();
  const matchedRefRecord = token
    ? refRecords.find((record) => fastaRecordMatchesIdentifier(record, token))
    : null;
  const refRecord = matchedRefRecord || refRecords[0];
  const referenceId = String(refRecord?.id || refRecord?.header || '').trim();
  if (!matchedRefRecord) {
    pushRuntimeLine(`[scoring] reference id ${token || '(empty)'} not found, fallback to ${refRecord.id}`);
  }

  // Keep the designated reference first and avoid duplicating it if the
  // filtered candidate FASTA already contains the same sequence identifier.
  const filteredWithoutReference = filteredRecords.filter((record) => (
    !fastaRecordMatchesIdentifier(record, referenceId)
    && (!token || !fastaRecordMatchesIdentifier(record, token))
  ));
  const combined = [refRecord, ...filteredWithoutReference];

  updateAlignmentProgress({ current: 3, total: totalSteps, phase: '组装输入 FASTA' });
  const outLines = combined.flatMap((r) => [`>${r.header || r.id}`, String(r.seq || '').replace(/\s+/g, '').toUpperCase()]);
  await fs.writeFile(outInputFasta, outLines.join('\n'), 'utf-8');

  updateAlignmentProgress({ current: 4, total: totalSteps, phase: '运行 MAFFT' });
  const mafftOut = await runMafftAuto(outInputFasta);

  updateAlignmentProgress({ current: 5, total: totalSteps, phase: '写出对齐结果' });
  await fs.writeFile(outAlignment, mafftOut.stdout, 'utf-8');
  return { referenceId };
}

async function resolveDefaultReferenceFasta(workDir) {
  const candidates = [
    path.join(workDir, 'ref.fasta'),
    // Legacy fallbacks for old tasks created before generic rename:
    path.join(workDir, 'AAO_ref.fasta'),
    path.join(workDir, 'AOX_ref21.fasta'),
    path.join(workDir, 'AOX_ref.fasta'),
    path.join(workDir, 'AOX_ref_cdhit90.fasta'),
  ];
  for (const p of candidates) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // continue
    }
  }
  return candidates[0];
}

/**
 * Read the first record ID from a FASTA file to use as fallback refId.
 * Returns empty string if the file doesn't exist or has no records.
 */
async function resolveDefaultRefId(workDir) {
  const fastaPath = await resolveDefaultReferenceFasta(workDir);
  try {
    const text = await fs.readFile(fastaPath, 'utf-8');
    const records = parseFastaRecords(text);
    if (records.length > 0) {
      return records[0].id || '';
    }
  } catch {
    // file not found or unreadable
  }
  return '';
}

function parseCdHitClusters(clstrText) {
  const clusters = [];
  let current = null;
  const lines = String(clstrText || '').split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith('>Cluster')) {
      if (current) {
        clusters.push(current);
      }
      current = { name: line.slice(1), members: [] };
      continue;
    }
    if (!current) {
      continue;
    }

    const idMatch = line.match(/>(.+?)\.\.\./);
    if (!idMatch) {
      continue;
    }
    const id = String(idMatch[1] || '').trim();
    if (!id) {
      continue;
    }

    const representative = line.endsWith('*');
    const simMatch = line.match(/at\s+([0-9.]+)%/i);
    const similarity = simMatch ? Number(simMatch[1]) : null;
    current.members.push({ id, representative, similarity });
  }

  if (current) {
    clusters.push(current);
  }
  return clusters;
}

function normalizeIdTokens(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return [];
  }
  const first = text.split(/\s+/)[0] || text;
  const out = new Set([text, first]);
  if (first.includes('|')) {
    const parts = first.split('|').map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
      out.add(p);
    }
  }
  return Array.from(out);
}

function buildSequenceLookup(records) {
  const byToken = new Map();
  for (const rec of records || []) {
    const seq = String(rec?.seq || '').replace(/\s+/g, '').toUpperCase();
    if (!seq) {
      continue;
    }
    const tokens = new Set([
      ...normalizeIdTokens(rec?.id),
      ...normalizeIdTokens(rec?.header),
    ]);
    for (const token of tokens) {
      if (!byToken.has(token)) {
        byToken.set(token, seq);
      }
    }
  }
  return byToken;
}

function normalizeSimilarityMethod(method) {
  const m = String(method || 'mmseqs2').trim().toLowerCase();
  if (m === 'needleman-wunsch' || m === 'smith-waterman' || m === 'mmseqs2') {
    return m;
  }
  return 'mmseqs2';
}

function buildSimilarityPairKey(sourceId, targetId, symmetric = true) {
  const source = String(sourceId || '').trim();
  const target = String(targetId || '').trim();
  if (!source || !target) {
    return '';
  }
  if (!symmetric) {
    return `${source}::${target}`;
  }
  return source < target ? `${source}::${target}` : `${target}::${source}`;
}

function wrapFastaSequence(seq, width = 60) {
  const s = String(seq || '').replace(/\s+/g, '').toUpperCase();
  if (!s) {
    return '';
  }
  const out = [];
  for (let i = 0; i < s.length; i += width) {
    out.push(s.slice(i, i + width));
  }
  return out.join('\n');
}

async function parseMmseqsSimilarityTsv(tsvPath, queryAliasToId, targetAliasToId, symmetric = false, options = {}) {
  const similarityByPair = new Map();
  const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null;
  const totalBytes = Number((await fs.stat(tsvPath).catch(() => ({ size: 0 })))?.size || 0);
  let processedBytes = 0;
  let lastReported = -1;
  const stream = fsSync.createReadStream(tsvPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    processedBytes += Buffer.byteLength(String(rawLine || ''), 'utf-8') + 1;
    if (onProgress && totalBytes > 0) {
      const ratio = Math.max(0, Math.min(1, processedBytes / totalBytes));
      if (ratio >= 1 || ratio - lastReported >= 0.01) {
        onProgress(ratio);
        lastReported = ratio;
      }
    }

    const line = String(rawLine || '').trim();
    if (!line) {
      continue;
    }
    const cols = line.split('\t');
    if (cols.length < 3) {
      continue;
    }
    const queryAlias = String(cols[0] || '').trim();
    const targetAlias = String(cols[1] || '').trim();
    const simPct = Number(cols[2]);
    if (!queryAlias || !targetAlias || !Number.isFinite(simPct)) {
      continue;
    }

    const queryId = queryAliasToId.get(queryAlias) || '';
    const targetId = targetAliasToId.get(targetAlias) || '';
    if (!queryId || !targetId || queryId === targetId) {
      continue;
    }

    const key = buildSimilarityPairKey(queryId, targetId, symmetric);
    if (!key) {
      continue;
    }
    const prev = similarityByPair.get(key);
    if (!Number.isFinite(prev) || simPct > prev) {
      similarityByPair.set(key, simPct);
    }
  }

  if (onProgress) {
    onProgress(1);
  }

  return similarityByPair;
}

async function computePairSimilarityMapMmseqs(workDir, queryEntries, targetEntries, options = {}) {
  const phaseLabel = String(options?.phase || 'pairwise').trim() || 'pairwise';
  const symmetric = options?.symmetric === true;

  const dedupeEntries = (entries) => {
    const byId = new Map();
    for (const entry of entries || []) {
      const id = String(entry?.id || '').trim();
      const seq = String(entry?.seq || '').replace(/\s+/g, '').toUpperCase();
      if (!id || !seq || byId.has(id)) {
        continue;
      }
      byId.set(id, seq);
    }
    return Array.from(byId.entries()).map(([id, seq]) => ({ id, seq }));
  };

  const queryList = dedupeEntries(queryEntries);
  const targetList = dedupeEntries(targetEntries);

  const fallbackTotal = queryList.length * targetList.length;
  const overallTotalRaw = Number(options?.overallTotal);
  const overallTotal = Number.isFinite(overallTotalRaw)
    ? Math.max(1, overallTotalRaw)
    : Math.max(1, fallbackTotal);
  const completedBeforeRaw = Number(options?.completedBefore);
  const completedBefore = Number.isFinite(completedBeforeRaw)
    ? Math.max(0, completedBeforeRaw)
    : 0;

  const stageTotal = Math.max(1, overallTotal);
  const remainingStageTotal = Math.max(0, stageTotal - completedBefore);

  if (!queryList.length || !targetList.length) {
    updateNetworkAlignProgress({
      phase: phaseLabel,
      stageCurrent: Math.min(stageTotal, completedBefore),
      stageTotal,
      overallCurrent: Math.min(overallTotal, completedBefore),
      overallTotal,
    });
    return new Map();
  }

  let lastStageCurrent = -1;
  const updateMmseqsProgressByRatio = (ratio) => {
    const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
    const stageCurrent = Math.max(
      0,
      Math.min(stageTotal, completedBefore + Math.round(remainingStageTotal * clamped)),
    );
    if (stageCurrent === lastStageCurrent && clamped < 1) {
      return;
    }
    if (stageCurrent < lastStageCurrent) {
      return;
    }
    lastStageCurrent = stageCurrent;
    updateNetworkAlignProgress({
      phase: phaseLabel,
      stageCurrent,
      stageTotal,
      overallCurrent: Math.max(0, Math.min(overallTotal, stageCurrent)),
      overallTotal,
    });
  };

  updateMmseqsProgressByRatio(0);

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const mmseqDir = path.join(workDir, `.mmseqs_pairwise_${stamp}`);
  const queryFastaPath = path.join(mmseqDir, 'query.fasta');
  const targetFastaPath = path.join(mmseqDir, 'target.fasta');
  const queryDbPath = path.join(mmseqDir, 'query_db');
  const targetDbPath = path.join(mmseqDir, 'target_db');
  const resultDbPath = path.join(mmseqDir, 'result_db');
  const tmpDir = path.join(mmseqDir, 'tmp');
  const tsvPath = path.join(mmseqDir, 'result.tsv');

  const queryAliasToId = new Map();
  const targetAliasToId = new Map();

  const buildFastaText = (entries, aliasPrefix, aliasToId) => entries
    .map((entry, idx) => {
      const alias = `${aliasPrefix}${idx + 1}`;
      aliasToId.set(alias, entry.id);
      return `>${alias}\n${wrapFastaSequence(entry.seq)}`;
    })
    .join('\n') + '\n';

  try {
    await ensureDir(mmseqDir);
    await ensureDir(tmpDir);
    await fs.writeFile(queryFastaPath, buildFastaText(queryList, 'q', queryAliasToId), 'utf-8');
    await fs.writeFile(targetFastaPath, buildFastaText(targetList, 't', targetAliasToId), 'utf-8');
    updateMmseqsProgressByRatio(0.02);

    pushRuntimeLine(`[network] MMseqs2 ${phaseLabel}: ${queryList.length}x${targetList.length} sequences`);

    await runCmd(mmseqsBin, ['createdb', queryFastaPath, queryDbPath], workDir);
    updateMmseqsProgressByRatio(0.06);
    await runCmd(mmseqsBin, ['createdb', targetFastaPath, targetDbPath], workDir);
    updateMmseqsProgressByRatio(0.1);

    let searchRatio = 0.1;
    let searchTicker = null;
    const bumpSearchRatio = (delta) => {
      const n = Number(delta) || 0;
      if (n <= 0) {
        return;
      }
      searchRatio = Math.min(0.9, searchRatio + n);
      updateMmseqsProgressByRatio(searchRatio);
    };

    searchTicker = setInterval(() => {
      bumpSearchRatio(0.003);
    }, 800);
    await runCmd(mmseqsBin, [
      'search',
      queryDbPath,
      targetDbPath,
      resultDbPath,
      tmpDir,
      '--threads',
      String(mmseqsThreads),
      '--max-seqs',
      String(Math.max(1000, targetList.length + 100)),
      '-e',
      '1000000',
      '-s',
      '7.5',
    ], workDir, {
      onStdout: (chunk) => {
        const lines = String(chunk || '')
          .split(/\r?\n/)
          .filter((line) => String(line || '').trim())
          .length;
        if (lines > 0) {
          bumpSearchRatio(Math.min(0.05, lines * 0.0004));
        }
      },
      onStderr: (chunk) => {
        const lines = String(chunk || '')
          .split(/\r?\n/)
          .filter((line) => String(line || '').trim())
          .length;
        if (lines > 0) {
          bumpSearchRatio(Math.min(0.03, lines * 0.00025));
        }
      },
    }).finally(() => {
      if (searchTicker) {
        clearInterval(searchTicker);
      }
    });
    updateMmseqsProgressByRatio(0.92);

    let convertRatio = 0.92;
    const bumpConvertRatio = (delta) => {
      const n = Number(delta) || 0;
      if (n <= 0) {
        return;
      }
      convertRatio = Math.min(0.97, convertRatio + n);
      updateMmseqsProgressByRatio(convertRatio);
    };
    await runCmd(mmseqsBin, [
      'convertalis',
      queryDbPath,
      targetDbPath,
      resultDbPath,
      tsvPath,
      '--format-output',
      'query,target,pident',
    ], workDir, {
      onStdout: (chunk) => {
        const lines = String(chunk || '')
          .split(/\r?\n/)
          .filter((line) => String(line || '').trim())
          .length;
        if (lines > 0) {
          bumpConvertRatio(Math.min(0.02, lines * 0.0007));
        }
      },
      onStderr: (chunk) => {
        const lines = String(chunk || '')
          .split(/\r?\n/)
          .filter((line) => String(line || '').trim())
          .length;
        if (lines > 0) {
          bumpConvertRatio(Math.min(0.01, lines * 0.0005));
        }
      },
    });
    updateMmseqsProgressByRatio(0.97);

    const similarityByPair = await parseMmseqsSimilarityTsv(
      tsvPath,
      queryAliasToId,
      targetAliasToId,
      symmetric,
      {
        onProgress: (ratio) => {
          const tailRatio = 0.97 + (Math.max(0, Math.min(1, Number(ratio) || 0)) * 0.029);
          updateMmseqsProgressByRatio(tailRatio);
        },
      },
    );

    updateMmseqsProgressByRatio(1);

    pushRuntimeLine(`[network] MMseqs2 ${phaseLabel}: parsed ${similarityByPair.size} similarity pairs`);
    return similarityByPair;
  } finally {
    await fs.rm(mmseqDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function computePairSimilarityPctBatchBiopython(workDir, pairs, method, progress = {}) {
  const safePairs = Array.isArray(pairs) ? pairs : [];
  const BATCH_SIZE = 5000;

  const similarityMethod = normalizeSimilarityMethod(method);
  const scriptPath = path.join(projectRoot, 'backend', 'biopython_pairwise_similarity.py');

  const overallTotal = Math.max(
    1,
    Number.isFinite(Number(progress?.overallTotal))
      ? Number(progress.overallTotal)
      : safePairs.length,
  );
  const completedBefore = Math.max(
    0,
    Number.isFinite(Number(progress?.completedBefore))
      ? Number(progress.completedBefore)
      : 0,
  );
  const phaseLabel = String(progress?.phase || 'pairwise');
  const stageStart = Math.min(overallTotal, completedBefore);

  if (safePairs.length === 0) {
    updateNetworkAlignProgress({
      phase: phaseLabel,
      stageCurrent: stageStart,
      stageTotal: overallTotal,
      overallCurrent: stageStart,
      overallTotal,
    });
    return [];
  }

  updateNetworkAlignProgress({
    phase: phaseLabel,
    stageCurrent: stageStart,
    stageTotal: overallTotal,
    overallCurrent: stageStart,
    overallTotal,
  });

  const allResults = new Array(safePairs.length).fill(null);
  let completedSoFar = 0;

  for (let batchStart = 0; batchStart < safePairs.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, safePairs.length);
    const batchPairs = safePairs.slice(batchStart, batchEnd);
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const inputPath = path.join(workDir, `.biopython_pairs_${stamp}.json`);
    const outputPath = path.join(workDir, `.biopython_results_${stamp}.json`);

    const payload = {
      method: similarityMethod,
      phase: phaseLabel,
      scoring: {
        match: 2,
        mismatch: -1,
        open_gap: -1,
        extend_gap: -1,
      },
      pairs: batchPairs.map((p) => ({
        seqA: String(p?.seqA || ''),
        seqB: String(p?.seqB || ''),
      })),
    };

    try {
      await fs.writeFile(inputPath, JSON.stringify(payload), 'utf-8');
      let stdoutBuf = '';
      await runCmd(pythonBin, [scriptPath, inputPath, outputPath], pipelineRoot, {
        onStdout: (chunk) => {
          stdoutBuf += String(chunk || '');
          const lines = stdoutBuf.split(/\r?\n/);
          stdoutBuf = lines.pop() || '';
          for (const line of lines) {
            const text = String(line || '').trim();
            const m = /^PROGRESS\|([^|]+)\|(\d+)\|(\d+)$/i.exec(text);
            if (!m) {
              continue;
            }
            const cur = Number(m[2]);
            const subTotal = Number(m[3]);
            if (!Number.isFinite(cur) || !Number.isFinite(subTotal) || subTotal <= 0) {
              continue;
            }
            const cappedCur = Math.max(0, Math.min(subTotal, cur));
            const overallCurrent = Math.min(
              overallTotal,
              Math.max(0, completedBefore + completedSoFar + cappedCur),
            );
            updateNetworkAlignProgress({
              phase: m[1] || phaseLabel,
              stageCurrent: overallCurrent,
              stageTotal: overallTotal,
              overallCurrent,
              overallTotal,
            });
          }
        },
      });
      const raw = await fs.readFile(outputPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const batchResults = Array.isArray(parsed?.results) ? parsed.results : [];
      for (let i = 0; i < batchPairs.length; i += 1) {
        const n = Number(batchResults[i]);
        allResults[batchStart + i] = Number.isFinite(n) ? n : null;
      }
      completedSoFar += batchPairs.length;
    } catch (err) {
      throw new Error(`Biopython alignment failed: ${String(err)}`);
    } finally {
      await fs.rm(inputPath, { force: true }).catch(() => {});
      await fs.rm(outputPath, { force: true }).catch(() => {});
    }
  }

  const completedCurrent = Math.max(0, Math.min(overallTotal, completedBefore + safePairs.length));
  updateNetworkAlignProgress({
    phase: phaseLabel,
    stageCurrent: completedCurrent,
    stageTotal: overallTotal,
    overallCurrent: completedCurrent,
    overallTotal,
  });
  return allResults;
}

function resolveNetworkSourceFasta(workDir) {
  return [
    // After step 6, the CD-HIT representatives are the canonical input for
    // similarity calculation. Keep this ahead of the pre-clustering FASTA so
    // automatic resolution cannot silently bring removed sequences back.
    path.join(workDir, 'candidates_cdhit85.fasta'),
    path.join(workDir, 'scored_passed.fasta'),
    path.join(workDir, 'candidates.fasta'),
    path.join(workDir, 'hits_filtered.fasta'),
    path.join(workDir, 'merged_sequences.fasta'),
    // Legacy fallbacks for old tasks:
    path.join(workDir, 'AOX_candidates_cdhit85.fasta'),
    path.join(workDir, 'AOX_candidates_from_hits_len650_700_200.fasta'),
  ];
}

async function loadReferenceIdSet(referenceFastaPath) {
  const idSet = new Set();
  try {
    const text = await fs.readFile(referenceFastaPath, 'utf-8');
    const records = parseFastaRecords(text);
    for (const rec of records) {
      for (const token of normalizeIdTokens(rec?.id)) {
        idSet.add(token);
      }
      for (const token of normalizeIdTokens(rec?.header)) {
        idSet.add(token);
      }
    }
  } catch {
    // no-op
  }
  return idSet;
}

async function loadReferenceRecords(referenceFastaPath) {
  if (!referenceFastaPath) {
    return [];
  }
  try {
    const text = await fs.readFile(referenceFastaPath, 'utf-8');
    return parseFastaRecords(text);
  } catch {
    return [];
  }
}

function isReferenceNode(nodeId, referenceIdSet) {
  if (!referenceIdSet || referenceIdSet.size === 0) {
    return false;
  }
  return normalizeIdTokens(nodeId).some((token) => referenceIdSet.has(token));
}

async function firstExistingPath(candidates) {
  for (const p of candidates || []) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // continue
    }
  }
  return null;
}

async function buildNetworkFilesFromClusters(workDir, clusterFilePath, fallbackFastaPath, opts = {}) {
  const pairwiseThresholdPct = Number.isFinite(Number(opts?.pairwiseThresholdPct))
    ? Number(opts.pairwiseThresholdPct)
    : 85;
  const includeReferenceLinks = opts?.includeReferenceLinks === true;
  const similarityMethod = normalizeSimilarityMethod(opts?.similarityMethod);

  const sourceFastaPath = opts?.sourceFastaPath || fallbackFastaPath;
  const referenceFastaPath = opts?.referenceFastaPath || null;

  let clusters = [];
  let clusterFileReadable = false;
  try {
    const clstrText = await fs.readFile(clusterFilePath, 'utf-8');
    clusterFileReadable = true;
    clusters = parseCdHitClusters(clstrText);
  } catch {
    clusters = [];
  }

  if (!clusters.length) {
    if (clusterFileReadable) {
      throw new Error(`CD-HIT cluster file is empty or invalid: ${clusterFilePath}`);
    }
    const fastaText = await fs.readFile(sourceFastaPath, 'utf-8');
    const records = parseFastaRecords(fastaText);
    if (!records.length) {
      throw new Error('No sequences available to build network files');
    }
    clusters = [
      {
        name: 'Cluster_0',
        members: records.map((r, i) => ({ id: r.id, representative: i === 0, similarity: null })),
      },
    ];
  }

  const sourceFastaText = await fs.readFile(sourceFastaPath, 'utf-8');
  const sourceRecords = parseFastaRecords(sourceFastaText);
  const referenceIdSet = referenceFastaPath
    ? await loadReferenceIdSet(referenceFastaPath)
    : new Set();
  const referenceRecords = await loadReferenceRecords(referenceFastaPath);
  const seqByToken = buildSequenceLookup([...sourceRecords, ...referenceRecords]);

  // Build taxonomy lookup from hits_filtered.csv (key: target) and ref.csv (key: accession).
  const phylumByToken = new Map();
  const classByToken = new Map();
  const orderByToken = new Map();
  const familyByToken = new Map();
  const genusByToken = new Map();
  const speciesByToken = new Map();
  const kingdomByToken = new Map();
  const loadMetaCsv = async (csvPath, idCol) => {
    try {
      const { rows } = await readCsvRows(csvPath);
      for (const row of rows) {
        const rawId = String(row[idCol] || '').trim();
        if (!rawId) continue;
        const kingdom = String(row.kingdom || '').trim();
        const phylum = String(row.phylum || '').trim();
        const cls = String(row['class'] || '').trim();
        const order = String(row.order || '').trim();
        const family = String(row.family || '').trim();
        const genus = String(row.genus || '').trim();
        const species = String(row.species || '').trim();
        for (const token of normalizeIdTokens(rawId)) {
          if (kingdom && !kingdomByToken.has(token)) kingdomByToken.set(token, kingdom);
          if (phylum && !phylumByToken.has(token)) phylumByToken.set(token, phylum);
          if (cls && !classByToken.has(token)) classByToken.set(token, cls);
          if (order && !orderByToken.has(token)) orderByToken.set(token, order);
          if (family && !familyByToken.has(token)) familyByToken.set(token, family);
          if (genus && !genusByToken.has(token)) genusByToken.set(token, genus);
          if (species && !speciesByToken.has(token)) speciesByToken.set(token, species);
        }
      }
    } catch { /* file may not exist */ }
  };
  await loadMetaCsv(path.join(workDir, 'hits_filtered.csv'), 'target');
  await loadMetaCsv(path.join(workDir, 'ref.csv'), 'accession');
  // Also load from cached nodes metadata (preserved before deletion in compute-similarity)
  await loadMetaCsv(path.join(workDir, '.nodes_meta_cache.csv'), 'id');
  await loadMetaCsv(path.join(workDir, 'nodes.csv'), 'id');

  const lookupMeta = (nodeId) => {
    const tokens = normalizeIdTokens(nodeId);
    let kingdom = '';
    let phylum = '';
    let cls = '';
    let order = '';
    let family = '';
    let genus = '';
    let species = '';
    for (const t of tokens) {
      if (!kingdom) kingdom = kingdomByToken.get(t) || '';
      if (!phylum) phylum = phylumByToken.get(t) || '';
      if (!cls) cls = classByToken.get(t) || '';
      if (!order) order = orderByToken.get(t) || '';
      if (!family) family = familyByToken.get(t) || '';
      if (!genus) genus = genusByToken.get(t) || '';
      if (!species) species = speciesByToken.get(t) || '';
      if (kingdom && phylum && cls && order && family && genus && species) break;
    }
    return { kingdom, phylum, class: cls, order, family, genus, species };
  };

  const nodes = [];
  const edges = [];
  const seenEdge = new Set();
  const pushEdge = (sourceId, targetId, similarityPct, clusterName) => {
    if (!sourceId || !targetId || sourceId === targetId) {
      return;
    }
    const a = String(sourceId);
    const b = String(targetId);
    const key = buildSimilarityPairKey(a, b, true);
    if (seenEdge.has(key)) {
      return;
    }
    seenEdge.add(key);
    const sim = Number(similarityPct);
    edges.push({
      source: a,
      target: b,
      similarity: String(sim.toFixed(3)),
      weight: String(Math.max(0.01, sim / 100)),
      cluster: clusterName,
    });
  };
  const seenNode = new Set();
  const seenNodeToken = new Set();
  const markSeenNode = (nodeId) => {
    seenNode.add(nodeId);
    for (const token of normalizeIdTokens(nodeId)) {
      seenNodeToken.add(token);
    }
  };
  const hasSeenNode = (nodeId) => {
    if (seenNode.has(nodeId)) {
      return true;
    }
    const tokens = normalizeIdTokens(nodeId);
    return tokens.some((token) => seenNodeToken.has(token));
  };

  // The .clstr file contains every pre-deduplication member, while the FASTA
  // selected on the Similarity page may contain only CD-HIT representatives.
  // Nodes and pairwise jobs must both be driven by that exact FASTA. Use the
  // cluster file only as metadata; otherwise removed members reappear as
  // disconnected nodes and the step-6/step-7 sequence counts diverge.
  const clusterInfoByToken = new Map();
  for (const cluster of clusters) {
    const members = Array.isArray(cluster.members) ? cluster.members : [];
    for (const member of members) {
      const info = {
        name: cluster.name || 'Unclustered',
        size: Math.max(1, members.length),
        representative: member.representative === true,
      };
      for (const token of normalizeIdTokens(member.id)) {
        if (!clusterInfoByToken.has(token)) clusterInfoByToken.set(token, info);
      }
    }
  }

  const lookupClusterInfo = (record) => {
    const tokens = new Set([
      ...normalizeIdTokens(record?.id),
      ...normalizeIdTokens(record?.header),
    ]);
    for (const token of tokens) {
      const info = clusterInfoByToken.get(token);
      if (info) return info;
    }
    return null;
  };

  for (const record of sourceRecords) {
    const nodeId = String(record?.id || '').trim();
    if (!nodeId || hasSeenNode(nodeId)) continue;
    markSeenNode(nodeId);
    const clusterInfo = lookupClusterInfo(record);
    const meta = lookupMeta(nodeId);
    nodes.push({
      id: nodeId,
      cluster: clusterInfo?.name || 'Unclustered',
      cluster_size: clusterInfo?.size || 1,
      representative: clusterInfo ? (clusterInfo.representative ? '1' : '0') : '1',
      is_reference: isReferenceNode(nodeId, referenceIdSet) ? '1' : '0',
      kingdom: meta.kingdom,
      phylum: meta.phylum,
      class: meta.class,
      order: meta.order,
      family: meta.family,
      genus: meta.genus,
      species: meta.species,
    });
  }

  // Force all reference sequences into nodes, even if they are absent in clustered candidates.
  if (referenceRecords.length > 0) {
    const usedClusterNames = new Set(clusters.map((c) => c.name).filter(Boolean));
    let referenceClusterName = 'Reference_only';
    let suffix = 1;
    while (usedClusterNames.has(referenceClusterName)) {
      suffix += 1;
      referenceClusterName = `Reference_only_${suffix}`;
    }

    for (const rec of referenceRecords) {
      const refId = String(rec?.id || '').trim();
      if (!refId || hasSeenNode(refId)) {
        continue;
      }
      markSeenNode(refId);
      const meta = lookupMeta(refId);
      nodes.push({
        id: refId,
        cluster: referenceClusterName,
        cluster_size: 1,
        representative: '1',
        is_reference: '1',
        kingdom: meta.kingdom,
        phylum: meta.phylum,
        class: meta.class,
        order: meta.order,
        family: meta.family,
        genus: meta.genus,
        species: meta.species,
      });
    }

      // Always compute reference-candidate edges — they are essential for
      // seeing where reference sequences sit in the similarity graph,
      // regardless of the includeReferenceLinks toggle.
      {
      const refSeqById = new Map();
      for (const rec of referenceRecords) {
        const refId = String(rec?.id || '').trim();
        const refSeq = String(rec?.seq || '').replace(/\s+/g, '').toUpperCase();
        if (refId && refSeq) {
          refSeqById.set(refId, refSeq);
        }
      }

      const refEdgeRequests = [];
      for (const [refId, refSeq] of refSeqById.entries()) {
        for (const node of nodes) {
          const nodeId = String(node?.id || '').trim();
          if (!nodeId || nodeId === refId) {
            continue;
          }
          if (String(node?.is_reference || '0') === '1' && node.cluster?.startsWith('Reference_only')) {
            continue;
          }

          const nodeSeq = seqByToken.get(nodeId) || null;
          if (!nodeSeq) {
            continue;
          }

          refEdgeRequests.push({
            sourceId: refId,
            targetId: nodeId,
            clusterName: 'Reference_links',
            seqA: refSeq,
            seqB: nodeSeq,
          });
        }
      }

      const pairwiseTotal = refEdgeRequests.length;
      const runReferenceLinksWithBiopython = async () => {
        const refScores = await computePairSimilarityPctBatchBiopython(workDir, refEdgeRequests, similarityMethod, {
          phase: 'reference-links',
          overallTotal: pairwiseTotal,
          completedBefore: 0,
        });
        for (let idx = 0; idx < refEdgeRequests.length; idx += 1) {
          const req = refEdgeRequests[idx];
          const simPct = refScores[idx];
          if (!Number.isFinite(simPct) || simPct < pairwiseThresholdPct) {
            continue;
          }
          pushEdge(req.sourceId, req.targetId, simPct, req.clusterName);
        }
      };

      if (pairwiseTotal > 0 && similarityMethod === 'mmseqs2') {
        try {
          const refEntries = Array.from(refSeqById.entries()).map(([id, seq]) => ({ id, seq }));
          const nodeEntries = nodes
            .map((node) => {
              const nodeId = String(node?.id || '').trim();
              return {
                id: nodeId,
                seq: nodeId ? (seqByToken.get(nodeId) || '') : '',
              };
            })
            .filter((entry) => entry.id && entry.seq);

          const similarityByPair = await computePairSimilarityMapMmseqs(workDir, refEntries, nodeEntries, {
            phase: 'reference-links',
            overallTotal: pairwiseTotal,
            completedBefore: 0,
            symmetric: false,
          });

          for (const req of refEdgeRequests) {
            const key = buildSimilarityPairKey(req.sourceId, req.targetId, false);
            const simPct = similarityByPair.get(key);
            if (!Number.isFinite(simPct) || simPct < pairwiseThresholdPct) {
              continue;
            }
            pushEdge(req.sourceId, req.targetId, simPct, req.clusterName);
          }
        } catch (err) {
          pushRuntimeLine(`[network] MMseqs2 failed in reference-links, fallback to Biopython: ${String(err)}`);
          await runReferenceLinksWithBiopython();
        }
      } else {
        await runReferenceLinksWithBiopython();
      }
    }
  }

  // Candidate sequences are pairwise compared (all-vs-all) with the selected alignment method.
  // Pairs are generated and processed in batches to avoid memory exhaustion.
  const candidateIds = nodes
    .filter((node) => String(node.is_reference || '') !== '1')
    .map((node) => String(node.id || '').trim())
    .filter(Boolean);

  // Pre-calculate total pair count for progress tracking.
  const n = candidateIds.length;
  const totalPairs = (n * (n - 1)) / 2;
  pushRuntimeLine(`[network] candidate pairwise: ${n} sequences → ${totalPairs} pairs`);

  const computeCandidatePairsWithBiopython = async () => {
    const PAIR_BATCH = 5000;
    let pairsDone = 0;
    let batchBuf = [];
    let batchMeta = []; // [{sourceId, targetId}]

    const flushBatch = async () => {
      if (!batchBuf.length) return;
      const scores = await computePairSimilarityPctBatchBiopython(workDir, batchBuf, similarityMethod, {
        phase: 'candidate-pairwise',
        overallTotal: totalPairs,
        completedBefore: pairsDone,
      });
      for (let k = 0; k < batchMeta.length; k += 1) {
        const simPct = scores[k];
        if (!Number.isFinite(simPct) || simPct < pairwiseThresholdPct) continue;
        pushEdge(batchMeta[k].sourceId, batchMeta[k].targetId, simPct, 'Pairwise');
      }
      pairsDone += batchBuf.length;
      batchBuf = [];
      batchMeta = [];
    };

    for (let i = 0; i < candidateIds.length; i += 1) {
      const idA = candidateIds[i];
      const seqA = seqByToken.get(idA) || null;
      if (!seqA) continue;
      for (let j = i + 1; j < candidateIds.length; j += 1) {
        const idB = candidateIds[j];
        const seqB = seqByToken.get(idB) || null;
        if (!seqB) continue;
        batchBuf.push({ seqA, seqB });
        batchMeta.push({ sourceId: idA, targetId: idB });
        if (batchBuf.length >= PAIR_BATCH) {
          await flushBatch();
        }
      }
    }
    await flushBatch();
  };

  if (totalPairs > 0 && similarityMethod === 'mmseqs2') {
    try {
      const candidateEntries = candidateIds
        .map((id) => ({ id, seq: seqByToken.get(id) || '' }))
        .filter((entry) => entry.seq);

      const similarityByPair = await computePairSimilarityMapMmseqs(workDir, candidateEntries, candidateEntries, {
        phase: 'candidate-pairwise',
        overallTotal: totalPairs,
        completedBefore: 0,
        symmetric: true,
      });

      for (let i = 0; i < candidateIds.length; i += 1) {
        const idA = candidateIds[i];
        for (let j = i + 1; j < candidateIds.length; j += 1) {
          const idB = candidateIds[j];
          const key = buildSimilarityPairKey(idA, idB, true);
          const simPct = similarityByPair.get(key);
          if (!Number.isFinite(simPct) || simPct < pairwiseThresholdPct) {
            continue;
          }
          pushEdge(idA, idB, simPct, 'Pairwise');
        }
      }
    } catch (err) {
      pushRuntimeLine(`[network] MMseqs2 failed in candidate-pairwise, fallback to Biopython: ${String(err)}`);
      await computeCandidatePairsWithBiopython();
    }
  } else {
    await computeCandidatePairsWithBiopython();
  }

  const nodesPath = path.join(workDir, 'nodes.csv');
  const edgesPath = path.join(workDir, 'edges_similarity.csv');
  await writeCsvRows(nodesPath, ['id', 'cluster', 'cluster_size', 'representative', 'is_reference', 'kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species'], nodes);
  await writeCsvRows(edgesPath, ['source', 'target', 'similarity', 'weight', 'cluster'], edges);
  return { nodesPath, edgesPath, nodeCount: nodes.length, edgeCount: edges.length };
}

function networkBuildMetaPath(workDir) {
  return path.join(workDir, 'network_build_meta.json');
}

function networkStaleMetaPath(workDir) {
  return path.join(workDir, '.network_similarity_stale.json');
}

async function readNetworkStaleMeta(workDir) {
  try {
    const raw = await fs.readFile(networkStaleMetaPath(workDir), 'utf-8');
    const meta = JSON.parse(raw);
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

async function markNetworkArtifactsStale(workDir, meta = {}) {
  await fs.writeFile(networkStaleMetaPath(workDir), JSON.stringify({
    markedAt: Date.now(),
    reason: 'clustering-output-changed',
    ...meta,
  }, null, 2), 'utf-8');
}

async function clearNetworkArtifactsStale(workDir) {
  await fs.rm(networkStaleMetaPath(workDir), { force: true }).catch(() => {});
}

async function readNetworkBuildMeta(workDir) {
  try {
    const raw = await fs.readFile(networkBuildMetaPath(workDir), 'utf-8');
    const meta = JSON.parse(raw);
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

async function writeNetworkBuildMeta(workDir, meta) {
  const payload = {
    formatVersion: 1,
    builtAt: Date.now(),
    ...meta,
  };
  await fs.writeFile(networkBuildMetaPath(workDir), JSON.stringify(payload, null, 2), 'utf-8');
}

async function ensureNetworkFiles(workDir, opts = {}) {
  const nodesPath = path.join(workDir, 'nodes.csv');
  const edgesPath = path.join(workDir, 'edges_similarity.csv');
  const includeReferenceLinks = opts?.includeReferenceLinks === true;
  const similarityMethod = normalizeSimilarityMethod(opts?.similarityMethod);
  const forceRebuild = opts?.forceRebuild === true;
  const resolveOptionalFastaPath = (rawPath) => {
    const text = String(rawPath || '').trim();
    if (!text) {
      return null;
    }
    const resolved = path.isAbsolute(text) ? path.resolve(text) : path.resolve(workDir, text);
    assertPathInsideDir(resolved, pipelineRoot);
    return resolved;
  };
  const sourceFastaPath = resolveOptionalFastaPath(opts?.sourceFastaPath);
  const referenceFastaPath = resolveOptionalFastaPath(opts?.referenceFastaPath);

  const buildFreshNetworkFiles = async () => {
    const clusteredFasta = path.join(workDir, 'candidates_cdhit85.fasta');
    const clusterFile = `${clusteredFasta}.clstr`;
    const autoSourceFasta = await firstExistingPath(resolveNetworkSourceFasta(workDir));
    let sourceFasta = sourceFastaPath;
    if (sourceFasta) {
      try {
        await fs.access(sourceFasta);
      } catch {
        pushRuntimeLine(`[network] source FASTA not found: ${sourceFasta}; fallback to auto-detected source`);
        sourceFasta = null;
      }
    }
    if (!sourceFasta) {
      sourceFasta = autoSourceFasta;
    }
    if (!sourceFasta) {
      throw new Error('No candidate FASTA found. Please set Candidate FASTA path on Similarity page.');
    }

    // Auto-run cd-hit if the cluster file is missing or empty/invalid.
    let clusterFileReady = false;
    try {
      const clstrText = await fs.readFile(clusterFile, 'utf-8');
      clusterFileReady = parseCdHitClusters(clstrText).length > 0;
      if (!clusterFileReady) {
        pushRuntimeLine('[network] cd-hit cluster file is empty or invalid — auto-running cd-hit at 85% identity');
      }
    } catch {
      pushRuntimeLine('[network] No cd-hit cluster file found — auto-running cd-hit at 85% identity');
    }
    if (!clusterFileReady) {
      await runCmd('cd-hit', ['-i', sourceFasta, '-o', clusteredFasta, '-c', '0.85', '-n', '5', '-d', '0']);
      pushRuntimeLine('[network] cd-hit auto-clustering complete');
    }

    const referenceFasta = referenceFastaPath || await resolveDefaultReferenceFasta(workDir);
    // Persist the full similarity graph once and apply threshold filtering later
    // for browser/Cytoscape views. This avoids "poisoning" task artifacts with
    // whichever threshold happened to be selected on the first load/push.
    const buildPairwiseThresholdPct = 0;
    const built = await buildNetworkFilesFromClusters(workDir, clusterFile, clusteredFasta, {
      sourceFastaPath: sourceFasta,
      referenceFastaPath: referenceFasta,
      pairwiseThresholdPct: buildPairwiseThresholdPct,
      includeReferenceLinks,
      similarityMethod,
    });
    await writeNetworkBuildMeta(workDir, {
      pairwiseThresholdPct: buildPairwiseThresholdPct,
      includeReferenceLinks,
      similarityMethod,
      sourceFastaPath: sourceFasta,
      referenceFastaPath: referenceFasta,
    });
    await clearNetworkArtifactsStale(workDir);
    return { nodesPath: built.nodesPath, edgesPath: built.edgesPath, generated: true };
  };

  if (forceRebuild) {
    return await buildFreshNetworkFiles();
  }

  // Loading or pushing an existing network must never launch an expensive
  // similarity calculation implicitly. Configuration changes are applied only
  // through an explicit force-recompute request from the Similarity page.
  try {
    await Promise.all([fs.access(nodesPath), fs.access(edgesPath)]);
    return { nodesPath, edgesPath, generated: false };
  } catch {
    return await buildFreshNetworkFiles();
  }
}

function filterEdgesByThresholdPct(rows, thresholdPct) {
  const threshold = Number.isFinite(Number(thresholdPct)) ? Number(thresholdPct) : 0;
  return (rows || []).filter((row) => {
    const sim = toFiniteNumber(row?.similarity, null);
    if (sim !== null) {
      return sim >= threshold;
    }
    const weight = toFiniteNumber(row?.weight, null);
    if (weight !== null) {
      return weight * 100 >= threshold;
    }
    return false;
  });
}

const MAX_BROWSER_GRAPH_EDGES = 20000;

function chooseBrowserGraphThreshold(rows, requestedThresholdPct, maxEdges = MAX_BROWSER_GRAPH_EDGES) {
  const requested = Number.isFinite(Number(requestedThresholdPct)) ? Number(requestedThresholdPct) : 80;
  const boundedRequested = Math.max(40, Math.min(100, requested));
  const safeMaxEdges = Number.isFinite(Number(maxEdges)) && Number(maxEdges) > 0 ? Number(maxEdges) : MAX_BROWSER_GRAPH_EDGES;

  let appliedThreshold = boundedRequested;
  let filteredRows = filterEdgesByThresholdPct(rows, appliedThreshold);
  while (appliedThreshold < 100 && filteredRows.length > safeMaxEdges) {
    appliedThreshold += 1;
    filteredRows = filterEdgesByThresholdPct(rows, appliedThreshold);
  }

  return {
    requestedThresholdPct: boundedRequested,
    appliedThresholdPct: appliedThreshold,
    thresholdAdjusted: appliedThreshold > boundedRequested,
    maxEdges: safeMaxEdges,
    filteredRows,
  };
}

function normalizeCyRestBaseUrl(raw) {
  const text = String(raw || 'http://localhost:1234/v1').trim();
  const withProto = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  const u = new URL(withProto);
  // SECURITY: only allow localhost to prevent SSRF
  const allowedHosts = ['localhost', '127.0.0.1', '::1'];
  if (!allowedHosts.includes(u.hostname)) {
    throw new Error(`CyREST baseUrl must be localhost (got ${u.hostname})`);
  }
  const pathname = String(u.pathname || '').replace(/\/+$/, '');
  u.pathname = pathname && pathname !== '/' ? pathname : '/v1';
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/$/, '');
}

async function parseResponseBodySafe(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function cyrestRequest(baseUrl, method, endpointPath, body) {
  const response = await fetch(`${baseUrl}${endpointPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await parseResponseBodySafe(response);
  if (!response.ok) {
    const details = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
    throw new Error(`CyREST request failed: ${method} ${endpointPath} (${response.status}) ${details.slice(0, 500)}`);
  }
  return payload;
}

function parseCyNetworkSuid(payload) {
  if (typeof payload === 'number' && Number.isFinite(payload)) {
    return payload;
  }
  if (typeof payload === 'string') {
    const n = Number(payload);
    return Number.isFinite(n) ? n : null;
  }
  if (payload && typeof payload === 'object') {
    const candidates = [payload.networkSUID, payload.suid, payload.id, payload.network];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n)) {
        return n;
      }
    }
  }
  return null;
}

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function computeFiniteMinMax(values) {
  let min = null;
  let max = null;
  for (const value of values) {
    const n = toFiniteNumber(value, null);
    if (n === null) {
      continue;
    }
    if (min === null || n < min) {
      min = n;
    }
    if (max === null || n > max) {
      max = n;
    }
  }
  return { min, max };
}

function buildCyNetworkPayload(nodesRows, edgesRows, title) {
  const nodeElements = [];
  const seen = new Set();
  const tokenToCanonical = new Map(); // token -> canonical node id

  // Helper: extract the most meaningful accession token from an ID
  const extractAccession = (rawId) => {
    const tokens = normalizeIdTokens(rawId);
    // Prefer accession-like tokens (e.g. WP_013440946.1) over short prefixes
    const accs = tokens.filter(t => t.length >= 4 && !/^(ref|gb|emb|sp|tr|pdb|dbj|pir|prf|gnl|lcl)$/i.test(t) && t !== rawId);
    return accs.length > 0 ? accs[0] : rawId;
  };

  // Resolve a raw ID to its canonical node ID (merging ref|WP_X| with WP_X)
  const resolveId = (rawId) => {
    if (seen.has(rawId)) return rawId;
    const acc = extractAccession(rawId);
    if (tokenToCanonical.has(acc)) return tokenToCanonical.get(acc);
    return rawId;
  };

  for (const row of nodesRows) {
    const rawId = String(row.id || row.uniprot_identifier || row.name || '').trim();
    if (!rawId) continue;
    const acc = extractAccession(rawId);
    // Check if a node with the same accession already exists
    if (tokenToCanonical.has(acc)) {
      // Merge: enrich existing node if it has less metadata
      const existingId = tokenToCanonical.get(acc);
      const existingNode = nodeElements.find(n => n.data.id === existingId);
      if (existingNode) {
        // Prefer the row with more taxonomy data
        for (const key of ['kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species']) {
          if (!existingNode.data[key] && row[key]) {
            existingNode.data[key] = row[key];
          }
        }
        // If existing is reference, keep is_reference=1
        if (String(row.is_reference || '0') === '1') {
          existingNode.data.is_reference = '1';
        }
      }
      continue;
    }
    if (seen.has(rawId)) continue;
    seen.add(rawId);
    tokenToCanonical.set(acc, rawId);
    // Also map the full rawId tokens
    for (const t of normalizeIdTokens(rawId)) {
      if (t.length >= 4 && !tokenToCanonical.has(t)) {
        tokenToCanonical.set(t, rawId);
      }
    }
    nodeElements.push({
      data: {
        id: rawId,
        name: rawId,
        ...row,
        __blank_label__: '',
      },
    });
  }

  const edgeElements = [];
  const seenEdgeKey = new Set();
  for (let i = 0; i < edgesRows.length; i += 1) {
    const row = edgesRows[i] || {};
    let source = String(row.source || '').trim();
    let target = String(row.target || '').trim();
    if (!source || !target) continue;

    // Resolve to canonical IDs
    source = resolveId(source);
    target = resolveId(target);
    if (source === target) continue;

    // Deduplicate edges after ID normalization
    const edgeKey = source < target ? `${source}::${target}` : `${target}::${source}`;
    if (seenEdgeKey.has(edgeKey)) continue;
    seenEdgeKey.add(edgeKey);

    if (!seen.has(source)) {
      seen.add(source);
      nodeElements.push({ data: { id: source, name: source, __blank_label__: '' } });
    }
    if (!seen.has(target)) {
      seen.add(target);
      nodeElements.push({ data: { id: target, name: target, __blank_label__: '' } });
    }

    edgeElements.push({
      data: {
        id: `e_${edgeElements.length + 1}_${source}_${target}`,
        source,
        target,
        ...row,
        source,
        target,
        interaction: String(row.interaction || 'pp'),
        weight: toFiniteNumber(row.weight, 1),
        similarity: toFiniteNumber(row.similarity, null),
      },
    });
  }

  return {
    data: { name: String(title || 'Similarity Network') },
    elements: {
      nodes: nodeElements,
      edges: edgeElements,
    },
  };
}

function pickCategoryColumn(nodesRows, preferred) {
  if (preferred) {
    const col = preferred.toLowerCase().trim();
    if (nodesRows.some((r) => r[col] && String(r[col]).trim())) return col;
  }
  if (nodesRows.some((r) => String(r.phylum || '').trim())) {
    return 'phylum';
  }
  if (nodesRows.some((r) => String(r['class'] || '').trim())) {
    return 'class';
  }
  if (nodesRows.some((r) => String(r.kingdom || '').trim())) {
    return 'kingdom';
  }
  if (nodesRows.some((r) => String(r.cluster || '').trim())) {
    return 'cluster';
  }
  return null;
}

function buildCategoryColorMap(values) {
  const palette = [
    '#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1',
    '#FF9DA7', '#9C755F', '#BAB0AC', '#1B9E77', '#D95F02', '#7570B3', '#E7298A',
    '#66A61E', '#E6AB02', '#A6761D', '#666666',
  ];
  const uniq = Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean)));
  return uniq.map((key, idx) => ({ key, value: palette[idx % palette.length] }));
}

async function upsertCytoscapeStyle(baseUrl, opts) {
  const styleName = String(opts?.styleName || 'phylum_style').trim() || 'phylum_style';
  const categoryColumn = opts?.categoryColumn || null;
  const categories = Array.isArray(opts?.categories) ? opts.categories : [];
  const hasReferenceFlag = Boolean(opts?.hasReferenceFlag);
  const weightMin = toFiniteNumber(opts?.weightMin, null);
  const weightMax = toFiniteNumber(opts?.weightMax, null);

  const existing = await cyrestRequest(baseUrl, 'GET', '/styles', undefined);
  if (Array.isArray(existing) && existing.includes(styleName)) {
    await cyrestRequest(baseUrl, 'DELETE', `/styles/${encodeURIComponent(styleName)}`, undefined);
  }

  const defaults = [
    { visualProperty: 'NODE_SHAPE', value: 'ELLIPSE' },
    { visualProperty: 'NODE_SIZE', value: 22 },
    { visualProperty: 'NODE_BORDER_WIDTH', value: 0.5 },
    { visualProperty: 'NODE_BORDER_PAINT', value: '#333333' },
    { visualProperty: 'NODE_LABEL', value: '' },
    { visualProperty: 'NODE_LABEL_TRANSPARENCY', value: 0 },
    { visualProperty: 'EDGE_STROKE_UNSELECTED_PAINT', value: '#999999' },
    { visualProperty: 'EDGE_TRANSPARENCY', value: 150 },
  ];

  const mappings = [];

  mappings.push({
    mappingType: 'passthrough',
    mappingColumn: '__blank_label__',
    mappingColumnType: 'String',
    visualProperty: 'NODE_LABEL',
  });

  if (categoryColumn && categories.length) {
    mappings.push({
      mappingType: 'discrete',
      mappingColumn: categoryColumn,
      mappingColumnType: 'String',
      visualProperty: 'NODE_FILL_COLOR',
      map: categories,
    });
  }

  if (hasReferenceFlag) {
    mappings.push({
      mappingType: 'discrete',
      mappingColumn: 'is_reference',
      mappingColumnType: 'String',
      visualProperty: 'NODE_SIZE',
      map: [
        { key: '0', value: '22' },
        { key: '1', value: '38' },
      ],
    });
    mappings.push({
      mappingType: 'discrete',
      mappingColumn: 'is_reference',
      mappingColumnType: 'String',
      visualProperty: 'NODE_BORDER_WIDTH',
      map: [
        { key: '0', value: '0.5' },
        { key: '1', value: '6.0' },
      ],
    });
    mappings.push({
      mappingType: 'discrete',
      mappingColumn: 'is_reference',
      mappingColumnType: 'String',
      visualProperty: 'NODE_BORDER_TRANSPARENCY',
      map: [
        { key: '0', value: '190' },
        { key: '1', value: '255' },
      ],
    });
    mappings.push({
      mappingType: 'discrete',
      mappingColumn: 'is_reference',
      mappingColumnType: 'String',
      visualProperty: 'NODE_BORDER_PAINT',
      map: [
        { key: '0', value: '#333333' },
        { key: '1', value: '#FF3B30' },
      ],
    });
  }

  if (weightMin !== null && weightMax !== null && weightMax >= weightMin) {
    const mid = (weightMin + weightMax) / 2;
    mappings.push({
      mappingType: 'continuous',
      mappingColumn: 'weight',
      mappingColumnType: 'Double',
      visualProperty: 'EDGE_WIDTH',
      points: [
        { value: weightMin, lesser: '0.5', equal: '0.5', greater: '0.5' },
        { value: mid, lesser: '3.0', equal: '3.0', greater: '3.0' },
        { value: weightMax, lesser: '6.0', equal: '6.0', greater: '6.0' },
      ],
    });
  }

  await cyrestRequest(baseUrl, 'POST', '/styles', {
    title: styleName,
    defaults,
    mappings,
  });

  return { styleName, categoryColumn };
}

route.get('/api/tasks', async (_req, res) => {
  try {
    const tasks = await listTasks();
    res.json({ ok: true, tasks });
  } catch (err) {
    jsonError(res, 'Failed to list tasks', err);
  }
});

route.post('/api/tasks', async (req, res) => {
  try {
    const rawTaskId = req.body?.taskId ? String(req.body.taskId) : '';
    const taskId = rawTaskId ? normalizeTaskId(rawTaskId) : generateTaskId();
    if (RESERVED_TASK_IDS.has(taskId)) {
      res.status(400).json({ ok: false, message: `taskId "${taskId}" is reserved` });
      return;
    }

    await ensureDir(tasksRoot);
    const taskDir = path.join(tasksRoot, taskId);
    try {
      await fs.mkdir(taskDir);
    } catch (err) {
      if (String(err).includes('EEXIST')) {
        res.status(409).json({ ok: false, message: `Task already exists: ${taskId}` });
        return;
      }
      throw err;
    }

    const rawModule = String(req.body?.module || '').trim().toLowerCase();
    const taskModule = (rawModule === 'hmmer' || rawModule === 'blast' || rawModule === 'compare') ? rawModule : null;
    const meta = {
      id: taskId,
      createdAt: Date.now(),
      name: String(req.body?.name || taskId),
      note: String(req.body?.note || ''),
      module: taskModule,
    };
    await fs.writeFile(path.join(taskDir, 'task.json'), JSON.stringify(meta, null, 2), 'utf-8');
    res.json({ ok: true, task: { id: taskId, workDir: taskDir, ...meta } });
  } catch (err) {
    jsonError(res, 'Failed to create task', err);
  }
});


route.post('/api/tasks/:taskId/duplicate', async (req, res) => {
  try {
    const srcTaskId = normalizeTaskId(req.params.taskId);
    const rawNewTaskId = req.body?.newTaskId ? String(req.body.newTaskId) : '';
    const newTaskId = rawNewTaskId ? normalizeTaskId(rawNewTaskId) : generateTaskId();
    const newName = req.body?.name ? String(req.body.name) : `${srcTaskId} (Copy)`;

    if (RESERVED_TASK_IDS.has(newTaskId)) {
      res.status(400).json({ ok: false, message: `taskId "${newTaskId}" is reserved` });
      return;
    }

    const srcDir = path.join(tasksRoot, srcTaskId);
    const newDir = path.join(tasksRoot, newTaskId);

    try { await fs.stat(srcDir); } catch(e) { return res.status(404).json({ok:false, message: `Source task not found: ${srcTaskId}`}); }
    try { await fs.stat(newDir); return res.status(409).json({ok:false, message: `Target task already exists: ${newTaskId}`}); } catch(e) {}

    await fs.cp(srcDir, newDir, { recursive: true, force: false });

    // Update task.json
    const metaPath = path.join(newDir, 'task.json');
    let meta = { module: null, name: newName, note: '' };
    try {
      const b = await fs.readFile(metaPath, 'utf8');
      Object.assign(meta, JSON.parse(b));
    } catch(e) {}
    meta.id = newTaskId;
    meta.createdAt = Date.now();
    meta.name = newName;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    res.json({ ok: true, task: { id: newTaskId, workDir: newDir, ...meta } });
  } catch (err) {
    jsonError(res, 'Failed to duplicate task', err);
  }
});

route.delete('/api/tasks/:taskId', async (req, res) => {
  try {
    const taskId = normalizeTaskId(req.params.taskId);
    if (RESERVED_TASK_IDS.has(taskId)) {
      res.status(400).json({ ok: false, message: `${taskId} task cannot be deleted` });
      return;
    }
    const runtimeState = getRuntimeState(taskId);
    if (runtimeState.active) {
      res.status(409).json({ ok: false, message: `Task is running: ${runtimeState.task}` });
      return;
    }
    await fs.rm(path.join(tasksRoot, taskId), { recursive: true, force: true });
    runtimeStates.delete(taskId);
    res.json({ ok: true, taskId });
  } catch (err) {
    jsonError(res, 'Failed to delete task', err);
  }
});

route.get('/api/health', async (req, res) => {
  const toolBins = {
    'cd-hit': 'cd-hit',
    mafft: 'mafft',
    hmmbuild: 'hmmbuild',
    hmmsearch: 'hmmsearch',
    blastp: 'blastp',
    makeblastdb: 'makeblastdb',
    mmseqs: mmseqsBin,
  };
  const toolStates = {};
  const pythonPackages = { pandas: false, biopython: false, requests: false, tqdm: false };
  const { taskId, workDir } = await resolveWorkDirForReq(req);

  await Promise.all(Object.entries(toolBins).map(async ([name, executable]) => {
    try {
      await runCmd('bash', ['-lc', 'command -v -- "$1"', 'tool-check', executable], pipelineRoot, { timeoutMs: 5000 });
      toolStates[name] = true;
    } catch {
      toolStates[name] = false;
    }
  }));

  let pythonAvailable = false;
  try {
    const probe = [
      'import importlib.util, json',
      "packages = {'pandas': 'pandas', 'biopython': 'Bio', 'requests': 'requests', 'tqdm': 'tqdm'}",
      'print(json.dumps({name: importlib.util.find_spec(module) is not None for name, module in packages.items()}))',
    ].join('\n');
    const { stdout } = await runCmd(pythonBin, ['-c', probe], pipelineRoot, { timeoutMs: 10_000 });
    Object.assign(pythonPackages, JSON.parse(stdout.trim()));
    pythonAvailable = true;
  } catch {
    // Keep all package states false when Python itself is unavailable or the
    // import probe cannot run.
  }

  const predServices = await checkAllPredictionServices();
  const ready = Object.values(toolStates).every(Boolean)
    && pythonAvailable
    && Object.values(pythonPackages).every(Boolean);

  res.json({
    ok: true,
    ready,
    pipelineRoot,
    workDir,
    taskId,
    pythonBin,
    pythonAvailable,
    pythonPackages,
    tools: toolStates,
    predictionServices: {
      cataPro: { url: CATAPRO_URL, online: predServices.cataPro },
      solubility: { url: SOL_URL, online: predServices.sol },
      ec: { url: EC_URL, online: predServices.ec },
      tm: { url: TM_URL, online: predServices.tm },
    },
  });
});

route.get('/api/runtime/logs', async (req, res) => {
  const taskId = getTaskIdFromReq(req);
  const runtimeState = getRuntimeState(taskId);
  const limit = Math.max(10, Math.min(1000, Number(req.query.limit || 200)));
  const lines = runtimeState.lines.slice(-limit).map(
    (l) => String(l).replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  );
  res.json({
    ok: true,
    active: runtimeState.active,
    task: runtimeState.task,
    startedAt: runtimeState.startedAt,
    updatedAt: runtimeState.updatedAt,
    meta: runtimeState.meta,
    taskId,
    lines,
  });
});

route.get('/api/pipeline/state', async (req, res) => {
  try {
    const { taskId, workDir } = await resolveWorkDirForReq(req);
    const module = String(req.query?.module || '').trim().toLowerCase() || null;
    const { exists, state } = await readPipelineState(workDir, module);
    res.json({ ok: true, taskId, exists, state });
  } catch (err) {
    jsonError(res, 'Failed to load pipeline state', err);
  }
});

route.post('/api/pipeline/state', async (req, res) => {
  try {
    const { taskId, workDir } = await resolveWorkDirForReq(req);
    const state = req.body?.state;
    if (!state || typeof state !== 'object') {
      res.status(400).json({ ok: false, message: 'state is required and must be object' });
      return;
    }
    const module = String(req.body?.module || req.query?.module || '').trim().toLowerCase() || null;
    await writePipelineState(workDir, state, module);
    res.json({ ok: true, taskId, saved: true });
  } catch (err) {
    jsonError(res, 'Failed to save pipeline state', err);
  }
});

const ARTIFACT_FILES = [
  { key: 'ref.csv',                         csv: true },
  { key: 'ref.fasta' },
  { key: 'ref.hmm' },
  { key: 'ref_cdhit90.fasta' },
  { key: 'ref_cdhit90.mafft.fasta' },
  { key: 'hits_all.csv',                    csv: true },
  { key: 'hmmsearch.tblout' },
  { key: 'ebi_download_meta.json',          json: true },
  { key: 'hits_filtered.csv',               csv: true },
  { key: 'hits_filtered.fasta' },
  { key: 'scoring_input_auto.fasta' },
  { key: 'scoring_input_auto.mafft.fasta' },
  { key: 'scored_results.csv',              csv: true },
  { key: 'scored_passed.fasta' },
  { key: 'candidates.fasta' },
  { key: 'candidates_cdhit85.fasta' },
  { key: 'nodes.csv',                       csv: true },
  { key: 'edges_similarity.csv',            csv: true },
];

route.get('/api/task/artifacts', async (req, res) => {
  try {
    const { taskId, workDir } = await resolveWorkDirForReq(req);
    const artifacts = {};

    await Promise.all(ARTIFACT_FILES.map(async ({ key, csv, json }) => {
      const filePath = path.join(workDir, key);
      try {
        const stat = await fs.stat(filePath);
        const entry = { exists: true, size: stat.size };

        if (csv) {
          entry.rowCount = await countCsvDataRows(filePath);
        }

        if (json) {
          try {
            const raw = await fs.readFile(filePath, 'utf-8');
            entry.meta = JSON.parse(raw);
          } catch { /* ignore parse error */ }
        }

        artifacts[key] = entry;
      } catch {
        artifacts[key] = { exists: false };
      }
    }));

    res.json({ ok: true, taskId, workDir, artifacts });
  } catch (err) {
    jsonError(res, 'Failed to list task artifacts', err);
  }
});

route.post('/api/runtime/logs/clear', async (req, res) => {
  const taskId = getTaskIdFromReq(req);
  const runtimeState = getRuntimeState(taskId);
  runtimeState.lines = [];
  runtimeState.task = 'idle';
  runtimeState.active = false;
  runtimeState.startedAt = null;
  runtimeState.updatedAt = Date.now();
  runtimeState.meta = {};
  res.json({ ok: true });
});

route.get('/api/reference/preview', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const csvPath = path.join(workDir, 'ref.csv');
    try {
      await fs.access(csvPath);
    } catch {
      return res.json({ ok: true, exists: false, preview: { headers: [], rows: [], total: 0 } });
    }
    const preview = await readCsvPreview(csvPath, 100000);
    res.json({ ok: true, exists: true, preview });
  } catch (err) {
    jsonError(res, 'Failed to load reference preview', err);
  }
});

route.get('/api/hmm/cdhit-preview', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const prefix = 'ref';
    const ref90 = path.join(workDir, `${prefix}_cdhit90.fasta`);
    const csvPath = path.join(workDir, `${prefix}.csv`);
    try {
      await fs.access(ref90);
      await fs.access(csvPath);
    } catch {
      return res.json({ ok: true, exists: false, preview: { headers: [], rows: [], total: 0 } });
    }
    const fastaText = await fs.readFile(ref90, 'utf-8');
    const remainingIds = new Set(parseFastaRecords(fastaText).map((r) => r.id));
    const csvData = await readCsvPreview(csvPath, 100000);
    const filteredRows = csvData.rows.filter((row) => remainingIds.has(row.accession));
    res.json({ ok: true, exists: true, preview: { headers: csvData.headers, rows: filteredRows, total: filteredRows.length } });
  } catch (err) {
    jsonError(res, 'Failed to load CD-HIT preview', err);
  }
});

route.post('/api/reference/fetch', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'reference/fetch', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });
      const { accessionList, email } = req.body;
      if (!Array.isArray(accessionList) || accessionList.length === 0) {
        finishRuntimeTask('reference/fetch', false);
        res.status(400).json({ ok: false, message: 'accessionList is required' });
        return;
      }
      if (!email) {
        finishRuntimeTask('reference/fetch', false);
        res.status(400).json({ ok: false, message: 'email is required for Entrez' });
        return;
      }
      validateEmail(email);

      const args = [
        path.join(__dirname, 'pipeline.py'),
        'fetch-reference',
        '--work-dir',
        workDir,
        '--email',
        email,
        '--accessions-json',
        JSON.stringify(accessionList),
      ];

      const { stdout } = await runCmd(pythonBin, args, pipelineRoot);
      const payload = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');

      const preview = await readCsvPreview(path.join(workDir, 'ref.csv'), 100000);
      res.json({ ok: true, ...payload, preview });
      finishRuntimeTask('reference/fetch', true);
    } catch (err) {
      finishRuntimeTask('reference/fetch', false);
      jsonError(res, 'Failed to fetch reference sequences', err);
    }
  });
});

route.post('/api/reference/import-fasta', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'reference/import-fasta', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });

      const fastaText = String(req.body?.fastaText || '').trim();
      const sourceName = String(req.body?.sourceName || 'uploaded.fasta').trim() || 'uploaded.fasta';
      if (!fastaText) {
        finishRuntimeTask('reference/import-fasta', false);
        res.status(400).json({ ok: false, message: 'fastaText is required' });
        return;
      }

      const parsed = parseFastaRecords(fastaText)
        .map((rec) => ({
          id: sanitizeFastaId(rec?.id || ''),
          header: String(rec?.header || '').trim(),
          seq: String(rec?.seq || '').replace(/\s+/g, '').toUpperCase(),
        }))
        .filter((rec) => rec.id && rec.seq);

      if (!parsed.length) {
        finishRuntimeTask('reference/import-fasta', false);
        res.status(400).json({ ok: false, message: 'No valid FASTA records found' });
        return;
      }

      const idCounter = new Map();
      const records = parsed.map((rec) => {
        const base = rec.id;
        const next = (idCounter.get(base) || 0) + 1;
        idCounter.set(base, next);
        const id = next === 1 ? base : `${base}_${next}`;
        return { id, header: rec.header || id, seq: rec.seq };
      });

      const fastaPath = path.join(workDir, 'ref.fasta');
      const csvPath = path.join(workDir, 'ref.csv');

      const fastaOut = records.map((rec) => `>${rec.id}\n${rec.seq}`).join('\n');
      await fs.writeFile(fastaPath, fastaOut, 'utf-8');

      const headers = ['input', 'type', 'accession', 'kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species', 'description', 'length', 'sequence'];
      const csvRows = records.map((rec) => ({
        input: sourceName,
        type: 'fasta_upload',
        accession: rec.id,
        kingdom: '',
        phylum: '',
        class: '',
        order: '',
        family: '',
        genus: '',
        species: '',
        description: rec.header,
        length: String(rec.seq.length),
        sequence: rec.seq,
      }));
      await writeCsvRows(csvPath, headers, csvRows);

      const preview = await readCsvPreview(csvPath, 100000);
      res.json({
        ok: true,
        rows: csvRows.length,
        csv: csvPath,
        fasta: fastaPath,
        sourceName,
        preview,
      });
      finishRuntimeTask('reference/import-fasta', true);
    } catch (err) {
      finishRuntimeTask('reference/import-fasta', false);
      jsonError(res, 'Failed to import reference FASTA', err);
    }
  });
});

route.post('/api/reference/pairwise-identity', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const fastaPath = resolveAndValidatePath(
      req.body?.fastaPath, workDir, path.join(workDir, 'ref.fasta'));

    const text = await fs.readFile(fastaPath, 'utf-8');
    const records = parseFastaRecords(text);
    if (records.length === 0) {
      return res.json({ ok: true, ids: [], matrix: [] });
    }
    if (records.length > 200) {
      return res.status(400).json({ ok: false, message: `Too many sequences (${records.length}). Max 200 for pairwise identity.` });
    }

    const pairs = [];
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        pairs.push({ seqA: records[i].seq, seqB: records[j].seq });
      }
    }

    const results = await computePairSimilarityPctBatchBiopython(workDir, pairs, 'needleman-wunsch', {
      overallTotal: pairs.length,
      completedBefore: 0,
      phase: 'ref-pairwise',
    });

    const ids = records.map((r) => r.id);
    const n = records.length;
    const matrix = Array.from({ length: n }, () => new Array(n).fill(100));
    let idx = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const val = results[idx] ?? 0;
        matrix[i][j] = val;
        matrix[j][i] = val;
        idx++;
      }
    }

    res.json({ ok: true, ids, matrix });
  } catch (err) {
    jsonError(res, 'Failed to compute pairwise identity', err);
  }
});

route.post('/api/hmm/build', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'hmm/build', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });
      const identity = Number(req.body?.identity ?? 0.9);
      const identityLowerBound = Number(req.body?.identityLowerBound ?? 0);
      const excludedIds = Array.isArray(req.body?.excludedIds) ? req.body.excludedIds.map(String) : [];
      const wordSize = Number(req.body?.wordSize ?? 5);
      const coverageLong = Number(req.body?.coverageLong ?? 0);
      const coverageShort = Number(req.body?.coverageShort ?? 0);
      const refFasta = resolveAndValidatePath(
        req.body?.refFasta, workDir, path.join(workDir, 'ref.fasta'));
      const prefix = normalizeFilePrefix(req.body?.prefix, 'ref');

      const ref90 = path.join(workDir, `${prefix}_cdhit90.fasta`);
      const ref90Aln = path.join(workDir, `${prefix}_cdhit90.mafft.fasta`);
      const hmm = path.join(workDir, `${prefix}.hmm`);

      // Count input sequences
      const inputText = await fs.readFile(refFasta, 'utf-8');
      let records = parseFastaRecords(inputText);
      const inputCount = records.length;

      // --- Pre-filter: manually excluded IDs ---
      let prefilterRemoved = [];
      if (excludedIds.length > 0) {
        const excludeSet = new Set(excludedIds);
        const before = records.length;
        prefilterRemoved = records.filter((r) => excludeSet.has(r.id)).map((r) => r.id);
        records = records.filter((r) => !excludeSet.has(r.id));
        pushRuntimeLine(`[hmm/build] Manually excluded ${prefilterRemoved.length} sequences (${before} → ${records.length})`);
      }

      // --- Pre-filter: identity lower bound ---
      let lowerBoundRemoved = [];
      if (identityLowerBound > 0 && records.length > 1) {
        pushRuntimeLine(`[hmm/build] Computing pairwise identity for lower-bound filter (threshold=${identityLowerBound}%)...`);
        const pairs = [];
        for (let i = 0; i < records.length; i++) {
          for (let j = i + 1; j < records.length; j++) {
            pairs.push({ seqA: records[i].seq, seqB: records[j].seq });
          }
        }
        const simResults = await computePairSimilarityPctBatchBiopython(workDir, pairs, 'needleman-wunsch', {
          overallTotal: pairs.length, completedBefore: 0, phase: 'ref-lowerbound',
        });
        // Build identity matrix and find max-identity per sequence
        const n = records.length;
        const maxIdentity = new Array(n).fill(0);
        let idx = 0;
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const val = simResults[idx] ?? 0;
            if (val > maxIdentity[i]) maxIdentity[i] = val;
            if (val > maxIdentity[j]) maxIdentity[j] = val;
            idx++;
          }
        }
        const keep = [];
        for (let i = 0; i < n; i++) {
          if (maxIdentity[i] >= identityLowerBound) {
            keep.push(records[i]);
          } else {
            lowerBoundRemoved.push(records[i].id);
          }
        }
        pushRuntimeLine(`[hmm/build] Lower-bound filter: removed ${lowerBoundRemoved.length} outlier sequences (max identity < ${identityLowerBound}%)`);
        records = keep;
      }

      // Write pre-filtered FASTA (if any filtering happened)
      let actualRefFasta = refFasta;
      if (prefilterRemoved.length > 0 || lowerBoundRemoved.length > 0) {
        const filteredFasta = path.join(workDir, `${prefix}_prefiltered.fasta`);
        const filteredContent = records.map((r) => `>${r.id}\n${r.seq}`).join('\n') + '\n';
        await fs.writeFile(filteredFasta, filteredContent, 'utf-8');
        actualRefFasta = filteredFasta;
        pushRuntimeLine(`[hmm/build] Pre-filtered FASTA: ${records.length} sequences → ${filteredFasta}`);
      }
      const afterFilterCount = records.length;

      // Build cd-hit args
      const cdhitArgs = ['-i', actualRefFasta, '-o', ref90, '-c', String(identity), '-n', String(wordSize), '-d', '0'];
      if (coverageLong > 0) cdhitArgs.push('-aL', String(coverageLong));
      if (coverageShort > 0) cdhitArgs.push('-aS', String(coverageShort));

      await runCmd('cd-hit', cdhitArgs);

      // Parse cluster file for stats
      let clusters = [];
      try {
        const clstrText = await fs.readFile(ref90 + '.clstr', 'utf-8');
        clusters = parseCdHitClusters(clstrText);
      } catch { /* clstr file may not exist */ }

      const outputText = await fs.readFile(ref90, 'utf-8');
      const outputRecords = parseFastaRecords(outputText);
      const outputCount = outputRecords.length;

      const mafftOut = await runMafftAuto(ref90);
      await fs.writeFile(ref90Aln, mafftOut.stdout, 'utf-8');
      await runCmd('hmmbuild', [hmm, ref90Aln]);

      // Build preview of remaining sequences by cross-referencing ref.csv
      let preview = { headers: [], rows: [], total: 0 };
      try {
        const refCsv = path.join(workDir, `${prefix}.csv`);
        const csvData = await readCsvPreview(refCsv, 100000);
        const remainingIds = new Set(outputRecords.map((r) => r.id));
        const filteredRows = csvData.rows.filter((row) => remainingIds.has(row.accession));
        preview = { headers: csvData.headers, rows: filteredRows, total: filteredRows.length };
      } catch { /* ref.csv may not exist */ }

      res.json({
        ok: true,
        outputs: {
          refInput: refFasta,
          ref90,
          ref90Aln,
          hmm,
        },
        stats: {
          inputCount,
          afterFilterCount,
          outputCount,
          clusterCount: clusters.length,
          clusters: clusters.map((c) => ({
            name: c.name,
            size: c.members.length,
            representative: c.members.find((m) => m.representative)?.id || '',
          })),
          prefilterRemoved,
          lowerBoundRemoved,
        },
        preview,
      });
      finishRuntimeTask('hmm/build', true);
    } catch (err) {
      finishRuntimeTask('hmm/build', false);
      jsonError(res, 'Failed to build HMM model', err);
    }
  });
});

route.get('/api/search/ebi/databases', async (_req, res) => {
  const now = Date.now();
  if (
    ebiDatabaseCache.databases.length > 0
    && now - ebiDatabaseCache.fetchedAt < ebiDatabaseCacheTtlMs
  ) {
    res.json({
      ok: true,
      databases: ebiDatabaseCache.databases,
      source: 'cache',
      fetchedAt: new Date(ebiDatabaseCache.fetchedAt).toISOString(),
    });
    return;
  }

  const payload = await fetchJsonViaCurl(ebiDatabasesUrl, {
    headers: { Accept: 'application/json' },
  }, {
    retries: 1,
    retryDelayMs: 0,
    label: 'ebi-databases',
    curlRetries: 0,
    connectTimeoutSec: 5,
    maxTimeSec: 12,
  });

  if (!Array.isArray(payload)) {
    throw new Error('EBI HMMER database metadata response is not an array');
  }

  const databases = payload
    .filter((entry) => entry && entry.type === 'seq' && entry.status === 'enabled')
    .map((entry) => {
      const id = String(entry.id || '').trim();
      const version = String(entry.version || '').trim();
      const reportedCount = Number(
        entry.sequence_count ?? entry.sequenceCount ?? entry.num_sequences ?? entry.nseqs,
      );
      const sequenceCount = Number.isSafeInteger(reportedCount) && reportedCount >= 0
        ? reportedCount
        : (ebiDatabaseSequenceCountsByRelease.get(`${id}@${version}`) ?? null);
      return {
        id,
        type: String(entry.type || ''),
        status: String(entry.status || ''),
        name: String(entry.name || entry.id || '').trim(),
        version,
        releaseDate: entry.release_date ? String(entry.release_date) : null,
        sequenceCount,
        sequenceCountSource: sequenceCount == null
          ? null
          : (Number.isSafeInteger(reportedCount) && reportedCount >= 0 ? 'metadata' : 'ebi-search-stats'),
        order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : 999,
      };
    })
    .filter((entry) => entry.id && entry.name)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  if (databases.length === 0) {
    throw new Error('EBI HMMER returned no enabled sequence databases');
  }

  ebiDatabaseCache = { fetchedAt: now, databases };
  res.json({
    ok: true,
    databases,
    source: 'live',
    fetchedAt: new Date(now).toISOString(),
  });
});

route.post('/api/search/run', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'search/run', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });
      const mode = String(req.body?.mode || 'local').toLowerCase();
      const database = String(req.body?.database || 'refprot');
      const targetFasta = resolveAndValidatePath(
        req.body?.targetFasta, workDir, path.join(workDir, 'target.fasta'));
      const hmmFile = resolveAndValidatePath(
        req.body?.hmmFile, workDir, path.join(workDir, 'ref.hmm'));

      const tblout = path.join(workDir, 'hmmsearch.tblout');
      const hitsCsv = path.join(workDir, 'hits_all.csv');

      if (mode === 'ebi') {
        const { jobId, pageCount, allHits, failedPages } = await runEbiHmmsearch(hmmFile, database);
        await writeEbiHitsCsv(allHits, hitsCsv);
        await writeEbiDownloadMeta(workDir, {
          jobId,
          pageCount,
          failedPages,
          updatedAt: new Date().toISOString(),
        });
        const preview = await readCsvPreview(hitsCsv, 30);
        res.json({
          ok: true,
          mode: 'ebi',
          jobId,
          pageCount,
          failedPages: failedPages.length,
          failedPageNumbers: failedPages,
          tblout: null,
          hitsCsv,
          preview,
        });
      } else {
        await runCmd('hmmsearch', ['--tblout', tblout, hmmFile, targetFasta]);
        await runCmd(
          pythonBin,
          [
            path.join(__dirname, 'pipeline.py'),
            'parse-hmm-tblout',
            '--tblout',
            tblout,
            '--target-fasta',
            targetFasta,
            '--output-csv',
            hitsCsv,
          ],
          pipelineRoot,
        );

        const preview = await readCsvPreview(hitsCsv, 30);
        res.json({ ok: true, mode: 'local', tblout, hitsCsv, preview });
      }
      finishRuntimeTask('search/run', true);
    } catch (err) {
      finishRuntimeTask('search/run', false);
      jsonError(res, 'Failed to run hmmsearch', err);
    }
  });
});

route.post('/api/search/ebi/monitor', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'search/ebi-monitor', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });
      const database = String(req.body?.database || 'refprot');
      const hmmFile = resolveAndValidatePath(
        req.body?.hmmFile, workDir, path.join(workDir, 'ref.hmm')
      );

      const { jobId } = await submitEbiHmmsearch(hmmFile, database);
      const result = await pollEbiHmmsearchUntilSuccess(jobId);
      res.json({ ok: true, ...result });
      finishRuntimeTask('search/ebi-monitor', true);
    } catch (err) {
      finishRuntimeTask('search/ebi-monitor', false);
      jsonError(res, 'Failed to monitor EBI hmmsearch', err);
    }
  });
});

route.post('/api/search/ebi/download', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'search/ebi-download', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });
      const jobId = String(req.body?.jobId || '').trim();
      if (!jobId) {
        res.status(400).json({ ok: false, message: 'jobId is required' });
        finishRuntimeTask('search/ebi-download', false);
        return;
      }

      const hitsCsv = path.join(workDir, 'hits_all.csv');
      const { pageCount, allHits, failedPages } = await downloadEbiHmmsearchResults(jobId);
      await writeEbiHitsCsv(allHits, hitsCsv);
      await writeEbiDownloadMeta(workDir, {
        jobId,
        pageCount,
        failedPages,
        updatedAt: new Date().toISOString(),
      });
      const preview = await readCsvPreview(hitsCsv, 30);
      res.json({
        ok: true,
        mode: 'ebi',
        jobId,
        pageCount,
        failedPages: failedPages.length,
        failedPageNumbers: failedPages,
        tblout: null,
        hitsCsv,
        preview,
      });
      finishRuntimeTask('search/ebi-download', true);
    } catch (err) {
      finishRuntimeTask('search/ebi-download', false);
      jsonError(res, 'Failed to download EBI hmmsearch results', err);
    }
  });
});

route.post("/api/search/ebi/uniprot-fill", async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, "search/uniprot-fill", taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId, uniprotProgress: 0, uniprotPhase: 'fetching' });
      const hitsCsv = path.join(workDir, "hits_all.csv");
      pushRuntimeLine("[uniprot] Calling uniprot_fill.py to retrieve length/sequence...");
      await runCmd(pythonBin, [path.join(projectRoot, "scripts/uniprot_fill.py"), hitsCsv], projectRoot, {
        timeoutMs: uniprotFillTimeoutMs,
        onStderr: (text) => {
          const m = text.match(/(\d+)%\|/);
          if (m) {
            setRuntimeMeta({ uniprotProgress: parseInt(m[1], 10), uniprotPhase: 'fetching', taskId });
          }
        }
      });
      setRuntimeMeta({ uniprotProgress: 100, uniprotPhase: 'writing', taskId });
      const preview = await readCsvPreview(hitsCsv, 30);
      res.json({ ok: true, hitsCsv, preview });
      finishRuntimeTask("search/uniprot-fill", true);
    } catch (err) {
      finishRuntimeTask("search/uniprot-fill", false);
      jsonError(res, "Failed to fill UniProt data", err);
    }
  });
});

route.post('/api/search/ebi/retry-failed', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'search/ebi-retry-failed', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });

      const hitsCsv = path.join(workDir, 'hits_all.csv');
      const bodyJobId = String(req.body?.jobId || '').trim();
      const bodyPages = Array.isArray(req.body?.failedPages)
        ? req.body.failedPages.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
        : null;

      const meta = await readEbiDownloadMeta(workDir);
      const jobId = bodyJobId || String(meta?.jobId || '').trim();
      const failedPages = bodyPages && bodyPages.length ? bodyPages : (Array.isArray(meta?.failedPages) ? meta.failedPages : []);

      if (!jobId) {
        res.status(400).json({ ok: false, message: 'jobId is required' });
        finishRuntimeTask('search/ebi-retry-failed', false);
        return;
      }
      if (!failedPages.length) {
        const preview = await readCsvPreview(hitsCsv, 30);
        res.json({
          ok: true,
          mode: 'ebi',
          jobId,
          retriedPages: 0,
          insertedRows: 0,
          failedPages: 0,
          hitsCsv,
          preview,
        });
        finishRuntimeTask('search/ebi-retry-failed', true);
        return;
      }

      const { recoveredHits, stillFailedPages } = await retryFailedEbiPages({ jobId, failedPages });
      const { inserted, total } = await mergeEbiRecoveredRows(hitsCsv, recoveredHits);
      await writeEbiDownloadMeta(workDir, {
        jobId,
        pageCount: Number(meta?.pageCount || 0) || null,
        failedPages: stillFailedPages,
        updatedAt: new Date().toISOString(),
      });

      const preview = await readCsvPreview(hitsCsv, 30);
      res.json({
        ok: true,
        mode: 'ebi',
        jobId,
        retriedPages: failedPages.length,
        insertedRows: inserted,
        totalRows: total,
        failedPages: stillFailedPages.length,
        failedPageNumbers: stillFailedPages,
        hitsCsv,
        preview,
      });
      finishRuntimeTask('search/ebi-retry-failed', true);
    } catch (err) {
      finishRuntimeTask('search/ebi-retry-failed', false);
      jsonError(res, 'Failed to retry EBI failed pages', err);
    }
  });
});

route.get('/api/search/page', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.max(1, Math.min(500, Number(req.query.pageSize || 50)));
    const source = String(req.query.source || 'hits_all');
    const fileName = source === 'filtered' ? 'hits_filtered.csv' : 'hits_all.csv';
    const csvPath = path.join(workDir, fileName);
    const offset = (page - 1) * pageSize;

    const preview = await readCsvPreview(csvPath, pageSize, offset);
    res.json({
      ok: true,
      source,
      file: csvPath,
      page,
      pageSize,
      total: preview.total,
      totalPages: Math.max(1, Math.ceil((preview.total || 0) / pageSize)),
      preview,
    });
  } catch (err) {
    jsonError(res, 'Failed to load paginated search results', err);
  }
});

route.post('/api/search/filter', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'search/filter', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });
      const scoreMin = Number(req.body?.scoreMin ?? 200);
      const lenMin = Number(req.body?.lenMin ?? 520);
      const lenMax = Number(req.body?.lenMax ?? 570);

      const hitsCsv = path.join(workDir, 'hits_all.csv');
      const filteredCsv = path.join(workDir, 'hits_filtered.csv');

      const { stdout } = await runCmd(
        pythonBin,
        [
          path.join(__dirname, 'pipeline.py'),
          'filter-hits',
          '--input-csv',
          hitsCsv,
          '--output-csv',
          filteredCsv,
          '--score-min',
          String(scoreMin),
          '--len-min',
          String(lenMin),
          '--len-max',
          String(lenMax),
        ],
        pipelineRoot,
      );

      const payload = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
      const preview = await readCsvPreview(filteredCsv, 30);
      const filteredFasta = path.join(workDir, 'hits_filtered.fasta');
      const fastaCount = await writeFastaFromCsv(filteredCsv, filteredFasta);
      res.json({
        ok: true,
        ...payload,
        preview,
        filteredFasta: fastaCount > 0 ? filteredFasta : null,
        fastaCount,
      });
      finishRuntimeTask('search/filter', true);
    } catch (err) {
      finishRuntimeTask('search/filter', false);
      jsonError(res, 'Failed to filter hits', err);
    }
  });
});

route.post('/api/search/filter-box', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'search/filter-box', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
    const { workDir } = await resolveWorkDirForReq(req);
    setRuntimeMeta({ taskId });
    const targets = Array.isArray(req.body?.targets)
      ? req.body.targets.map((x) => String(x)).filter(Boolean)
      : [];
    if (!targets.length) {
      res.status(400).json({ ok: false, message: 'targets is required' });
      return;
    }

    const targetSet = new Set(targets);
    const hitsCsv = path.join(workDir, 'hits_all.csv');
    const filteredCsv = path.join(workDir, 'hits_filtered.csv');

    const raw = await fs.readFile(hitsCsv, 'utf-8');
    const lines = raw.trim().split(/\r?\n/);
    if (!lines.length) {
      await fs.writeFile(filteredCsv, '', 'utf-8');
      res.json({ ok: true, total: 0, kept: 0, csv: filteredCsv, preview: { headers: [], rows: [], total: 0 } });
      finishRuntimeTask('search/filter-box', true);
      return;
    }

    const headers = parseCsvLine(lines[0]);
    const targetCol = headers.findIndex((h) => h === 'target');
    if (targetCol < 0) {
      throw new Error('hits_all.csv missing target column');
    }

    const dataLines = lines.slice(1);
    const keptLines = dataLines.filter((line) => {
      const cols = parseCsvLine(line);
      return targetSet.has(cols[targetCol] ?? '');
    });

    const out = [headers.map(csvEscape).join(',')]
      .concat(keptLines)
      .join('\n');
    await fs.writeFile(filteredCsv, out, 'utf-8');

    const preview = await readCsvPreview(filteredCsv, 30);
    const filteredFasta = path.join(workDir, 'hits_filtered.fasta');
    const fastaCount = await writeFastaFromCsv(filteredCsv, filteredFasta);
    res.json({
      ok: true,
      total: dataLines.length,
      kept: keptLines.length,
      csv: filteredCsv,
      preview,
      filteredFasta: fastaCount > 0 ? filteredFasta : null,
      fastaCount,
    });
    finishRuntimeTask('search/filter-box', true);
    } catch (err) {
      finishRuntimeTask('search/filter-box', false);
      jsonError(res, 'Failed to save box-filtered hits', err);
    }
  });
});

route.post('/api/search/consistency-check', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'search/consistency-check', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
    const { workDir } = await resolveWorkDirForReq(req);
    setRuntimeMeta({ taskId, consistencyProgress: 0 });
    const source = String(req.body?.source || 'hits_all');
    const fileName = source === 'filtered' ? 'hits_filtered.csv' : 'hits_all.csv';
    const csvPath = path.join(workDir, fileName);

    const { headers, rows } = await readCsvRows(csvPath);
    if (!headers.length) {
      res.json({ ok: true, source, file: csvPath, total: 0, mismatch: 0, filled: 0, updated: false });
      finishRuntimeTask('search/consistency-check', true);
      return;
    }

    const lengthCol = headers.find((h) => h === 'length');
    const seqCol = headers.find((h) => h === 'sequence');
    if (!lengthCol || !seqCol) {
      res.status(400).json({ ok: false, message: 'CSV must contain length and sequence columns' });
      finishRuntimeTask('search/consistency-check', false);
      return;
    }

    let mismatch = 0;
    let filled = 0;
    let checked = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const seq = String(row[seqCol] ?? '').trim();
      const hasSequence = Boolean(seq);
      const rawLength = String(row[lengthCol] ?? '').trim();
      const parsedLength = Number(rawLength);
      const hasLength = rawLength !== '' && Number.isFinite(parsedLength);

      if (hasSequence && hasLength) {
        checked += 1;
        const calcLen = seq.length;
        if (parsedLength !== calcLen) {
          mismatch += 1;
        }
      }

      if (hasSequence && !hasLength) {
        row[lengthCol] = String(seq.length);
        filled += 1;
      }

      if (i % 500 === 0 || i === rows.length - 1) {
        const percent = Math.min(100, Math.round(((i + 1) / Math.max(1, rows.length)) * 100));
        setRuntimeMeta({ taskId, consistencyProgress: percent });
      }
    }

    if (filled > 0) {
      await writeCsvRows(csvPath, headers, rows);
      pushRuntimeLine(`[search] filled missing length rows=${filled}`);
    }
    const preview = await readCsvPreview(csvPath, 30);
    res.json({
      ok: true,
      source,
      file: csvPath,
      total: rows.length,
      checked,
      mismatch,
      filled,
      updated: filled > 0,
      preview,
    });
    finishRuntimeTask('search/consistency-check', true);
    } catch (err) {
      finishRuntimeTask('search/consistency-check', false);
      jsonError(res, 'Failed to run sequence-length consistency check', err);
    }
  });
});

route.post('/api/scoring/run', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'scoring/run', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
    const { workDir } = await resolveWorkDirForReq(req);
    setRuntimeMeta({ taskId });
    const autoFromFiltered = Boolean(req.body?.autoFromFiltered);
    let alignment = req.body?.alignment
      ? resolveAndValidatePath(req.body.alignment, workDir, null)
      : null;
    const refIdRaw = String(req.body?.refId || '').trim();
    const refId = refIdRaw || await resolveDefaultRefId(workDir);
    const threshold = Number(req.body?.threshold ?? 33.6);
    const rules = normalizeScoringRules(req.body?.rules);
    const positionMode = normalizeScoringPositionMode(req.body?.positionMode);
    const preAlignmentAnchor = String(req.body?.preAlignmentAnchor || 'first').trim().toLowerCase() === 'refid' ? 'refid' : 'first';
    const scoreCsv = path.join(workDir, 'scored_results.csv');
    const passedFasta = path.join(workDir, 'scored_passed.fasta');
    let rulesJsonPath = null;

    if (rules) {
      rulesJsonPath = path.join(workDir, `scoring_rules.${Date.now()}.json`);
      await fs.writeFile(rulesJsonPath, JSON.stringify(rules, null, 2), 'utf-8');
      pushRuntimeLine(`[scoring] using custom rules count=${rules.length}`);
    }

    if (autoFromFiltered) {
      const filteredFasta = resolveAndValidatePath(
        req.body?.filteredFasta, workDir, path.join(workDir, 'hits_filtered.fasta'));
      const referenceFasta = resolveAndValidatePath(
        req.body?.referenceFasta, workDir, await resolveDefaultReferenceFasta(workDir));
      const scoringInputFasta = path.join(workDir, 'scoring_input_auto.fasta');
      const scoringAlignment = path.join(workDir, 'scoring_input_auto.mafft.fasta');

      await prepareScoringAutoAlignment({
        filteredFasta,
        referenceFasta,
        refId,
        outInputFasta: scoringInputFasta,
        outAlignment: scoringAlignment,
      });
      alignment = scoringAlignment;
    } else if (!alignment) {
      alignment = await firstExistingPath([
        path.join(workDir, 'scoring_input_auto.mafft.fasta'),
        path.join(workDir, 'all_sequences_for_msa.mafft.fasta'),
        // Legacy fallback for old tasks:
        path.join(workDir, 'AOX_all_sequences_for_msa.mafft.fasta'),
      ]);
      if (!alignment) {
        throw new Error('No alignment file found. Please run step 4 Alignment first.');
      }
    }

    // When using pre-alignment positioning with a specific refId, ensure the
    // reference sequence is actually present in the alignment. If not, inject
    // it from ref.fasta and re-run MAFFT so scoring can map residue positions.
    if (alignment && positionMode === 'pre' && preAlignmentAnchor === 'refid' && refId) {
      const alnText = await fs.readFile(alignment, 'utf-8');
      const alnRecords = parseFastaRecords(alnText);
      const refInAln = alnRecords.some((r) => r.id.includes(refId) || r.header.includes(refId));
      if (!refInAln) {
        pushRuntimeLine(`[scoring] refId "${refId}" not found in alignment – rebuilding with ref sequence injected`);
        const referenceFasta = resolveAndValidatePath(
          req.body?.referenceFasta, workDir, await resolveDefaultReferenceFasta(workDir));
        const refText = await fs.readFile(referenceFasta, 'utf-8');
        const refRecords = parseFastaRecords(refText);
        const refRecord = refRecords.find((r) => r.id.includes(refId) || r.header.includes(refId));
        if (!refRecord) {
          throw new Error(`Reference sequence "${refId}" not found in ${referenceFasta}`);
        }
        // Reconstruct ungapped sequences from the current alignment, prepend
        // the missing ref record, then re-align with MAFFT.
        const ungapped = alnRecords.map((r) => ({
          header: r.header || r.id,
          seq: String(r.seq || '').replace(/-/g, ''),
        }));
        const combined = [
          { header: refRecord.header || refRecord.id, seq: String(refRecord.seq || '').replace(/\s+/g, '').toUpperCase() },
          ...ungapped,
        ];
        const scoringInputFasta = path.join(workDir, 'scoring_input_auto.fasta');
        const scoringAlignment = path.join(workDir, 'scoring_input_auto.mafft.fasta');
        const outLines = combined.flatMap((r) => [`>${r.header}`, r.seq]);
        await fs.writeFile(scoringInputFasta, outLines.join('\n'), 'utf-8');
        const mafftOut = await runMafftAuto(scoringInputFasta);
        await fs.writeFile(scoringAlignment, mafftOut.stdout, 'utf-8');
        alignment = scoringAlignment;
        pushRuntimeLine(`[scoring] rebuilt alignment with ${combined.length} sequences including refId "${refId}"`);
      }
    }

    const scoreArgs = [
      path.join(__dirname, 'pipeline.py'),
      'score-alignment',
      '--alignment',
      alignment,
      '--output-csv',
      scoreCsv,
      '--threshold',
      String(threshold),
      '--position-mode',
      positionMode,
    ];
    if (positionMode === 'pre' && preAlignmentAnchor === 'refid' && refId) {
      scoreArgs.push('--ref-id', refId);
    }
    if (rulesJsonPath) {
      scoreArgs.push('--rules-json', rulesJsonPath);
    }

    const { stdout } = await runCmd(pythonBin, scoreArgs, pipelineRoot);

    const payload = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
    const passedExport = await buildScoringPassedFasta(scoreCsv, alignment, passedFasta);
    const preview = await readCsvPreview(scoreCsv, 50);
    res.json({
      ok: true,
      ...payload,
      preview,
      alignmentUsed: alignment,
      autoFromFiltered,
      rulesCount: rules?.length ?? null,
      positionMode,
      preAlignmentAnchor,
      refIdUsed: positionMode === 'pre' && preAlignmentAnchor === 'refid' ? refId : null,
      passedFasta: passedExport.fasta,
      passedCount: passedExport.written,
      passedMissingInAlignment: passedExport.missingInAlignment,
    });

    if (rulesJsonPath) {
      await fs.unlink(rulesJsonPath).catch(() => {});
    }
    finishRuntimeTask('scoring/run', true);
    } catch (err) {
      finishRuntimeTask('scoring/run', false);
      jsonError(res, 'Failed to score sequences', err);
    }
  });
});

route.post('/api/scoring/prepare-alignment', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'scoring/prepare-alignment', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });
      updateAlignmentProgress({ current: 0, total: 5, phase: '准备中' });

      const filteredFasta = resolveAndValidatePath(
        req.body?.filteredFasta, workDir, path.join(workDir, 'hits_filtered.fasta'));
      const referenceFasta = resolveAndValidatePath(
        req.body?.referenceFasta, workDir, await resolveDefaultReferenceFasta(workDir));
      const refId = req.body?.refId || await resolveDefaultRefId(workDir);

      const scoringInputFasta = path.join(workDir, 'scoring_input_auto.fasta');
      const scoringAlignment = path.join(workDir, 'scoring_input_auto.mafft.fasta');

      const alignmentInfo = await prepareScoringAutoAlignment({
        filteredFasta,
        referenceFasta,
        refId,
        outInputFasta: scoringInputFasta,
        outAlignment: scoringAlignment,
      });

      const inputText = await fs.readFile(scoringInputFasta, 'utf-8');
      const records = parseFastaRecords(inputText);
      res.json({
        ok: true,
        inputFasta: scoringInputFasta,
        alignment: scoringAlignment,
        records: records.length,
        referenceId: alignmentInfo.referenceId,
      });
      updateAlignmentProgress({ current: 5, total: 5, phase: '完成' });
      finishRuntimeTask('scoring/prepare-alignment', true);
    } catch (err) {
      finishRuntimeTask('scoring/prepare-alignment', false);
      jsonError(res, 'Failed to prepare scoring alignment', err);
    }
  });
});

route.get('/api/scoring/alignment-preview', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const alignmentPath = resolveAndValidatePath(
      req.query?.alignment ? String(req.query.alignment) : null,
      workDir, path.join(workDir, 'scoring_input_auto.mafft.fasta'));

    const startParam = Number(req.query?.start || 1);
    const requestedStart = Number.isFinite(startParam) ? Math.max(1, Math.floor(startParam)) : 1;
    const endParam = Number(req.query?.end || 120);
    const requestedEnd = Number.isFinite(endParam)
      ? Math.max(requestedStart, Math.floor(endParam))
      : Math.max(requestedStart, 120);
    const limitParam = Number(req.query?.limit || 40);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(200, Math.floor(limitParam))) : 40;
    const offsetParam = Number(req.query?.offset || 0);
    const offset = Number.isFinite(offsetParam) ? Math.max(0, Math.floor(offsetParam)) : 0;
    const maxPreviewColumns = 240;

    const text = await fs.readFile(alignmentPath, 'utf-8');
    const records = parseFastaRecords(text);
    const totalRecords = records.length;
    const requestedReferenceId = String(req.query?.referenceId || '').trim();
    const fallbackReferenceId = requestedReferenceId || await resolveDefaultRefId(workDir);
    let referenceIndex = fallbackReferenceId
      ? records.findIndex((record) => fastaRecordMatchesIdentifier(record, fallbackReferenceId))
      : -1;
    const referenceMatched = referenceIndex >= 0;
    if (referenceIndex < 0 && records.length > 0) referenceIndex = 0;
    const referenceRecord = referenceIndex >= 0 ? records[referenceIndex] : null;
    const orderedRecords = referenceIndex > 0
      ? [referenceRecord, ...records.slice(0, referenceIndex), ...records.slice(referenceIndex + 1)]
      : records;
    const alignmentLength = records.reduce(
      (maxLength, record) => Math.max(maxLength, String(record?.seq || '').length),
      0,
    );
    const start = alignmentLength > 0
      ? Math.min(requestedStart, alignmentLength)
      : requestedStart;
    const availableEnd = Math.min(requestedEnd, alignmentLength);
    const requestedWindowEnd = Math.min(availableEnd, start + maxPreviewColumns - 1);
    const from = start - 1;
    const to = Math.min(requestedWindowEnd, alignmentLength);
    const windowWidth = Math.max(0, to - from);
    const windowed = orderedRecords.slice(offset, offset + limit).map((r) => ({
      id: r.id,
      segment: String(r.seq || '').slice(from, to).padEnd(windowWidth, '-'),
      isReference: r === referenceRecord,
    }));
    const referenceSegment = referenceRecord
      ? String(referenceRecord.seq || '').slice(from, to).padEnd(windowWidth, '-')
      : '';

    // Consensus and conservation use all sequences, not only the visible page,
    // while the rendered DOM remains bounded to at most 200 x 240 residues.
    const consensus = [];
    const conservation = [];
    for (let column = from; column < to; column += 1) {
      const counts = new Map();
      for (const record of records) {
        const residue = String(record?.seq?.[column] || '-').toUpperCase();
        if (residue === '-' || residue === '.') continue;
        counts.set(residue, (counts.get(residue) || 0) + 1);
      }
      let bestResidue = '-';
      let bestCount = 0;
      for (const [residue, count] of counts.entries()) {
        if (count > bestCount) {
          bestResidue = residue;
          bestCount = count;
        }
      }
      consensus.push(bestResidue);
      conservation.push(totalRecords > 0 ? Number((bestCount / totalRecords).toFixed(4)) : 0);
    }

    res.json({
      ok: true,
      alignment: alignmentPath,
      start,
      end: to,
      requestedEnd,
      maxPreviewColumns,
      columnsTruncated: availableEnd > requestedWindowEnd,
      limit,
      offset,
      totalRecords,
      alignmentLength,
      referenceId: String(referenceRecord?.id || referenceRecord?.header || ''),
      referenceMatched,
      referenceSegment,
      consensus: consensus.join(''),
      conservation,
      rows: windowed,
    });
  } catch (err) {
    jsonError(res, 'Failed to preview alignment', err);
  }
});

route.get('/api/scoring/alignment-download', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const alignmentPath = resolveTaskArtifactPath(
      req.query?.alignment ? String(req.query.alignment) : null,
      workDir,
      'scoring_input_auto.mafft.fasta',
      ['scoring_input_auto.mafft.fasta'],
    );
    const fasta = await fs.readFile(alignmentPath);
    const fileName = path.basename(alignmentPath) || 'scoring_input_auto.mafft.fasta';
    res.setHeader('Content-Type', 'text/x-fasta; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(fasta);
  } catch (err) {
    jsonError(res, 'Failed to download scoring alignment FASTA', err);
  }
});

route.get('/api/scoring/page', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const requestedPage = Number(req.query.page || 1);
    const requestedPageSize = Number(req.query.pageSize || 25);
    const page = Number.isFinite(requestedPage) ? Math.max(1, Math.floor(requestedPage)) : 1;
    const pageSize = Number.isFinite(requestedPageSize)
      ? Math.max(1, Math.min(500, Math.floor(requestedPageSize)))
      : 25;
    const csvPath = resolveTaskArtifactPath(
      req.query?.csv ? String(req.query.csv) : null,
      workDir,
      'scored_results.csv',
      ['scored_results.csv'],
    );
    const offset = (page - 1) * pageSize;
    const preview = await readCsvPreview(csvPath, pageSize, offset);
    const total = Number(preview.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);

    if (safePage !== page) {
      const safePreview = await readCsvPreview(csvPath, pageSize, (safePage - 1) * pageSize);
      return res.json({
        ok: true,
        csv: csvPath,
        page: safePage,
        pageSize,
        total,
        totalPages,
        preview: safePreview,
      });
    }

    res.json({
      ok: true,
      csv: csvPath,
      page,
      pageSize,
      total,
      totalPages,
      preview,
    });
  } catch (err) {
    jsonError(res, 'Failed to load paginated scoring results', err);
  }
});

route.get('/api/scoring/download', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const csvPath = resolveTaskArtifactPath(
      req.query?.csv ? String(req.query.csv) : null,
      workDir,
      'scored_results.csv',
      ['scored_results.csv'],
    );

    const csvText = await fs.readFile(csvPath, 'utf-8');
    const fileName = path.basename(csvPath) || 'scored_results.csv';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(csvText);
  } catch (err) {
    jsonError(res, 'Failed to download scoring csv', err);
  }
});

route.get('/api/scoring/threshold-preview', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const threshold = Number(req.query?.threshold ?? NaN);
    if (!Number.isFinite(threshold)) {
      res.status(400).json({ ok: false, message: 'threshold must be a number' });
      return;
    }

    const csvPath = resolveAndValidatePath(
      req.query?.csv ? String(req.query.csv) : null,
      workDir, path.join(workDir, 'scored_results.csv'));

    const { rows } = await readCsvRows(csvPath);
    const total = rows.length;
    const passed = rows.reduce((acc, row) => {
      const s = Number(row.seq_score ?? row.score ?? NaN);
      return acc + (Number.isFinite(s) && s >= threshold ? 1 : 0);
    }, 0);
    const ratio = total > 0 ? passed / total : 0;
    res.json({ ok: true, csv: csvPath, threshold, total, passed, ratio });
  } catch (err) {
    jsonError(res, 'Failed to preview threshold counts', err);
  }
});

route.post('/api/clustering/run', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'clustering/run', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
    const { workDir } = await resolveWorkDirForReq(req);
    setRuntimeMeta({ taskId });
    const identity = Number(req.body?.identity ?? 0.85);
    const wordSize = Number(req.body?.wordSize ?? 5);
    const inputFasta = resolveAndValidatePath(
      req.body?.inputFasta, workDir,
      path.join(workDir, 'candidates.fasta'));
    const outputFasta = path.join(workDir, 'candidates_cdhit85.fasta');
    const effectiveOutputFasta = inputFasta === outputFasta
      ? path.join(workDir, 'candidates_cdhit85.fasta.tmp')
      : outputFasta;

    const inputText = await fs.readFile(inputFasta, 'utf-8');
    const inputCount = parseFastaRecords(inputText).length;

    await runCmd('cd-hit', ['-i', inputFasta, '-o', effectiveOutputFasta, '-c', String(identity), '-n', String(wordSize), '-d', '0']);

    if (effectiveOutputFasta !== outputFasta) {
      await fs.rm(outputFasta, { force: true }).catch(() => {});
      await fs.rm(`${outputFasta}.clstr`, { force: true }).catch(() => {});
      await fs.rename(effectiveOutputFasta, outputFasta);
      await fs.rename(`${effectiveOutputFasta}.clstr`, `${outputFasta}.clstr`);
    }

    const clusterFile = `${outputFasta}.clstr`;
    const outputText = await fs.readFile(outputFasta, 'utf-8');
    const outputCount = parseFastaRecords(outputText).length;
    let clusters = 0;
    try {
      const clstrText = await fs.readFile(clusterFile, 'utf-8');
      clusters = clstrText.split(/\r?\n/).filter((x) => x.startsWith('>Cluster')).length;
    } catch {
      clusters = outputText.split(/\r?\n/).filter((x) => x.startsWith('>')).length;
    }

    // Existing nodes/edges describe the previous candidate set. Preserve the
    // files for failure recovery, but mark them stale so a normal Compute on
    // step 7 rebuilds them instead of silently reusing mismatched entries.
    await markNetworkArtifactsStale(workDir, {
      sourceFastaPath: outputFasta,
      clusterFilePath: clusterFile,
      inputCount,
      outputCount,
    });

    res.json({
      ok: true,
      outputFasta,
      clusterFile,
      inputCount,
      outputCount,
      deduplicatedCount: Math.max(0, inputCount - outputCount),
      clusters,
      similarityInvalidated: true,
    });
    finishRuntimeTask('clustering/run', true);
    } catch (err) {
      finishRuntimeTask('clustering/run', false);
      jsonError(res, 'Failed to run clustering', err);
    }
  });
});

route.post('/api/network/compute-similarity', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'network/compute-similarity', taskId)) {
    return;
  }

  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });

      const includeReferenceLinks = req.body?.includeReferenceLinks === true;
      const similarityMethod = normalizeSimilarityMethod(req.body?.similarityMethod);
      const sourceFastaPath = String(req.body?.sourceFasta || '').trim();
      const referenceFastaPath = String(req.body?.referenceFasta || '').trim();
      const forceRecompute = req.body?.forceRecompute === true;
      const nodesPath = path.join(workDir, 'nodes.csv');
      const edgesPath = path.join(workDir, 'edges_similarity.csv');
      const staleMeta = await readNetworkStaleMeta(workDir);

      let existingNodeTotal = 0;
      let existingEdgeTotal = 0;
      let existingFilesReady = false;
      try {
        const [nodesPreview, edgesPreview] = await Promise.all([
          readCsvPreview(nodesPath, 1),
          readCsvPreview(edgesPath, 1),
        ]);
        existingNodeTotal = Number(nodesPreview.total || 0);
        existingEdgeTotal = Number(edgesPreview.total || 0);
        existingFilesReady = existingNodeTotal > 0;
      } catch {
        existingFilesReady = false;
      }

      if (existingFilesReady && !forceRecompute && !staleMeta) {
        const buildMeta = await readNetworkBuildMeta(workDir);
        pushRuntimeLine(`[network] reused existing similarity artifacts: nodes=${existingNodeTotal}, edges=${existingEdgeTotal}; no alignment was run`);
        res.json({
          ok: true,
          nodesCsv: nodesPath,
          edgesCsv: edgesPath,
          nodes: existingNodeTotal,
          edges: existingEdgeTotal,
          similarityMethod: buildMeta?.similarityMethod || null,
          includeReferenceLinks: typeof buildMeta?.includeReferenceLinks === 'boolean'
            ? buildMeta.includeReferenceLinks
            : null,
          reused: true,
          generated: false,
          recomputedAt: null,
        });
        finishRuntimeTask('network/compute-similarity', true);
        return;
      }

      if (staleMeta && !forceRecompute) {
        pushRuntimeLine('[network] clustering output changed; existing similarity CSV files are stale and will be rebuilt');
      }

      updateNetworkAlignProgress({
        phase: 'prepare',
        stageCurrent: 0,
        stageTotal: 1,
        overallCurrent: 0,
        overallTotal: 1,
      }, taskId);

      // Keep the previous files in place until replacement data is ready. The
      // metadata copy preserves taxonomy fields during an explicit rebuild.
      const taxonomyCachePath = path.join(workDir, '.nodes_meta_cache.csv');
      try {
        await fs.copyFile(nodesPath, taxonomyCachePath);
      } catch { /* no existing nodes.csv */ }
      pushRuntimeLine(`[network] ${forceRecompute ? 'explicit force-recompute' : 'no reusable artifacts found'}; full similarity calculation started`);

      const rebuilt = await ensureNetworkFiles(workDir, {
        forceRebuild: true,
        pairwiseThresholdPct: 0,
        includeReferenceLinks,
        similarityMethod,
        sourceFastaPath: sourceFastaPath || String(staleMeta?.sourceFastaPath || ''),
        referenceFastaPath,
      });

      const outNodesPath = rebuilt.nodesPath;
      const outEdgesPath = rebuilt.edgesPath;
      const { rows: nodeRows } = await readCsvRows(outNodesPath);
      const { rows: edgeRows } = await readCsvRows(outEdgesPath);
      const candidateNodes = nodeRows.filter((row) => String(row.is_reference || '') !== '1').length;
      const referenceNodes = nodeRows.length - candidateNodes;

      if (!nodeRows.length) {
        throw new Error('Similarity computed but nodes.csv is empty. Please verify input FASTA contains sequences.');
      }
      if (!edgeRows.length) {
        throw new Error('Similarity computed but no edges were generated. Please verify sequence count or algorithm settings.');
      }

      // The HTTP request may finish between two frontend polling ticks. Persist an
      // explicit terminal snapshot so the final poll always sees fully completed bars.
      completeNetworkAlignProgress(taskId);

      res.json({
        ok: true,
        nodesCsv: outNodesPath,
        edgesCsv: outEdgesPath,
        nodes: nodeRows.length,
        candidateNodes,
        referenceNodes,
        edges: edgeRows.length,
        similarityMethod,
        includeReferenceLinks,
        reused: false,
        generated: true,
        recomputedAt: Date.now(),
      });
      finishRuntimeTask('network/compute-similarity', true);
    } catch (err) {
      finishRuntimeTask('network/compute-similarity', false);
      jsonError(res, 'Failed to compute sequence similarity', err);
    }
  });
});

route.get('/api/network/similarity-status', async (req, res) => {
  try {
    const { taskId, workDir } = await resolveWorkDirForReq(req);
    const nodesPath = path.join(workDir, 'nodes.csv');
    const edgesPath = path.join(workDir, 'edges_similarity.csv');
    const staleMeta = await readNetworkStaleMeta(workDir);

    let nodesExists = false;
    let edgesExists = false;
    try {
      await fs.access(nodesPath);
      nodesExists = true;
    } catch {
      nodesExists = false;
    }
    try {
      await fs.access(edgesPath);
      edgesExists = true;
    } catch {
      edgesExists = false;
    }

    let nodeTotal = 0;
    let edgeTotal = 0;
    if (nodesExists) {
      const p = await readCsvPreview(nodesPath, 1);
      nodeTotal = Number(p.total || 0);
    }
    if (edgesExists) {
      const p = await readCsvPreview(edgesPath, 1);
      edgeTotal = Number(p.total || 0);
    }

    res.json({
      ok: true,
      taskId,
      exists: nodesExists && edgesExists,
      nodesExists,
      edgesExists,
      nodeTotal,
      edgeTotal,
      nodesCsv: nodesPath,
      edgesCsv: edgesPath,
      stale: Boolean(staleMeta),
      staleReason: staleMeta?.reason || null,
    });
  } catch (err) {
    jsonError(res, 'Failed to load similarity status', err);
  }
});

route.get('/api/network/data', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const edgesPath = path.join(workDir, 'edges_similarity.csv');
    const nodesPath = path.join(workDir, 'nodes.csv');
    const staleMeta = await readNetworkStaleMeta(workDir);

    if (staleMeta) {
      res.status(409).json({
        ok: false,
        stale: true,
        message: 'Clustering results changed after these similarity files were created. Run Compute Similarity to rebuild them from the current clustered FASTA.',
      });
      return;
    }

    // This endpoint is intentionally read-only. "Load" must report exactly
    // what is already stored on disk and must never trigger CD-HIT/alignment.
    try {
      await Promise.all([fs.access(nodesPath), fs.access(edgesPath)]);
    } catch {
      res.status(404).json({
        ok: false,
        message: 'Existing nodes.csv / edges_similarity.csv were not found. Compute sequence similarity first.',
      });
      return;
    }

    const [edgesPreview, nodesPreview] = await Promise.all([
      readCsvPreview(edgesPath, 200),
      readCsvPreview(nodesPath, 200),
    ]);
    const normalizedEdges = edgesPreview.rows.map((row) => ({
      ...row,
      weight: toFiniteNumber(row.weight, null),
      similarity: toFiniteNumber(row.similarity, null),
    }));
    res.json({
      ok: true,
      edges: normalizedEdges,
      nodes: nodesPreview.rows,
      edgeTotal: Number(edgesPreview.total || 0),
      nodeTotal: Number(nodesPreview.total || 0),
      generated: false,
      reused: true,
    });
  } catch (err) {
    jsonError(res, 'Failed to read existing network files', err);
  }
});

// ── Browser Graph Data (full nodes + filtered edges for in-browser visualization) ──
route.post('/api/network/browser-graph', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const staleMeta = await readNetworkStaleMeta(workDir);
    if (staleMeta) {
      res.status(409).json({
        ok: false,
        stale: true,
        message: 'Clustering results changed. Recompute sequence similarity before loading the network.',
      });
      return;
    }
    const pairwiseThresholdPct = Number(req.body?.pairwiseThresholdPct);
    const maxEdges = Number(req.body?.maxEdges);
    const nodesPath = path.join(workDir, 'nodes.csv');
    const edgesPath = path.join(workDir, 'edges_similarity.csv');
    const { rows: nodesRows } = await readCsvRows(nodesPath);
    const { rows: edgesRows } = await readCsvRows(edgesPath);
    const browserGraphSelection = chooseBrowserGraphThreshold(edgesRows, pairwiseThresholdPct, maxEdges);
    const filteredEdges = browserGraphSelection.filteredRows;
    // Normalize numeric fields
    const edges = filteredEdges.map((r) => ({
      source: String(r.source || '').trim(),
      target: String(r.target || '').trim(),
      weight: toFiniteNumber(r.weight, 1),
      similarity: toFiniteNumber(r.similarity, null),
    }));
    const nodes = nodesRows.map((r) => ({
      id: String(r.id || '').trim(),
      cluster: String(r.cluster || '').trim(),
      cluster_size: Number(r.cluster_size) || 1,
      is_reference: String(r.is_reference || '0').trim(),
      kingdom: String(r.kingdom || '').trim(),
      phylum: String(r.phylum || '').trim(),
      class: String(r['class'] || '').trim(),
      order: String(r.order || '').trim(),
      family: String(r.family || '').trim(),
      genus: String(r.genus || '').trim(),
      species: String(r.species || '').trim(),
    }));
    res.json({
      ok: true,
      nodes,
      edges,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      requestedThresholdPct: browserGraphSelection.requestedThresholdPct,
      appliedThresholdPct: browserGraphSelection.appliedThresholdPct,
      thresholdAdjusted: browserGraphSelection.thresholdAdjusted,
      maxEdges: browserGraphSelection.maxEdges,
    });
  } catch (err) {
    jsonError(res, 'Failed to load browser graph data', err);
  }
});

route.post('/api/network/push-cytoscape', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'network/push-cytoscape', taskId)) {
    return;
  }

  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });

      const pairwiseThresholdPct = Number(req.body?.pairwiseThresholdPct);
      const includeReferenceLinks = req.body?.includeReferenceLinks === true;
      const similarityMethod = normalizeSimilarityMethod(req.body?.similarityMethod);
      const forceRebuild = req.body?.forceRebuild === true;
      const sourceFastaPath = String(req.body?.sourceFasta || '').trim();
      const referenceFastaPath = String(req.body?.referenceFasta || '').trim();
      let nodesPath = path.join(workDir, 'nodes.csv');
      let edgesPath = path.join(workDir, 'edges_similarity.csv');
      let generated = false;
      if (forceRebuild) {
        const rebuilt = await ensureNetworkFiles(workDir, {
          forceRebuild: true,
          pairwiseThresholdPct: 0,
          includeReferenceLinks,
          similarityMethod,
          sourceFastaPath,
          referenceFastaPath,
        });
        nodesPath = rebuilt.nodesPath;
        edgesPath = rebuilt.edgesPath;
        generated = true;
      } else {
        const staleMeta = await readNetworkStaleMeta(workDir);
        if (staleMeta) {
          res.status(409).json({
            ok: false,
            stale: true,
            message: 'Clustering results changed. Recompute sequence similarity before pushing the network.',
          });
          finishRuntimeTask('network/push-cytoscape', false);
          return;
        }
        try {
          await Promise.all([fs.access(nodesPath), fs.access(edgesPath)]);
        } catch {
          res.status(404).json({
            ok: false,
            message: 'Existing similarity files were not found. Compute sequence similarity before loading or pushing the network.',
          });
          finishRuntimeTask('network/push-cytoscape', false);
          return;
        }
      }
      const { rows: nodesRows } = await readCsvRows(nodesPath);
      const { rows: edgesRows } = await readCsvRows(edgesPath);
      const filteredEdgesRows = filterEdgesByThresholdPct(edgesRows, pairwiseThresholdPct);

      if (!nodesRows.length) {
        res.status(400).json({ ok: false, message: 'nodes.csv is empty; nothing to push to Cytoscape' });
        finishRuntimeTask('network/push-cytoscape', false);
        return;
      }
      if (!filteredEdgesRows.length) {
        res.status(400).json({
          ok: false,
          message: `No edges after threshold filter (${Number.isFinite(pairwiseThresholdPct) ? pairwiseThresholdPct : 'N/A'}%). Lower threshold or recompute similarity.`,
        });
        finishRuntimeTask('network/push-cytoscape', false);
        return;
      }

      const baseUrl = normalizeCyRestBaseUrl(req.body?.baseUrl);
      const networkTitle = String(req.body?.title || 'Similarity Network').trim() || 'Similarity Network';
      const collection = String(req.body?.collection || 'Similarity').trim() || 'Similarity';
      const layout = String(req.body?.layout || 'force-directed').trim();
      const requestedCategory = req.body?.categoryColumn ? String(req.body.categoryColumn).trim() : null;
      const styleName = String(req.body?.styleName || (requestedCategory ? `${requestedCategory}_style` : 'phylum_style')).trim();
      const applyStyle = req.body?.applyStyle !== false;

      pushRuntimeLine(`[cytoscape] base=${baseUrl} requestedCategory=${requestedCategory} styleName=${styleName}`);
      await cyrestRequest(baseUrl, 'GET', '', undefined);

      const payload = buildCyNetworkPayload(nodesRows, filteredEdgesRows, networkTitle);
      const createResp = await cyrestRequest(
        baseUrl,
        'POST',
        `/networks?collection=${encodeURIComponent(collection)}`,
        payload,
      );

      const networkSuid = parseCyNetworkSuid(createResp);
      if (networkSuid === null) {
        throw new Error(`Cytoscape create succeeded but network SUID is missing: ${JSON.stringify(createResp || {})}`);
      }

      // Large networks in Cytoscape (usually > 100,000 items) skip automatic view creation
      // to avoid OOM/freezing. We must manually create the view so layout/style can be applied.
      try {
        await cyrestRequest(baseUrl, 'POST', `/networks/${networkSuid}/views`, undefined);
      } catch (err) {
        pushRuntimeLine(`[cytoscape] creating view manually failed: ${String(err)}`);
      }

      let styleApplied = false;
      let styleError = '';
      let categoryColumn = null;
      let layoutApplied = false;
      let layoutError = '';

      if (applyStyle && networkSuid !== null) {
        try {
          const column = pickCategoryColumn(nodesRows, requestedCategory);
          pushRuntimeLine(`[cytoscape] picked column=${column} (requested=${requestedCategory}, rows=${nodesRows.length})`);
          const categories = column
            ? buildCategoryColorMap(nodesRows.map((r) => r[column]))
            : [];
          const { min: weightMin, max: weightMax } = computeFiniteMinMax(filteredEdgesRows.map((r) => r.weight));
          const hasReferenceFlag = nodesRows.some((r) => String(r?.is_reference || '').trim() === '1');

          const styleInfo = await upsertCytoscapeStyle(baseUrl, {
            styleName,
            categoryColumn: column,
            categories,
            hasReferenceFlag,
            weightMin,
            weightMax,
          });
          categoryColumn = styleInfo.categoryColumn;

          await cyrestRequest(baseUrl, 'GET', `/apply/styles/${encodeURIComponent(styleInfo.styleName)}/${networkSuid}`, undefined);
          styleApplied = true;
        } catch (err) {
          styleError = String(err);
          pushRuntimeLine(`[cytoscape] style failed: ${styleError}`);
        }
      }

      if (layout && networkSuid !== null) {
        try {
          await cyrestRequest(baseUrl, 'GET', `/apply/layouts/${encodeURIComponent(layout)}/${networkSuid}`, undefined);
          layoutApplied = true;
        } catch (err) {
          layoutError = String(err);
          pushRuntimeLine(`[cytoscape] layout failed: ${layoutError}`);
        }
      }

      res.json({
        ok: true,
        baseUrl,
        networkSuid,
        generated,
        nodesCsv: nodesPath,
        edgesCsv: edgesPath,
        pushedNodes: payload.elements.nodes.length,
        pushedEdges: payload.elements.edges.length,
        pairwiseThresholdPct: Number.isFinite(pairwiseThresholdPct) ? pairwiseThresholdPct : null,
        includeReferenceLinks,
        similarityMethod,
        collection,
        title: networkTitle,
        layout,
        styleName,
        styleApplied,
        styleError,
        categoryColumn,
        layoutApplied,
        layoutError,
      });
      finishRuntimeTask('network/push-cytoscape', true);
    } catch (err) {
      finishRuntimeTask('network/push-cytoscape', false);
      jsonError(res, 'Failed to push network to Cytoscape', err);
    }
  });
});

// ── Candidate property prediction (kcat / Km / solubility / Tm / EC) ──────
route.post('/api/network/predict-metrics', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'network/predict-metrics', taskId)) return;

  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });

      const forceRecompute = Boolean(req.body?.forceRecompute);
      const tmTarget = Number.isFinite(Number(req.body?.tmTarget)) ? Number(req.body.tmTarget) : 60;
      const subWeights = normalizePredictedSubWeights(req.body?.subWeights);
      const smiles = String(req.body?.smiles || '').trim();

      const [cataProOnline, solOnline, ecOnline, tmOnline] = await Promise.all([
        checkServiceHealth(CATAPRO_URL),
        checkServiceHealth(SOL_URL),
        checkServiceHealth(EC_URL),
        checkServiceHealth(TM_URL),
      ]);

      const modes = {
        cataPro: Boolean(cataProOnline && smiles),
        solubility: solOnline,
        ec: ecOnline,
        tm: tmOnline,
      };

      pushRuntimeLine(`[predict-metrics] services: cataPro=${cataProOnline ? 'online' : 'offline'}${!smiles && cataProOnline ? ' (no SMILES provided, using mock kcat/Km)' : ''}, sol=${solOnline ? 'online' : 'offline'}, ec=${ecOnline ? 'online' : 'offline'}, tm=${tmOnline ? 'online' : 'offline'}`);
      pushRuntimeLine(`[predict-metrics] mode: kcat/Km=${modes.cataPro ? 'real-preferred' : 'mock'}, sol=${modes.solubility ? 'real-preferred' : 'mock'}, ec=${modes.ec ? 'real-preferred' : 'mock'}, tm=${modes.tm ? 'real-preferred' : 'mock'}`);

      const { rows: nodeRows } = await readCsvRows(path.join(workDir, 'nodes.csv'));
      const candidateIds = nodeRows.filter((n) => String(n.is_reference) !== '1').map((n) => n.id);
      if (!candidateIds.length) throw new Error('No candidate sequences found in nodes.csv – run similarity computation first');

      const candFastaPath = await firstExistingPath(resolveNetworkSourceFasta(workDir));
      if (!candFastaPath) throw new Error('Could not find candidate FASTA to run predictions on');
      const fastaText = await fs.readFile(candFastaPath, 'utf-8');
      const seqLookup = buildSequenceLookup(parseFastaRecords(fastaText));

      const cacheContext = buildPredictionCacheContext({ candidateIds, seqLookup, smiles, modes });
      const cachedMeta = forceRecompute ? null : await loadPredictionCacheMeta(workDir);
      const existing = forceRecompute ? new Map() : await loadPredictedMetricsMap(workDir);
      if (forceRecompute) {
        pushRuntimeLine('[predict-metrics] cache bypassed by forceRecompute');
      } else if (!cachedMeta) {
        pushRuntimeLine('[predict-metrics] no prediction cache metadata found; predictors will run as needed');
      } else if (cachedMeta.fingerprint !== cacheContext.fingerprint) {
        pushRuntimeLine('[predict-metrics] prediction context changed; validating each cached predictor independently');
      }

      // Cache each predictor independently. A cached mock is a completed result,
      // not a failed cache entry: a normal Run must reuse it even if the service
      // health check later reports online. Recompute All remains the explicit way
      // to refresh predictions. Sequence changes invalidate all predictors for
      // that sequence, while a SMILES change invalidates only CataPro.
      const itemsByPredictor = Object.fromEntries(PREDICTION_NAMES.map((name) => [name, []]));
      const recomputeById = new Map();
      const cachedSequenceHashes = sequenceHashMapFromCacheContext(cachedMeta);
      const currentSequenceHashes = sequenceHashMapFromCacheContext(cacheContext);
      for (const id of candidateIds) {
        const sequence = seqLookup.get(id);
        if (!sequence) {
          existing.delete(id);
          pushRuntimeLine(`[predict-metrics] skipped ${id}: sequence not found in candidate FASTA`);
          continue;
        }

        const row = existing.get(id);
        for (const predictor of PREDICTION_NAMES) {
          if (predictionNeedsRecompute({
            predictor,
            id,
            row,
            cachedContext: cachedMeta,
            currentContext: cacheContext,
            cachedSequenceHashes,
            currentSequenceHashes,
            forceRecompute,
          })) {
            itemsByPredictor[predictor].push({ id, sequence });
            if (!recomputeById.has(id)) recomputeById.set(id, new Set());
            recomputeById.get(id).add(predictor);
          }
        }
      }

      const recomputedCount = recomputeById.size;
      const predictorCounts = Object.fromEntries(
        PREDICTION_NAMES.map((name) => [name, itemsByPredictor[name].length]),
      );
      const predictorUnitCount = Object.values(predictorCounts).reduce((sum, count) => sum + count, 0);
      if (predictorUnitCount > 0) {
        pushRuntimeLine(`[predict-metrics] running ${predictorUnitCount} predictor unit(s) for ${recomputedCount} sequence(s), application batch size=${PREDICTION_BATCH_SIZE}: kcat/Km=${predictorCounts.cataPro}, sol=${predictorCounts.solubility}, EC=${predictorCounts.ec}, Tm=${predictorCounts.tm}`);
        const progress = createPredictionProgressTracker(itemsByPredictor, modes);
        const [cataProResults, solubilityResults, ecResults, tmResults] = await Promise.all([
          itemsByPredictor.cataPro.length
            ? runCataProPredictions(itemsByPredictor.cataPro, smiles, modes.cataPro, progress)
            : Promise.resolve(new Map()),
          itemsByPredictor.solubility.length
            ? runSolubilityPredictions(itemsByPredictor.solubility, modes.solubility, progress)
            : Promise.resolve(new Map()),
          itemsByPredictor.ec.length
            ? runECPredictions(itemsByPredictor.ec, modes.ec, progress)
            : Promise.resolve(new Map()),
          itemsByPredictor.tm.length
            ? runTmPredictions(itemsByPredictor.tm, modes.tm, progress)
            : Promise.resolve(new Map()),
        ]);

        for (const [id, predictors] of recomputeById) {
          const row = { ...(existing.get(id) || {}), id };
          if (predictors.has('cataPro')) {
            const result = cataProResults.get(id);
            row.kcat = result?.kcat ?? 0;
            row.km = result?.km ?? 0;
            row.cataPro_source = result?.source || 'mock';
          }
          if (predictors.has('solubility')) {
            const result = solubilityResults.get(id);
            row.solubility = result?.score ?? 0;
            row.solubility_source = result?.source || 'mock';
          }
          if (predictors.has('ec')) {
            const result = ecResults.get(id);
            const entries = result?.entries || [];
            row.ec_top1 = entries[0]?.ec || '';
            row.ec_score1 = entries[0]?.score || 0;
            row.ec_top2 = entries[1]?.ec || '';
            row.ec_score2 = entries[1]?.score || 0;
            row.ec_top3 = entries[2]?.ec || '';
            row.ec_score3 = entries[2]?.score || 0;
            row.ec_source = result?.source || 'mock';
          }
          if (predictors.has('tm')) {
            const result = tmResults.get(id);
            row.tm = result?.value ?? 0;
            row.tm_source = result?.source || 'mock';
          }
          existing.set(id, row);
        }
        const finalProgress = progress.snapshot();
        pushRuntimeLine(`[predict-metrics] finished ${recomputedCount} updated sequence(s); ${finalProgress.current}/${finalProgress.total} predictor units complete`);
      } else {
        pushRuntimeLine(`[predict-metrics] loaded all ${candidateIds.length} candidate prediction(s) from cache`);
        setRuntimeMeta({
          predictProgress: {
            current: 0,
            total: 0,
            done: true,
            startedAt: Date.now(),
            elapsedMs: 0,
            estimatedRemainingMs: 0,
            predictors: {},
          },
        });
      }

      const allRows = candidateIds.map((id) => existing.get(id)).filter(Boolean);
      const csvHeaders = [
        'id', 'kcat', 'km', 'solubility', 'tm',
        'ec_top1', 'ec_score1', 'ec_top2', 'ec_score2', 'ec_top3', 'ec_score3',
        'cataPro_source', 'solubility_source', 'tm_source', 'ec_source',
      ];
      await writeCsvRows(resolvePredictedMetricsPath(workDir), csvHeaders, allRows);
      await writePredictionCacheMeta(workDir, cacheContext);

      const normMap = computePredictedNormalization(allRows, subWeights, tmTarget);
      const rows = allRows
        .map((r) => ({
          id: r.id,
          kcat: r.kcat,
          km: r.km ?? 0,
          solubility: r.solubility,
          tm: r.tm,
          ec_top1: r.ec_top1 || '',
          ec_score1: r.ec_score1 ?? 0,
          ec_top2: r.ec_top2 || '',
          ec_score2: r.ec_score2 ?? 0,
          ec_top3: r.ec_top3 || '',
          ec_score3: r.ec_score3 ?? 0,
          sources: {
            cataPro: r.cataPro_source,
            solubility: r.solubility_source,
            tm: r.tm_source,
            ec: r.ec_source,
          },
          ...normMap.get(r.id),
        }))
        .sort((a, b) => b.predictedScore - a.predictedScore);

      const realServiceUsage = {
        cataPro: allRows.some((r) => r.cataPro_source === 'real'),
        solubility: allRows.some((r) => r.solubility_source === 'real'),
        ec: allRows.some((r) => r.ec_source === 'real'),
        tm: allRows.some((r) => r.tm_source === 'real'),
      };

      res.json({
        ok: true,
        taskId,
        count: rows.length,
        recomputedCount,
        tmTarget,
        subWeights,
        smiles: smiles || null,
        services: realServiceUsage,
        rows,
      });
      finishRuntimeTask('network/predict-metrics', true);
    } catch (err) {
      finishRuntimeTask('network/predict-metrics', false);
      jsonError(res, 'Failed to predict candidate metrics', err);
    }
  });
});
// ── Candidate Recommendation ──────────────────────────────────────
route.post('/api/network/recommend-candidates', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'network/recommend', taskId)) return;

  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });

      const weights = {
        avgRefSimilarity: Number(req.body?.weights?.avgRefSimilarity ?? 0.28),
        maxRefSimilarity: Number(req.body?.weights?.maxRefSimilarity ?? 0.2),
        clusterSize: Number(req.body?.weights?.clusterSize ?? 0.24),
        taxonomyDiversity: Number(req.body?.weights?.taxonomyDiversity ?? 0.08),
        predictedScore: Number(req.body?.weights?.predictedScore ?? 0.2),
      };
      const predictedSubWeights = normalizePredictedSubWeights(req.body?.predictedSubWeights);
      const predictedTmTarget = Number.isFinite(Number(req.body?.predictedTmTarget)) ? Number(req.body.predictedTmTarget) : 60;
      const topN = Math.max(1, Math.min(Number(req.body?.topN) || 50, 5000));
      const minClusterSize = Math.max(1, Number(req.body?.minClusterSize) || 2);
      const minSimilarity = Math.max(0, Math.min(100, Number(req.body?.minSimilarity) || 0));
      const temperature = Math.max(0, Number(req.body?.temperature) || 0); // 0 = deterministic
      const diversityMode = String(req.body?.diversityMode || 'proportional').trim().toLowerCase() === 'round-robin' ? 'round-robin' : 'proportional';

      const nodesPath = path.join(workDir, 'nodes.csv');
      const edgesPath = path.join(workDir, 'edges_similarity.csv');

      const { rows: nodeRows } = await readCsvRows(nodesPath);
      const { rows: edgeRows } = await readCsvRows(edgesPath);

      if (!nodeRows.length) throw new Error('nodes.csv is empty – run similarity computation first');

      // Identify reference node IDs
      const referenceIds = new Set(
        nodeRows.filter((n) => String(n.is_reference) === '1').map((n) => n.id),
      );


      const networkConnectivityThreshold = Math.max(0, Math.min(100, Number(req.body?.networkConnectivityThreshold) || 80));

      // Build candidate → reference similarity map and candidate connectivity at the browser graph threshold.
      const candidateRefSims = new Map();
      const parent = new Map();
      const find = (i) => {
        if (!parent.has(i)) parent.set(i, i);
        if (parent.get(i) === i) return i;
        const root = find(parent.get(i));
        parent.set(i, root);
        return root;
      };
      const union = (i, j) => {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) {
          // Keep reference node as root if possible
          if (referenceIds.has(rootI)) {
            parent.set(rootJ, rootI);
          } else {
            parent.set(rootI, rootJ);
          }
        }
      };

      for (const node of nodeRows) {
        parent.set(node.id, node.id);
      }

      for (const edge of edgeRows) {
        const sim = Number(edge.similarity);
        if (!Number.isFinite(sim)) continue;
        const srcIsRef = referenceIds.has(edge.source);
        const tgtIsRef = referenceIds.has(edge.target);
        
        if (srcIsRef && !tgtIsRef) {
          if (!candidateRefSims.has(edge.target)) candidateRefSims.set(edge.target, []);
          candidateRefSims.get(edge.target).push(sim);
        } else if (tgtIsRef && !srcIsRef) {
          if (!candidateRefSims.has(edge.source)) candidateRefSims.set(edge.source, []);
          candidateRefSims.get(edge.source).push(sim);
        }

        if (sim >= networkConnectivityThreshold) {
          union(edge.source, edge.target);
        }
      }

      const componentSizes = new Map();
      for (const node of nodeRows) {
        const root = find(node.id);
        componentSizes.set(root, (componentSizes.get(root) || 0) + 1);
      }
      
      const maxComponentSize = Math.max(1, ...Array.from(componentSizes.values()));


      // Normalisation helpers — now using network connected components as "clusters"
      const componentClasses = new Map(); // rootId -> Set of class names
      for (const node of nodeRows) {
        const rootId = find(node.id);
        if (!componentClasses.has(rootId)) componentClasses.set(rootId, new Set());
        if (node['class']) componentClasses.get(rootId).add(node['class']);
      }
      const maxClassCount = Math.max(1, ...Array.from(componentClasses.values()).map((s) => s.size));

      // Predicted property score (kcat / solubility / Tm), if predict-metrics has been run for this task.
      const predictedMetricsMap = await loadPredictedMetricsMap(workDir);
      const predictedMetricsAvailable = predictedMetricsMap.size > 0;
      const predictedNormMap = predictedMetricsAvailable
        ? computePredictedNormalization(Array.from(predictedMetricsMap.values()), predictedSubWeights, predictedTmTarget)
        : new Map();

      // Score each non-reference candidate
      const candidates = [];
      let filteredByClusterSize = 0;
      let filteredBySimilarity = 0;
      for (const node of nodeRows) {
        if (String(node.is_reference) === '1') continue;
        const rootId = find(node.id);
        const compSize = componentSizes.get(rootId) || 1;
        if (compSize < minClusterSize) { filteredByClusterSize++; continue; }
        const sims = candidateRefSims.get(node.id) || [];
        const avgRefSim = sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length / 100 : 0;
        const maxRefSim = sims.length ? Math.max(...sims) / 100 : 0;
        if (minSimilarity > 0 && maxRefSim * 100 < minSimilarity) { filteredBySimilarity++; continue; }
        const compSizeNorm = compSize / maxComponentSize;
        
        const classCount = componentClasses.get(rootId)?.size || 1;
        const taxonomyDiv = classCount / maxClassCount;
        const predictedScore = predictedNormMap.get(node.id)?.predictedScore ?? 0;

        const score =
          weights.avgRefSimilarity * avgRefSim +
          weights.maxRefSimilarity * maxRefSim +
          weights.clusterSize * compSizeNorm +
          weights.taxonomyDiversity * taxonomyDiv +
          weights.predictedScore * predictedScore;

        candidates.push({
          id: node.id,
          cluster: rootId,
          cluster_size: compSize,
          networkComponent: rootId,
          networkComponentSize: compSize,

          representative: String(node.representative) === '1',
          kingdom: node.kingdom || '',
          phylum: node.phylum || '',
          class: node['class'] || '',
          order: node.order || '',
          family: node.family || '',
          genus: node.genus || '',
          species: node.species || '',
          avgRefSimilarity: Number(avgRefSim.toFixed(4)),
          maxRefSimilarity: Number(maxRefSim.toFixed(4)),
          clusterSizeNorm: Number(compSizeNorm.toFixed(4)),
          networkComponentSizeNorm: Number(compSizeNorm.toFixed(4)),
          taxonomyDiversity: Number(taxonomyDiv.toFixed(4)),
          predictedScore: Number(predictedScore.toFixed(4)),
          score: Number(score.toFixed(4)),
          refEdgeCount: sims.length,
        });

      }

      candidates.sort((a, b) => b.score - a.score);

      const selectionCandidates = candidates;

      // -- Temperature-based weighted sampling helper --
      // When temperature=0, pick deterministically (highest score first).
      // When temperature>0, convert scores to probabilities via softmax and sample.
      const sampleFromBucket = (bucket, ptr) => {
        if (temperature <= 0) {
          // Deterministic: return next in sorted order
          return ptr < bucket.length ? { picked: bucket[ptr], newPtr: ptr + 1 } : null;
        }
        // Temperature sampling among remaining items
        const remaining = bucket.slice(ptr);
        if (!remaining.length) return null;
        if (remaining.length === 1) return { picked: remaining[0], newPtr: bucket.length };
        // Softmax with temperature
        const maxScore = Math.max(...remaining.map(c => c.score));
        const exps = remaining.map(c => Math.exp((c.score - maxScore) / temperature));
        const sumExp = exps.reduce((a, b) => a + b, 0);
        const probs = exps.map(e => e / sumExp);
        // Weighted random pick
        const r = Math.random();
        let cumulative = 0;
        let pickedIdx = remaining.length - 1;
        for (let j = 0; j < probs.length; j++) {
          cumulative += probs[j];
          if (r <= cumulative) { pickedIdx = j; break; }
        }
        const picked = remaining[pickedIdx];
        // Remove picked from bucket by swapping to ptr position
        const bucketIdx = ptr + pickedIdx;
        if (bucketIdx !== ptr) {
          [bucket[ptr], bucket[bucketIdx]] = [bucket[bucketIdx], bucket[ptr]];
        }
        return { picked, newPtr: ptr + 1 };
      };

      // Cluster-diverse selection with optional temperature sampling
      const diverseTopN = [];
      const clusterBuckets = new Map();
      for (const c of selectionCandidates) {
        const cl = String(c.networkComponent); // group by component!
        if (!clusterBuckets.has(cl)) clusterBuckets.set(cl, []);
        clusterBuckets.get(cl).push(c);
      }
      const bucketEntries = Array.from(clusterBuckets.entries())
        .sort((a, b) => (b[1][0]?.score ?? 0) - (a[1][0]?.score ?? 0));
      const bucketPointers = new Map(bucketEntries.map(([cl]) => [cl, 0]));

      if (diversityMode === 'round-robin') {
        // Round-robin: uniform rotation across clusters regardless of size
        const activeBuckets = bucketEntries.map(([cl]) => cl);
        while (diverseTopN.length < topN && activeBuckets.length > 0) {
          let i = 0;
          while (i < activeBuckets.length && diverseTopN.length < topN) {
            const cl = activeBuckets[i];
            const bucket = clusterBuckets.get(cl);
            const ptr = bucketPointers.get(cl);
            const result = sampleFromBucket(bucket, ptr);
            if (result) {
              diverseTopN.push(result.picked);
              bucketPointers.set(cl, result.newPtr);
              i++;
            } else {
              activeBuckets.splice(i, 1);
            }
          }
        }
      } else {
        // Proportional: each cluster gets a share of topN proportional to its size
        const totalCandidates = selectionCandidates.length;
        const clusterQuotas = new Map();
        if (totalCandidates > 0) {
          const rawShares = bucketEntries.map(([cl, bucket]) => ({
            cl,
            size: bucket.length,
            share: (bucket.length / totalCandidates) * topN,
          }));
          let allocated = 0;
          for (const s of rawShares) {
            // Keep Top N as a hard global cap. Small clusters can legitimately receive 0
            // slots in proportional mode; users can switch to round-robin for stricter diversity.
            const base = Math.floor(s.share);
            const quota = Math.min(base, s.size);
            clusterQuotas.set(s.cl, quota);
            allocated += quota;
          }
          let remaining = topN - allocated;
          if (remaining > 0) {
            const byFrac = rawShares
              .filter((s) => clusterQuotas.get(s.cl) < s.size)
              .map((s) => ({ cl: s.cl, frac: s.share - Math.floor(s.share), headroom: s.size - clusterQuotas.get(s.cl) }))
              .sort((a, b) => b.frac - a.frac);
            for (const entry of byFrac) {
              if (remaining <= 0) break;
              const extra = Math.min(remaining, entry.headroom);
              clusterQuotas.set(entry.cl, clusterQuotas.get(entry.cl) + extra);
              remaining -= extra;
            }
          }
          if (remaining > 0) {
            for (const [cl, bucket] of bucketEntries) {
              if (remaining <= 0) break;
              const headroom = bucket.length - (clusterQuotas.get(cl) || 0);
              if (headroom > 0) {
                const extra = Math.min(remaining, headroom);
                clusterQuotas.set(cl, (clusterQuotas.get(cl) || 0) + extra);
                remaining -= extra;
              }
            }
          }
        }
        for (const [cl] of bucketEntries) {
          const bucket = clusterBuckets.get(cl);
          let ptr = bucketPointers.get(cl);
          const quota = clusterQuotas.get(cl) || 0;
          let picked = 0;
          while (picked < quota) {
            const result = sampleFromBucket(bucket, ptr);
            if (!result) break;
            diverseTopN.push(result.picked);
            ptr = result.newPtr;
            picked++;
          }
          bucketPointers.set(cl, ptr);
        }
      }

      // --- On-the-fly ref similarity if edges are sparse ---
      const candidatesWithRefEdges = diverseTopN.filter(c => c.refEdgeCount > 0).length;
      if (diverseTopN.length > 0 && candidatesWithRefEdges < diverseTopN.length * 0.5) {
        // Most selected candidates have no Reference_links edges — compute ref similarity on the fly
        const refFastaPath = await resolveDefaultReferenceFasta(workDir);
        const candidateFastaPaths = resolveNetworkSourceFasta(workDir);
        const candFastaPath = await firstExistingPath(candidateFastaPaths);
        if (refFastaPath && candFastaPath) {
          try {
            const refRecords = await loadReferenceRecords(refFastaPath);
            let candText = '';
            try { candText = await fs.readFile(candFastaPath, 'utf-8'); } catch {}
            const candRecords = candText ? parseFastaRecords(candText) : [];
            if (refRecords.length > 0 && candRecords.length > 0) {
              const seqLookup = buildSequenceLookup([...candRecords, ...refRecords]);
              const needCalc = diverseTopN.filter(c => c.refEdgeCount === 0);
              const pairs = [];
              for (const cand of needCalc) {
                const candSeq = seqLookup.get(cand.id) || null;
                if (!candSeq) continue;
                for (const rec of refRecords) {
                  const refId = String(rec?.id || '').trim();
                  const refSeq = String(rec?.seq || '').replace(/\s+/g, '').toUpperCase();
                  if (!refId || !refSeq) continue;
                  pairs.push({ sourceId: refId, targetId: cand.id, seqA: refSeq, seqB: candSeq });
                }
              }
              if (pairs.length > 0) {
                pushRuntimeLine(`[recommend] computing ref similarity on-the-fly for ${needCalc.length} candidates (${pairs.length} pairs)`);
                const scores = await computePairSimilarityPctBatchBiopython(workDir, pairs, 'needleman-wunsch', {
                  phase: 'recommend-ref-sim',
                  overallTotal: pairs.length,
                  completedBefore: 0,
                });
                // Aggregate per candidate
                const candRefSims = new Map();
                const nRefs = refRecords.length;
                for (let i = 0; i < pairs.length; i++) {
                  const sim = scores[i];
                  if (!Number.isFinite(sim)) continue;
                  const candId = pairs[i].targetId;
                  if (!candRefSims.has(candId)) candRefSims.set(candId, []);
                  candRefSims.get(candId).push(sim);
                }
                // Update candidate objects
                for (const cand of needCalc) {
                  const sims = candRefSims.get(cand.id);
                  if (!sims || !sims.length) continue;
                  const avgSim = sims.reduce((a, b) => a + b, 0) / sims.length / 100;
                  const maxSim = Math.max(...sims) / 100;
                  cand.avgRefSimilarity = Number(avgSim.toFixed(4));
                  cand.maxRefSimilarity = Number(maxSim.toFixed(4));
                  cand.refEdgeCount = sims.length;
                  // Recalculate score
                  cand.score = Number((
                    weights.avgRefSimilarity * avgSim +
                    weights.maxRefSimilarity * maxSim +
                    weights.clusterSize * cand.clusterSizeNorm +
                    weights.networkComponentSize * cand.networkComponentSizeNorm +
                    weights.taxonomyDiversity * cand.taxonomyDiversity +
                    weights.predictedScore * cand.predictedScore
                  ).toFixed(4));
                }
                pushRuntimeLine(`[recommend] ref similarity computed for ${candRefSims.size} candidates`);
              }
            }
          } catch (e) {
            pushRuntimeLine(`[recommend] on-the-fly ref similarity failed: ${e.message}`);
          }
        }
      }

      // Re-sort the diverse selection by score so the output is score-ranked
      diverseTopN.sort((a, b) => b.score - a.score);

      res.json({
        ok: true,
        totalCandidates: candidates.length,
        totalReferences: referenceIds.size,
        filteredByClusterSize,
        filteredBySimilarity,
        minClusterSize,
        minSimilarity,
        temperature,
        diversityMode,
        weights,
        predictedSubWeights,
        predictedTmTarget,
        predictedMetricsAvailable,
        candidates: diverseTopN,
      });
      finishRuntimeTask('network/recommend', true);
    } catch (err) {
      finishRuntimeTask('network/recommend', false);
      jsonError(res, 'Failed to compute candidate recommendations', err);
    }
  });
});

// --- Highlight recommended candidates in Cytoscape ---
route.post('/api/network/highlight-cytoscape', async (req, res) => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return jsonError(res, 'ids array is required');
    }
    const baseUrl = normalizeCyRestBaseUrl(req.body?.baseUrl);
    const networkSuid = req.body?.networkSuid;

    // Get current network SUID if not provided
    let suid = networkSuid;
    if (!suid) {
      const nets = await cyrestRequest(baseUrl, 'GET', '/networks', undefined);
      if (!Array.isArray(nets) || nets.length === 0) throw new Error('No networks loaded in Cytoscape');
      suid = nets[nets.length - 1]; // most recently created
    }

    // Use CyREST Commands API: network/select and network/deselect
    const commandsBase = baseUrl.replace(/\/v1\/?$/, '') + '/v1/commands';

    // Deselect all nodes first
    await fetch(`${commandsBase}/network/deselect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeList: 'all', network: String(suid) }),
    });

    // Get node table to find matching names
    const nodeTable = await cyrestRequest(baseUrl, 'GET', `/networks/${suid}/tables/defaultnode/rows`, undefined);
    const idSet = new Set(ids.map(String));
    const matchingNames = [];
    if (Array.isArray(nodeTable)) {
      for (const row of nodeTable) {
        if (row.name && idSet.has(String(row.name))) {
          matchingNames.push(String(row.name));
        }
      }
    }

    // Select matching nodes by name via Commands API
    if (matchingNames.length > 0) {
      // Use name: prefix for each node
      const nodeListStr = matchingNames.map(n => `name:${n}`).join(',');
      await fetch(`${commandsBase}/network/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeList: nodeListStr, network: String(suid) }),
      });
    }

    res.json({ ok: true, selectedCount: matchingNames.length, requestedCount: ids.length, networkSuid: suid });
  } catch (err) {
    jsonError(res, 'Failed to highlight in Cytoscape', err);
  }
});

function normalizeRecommendedExportIds(rawIds) {
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new Error('ids array is required');
  }
  if (rawIds.length > 50000) {
    throw new Error('Too many ids to export (max 50000)');
  }
  const ids = rawIds.map((id) => String(id || '').trim()).filter(Boolean);
  if (!ids.length) {
    throw new Error('ids array is required');
  }
  return ids;
}

function buildRequestedTokenIndex(ids) {
  const index = new Map();
  for (const id of ids) {
    for (const token of new Set([id, ...normalizeIdTokens(id)])) {
      const matches = index.get(token) || [];
      matches.push(id);
      index.set(token, matches);
    }
  }
  return index;
}

async function loadRecommendedSequenceRecords(workDir, ids) {
  const tokenIndex = buildRequestedTokenIndex(ids);
  const found = new Map();
  const allPaths = [
    ...resolveNetworkSourceFasta(workDir),
    path.join(workDir, 'ref.fasta'),
    path.join(workDir, 'ref_dedup.fasta'),
  ];

  for (const filePath of allPaths) {
    try {
      const records = parseFastaRecords(await fs.readFile(filePath, 'utf-8'));
      for (const rec of records) {
        const recordTokens = new Set([
          ...normalizeIdTokens(rec.id),
          ...normalizeIdTokens(rec.header),
        ]);
        for (const token of recordTokens) {
          for (const requestedId of tokenIndex.get(token) || []) {
            if (!found.has(requestedId)) found.set(requestedId, rec);
          }
        }
      }
    } catch {
      // Optional/legacy FASTA source is absent.
    }
  }
  return found;
}

function mergeNonEmptyFields(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if ((target[key] === undefined || target[key] === null || target[key] === '') && value !== undefined && value !== null && value !== '') {
      target[key] = value;
    }
  }
}

async function loadRecommendedMetadata(workDir, ids) {
  const tokenIndex = buildRequestedTokenIndex(ids);
  const metadata = new Map(ids.map((id) => [id, {}]));
  const csvFiles = [
    'hits_filtered.csv',
    'blast_hits_filtered.csv',
    'hits_all.csv',
    'blast_hits_all.csv',
    'scored_results.csv',
    'nodes.csv',
    '.nodes_meta_cache.csv',
    'ref.csv',
  ];
  const identityColumns = ['id', 'target', 'accession', 'uniprot_accession', 'uniprot_identifier'];

  for (const fileName of csvFiles) {
    try {
      const { rows } = await readCsvRows(path.join(workDir, fileName));
      for (const row of rows) {
        const rowTokens = new Set();
        for (const column of identityColumns) {
          for (const token of normalizeIdTokens(row[column])) rowTokens.add(token);
        }
        const matchedIds = new Set();
        for (const token of rowTokens) {
          for (const requestedId of tokenIndex.get(token) || []) matchedIds.add(requestedId);
        }
        for (const requestedId of matchedIds) mergeNonEmptyFields(metadata.get(requestedId), row);
      }
    } catch {
      // Metadata sources are optional and differ between HMMER/BLAST/legacy tasks.
    }
  }
  return metadata;
}

function lookupMapByNormalizedId(sourceMap, ids) {
  const byToken = new Map();
  for (const [sourceId, value] of sourceMap.entries()) {
    for (const token of normalizeIdTokens(sourceId)) {
      if (!byToken.has(token)) byToken.set(token, value);
    }
  }
  const out = new Map();
  for (const id of ids) {
    const value = sourceMap.get(id) || normalizeIdTokens(id).map((token) => byToken.get(token)).find(Boolean);
    if (value) out.set(id, value);
  }
  return out;
}

const MANUAL_FILTER_TEXT_FIELDS = new Set([
  'id', 'ec', 'ec_top1', 'ec_top2', 'ec_top3', 'uniprot_accession', 'uniprot_identifier',
  'description', 'taxonomy_id', 'kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species',
]);
const MANUAL_FILTER_NUMERIC_FIELDS = new Set([
  'length', 'hmm_score', 'evalue', 'bitscore', 'pident', 'qcovs', 'kcat', 'km',
  'catalytic_efficiency', 'solubility', 'tm', 'predicted_score',
]);
const MANUAL_FILTER_TEXT_OPERATORS = new Set(['contains', 'not_contains', 'equals', 'not_equals', 'starts_with']);
const MANUAL_FILTER_NUMERIC_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'between']);
const MANUAL_FILTER_SORT_FIELDS = new Set([...MANUAL_FILTER_TEXT_FIELDS, ...MANUAL_FILTER_NUMERIC_FIELDS]);

function manualFilterBadRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizeManualFilterConditions(rawConditions) {
  if (!Array.isArray(rawConditions)) return [];
  if (rawConditions.length > 20) throw manualFilterBadRequest('A maximum of 20 filter conditions is allowed');
  return rawConditions.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const field = String(raw.field || '').trim();
    const operator = String(raw.operator || '').trim();
    const isText = MANUAL_FILTER_TEXT_FIELDS.has(field);
    const isNumeric = MANUAL_FILTER_NUMERIC_FIELDS.has(field);
    if (!isText && !isNumeric) throw manualFilterBadRequest(`Unsupported filter field: ${field || '(empty)'}`);
    if (isText && !MANUAL_FILTER_TEXT_OPERATORS.has(operator)) {
      throw manualFilterBadRequest(`Unsupported operator ${operator || '(empty)'} for ${field}`);
    }
    if (isNumeric && !MANUAL_FILTER_NUMERIC_OPERATORS.has(operator)) {
      throw manualFilterBadRequest(`Unsupported operator ${operator || '(empty)'} for ${field}`);
    }
    if (isText) {
      const value = String(raw.value ?? '').trim();
      if (!value) return [];
      const ecScope = ['top1', 'top2', 'top3'].includes(String(raw.ecScope || ''))
        ? String(raw.ecScope)
        : 'any';
      return [{ field, operator, value, ecScope }];
    }
    if (raw.value === '' || raw.value === null || raw.value === undefined) return [];
    if (operator === 'between' && (raw.value2 === '' || raw.value2 === null || raw.value2 === undefined)) return [];
    const value = Number(raw.value);
    const value2 = Number(raw.value2);
    if (!Number.isFinite(value)) return [];
    if (operator === 'between' && !Number.isFinite(value2)) return [];
    return [{ field, operator, value, value2 }];
  });
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function manualFilterValue(row, condition) {
  if (condition.field !== 'ec') return row[condition.field];
  if (condition.ecScope === 'top1') return row.ec_top1;
  if (condition.ecScope === 'top2') return row.ec_top2;
  if (condition.ecScope === 'top3') return row.ec_top3;
  return [row.ec_top1, row.ec_top2, row.ec_top3].filter(Boolean).join(' ');
}

function manualFilterConditionMatches(row, condition) {
  const rawValue = manualFilterValue(row, condition);
  if (MANUAL_FILTER_TEXT_FIELDS.has(condition.field)) {
    const actual = String(rawValue ?? '').toLocaleLowerCase();
    const expected = String(condition.value ?? '').toLocaleLowerCase();
    if (condition.operator === 'contains') return actual.includes(expected);
    if (condition.operator === 'not_contains') return !actual.includes(expected);
    if (condition.operator === 'equals') return actual === expected;
    if (condition.operator === 'not_equals') return actual !== expected;
    if (condition.operator === 'starts_with') return actual.startsWith(expected);
    return false;
  }
  const actual = finiteNumberOrNull(rawValue);
  if (actual === null) return false;
  if (condition.operator === 'gt') return actual > condition.value;
  if (condition.operator === 'gte') return actual >= condition.value;
  if (condition.operator === 'lt') return actual < condition.value;
  if (condition.operator === 'lte') return actual <= condition.value;
  if (condition.operator === 'eq') return Math.abs(actual - condition.value) <= 1e-12;
  if (condition.operator === 'between') {
    const lower = Math.min(condition.value, condition.value2);
    const upper = Math.max(condition.value, condition.value2);
    return actual >= lower && actual <= upper;
  }
  return false;
}

function compareManualFilterRows(left, right, field, direction) {
  const leftValue = field === 'ec'
    ? [left.ec_top1, left.ec_top2, left.ec_top3].filter(Boolean).join(' ')
    : left[field];
  const rightValue = field === 'ec'
    ? [right.ec_top1, right.ec_top2, right.ec_top3].filter(Boolean).join(' ')
    : right[field];
  const leftMissing = leftValue === null || leftValue === undefined || leftValue === '';
  const rightMissing = rightValue === null || rightValue === undefined || rightValue === '';
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return String(left.id).localeCompare(String(right.id));
    return leftMissing ? 1 : -1;
  }
  let compared;
  if (MANUAL_FILTER_NUMERIC_FIELDS.has(field)) {
    compared = Number(leftValue) - Number(rightValue);
  } else {
    compared = String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: 'base' });
  }
  if (compared === 0) compared = String(left.id).localeCompare(String(right.id), undefined, { numeric: true });
  return direction === 'desc' ? -compared : compared;
}

// Filter every candidate that already has cached property predictions. This is
// intentionally independent of the automatic Top-N recommendation output.
route.post('/api/network/filter-predicted-candidates', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const conditions = normalizeManualFilterConditions(req.body?.conditions);
    const logic = String(req.body?.logic || 'and').toLowerCase() === 'or' ? 'or' : 'and';
    const pageSize = Math.max(1, Math.min(200, Math.floor(Number(req.body?.pageSize) || 50)));
    const requestedPage = Math.max(1, Math.floor(Number(req.body?.page) || 1));
    const includeAllIds = req.body?.includeAllIds === true;
    const sortField = MANUAL_FILTER_SORT_FIELDS.has(String(req.body?.sort?.field || ''))
      ? String(req.body.sort.field)
      : 'id';
    const sortDirection = String(req.body?.sort?.direction || '').toLowerCase() === 'desc' ? 'desc' : 'asc';
    const predictedSubWeights = normalizePredictedSubWeights(req.body?.subWeights);
    const tmTarget = Number.isFinite(Number(req.body?.tmTarget)) ? Number(req.body.tmTarget) : 60;

    const rawPredictedMetrics = await loadPredictedMetricsMap(workDir);
    const ids = Array.from(rawPredictedMetrics.keys()).filter(Boolean);
    if (!ids.length) {
      res.json({
        ok: true,
        totalPredicted: 0,
        filteredCount: 0,
        page: 1,
        pageSize,
        totalPages: 1,
        rows: [],
        ...(includeAllIds ? { matchingIds: [] } : {}),
      });
      return;
    }

    const [records, metadata] = await Promise.all([
      loadRecommendedSequenceRecords(workDir, ids),
      loadRecommendedMetadata(workDir, ids),
    ]);
    const normalizedMetrics = computePredictedNormalization(
      Array.from(rawPredictedMetrics.values()),
      predictedSubWeights,
      tmTarget,
    );
    const rows = ids.map((id) => {
      const predicted = rawPredictedMetrics.get(id) || {};
      const normalized = normalizedMetrics.get(id) || {};
      const meta = metadata.get(id) || {};
      const record = records.get(id);
      const sequence = String(record?.seq || meta.sequence || '').replace(/\s+/g, '').toUpperCase();
      return {
        id,
        sequence,
        length: sequence ? sequence.length : finiteNumberOrNull(meta.length || meta.slen),
        hmm_score: finiteNumberOrNull(meta.hmm_score),
        evalue: finiteNumberOrNull(meta.evalue),
        bitscore: finiteNumberOrNull(meta.bitscore),
        pident: finiteNumberOrNull(meta.pident),
        qcovs: finiteNumberOrNull(meta.qcovs),
        uniprot_accession: meta.uniprot_accession || meta.accession || '',
        uniprot_identifier: meta.uniprot_identifier || meta.identifier || '',
        taxonomy_id: meta.taxonomy_id || '',
        kingdom: meta.kingdom || '',
        phylum: meta.phylum || '',
        class: meta.class || '',
        order: meta.order || '',
        family: meta.family || '',
        genus: meta.genus || '',
        species: meta.species || '',
        description: meta.description || '',
        kcat: finiteNumberOrNull(predicted.kcat),
        km: finiteNumberOrNull(predicted.km),
        catalytic_efficiency: finiteNumberOrNull(normalized.catalyticEfficiency),
        solubility: finiteNumberOrNull(predicted.solubility),
        tm: finiteNumberOrNull(predicted.tm),
        ec_top1: predicted.ec_top1 || '',
        ec_score1: finiteNumberOrNull(predicted.ec_score1),
        ec_top2: predicted.ec_top2 || '',
        ec_score2: finiteNumberOrNull(predicted.ec_score2),
        ec_top3: predicted.ec_top3 || '',
        ec_score3: finiteNumberOrNull(predicted.ec_score3),
        predicted_score: finiteNumberOrNull(normalized.predictedScore),
        cataPro_source: predicted.cataPro_source || '',
        solubility_source: predicted.solubility_source || '',
        tm_source: predicted.tm_source || '',
        ec_source: predicted.ec_source || '',
      };
    });

    const filteredRows = conditions.length
      ? rows.filter((row) => logic === 'or'
        ? conditions.some((condition) => manualFilterConditionMatches(row, condition))
        : conditions.every((condition) => manualFilterConditionMatches(row, condition)))
      : rows;
    filteredRows.sort((left, right) => compareManualFilterRows(left, right, sortField, sortDirection));
    const filteredCount = filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(filteredCount / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;

    res.json({
      ok: true,
      totalPredicted: rows.length,
      filteredCount,
      page,
      pageSize,
      totalPages,
      rows: filteredRows.slice(offset, offset + pageSize),
      ...(includeAllIds ? { matchingIds: filteredRows.map((row) => row.id) } : {}),
    });
  } catch (err) {
    jsonError(res, 'Failed to filter predicted candidates', err);
  }
});

// --- Export recommended candidates as FASTA ---
route.post('/api/network/export-recommended-fasta', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const ids = normalizeRecommendedExportIds(req.body?.ids);
    const found = await loadRecommendedSequenceRecords(workDir, ids);
    const lines = [];
    for (const id of ids) {
      const rec = found.get(id);
      if (!rec) continue;
      lines.push(`>${rec.header}`);
      for (let i = 0; i < rec.seq.length; i += 80) lines.push(rec.seq.slice(i, i + 80));
    }
    res.json({ ok: true, fasta: lines.join('\n'), foundCount: found.size, requestedCount: ids.length });
  } catch (err) {
    jsonError(res, 'Failed to export FASTA', err);
  }
});

// --- Export recommended candidates with source metadata, scores and predictions ---
route.post('/api/network/export-recommended-csv', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const ids = normalizeRecommendedExportIds(req.body?.ids);
    const suppliedCandidates = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
    const candidateById = new Map(
      suppliedCandidates
        .filter((candidate) => candidate && typeof candidate === 'object' && ids.includes(String(candidate.id || '')))
        .map((candidate) => [String(candidate.id), candidate]),
    );
    const [records, metadata, rawPredictedMetrics] = await Promise.all([
      loadRecommendedSequenceRecords(workDir, ids),
      loadRecommendedMetadata(workDir, ids),
      loadPredictedMetricsMap(workDir),
    ]);
    const predictedMetrics = lookupMapByNormalizedId(rawPredictedMetrics, ids);
    const exportSubWeights = normalizePredictedSubWeights(req.body?.predictedSubWeights);
    const exportTmTarget = Number.isFinite(Number(req.body?.predictedTmTarget))
      ? Number(req.body.predictedTmTarget)
      : 60;
    const normalizedPredictedMetrics = computePredictedNormalization(
      Array.from(rawPredictedMetrics.values()),
      exportSubWeights,
      exportTmTarget,
    );
    const headers = [
      'id', 'sequence', 'length', 'hmm_score', 'evalue', 'bitscore', 'pident', 'qcovs',
      'uniprot_accession', 'uniprot_identifier', 'taxonomy_id', 'kingdom', 'phylum', 'class',
      'order', 'family', 'genus', 'species', 'description', 'external_link', 'scoring_score',
      'cluster', 'cluster_size', 'network_component', 'network_component_size', 'representative',
      'avg_ref_similarity', 'max_ref_similarity', 'ref_edge_count', 'cluster_size_norm',
      'network_component_size_norm', 'taxonomy_diversity', 'recommendation_score',
      'kcat', 'km', 'catalytic_efficiency', 'solubility', 'tm',
      'ec_top1', 'ec_score1', 'ec_top2', 'ec_score2', 'ec_top3', 'ec_score3',
      'catapro_source', 'solubility_source', 'tm_source', 'ec_source', 'predicted_score',
    ];
    const finiteOrBlank = (value) => Number.isFinite(Number(value)) ? Number(value) : '';
    const rows = ids.map((id) => {
      const rec = records.get(id);
      const meta = metadata.get(id) || {};
      const candidate = candidateById.get(id) || {};
      const predicted = predictedMetrics.get(id) || {};
      const normalizedPredicted = normalizedPredictedMetrics.get(predicted.id || id) || {};
      const sequence = String(rec?.seq || meta.sequence || '').replace(/\s+/g, '').toUpperCase();
      const efficiency = catalyticEfficiency(predicted);
      return {
        id,
        sequence,
        length: sequence ? sequence.length : (meta.length || meta.slen || ''),
        hmm_score: meta.hmm_score || '',
        evalue: meta.evalue || '',
        bitscore: meta.bitscore || '',
        pident: meta.pident || '',
        qcovs: meta.qcovs || '',
        uniprot_accession: meta.uniprot_accession || meta.accession || '',
        uniprot_identifier: meta.uniprot_identifier || meta.identifier || '',
        taxonomy_id: meta.taxonomy_id || '',
        kingdom: meta.kingdom || candidate.kingdom || '',
        phylum: meta.phylum || candidate.phylum || '',
        class: meta.class || candidate.class || '',
        order: meta.order || candidate.order || '',
        family: meta.family || candidate.family || '',
        genus: meta.genus || candidate.genus || '',
        species: meta.species || candidate.species || '',
        description: meta.description || '',
        external_link: meta.external_link || '',
        scoring_score: meta.score || '',
        cluster: candidate.cluster || meta.cluster || '',
        cluster_size: candidate.cluster_size ?? meta.cluster_size ?? '',
        network_component: candidate.networkComponent || '',
        network_component_size: candidate.networkComponentSize ?? '',
        representative: candidate.representative ?? parseBooleanLike(meta.representative),
        avg_ref_similarity: candidate.avgRefSimilarity ?? '',
        max_ref_similarity: candidate.maxRefSimilarity ?? '',
        ref_edge_count: candidate.refEdgeCount ?? '',
        cluster_size_norm: candidate.clusterSizeNorm ?? '',
        network_component_size_norm: candidate.networkComponentSizeNorm ?? '',
        taxonomy_diversity: candidate.taxonomyDiversity ?? '',
        recommendation_score: candidate.score ?? '',
        kcat: finiteOrBlank(predicted.kcat),
        km: finiteOrBlank(predicted.km),
        catalytic_efficiency: Number.isFinite(efficiency) ? efficiency : '',
        solubility: finiteOrBlank(predicted.solubility),
        tm: finiteOrBlank(predicted.tm),
        ec_top1: predicted.ec_top1 || '',
        ec_score1: finiteOrBlank(predicted.ec_score1),
        ec_top2: predicted.ec_top2 || '',
        ec_score2: finiteOrBlank(predicted.ec_score2),
        ec_top3: predicted.ec_top3 || '',
        ec_score3: finiteOrBlank(predicted.ec_score3),
        catapro_source: predicted.cataPro_source || '',
        solubility_source: predicted.solubility_source || '',
        tm_source: predicted.tm_source || '',
        ec_source: predicted.ec_source || '',
        predicted_score: candidate.predictedScore ?? normalizedPredicted.predictedScore ?? '',
      };
    });
    const csv = [headers.map(csvEscape).join(',')]
      .concat(rows.map((row) => headers.map((header) => csvEscape(row[header] ?? '')).join(',')))
      .join('\n');
    res.json({ ok: true, csv, foundCount: records.size, requestedCount: ids.length });
  } catch (err) {
    jsonError(res, 'Failed to export CSV', err);
  }
});

// --- Startup validation ---
if (!API_KEY) {
  console.warn('NOTICE: API_KEY is not set. This is suitable only for local or trusted single-user environments.');
}
if (configuredAllowedOrigins.length === 0) {
  console.warn(`NOTICE: ALLOWED_ORIGINS is not set; using local-only defaults: ${allowedOrigins.join(', ')}`);
}
if (!['127.0.0.1', 'localhost', '::1'].includes(apiHost) && !API_KEY) {
  console.warn(`WARNING: API is listening on ${apiHost} without API_KEY protection. Use this only on a trusted network.`);
}

// ========================================================================
// BLAST Pipeline Endpoints
// ========================================================================

// --- BLAST DB Build ---
route.post('/api/blast/build-db', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'blast/build-db', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });

      const dbSource = String(req.body?.dbSource || 'local');
      const deduplicateRefs = req.body?.deduplicateRefs !== false;
      const deduplicateIdentity = Number(req.body?.deduplicateIdentity ?? 0.95);

      const refFasta = path.join(workDir, 'ref.fasta');
      try {
        await fs.access(refFasta);
      } catch {
        throw new Error('ref.fasta not found. Please run Step 1 (Reference) first.');
      }

      // Count input reference sequences
      const refContent = await fs.readFile(refFasta, 'utf-8');
      const refInputCount = (refContent.match(/^>/gm) || []).length;

      let refDedupPath = null;
      let refDedupCount = refInputCount;

      // Optionally deduplicate references with CD-HIT
      if (deduplicateRefs && refInputCount > 1) {
        refDedupPath = path.join(workDir, 'blast_ref_dedup.fasta');
        const wordSizeCdhit = deduplicateIdentity >= 0.7 ? 5 : deduplicateIdentity >= 0.6 ? 4 : deduplicateIdentity >= 0.5 ? 3 : 2;
        await runCmd('cd-hit', [
          '-i', refFasta,
          '-o', refDedupPath,
          '-c', String(deduplicateIdentity),
          '-n', String(wordSizeCdhit),
          '-M', '0',
          '-T', '0',
        ]);
        const dedupContent = await fs.readFile(refDedupPath, 'utf-8');
        refDedupCount = (dedupContent.match(/^>/gm) || []).length;
        pushRuntimeLine(`[blast] CD-HIT dedup: ${refInputCount} → ${refDedupCount} sequences (identity=${deduplicateIdentity})`);
      } else {
        pushRuntimeLine(`[blast] Skipping reference dedup (${refInputCount} sequence(s))`);
      }

      let dbPath = null;

      if (dbSource === 'local') {
        const targetFasta = resolveAndValidatePath(
          req.body?.targetFasta, workDir, path.join(workDir, 'target.fasta'));
        try {
          await fs.access(targetFasta);
        } catch {
          throw new Error(`Target FASTA not found: ${targetFasta}`);
        }

        dbPath = path.join(workDir, 'blast_db');
        await runCmd('makeblastdb', [
          '-in', targetFasta,
          '-dbtype', 'prot',
          '-out', dbPath,
          '-parse_seqids',
        ]);
        pushRuntimeLine(`[blast] makeblastdb completed: ${dbPath}`);
      } else {
        const ncbiDb = String(req.body?.ncbiDb || 'nr');
        pushRuntimeLine(`[blast] NCBI remote mode configured: database=${ncbiDb}`);
        // Save config for search step
        await fs.writeFile(
          path.join(workDir, 'blast_db_config.json'),
          JSON.stringify({ dbSource, ncbiDb, createdAt: new Date().toISOString() }, null, 2),
          'utf-8',
        );
      }

      res.json({
        ok: true,
        dbSource,
        dbPath,
        refDedup: refDedupPath,
        refDedupCount,
        refInputCount,
      });
      finishRuntimeTask('blast/build-db', true);
    } catch (err) {
      finishRuntimeTask('blast/build-db', false);
      jsonError(res, 'Failed to build BLAST DB', err);
    }
  });
});

// --- BLAST Search ---
route.post('/api/blast/search', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'blast/search', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });

      const evalue = Number(req.body?.evalue ?? 1e-10);
      const identityMin = Number(req.body?.identityMin ?? 30);
      const queryCovMin = Number(req.body?.queryCovMin ?? 70);
      const subjectLenMin = Number(req.body?.subjectLenMin ?? 200);
      const subjectLenMax = Number(req.body?.subjectLenMax ?? 800);
      const maxTargetSeqs = Number(req.body?.maxTargetSeqs ?? 500);
      const matrix = String(req.body?.matrix || 'BLOSUM62');
      const wordSize = Number(req.body?.wordSize ?? 3);
      const gapOpen = Number(req.body?.gapOpen ?? 11);
      const gapExtend = Number(req.body?.gapExtend ?? 1);
      const mergeStrategy = String(req.body?.mergeStrategy || 'best-evalue');

      // Determine query FASTA (use dedup if available, else ref.fasta)
      const refDedupPath = path.join(workDir, 'blast_ref_dedup.fasta');
      let queryFasta;
      try {
        await fs.access(refDedupPath);
        queryFasta = refDedupPath;
      } catch {
        queryFasta = path.join(workDir, 'ref.fasta');
      }
      try {
        await fs.access(queryFasta);
      } catch {
        throw new Error('No query FASTA found. Please run Reference and BLAST DB setup first.');
      }

      // Determine DB source
      let dbSource = String(req.body?.dbSource || '').toLowerCase();
      let dbPath = path.join(workDir, 'blast_db');
      let useRemote = false;
      let ncbiDb = String(req.body?.ncbiDb || 'nr');

      // Check for saved config
      const configPath = path.join(workDir, 'blast_db_config.json');
      try {
        const configText = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configText);
        if (!dbSource) dbSource = config.dbSource || 'local';
        if (config.ncbiDb) ncbiDb = config.ncbiDb;
      } catch {
        // No config file — default to local
        if (!dbSource) dbSource = 'local';
      }

      if (dbSource === 'ncbi-remote') {
        useRemote = true;
      } else {
        // Verify local DB exists
        try {
          await fs.access(dbPath + '.phr');
        } catch {
          try {
            await fs.access(dbPath + '.psq');
          } catch {
            throw new Error('Local BLAST database not found. Please run "BLAST DB Setup" first.');
          }
        }
      }

      // Split query FASTA into individual sequences
      const queryContent = await fs.readFile(queryFasta, 'utf-8');
      const querySeqs = [];
      let curId = '';
      let curSeq = '';
      for (const line of queryContent.split(/\r?\n/)) {
        if (line.startsWith('>')) {
          if (curId && curSeq) querySeqs.push({ id: curId, seq: curSeq });
          curId = line.slice(1).split(/\s/)[0];
          curSeq = '';
        } else {
          curSeq += line.trim();
        }
      }
      if (curId && curSeq) querySeqs.push({ id: curId, seq: curSeq });

      pushRuntimeLine(`[blast] Running blastp with ${querySeqs.length} query sequence(s)`);
      setRuntimeMeta({
        taskId,
        blastProgress: { current: 0, total: querySeqs.length, queryId: '', queryTimings: [], estimatedRemainingMs: null },
      });

      // outfmt 6 columns:
      // qseqid sseqid pident length mismatch gapopen qstart qend sstart send evalue bitscore qcovs slen sseq
      const outfmtCols = 'qseqid sseqid pident length mismatch gapopen qstart qend sstart send evalue bitscore qcovs slen sseq';
      const rawResultsPath = path.join(workDir, 'blast_raw_results.tsv');
      const combinedResults = [];
      const queryTimings = [];

      for (let qi = 0; qi < querySeqs.length; qi++) {
        const q = querySeqs[qi];
        const queryTmpFile = path.join(workDir, `_blast_query_${qi}.fasta`);
        await fs.writeFile(queryTmpFile, `>${q.id}\n${q.seq}\n`, 'utf-8');
        const outFile = path.join(workDir, `_blast_out_${qi}.tsv`);

        const blastArgs = [
          '-query', queryTmpFile,
          '-evalue', String(evalue),
          '-max_target_seqs', String(maxTargetSeqs),
          '-matrix', matrix,
          '-word_size', String(wordSize),
          '-gapopen', String(gapOpen),
          '-gapextend', String(gapExtend),
          '-outfmt', `6 ${outfmtCols}`,
          '-out', outFile,
        ];

        if (useRemote) {
          blastArgs.push('-remote', '-db', ncbiDb);
        } else {
          blastArgs.push('-db', dbPath, '-num_threads', '4');
        }

        const avgMs = queryTimings.length > 0
          ? queryTimings.reduce((a, b) => a + b, 0) / queryTimings.length
          : null;
        const estimatedRemainingMs = avgMs !== null ? Math.round(avgMs * (querySeqs.length - qi)) : null;

        pushRuntimeLine(`[blast] Query ${qi + 1}/${querySeqs.length}: ${q.id}`);
        setRuntimeMeta({
          blastProgress: {
            current: qi,
            total: querySeqs.length,
            queryId: q.id,
            queryTimings: queryTimings.map((ms) => ({ ms })),
            estimatedRemainingMs,
          },
        });

        const queryStartMs = Date.now();
        await runCmd('blastp', blastArgs);
        const queryElapsedMs = Date.now() - queryStartMs;
        queryTimings.push(queryElapsedMs);

        pushRuntimeLine(`[blast] Query ${qi + 1}/${querySeqs.length}: ${q.id} finished in ${(queryElapsedMs / 1000).toFixed(1)}s`);

        // Parse results
        try {
          const outText = await fs.readFile(outFile, 'utf-8');
          for (const line of outText.trim().split(/\r?\n/)) {
            if (!line.trim()) continue;
            const cols = line.split('\t');
            if (cols.length >= 14) {
              combinedResults.push({
                query: cols[0],
                target: cols[1],
                pident: parseFloat(cols[2]),
                alignment_length: parseInt(cols[3]),
                mismatch: parseInt(cols[4]),
                gapopen: parseInt(cols[5]),
                qstart: parseInt(cols[6]),
                qend: parseInt(cols[7]),
                sstart: parseInt(cols[8]),
                send: parseInt(cols[9]),
                evalue: parseFloat(cols[10]),
                bitscore: parseFloat(cols[11]),
                qcovs: parseFloat(cols[12]),
                slen: parseInt(cols[13]),
                sequence: cols[14] ? cols[14].replace(/-/g, '') : '',
              });
            }
          }
        } catch {
          pushRuntimeLine(`[blast] Warning: no results for query ${q.id}`);
        }

        // Cleanup temp files
        await fs.unlink(queryTmpFile).catch(() => {});
        await fs.unlink(outFile).catch(() => {});
      }

      pushRuntimeLine(`[blast] Total raw hits: ${combinedResults.length}`);
      setRuntimeMeta({
        blastProgress: {
          current: querySeqs.length,
          total: querySeqs.length,
          queryId: '',
          queryTimings: queryTimings.map((ms) => ({ ms })),
          estimatedRemainingMs: 0,
        },
      });

      // Merge by subject accession
      const bySubject = new Map();
      for (const hit of combinedResults) {
        const key = hit.target;
        if (mergeStrategy === 'best-evalue') {
          const existing = bySubject.get(key);
          if (!existing || hit.evalue < existing.evalue) {
            bySubject.set(key, hit);
          }
        } else {
          // union: keep the one with best bitscore per subject
          const existing = bySubject.get(key);
          if (!existing || hit.bitscore > existing.bitscore) {
            bySubject.set(key, hit);
          }
        }
      }

      const mergedHits = [...bySubject.values()];
      pushRuntimeLine(`[blast] After merge (${mergeStrategy}): ${mergedHits.length} unique subjects`);

      // Write hits_all CSV
      const hitsCsv = path.join(workDir, 'blast_hits_all.csv');
      const csvHeaders = ['target', 'query', 'pident', 'evalue', 'bitscore', 'alignment_length', 'qcovs', 'slen', 'length', 'sequence'];
      const csvLines = [csvHeaders.map(csvEscape).join(',')];
      for (const h of mergedHits) {
        csvLines.push([
          csvEscape(h.target),
          csvEscape(h.query),
          csvEscape(h.pident.toFixed(2)),
          csvEscape(h.evalue.toExponential(2)),
          csvEscape(h.bitscore.toFixed(1)),
          csvEscape(h.alignment_length),
          csvEscape(h.qcovs),
          csvEscape(h.slen),
          csvEscape(h.sequence.length || h.slen),
          csvEscape(h.sequence),
        ].join(','));
      }
      await fs.writeFile(hitsCsv, csvLines.join('\n'), 'utf-8');

      const preview = await readCsvPreview(hitsCsv, 30);
      res.json({
        ok: true,
        mode: useRemote ? 'ncbi-remote' : 'local',
        hitsCsv,
        totalHits: combinedResults.length,
        uniqueSubjects: mergedHits.length,
        queriesUsed: querySeqs.length,
        preview,
      });
      finishRuntimeTask('blast/search', true);
    } catch (err) {
      finishRuntimeTask('blast/search', false);
      jsonError(res, 'Failed to run BLAST search', err);
    }
  });
});

// --- BLAST Filter ---
route.post('/api/blast/filter', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'blast/filter', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId });

      const evalueMax = Number(req.body?.evalueMax ?? 1e-10);
      const identityMin = Number(req.body?.identityMin ?? 30);
      const identityMax = Number(req.body?.identityMax ?? 100);
      const queryCovMin = Number(req.body?.queryCovMin ?? 70);
      const subjectLenMin = Number(req.body?.subjectLenMin ?? 200);
      const subjectLenMax = Number(req.body?.subjectLenMax ?? 800);

      const hitsCsv = path.join(workDir, 'blast_hits_all.csv');
      const filteredCsv = path.join(workDir, 'blast_hits_filtered.csv');

      const raw = await fs.readFile(hitsCsv, 'utf-8');
      const lines = raw.trim().split(/\r?\n/);
      if (lines.length <= 1) {
        await fs.writeFile(filteredCsv, lines[0] || '', 'utf-8');
        res.json({ ok: true, total: 0, kept: 0, csv: filteredCsv, filteredFasta: null, fastaCount: 0, preview: { headers: [], rows: [], total: 0 } });
        finishRuntimeTask('blast/filter', true);
        return;
      }

      const headers = parseCsvLine(lines[0]);
      const col = (name) => headers.indexOf(name);
      const dataLines = lines.slice(1);
      const keptLines = dataLines.filter((line) => {
        const cols = parseCsvLine(line);
        const evalue = parseFloat(cols[col('evalue')] || '1');
        const pident = parseFloat(cols[col('pident')] || '0');
        const qcovs = parseFloat(cols[col('qcovs')] || '0');
        const slen = parseInt(cols[col('slen')] || cols[col('length')] || '0');
        return (
          evalue <= evalueMax &&
          pident >= identityMin &&
          pident <= identityMax &&
          qcovs >= queryCovMin &&
          slen >= subjectLenMin &&
          slen <= subjectLenMax
        );
      });

      const out = [headers.map(csvEscape).join(',')].concat(keptLines).join('\n');
      await fs.writeFile(filteredCsv, out, 'utf-8');

      // Also write hits_filtered.csv for downstream step compatibility (alignment/scoring/clustering)
      const compatFilteredCsv = path.join(workDir, 'hits_filtered.csv');
      await fs.writeFile(compatFilteredCsv, out, 'utf-8');

      const preview = await readCsvPreview(filteredCsv, 30);
      const filteredFasta = path.join(workDir, 'blast_hits_filtered.fasta');
      const fastaCount = await writeFastaFromCsv(filteredCsv, filteredFasta);

      // Also write hits_filtered.fasta for downstream compatibility
      const compatFilteredFasta = path.join(workDir, 'hits_filtered.fasta');
      await fs.copyFile(filteredFasta, compatFilteredFasta);

      pushRuntimeLine(`[blast] Filter: ${dataLines.length} → ${keptLines.length} (evalue≤${evalueMax}, pident ${identityMin}-${identityMax}%, qcov≥${queryCovMin}%, slen ${subjectLenMin}-${subjectLenMax})`);

      res.json({
        ok: true,
        total: dataLines.length,
        kept: keptLines.length,
        csv: filteredCsv,
        filteredFasta: fastaCount > 0 ? filteredFasta : null,
        fastaCount,
        preview,
      });
      finishRuntimeTask('blast/filter', true);
    } catch (err) {
      finishRuntimeTask('blast/filter', false);
      jsonError(res, 'Failed to filter BLAST hits', err);
    }
  });
});

// --- BLAST Page (paginated browse) ---
route.get('/api/blast/page', async (req, res) => {
  try {
    const { workDir } = await resolveWorkDirForReq(req);
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.max(1, Math.min(500, Number(req.query.pageSize || 50)));
    const source = String(req.query.source || 'blast_hits_all');
    const fileName = source === 'blast_hits_filtered' ? 'blast_hits_filtered.csv' : 'blast_hits_all.csv';
    const csvPath = path.join(workDir, fileName);
    const offset = (page - 1) * pageSize;

    const preview = await readCsvPreview(csvPath, pageSize, offset);
    res.json({
      ok: true,
      source,
      file: csvPath,
      page,
      pageSize,
      total: preview.total,
      totalPages: Math.max(1, Math.ceil((preview.total || 0) / pageSize)),
      preview,
    });
  } catch (err) {
    jsonError(res, 'Failed to load BLAST results page', err);
  }
});

// --- BLAST Annotate (NCBI taxonomy enrichment) ---
route.post('/api/blast/annotate', async (req, res) => {
  const { taskId } = await resolveWorkDirForReq(req);
  if (!beginRuntimeTaskOrReject(res, 'blast/annotate', taskId)) {
    return;
  }
  await runInTaskContext(taskId, async () => {
    try {
      const { workDir } = await resolveWorkDirForReq(req);
      setRuntimeMeta({ taskId, blastAnnotateProgress: 0, blastAnnotatePhase: 'fetching' });
      const hitsCsv = path.join(workDir, 'blast_hits_all.csv');
      pushRuntimeLine('[blast-annotate] Calling ncbi_annotate.py to retrieve taxonomy info...');
      await runCmd(pythonBin, [path.join(projectRoot, 'scripts/ncbi_annotate.py'), hitsCsv], projectRoot, {
        timeoutMs: uniprotFillTimeoutMs,
        onStderr: (text) => {
          const m = text.match(/(\d+)%\|/);
          if (m) {
            setRuntimeMeta({ blastAnnotateProgress: parseInt(m[1], 10), blastAnnotatePhase: 'fetching', taskId });
          }
        }
      });
      setRuntimeMeta({ blastAnnotateProgress: 100, blastAnnotatePhase: 'done', taskId });

      // Re-apply filter if blast_hits_filtered.csv exists (propagate new taxonomy columns)
      const filteredCsv = path.join(workDir, 'blast_hits_filtered.csv');
      try {
        await fs.access(filteredCsv);
        // Re-read blast_hits_all.csv, filter with same criteria stored in state, and overwrite
        const allRaw = await fs.readFile(hitsCsv, 'utf-8');
        const allLines = allRaw.trim().split(/\r?\n/);
        if (allLines.length > 1) {
          // Read existing filtered to get the set of kept targets
          const filteredRaw = await fs.readFile(filteredCsv, 'utf-8');
          const filteredLines = filteredRaw.trim().split(/\r?\n/);
          const filteredHeaders = parseCsvLine(filteredLines[0]);
          const tIdx = filteredHeaders.indexOf('target');
          const keptTargets = new Set();
          for (let i = 1; i < filteredLines.length; i++) {
            const cols = parseCsvLine(filteredLines[i]);
            if (tIdx >= 0 && cols[tIdx]) keptTargets.add(cols[tIdx].trim());
          }
          // Rebuild filtered from enriched all
          const allHeaders = parseCsvLine(allLines[0]);
          const allTIdx = allHeaders.indexOf('target');
          const newFilteredLines = [allLines[0]];
          for (let i = 1; i < allLines.length; i++) {
            const cols = parseCsvLine(allLines[i]);
            if (allTIdx >= 0 && keptTargets.has((cols[allTIdx] || '').trim())) {
              newFilteredLines.push(allLines[i]);
            }
          }
          await fs.writeFile(filteredCsv, newFilteredLines.join('\n'), 'utf-8');
          // Also update compatibility copy
          const compatFilteredCsv = path.join(workDir, 'hits_filtered.csv');
          await fs.writeFile(compatFilteredCsv, newFilteredLines.join('\n'), 'utf-8');
          pushRuntimeLine(`[blast-annotate] Updated filtered CSV with taxonomy columns (${newFilteredLines.length - 1} rows)`);
        }
      } catch {
        // No filtered CSV yet, that's fine
      }

      // Also refresh nodes.csv taxonomy if it already exists
      try {
        const nodesPath = path.join(workDir, 'nodes.csv');
        await fs.access(nodesPath);
        // Re-read taxonomy from updated hits_filtered.csv and ref.csv
        const phylumByToken = new Map();
        const classByToken = new Map();
        const orderByToken = new Map();
        const familyByToken = new Map();
        const genusByToken = new Map();
        const speciesByToken = new Map();
        const kingdomByToken = new Map();
        const loadMeta = async (csvPath, idCol) => {
          try {
            const { rows } = await readCsvRows(csvPath);
            for (const row of rows) {
              const rawId = String(row[idCol] || '').trim();
              if (!rawId) continue;
              const kingdom = String(row.kingdom || '').trim();
              const phylum = String(row.phylum || '').trim();
              const cls = String(row['class'] || '').trim();
              const order = String(row.order || '').trim();
              const family = String(row.family || '').trim();
              const genus = String(row.genus || '').trim();
              const species = String(row.species || '').trim();
              for (const token of normalizeIdTokens(rawId)) {
                if (kingdom && !kingdomByToken.has(token)) kingdomByToken.set(token, kingdom);
                if (phylum && !phylumByToken.has(token)) phylumByToken.set(token, phylum);
                if (cls && !classByToken.has(token)) classByToken.set(token, cls);
                if (order && !orderByToken.has(token)) orderByToken.set(token, order);
                if (family && !familyByToken.has(token)) familyByToken.set(token, family);
                if (genus && !genusByToken.has(token)) genusByToken.set(token, genus);
                if (species && !speciesByToken.has(token)) speciesByToken.set(token, species);
              }
            }
          } catch { /* file may not exist */ }
        };
        await loadMeta(path.join(workDir, 'hits_filtered.csv'), 'target');
        await loadMeta(path.join(workDir, 'ref.csv'), 'accession');

        // Read existing nodes.csv
        const { headers: nodeHeaders, rows: nodeRows } = await readCsvRows(nodesPath);
        const existingNodeIds = new Set();
        const existingNodeTokens = new Set();

        // Helper to lookup taxonomy by tokens
        const lookupTax = (nodeId) => {
          const tokens = normalizeIdTokens(nodeId);
          let kingdom = '', phylum = '', cls = '', order = '', family = '', genus = '', species = '';
          for (const t of tokens) {
            if (!kingdom) kingdom = kingdomByToken.get(t) || '';
            if (!phylum) phylum = phylumByToken.get(t) || '';
            if (!cls) cls = classByToken.get(t) || '';
            if (!order) order = orderByToken.get(t) || '';
            if (!family) family = familyByToken.get(t) || '';
            if (!genus) genus = genusByToken.get(t) || '';
            if (!species) species = speciesByToken.get(t) || '';
          }
          return { kingdom, phylum, class: cls, order, family, genus, species };
        };

        // Update existing rows
        let updated = 0;
        for (const row of nodeRows) {
          const nodeId = String(row.id || '').trim();
          existingNodeIds.add(nodeId);
          for (const t of normalizeIdTokens(nodeId)) existingNodeTokens.add(t);
          const tokens = normalizeIdTokens(nodeId);
          let kingdom = String(row.kingdom || '').trim();
          let phylum = String(row.phylum || '').trim();
          let cls = String(row['class'] || '').trim();
          let order = String(row.order || '').trim();
          let family = String(row.family || '').trim();
          let genus = String(row.genus || '').trim();
          let species = String(row.species || '').trim();
          let changed = false;
          for (const t of tokens) {
            if (!kingdom && kingdomByToken.has(t)) { kingdom = kingdomByToken.get(t); changed = true; }
            if (!phylum && phylumByToken.has(t)) { phylum = phylumByToken.get(t); changed = true; }
            if (!cls && classByToken.has(t)) { cls = classByToken.get(t); changed = true; }
            if (!order && orderByToken.has(t)) { order = orderByToken.get(t); changed = true; }
            if (!family && familyByToken.has(t)) { family = familyByToken.get(t); changed = true; }
            if (!genus && genusByToken.has(t)) { genus = genusByToken.get(t); changed = true; }
            if (!species && speciesByToken.has(t)) { species = speciesByToken.get(t); changed = true; }
          }
          if (changed) {
            row.kingdom = kingdom;
            row.phylum = phylum;
            row['class'] = cls;
            row.order = order;
            row.family = family;
            row.genus = genus;
            row.species = species;
            updated++;
          }
        }

        // Collect all node IDs referenced in edges but missing from nodes.csv
        const edgesPath = path.join(workDir, 'edges_similarity.csv');
        let missingIds = [];
        try {
          const { rows: edgeRows } = await readCsvRows(edgesPath);
          const edgeNodeIds = new Set();
          for (const er of edgeRows) {
            const s = String(er.source || '').trim();
            const t = String(er.target || '').trim();
            if (s) edgeNodeIds.add(s);
            if (t) edgeNodeIds.add(t);
          }
          for (const eid of edgeNodeIds) {
            if (existingNodeIds.has(eid)) continue;
            const meaningfulTokens = normalizeIdTokens(eid).filter(tk => tk.length >= 4 && !/^(ref|gb|emb|sp|tr|pdb|dbj|pir|prf|gnl|lcl)$/i.test(tk));
            if (!meaningfulTokens.some(tk => existingNodeTokens.has(tk))) {
              missingIds.push(eid);
            }
          }
          pushRuntimeLine(`[blast-annotate] ${missingIds.length} nodes missing from nodes.csv (${edgeNodeIds.size} total in edges)`);
        } catch (edgeErr) {
          pushRuntimeLine(`[blast-annotate] edges read error: ${edgeErr}`);
        }

        // Load cluster info from cd-hit .clstr file for missing nodes
        const clusterOfId = new Map();
        const clusterSizes = new Map();
        const representativeOfCluster = new Map();
        try {
          const clstrPath = path.join(workDir, 'candidates_cdhit85.fasta.clstr');
          const clstrText = await fs.readFile(clstrPath, 'utf-8');
          const clusterBlocks = clstrText.split(/^>Cluster /m).filter(Boolean);
          for (const block of clusterBlocks) {
            const lines = block.trim().split(/\n/);
            const clusterIdx = parseInt(lines[0], 10);
            const clusterName = `Cluster ${clusterIdx}`;
            const memberIds = [];
            let repId = '';
            for (let li = 1; li < lines.length; li++) {
              const match = lines[li].match(/>([^.]+\.[^.]+)\.\.\./);
              if (match) {
                memberIds.push(match[1]);
                if (lines[li].includes('*')) repId = match[1];
              }
            }
            clusterSizes.set(clusterName, memberIds.length);
            if (repId) representativeOfCluster.set(clusterName, repId);
            for (const mid of memberIds) {
              clusterOfId.set(mid, clusterName);
            }
          }
        } catch { /* clstr file may not exist */ }

        // Determine reference set
        const referenceIdSet = new Set();
        try {
          const refFasta = await resolveDefaultReferenceFasta(workDir);
          if (refFasta) {
            const refText = await fs.readFile(refFasta, 'utf-8');
            const refRecs = parseFastaRecords(refText);
            for (const rec of refRecs) {
              for (const token of normalizeIdTokens(rec?.id)) referenceIdSet.add(token);
            }
          }
        } catch { /* no reference fasta */ }

        // Add missing nodes with taxonomy and cluster info
        let added = 0;
        for (const mid of missingIds) {
          const tax = lookupTax(mid);
          const cl = clusterOfId.get(mid) || '';
          const cSize = cl ? (clusterSizes.get(cl) || 1) : 1;
          const rep = cl && representativeOfCluster.get(cl) === mid ? '1' : '0';
          const isRef = normalizeIdTokens(mid).some(t => referenceIdSet.has(t)) ? '1' : '0';
          nodeRows.push({
            id: mid,
            cluster: cl || 'Unknown',
            cluster_size: String(cSize),
            representative: rep,
            is_reference: isRef,
            kingdom: tax.kingdom,
            phylum: tax.phylum,
            class: tax.class,
            order: tax.order,
            family: tax.family,
            genus: tax.genus,
            species: tax.species,
          });
          added++;
        }

        if (updated > 0 || added > 0) {
          const finalHeaders = nodeHeaders.length ? nodeHeaders : ['id', 'cluster', 'cluster_size', 'representative', 'is_reference', 'kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species'];
          await writeCsvRows(nodesPath, finalHeaders, nodeRows);
          pushRuntimeLine(`[blast-annotate] nodes.csv: updated ${updated}, added ${added} missing nodes (total ${nodeRows.length})`);
        }
      } catch (nodesErr) {
        // nodes.csv doesn't exist yet, or error during refresh
        if (nodesErr?.code !== 'ENOENT') {
          pushRuntimeLine(`[blast-annotate] nodes.csv refresh error: ${nodesErr}`);
        }
      }

      const preview = await readCsvPreview(hitsCsv, 30);
      res.json({ ok: true, hitsCsv, preview });
      finishRuntimeTask('blast/annotate', true);
    } catch (err) {
      finishRuntimeTask('blast/annotate', false);
      jsonError(res, 'Failed to annotate BLAST hits', err);
    }
  });
});

// --- Periodic cleanup of stale runtimeStates (every 10 minutes) ---
const RUNTIME_STATE_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const runtimeCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [taskId, state] of runtimeStates) {
    if (!state.active && state.updatedAt && now - state.updatedAt > RUNTIME_STATE_MAX_AGE_MS) {
      runtimeStates.delete(taskId);
    }
  }
}, 10 * 60 * 1000);
runtimeCleanupTimer.unref();

// ──────────────────────────────────────────────────────────
// Compare Module — network intersection / merge endpoints
// ──────────────────────────────────────────────────────────

/**
 * Load summary info for a single task: ref count, candidate count, module type, whether nodes.csv exists.
 */
async function loadTaskNetworkSummary(taskId) {
  const workDir = await resolveWorkDirByTaskId(taskId);
  let module = null;
  let name = taskId;
  try {
    const raw = await fs.readFile(path.join(workDir, 'task.json'), 'utf-8');
    const meta = JSON.parse(raw);
    module = meta?.module || null;
    name = meta?.name || taskId;
  } catch {}

  const refFasta = await resolveDefaultReferenceFasta(workDir);
  const refRecords = await loadReferenceRecords(refFasta);

  let candidateCount = 0;
  let nodesCount = 0;
  let hasNodesCsv = false;
  try {
    const { rows } = await readCsvRows(path.join(workDir, 'nodes.csv'));
    nodesCount = rows.length;
    hasNodesCsv = true;
    candidateCount = rows.filter(r => String(r?.is_reference || '0') !== '1').length;
  } catch {}

  if (!hasNodesCsv) {
    // Fall back: count FASTA records from candidates_cdhit85 or hits_filtered
    for (const candidate of ['candidates_cdhit85.fasta', 'scored_passed.fasta']) {
      try {
        const text = await fs.readFile(path.join(workDir, candidate), 'utf-8');
        candidateCount = parseFastaRecords(text).length;
        break;
      } catch {}
    }
  }

  return {
    taskId,
    name,
    module,
    referenceCount: refRecords.length,
    candidateCount,
    nodesCount,
    hasNodesCsv,
  };
}

route.get('/api/compare/task-info', async (req, res) => {
  try {
    const taskA = String(req.query.taskA || '').trim();
    const taskB = String(req.query.taskB || '').trim();
    if (!taskA || !taskB) {
      return res.status(400).json({ ok: false, message: 'taskA and taskB are required' });
    }
    const [infoA, infoB] = await Promise.all([
      loadTaskNetworkSummary(taskA),
      loadTaskNetworkSummary(taskB),
    ]);
    res.json({ ok: true, taskA: infoA, taskB: infoB });
  } catch (err) {
    jsonError(res, 'Failed to load task info', err);
  }
});

/**
 * Build a token→{id, row, seq} map from a task's nodes.csv + source FASTA.
 * Returns { byToken: Map<string, { id, row, seq }>, refTokens: Set<string>, allRows: Array }
 */
async function loadTaskSequences(taskId) {
  const workDir = await resolveWorkDirByTaskId(taskId);

  // Load all FASTA sequences from the best available source
  const seqById = new Map();
  for (const fastaName of ['candidates_cdhit85.fasta', 'scored_passed.fasta']) {
    try {
      const text = await fs.readFile(path.join(workDir, fastaName), 'utf-8');
      for (const rec of parseFastaRecords(text)) {
        if (rec.id && rec.seq) seqById.set(rec.id, rec.seq);
      }
      break;
    } catch {}
  }

  // Also load reference sequences
  const refFasta = await resolveDefaultReferenceFasta(workDir);
  const refRecords = await loadReferenceRecords(refFasta);
  const refTokenSet = new Set();
  for (const rec of refRecords) {
    if (rec.id && rec.seq) seqById.set(rec.id, rec.seq);
    for (const t of normalizeIdTokens(rec.id)) refTokenSet.add(t);
  }

  // Load nodes.csv for taxonomy/cluster metadata
  let nodeRows = [];
  try {
    const { rows } = await readCsvRows(path.join(workDir, 'nodes.csv'));
    nodeRows = rows;
  } catch {}

  // Build token maps
  const byToken = new Map(); // token → { id, row, seq }
  const rowById = new Map();
  const rowByToken = new Map(); // token → row  (for fallback matching)
  for (const row of nodeRows) {
    rowById.set(row.id, row);
    for (const t of normalizeIdTokens(row.id)) {
      if (!rowByToken.has(t)) rowByToken.set(t, row);
    }
  }

  const allIds = new Set([...nodeRows.map(r => r.id), ...seqById.keys()]);
  for (const id of allIds) {
    const tokens = normalizeIdTokens(id);
    const seq = seqById.get(id) || '';
    // Exact match first, then token-based fallback (handles ref|WP_xxx| vs WP_xxx mismatch)
    let row = rowById.get(id) || null;
    if (!row) {
      for (const t of tokens) {
        const found = rowByToken.get(t);
        if (found) { row = found; break; }
      }
    }
    const entry = { id, row, seq };
    for (const t of tokens) {
      if (t.length >= 4 && !['ref', 'gb', 'emb', 'sp', 'tr', 'pdb', 'dbj', 'pir', 'prf', 'gnl', 'lcl'].includes(t.toLowerCase())) {
        if (!byToken.has(t)) byToken.set(t, entry);
      }
    }
  }

  return { byToken, refTokenSet, nodeRows, seqById, workDir };
}

/**
 * Find matching sequences between two tasks using token overlap.
 */
function matchSequences(dataA, dataB) {
  const matched = []; // { tokenKey, entryA, entryB }
  const usedA = new Set();
  const usedB = new Set();

  for (const [token, entryA] of dataA.byToken) {
    if (usedA.has(entryA.id)) continue;
    const entryB = dataB.byToken.get(token);
    if (entryB && !usedB.has(entryB.id)) {
      matched.push({ tokenKey: token, entryA, entryB });
      usedA.add(entryA.id);
      usedB.add(entryB.id);
    }
  }

  return matched;
}

route.post('/api/compare/intersect', async (req, res) => {
  try {
    const taskA = String(req.body?.taskA || '').trim();
    const taskB = String(req.body?.taskB || '').trim();
    const keepReferences = req.body?.keepReferences !== false;
    const targetTaskId = String(req.body?.targetTaskId || '').trim();

    if (!taskA || !taskB) {
      return res.status(400).json({ ok: false, message: 'taskA and taskB are required' });
    }
    if (!targetTaskId) {
      return res.status(400).json({ ok: false, message: 'targetTaskId is required' });
    }

    const [dataA, dataB] = await Promise.all([
      loadTaskSequences(taskA),
      loadTaskSequences(taskB),
    ]);

    const matched = matchSequences(dataA, dataB);

    // Build intersected collection
    const resultNodes = [];
    const resultSeqs = []; // { id, seq }
    const seenIds = new Set();

    // Process matched candidate sequences (exclude reference-only matches unless keepReferences)
    for (const { entryA, entryB } of matched) {
      const isRefA = dataA.refTokenSet.has(normalizeIdTokens(entryA.id).find(t => dataA.refTokenSet.has(t)) || '');
      const isRefB = dataB.refTokenSet.has(normalizeIdTokens(entryB.id).find(t => dataB.refTokenSet.has(t)) || '');
      const isRef = isRefA || isRefB;

      if (isRef && !keepReferences) continue;

      // Use entryA's ID as canonical
      const canonId = entryA.id;
      if (seenIds.has(canonId)) continue;
      seenIds.add(canonId);

      const row = entryA.row || entryB.row || {};
      const seq = entryA.seq || entryB.seq || '';
      if (!seq) continue;

      resultNodes.push({
        id: canonId,
        cluster: row.cluster || '',
        cluster_size: row.cluster_size || '',
        representative: row.representative || '0',
        is_reference: isRef ? '1' : '0',
        kingdom: row.kingdom || (entryB.row?.kingdom || ''),
        phylum: row.phylum || (entryB.row?.phylum || ''),
        class: row['class'] || (entryB.row?.['class'] || ''),
        species: row.species || (entryB.row?.species || ''),
        source_task: isRef ? 'reference' : 'both',
      });
      resultSeqs.push({ id: canonId, seq });
    }

    // If keepReferences, also add reference-only sequences that weren't in the intersection
    if (keepReferences) {
      for (const data of [dataA, dataB]) {
        for (const [token, entry] of data.byToken) {
          if (seenIds.has(entry.id)) continue;
          const isRef = data.refTokenSet.has(token) || normalizeIdTokens(entry.id).some(t => data.refTokenSet.has(t));
          if (!isRef) continue;
          seenIds.add(entry.id);
          const row = entry.row || {};
          const seq = entry.seq || '';
          if (!seq) continue;
          resultNodes.push({
            id: entry.id,
            cluster: '', cluster_size: '', representative: '1',
            is_reference: '1',
            kingdom: row.kingdom || '', phylum: row.phylum || '', class: row['class'] || '', order: row.order || '', family: row.family || '', genus: row.genus || '', species: row.species || '',
            source_task: 'reference',
          });
          resultSeqs.push({ id: entry.id, seq });
        }
      }
    }

    // Write results to target task directory
    const targetWorkDir = await resolveWorkDirByTaskId(targetTaskId);

    // Write task.json
    const metaPath = path.join(targetWorkDir, 'task.json');
    try { await fs.access(metaPath); } catch {
      await fs.writeFile(metaPath, JSON.stringify({
        id: targetTaskId, createdAt: Date.now(), name: targetTaskId, module: 'compare', note: '',
      }, null, 2), 'utf-8');
    }

    // Write FASTA
    const fastaPath = path.join(targetWorkDir, 'merged_sequences.fasta');
    const fastaContent = resultSeqs.map(r => `>${r.id}\n${r.seq}`).join('\n') + '\n';
    await fs.writeFile(fastaPath, fastaContent, 'utf-8');

    // Write reference FASTA (only ref sequences)
    const refSeqs = resultSeqs.filter((_, i) => resultNodes[i]?.is_reference === '1');
    if (refSeqs.length) {
      const refPath = path.join(targetWorkDir, 'ref.fasta');
      await fs.writeFile(refPath, refSeqs.map(r => `>${r.id}\n${r.seq}`).join('\n') + '\n', 'utf-8');
    }

    // Write nodes.csv
    const nodesPath = path.join(targetWorkDir, 'nodes.csv');
    if (resultNodes.length) {
      const nodesHeaders = ['id', 'cluster', 'cluster_size', 'representative', 'is_reference', 'kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species', 'source_task'];
      await writeCsvRows(nodesPath, nodesHeaders, resultNodes);
    }

    // Remove old edges so user has to recompute
    await fs.rm(path.join(targetWorkDir, 'edges_similarity.csv'), { force: true }).catch(() => {});

    // Persist compare state so it can be restored on hydrate
    const compareResultState = {
      ok: true, targetTaskId, operation: 'intersect', taskA, taskB, keepReferences,
      totalSequences: resultSeqs.length,
      candidateCount: resultNodes.filter(r => r.is_reference !== '1').length,
      referenceCount: resultNodes.filter(r => r.is_reference === '1').length,
      matchedPairs: matched.length,
    };
    await writePipelineState(targetWorkDir, { taskAId: taskA, taskBId: taskB, keepReferences, compareResult: compareResultState }, 'compare');

    res.json(compareResultState);
  } catch (err) {
    jsonError(res, 'Failed to intersect networks', err);
  }
});

route.post('/api/compare/merge', async (req, res) => {
  try {
    const taskA = String(req.body?.taskA || '').trim();
    const taskB = String(req.body?.taskB || '').trim();
    const keepReferences = req.body?.keepReferences !== false;
    const targetTaskId = String(req.body?.targetTaskId || '').trim();

    if (!taskA || !taskB) {
      return res.status(400).json({ ok: false, message: 'taskA and taskB are required' });
    }
    if (!targetTaskId) {
      return res.status(400).json({ ok: false, message: 'targetTaskId is required' });
    }

    const [dataA, dataB] = await Promise.all([
      loadTaskSequences(taskA),
      loadTaskSequences(taskB),
    ]);

    // Find matches for dedup
    const matched = matchSequences(dataA, dataB);
    const matchedIdA = new Set(matched.map(m => m.entryA.id));
    const matchedIdB = new Set(matched.map(m => m.entryB.id));

    const resultNodes = [];
    const resultSeqs = [];
    const seenIds = new Set();

    const addEntry = (entry, data, sourceLabel, isMatchedBoth) => {
      if (seenIds.has(entry.id)) return;
      const isRef = normalizeIdTokens(entry.id).some(t => data.refTokenSet.has(t));
      if (isRef && !keepReferences) return;

      seenIds.add(entry.id);
      const row = entry.row || {};
      const seq = entry.seq || '';
      if (!seq) return;

      resultNodes.push({
        id: entry.id,
        cluster: row.cluster || '', cluster_size: row.cluster_size || '', representative: row.representative || '0',
        is_reference: isRef ? '1' : '0',
        kingdom: row.kingdom || '', phylum: row.phylum || '', class: row['class'] || '', order: row.order || '', family: row.family || '', genus: row.genus || '', species: row.species || '',
        source_task: isRef ? 'reference' : isMatchedBoth ? 'both' : sourceLabel,
      });
      resultSeqs.push({ id: entry.id, seq });
    };

    // Add matched sequences (mark as 'both')
    for (const { entryA, entryB } of matched) {
      const mergedEntry = {
        id: entryA.id,
        row: { ...(entryB.row || {}), ...(entryA.row || {}) },
        seq: entryA.seq || entryB.seq,
      };
      addEntry(mergedEntry, dataA, '', true);
    }

    // Add remaining sequences from A
    for (const [, entry] of dataA.byToken) {
      if (matchedIdA.has(entry.id)) continue;
      addEntry(entry, dataA, taskA, false);
    }

    // Add remaining sequences from B
    for (const [, entry] of dataB.byToken) {
      if (matchedIdB.has(entry.id)) continue;
      addEntry(entry, dataB, taskB, false);
    }

    // Write to target task
    const targetWorkDir = await resolveWorkDirByTaskId(targetTaskId);

    const metaPath = path.join(targetWorkDir, 'task.json');
    try { await fs.access(metaPath); } catch {
      await fs.writeFile(metaPath, JSON.stringify({
        id: targetTaskId, createdAt: Date.now(), name: targetTaskId, module: 'compare', note: '',
      }, null, 2), 'utf-8');
    }

    const fastaPath = path.join(targetWorkDir, 'merged_sequences.fasta');
    await fs.writeFile(fastaPath, resultSeqs.map(r => `>${r.id}\n${r.seq}`).join('\n') + '\n', 'utf-8');

    const refSeqs = resultSeqs.filter((_, i) => resultNodes[i]?.is_reference === '1');
    if (refSeqs.length) {
      await fs.writeFile(path.join(targetWorkDir, 'ref.fasta'), refSeqs.map(r => `>${r.id}\n${r.seq}`).join('\n') + '\n', 'utf-8');
    }

    const nodesPath = path.join(targetWorkDir, 'nodes.csv');
    if (resultNodes.length) {
      const nodesHeaders = ['id', 'cluster', 'cluster_size', 'representative', 'is_reference', 'kingdom', 'phylum', 'class', 'order', 'family', 'genus', 'species', 'source_task'];
      await writeCsvRows(nodesPath, nodesHeaders, resultNodes);
    }

    await fs.rm(path.join(targetWorkDir, 'edges_similarity.csv'), { force: true }).catch(() => {});

    // Persist compare state for hydrate
    const compareResultState = {
      ok: true, targetTaskId, operation: 'merge', taskA, taskB, keepReferences,
      totalSequences: resultSeqs.length,
      candidateCount: resultNodes.filter(r => r.is_reference !== '1').length,
      referenceCount: resultNodes.filter(r => r.is_reference === '1').length,
      matchedPairs: matched.length,
      uniqueToA: resultNodes.filter(r => r.source_task === taskA).length,
      uniqueToB: resultNodes.filter(r => r.source_task === taskB).length,
      inBoth: resultNodes.filter(r => r.source_task === 'both').length,
    };
    await writePipelineState(targetWorkDir, { taskAId: taskA, taskBId: taskB, keepReferences, compareResult: compareResultState }, 'compare');

    res.json(compareResultState);
  } catch (err) {
    jsonError(res, 'Failed to merge networks', err);
  }
});

app.use((err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = Number.isInteger(err?.status) ? err.status : 500;
  const message = status >= 500 ? 'Internal server error' : String(err?.message || 'Bad request');
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({
    ok: false,
    message,
    ...(process.env.NODE_ENV === 'development' && status >= 500
      ? { details: String(err?.stack || err) }
      : {}),
  });
});

function startServer({ host = apiHost, port = apiPort } = {}) {
  const server = app.listen(port, host, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    console.log(`EnzymeMiner backend API listening on http://${host}:${boundPort}`);
    console.log(`pipelineRoot=${pipelineRoot}`);
    console.log(`defaultWorkDir=${defaultWorkDir}`);
    console.log(`tasksRoot=${tasksRoot}`);
  });
  return server;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMainModule) {
  startServer();
}

export { app, startServer };
