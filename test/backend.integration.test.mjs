import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'enzymeminer-test-'));
const tasksRoot = path.join(tempRoot, 'tasks');
await fs.mkdir(tasksRoot, { recursive: true });

const fakeStats = {
  cataProBatches: [],
  solubilityBatches: [],
  ecBatches: [],
  tmItems: 0,
  legacyPredictCalls: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fakePredictor = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/docs')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = body ? JSON.parse(body) : null;
  res.setHeader('content-type', 'application/json');

  if (req.url === '/catapro/predict/batch' && req.method === 'POST') {
    fakeStats.cataProBatches.push(payload.map((item) => item.id));
    await sleep(80);
    const results = payload.map((item, index) => {
      // A has higher kcat but lower kcat/Km than the other test sequences.
      const prediction = String(item.sequence).startsWith('A')
        ? { kcat_value: 100, km_value: 100 }
        : { kcat_value: 10, km_value: 1 };
      return { index, status: 'success', fasta_id: `${item.id}_wild`, ...prediction };
    });
    res.end(JSON.stringify({
      batch_size: payload.length,
      success_count: results.length,
      error_count: 0,
      execution_time: 0.08,
      results,
    }));
    return;
  }

  if (req.url === '/sol/predict/batch' && req.method === 'POST') {
    fakeStats.solubilityBatches.push(payload.map((item) => item.name));
    await sleep(80);
    const results = payload.map((item, index) => String(item.sequence).startsWith('X')
      ? { index, status: 'error', enzyme_name: item.name, message: 'invalid test sequence' }
      : {
          index,
          status: 'success',
          enzyme_name: item.name,
          prediction: 'Soluble',
          score: 0.75 + index * 0.01,
        });
    res.end(JSON.stringify({
      batch_size: payload.length,
      success_count: results.filter((item) => item.status === 'success').length,
      error_count: results.filter((item) => item.status === 'error').length,
      execution_time: 0.08,
      results,
    }));
    return;
  }

  if (req.url === '/ec/predict/batch' && req.method === 'POST') {
    fakeStats.ecBatches.push(payload.map((item) => item.name));
    await sleep(80);
    const results = payload.map((item, index) => ({
      index,
      enzyme_name: item.name,
      status: 'success',
      results: [{ ec: `1.1.1.${index + 1}`, score: 0.9 - index * 0.01 }],
    }));
    res.end(JSON.stringify({
      batch_size: payload.length,
      success_count: results.length,
      error_count: 0,
      execution_time: 0.08,
      results,
    }));
    return;
  }

  if (req.url === '/tm/predict' && req.method === 'POST') {
    fakeStats.tmItems++;
    await sleep(35);
    res.end(JSON.stringify({ result: { prediction: { Tm: 71.5 } } }));
    return;
  }

  if (req.url?.endsWith('/predict') && req.method === 'POST') {
    fakeStats.legacyPredictCalls++;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ message: 'not found' }));
});

await new Promise((resolve, reject) => {
  fakePredictor.once('error', reject);
  fakePredictor.listen(0, '127.0.0.1', resolve);
});
const fakeAddress = fakePredictor.address();
assert.equal(typeof fakeAddress, 'object');
const fakeUrl = `http://127.0.0.1:${fakeAddress.port}`;

process.env.PIPELINE_ROOT = tempRoot;
process.env.PIPELINE_TASKS_ROOT = tasksRoot;
process.env.CATAPRO_URL = `${fakeUrl}/catapro`;
process.env.SOL_URL = `${fakeUrl}/sol`;
process.env.EC_URL = `${fakeUrl}/ec`;
process.env.TM_URL = `${fakeUrl}/tm`;
process.env.PREDICTION_BATCH_SIZE = '2';
process.env.PREDICTION_REQUEST_TIMEOUT_MS = '5000';
process.env.API_KEY = '';
process.env.ALLOWED_ORIGINS = '';

const { startServer } = await import('../backend/server.mjs');
let backend;
let baseUrl;

before(async () => {
  backend = startServer({ host: '127.0.0.1', port: 0 });
  if (!backend.listening) {
    await new Promise((resolve, reject) => {
      backend.once('listening', resolve);
      backend.once('error', reject);
    });
  }
  const address = backend.address();
  assert.equal(typeof address, 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await Promise.all([
    new Promise((resolve) => backend?.close(resolve)),
    new Promise((resolve) => fakePredictor.close(resolve)),
  ]);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function api(relativeUrl, init) {
  const response = await fetch(`${baseUrl}${relativeUrl}`, init);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { response, body };
}

test('invalid async task ids return 400 without terminating the server', async () => {
  const invalid = await api('/api/network/predict-metrics?taskId=../../oops', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(invalid.response.status, 400);

  const health = await api('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(typeof health.body.tools.mmseqs, 'boolean');
  assert.deepEqual(Object.keys(health.body.pythonPackages).sort(), ['biopython', 'pandas', 'requests', 'tqdm']);

  const allowedOrigin = await fetch(`${baseUrl}/api/health`, { headers: { origin: 'http://localhost:3000' } });
  assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  const blockedOrigin = await fetch(`${baseUrl}/api/health`, { headers: { origin: 'http://evil.example' } });
  assert.equal(blockedOrigin.headers.get('access-control-allow-origin'), null);
});

test('artifact, compare-task, and HMM prefix traversal attempts are rejected', async () => {
  const taskDir = path.join(tasksRoot, 'security-task');
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, 'scored_results.csv'), 'id,score\nvalid,1\n');
  const secretPath = path.join(tempRoot, '.env.example');
  await fs.writeFile(secretPath, 'SECRET=should-not-be-readable\n');

  const blockedDownload = await api(`/api/scoring/download?taskId=security-task&csv=${encodeURIComponent(secretPath)}`);
  assert.equal(blockedDownload.response.status, 400);
  assert.doesNotMatch(JSON.stringify(blockedDownload.body), /should-not-be-readable/);

  const validDownload = await api('/api/scoring/download?taskId=security-task');
  assert.equal(validDownload.response.status, 200);
  assert.match(validDownload.body, /valid,1/);

  const compare = await api('/api/compare/task-info?taskA=../../outside&taskB=security-task');
  assert.equal(compare.response.status, 400);

  const outsidePrefix = path.join(tempRoot, 'outside');
  const hmm = await api('/api/hmm/build?taskId=security-task', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefix: '../../outside' }),
  });
  assert.equal(hmm.response.status, 400);
  await assert.rejects(fs.access(outsidePrefix));
});

test('prediction uses kcat/Km, calls real Tm, and invalidates cache context', async () => {
  const taskDir = path.join(tasksRoot, 'prediction-task');
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, 'nodes.csv'), 'id,is_reference\ncandA,0\ncandB,0\n');
  await fs.writeFile(path.join(taskDir, 'candidates.fasta'), '>candA\nAAAAAAAAAA\n>candB\nCCCCCCCCCC\n');

  const requestPrediction = (smiles) => api('/api/network/predict-metrics?taskId=prediction-task', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ smiles, subWeights: { kcat: 1, solubility: 0, tm: 0 } }),
  });

  const first = await requestPrediction('CCO');
  assert.equal(first.response.status, 200);
  assert.equal(first.body.recomputedCount, 2);
  assert.equal(first.body.services.cataPro, true);
  assert.equal(first.body.services.tm, true);
  assert.equal(first.body.services.solubility, true);
  assert.equal(first.body.services.ec, true);
  assert.equal(first.body.rows[0].id, 'candB');
  assert.equal(first.body.rows[0].catalyticEfficiency, 10);
  assert.equal(first.body.rows[1].catalyticEfficiency, 1);
  assert.equal(first.body.rows[0].tm, 71.5);
  assert.equal(first.body.rows[0].sources.tm, 'real');
  assert.equal(first.body.rows[0].sources.cataPro, 'real');
  assert.equal(first.body.rows[0].sources.solubility, 'real');
  assert.equal(first.body.rows[0].sources.ec, 'real');

  const cached = await requestPrediction('CCO');
  assert.equal(cached.body.recomputedCount, 0);

  const changedSmiles = await requestPrediction('CCC');
  assert.equal(changedSmiles.body.recomputedCount, 2);

  await fs.writeFile(path.join(taskDir, 'candidates.fasta'), '>candA\nAAAAAAAAAAA\n>candB\nCCCCCCCCCC\n');
  const changedSequence = await requestPrediction('CCC');
  assert.equal(changedSequence.body.recomputedCount, 2);

  const meta = JSON.parse(await fs.readFile(path.join(taskDir, 'predicted_metrics.meta.json'), 'utf-8'));
  assert.equal(meta.version, 2);
  assert.equal(meta.smiles, 'CCC');
  assert.equal(meta.predictors.tm.mode, 'real');
  assert.equal(fakeStats.legacyPredictCalls, 0);
  assert.match(meta.fingerprint, /^[a-f0-9]{64}$/);
});

test('prediction batches requests, reports real progress and ETA, and falls back per invalid item', async () => {
  const taskId = 'batch-progress-task';
  const taskDir = path.join(tasksRoot, taskId);
  await fs.mkdir(taskDir, { recursive: true });
  const ids = ['batchA', 'batchB', 'batchC', 'batchD', 'batchX'];
  await fs.writeFile(
    path.join(taskDir, 'nodes.csv'),
    `id,is_reference\n${ids.map((id) => `${id},0`).join('\n')}\n`,
  );
  await fs.writeFile(
    path.join(taskDir, 'candidates.fasta'),
    ids.map((id, index) => `>${id}\n${index === ids.length - 1 ? 'XXXXXXXXXX' : `${'C'.repeat(9)}${index}`}`).join('\n'),
  );

  const cataStart = fakeStats.cataProBatches.length;
  const solStart = fakeStats.solubilityBatches.length;
  const ecStart = fakeStats.ecBatches.length;
  const requestPromise = api(`/api/network/predict-metrics?taskId=${taskId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ smiles: 'CCO' }),
  });

  const samples = [];
  let responseResult = null;
  while (!responseResult) {
    const race = await Promise.race([
      requestPromise.then((value) => ({ type: 'response', value })),
      sleep(15).then(() => ({ type: 'poll' })),
    ]);
    const runtime = await api(`/api/runtime/logs?taskId=${taskId}&limit=20`);
    if (runtime.body.meta?.predictProgress) samples.push(runtime.body.meta.predictProgress);
    if (race.type === 'response') responseResult = race.value;
  }

  assert.equal(responseResult.response.status, 200);
  assert.equal(responseResult.body.recomputedCount, ids.length);
  assert.deepEqual(fakeStats.cataProBatches.slice(cataStart).map((batch) => batch.length), [2, 2, 1]);
  assert.deepEqual(fakeStats.solubilityBatches.slice(solStart).map((batch) => batch.length), [2, 2, 1]);
  assert.deepEqual(fakeStats.ecBatches.slice(ecStart).map((batch) => batch.length), [2, 2, 1]);
  assert.equal(fakeStats.legacyPredictCalls, 0);

  const invalidSolRow = responseResult.body.rows.find((row) => row.id === 'batchX');
  assert.equal(invalidSolRow.sources.solubility, 'mock');
  assert.equal(invalidSolRow.sources.cataPro, 'real');
  assert.equal(invalidSolRow.sources.ec, 'real');

  assert.ok(samples.some((sample) => sample.current > 0 && sample.current < sample.total));
  assert.ok(samples.some((sample) => Number.isFinite(sample.estimatedRemainingMs) && sample.estimatedRemainingMs > 0));
  for (let index = 1; index < samples.length; index++) {
    assert.ok(samples[index].current >= samples[index - 1].current, 'prediction progress must be monotonic');
    assert.ok(samples[index].current <= samples[index].total);
  }
  const finalProgress = samples.at(-1);
  assert.equal(finalProgress.done, true);
  assert.equal(finalProgress.current, ids.length * 4);
  assert.equal(finalProgress.total, ids.length * 4);
  assert.equal(finalProgress.estimatedRemainingMs, 0);
  assert.equal(finalProgress.predictors.cataPro.completedBatches, 3);
  assert.equal(finalProgress.predictors.solubility.completedBatches, 3);
  assert.equal(finalProgress.predictors.ec.completedBatches, 3);
  assert.equal(finalProgress.predictors.tm.completedBatches, ids.length);
});

