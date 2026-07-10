import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Database,
  Filter,
  FlaskConical,
  GitCompareArrows,
  List,
  Moon,
  Network,
  Play,
  Search,
  Settings,
  Star,
  Sun,
} from 'lucide-react';

import {
  buildHmm,
  clearRuntimeLogs,
  computeRefPairwiseIdentity,
  createTask,
  duplicateTask,
  deleteTask,
  fetchReferences,
  importReferenceFasta,
  filterHitsByTargets,
  filterHits,
  healthCheck,
  listTasks,
  loadReferencePreview,
  loadCdhitPreview,
  monitorEbiHmmSearch,
  loadSearchPage,
  loadRuntimeLogs,
  loadNetworkData,
  computeNetworkSimilarity,
  loadNetworkSimilarityStatus,
  pushNetworkToCytoscape,
  fetchBrowserGraphData,
  recommendCandidates,
  exportRecommendedFasta,
  predictNetworkMetrics,
  loadPipelineState,
  loadTaskArtifacts,
  downloadEbiHmmSearchResults,
  fillUniProt,
  retryFailedEbiPages,
  runSearchConsistencyCheck,
  runClustering,
  runHmmSearch,
  runScoring,
  prepareScoringAlignment,
  loadScoringAlignmentPreview,
  downloadScoringCsv,
  previewScoringThreshold,
  savePipelineState,
  setActiveTaskId,
  buildBlastDb,
  runBlastSearch,
  filterBlastHits,
  loadBlastSearchPage,
  annotateBlastHits,
  loadCompareTaskInfo,
  compareIntersect,
  compareMerge,
} from './api';
import type { BlastDbSource, BlastMergeStrategy, CompareTaskInfo, CompareResult, PreAlignmentAnchor, ScoringPositionMode, ScoringRule, RecommendCandidate, RecommendWeights, PredictedSubWeights, PredictedMetricsRow, BrowserGraphNode, BrowserGraphEdge } from './api';
import NetworkGraph from './NetworkGraph';

type View = 'dashboard' | 'reference' | 'hmm-build' | 'search-filter' | 'alignment' | 'scoring' | 'clustering' | 'similarity' | 'network' | 'recommendation';
type BlastView = 'dashboard' | 'reference' | 'blast-db' | 'blast-search' | 'alignment' | 'scoring' | 'clustering' | 'similarity' | 'network' | 'recommendation';
type PipelineStepKey = 'reference' | 'hmm' | 'search' | 'alignment' | 'scoring' | 'clustering' | 'similarity' | 'network-push' | 'recommendation';
type BlastPipelineStepKey = 'reference' | 'blast-db' | 'blast-search' | 'alignment' | 'scoring' | 'clustering' | 'similarity' | 'network-push' | 'recommendation';
type StepStatus = 'idle' | 'running' | 'success' | 'error';
type EbiSubStepKey = 'submit' | 'download' | 'enrich';

type JobState = {
  loading: boolean;
  message: string;
  error: string;
};

type StepMetrics = {
  runs: number;
  success: number;
  fail: number;
  totalMs: number;
  retries: number;
  lastMs: number;
  lastAttempts: number;
};

type TaskBrief = {
  id: string;
  workDir: string;
  module: string | null;
  name: string;
  createdAt: number;
  updatedAt: number;
};

type EbiSubStepState = Record<EbiSubStepKey, StepStatus>;

const initialEbiSubStepState: EbiSubStepState = {
  submit: 'idle',
  download: 'idle',
  enrich: 'idle',
};

const pipelineSteps: Array<{ key: PipelineStepKey; title: string }> = [
  { key: 'reference', title: '1. Reference' },
  { key: 'hmm', title: '2. HMM Build' },
  { key: 'search', title: '3. Search & Filter' },
  { key: 'alignment', title: '4. Alignment' },
  { key: 'scoring', title: '5. Scoring' },
  { key: 'clustering', title: '6. Clustering' },
  { key: 'similarity', title: '7. Similarity' },
];

const initialStepState: Record<PipelineStepKey, StepStatus> = {
  reference: 'idle',
  hmm: 'idle',
  search: 'idle',
  alignment: 'idle',
  scoring: 'idle',
  clustering: 'idle',
  similarity: 'idle',
  'network-push': 'idle',
  recommendation: 'idle',
};

const initialMetrics: Record<PipelineStepKey, StepMetrics> = {
  reference: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  hmm: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  search: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  alignment: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  scoring: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  clustering: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  similarity: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  'network-push': { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  recommendation: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
};

// ===== BLAST Pipeline Definitions =====

const blastPipelineSteps: Array<{ key: BlastPipelineStepKey; title: string }> = [
  { key: 'reference', title: '1. Reference' },
  { key: 'blast-db', title: '2. BLAST DB Setup' },
  { key: 'blast-search', title: '3. BLAST Search & Filter' },
  { key: 'alignment', title: '4. Alignment' },
  { key: 'scoring', title: '5. Scoring' },
  { key: 'clustering', title: '6. Clustering' },
  { key: 'similarity', title: '7. Similarity' },
];

const initialBlastStepState: Record<BlastPipelineStepKey, StepStatus> = {
  reference: 'idle',
  'blast-db': 'idle',
  'blast-search': 'idle',
  alignment: 'idle',
  scoring: 'idle',
  clustering: 'idle',
  similarity: 'idle',
  'network-push': 'idle',
  recommendation: 'idle',
};

const initialBlastMetrics: Record<BlastPipelineStepKey, StepMetrics> = {
  reference: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  'blast-db': { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  'blast-search': { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  alignment: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  scoring: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  clustering: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  similarity: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  'network-push': { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
  recommendation: { runs: 0, success: 0, fail: 0, totalMs: 0, retries: 0, lastMs: 0, lastAttempts: 0 },
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const accessionPlaceholder = ['e.g.: ', 'AAC72747.1', 'KDQ24956.1', '9AVH_A', 'MF540777', 'P46881'].join('\n');

const MAX_REFERENCE_FASTA_UPLOAD_BYTES = 20 * 1024 * 1024;

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function formatDurationMs(ms: number) {
  const totalSec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

function formatRuntimeDurationLabel(startedAt: number | null | undefined, updatedAt: number | null | undefined, active: boolean) {
  const start = Number(startedAt);
  if (!Number.isFinite(start) || start <= 0) {
    return '';
  }
  const finish = active ? Date.now() : Number(updatedAt);
  const end = Number.isFinite(finish) && finish >= start ? finish : Date.now();
  return formatDurationMs(end - start);
}

function validateReferenceFastaUpload(file: File | null) {
  if (!file) {
    throw new Error('Please select a FASTA file first');
  }
  if (!/\.(fasta|fa|faa|fas|fna|txt)$/i.test(file.name)) {
    throw new Error('Only .fasta, .fa, .faa, .fas, .fna, or .txt files are supported');
  }
  if (file.size <= 0) {
    throw new Error('The selected file is empty');
  }
  if (file.size > MAX_REFERENCE_FASTA_UPLOAD_BYTES) {
    throw new Error(`File too large, current limit is ${formatFileSize(MAX_REFERENCE_FASTA_UPLOAD_BYTES)}`);
  }
  return file;
}

function validateReferenceFastaText(text: string) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('>')) {
    throw new Error('Invalid FASTA file format: content must start with >');
  }
  return trimmed;
}

function defaultTaskReferenceFasta(taskId: string) {
  return `/home/threo/aox_project/aox_tasks/${taskId}/ref.fasta`;
}

const peAaoScoringRules: ScoringRule[] = [
  { pos: 36, allowed: ['G'], score: 1, label: 'M1_36_G' },
  { pos: 38, allowed: ['G'], score: 1, label: 'M1_38_G' },
  { pos: 41, allowed: ['G', 'A'], score: 1, label: 'M1_41_GA' },
  { pos: 45, allowed: ['A'], score: 1, label: 'M1_45_A' },
  { pos: 47, allowed: ['R'], score: 1, label: 'M1_47_R' },
  { pos: 108, allowed: ['G', 'A'], score: 1, label: 'M2_108_GA' },
  { pos: 109, allowed: ['R', 'K', 'Q', 'N'], score: 1, label: 'M2_109_RKQN' },
  { pos: 111, allowed: ['L', 'V'], score: 1, label: 'M2_111_LV' },
  { pos: 112, allowed: ['G'], score: 1, label: 'M2_112_G' },
  { pos: 113, allowed: ['G'], score: 1, label: 'M2_113_G' },
  { pos: 114, allowed: ['S', 'G', 'T'], score: 1, label: 'M2_114_SGT' },
  { pos: 115, allowed: ['S', 'G', 'T'], score: 1, label: 'M2_115_SGT' },
  { pos: 118, allowed: ['N', 'H'], score: 1, label: 'M2_118_NH' },
  { pos: 295, allowed: ['V', 'I', 'L'], score: 1, label: 'M3_295_VIL' },
  { pos: 299, allowed: ['A', 'G', 'S'], score: 1, label: 'M3_299_AGS' },
  { pos: 300, allowed: ['G'], score: 1, label: 'M3_300_G' },
  { pos: 304, allowed: ['S', 'T'], score: 1, label: 'M3_304_ST' },
  { pos: 305, allowed: ['P', 'A'], score: 1, label: 'M3_305_PA' },
  { pos: 308, allowed: ['L', 'I'], score: 1, label: 'M3_308_LI' },
  { pos: 311, allowed: ['S'], score: 1, label: 'M3_311_S' },
  { pos: 312, allowed: ['G'], score: 1, label: 'M3_312_G' },
  { pos: 313, allowed: ['I', 'V'], score: 1, label: 'M3_313_IV' },
  { pos: 314, allowed: ['G'], score: 1, label: 'M3_314_G' },
  { pos: 340, allowed: ['H'], score: 2, label: 'M3_340_H' },
  { pos: 529, allowed: ['H'], score: 4, label: 'CAT_529_H' },
  { pos: 545, allowed: ['V', 'A'], score: 1, label: 'M4_545_VA' },
  { pos: 547, allowed: ['D', 'G'], score: 1, label: 'M4_547_DG' },
  { pos: 552, allowed: ['V', 'L', 'I'], score: 1, label: 'M4_552_VLI' },
  { pos: 554, allowed: ['G'], score: 1, label: 'M4_554_G' },
  { pos: 557, allowed: ['G', 'N', 'A', 'R'], score: 1, label: 'M4_557_GNAR' },
  { pos: 559, allowed: ['R', 'K'], score: 1, label: 'M4_559_RK' },
  { pos: 560, allowed: ['V', 'I'], score: 1, label: 'M4_560_VI' },
  { pos: 564, allowed: ['S', 'A'], score: 1, label: 'M4_564_SA' },
  { pos: 573, allowed: ['H'], score: 3, label: 'CAT_573_H' },
  { pos: 583, allowed: ['K', 'E'], score: 2, label: 'M4_583_KE' },
];

const legacyRuleLabels = new Set([
  'FAD_13_G',
  'FAD_15_G',
  'FAD_18_G',
  'Sub_98_FWY',
  'Sub_417_FWY',
  'Sub_566_FWY',
  'Cat_567_H',
  'Cat_616_HNP',
  'PTS_660',
  'PTS_661',
  'PTS_662',
  'PTS_663',
]);

function clonePeAaoScoringRules(): ScoringRule[] {
  return peAaoScoringRules.map((r) => ({ ...r, allowed: [...r.allowed] }));
}

function looksLikeLegacyScoringRules(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length !== 12) {
    return false;
  }
  try {
    const labels = raw.map((x) => String((x as any)?.label ?? ''));
    return labels.every((label) => legacyRuleLabels.has(label));
  } catch {
    return false;
  }
}

function parseScoringRulesInput(raw: unknown): ScoringRule[] {
  const parsed = raw;

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Rules must be a non-empty array');
  }

  return parsed.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Rule #${idx + 1} must be an object`);
    }
    const rule = item as Record<string, unknown>;

    const pos = Number(rule.pos);
    if (!Number.isInteger(pos) || pos <= 0) {
      throw new Error(`Rule #${idx + 1} has an invalid pos`);
    }

    const score = Number(rule.score);
    if (!Number.isFinite(score)) {
      throw new Error(`Rule #${idx + 1} has an invalid score`);
    }

    const label = String(rule.label ?? '').trim();
    if (!label) {
      throw new Error(`Rule #${idx + 1} label cannot be empty`);
    }

    if (!Array.isArray(rule.allowed) || rule.allowed.length === 0) {
      throw new Error(`Rule #${idx + 1} allowed must be a non-empty array`);
    }

    const allowed = Array.from(
      new Set(
        rule.allowed
          .map((x) => String(x ?? '').trim())
          .filter(Boolean)
          .map((x) => (x.toUpperCase() === 'UNI' ? 'Uni' : x.toUpperCase())),
      ),
    );
    if (!allowed.length) {
      throw new Error(`Rule #${idx + 1} allowed cannot be empty`);
    }

    return { pos, score, label, allowed };
  });
}

function parseAllowedInput(raw: string): string[] {
  return Array.from(
    new Set(
      String(raw ?? '')
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => (x.toUpperCase() === 'UNI' ? 'Uni' : x.toUpperCase())),
    ),
  );
}

const CHART_M = { top: 14, right: 20, bottom: 52, left: 64 } as const;
function niceTickValues(min: number, max: number, maxTicks = 8): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  const range = max - min;
  if (range <= 0) return [min];
  const rawStep = range / Math.max(1, maxTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const r = rawStep / mag;
  const step = r <= 1.5 ? mag : r <= 3 ? 2 * mag : r <= 7 ? 5 * mag : 10 * mag;
  const first = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = first; v <= max + step * 0.001; v += step) {
    ticks.push(+(v.toPrecision(12)));
    if (ticks.length > 50) break;
  }
  return ticks;
}

function isLikelyErrorLogLine(line: string): boolean {
  const text = String(line || '');
  const lower = text.toLowerCase();
  if (/\b(traceback|exception|fatal)\b/.test(lower)) {
    return true;
  }
  if (/\b(error|failed)\b/.test(lower) && !/\b0\s+failed\b/.test(lower)) {
    return true;
  }
  if (/\[stderr\]/i.test(text)) {
    return /\b(traceback|exception|fatal|error|failed)\b/.test(lower) && !/\b0\s+failed\b/.test(lower);
  }
  return false;
}

// ── Multi-segment weight bar component ──
const WEIGHT_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899']; // indigo, sky, emerald, violet, amber, pink
const DEFAULT_WEIGHTS: RecommendWeights = { avgRefSimilarity: 0.28, maxRefSimilarity: 0.2, clusterSize: 0.12, networkComponentSize: 0.12, taxonomyDiversity: 0.08, predictedScore: 0.2 };
const WEIGHT_LABELS: { key: keyof RecommendWeights; label: string }[] = [
  { key: 'avgRefSimilarity', label: 'Avg Ref Sim' },
  { key: 'maxRefSimilarity', label: 'Max Ref Sim' },
  { key: 'clusterSize', label: 'Cluster Size' },
  { key: 'networkComponentSize', label: 'Net Comp Size' },
  { key: 'taxonomyDiversity', label: 'Tax Diversity' },
  { key: 'predictedScore', label: 'Predicted Score' },
];

const DEFAULT_PREDICTED_SUB_WEIGHTS: PredictedSubWeights = { kcat: 1 / 3, solubility: 1 / 3, tm: 1 / 3 };
const PREDICTED_SUB_WEIGHT_LABELS: { key: keyof PredictedSubWeights; label: string }[] = [
  { key: 'kcat', label: 'kcat' },
  { key: 'solubility', label: 'Solubility' },
  { key: 'tm', label: 'Tm' },
];

function normalizeSavedRecommendResults(results: unknown, topN: unknown): { results: RecommendCandidate[] | null; stale: boolean } {
  if (!Array.isArray(results)) {
    return { results: null, stale: false };
  }
  const normalizedTopN = Number(topN);
  if (Number.isFinite(normalizedTopN) && normalizedTopN > 0 && results.length > normalizedTopN) {
    return { results: [], stale: true };
  }
  return { results: results as RecommendCandidate[], stale: false };
}

// Generic normalizer: given a partial weights record, a set of keys, and defaults,
// clamps to >= 0 and rescales so the values sum to 1.
function normalizeWeightRecord<K extends string>(
  raw: unknown,
  keys: readonly K[],
  defaults: Record<K, number>,
): Record<K, number> {
  if (!raw || typeof raw !== 'object') {
    return { ...defaults };
  }
  const rawRecord = raw as Partial<Record<K, unknown>>;
  const parsed = {} as Record<K, number>;
  for (const key of keys) {
    const v = Number(rawRecord[key]);
    parsed[key] = Number.isFinite(v) ? Math.max(0, v) : 0;
  }
  const total = keys.reduce((s, k) => s + parsed[k], 0);
  if (!Number.isFinite(total) || total <= 0) {
    return { ...defaults };
  }
  const out = {} as Record<K, number>;
  for (const key of keys) {
    out[key] = parsed[key] / total;
  }
  return out;
}

function normalizeRecommendWeights(weights: unknown): RecommendWeights {
  return normalizeWeightRecord(
    weights,
    WEIGHT_LABELS.map((w) => w.key),
    DEFAULT_WEIGHTS,
  ) as RecommendWeights;
}

function normalizePredictedSubWeights(weights: unknown): PredictedSubWeights {
  return normalizeWeightRecord(
    weights,
    PREDICTED_SUB_WEIGHT_LABELS.map((w) => w.key),
    DEFAULT_PREDICTED_SUB_WEIGHTS,
  ) as PredictedSubWeights;
}

// Generic N-segment draggable weight bar. Works for both the 6-way recommendation
// weights and the 3-way predicted-metric sub-weights.
function WeightBar<K extends string>({
  weights,
  onChange,
  labels,
  colors,
  defaults,
}: {
  weights: Record<K, number>;
  onChange: (w: Record<K, number>) => void;
  labels: { key: K; label: string }[];
  colors?: string[];
  defaults: Record<K, number>;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const keys = useMemo(() => labels.map((l) => l.key), [labels]);
  const palette = colors || WEIGHT_COLORS;

  const normalizedWeights = useMemo(() => normalizeWeightRecord(weights, keys, defaults), [weights, keys, defaults]);
  const vals = keys.map((k) => normalizedWeights[k]);
  const total = vals.reduce((s, v) => s + v, 0) || 1;
  const normed = vals.map((v) => v / total);
  const cumulative = normed.reduce<number[]>((acc, v, i) => {
    acc.push((acc[i - 1] ?? 0) + v);
    return acc;
  }, []);
  const dividerCount = keys.length - 1;
  const dividers = cumulative.slice(0, dividerCount);

  const handlePointerDown = (idx: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = idx;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (dragging.current === null || !barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const idx = dragging.current;
    const lo = idx === 0 ? 0 : dividers[idx - 1];
    const hi = idx === dividerCount - 1 ? 1 : dividers[idx + 1];
    const clamped = Math.max(lo, Math.min(hi, pct));
    const newDiv = [...dividers];
    newDiv[idx] = clamped;
    // Derive segment widths from divider positions
    const segs: number[] = [];
    for (let i = 0; i < keys.length; i++) {
      const left = i === 0 ? 0 : newDiv[i - 1];
      const right = i === keys.length - 1 ? 1 : newDiv[i];
      segs.push(Math.max(0, right - left));
    }
    const next = {} as Record<K, number>;
    keys.forEach((k, i) => {
      next[k] = Number(segs[i].toFixed(3));
    });
    onChange(next);
  };

  const handlePointerUp = () => {
    dragging.current = null;
  };

  return (
    <div className="space-y-1">
      <div
        ref={barRef}
        className="relative h-7 rounded-lg overflow-hidden cursor-pointer select-none"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {normed.map((w, i) => {
          const left = i === 0 ? 0 : cumulative[i - 1];
          return (
            <div
              key={i}
              className="absolute top-0 h-full flex items-center justify-center text-[10px] text-white font-medium"
              style={{ left: `${left * 100}%`, width: `${w * 100}%`, backgroundColor: palette[i % palette.length] }}
            >
              {w >= 0.08 && `${(w * 100).toFixed(0)}%`}
            </div>
          );
        })}
        {dividers.map((pos, i) => (
          <div
            key={i}
            className="absolute top-0 h-full w-3 -ml-1.5 cursor-col-resize z-10 flex items-center justify-center"
            style={{ left: `${pos * 100}%` }}
            onPointerDown={handlePointerDown(i)}
          >
            <div className="w-1 h-5 bg-white/80 rounded-full shadow" />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 text-[10px] text-slate-500 flex-wrap">
        {labels.map(({ key, label }, i) => (
          <span key={key} className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: palette[i % palette.length] }} />
            {label} {(normalizedWeights[key] * 100).toFixed(0)}%
          </span>
        ))}
        <button
          type="button"
          className="ml-auto text-[10px] text-slate-400 hover:text-indigo-500 underline"
          onClick={() => onChange({ ...defaults })}
        >
          Reset to Default
        </button>
      </div>
    </div>
  );
}

// ── Strategy 1: property-prediction based scoring (kcat / solubility / Tm) ──
// Self-contained panel: fetches (and caches) raw predictions from the backend,
// then normalizes + weights them client-side into a single "Predicted Score"
// per candidate. The sub-weights and Tm target are lifted to the parent view
// so the same values can be reused as the 6th weight in the comprehensive
// recommendation strategy below.
function PredictedMetricsPanel({
  subWeights,
  onSubWeightsChange,
  tmTarget,
  onTmTargetChange,
}: {
  subWeights: PredictedSubWeights;
  onSubWeightsChange: (w: PredictedSubWeights) => void;
  tmTarget: number;
  onTmTargetChange: (v: number) => void;
}) {
  const [rows, setRows] = useState<PredictedMetricsRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastRunInfo, setLastRunInfo] = useState<{ count: number; recomputedCount: number } | null>(null);

  const runPredict = async (forceRecompute: boolean) => {
    setLoading(true);
    setError('');
    try {
      const data = await predictNetworkMetrics({
        forceRecompute,
        subWeights: normalizePredictedSubWeights(subWeights),
        tmTarget,
      });
      setRows(data.rows);
      setLastRunInfo({ count: data.count, recomputedCount: data.recomputedCount });
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Strategy 1: Property Prediction Score</h2>
      </div>
      <p className="text-sm text-slate-600">
        Runs kcat, solubility, and Tm (melting temperature) predictors on every candidate sequence in the network, then combines
        the three (min-max normalized) values into a single weighted score. Results are cached per task; use "Recompute All" to
        force fresh predictions.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Tm Target (°C)</label>
          <input type="number" step={0.5} className="w-full p-2 border rounded text-sm"
            value={tmTarget}
            onChange={(e) => onTmTargetChange(Number(e.target.value))} />
          <p className="text-[10px] text-slate-400 mt-1">Sequences with Tm closest to this target score highest.</p>
        </div>
      </div>
      <WeightBar
        weights={subWeights}
        onChange={onSubWeightsChange}
        labels={PREDICTED_SUB_WEIGHT_LABELS}
        colors={['#0ea5e9', '#10b981', '#f59e0b']}
        defaults={DEFAULT_PREDICTED_SUB_WEIGHTS}
      />
      <div className="flex items-center gap-3 flex-wrap">
        <button className="bg-sky-600 hover:bg-sky-700 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50"
          disabled={loading}
          onClick={() => runPredict(false)}>
          {loading ? 'Predicting...' : 'Run Property Prediction'}
        </button>
        <button className="text-xs text-slate-400 hover:text-indigo-500 underline disabled:opacity-50"
          disabled={loading}
          onClick={() => runPredict(true)}>
          Recompute All
        </button>
        {lastRunInfo && (
          <span className="text-xs text-slate-500">
            {lastRunInfo.count} candidate(s) scored, {lastRunInfo.recomputedCount} newly predicted
          </span>
        )}
      </div>
      {error && <div className="text-sm text-red-600">{error}</div>}
      {rows.length > 0 && (
        <div className="border border-slate-200 rounded-lg overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 sticky top-0">
              <tr>
                <th className="px-2 py-2 text-left">#</th>
                <th className="px-2 py-2 text-left">ID</th>
                <th className="px-2 py-2 text-right">kcat</th>
                <th className="px-2 py-2 text-right">Solubility</th>
                <th className="px-2 py-2 text-right">Tm</th>
                <th className="px-2 py-2 text-right">Predicted Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                  <td className="px-2 py-1.5 text-slate-400">{i + 1}</td>
                  <td className="px-2 py-1.5 font-mono text-xs break-all max-w-[200px]">{r.id}</td>
                  <td className="px-2 py-1.5 text-right">{r.kcat.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-right">{r.solubility.toFixed(1)}%</td>
                  <td className="px-2 py-1.5 text-right">{r.tm.toFixed(1)}°C</td>
                  <td className="px-2 py-1.5 text-right font-semibold">{r.predictedScore.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HmmerPipeline({ darkMode, setDarkMode, onBack }: { darkMode: boolean; setDarkMode: (v: boolean | ((p: boolean) => boolean)) => void; onBack: () => void }) {
  const hydratingStateRef = useRef(false);
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [taskList, setTaskList] = useState<TaskBrief[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState(() => {
    if (typeof window === 'undefined') {
      return 'hmmer-default';
    }
    return window.localStorage.getItem('enzymeminer.hmmer.activeTaskId') || 'hmmer-default';
  });
  const [newTaskId, setNewTaskId] = useState('');

  const [health, setHealth] = useState<any>(null);
  const [job, setJob] = useState<JobState>({ loading: false, message: '', error: '' });
  const [stepState, setStepState] = useState<Record<PipelineStepKey, StepStatus>>(initialStepState);
  const [activeStep, setActiveStep] = useState<PipelineStepKey | null>(null);
  const [runtimeTask, setRuntimeTask] = useState('idle');
  const [runtimeStartedAt, setRuntimeStartedAt] = useState<number | null>(null);
  const [runtimeUpdatedAt, setRuntimeUpdatedAt] = useState<number | null>(null);
  const [runtimeActive, setRuntimeActive] = useState(false);
  const [runtimeMeta, setRuntimeMeta] = useState<{ 
    ebiJobId?: string; 
    ebiDatabase?: string; 
    ebiDownloadProgress?: { current: number; total: number };
    uniprotProgress?: number;
    uniprotPhase?: string;
    consistencyProgress?: number;
    alignmentProgress?: { current: number; total: number; phase?: string };
    networkAlignProgress?: { current: number; total: number; phase?: string };
    networkAlignStages?: {
      'reference-links'?: { current: number; total: number };
      'candidate-pairwise'?: { current: number; total: number };
    };
  }>({});
  const [runtimeLogs, setRuntimeLogs] = useState<string[]>([]);
  const [autoScrollLog, setAutoScrollLog] = useState(true);
  const [lastCompletedStep, setLastCompletedStep] = useState<PipelineStepKey | null>(null);
  const [completionToast, setCompletionToast] = useState('');
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const actionStartedAtRef = useRef<number>(0);
  const [retryPolicy, setRetryPolicy] = useState<Record<PipelineStepKey, number>>({
    reference: 2,
    hmm: 2,
    search: 0,
    alignment: 1,
    scoring: 2,
    clustering: 1,
    similarity: 1,
    'network-push': 1,
    recommendation: 0,
  });
  const [retryIntervalMs, setRetryIntervalMs] = useState(900);
  const [metrics, setMetrics] = useState<Record<PipelineStepKey, StepMetrics>>(initialMetrics);

  const [entrezEmail, setEntrezEmail] = useState(import.meta.env.VITE_DEFAULT_EMAIL || '');
  const [accessions, setAccessions] = useState('');
  const [referencePreview, setReferencePreview] = useState<Array<Record<string, string>>>([]);
  const [referencePage, setReferencePage] = useState(1);
  const referencePageSize = 10;
  const [referenceFastaPath, setReferenceFastaPath] = useState('');
  const [referenceUploadFile, setReferenceUploadFile] = useState<File | null>(null);
  const [referenceImportNotice, setReferenceImportNotice] = useState('');
  const referenceUploadInputRef = useRef<HTMLInputElement | null>(null);

  const [cdhitPreview, setCdhitPreview] = useState<Array<Record<string, string>>>([]);
  const [cdhitPreviewPage, setCdhitPreviewPage] = useState(1);

  const [cdhitIdentity, setCdhitIdentity] = useState(0.9);

  const loadAllRows = async (source: 'hits_all' | 'filtered' = 'hits_all') => {
    let acc: any[] = [];
    let page = 1;
    const pageSize = 5000;
    while (true) {
      const res = await loadSearchPage(page, pageSize, source);
      const rows = Array.isArray(res.preview?.rows) ? res.preview.rows : [];
      if (rows.length === 0) {
        break;
      }
      acc = acc.concat(rows);
      if (page >= res.totalPages) break;
      page++;
    }
    return acc;
  };

  const [cdhitWordSize, setCdhitWordSize] = useState(5);
  const [cdhitCoverageLong, setCdhitCoverageLong] = useState(0);
  const [cdhitCoverageShort, setCdhitCoverageShort] = useState(0);
  const [identityLowerBound, setIdentityLowerBound] = useState(0);

  // Pairwise identity heatmap state
  const [refIdentityIds, setRefIdentityIds] = useState<string[]>([]);
  const [refIdentityMatrix, setRefIdentityMatrix] = useState<number[][]>([]);
  const [postCdhitIdentityIds, setPostCdhitIdentityIds] = useState<string[]>([]);
  const [postCdhitIdentityMatrix, setPostCdhitIdentityMatrix] = useState<number[][]>([]);
  const [hmmBuildStats, setHmmBuildStats] = useState<{
    inputCount: number;
    outputCount: number;
    clusterCount: number;
    clusters: Array<{ name: string; size: number; representative: string }>;
    lowerBoundRemoved?: string[];
  } | null>(null);

  const [targetFasta, setTargetFasta] = useState('');
  const [hmmFile, setHmmFile] = useState('');
  const [searchMode, setSearchMode] = useState<'local' | 'ebi'>('local');
  const [ebiDatabase, setEbiDatabase] = useState('refprot');
  const [ebiStageJobId, setEbiStageJobId] = useState('');
  const [ebiStagePageCount, setEbiStagePageCount] = useState<number | null>(null);
  const [ebiStageFailedPages, setEbiStageFailedPages] = useState<number | null>(null);
  const [ebiStageFailedPageNumbers, setEbiStageFailedPageNumbers] = useState<number[]>([]);
  const [ebiSubStepState, setEbiSubStepState] = useState<EbiSubStepState>(initialEbiSubStepState);
  const [allHmmRows, setAllHmmRows] = useState<Array<Record<string, string>>>([]);
  const [hitsRows, setHitsRows] = useState<Array<Record<string, string>>>([]);
  const [searchPage, setSearchPage] = useState(1);
  const [searchPageSize] = useState(50);
  const [searchTotalPages, setSearchTotalPages] = useState(1);
  const [searchSource, setSearchSource] = useState<'hits_all' | 'filtered'>('hits_all');

  const [scoreMin, setScoreMin] = useState(200);
  const [lenMin, setLenMin] = useState(520);
  const [lenMax, setLenMax] = useState(570);
  const [filterStats, setFilterStats] = useState<{ kept: number; total: number } | null>(null);
  const [filteredRows, setFilteredRows] = useState<Array<Record<string, string>>>([]);
  const [consistencyStats, setConsistencyStats] = useState<{
    total: number;
    checked: number;
    mismatch: number;
    filled: number;
    source: string;
  } | null>(null);
  const [selectionBoxes, setSelectionBoxes] = useState<Array<{ id: number; x1: number; x2: number; y1: number; y2: number }>>([]);
  const [dragMode, setDragMode] = useState<'draw' | 'move' | 'pan' | null>(null);
  const [movingBoxId, setMovingBoxId] = useState<number | null>(null);
  const dragAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const draftDataRef = useRef<{ x1: number; x2: number; y1: number; y2: number } | null>(null);
  const draftOverlayRef = useRef<SVGRectElement | null>(null);
  const additiveDrawRef = useRef(false);
  const moveRafRef = useRef<number>(0);
  const [highlightTarget, setHighlightTarget] = useState('');
  const [plotDomain, setPlotDomain] = useState<{ xMin: number; xMax: number; yMin: number; yMax: number } | null>(null);
  const scatterWrapRef = useRef<HTMLDivElement | null>(null);
  const scatterRoRef = useRef<ResizeObserver | null>(null);
  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});
  const stableWheelFn = useRef((e: WheelEvent) => wheelHandlerRef.current(e));
  const scatterWrapCallbackRef = useCallback((node: HTMLDivElement | null) => {
    const prev = scatterWrapRef.current;
    if (prev) prev.removeEventListener('wheel', stableWheelFn.current);
    if (scatterRoRef.current) { scatterRoRef.current.disconnect(); scatterRoRef.current = null; }
    scatterWrapRef.current = node;
    if (node) {
      node.addEventListener('wheel', stableWheelFn.current, { passive: false });
      const ro = new ResizeObserver((entries) => {
        const { width, height } = entries[0].contentRect;
        setSvgSize({ w: Math.round(width), h: Math.round(height) });
      });
      ro.observe(node);
      scatterRoRef.current = ro;
    }
  }, []);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });
  const nextBoxIdRef = useRef(1);

  const [alignmentPath, setAlignmentPath] = useState('');
  const [refId, setRefId] = useState('');
  const [threshold, setThreshold] = useState(33.6);
  const [autoScoreFromFiltered, setAutoScoreFromFiltered] = useState(false);
  const [scoringRules, setScoringRules] = useState<ScoringRule[]>([]);
  const [scoringPositionMode, setScoringPositionMode] = useState<ScoringPositionMode>('pre');
  const [preAlignmentAnchor, setPreAlignmentAnchor] = useState<PreAlignmentAnchor>('first');
  const [scoringRulesError, setScoringRulesError] = useState('');
  const [scoringRulesSuccess, setScoringRulesSuccess] = useState('');
  const [scoringAllowedDrafts, setScoringAllowedDrafts] = useState<Record<number, string>>({});
  const rulesImportRef = useRef<HTMLInputElement | null>(null);
  const [scoringRows, setScoringRows] = useState<Array<Record<string, string>>>([]);
  const [scoringRunInfo, setScoringRunInfo] = useState<{
    csv?: string;
    alignmentUsed: string;
    autoFromFiltered: boolean;
    total: number;
    passed: number;
    passedFasta?: string;
    passedCount?: number;
    passedMissingInAlignment?: number;
    positionMode?: ScoringPositionMode;
    preAlignmentAnchor?: PreAlignmentAnchor;
    refIdUsed?: string | null;
  } | null>(null);
  const [alignmentPrepInfo, setAlignmentPrepInfo] = useState<{ alignment: string; records: number } | null>(null);
  const [autoDownloadScoringCsv, setAutoDownloadScoringCsv] = useState(true);
  const [thresholdPreview, setThresholdPreview] = useState<{ total: number; passed: number; ratio: number; threshold: number } | null>(null);
  const [alignmentPreviewRows, setAlignmentPreviewRows] = useState<Array<{ id: string; segment: string }>>([]);
  const [alignmentPreviewStart, setAlignmentPreviewStart] = useState(1);
  const [alignmentPreviewEnd, setAlignmentPreviewEnd] = useState(120);
  const [alignmentPreviewOffset, setAlignmentPreviewOffset] = useState(0);
  const [alignmentPreviewLimit] = useState(25);
  const [alignmentPreviewTotalRecords, setAlignmentPreviewTotalRecords] = useState(0);
  const [alignmentPreviewLength, setAlignmentPreviewLength] = useState(0);

  const [candidateFasta, setCandidateFasta] = useState('');
  const [clusterIdentity, setClusterIdentity] = useState(0.85);
  const [clusterWordSize, setClusterWordSize] = useState(5);
  const [clusteringRunInfo, setClusteringRunInfo] = useState<{
    inputFasta: string;
    outputFasta: string;
    clusterFile: string;
    inputCount: number;
    outputCount: number;
    deduplicatedCount: number;
    clusters: number;
  } | null>(null);

  const [networkStats, setNetworkStats] = useState({ nodes: 0, edges: 0 });
  const [cytoBaseUrl, setCytoBaseUrl] = useState('http://localhost:1234/v1');
  const [cytoCollection, setCytoCollection] = useState('Similarity');
  const [cytoNetworkTitle, setCytoNetworkTitle] = useState('Similarity Network');
  const [cytoLayout, setCytoLayout] = useState('force-directed');
  const [cytoCategoryColumn, setCytoCategoryColumn] = useState('phylum');
  const [cytoApplyStyle, setCytoApplyStyle] = useState(true);
  const [networkPairwiseThresholdPct, setNetworkPairwiseThresholdPct] = useState(85);
  const [networkIncludeReferenceLinks, setNetworkIncludeReferenceLinks] = useState(true);
  const [networkSimilarityMethod, setNetworkSimilarityMethod] = useState<'needleman-wunsch' | 'smith-waterman' | 'mmseqs2'>('mmseqs2');
  const [networkSourceFasta, setNetworkSourceFasta] = useState('scored_passed.fasta');
  const [networkReferenceFasta, setNetworkReferenceFasta] = useState(() => defaultTaskReferenceFasta(selectedTaskId));
  const [similarityConfirmState, setSimilarityConfirmState] = useState({ open: false, nodeTotal: 0, edgeTotal: 0 });
  const [cytoPushInfo, setCytoPushInfo] = useState<{
    networkSuid: number | null;
    pushedNodes: number;
    pushedEdges: number;
    baseUrl: string;
    collection: string;
    title: string;
    layout: string;
    styleName: string;
    styleApplied: boolean;
    styleError?: string;
    categoryColumn?: string | null;
    layoutApplied: boolean;
    layoutError?: string;
    generated: boolean;
  } | null>(null);

  // ── Browser graph state ──
  const [browserGraphNodes, setBrowserGraphNodes] = useState<BrowserGraphNode[]>([]);
  const [browserGraphEdges, setBrowserGraphEdges] = useState<BrowserGraphEdge[]>([]);
  const [browserGraphAllEdges, setBrowserGraphAllEdges] = useState<BrowserGraphEdge[]>([]);
  const [browserGraphThreshold, setBrowserGraphThreshold] = useState(80);
  const [browserGraphLoadedThreshold, setBrowserGraphLoadedThreshold] = useState(80);
  const [browserGraphThresholdAdjusted, setBrowserGraphThresholdAdjusted] = useState(false);
  const [browserGraphMaxEdges, setBrowserGraphMaxEdges] = useState(20000);
  const [browserGraphMode, setBrowserGraphMode] = useState<'d3' | 'cytoscape'>('cytoscape');
  const [browserGraphCategoryCol, setBrowserGraphCategoryCol] = useState<string>('class');
  const [browserGraphVisible, setBrowserGraphVisible] = useState(false);

  // ── Recommendation state ──
  const [recommendResults, setRecommendResults] = useState<RecommendCandidate[]>([]);
  const [recommendWeights, setRecommendWeights] = useState<RecommendWeights>({ ...DEFAULT_WEIGHTS });
  const [recommendNetworkConnectivityThreshold, setRecommendNetworkConnectivityThreshold] = useState<number>(85);
  const [recommendTopN, setRecommendTopN] = useState(50);
  const [recommendMinClusterSize, setRecommendMinClusterSize] = useState(2);
  const [recommendMinSimilarity, setRecommendMinSimilarity] = useState(0);
  const [recommendTemperature, setRecommendTemperature] = useState(0);
  const [recommendDiversityMode, setRecommendDiversityMode] = useState<'proportional' | 'round-robin'>('proportional');
  const [recommendMeta, setRecommendMeta] = useState<{ totalCandidates: number; totalReferences: number; filteredByClusterSize: number; filteredBySimilarity: number; predictedMetricsAvailable: boolean } | null>(null);
  const [predictedSubWeights, setPredictedSubWeights] = useState<PredictedSubWeights>({ ...DEFAULT_PREDICTED_SUB_WEIGHTS });
  const [predictedTmTarget, setPredictedTmTarget] = useState(60);

  const getDerivedEbiSearchStepStatus = (): StepStatus => {
    const { submit, download, enrich } = ebiSubStepState;
    if (submit === 'error' || download === 'error' || enrich === 'error') {
      return 'error';
    }
    if (enrich === 'success') {
      return 'success';
    }
    if (
      submit === 'running' ||
      download === 'running' ||
      enrich === 'running' ||
      submit === 'success' ||
      download === 'success'
    ) {
      return 'running';
    }
    return 'idle';
  };

  useEffect(() => {
    setActiveTaskId(selectedTaskId);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('enzymeminer.hmmer.activeTaskId', selectedTaskId);
    }
  }, [selectedTaskId]);

  useEffect(() => {
    setNetworkReferenceFasta((prev) => {
      const text = String(prev || '').trim();
      const isTaskDefault = /^\/home\/threo\/aox_project\/aox_tasks\/[^/]+\/ref\.fasta$/.test(text);
      if (!text || isTaskDefault) {
        return defaultTaskReferenceFasta(selectedTaskId);
      }
      return prev;
    });
  }, [selectedTaskId]);

  useEffect(() => {
    if (searchMode !== 'ebi') {
      return;
    }
    const derived = getDerivedEbiSearchStepStatus();
    setStepState((prev) => {
      if (prev.search === derived) {
        return prev;
      }
      return { ...prev, search: derived };
    });
    if (derived !== 'running') {
      setActiveStep((prev) => (prev === 'search' ? null : prev));
    }
  }, [searchMode, ebiSubStepState]);

  const refreshTasks = async () => {
    const data = await listTasks();
    const all = data.tasks || [];
    setTaskList(all.filter((t) => t.module === 'hmmer' || !t.module || t.id === 'hmmer-default'));
    if (!all.some((t) => t.id === selectedTaskId)) {
      setSelectedTaskId('hmmer-default');
    }
  };

  useEffect(() => {
    void refreshTasks();
  }, []);

  useEffect(() => {
    setHealth(null);
    setReferencePreview([]);
    setCdhitPreview([]);
    setAllHmmRows([]);
    setHitsRows([]);
    setFilteredRows([]);
    setFilterStats(null);
    setScoringRows([]);
    setAlignmentPrepInfo(null);
    setAlignmentPath('');
    setAlignmentPreviewRows([]);
    setAlignmentPreviewOffset(0);
    setNetworkStats({ nodes: 0, edges: 0 });
    setConsistencyStats(null);
    setRuntimeTask('idle');
    setRuntimeMeta({});
    setRuntimeLogs([]);
    setStepState(initialStepState);
    setLastCompletedStep(null);
    setJob({ loading: true, message: `Loading task progress: ${selectedTaskId}`, error: '' });
    setEbiStageJobId('');
    setEbiStagePageCount(null);
    setEbiStageFailedPages(null);
    setEbiStageFailedPageNumbers([]);
    setEbiSubStepState(initialEbiSubStepState);
    setReferenceFastaPath('');
    setCandidateFasta('');
    setRefId('');
    setNetworkSourceFasta('scored_passed.fasta');
    setNetworkReferenceFasta(defaultTaskReferenceFasta(selectedTaskId));
    setHmmFile('');
    setTargetFasta('');
    setSearchPage(1);
    setSearchTotalPages(1);
    setSearchSource('hits_all');
    setAccessions('');
    // Reset parameters to defaults; hydration will restore saved values
    setScoreMin(200);
    setLenMin(520);
    setLenMax(570);
    setCdhitIdentity(0.9);
    setCdhitWordSize(5);
    setCdhitCoverageLong(0);
    setCdhitCoverageShort(0);
    setIdentityLowerBound(0);
    setRefIdentityIds([]);
    setRefIdentityMatrix([]);
    setPostCdhitIdentityIds([]);
    setPostCdhitIdentityMatrix([]);
    setHmmBuildStats(null);
    setEbiDatabase('refprot');
    setThreshold(33.6);
    setAutoScoreFromFiltered(false);
    setScoringPositionMode('pre');
    setPreAlignmentAnchor('first');
    setAutoDownloadScoringCsv(true);
    setClusterIdentity(0.85);
    setClusterWordSize(5);
    setNetworkPairwiseThresholdPct(85);
    setNetworkIncludeReferenceLinks(true);
    setNetworkSimilarityMethod('mmseqs2');
    setCytoBaseUrl('http://localhost:1234/v1');
    setCytoCollection('Similarity');
    setCytoNetworkTitle('Similarity Network');
    setCytoLayout('force-directed');
    setCytoCategoryColumn('phylum');
    setCytoApplyStyle(true);
    setScoringRunInfo(null);
    setThresholdPreview(null);
    setCytoPushInfo(null);
    setScoringRules([]);
    setScoringAllowedDrafts({});
    setScoringRulesError('');
    setScoringRulesSuccess('');
    setSelectionBoxes([]);
    draftDataRef.current = null;
    setDragMode(null);
    dragAnchorRef.current = null;
    setMovingBoxId(null);
    setHighlightTarget('');
    setPlotDomain(null);
    if (draftOverlayRef.current) draftOverlayRef.current.style.display = 'none';

    let cancelled = false;
    hydratingStateRef.current = true;
    const hydrateTaskState = async () => {
      let staleRecommendCache = false;
      setActiveTaskId(selectedTaskId);
      try {
        const data = await loadPipelineState('hmmer');
        const state = data.exists && data.state && typeof data.state === 'object' ? data.state : {};
        if (cancelled) {
          return;
        }

        if (state.currentView) setCurrentView(state.currentView as View);
        if (state.stepState && typeof state.stepState === 'object') {
          setStepState({ ...initialStepState, ...(state.stepState as Record<PipelineStepKey, StepStatus>) });
        }
        if (state.lastCompletedStep) setLastCompletedStep(state.lastCompletedStep as PipelineStepKey);

        if (typeof state.entrezEmail === 'string') setEntrezEmail(state.entrezEmail);
        if (typeof state.accessions === 'string') setAccessions(state.accessions);
        if (typeof state.referenceFastaPath === 'string') setReferenceFastaPath(state.referenceFastaPath);
        if (typeof state.candidateFasta === 'string') setCandidateFasta(state.candidateFasta);
        if (typeof state.alignmentPath === 'string') setAlignmentPath(state.alignmentPath);
        if (typeof state.refId === 'string') setRefId(state.refId);
        if (typeof state.hmmFile === 'string') setHmmFile(state.hmmFile);
        if (typeof state.targetFasta === 'string') setTargetFasta(state.targetFasta);
        if (typeof state.networkSourceFasta === 'string') setNetworkSourceFasta(state.networkSourceFasta);
        if (typeof state.networkReferenceFasta === 'string' && state.networkReferenceFasta.trim()) {
          // Auto-correct legacy filenames (AAO_ref.fasta, AOX_ref.fasta, etc.) to ref.fasta
          const nrf = state.networkReferenceFasta.trim();
          const corrected = nrf.replace(/\/(AAO_ref|AOX_ref\d*|AOX_ref_cdhit\d+)\.fasta$/, '/ref.fasta');
          setNetworkReferenceFasta(corrected);
        } else {
          setNetworkReferenceFasta(defaultTaskReferenceFasta(selectedTaskId));
        }

        if (typeof state.searchMode === 'string' && (state.searchMode === 'local' || state.searchMode === 'ebi')) {
          setSearchMode(state.searchMode);
        }
        if (state.ebiSubStepState && typeof state.ebiSubStepState === 'object') {
          setEbiSubStepState({ ...initialEbiSubStepState, ...(state.ebiSubStepState as EbiSubStepState) });
        }
        if (typeof state.ebiDatabase === 'string') setEbiDatabase(state.ebiDatabase);

        // Filter parameters
        if (typeof state.scoreMin === 'number' && Number.isFinite(state.scoreMin)) setScoreMin(state.scoreMin);
        if (typeof state.lenMin === 'number' && Number.isFinite(state.lenMin)) setLenMin(state.lenMin);
        if (typeof state.lenMax === 'number' && Number.isFinite(state.lenMax)) setLenMax(state.lenMax);

        // HMM build parameters
        if (typeof state.cdhitIdentity === 'number' && Number.isFinite(state.cdhitIdentity)) setCdhitIdentity(state.cdhitIdentity);
        if (typeof state.cdhitWordSize === 'number' && Number.isFinite(state.cdhitWordSize)) setCdhitWordSize(state.cdhitWordSize);
        if (typeof state.cdhitCoverageLong === 'number' && Number.isFinite(state.cdhitCoverageLong)) setCdhitCoverageLong(state.cdhitCoverageLong);
        if (typeof state.cdhitCoverageShort === 'number' && Number.isFinite(state.cdhitCoverageShort)) setCdhitCoverageShort(state.cdhitCoverageShort);
        if (typeof state.identityLowerBound === 'number' && Number.isFinite(state.identityLowerBound)) setIdentityLowerBound(state.identityLowerBound);

        // Scoring parameters
        if (typeof state.threshold === 'number' && Number.isFinite(state.threshold)) setThreshold(state.threshold);
        if (typeof state.autoScoreFromFiltered === 'boolean') setAutoScoreFromFiltered(state.autoScoreFromFiltered);
        if (typeof state.scoringPositionMode === 'string') setScoringPositionMode(state.scoringPositionMode as ScoringPositionMode);
        if (typeof state.preAlignmentAnchor === 'string') setPreAlignmentAnchor(state.preAlignmentAnchor as PreAlignmentAnchor);
        if (typeof state.autoDownloadScoringCsv === 'boolean') setAutoDownloadScoringCsv(state.autoDownloadScoringCsv);
        if (Array.isArray(state.scoringRules)) setScoringRules(state.scoringRules);

        // Clustering parameters
        if (typeof state.clusterIdentity === 'number' && Number.isFinite(state.clusterIdentity)) setClusterIdentity(state.clusterIdentity);
        if (typeof state.clusterWordSize === 'number' && Number.isFinite(state.clusterWordSize)) setClusterWordSize(state.clusterWordSize);
        if (state.clusteringRunInfo !== undefined) setClusteringRunInfo(state.clusteringRunInfo);

        // Network / Cytoscape parameters
        if (typeof state.networkPairwiseThresholdPct === 'number' && Number.isFinite(state.networkPairwiseThresholdPct)) setNetworkPairwiseThresholdPct(state.networkPairwiseThresholdPct);
        if (typeof state.networkIncludeReferenceLinks === 'boolean') setNetworkIncludeReferenceLinks(state.networkIncludeReferenceLinks);
        if (typeof state.networkSimilarityMethod === 'string') setNetworkSimilarityMethod(state.networkSimilarityMethod as 'needleman-wunsch' | 'smith-waterman' | 'mmseqs2');
        if (typeof state.cytoBaseUrl === 'string') setCytoBaseUrl(state.cytoBaseUrl);
        if (typeof state.cytoCollection === 'string') setCytoCollection(state.cytoCollection);
        if (typeof state.cytoNetworkTitle === 'string') setCytoNetworkTitle(state.cytoNetworkTitle);
        if (typeof state.cytoLayout === 'string') setCytoLayout(state.cytoLayout);
        if (typeof state.cytoCategoryColumn === 'string') setCytoCategoryColumn(state.cytoCategoryColumn);
        if (typeof state.cytoApplyStyle === 'boolean') setCytoApplyStyle(state.cytoApplyStyle);

        // Recommendation parameters
        if (state.recommendWeights && typeof state.recommendWeights === 'object') setRecommendWeights(normalizeRecommendWeights(state.recommendWeights));
        if (typeof state.recommendTopN === 'number') setRecommendTopN(state.recommendTopN);
        if (typeof state.recommendMinClusterSize === 'number') setRecommendMinClusterSize(state.recommendMinClusterSize);
        if (typeof state.recommendMinSimilarity === 'number') setRecommendMinSimilarity(state.recommendMinSimilarity);
        if (typeof state.recommendTemperature === 'number') setRecommendTemperature(state.recommendTemperature);
        if (state.recommendDiversityMode === 'proportional' || state.recommendDiversityMode === 'round-robin') setRecommendDiversityMode(state.recommendDiversityMode);
        const normalizedRecommend = normalizeSavedRecommendResults(state.recommendResults, state.recommendTopN);
        setRecommendResults(normalizedRecommend.results || []);
        staleRecommendCache = normalizedRecommend.stale;
        if (!normalizedRecommend.stale && state.recommendMeta && typeof state.recommendMeta === 'object') setRecommendMeta(state.recommendMeta as any);
        else setRecommendMeta(null);

        // ===== Auto-load from existing artifacts =====
        let artifacts: Record<string, any> = {};
        let artifactWorkDir = '';
        try {
          const artRes = await loadTaskArtifacts();
          if (!cancelled) {
            artifacts = artRes.artifacts || {};
            artifactWorkDir = artRes.workDir || '';
          }
        } catch (artErr) {
          console.warn('[hydrate] loadTaskArtifacts failed:', artErr);
        }
        if (cancelled) return;

        // Step 1: ref.csv → referencePreview
        if (artifacts['ref.csv']?.exists) {
          try {
            const refData = await loadReferencePreview();
            if (!cancelled && refData.exists && refData.preview?.rows?.length) {
              setReferencePreview(refData.preview.rows);
            }
          } catch (e) { console.warn('[hydrate] ref preview:', e); }
        }

        // Step 2: ref.hmm → hmmFile
        if (artifacts['ref.hmm']?.exists && artifactWorkDir) {
          setHmmFile(artifactWorkDir + '/ref.hmm');
        }

        // Step 2: ref.fasta → referenceFastaPath (only if not already set from state)
        if (artifacts['ref.fasta']?.exists && artifactWorkDir && !state.referenceFastaPath) {
          setReferenceFastaPath(artifactWorkDir + '/ref.fasta');
        }

        // Step 2: ref_cdhit90.fasta → cdhitPreview
        if (artifacts['ref_cdhit90.fasta']?.exists) {
          try {
            const cdhitData = await loadCdhitPreview();
            if (!cancelled && cdhitData.exists && cdhitData.preview?.rows?.length) {
              setCdhitPreview(cdhitData.preview.rows);
            }
          } catch (e) { console.warn('[hydrate] cdhit preview:', e); }
        }

        // Step 3: ebi_download_meta → ebi substep info
        if (artifacts['ebi_download_meta.json']?.exists && artifacts['ebi_download_meta.json'].meta) {
          const meta = artifacts['ebi_download_meta.json'].meta;
          if (meta.jobId) setEbiStageJobId(String(meta.jobId));
          if (meta.pageCount) setEbiStagePageCount(Number(meta.pageCount));
          if (Array.isArray(meta.failedPages)) {
            setEbiStageFailedPages(meta.failedPages.length);
            setEbiStageFailedPageNumbers(meta.failedPages);
          }
        }

        // Step 3: hits_all.csv → load first page immediately for table, full data lazily for scatter
        if (artifacts['hits_all.csv']?.exists && (artifacts['hits_all.csv'].rowCount ?? 0) > 0) {
          try {
            const firstPage = await loadSearchPage(1, searchPageSize, 'hits_all');
            if (!cancelled && firstPage.preview?.rows?.length) {
              setHitsRows(firstPage.preview.rows);
              setSearchPage(1);
              setSearchTotalPages(firstPage.totalPages);
            }
          } catch (e) { console.warn('[hydrate] hits_all:', e); }
          // Load full dataset for scatter plot (non-blocking)
          if (!cancelled) {
            loadAllRows('hits_all').then((rows) => {
              if (!cancelled) setAllHmmRows(rows);
            }).catch((e) => console.warn('[hydrate] allRows:', e));
          }
        }

        // Step 3: hits_filtered.csv → filteredRows + filterStats (first page)
        if (artifacts['hits_filtered.csv']?.exists && (artifacts['hits_filtered.csv'].rowCount ?? 0) > 0) {
          try {
            const firstPage = await loadSearchPage(1, searchPageSize, 'filtered');
            if (!cancelled && firstPage.preview?.rows?.length) {
              setFilteredRows(firstPage.preview.rows);
              setFilterStats({
                kept: artifacts['hits_filtered.csv'].rowCount ?? firstPage.preview.rows.length,
                total: artifacts['hits_all.csv']?.rowCount ?? 0,
              });
            }
          } catch (e) { console.warn('[hydrate] filtered:', e); }
        }

        // Step 7: nodes.csv + edges → networkStats
        if (artifacts['nodes.csv']?.exists && artifacts['edges_similarity.csv']?.exists) {
          setNetworkStats({
            nodes: artifacts['nodes.csv'].rowCount ?? 0,
            edges: artifacts['edges_similarity.csv'].rowCount ?? 0,
          });
        }

        setJob({ loading: false, message: `Task progress loaded: ${selectedTaskId}`, error: '' });
        if (staleRecommendCache) {
          setCompletionToast('Detected outdated recommendation cache, please recompute recommendations');
        }
      } catch (err) {
        if (!cancelled) {
          setJob({ loading: false, message: '', error: `Failed to load task progress: ${String(err)}` });
        }
      } finally {
        if (!cancelled) {
          hydratingStateRef.current = false;
        }
      }
    };

    void hydrateTaskState();
    return () => {
      cancelled = true;
      hydratingStateRef.current = false;
    };
  }, [selectedTaskId]);

  useEffect(() => {
    if (hydratingStateRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      const state = {
        currentView,
        stepState,
        lastCompletedStep,
        entrezEmail,
        accessions,
        referenceFastaPath,
        hmmFile,
        targetFasta,
        searchMode,
        ebiSubStepState,
        ebiDatabase,
        candidateFasta,
        alignmentPath,
        refId,
        networkSourceFasta,
        networkReferenceFasta,
        // Filter parameters
        scoreMin,
        lenMin,
        lenMax,
        // HMM build parameters
        cdhitIdentity,
        cdhitWordSize,
        cdhitCoverageLong,
        cdhitCoverageShort,
        identityLowerBound,
        // Scoring parameters
        scoringRules,
        threshold,
        autoScoreFromFiltered,
        scoringPositionMode,
        preAlignmentAnchor,
        autoDownloadScoringCsv,
        // Clustering parameters
        clusterIdentity,
        clusterWordSize,
        clusteringRunInfo,
        // Network / Cytoscape parameters
        networkPairwiseThresholdPct,
        networkIncludeReferenceLinks,
        networkSimilarityMethod,
        cytoBaseUrl,
        cytoCollection,
        cytoNetworkTitle,
        cytoLayout,
        cytoCategoryColumn,
        cytoApplyStyle,
        // Recommendation parameters
        recommendWeights,
        recommendTopN,
        recommendMinClusterSize,
        recommendMinSimilarity,
        recommendTemperature,
        recommendDiversityMode,
        recommendResults,
        recommendMeta,
      };
      void savePipelineState(state, 'hmmer').catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [
    currentView,
    stepState,
    lastCompletedStep,
    entrezEmail,
    accessions,
    referenceFastaPath,
    hmmFile,
    targetFasta,
    searchMode,
    ebiSubStepState,
    ebiDatabase,
    candidateFasta,
    alignmentPath,
    refId,
    networkSourceFasta,
    networkReferenceFasta,
    scoreMin,
    lenMin,
    lenMax,
    cdhitIdentity,
    cdhitWordSize,
    cdhitCoverageLong,
    cdhitCoverageShort,
    identityLowerBound,
    threshold,
    autoScoreFromFiltered,
    scoringPositionMode,
    preAlignmentAnchor,
    autoDownloadScoringCsv,
    scoringRules,
    clusterIdentity,
    clusterWordSize,
    clusteringRunInfo,
    networkPairwiseThresholdPct,
    networkIncludeReferenceLinks,
    networkSimilarityMethod,
    cytoBaseUrl,
    cytoCollection,
    cytoNetworkTitle,
    cytoLayout,
    cytoCategoryColumn,
    cytoApplyStyle,
    recommendWeights,
    recommendTopN,
    recommendMinClusterSize,
    recommendMinSimilarity,
    recommendTemperature,
    recommendDiversityMode,
    recommendResults,
    recommendMeta,
  ]);

  useEffect(() => {
    if (!refId && referencePreview.length > 0) {
      const first = referencePreview[0];
      const acc = first.accession ?? first.id ?? '';
      if (acc) setRefId(acc);
    }
  }, [referencePreview, refId]);

  const scatterData = useMemo(() => {
    const raw = allHmmRows
      .map((row) => ({
        target: String(row.target ?? ''),
        score: Number(row.hmm_score ?? row.score ?? 0),
        length: Number(row.length ?? 0),
      }))
      .filter((x) => Number.isFinite(x.score) && Number.isFinite(x.length));
    
    // If the count is extremely large, rendering the scatter plot on the frontend can be very laggy (especially when box-selection triggers a re-render), so apply uniform downsampling
    if (raw.length > 2000) {
      const step = raw.length / 2000;
      const sampled = [];
      for (let i = 0; i < raw.length; i += step) {
        sampled.push(raw[Math.floor(i)]);
      }
      return sampled;
    }
    return raw;
  }, [allHmmRows]);

  const scatterBounds = useMemo(() => {
    if (!scatterData.length) {
      return null;
    }
    const scores = scatterData.map((d) => d.score);
    const lengths = scatterData.map((d) => d.length);
    return {
      minScore: Math.min(...scores),
      maxScore: Math.max(...scores),
      minLength: Math.min(...lengths),
      maxLength: Math.max(...lengths),
    };
  }, [scatterData]);

  useEffect(() => {
    if (!scatterBounds) {
      setPlotDomain(null);
      return;
    }
    if (!plotDomain) {
      setPlotDomain({
        xMin: scatterBounds.minScore,
        xMax: scatterBounds.maxScore,
        yMin: scatterBounds.minLength,
        yMax: scatterBounds.maxLength,
      });
    }
  }, [scatterBounds, plotDomain]);

  const highlightedPoint = useMemo(
    () => scatterData.filter((d) => d.target === highlightTarget),
    [scatterData, highlightTarget],
  );

  const referenceTotalPages = useMemo(
    () => Math.max(1, Math.ceil(referencePreview.length / referencePageSize)),
    [referencePreview.length],
  );

  const pagedReferenceRows = useMemo(() => {
    const safePage = Math.min(Math.max(1, referencePage), referenceTotalPages);
    const start = (safePage - 1) * referencePageSize;
    return referencePreview.slice(start, start + referencePageSize);
  }, [referencePreview, referencePage, referenceTotalPages]);

  useEffect(() => {
    setReferencePage(1);
  }, [referencePreview]);

  const cdhitPreviewTotalPages = useMemo(
    () => Math.max(1, Math.ceil(cdhitPreview.length / referencePageSize)),
    [cdhitPreview.length],
  );

  const pagedCdhitPreviewRows = useMemo(() => {
    const safePage = Math.min(Math.max(1, cdhitPreviewPage), cdhitPreviewTotalPages);
    const start = (safePage - 1) * referencePageSize;
    return cdhitPreview.slice(start, start + referencePageSize);
  }, [cdhitPreview, cdhitPreviewPage, cdhitPreviewTotalPages]);

  useEffect(() => {
    setCdhitPreviewPage(1);
  }, [cdhitPreview]);

  useEffect(() => {
    if (!job.loading) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const data = await loadRuntimeLogs(240);
        if (!cancelled) {
          setRuntimeActive(Boolean(data.active));
          setRuntimeStartedAt(Number.isFinite(Number(data.startedAt)) ? Number(data.startedAt) : null);
          setRuntimeUpdatedAt(Number.isFinite(Number(data.updatedAt)) ? Number(data.updatedAt) : null);
          setRuntimeTask(data.task);
          setRuntimeMeta(data.meta || {});
          setRuntimeLogs(data.lines);

          const elapsed = Date.now() - actionStartedAtRef.current;
          if (!data.active && elapsed > 4000) {
            const tail = Array.isArray(data.lines) && data.lines.length > 0
              ? String(data.lines[data.lines.length - 1]).toLowerCase()
              : '';
            const markError = isLikelyErrorLogLine(tail);
            setJob({
              loading: false,
              message: markError ? '' : 'Backend task has ended; the frontend running lock was automatically released',
              error: markError ? 'Backend task ended but returned a failure; the frontend running lock was automatically released' : '',
            });
            setActiveStep(null);
            setStepState((prev) => {
              const next = { ...prev };
              (Object.keys(next) as PipelineStepKey[]).forEach((k) => {
                if (next[k] === 'running') {
                  next[k] = markError ? 'error' : 'success';
                }
              });
              return next;
            });
          }
        }
      } catch {
        if (!cancelled) {
          setRuntimeLogs((prev) => (prev.length ? prev : ['[log] Unable to read backend logs at the moment'])) ;
        }
      }
    };

    void poll();
    const timer = setInterval(poll, 250);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job.loading]);

  useEffect(() => {
    if (!autoScrollLog) {
      return;
    }
    const box = logContainerRef.current;
    if (box) {
      box.scrollTop = box.scrollHeight;
    }
  }, [runtimeLogs, autoScrollLog]);

  useEffect(() => {
    if (!completionToast) {
      return;
    }
    const timer = setTimeout(() => {
      setCompletionToast('');
      setLastCompletedStep(null);
    }, 1800);
    return () => clearTimeout(timer);
  }, [completionToast]);

  useEffect(() => {
    try {
      const parsed = parseScoringRulesInput(scoringRules);
      const maxScore = parsed.reduce((s, r) => s + (r.score ?? 0), 0);
      setScoringRulesError('');
      setScoringRulesSuccess(`Rules validated automatically: ${parsed.length} rules, max score ${maxScore}`);
    } catch (err) {
      setScoringRulesError(String(err));
      setScoringRulesSuccess('');
    }
  }, [scoringRules]);

  async function runAction(label: string, fn: () => Promise<void>, step?: PipelineStepKey, retries?: number, customToast?: string) {
    const started = Date.now();
    actionStartedAtRef.current = started;
    setJob({ loading: true, message: label, error: '' });
    if (step) {
      setActiveStep(step);
      setStepState((prev) => ({ ...prev, [step]: 'running' }));
    }

    const policyRetries = step ? Number(retryPolicy[step]) : 0;
    const totalRetries = typeof retries === 'number'
      ? retries
      : Number.isFinite(policyRetries)
        ? Math.max(0, Math.floor(policyRetries))
        : 0;

    try {
      let lastError: unknown = null;
      let attemptsUsed = 0;
      for (let attempt = 0; attempt <= totalRetries; attempt += 1) {
        attemptsUsed = attempt + 1;
        try {
          if (attempt > 0) {
            setJob({ loading: true, message: `${label} retrying (${attempt}/${totalRetries})`, error: '' });
          }
          await fn();
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < totalRetries) {
            await sleep(retryIntervalMs);
            continue;
          }
        }
      }

      if (lastError) {
        throw lastError;
      }

      if (step) {
        const elapsed = Date.now() - started;
        setMetrics((prev) => ({
          ...prev,
          [step]: {
            ...prev[step],
            runs: prev[step].runs + 1,
            success: prev[step].success + 1,
            totalMs: prev[step].totalMs + elapsed,
            retries: prev[step].retries + Math.max(0, attemptsUsed - 1),
            lastMs: elapsed,
            lastAttempts: attemptsUsed,
          },
        }));
      }

      setJob({ loading: false, message: `${label} completed`, error: '' });
      if (step) {
        setStepState((prev) => ({ ...prev, [step]: 'success' }));
        setActiveStep(null);
        setLastCompletedStep(step);
      }
      const stepTitle = step ? (pipelineSteps.find((x) => x.key === step)?.title || label) : label;
      setCompletionToast(customToast || `${stepTitle} Done`);
      return true;
    } catch (err) {
      if (step) {
        const elapsed = Date.now() - started;
        setMetrics((prev) => ({
          ...prev,
          [step]: {
            ...prev[step],
            runs: prev[step].runs + 1,
            fail: prev[step].fail + 1,
            totalMs: prev[step].totalMs + elapsed,
            lastMs: elapsed,
          },
        }));
      }
      setJob({ loading: false, message: '', error: String(err) });
      if (step) {
        setStepState((prev) => ({ ...prev, [step]: 'error' }));
        setActiveStep(null);
      }
      return false;
    }
  }

  const clearLogs = async () => {
    await clearRuntimeLogs();
    setRuntimeTask('idle');
    setRuntimeActive(false);
    setRuntimeStartedAt(null);
    setRuntimeUpdatedAt(null);
    setRuntimeMeta({});
    setRuntimeLogs([]);
  };

  const createTaskAndSwitch = async () => {
    const typed = newTaskId.trim();
    const data = await createTask(typed || undefined, typed || undefined, 'hmmer');
    const created = data.task?.id;
    await refreshTasks();
    if (created) {
      setSelectedTaskId(created);
    }
    setNewTaskId('');
  };

  const duplicateSelectedTask = async () => {
    const typed = newTaskId.trim();
    const data = await duplicateTask(selectedTaskId, typed || undefined, typed || undefined);
    const created = data.task?.id;
    await refreshTasks();
    if (created) {
      setSelectedTaskId(created);
    }
    setNewTaskId('');
  };

  const deleteSelectedTask = async () => {
    if (selectedTaskId === 'hmmer-default') {
      throw new Error('The default task cannot be deleted');
    }
    await deleteTask(selectedTaskId);
    await refreshTasks();
    setSelectedTaskId('hmmer-default');
  };

  const runReferenceStep = async () => {
    const accessionList = accessions
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    const data = await fetchReferences(accessionList, entrezEmail);
    setReferencePreview(data.preview.rows);
    if (data.fasta) {
      setReferenceFastaPath(data.fasta);
    }
    setReferenceImportNotice('');
    setRefIdentityIds([]);
    setRefIdentityMatrix([]);
  };

  const runReferenceUploadStep = async () => {
    const uploadFile = validateReferenceFastaUpload(referenceUploadFile);
    const fastaText = validateReferenceFastaText(await uploadFile.text());
    const data = await importReferenceFasta(fastaText, uploadFile.name);
    setReferencePreview(data.preview?.rows || []);
    setReferencePage(1);
    if (data.fasta) {
      setReferenceFastaPath(data.fasta);
    }
    setAccessions('');
    setReferenceUploadFile(null);
    if (referenceUploadInputRef.current) {
      referenceUploadInputRef.current.value = '';
    }
    setReferenceImportNotice(`Imported ${data.rows} reference sequences from file ${uploadFile.name}`);
    setRefIdentityIds([]);
    setRefIdentityMatrix([]);
  };

  const runRefPairwiseIdentity = async () => {
    const data = await computeRefPairwiseIdentity(referenceFastaPath || undefined);
    setRefIdentityIds(data.ids);
    setRefIdentityMatrix(data.matrix);
  };

  const runHmmBuildStep = async () => {
    const data = await buildHmm(cdhitIdentity, cdhitWordSize, referenceFastaPath, {
      coverageLong: cdhitCoverageLong,
      coverageShort: cdhitCoverageShort,
      identityLowerBound,
    });
    if (data.outputs?.hmm) {
      setHmmFile(data.outputs.hmm);
    }
    if (data.stats) {
      setHmmBuildStats(data.stats);
    }
    if ((data as any).preview?.rows?.length) {
      setCdhitPreview((data as any).preview.rows);
    } else {
      setCdhitPreview([]);
    }
    setPostCdhitIdentityIds([]);
    setPostCdhitIdentityMatrix([]);
  };

  const runPostCdhitPairwiseIdentity = async () => {
    // Use the cd-hit output file
    const cdhitFasta = referenceFastaPath
      ? referenceFastaPath.replace(/\.fasta$/, '').replace(/ref$/, 'ref_cdhit90') + '.fasta'
      : undefined;
    const data = await computeRefPairwiseIdentity(cdhitFasta);
    setPostCdhitIdentityIds(data.ids);
    setPostCdhitIdentityMatrix(data.matrix);
  };

  const runSearchStep = async () => {
    if (searchMode === 'ebi') {
      setEbiSubStepState({ submit: 'running', download: 'idle', enrich: 'idle' });
      try {
        const data = await monitorEbiHmmSearch(hmmFile, ebiDatabase);
        setEbiStageJobId(String(data.jobId || ''));
        setEbiStagePageCount(Number(data.pageCount || 1));
        setEbiStageFailedPages(null);
        setEbiStageFailedPageNumbers([]);
        setEbiSubStepState({ submit: 'success', download: 'idle', enrich: 'idle' });
      } catch (err) {
        setEbiSubStepState({ submit: 'error', download: 'idle', enrich: 'idle' });
        throw err;
      }
      return;
    }

    await runHmmSearch(targetFasta, hmmFile, { mode: searchMode, database: ebiDatabase });
    const rows = await loadAllRows('hits_all');
    setAllHmmRows(rows);
    setHitsRows(rows.slice(0, searchPageSize));
    setSearchTotalPages(Math.max(1, Math.ceil(rows.length / searchPageSize)));
    setSearchSource('hits_all');
    setSearchPage(1);
    setFilteredRows([]);
    setSelectionBoxes([]);
    draftDataRef.current = null;
    setDragMode(null);
    dragAnchorRef.current = null;
    setMovingBoxId(null);
    setHighlightTarget('');
    setPlotDomain(null);
    setEbiStageFailedPages(null);
    setEbiStageFailedPageNumbers([]);
  };

  const runEbiDownloadStep = async () => {
    if (!ebiStageJobId) {
      throw new Error('Please complete step 1 first: submit task');
    }
    setEbiSubStepState((prev) => ({ ...prev, submit: 'success', download: 'running' }));
    try {
      let data = await downloadEbiHmmSearchResults(ebiStageJobId);

      let retriesLeft = 3;
      while (data.failedPageNumbers && data.failedPageNumbers.length > 0 && retriesLeft > 0) {
        retriesLeft--;
        data = (await retryFailedEbiPages(ebiStageJobId, data.failedPageNumbers)) as any;
      }

      setEbiStageFailedPages(Number(data.failedPages || 0));
      setEbiStageFailedPageNumbers(Array.isArray(data.failedPageNumbers) ? data.failedPageNumbers : []);

      const rows = await loadAllRows('hits_all');
      setAllHmmRows(rows);
      setHitsRows(rows.slice(0, searchPageSize));
      setSearchTotalPages(Math.max(1, Math.ceil(rows.length / searchPageSize)));
      setSearchSource('hits_all');
      setSearchPage(1);
      setFilteredRows([]);
      setSelectionBoxes([]);
      draftDataRef.current = null;
      setDragMode(null);
      dragAnchorRef.current = null;
      setMovingBoxId(null);
      setHighlightTarget('');
      setPlotDomain(null);
      setEbiSubStepState((prev) => ({ ...prev, submit: 'success', download: 'success' }));
    } catch (err) {
      setEbiSubStepState((prev) => ({ ...prev, download: 'error' }));
      throw err;
    }
  };

  const runEbiUniprotStep = async () => {
    if (!selectedTaskId) return;
    try {
      setEbiSubStepState((prev) => ({ ...prev, submit: 'success', download: 'success', enrich: 'running' }));
      setJob({ loading: true, message: 'Filling in UniProt data (fetching large amounts of sequence info, running concurrently on the backend)...', error: '' });
      const res = await fillUniProt(selectedTaskId);
      if (res.ok) {
        setJob({ loading: true, message: 'UniProt fetch complete, running length consistency check...', error: '' });
        const consistency = await runSearchConsistencyCheck('hits_all');
        setConsistencyStats({
          total: consistency.total,
          checked: consistency.checked,
          mismatch: consistency.mismatch,
          filled: consistency.filled,
          source: consistency.source,
        });

        const rows = await loadAllRows('hits_all');
        setAllHmmRows(rows);
        setSearchSource('hits_all');
        const endPage = Math.min(searchPage * searchPageSize, rows.length);
        setHitsRows(rows.slice((searchPage - 1) * searchPageSize, endPage));
        setSearchTotalPages(Math.max(1, Math.ceil(rows.length / searchPageSize)));
        setEbiSubStepState((prev) => ({ ...prev, submit: 'success', download: 'success', enrich: 'success' }));
        setJob({ loading: false, message: '', error: '' });
      } else {
        setEbiSubStepState((prev) => ({ ...prev, enrich: 'error' }));
        throw new Error('Fill-in failed: ' + res.message);
      }
    } catch(err) {
      setEbiSubStepState((prev) => ({ ...prev, enrich: 'error' }));
      setJob({ loading: false, message: '', error: String(err) });
      throw err;
    }
  };

  const getNextEbiSubStep = (): EbiSubStepKey => {
    if (ebiSubStepState.submit !== 'success') return 'submit';
    if (ebiSubStepState.download !== 'success') return 'download';
    if (ebiSubStepState.enrich !== 'success') return 'enrich';
    return 'enrich';
  };

  const runNextEbiSubStep = async () => {
    const next = getNextEbiSubStep();
    if (next === 'submit') {
      await runSearchStep();
      return;
    }
    if (next === 'download') {
      await runEbiDownloadStep();
      return;
    }
    await runEbiUniprotStep();
  };

  const runFilterStep = async () => {
    const data = await filterHits(scoreMin, lenMin, lenMax);
    setFilteredRows(data.preview.rows);
    setFilterStats({ kept: Number(data.kept || 0), total: Number(data.total || 0) });
    if (data.filteredFasta) {
      setCandidateFasta(data.filteredFasta);
    }
    setSelectionBoxes([]);
    draftDataRef.current = null;
    setDragMode(null);
    dragAnchorRef.current = null;
    setMovingBoxId(null);
    setSearchSource('filtered');
    setSearchPage(1);
    setSearchTotalPages(1);
  };

  const runScoringStep = async () => {
    let customRules: ScoringRule[];
    try {
      customRules = parseScoringRulesInput(scoringRules);
      const maxScore = customRules.reduce((s, r) => s + (r.score ?? 0), 0);
      setScoringRulesError('');
      setScoringRulesSuccess(`Rules validated: ${customRules.length} rules, max score ${maxScore}`);
    } catch (err) {
      const msg = String(err);
      setScoringRulesError(msg);
      setScoringRulesSuccess('');
      throw err;
    }

    const data = await runScoring(alignmentPath, refId, threshold, {
      autoFromFiltered: false,
      filteredFasta: candidateFasta,
      referenceFasta: referenceFastaPath,
      rules: customRules,
      positionMode: scoringPositionMode,
      preAlignmentAnchor,
    });
    if (data.alignmentUsed) {
      setAlignmentPath(data.alignmentUsed);
    }
    setScoringRunInfo({
      csv: data.csv,
      alignmentUsed: data.alignmentUsed,
      autoFromFiltered: Boolean(data.autoFromFiltered),
      total: Number(data.total || 0),
      passed: Number(data.passed || 0),
      passedFasta: data.passedFasta,
      passedCount: Number(data.passedCount || 0),
      passedMissingInAlignment: Number(data.passedMissingInAlignment || 0),
      positionMode: data.positionMode || scoringPositionMode,
      preAlignmentAnchor: data.preAlignmentAnchor || preAlignmentAnchor,
      refIdUsed: data.refIdUsed ?? null,
    });
    setScoringRows(data.preview.rows);

    if (data.passedFasta) {
      setCandidateFasta(data.passedFasta);
      setNetworkSourceFasta(data.passedFasta);
    }

    if (autoDownloadScoringCsv && data.csv) {
      const { blob, fileName } = await downloadScoringCsv(data.csv);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      setScoringRulesSuccess((prev) => {
        const note = `Scoring results downloaded automatically: ${fileName}`;
        return prev ? `${prev} | ${note}` : note;
      });
    }

    try {
      const tp = await previewScoringThreshold(threshold, data.csv);
      setThresholdPreview({ total: tp.total, passed: tp.passed, ratio: tp.ratio, threshold: tp.threshold });
    } catch {
      setThresholdPreview(null);
    }
  };

  useEffect(() => {
    if (!scoringRunInfo?.csv) {
      setThresholdPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const tp = await previewScoringThreshold(threshold, scoringRunInfo.csv);
        if (!cancelled) {
          setThresholdPreview({ total: tp.total, passed: tp.passed, ratio: tp.ratio, threshold: tp.threshold });
        }
      } catch {
        if (!cancelled) {
          setThresholdPreview(null);
        }
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [threshold, scoringRunInfo?.csv]);

  const runAlignmentStep = async () => {
    const data = await prepareScoringAlignment({
      filteredFasta: candidateFasta,
      referenceFasta: referenceFastaPath,
      refId,
    });
    setAlignmentPath(data.alignment);
    setAlignmentPrepInfo({ alignment: data.alignment, records: Number(data.records || 0) });
    setAlignmentPreviewOffset(0);

    const preview = await loadScoringAlignmentPreview({
      alignment: data.alignment,
      start: alignmentPreviewStart,
      end: alignmentPreviewEnd,
      limit: alignmentPreviewLimit,
      offset: 0,
    });
    setAlignmentPreviewRows(preview.rows || []);
    setAlignmentPreviewTotalRecords(Number(preview.totalRecords || 0));
    setAlignmentPreviewLength(Number(preview.alignmentLength || 0));
  };

  const loadAlignmentPreviewPage = async (nextOffset: number) => {
    const preview = await loadScoringAlignmentPreview({
      alignment: alignmentPath,
      start: alignmentPreviewStart,
      end: alignmentPreviewEnd,
      limit: alignmentPreviewLimit,
      offset: Math.max(0, nextOffset),
    });
    setAlignmentPreviewRows(preview.rows || []);
    setAlignmentPreviewOffset(Number(preview.offset || 0));
    setAlignmentPreviewTotalRecords(Number(preview.totalRecords || 0));
    setAlignmentPreviewLength(Number(preview.alignmentLength || 0));
  };

  const runClusteringStep = async () => {
    const preferredInput = scoringRunInfo?.passedFasta || candidateFasta;
    setClusteringRunInfo(null);
    const data = await runClustering(preferredInput, clusterIdentity, clusterWordSize);
    if (data?.outputFasta) {
      setCandidateFasta(data.outputFasta);
      setNetworkSourceFasta(data.outputFasta);
    }
    setClusteringRunInfo({
      inputFasta: preferredInput,
      outputFasta: data.outputFasta,
      clusterFile: data.clusterFile,
      inputCount: data.inputCount,
      outputCount: data.outputCount,
      deduplicatedCount: data.deduplicatedCount,
      clusters: data.clusters,
    });
  };

  const skipClusteringStep = async () => {
    // Skip step 6 without triggering any comparison or network rebuild.
    setCurrentView('similarity');
  };

  const runComputeSimilarity = async () => {
    const sourceForSimilarity = (
      networkSourceFasta.trim() === 'scored_passed.fasta' && candidateFasta.trim()
    )
      ? candidateFasta.trim()
      : networkSourceFasta;
    const data = await computeNetworkSimilarity({
      includeReferenceLinks: networkIncludeReferenceLinks,
      similarityMethod: networkSimilarityMethod,
      sourceFasta: sourceForSimilarity,
      referenceFasta: networkReferenceFasta,
    });
    setNetworkStats({ nodes: data.nodes, edges: data.edges });
  };

  const confirmAndRunComputeSimilarity = async () => {
    try {
      const status = await loadNetworkSimilarityStatus();
      if (status.exists) {
        setSimilarityConfirmState({ open: true, nodeTotal: status.nodeTotal, edgeTotal: status.edgeTotal });
        return;
      }
      setJob({ loading: false, message: 'Confirmed, recomputing sequence similarity...', error: '' });
      await runAction('Compute Sequence Similarity', runComputeSimilarity, 'similarity');
    } catch (err) {
      setJob({ loading: false, message: '', error: `Pre-computation check failed: ${String(err)}` });
    }
  };

  const cancelSimilarityRecompute = () => {
    setSimilarityConfirmState((prev) => ({ ...prev, open: false }));
    setJob({ loading: false, message: 'Recomputation cancelled, similarity results unchanged', error: '' });
  };

  const startSimilarityRecomputeFromModal = () => {
    setSimilarityConfirmState((prev) => ({ ...prev, open: false }));
    setActiveStep('similarity');
    setStepState((prev) => ({ ...prev, similarity: 'running' }));
    setRuntimeTask('network/compute-similarity');
    setRuntimeMeta((prev) => ({
      ...prev,
      networkAlignProgress: { current: 0, total: 1, phase: 'prepare' },
    }));
    setJob({ loading: false, message: 'Confirmed, recomputing sequence similarity...', error: '' });
    void runAction('Compute Sequence Similarity', runComputeSimilarity, 'similarity');
  };

  const runPushToCytoscape = async () => {
    const sourceForSimilarity = (
      networkSourceFasta.trim() === 'scored_passed.fasta' && candidateFasta.trim()
    )
      ? candidateFasta.trim()
      : networkSourceFasta;

    const data = await pushNetworkToCytoscape({
      baseUrl: cytoBaseUrl,
      collection: cytoCollection,
      title: cytoNetworkTitle,
      layout: cytoLayout,
      styleName: `${cytoCategoryColumn}_style`,
      categoryColumn: cytoCategoryColumn,
      applyStyle: cytoApplyStyle,
      pairwiseThresholdPct: networkPairwiseThresholdPct,
      includeReferenceLinks: networkIncludeReferenceLinks,
      similarityMethod: networkSimilarityMethod,
      sourceFasta: sourceForSimilarity,
      referenceFasta: networkReferenceFasta,
    });
    setNetworkStats({ nodes: data.pushedNodes, edges: data.pushedEdges });
    setCytoPushInfo({
      networkSuid: data.networkSuid,
      pushedNodes: data.pushedNodes,
      pushedEdges: data.pushedEdges,
      baseUrl: data.baseUrl,
      collection: data.collection,
      title: data.title,
      layout: data.layout,
      styleName: data.styleName,
      styleApplied: data.styleApplied,
      styleError: data.styleError,
      categoryColumn: data.categoryColumn,
      layoutApplied: data.layoutApplied,
      layoutError: data.layoutError,
      generated: data.generated,
    });
  };

  const runRecommendation = async () => {
    const data = await recommendCandidates({ weights: normalizeRecommendWeights(recommendWeights), topN: recommendTopN, minClusterSize: recommendMinClusterSize, minSimilarity: recommendMinSimilarity, temperature: recommendTemperature, diversityMode: recommendDiversityMode, networkConnectivityThreshold: recommendNetworkConnectivityThreshold, predictedSubWeights: normalizePredictedSubWeights(predictedSubWeights), predictedTmTarget });
    setRecommendResults(data.candidates);
    setRecommendMeta({ totalCandidates: data.totalCandidates, totalReferences: data.totalReferences, filteredByClusterSize: data.filteredByClusterSize, filteredBySimilarity: data.filteredBySimilarity, predictedMetricsAvailable: data.predictedMetricsAvailable });
  };

  const highlightRecommendationsInNetwork = async () => {
    if (!recommendResults.length) return;
    try {
      setActiveTaskId(selectedTaskId);
      if (!browserGraphVisible || !browserGraphNodes.length || !browserGraphAllEdges.length) {
        const data = await fetchBrowserGraphData({ pairwiseThresholdPct: browserGraphThreshold });
        setBrowserGraphNodes(data.nodes);
        setBrowserGraphAllEdges(data.edges);
        setBrowserGraphLoadedThreshold(data.appliedThresholdPct);
        setBrowserGraphThreshold(data.appliedThresholdPct);
        setBrowserGraphThresholdAdjusted(Boolean(data.thresholdAdjusted));
        setBrowserGraphMaxEdges(data.maxEdges);
        setBrowserGraphVisible(true);
      }
      setCompletionToast(`Highlighted ${recommendResults.length} recommended sequences in the network; return to Similarity Network to view`);
    } catch (err: any) {
      alert('Highlight failed: ' + (err?.message || err));
    }
  };

  const clientPointToData = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const domain = plotDomain || (scatterBounds
      ? {
          xMin: scatterBounds.minScore,
          xMax: scatterBounds.maxScore,
          yMin: scatterBounds.minLength,
          yMax: scatterBounds.maxLength,
        }
      : null);
    if (!svg || !domain) return null;
    const rect = svg.getBoundingClientRect();
    const pW = Math.max(1, rect.width - CHART_M.left - CHART_M.right);
    const pH = Math.max(1, rect.height - CHART_M.top - CHART_M.bottom);
    const px = Math.min(Math.max(clientX - rect.left - CHART_M.left, 0), pW);
    const py = Math.min(Math.max(clientY - rect.top - CHART_M.top, 0), pH);
    return {
      x: domain.xMin + (px / pW) * (domain.xMax - domain.xMin),
      y: domain.yMax - (py / pH) * (domain.yMax - domain.yMin),
    };
  };

  const dataToSvgPx = (dataX: number, dataY: number) => {
    const svg = svgRef.current;
    const domain = plotDomain || (scatterBounds
      ? { xMin: scatterBounds.minScore, xMax: scatterBounds.maxScore, yMin: scatterBounds.minLength, yMax: scatterBounds.maxLength }
      : null);
    if (!svg || !domain) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const pW = Math.max(1, rect.width - CHART_M.left - CHART_M.right);
    const pH = Math.max(1, rect.height - CHART_M.top - CHART_M.bottom);
    return {
      x: CHART_M.left + (dataX - domain.xMin) / Math.max(1e-9, domain.xMax - domain.xMin) * pW,
      y: CHART_M.top + (domain.yMax - dataY) / Math.max(1e-9, domain.yMax - domain.yMin) * pH,
    };
  };

  const findBoxAtPoint = (x: number, y: number) => {
    for (let i = selectionBoxes.length - 1; i >= 0; i -= 1) {
      const b = selectionBoxes[i];
      if (x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) {
        return b;
      }
    }
    return null;
  };

  const applySelectionBoxes = (boxes: Array<{ id: number; x1: number; x2: number; y1: number; y2: number }>) => {
    if (!boxes.length) {
      setFilteredRows([]);
      return;
    }
    const selected = allHmmRows.filter((row) => {
      const score = Number(row.hmm_score ?? row.score ?? 0);
      const length = Number(row.length ?? 0);
      if (!Number.isFinite(score) || !Number.isFinite(length)) {
        return false;
      }
      return boxes.some((b) => score >= b.x1 && score <= b.x2 && length >= b.y1 && length <= b.y2);
    });
    setFilteredRows(selected);
  };

  const resetZoom = () => {
    if (!scatterBounds) {
      return;
    }
    setPlotDomain({
      xMin: scatterBounds.minScore,
      xMax: scatterBounds.maxScore,
      yMin: scatterBounds.minLength,
      yMax: scatterBounds.maxLength,
    });
  };

  const syncBoxesToFilter = () => {
    if (!selectionBoxes.length) return;
    const xMin = Math.min(...selectionBoxes.map((b) => b.x1));
    const yMin = Math.min(...selectionBoxes.map((b) => b.y1));
    const yMax = Math.max(...selectionBoxes.map((b) => b.y2));
    setScoreMin(Math.round(xMin));
    setLenMin(Math.round(yMin));
    setLenMax(Math.round(yMax));
  };

  wheelHandlerRef.current = (e: WheelEvent) => {
    if (!plotDomain || !scatterBounds) return;
    e.preventDefault();
    const center = clientPointToData(e.clientX, e.clientY);
    if (!center) return;
    const zoomIn = e.deltaY < 0;
    const factor = zoomIn ? 0.85 : 1.15;
    const nx = (plotDomain.xMax - plotDomain.xMin) * factor;
    const ny = (plotDomain.yMax - plotDomain.yMin) * factor;
    const fullX = scatterBounds.maxScore - scatterBounds.minScore;
    const fullY = scatterBounds.maxLength - scatterBounds.minLength;
    const next = {
      xMin: Math.max(scatterBounds.minScore, center.x - nx / 2),
      xMax: Math.min(scatterBounds.maxScore, center.x + nx / 2),
      yMin: Math.max(scatterBounds.minLength, center.y - ny / 2),
      yMax: Math.min(scatterBounds.maxLength, center.y + ny / 2),
    };
    if (next.xMax - next.xMin < fullX * 0.02 || next.yMax - next.yMin < fullY * 0.02) return;
    setPlotDomain(next);
  };

  const renderTailPanels = (logHeightClass: string, showRetry = false) => (
    <PageTailPanels
      showRetry={showRetry}
      retryPolicy={retryPolicy}
      setRetryPolicy={setRetryPolicy}
      retryIntervalMs={retryIntervalMs}
      setRetryIntervalMs={setRetryIntervalMs}
      jobLoading={job.loading}
      runtimeTask={runtimeTask}
      runtimeStartedAt={runtimeStartedAt}
      runtimeUpdatedAt={runtimeUpdatedAt}
      runtimeActive={runtimeActive}
      runtimeMeta={runtimeMeta}
      runtimeLogs={runtimeLogs}
      autoScrollLog={autoScrollLog}
      setAutoScrollLog={setAutoScrollLog}
      logContainerRef={logContainerRef}
      onClearLogs={clearLogs}
      logHeightClass={logHeightClass}
    />
  );

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50 text-slate-900 font-sans">
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col shadow-sm z-10">
        <div className="h-16 flex items-center justify-between px-4 border-b border-slate-200">
          <button onClick={onBack} className="flex items-center gap-2 text-indigo-600 hover:text-indigo-800 transition-colors" title="Back to home">
            <Activity className="w-6 h-6" />
            <span className="font-semibold text-lg tracking-tight text-slate-900">EnzyMiner</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-4">
          <nav className="space-y-1 px-3">
            <Section title="Overview" />
            <NavItem icon={<Settings className="w-4 h-4" />} label="Dashboard" active={currentView === 'dashboard'} onClick={() => setCurrentView('dashboard')} />

            <Section title="Pipeline Steps" />
            <NavItem icon={<List className="w-4 h-4" />} label="1. Reference Input" active={currentView === 'reference'} onClick={() => setCurrentView('reference')} />
            <NavItem icon={<Database className="w-4 h-4" />} label="2. HMM Build" active={currentView === 'hmm-build'} onClick={() => setCurrentView('hmm-build')} />
            <NavItem icon={<Filter className="w-4 h-4" />} label="3. Search & Filter" active={currentView === 'search-filter'} onClick={() => setCurrentView('search-filter')} />
            <NavItem icon={<Database className="w-4 h-4" />} label="4. Alignment" active={currentView === 'alignment'} onClick={() => setCurrentView('alignment')} />
            <NavItem icon={<CheckCircle2 className="w-4 h-4" />} label="5. Scoring" active={currentView === 'scoring'} onClick={() => setCurrentView('scoring')} />
            <NavItem icon={<Database className="w-4 h-4" />} label="6. Clustering" active={currentView === 'clustering'} onClick={() => setCurrentView('clustering')} />
            <NavItem icon={<Activity className="w-4 h-4" />} label="7. Similarity" active={currentView === 'similarity'} onClick={() => setCurrentView('similarity')} />

            <Section title="Analysis" />
            <NavItem icon={<Network className="w-4 h-4" />} label="Similarity Network" active={currentView === 'network'} onClick={() => setCurrentView('network')} />
            <NavItem icon={<Star className="w-4 h-4" />} label="Recommendation" active={currentView === 'recommendation'} onClick={() => setCurrentView('recommendation')} />
          </nav>
        </div>
      </aside>

      <main className="flex-1 flex flex-col h-full overflow-hidden">
        <header className="min-h-16 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-8 py-3 shadow-sm z-10">
          <div className="flex items-center text-sm text-slate-500 shrink-0">
            <span>Pipeline</span>
            <ChevronRight className="w-4 h-4 mx-1" />
            <span className="font-medium text-slate-900 capitalize">{currentView.replace('-', ' ')}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500">Task</span>
              <select
                className="p-1.5 border border-slate-300 rounded text-xs bg-white"
                value={selectedTaskId}
                onChange={(e) => setSelectedTaskId(e.target.value)}
                disabled={job.loading}
              >
                {taskList.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id}
                  </option>
                ))}
              </select>
              <input
                className="p-1.5 border border-slate-300 rounded text-xs w-32"
                value={newTaskId}
                onChange={(e) => setNewTaskId(e.target.value)}
                placeholder="New task ID (optional)"
                disabled={job.loading}
              />
              <button
                className="px-2 py-1.5 rounded bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
                onClick={() => runAction('Create task', createTaskAndSwitch)}
                disabled={job.loading}
              >
                New
              </button>
              <button
                className="px-2 py-1.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50"
                onClick={() => runAction('Duplicate task', duplicateSelectedTask)}
                disabled={job.loading}
              >
                Copy
              </button>
              <button
                className="px-2 py-1.5 rounded bg-red-600 text-white text-xs hover:bg-red-700 disabled:opacity-50"
                onClick={() => runAction('Delete task', deleteSelectedTask)}
                disabled={job.loading || selectedTaskId === 'hmmer-default'}
              >
                Delete
              </button>
            </div>
            <StatusBadge job={job} />
            <button
              className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
              onClick={() => setDarkMode((v) => !v)}
              title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-6xl mx-auto space-y-6">
            <PipelineProgressPanel
              stepState={stepState}
              activeStep={activeStep}
              loading={job.loading}
              lastCompletedStep={lastCompletedStep}
              ebiSubStepState={ebiSubStepState}
              showSearchSubProgress={currentView === 'search-filter' && searchMode === 'ebi'}
            />

            {job.error && (
              <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-700 text-sm whitespace-pre-wrap">
                {job.error}
              </div>
            )}
            {job.message && !job.error && (
              <div className="p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 text-sm">{job.message}</div>
            )}

            {completionToast && (
              <div className="p-3 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 text-sm step-success-pop">
                {completionToast}
              </div>
            )}

            <div key={currentView} className="view-enter">

            {currentView === 'dashboard' && (
              <div className="space-y-4">
                <h1 className="text-2xl font-semibold">EnzyMiner Candidate Screening Pipeline</h1>
                <button
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm"
                  disabled={job.loading}
                  onClick={() =>
                    runAction('Check backend status', async () => {
                      const data = await healthCheck();
                      setHealth(data);
                    })
                  }
                >
                  Check backend health
                </button>
                {health && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4 text-sm space-y-2">
                    <div>taskId: {health.taskId}</div>
                    <div>pipelineRoot: {health.pipelineRoot}</div>
                    <div>workDir: {health.workDir}</div>
                    <div>python: {health.pythonBin}</div>
                    <div className="flex gap-3 flex-wrap">
                      {Object.entries(health.tools).map(([name, ok]) => (
                        <span key={name} className={`px-2 py-1 rounded ${ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                          {name}: {String(ok)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <ObservabilityPanel metrics={metrics} />
                {renderTailPanels('h-44', true)}
              </div>
            )}

            {currentView === 'reference' && (
              <div className="space-y-4">
                <h1 className="text-2xl font-semibold">1. Reference Input & Download</h1>
                <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="text-sm font-semibold text-slate-700">Two ways to load reference sequences</div>
                    <div className="mt-1 text-sm text-slate-500">
                      Pick either one to generate this task's ref.csv and ref.fasta. Use Method A when you only have accession numbers; use Method B when you already have a local FASTA file.
                    </div>
                  </div>
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <section className="rounded-2xl border border-indigo-200 bg-indigo-50/70 p-4 space-y-3">
                      <div className="flex items-center gap-3">
                        <span className="rounded-full bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white">Method A</span>
                        <div>
                          <div className="text-sm font-semibold text-slate-800">Fetch online by accession</div>
                          <div className="text-xs text-slate-500">Suitable when you only have accession, protein_id, or UniProt ID</div>
                        </div>
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-slate-700">Entrez Email</label>
                        <input className="w-full rounded-lg border border-slate-200 bg-white p-2 text-sm" value={entrezEmail} onChange={(e) => setEntrezEmail(e.target.value)} />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-slate-700">Accession List</label>
                        <p className="mb-2 text-xs text-slate-500 leading-relaxed">
                          Supports mixed input of <strong>NCBI Protein</strong>, <strong>NCBI Nucleotide</strong>, and <strong>UniProt</strong>; the system automatically detects the source and fetches sequences.
                        </p>
                        <textarea
                          className="h-56 w-full rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs placeholder:text-slate-400"
                          value={accessions}
                          onChange={(e) => setAccessions(e.target.value)}
                          placeholder={accessionPlaceholder}
                        />
                      </div>
                      <button
                        className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700"
                        disabled={job.loading}
                        onClick={() => runAction('Download reference sequences', runReferenceStep, 'reference')}
                      >
                        Fetch online and generate ref.csv / ref.fasta
                      </button>
                    </section>
                    <section className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4 space-y-3">
                      <div className="flex items-center gap-3">
                        <span className="rounded-full bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white">Method B</span>
                        <div>
                          <div className="text-sm font-semibold text-slate-800">Upload a local FASTA file</div>
                          <div className="text-xs text-slate-500">Suitable when you already have a prepared reference sequence file and want to import it directly</div>
                        </div>
                      </div>
                      <div className="rounded-xl border border-sky-200 bg-white/80 px-3 py-2 text-xs text-slate-500">
                        Supports .fasta, .fa, .faa, .fas, .fna, .txt; single file limit 20 MB. Importing will directly overwrite the current task's reference set.
                      </div>
                      <input
                        ref={referenceUploadInputRef}
                        type="file"
                        accept=".fasta,.fa,.faa,.fas,.fna,text/plain"
                        className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-sky-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-sky-700 hover:file:bg-sky-200"
                        onChange={(e) => setReferenceUploadFile(e.target.files?.[0] || null)}
                      />
                      <div className="rounded-xl border border-dashed border-sky-300 bg-white/80 px-3 py-3 text-sm text-slate-600">
                        {referenceUploadFile
                          ? `Selected file: ${referenceUploadFile.name} · ${formatFileSize(referenceUploadFile.size)}`
                          : 'No file selected yet. Please choose a local FASTA file before importing.'}
                      </div>
                      <button
                        className="w-full rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
                        disabled={job.loading || !referenceUploadFile}
                        onClick={() => runAction('Upload reference FASTA', runReferenceUploadStep, 'reference')}
                      >
                        Upload, import, and generate ref.csv / ref.fasta
                      </button>
                    </section>
                  </div>
                  {referenceImportNotice && (
                    <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700">
                      {referenceImportNotice}
                    </div>
                  )}
                </div>
                <ReferencePreviewTable
                  rows={pagedReferenceRows}
                  allRows={referencePreview}
                  page={referencePage}
                  totalPages={referenceTotalPages}
                  onPageChange={setReferencePage}
                />
                {referencePreview.length > 0 && (
                  <div className="space-y-3">
                    <button
                      className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg text-sm"
                      disabled={job.loading}
                      onClick={() => runAction('Compute reference sequence pairwise identity', runRefPairwiseIdentity, 'reference')}
                    >
                      Compute Reference Sequence Pairwise Identity (auto-recommend CD-HIT threshold)
                    </button>
                    <IdentityHeatmap
                      ids={refIdentityIds}
                      matrix={refIdentityMatrix}
                      title="Reference Sequence Pairwise Identity Heatmap"
                      lowerBound={identityLowerBound}
                      onLowerBoundChange={setIdentityLowerBound}
                    />
                  </div>
                )}
                {renderTailPanels('h-28')}
              </div>
            )}

            {currentView === 'hmm-build' && (
              <div className="space-y-4">
                <h1 className="text-2xl font-semibold">2. HMM Build</h1>
                <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="md:col-span-4">
                    <label className="block text-sm font-medium mb-1">Reference FASTA (auto-carried from previous step; leave blank = backend default)</label>
                    <input
                      className="w-full p-2 border rounded text-sm"
                      value={referenceFastaPath}
                      onChange={(e) => setReferenceFastaPath(e.target.value)}
                      placeholder="e.g.: /path/to/ref.fasta"
                    />
                  </div>
                  <InputNum label="Identity Lower Bound (%)" value={identityLowerBound} step={0.1} onChange={setIdentityLowerBound} />
                  <InputNum label="Dedup Upper Bound (%)" value={+(cdhitIdentity * 100).toFixed(1)} step={0.1} onChange={(v) => setCdhitIdentity(v / 100)} />
                  <div className="md:col-span-2 flex items-end">
                    <button
                      className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm h-10 flex items-center justify-center gap-2 w-full"
                      disabled={job.loading}
                      onClick={() => runAction('Build HMM', runHmmBuildStep, 'hmm')}
                    >
                      <Play className="w-4 h-4" />
                      Run CD-HIT + MAFFT + hmmbuild
                    </button>
                  </div>
                </div>
                {hmmBuildStats && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                    <h3 className="text-sm font-semibold text-slate-700">CD-HIT Clustering Statistics</h3>
                    <div className="flex gap-6 text-sm flex-wrap">
                      <span>Input Sequences: <strong>{hmmBuildStats.inputCount}</strong></span>
                      {hmmBuildStats.lowerBoundRemoved && hmmBuildStats.lowerBoundRemoved.length > 0 && (
                        <span className="text-red-500">
                          Removed by lower-bound filter: <strong>{hmmBuildStats.lowerBoundRemoved.length}</strong>
                        </span>
                      )}
                      <span>→ Representative sequences after clustering: <strong>{hmmBuildStats.outputCount}</strong></span>
                      <span>Cluster count: <strong>{hmmBuildStats.clusterCount}</strong></span>
                      <span className="text-slate-400">
                        (Removed {hmmBuildStats.inputCount - hmmBuildStats.outputCount} redundant, 
                        kept {((hmmBuildStats.outputCount / Math.max(1, hmmBuildStats.inputCount)) * 100).toFixed(1)}%)
                      </span>
                    </div>
                    {hmmBuildStats.lowerBoundRemoved && hmmBuildStats.lowerBoundRemoved.length > 0 && (
                      <details className="text-xs text-red-500">
                        <summary className="cursor-pointer hover:text-red-700">View sequences removed by lower-bound filter</summary>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {hmmBuildStats.lowerBoundRemoved.map((id) => (
                            <span key={id} className="bg-red-50 px-1.5 py-0.5 rounded">{id}</span>
                          ))}
                        </div>
                      </details>
                    )}
                    {hmmBuildStats.clusters.length > 0 && hmmBuildStats.clusters.length <= 50 && (
                      <details className="text-xs text-slate-500">
                        <summary className="cursor-pointer hover:text-slate-700">Expand clustering details</summary>
                        <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-1">
                          {hmmBuildStats.clusters.map((c, i) => (
                            <span key={i} className="bg-slate-50 px-2 py-1 rounded">
                              {c.representative} ({c.size})
                            </span>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
                <ReferencePreviewTable
                  rows={pagedCdhitPreviewRows}
                  allRows={cdhitPreview}
                  page={cdhitPreviewPage}
                  totalPages={cdhitPreviewTotalPages}
                  onPageChange={setCdhitPreviewPage}
                  title="CD-HIT Post-Clustering Representative Sequences"
                />
                {hmmBuildStats && (
                  <div className="space-y-3">
                    <button
                      className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg text-sm"
                      disabled={job.loading}
                      onClick={() => runAction('Compute post-clustering pairwise identity', runPostCdhitPairwiseIdentity, 'hmm')}
                    >
                      Compute Post-Clustering Sequence Pairwise Identity
                    </button>
                    <IdentityHeatmap ids={postCdhitIdentityIds} matrix={postCdhitIdentityMatrix} title="CD-HIT Post-Clustering Pairwise Identity Heatmap" />
                  </div>
                )}
                {renderTailPanels('h-28')}
              </div>
            )}

            {currentView === 'search-filter' && (
              <div className="space-y-4">
                <h1 className="text-2xl font-semibold">3. Search & Filter</h1>
                {runtimeTask === 'search/run' && runtimeMeta?.ebiJobId && (
                  <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3 text-sm text-indigo-800">
                    EBI job is running: Job ID = {runtimeMeta.ebiJobId}
                  </div>
                )}
                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Search Mode</label>
                      <select
                        className="w-full p-2 border rounded text-sm"
                        value={searchMode}
                        onChange={(e) => setSearchMode(e.target.value as 'local' | 'ebi')}
                      >
                        <option value="local">Local hmmsearch</option>
                        <option value="ebi">EBI Online hmmsearch</option>
                      </select>
                    </div>
                    <div className="md:col-span-2 text-xs text-slate-500 self-end pb-1">
                      {searchMode === 'ebi' ? 'Currently using the EBI online server, which may be slower.' : 'Currently using local hmmsearch.'}
                    </div>
                  </div>
                  {searchMode === 'ebi' ? (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">EBI Database</label>
                      <input
                        className="w-full p-2 border rounded text-sm"
                        value={ebiDatabase}
                        onChange={(e) => setEbiDatabase(e.target.value)}
                        placeholder="refprot"
                      />
                    </div>
                  ) : (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Target FASTA path (leave blank = backend default)</label>
                      <input
                        className="w-full p-2 border rounded text-sm"
                        value={targetFasta}
                        onChange={(e) => setTargetFasta(e.target.value)}
                        placeholder="e.g.: /path/to/target.fasta"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">HMM file path (leave blank = backend default)</label>
                    <input
                      className="w-full p-2 border rounded text-sm"
                      value={hmmFile}
                      onChange={(e) => setHmmFile(e.target.value)}
                      placeholder="e.g.: /path/to/ref.hmm"
                    />
                  </div>
                  {searchMode === 'ebi' ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 overflow-x-auto pb-1">
                        {[
                          { key: 'submit' as EbiSubStepKey, title: '1. Submit task to server', desc: ebiStageJobId ? `Job ID: ${ebiStageJobId}` : 'Generate and submit EBI job' },
                          { key: 'download' as EbiSubStepKey, title: '2. Download HMMER results', desc: allHmmRows.length > 0 ? `Loaded ${allHmmRows.length}` : 'Paginated download and parse into hits_all' },
                          { key: 'enrich' as EbiSubStepKey, title: '3. Fetch lengths & consistency fill', desc: consistencyStats ? `filled=${consistencyStats.filled}` : 'Run length consistency check after filling UniProt' },
                        ].map((item, idx, arr) => {
                          const status = ebiSubStepState[item.key];
                          const isDone = status === 'success';
                          const isRunning = status === 'running';
                          const isError = status === 'error';
                          return (
                            <React.Fragment key={item.key}>
                              <div
                                className={`min-w-[220px] rounded-lg border px-3 py-2 text-xs ${
                                  isDone
                                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                                    : isRunning
                                      ? 'bg-indigo-50 border-indigo-300 text-indigo-800'
                                      : isError
                                        ? 'bg-rose-50 border-rose-300 text-rose-800'
                                        : 'bg-slate-50 border-slate-200 text-slate-600'
                                }`}
                              >
                                <div className="font-semibold">{item.title}</div>
                                <div className="mt-1 opacity-90">{item.desc}</div>
                                {isDone && <div className="mt-1 font-semibold">This stage completed</div>}
                              </div>
                              {idx < arr.length - 1 && <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />}
                            </React.Fragment>
                          );
                        })}
                      </div>

                      {ebiStageFailedPages !== null && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-800">
                          Download stage failed pages: {ebiStageFailedPages}
                          {ebiStageFailedPageNumbers.length > 0 && (
                            <span> | Failed page numbers: {ebiStageFailedPageNumbers.slice(0, 20).join(', ')}{ebiStageFailedPageNumbers.length > 20 ? ' ...' : ''}</span>
                          )}
                        </div>
                      )}

                      <button
                        className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm transition-colors disabled:bg-slate-200 disabled:text-slate-500"
                        disabled={job.loading}
                        onClick={() => {
                          const next = getNextEbiSubStep();
                          const labelMap: Record<EbiSubStepKey, string> = {
                            submit: 'Stage 1: Submit task to server',
                            download: 'Stage 2: Download HMMER results',
                            enrich: 'Stage 3: Fetch lengths & consistency fill',
                          };
                          const stepForProgress: PipelineStepKey | undefined = next === 'enrich' ? 'search' : undefined;
                          runAction(labelMap[next], runNextEbiSubStep, stepForProgress, undefined, `${labelMap[next]} Done`);
                        }}
                      >
                        <Play className="inline w-4 h-4 mr-1" />
                        {ebiSubStepState.submit === 'success' && ebiSubStepState.download === 'success' && ebiSubStepState.enrich === 'success'
                          ? 'All three stages completed (stage 3 can be re-run)'
                          : `Continue to next stage: ${getNextEbiSubStep() === 'submit' ? 'Submit task' : getNextEbiSubStep() === 'download' ? 'Download results' : 'Fetch lengths & fill'}`}
                      </button>
                    </div>
                  ) : (
                    <button
                      className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm"
                      disabled={job.loading}
                      onClick={() => runAction('Run hmmsearch', runSearchStep, 'search')}
                    >
                      <Search className="inline w-4 h-4 mr-1" />
                      Submit hmmsearch
                    </button>
                  )}

                  {typeof runtimeMeta?.uniprotProgress === 'number' && runtimeTask === 'search/uniprot-fill' && (
                    <div className="w-full mt-4 bg-slate-50 p-3 rounded-lg border border-slate-100">
                      <div className="flex justify-between text-xs text-slate-600 mb-2 font-medium">
                        <span>
                          🧬 Fetching UniProt data concurrently...
                          {runtimeMeta.uniprotPhase === 'writing' ? ' (writing result file)' : ''}
                        </span>
                        <span>{runtimeMeta.uniprotProgress}%</span>
                      </div>
                      <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
                        <div 
                          className="bg-indigo-500 h-2.5 rounded-full transition-all duration-300"
                          style={{ width: `${Math.min(100, runtimeMeta.uniprotProgress)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {typeof runtimeMeta?.consistencyProgress === 'number' && runtimeTask === 'search/consistency-check' && (
                    <div className="w-full mt-4 bg-slate-50 p-3 rounded-lg border border-slate-100">
                      <div className="flex justify-between text-xs text-slate-600 mb-2 font-medium">
                        <span>📏 Running length consistency check...</span>
                        <span>{runtimeMeta.consistencyProgress}%</span>
                      </div>
                      <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
                        <div
                          className="bg-emerald-500 h-2.5 rounded-full transition-all duration-300"
                          style={{ width: `${Math.min(100, runtimeMeta.consistencyProgress)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {runtimeMeta?.ebiDownloadProgress && runtimeTask === 'search/ebi-download' && (
                    <div className="w-full mt-4 bg-slate-50 p-3 rounded-lg border border-slate-100">
                      <div className="flex justify-between text-xs text-slate-600 mb-2 font-medium">
                        <span>⏬ Downloading and parsing result page ({runtimeMeta.ebiDownloadProgress.current} / {runtimeMeta.ebiDownloadProgress.total})</span>
                        <span>{Math.min(100, Math.round((runtimeMeta.ebiDownloadProgress.current / Math.max(1, runtimeMeta.ebiDownloadProgress.total)) * 100))}%</span>
                      </div>
                      <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
                        <div 
                          className="bg-emerald-500 h-2.5 rounded-full transition-all duration-300" 
                          style={{ width: `${Math.min(100, Math.round((runtimeMeta.ebiDownloadProgress.current / Math.max(1, runtimeMeta.ebiDownloadProgress.total)) * 100))}%` }} 
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                  <InputNum label="Min HMM Score" value={scoreMin} step={10} onChange={setScoreMin} />
                  <InputNum label="Length Min" value={lenMin} step={10} onChange={setLenMin} />
                  <InputNum label="Length Max" value={lenMax} step={10} onChange={setLenMax} />
                  <button
                    className="bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-lg text-sm h-10"
                    disabled={job.loading}
                    onClick={() => runAction('Filter hits', runFilterStep, 'search')}
                  >
                    {filterStats ? `Save filtered results (filtered ${filterStats.kept}/${filterStats.total}）` : 'Save filtered results'}
                  </button>
                </div>

                {consistencyStats && (searchMode !== 'ebi' || ebiSubStepState.enrich === 'success') && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs text-emerald-800">
                    source={consistencyStats.source} | total={consistencyStats.total} | checked={consistencyStats.checked} | mismatch={consistencyStats.mismatch} | filled={consistencyStats.filled}
                  </div>
                )}

                <div className="bg-white border border-slate-200 rounded-xl p-4 h-[420px]">
                  <div
                    ref={scatterWrapCallbackRef}
                    className={`relative h-full select-none ${dragMode === 'pan' ? 'cursor-grabbing' : 'cursor-crosshair'}`}
                    onMouseDown={(e) => {
                      // Middle-click or Ctrl+left-click → pan mode
                      if (e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey))) {
                        e.preventDefault();
                        const point = clientPointToData(e.clientX, e.clientY);
                        if (!point) return;
                        setDragMode('pan');
                        dragAnchorRef.current = point;
                        return;
                      }
                      const point = clientPointToData(e.clientX, e.clientY);
                      if (!point) return;
                      const hitBox = findBoxAtPoint(point.x, point.y);
                      if (hitBox && !e.shiftKey) {
                        setDragMode('move');
                        setMovingBoxId(hitBox.id);
                        dragAnchorRef.current = point;
                        return;
                      }
                      setDragMode('draw');
                      additiveDrawRef.current = e.shiftKey;
                      dragAnchorRef.current = point;
                      draftDataRef.current = { x1: point.x, x2: point.x, y1: point.y, y2: point.y };
                      const el = draftOverlayRef.current;
                      if (el) {
                        const px = dataToSvgPx(point.x, point.y);
                        el.setAttribute('x', String(px.x));
                        el.setAttribute('y', String(px.y));
                        el.setAttribute('width', '0');
                        el.setAttribute('height', '0');
                        el.style.display = '';
                      }
                    }}
                    onMouseMove={(e) => {
                      if (!dragMode) return;
                      if (dragMode === 'draw' && dragAnchorRef.current) {
                        const anchor = dragAnchorRef.current;
                        const point = clientPointToData(e.clientX, e.clientY);
                        if (!point) return;
                        const draft = {
                          x1: Math.min(anchor.x, point.x),
                          x2: Math.max(anchor.x, point.x),
                          y1: Math.min(anchor.y, point.y),
                          y2: Math.max(anchor.y, point.y),
                        };
                        draftDataRef.current = draft;
                        const el = draftOverlayRef.current;
                        if (el) {
                          const tl = dataToSvgPx(draft.x1, draft.y2);
                          const br = dataToSvgPx(draft.x2, draft.y1);
                          el.setAttribute('x', String(tl.x));
                          el.setAttribute('y', String(tl.y));
                          el.setAttribute('width', String(Math.max(0, br.x - tl.x)));
                          el.setAttribute('height', String(Math.max(0, br.y - tl.y)));
                        }
                        return;
                      }
                      if (dragMode === 'move' && dragAnchorRef.current && movingBoxId !== null) {
                        const point = clientPointToData(e.clientX, e.clientY);
                        if (!point) return;
                        const prev = dragAnchorRef.current;
                        const dx = point.x - prev.x;
                        const dy = point.y - prev.y;
                        dragAnchorRef.current = point;
                        if (!moveRafRef.current) {
                          moveRafRef.current = requestAnimationFrame(() => {
                            moveRafRef.current = 0;
                            setSelectionBoxes((boxes) =>
                              boxes.map((b) =>
                                b.id === movingBoxId
                                  ? { ...b, x1: b.x1 + dx, x2: b.x2 + dx, y1: b.y1 + dy, y2: b.y2 + dy }
                                  : b,
                              ),
                            );
                          });
                        }
                      }
                      if (dragMode === 'pan' && dragAnchorRef.current && plotDomain) {
                        const point = clientPointToData(e.clientX, e.clientY);
                        if (!point) return;
                        const prev = dragAnchorRef.current;
                        const ddx = prev.x - point.x;
                        const ddy = prev.y - point.y;
                        setPlotDomain((d) => d ? {
                          xMin: d.xMin + ddx,
                          xMax: d.xMax + ddx,
                          yMin: d.yMin + ddy,
                          yMax: d.yMax + ddy,
                        } : d);
                      }
                    }}
                    onMouseUp={() => {
                      if (dragMode === 'draw' && draftDataRef.current) {
                        const d = draftDataRef.current;
                        const minSize = 0.0001;
                        if (Math.abs(d.x2 - d.x1) > minSize && Math.abs(d.y2 - d.y1) > minSize) {
                          const newBox = { id: nextBoxIdRef.current++, ...d };
                          const nextBoxes = additiveDrawRef.current ? [...selectionBoxes, newBox] : [newBox];
                          setSelectionBoxes(nextBoxes);
                          applySelectionBoxes(nextBoxes);
                        }
                      }
                      if (dragMode === 'move') {
                        applySelectionBoxes(selectionBoxes);
                      }
                      draftDataRef.current = null;
                      dragAnchorRef.current = null;
                      setDragMode(null);
                      setMovingBoxId(null);
                      if (draftOverlayRef.current) draftOverlayRef.current.style.display = 'none';
                    }}
                    onMouseLeave={() => {
                      if (dragMode) {
                        draftDataRef.current = null;
                        dragAnchorRef.current = null;
                        setDragMode(null);
                        setMovingBoxId(null);
                        if (draftOverlayRef.current) draftOverlayRef.current.style.display = 'none';
                      }
                    }}
                  >
                    {(() => {
                      const W = svgSize.w;
                      const H = svgSize.h;
                      const pW = Math.max(1, W - CHART_M.left - CHART_M.right);
                      const pH = Math.max(1, H - CHART_M.top - CHART_M.bottom);
                      const dom = plotDomain ?? (scatterBounds
                        ? { xMin: scatterBounds.minScore, xMax: scatterBounds.maxScore, yMin: scatterBounds.minLength, yMax: scatterBounds.maxLength }
                        : null);
                      if (!dom || !W) return <div className="flex items-center justify-center h-full text-slate-400 text-sm">{hitsRows.length ? 'Loading data...' : 'No data yet'}</div>;
                      const xRange = dom.xMax - dom.xMin;
                      const yRange = dom.yMax - dom.yMin;
                      if (xRange <= 0 || yRange <= 0) return <div className="flex items-center justify-center h-full text-slate-400 text-sm">Data range is zero, cannot plot</div>;
                      const dx = (v: number) => CHART_M.left + (v - dom.xMin) / Math.max(1e-9, dom.xMax - dom.xMin) * pW;
                      const dy = (v: number) => CHART_M.top + (dom.yMax - v) / Math.max(1e-9, dom.yMax - dom.yMin) * pH;
                      const xTicks = niceTickValues(dom.xMin, dom.xMax, Math.max(3, Math.floor(pW / 80)));
                      const yTicks = niceTickValues(dom.yMin, dom.yMax, Math.max(3, Math.floor(pH / 50)));
                      const fmtTick = (v: number) => Math.abs(v) >= 1000 ? v.toFixed(0) : v.toPrecision(4).replace(/\.?0+$/, '');
                      return (
                        <svg ref={svgRef} width={W} height={H} className="block">
                          <defs>
                            <clipPath id="scatter-clip"><rect x={CHART_M.left} y={CHART_M.top} width={pW} height={pH} /></clipPath>
                          </defs>
                          {/* Plot background */}
                          <rect x={CHART_M.left} y={CHART_M.top} width={pW} height={pH} fill="#f8fafc" />
                          {/* Grid */}
                          {xTicks.map((v) => <line key={`gx${v}`} x1={dx(v)} x2={dx(v)} y1={CHART_M.top} y2={CHART_M.top + pH} stroke="#e2e8f0" strokeDasharray="3 3" shapeRendering="crispEdges" />)}
                          {yTicks.map((v) => <line key={`gy${v}`} x1={CHART_M.left} x2={CHART_M.left + pW} y1={dy(v)} y2={dy(v)} stroke="#e2e8f0" strokeDasharray="3 3" shapeRendering="crispEdges" />)}
                          {/* Clipped content */}
                          <g clipPath="url(#scatter-clip)">
                            {/* Reference lines */}
                            <line x1={dx(scoreMin)} x2={dx(scoreMin)} y1={CHART_M.top} y2={CHART_M.top + pH} stroke="#f59e0b" strokeDasharray="6 3" strokeWidth={1.5} />
                            <line x1={CHART_M.left} x2={CHART_M.left + pW} y1={dy(lenMin)} y2={dy(lenMin)} stroke="#10b981" strokeDasharray="6 3" strokeWidth={1.5} />
                            <line x1={CHART_M.left} x2={CHART_M.left + pW} y1={dy(lenMax)} y2={dy(lenMax)} stroke="#10b981" strokeDasharray="6 3" strokeWidth={1.5} />
                            {/* Reference line labels */}
                            <text x={dx(scoreMin) + 4} y={CHART_M.top + 14} fontSize={10} fill="#d97706" fontWeight={500}>Score≥{scoreMin}</text>
                            <text x={CHART_M.left + pW - 4} y={dy(lenMin) - 5} fontSize={10} fill="#059669" textAnchor="end" fontWeight={500}>Len≥{lenMin}</text>
                            <text x={CHART_M.left + pW - 4} y={dy(lenMax) + 14} fontSize={10} fill="#059669" textAnchor="end" fontWeight={500}>Len≤{lenMax}</text>
                            {/* Data points */}
                            {scatterData.map((d, i) => (
                              <circle key={i} cx={dx(d.score)} cy={dy(d.length)} r={2.5} fill="#6366f1" opacity={0.55}>
                                <title>{`${d.target}\nScore: ${d.score.toFixed(1)}\nLength: ${d.length}`}</title>
                              </circle>
                            ))}
                            {/* Highlighted points */}
                            {highlightedPoint.map((d, i) => (
                              <circle key={`hl${i}`} cx={dx(d.score)} cy={dy(d.length)} r={4.5} fill="#ef4444" stroke="#fff" strokeWidth={1} />
                            ))}
                            {/* Selection boxes */}
                            {selectionBoxes.map((b) => (
                              <rect key={b.id} x={dx(b.x1)} y={dy(b.y2)} width={Math.max(0, dx(b.x2) - dx(b.x1))} height={Math.max(0, dy(b.y1) - dy(b.y2))}
                                fill="rgba(99,102,241,0.12)" stroke="#6366f1" strokeWidth={1.5} rx={2} />
                            ))}
                            {/* Draft selection rect */}
                            <rect ref={draftOverlayRef} style={{ display: 'none' }} fill="rgba(99,102,241,0.2)" stroke="#6366f1" strokeWidth={2} rx={2} />
                          </g>
                          {/* X axis */}
                          <line x1={CHART_M.left} x2={CHART_M.left + pW} y1={CHART_M.top + pH} y2={CHART_M.top + pH} stroke="#94a3b8" strokeWidth={1} />
                          {xTicks.map((v) => (
                            <g key={`xt${v}`}>
                              <line x1={dx(v)} x2={dx(v)} y1={CHART_M.top + pH} y2={CHART_M.top + pH + 5} stroke="#94a3b8" />
                              <text x={dx(v)} y={CHART_M.top + pH + 18} textAnchor="middle" fontSize={11} fill="#64748b">{fmtTick(v)}</text>
                            </g>
                          ))}
                          <text x={CHART_M.left + pW / 2} y={H - 4} textAnchor="middle" fontSize={13} fill="#475569" fontWeight={600}>HMM Score</text>
                          {/* Y axis */}
                          <line x1={CHART_M.left} x2={CHART_M.left} y1={CHART_M.top} y2={CHART_M.top + pH} stroke="#94a3b8" strokeWidth={1} />
                          {yTicks.map((v) => (
                            <g key={`yt${v}`}>
                              <line x1={CHART_M.left - 5} x2={CHART_M.left} y1={dy(v)} y2={dy(v)} stroke="#94a3b8" />
                              <text x={CHART_M.left - 8} y={dy(v) + 4} textAnchor="end" fontSize={11} fill="#64748b">{fmtTick(v)}</text>
                            </g>
                          ))}
                          <text x={16} y={CHART_M.top + pH / 2} textAnchor="middle" fontSize={13} fill="#475569" fontWeight={600}
                            transform={`rotate(-90,16,${CHART_M.top + pH / 2})`}>Seq Length</text>
                          {/* Plot border */}
                          <rect x={CHART_M.left} y={CHART_M.top} width={pW} height={pH} fill="none" stroke="#cbd5e1" strokeWidth={0.5} />
                        </svg>
                      );
                    })()}
                  </div>
                </div>

                <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 text-sm flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    {selectionBoxes.length ? (
                      <span>
                        Selected {selectionBoxes.length} region(s), matched {filteredRows.length} hit(s). Shift + drag to add a new selection box; drag an existing box to move it.
                      </span>
                    ) : (
                      <span>Showing all HMM results by default. Drag on the chart to draw a filter box, scroll to zoom, Shift + drag for multiple selection boxes.</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="px-3 py-1.5 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-100"
                      onClick={resetZoom}
                    >
                      Reset Zoom
                    </button>
                    <button
                      className="px-3 py-1.5 rounded border border-amber-300 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                      disabled={!selectionBoxes.length}
                      onClick={syncBoxesToFilter}
                      title="Sync the selection box bounds to the filter inputs above"
                    >
                      Sync to Filter
                    </button>
                    <button
                      className="px-3 py-1.5 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                      disabled={!selectionBoxes.length}
                      onClick={() => {
                        setSelectionBoxes([]);
                        draftDataRef.current = null;
                        setFilteredRows([]);
                        if (draftOverlayRef.current) draftOverlayRef.current.style.display = 'none';
                      }}
                    >
                      Clear Selection
                    </button>
                    <button
                      className="px-3 py-1.5 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                      disabled={!filteredRows.length || job.loading}
                      onClick={() =>
                        runAction('Save selection results to backend', async () => {
                          const targets: string[] = Array.from(
                            new Set<string>(filteredRows.map((r) => String(r.target ?? '')).filter(Boolean)),
                          );
                          const data = await filterHitsByTargets(targets);
                          setFilteredRows(data.preview.rows);
                          if (data.filteredFasta) {
                            setCandidateFasta(data.filteredFasta);
                          }
                          setSearchSource('filtered');
                          setSearchPage(1);
                          setSearchTotalPages(1);
                        }, 'search')
                      }
                    >
                      Save Selection as Backend Filter
                    </button>
                  </div>
                </div>

                <SimpleTable
                  rows={filteredRows.length ? filteredRows : hitsRows}
                  highlightValue={highlightTarget}
                  highlightColumn="target"
                  onRowClick={(row) => setHighlightTarget(String(row.target ?? ''))}
                />

                <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center gap-3 flex-wrap">
                  <button
                    className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
                    disabled={job.loading || searchPage <= 1 || selectionBoxes.length > 0}
                    onClick={() =>
                      runAction('Load previous page', async () => {
                        const target = Math.max(1, searchPage - 1);
                        const data = await loadSearchPage(target, searchPageSize, searchSource);
                        if (searchSource === 'filtered') {
                          setFilteredRows(data.preview.rows);
                        } else {
                          setHitsRows(data.preview.rows);
                        }
                        setSearchPage(data.page);
                        setSearchTotalPages(data.totalPages);
                      })
                    }
                  >
                    Previous Page
                  </button>
                  <button
                    className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
                    disabled={job.loading || selectionBoxes.length > 0}
                    onClick={() =>
                      runAction('Refresh current page', async () => {
                        const data = await loadSearchPage(searchPage, searchPageSize, searchSource);
                        if (searchSource === 'filtered') {
                          setFilteredRows(data.preview.rows);
                        } else {
                          setHitsRows(data.preview.rows);
                        }
                        setSearchPage(data.page);
                        setSearchTotalPages(data.totalPages);
                      })
                    }
                  >
                    Refresh
                  </button>
                  <button
                    className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
                    disabled={job.loading || searchPage >= searchTotalPages || selectionBoxes.length > 0}
                    onClick={() =>
                      runAction('Load next page', async () => {
                        const target = searchPage + 1;
                        const data = await loadSearchPage(target, searchPageSize, searchSource);
                        if (searchSource === 'filtered') {
                          setFilteredRows(data.preview.rows);
                        } else {
                          setHitsRows(data.preview.rows);
                        }
                        setSearchPage(data.page);
                        setSearchTotalPages(data.totalPages);
                      })
                    }
                  >
                    Next Page
                  </button>
                  <span className="text-sm text-slate-600">
                    Data source: {searchSource} | Page {searchPage} / {searchTotalPages} {selectionBoxes.length > 0 ? '| Selecting (pagination locked)' : ''}
                  </span>
                </div>
                {renderTailPanels('h-36')}
              </div>
            )}

            {currentView === 'alignment' && (
              <div className="space-y-4">
                <h1 className="text-2xl font-semibold">4. Alignment (MAFFT)</h1>
                <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Filter FASTA (leave blank = backend default)</label>
                    <input className="w-full p-2 border rounded text-sm" value={candidateFasta} onChange={(e) => setCandidateFasta(e.target.value)} placeholder="e.g.: /path/to/hits_filtered.fasta" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Reference FASTA (leave blank = backend default)</label>
                    <input className="w-full p-2 border rounded text-sm" value={referenceFastaPath} onChange={(e) => setReferenceFastaPath(e.target.value)} placeholder="e.g.: /path/to/ref.fasta" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Reference Sequence ID</label>
                    <input className="w-full p-2 border rounded text-sm" value={refId} onChange={(e) => setRefId(e.target.value)} placeholder="Leave blank = automatically use the first reference sequence" />
                  </div>
                  <button
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm h-10"
                    disabled={job.loading}
                    onClick={() => runAction('Generate alignment file', runAlignmentStep, 'alignment')}
                  >
                    Generate Alignment and Load Preview
                  </button>
                </div>

                {runtimeMeta?.alignmentProgress && runtimeTask === 'scoring/prepare-alignment' && job.loading && (
                  <div className="w-full bg-slate-50 p-3 rounded-lg border border-slate-100">
                    <div className="flex justify-between text-xs text-slate-600 mb-2 font-medium">
                      <span>
                        🧬 Preparing Alignment
                        {runtimeMeta.alignmentProgress.phase ? `（${runtimeMeta.alignmentProgress.phase}）` : ''}
                        ：{runtimeMeta.alignmentProgress.current} / {runtimeMeta.alignmentProgress.total}
                      </span>
                      <span>
                        {Math.min(100, Math.round((runtimeMeta.alignmentProgress.current / Math.max(1, runtimeMeta.alignmentProgress.total)) * 100))}%
                      </span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
                      <div
                        className="bg-indigo-500 h-2.5 rounded-full transition-all duration-300"
                        style={{
                          width: `${Math.min(100, Math.round((runtimeMeta.alignmentProgress.current / Math.max(1, runtimeMeta.alignmentProgress.total)) * 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
                    <InputNum label="Column Start" value={alignmentPreviewStart} step={10} onChange={(v) => setAlignmentPreviewStart(Math.max(1, Math.floor(v)))} />
                    <InputNum label="Column End" value={alignmentPreviewEnd} step={10} onChange={(v) => setAlignmentPreviewEnd(Math.max(1, Math.floor(v)))} />
                    <div className="text-xs text-slate-600 md:col-span-2">
                      Alignment file: {alignmentPath || '(none)'}
                    </div>
                    <button
                      className="px-3 py-2 rounded border border-slate-300 text-sm"
                      disabled={job.loading || !alignmentPath}
                      onClick={() => runAction('Refresh alignment preview', async () => {
                        await loadAlignmentPreviewPage(0);
                      })}
                    >
                      Refresh Preview
                    </button>
                    <div className="text-xs text-slate-600">
                      rows: {alignmentPreviewRows.length}/{alignmentPreviewTotalRecords} | alnLen: {alignmentPreviewLength}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
                      disabled={job.loading || alignmentPreviewOffset <= 0 || !alignmentPath}
                      onClick={() => runAction('Previous alignment preview page', async () => {
                        await loadAlignmentPreviewPage(Math.max(0, alignmentPreviewOffset - alignmentPreviewLimit));
                      })}
                    >
                      Previous Page
                    </button>
                    <button
                      className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
                      disabled={job.loading || alignmentPreviewOffset + alignmentPreviewLimit >= alignmentPreviewTotalRecords || !alignmentPath}
                      onClick={() => runAction('Next alignment preview page', async () => {
                        await loadAlignmentPreviewPage(alignmentPreviewOffset + alignmentPreviewLimit);
                      })}
                    >
                      Next Page
                    </button>
                    <span className="text-xs text-slate-500">
                      offset: {alignmentPreviewOffset}
                    </span>
                  </div>

                  <div className="overflow-auto border rounded">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 border-b">
                        <tr>
                          <th className="px-2 py-2 text-left">ID</th>
                          <th className="px-2 py-2 text-left">Alignment Segment (Interactive Window)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {alignmentPreviewRows.map((r, idx) => (
                          <tr key={`${r.id}-${idx}`} className="border-b last:border-b-0">
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.id}</td>
                            <td className="px-2 py-1.5 font-mono text-[11px]">{r.segment}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                {renderTailPanels('h-28')}
              </div>
            )}

            {currentView === 'scoring' && (
              <div className="space-y-4">
                <h1 className="text-2xl font-semibold">5. Active Site Scoring</h1>
                <div className="bg-white border border-slate-200 rounded-xl p-3 text-sm text-slate-700 space-y-1.5">
                  <div className="font-semibold text-slate-900">Current Run Status</div>
                  <div className="text-xs text-slate-600">
                    Most recent alignment file: {(scoringRunInfo?.alignmentUsed || alignmentPath || '(none)')}
                  </div>
                  <div className="text-xs text-slate-600">
                    Current position mode:
                    {scoringPositionMode === 'pre' ? 'Pre-alignment residue number' : 'Post-alignment column number'}
                    {scoringPositionMode === 'pre'
                      ? (preAlignmentAnchor === 'first' ? ' (default: follows the first sequence)' : ` (anchored by reference ID: ${refId || '(empty)'})`)
                      : ''}
                  </div>
                  {scoringRunInfo && (
                    <div className="text-xs text-slate-600">
                      Most recent scoring: {scoringRunInfo.passed}/{scoringRunInfo.total} passed threshold
                    </div>
                  )}
                  {scoringRunInfo?.passedFasta && (
                    <div className="text-xs text-slate-600">
                      Threshold filter module: exported FASTA of passing sequences ({scoringRunInfo.passedCount || 0}) → path {scoringRunInfo.passedFasta}
                    </div>
                  )}
                  {alignmentPrepInfo && (
                    <div className="text-xs text-slate-600">
                      Most recent alignment-only run: records={alignmentPrepInfo.records} | {alignmentPrepInfo.alignment}
                    </div>
                  )}
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Alignment path (leave blank = backend default)</label>
                    <input className="w-full p-2 border rounded text-sm" value={alignmentPath} onChange={(e) => setAlignmentPath(e.target.value)} placeholder="e.g.: /path/to/alignment.fasta" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Reference Sequence ID</label>
                    <input className="w-full p-2 border rounded text-sm" value={refId} onChange={(e) => setRefId(e.target.value)} placeholder="Leave blank = automatically use the first reference sequence" />
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Position Coordinate Mode</label>
                    <select
                      className="w-full p-2 border rounded text-sm"
                      value={scoringPositionMode}
                      onChange={(e) => setScoringPositionMode((e.target.value === 'aligned' ? 'aligned' : 'pre'))}
                    >
                      <option value="pre">Pre-alignment (residue number)</option>
                      <option value="aligned">Post-alignment (MSA column number)</option>
                    </select>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-slate-700 pb-2">
                    <input
                      type="checkbox"
                      checked={preAlignmentAnchor === 'refid'}
                      disabled={scoringPositionMode !== 'pre'}
                      onChange={(e) => setPreAlignmentAnchor(e.target.checked ? 'refid' : 'first')}
                    />
                    Use reference ID anchoring in pre-alignment mode (off = default to the first sequence)
                  </label>
                  <div className="text-xs text-slate-500 pb-2">
                    Pre-alignment: automatically maps anchor sequence residue numbers to MSA columns; Post-alignment: treats pos directly as the column number.
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="text-sm text-slate-700">Scoring Rules (directly editable)</div>
                    <div className="text-xs text-slate-500">Current rule count: {scoringRules.length}</div>
                  </div>

                  <div className="overflow-auto border rounded">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 border-b">
                        <tr>
                          <th className="px-2 py-2 text-left">Pos</th>
                          <th className="px-2 py-2 text-left">Allowed (comma separated)</th>
                          <th className="px-2 py-2 text-left">Score</th>
                          <th className="px-2 py-2 text-left">Label</th>
                          <th className="px-2 py-2 text-left">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scoringRules.map((rule, idx) => (
                          <tr key={`${rule.label}-${idx}`} className="border-b last:border-b-0">
                            <td className="px-2 py-1.5">
                              <input
                                type="number"
                                className="w-24 p-1 border rounded"
                                value={rule.pos}
                                onChange={(e) => {
                                  const pos = Number(e.target.value);
                                  setScoringRules((prev) => prev.map((r, i) => (i === idx ? { ...r, pos } : r)));
                                  setScoringRulesSuccess('');
                                }}
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                className="w-full p-1 border rounded font-mono"
                                value={scoringAllowedDrafts[idx] ?? rule.allowed.join(',')}
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  const allowed = parseAllowedInput(raw);
                                  setScoringAllowedDrafts((prev) => ({ ...prev, [idx]: raw }));
                                  setScoringRules((prev) => prev.map((r, i) => (i === idx ? { ...r, allowed } : r)));
                                  setScoringRulesSuccess('');
                                }}
                                onBlur={(e) => {
                                  const normalized = parseAllowedInput(e.target.value).join(',');
                                  setScoringAllowedDrafts((prev) => ({ ...prev, [idx]: normalized }));
                                }}
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="number"
                                step="0.1"
                                className="w-24 p-1 border rounded"
                                value={rule.score}
                                onChange={(e) => {
                                  const score = Number(e.target.value);
                                  setScoringRules((prev) => prev.map((r, i) => (i === idx ? { ...r, score } : r)));
                                  setScoringRulesSuccess('');
                                }}
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                className="w-full p-1 border rounded"
                                value={rule.label}
                                onChange={(e) => {
                                  const label = e.target.value;
                                  setScoringRules((prev) => prev.map((r, i) => (i === idx ? { ...r, label } : r)));
                                  setScoringRulesSuccess('');
                                }}
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <button
                                className="px-2 py-1 border rounded text-red-700 border-red-300 disabled:opacity-50"
                                onClick={() => {
                                  setScoringRules((prev) => prev.filter((_, i) => i !== idx));
                                  setScoringAllowedDrafts({});
                                  setScoringRulesSuccess('');
                                }}
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      className="px-3 py-1.5 rounded border border-emerald-300 text-sm text-emerald-700 hover:bg-emerald-50"
                      onClick={() => {
                        setScoringRules(clonePeAaoScoringRules());
                        setScoringAllowedDrafts({});
                        setScoringRulesError('');
                        const maxScore = peAaoScoringRules.reduce((s, r) => s + (r.score ?? 0), 0);
                        setScoringRulesSuccess(`Applied PeAAO rule template: ${peAaoScoringRules.length} rules, max score ${maxScore}`);
                      }}
                    >
                      Apply PeAAO Rule Template (Overwrite)
                    </button>
                    <button
                      className="px-3 py-1.5 rounded border border-slate-300 text-sm hover:bg-slate-50"
                      onClick={() => {
                        setScoringRules((prev) => [
                          ...prev,
                          {
                            pos: 1,
                            allowed: ['A'],
                            score: 0,
                            label: `rule_${prev.length + 1}`,
                          },
                        ]);
                        setScoringAllowedDrafts({});
                        setScoringRulesSuccess('');
                      }}
                    >
                      Add Rule
                    </button>
                    <button
                      className="px-3 py-1.5 rounded border border-slate-300 text-sm hover:bg-slate-50"
                      onClick={() => rulesImportRef.current?.click()}
                    >
                      Import Rules JSON
                    </button>
                    <button
                      className="px-3 py-1.5 rounded border border-slate-300 text-sm hover:bg-slate-50"
                      onClick={() => {
                        const text = JSON.stringify(scoringRules, null, 2);
                        const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'scoring_rules.json';
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      Export Rules JSON
                    </button>
                    <input
                      ref={rulesImportRef}
                      type="file"
                      accept="application/json,.json"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) {
                          return;
                        }
                        try {
                          const text = await file.text();
                          const parsed = parseScoringRulesInput(JSON.parse(text));
                          setScoringRules(parsed);
                          setScoringAllowedDrafts({});
                          setScoringRulesError('');
                          const maxScore = parsed.reduce((s, r) => s + (r.score ?? 0), 0);
                          setScoringRulesSuccess(`Import successful, ${parsed.length} rules, max score ${maxScore}`);
                        } catch (err) {
                          setScoringRulesError(`Import failed: ${String(err)}`);
                          setScoringRulesSuccess('');
                        } finally {
                          e.currentTarget.value = '';
                        }
                      }}
                    />
                    <div className="text-xs text-slate-500">Supports importing/exporting JSON; fields are pos / allowed / score / label; allowed may include "Uni"</div>
                  </div>

                  {scoringRulesError && (
                    <div className="text-xs text-red-600 border border-red-200 bg-red-50 rounded p-2">{scoringRulesError}</div>
                  )}

                  {scoringRulesSuccess && !scoringRulesError && (
                    <div className="text-xs text-emerald-700 border border-emerald-200 bg-emerald-50 rounded p-2">
                      {scoringRulesSuccess}
                    </div>
                  )}

                  <button
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm h-10"
                    disabled={job.loading || Boolean(scoringRulesError)}
                    title={
                      scoringRulesError
                        ? `Rule validation failed: ${scoringRulesError}`
                        : 'Run Scoring (Based on Step 4 Alignment)'
                    }
                    onClick={() => runAction('Run active-site scoring', runScoringStep, 'scoring')}
                  >
                    Run Scoring (Based on Step 4 Alignment)
                  </button>

                  <div className="pt-1 border-t border-slate-100">
                    <label className="flex items-center gap-2 text-sm text-slate-700 pb-2">
                      <input
                        type="checkbox"
                        checked={autoDownloadScoringCsv}
                        onChange={(e) => setAutoDownloadScoringCsv(e.target.checked)}
                      />
                      Automatically download the full CSV after scoring succeeds
                    </label>
                    <InputNum label="Threshold (set after scoring)" value={threshold} step={0.1} onChange={setThreshold} />
                    <div className="text-xs text-slate-500 mt-1">Recommended to run scoring first, then adjust the threshold based on results and re-run the statistics.</div>
                    {thresholdPreview && (
                      <div className="mt-2 text-xs text-indigo-700 border border-indigo-200 bg-indigo-50 rounded p-2">
                        Threshold estimate (based on current scored_results.csv): at threshold {thresholdPreview.threshold}, {thresholdPreview.passed}/{thresholdPreview.total}（{(thresholdPreview.ratio * 100).toFixed(1)}%）.
                        To have clustering use this threshold result, please re-run scoring.
                      </div>
                    )}
                  </div>

                  {Boolean(scoringRulesError) && (
                    <div className="text-xs text-amber-700 border border-amber-200 bg-amber-50 rounded p-2">
                      There are errors in the current rules; scoring is disabled. Please fix the red error messages above first.
                    </div>
                  )}
                </div>
                <SimpleTable rows={scoringRows} />
                {renderTailPanels('h-28')}
              </div>
            )}

            {currentView === 'clustering' && (
              <div className="space-y-4">
                <h1 className="text-2xl font-semibold">6. Clustering & Export</h1>
                <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Candidate FASTA path (leave blank = backend default)</label>
                    <input className="w-full p-2 border rounded text-sm" value={candidateFasta} onChange={(e) => setCandidateFasta(e.target.value)} placeholder="e.g.: /path/to/hits_filtered.fasta" />
                  </div>
                  <InputNum label="Identity (-c)" value={clusterIdentity} step={0.01} onChange={setClusterIdentity} />
                  <InputNum label="Word size (-n)" value={clusterWordSize} step={1} onChange={setClusterWordSize} />
                  <button
                    className="bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-lg text-sm h-10"
                    disabled={job.loading}
                    onClick={() => runAction(`Run CD-HIT ${Math.round(clusterIdentity * 100)}%`, runClusteringStep, 'clustering')}
                  >
                    Run clustering
                  </button>
                  <button
                    className="bg-slate-100 hover:bg-slate-200 text-slate-800 px-4 py-2 rounded-lg text-sm h-10 border border-slate-300"
                    disabled={job.loading}
                    onClick={() => runAction('Skip Clustering', skipClusteringStep, 'clustering', 0, '6. Clustering skipped, no alignment performed')}
                  >
                    Skip Clustering, Proceed to Similarity
                  </button>
                </div>
                <div className="text-xs text-slate-500">
                  Step 6 only handles CD-HIT; if skipped, no alignment is triggered. Sequence alignment is only performed after clicking “Compute Sequence Similarity” on the Similarity page.
                </div>
                {clusteringRunInfo && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-3 text-sm text-emerald-950">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <h2 className="text-base font-semibold text-emerald-900">Clustering Results</h2>
                      <span className="text-xs text-emerald-700">
                        Identity {Math.round(clusterIdentity * 100)}% · Word Size {clusterWordSize}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                        <div className="text-xs text-emerald-700">Input Sequences</div>
                        <div className="text-xl font-semibold">{clusteringRunInfo.inputCount}</div>
                      </div>
                      <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                        <div className="text-xs text-emerald-700">Kept After Dedup</div>
                        <div className="text-xl font-semibold">{clusteringRunInfo.outputCount}</div>
                      </div>
                      <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                        <div className="text-xs text-emerald-700">Removed by Dedup</div>
                        <div className="text-xl font-semibold">{clusteringRunInfo.deduplicatedCount}</div>
                      </div>
                      <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                        <div className="text-xs text-emerald-700">Cluster Count</div>
                        <div className="text-xl font-semibold">{clusteringRunInfo.clusters}</div>
                      </div>
                    </div>
                    <div className="text-xs text-emerald-800 space-y-1 break-all">
                      <div>Input: {clusteringRunInfo.inputFasta}</div>
                      <div>Output FASTA: {clusteringRunInfo.outputFasta}</div>
                      <div>Cluster file: {clusteringRunInfo.clusterFile}</div>
                    </div>
                  </div>
                )}
                {renderTailPanels('h-28')}
              </div>
            )}

            {currentView === 'similarity' && (
              <div className="space-y-4">
                <h1 className="text-2xl font-semibold">7. Sequence Similarity Calculation</h1>
                <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="md:col-span-2">
                    <label className="block text-xs text-slate-500 mb-1">Candidate FASTA path (leave blank = backend auto-select)</label>
                    <input
                      className="w-full p-2 border rounded text-sm"
                      value={networkSourceFasta}
                      onChange={(e) => setNetworkSourceFasta(e.target.value)}
                      placeholder="e.g.: /path/to/scored_passed.fasta"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs text-slate-500 mb-1">Reference FASTA path (leave blank = backend default reference)</label>
                    <input
                      className="w-full p-2 border rounded text-sm"
                      value={networkReferenceFasta}
                      onChange={(e) => setNetworkReferenceFasta(e.target.value)}
                      placeholder="e.g.: /path/to/ref.fasta"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Similarity Algorithm</label>
                    <select
                      className="w-full p-2 border rounded text-sm"
                      value={networkSimilarityMethod}
                      onChange={(e) => setNetworkSimilarityMethod(e.target.value as 'needleman-wunsch' | 'smith-waterman' | 'mmseqs2')}
                    >
                      <option value="needleman-wunsch">Needleman-Wunsch (Global, Biopython)</option>
                      <option value="smith-waterman">Smith-Waterman (Local, Biopython)</option>
                      <option value="mmseqs2">MMseqs2 (Fast Pairwise)</option>
                    </select>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={networkIncludeReferenceLinks}
                      onChange={(e) => setNetworkIncludeReferenceLinks(e.target.checked)}
                    />
                    Compute similarity edges between reference and candidate sequences
                  </label>
                  <div className="md:col-span-2 flex flex-wrap gap-2">
                    <button
                      className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm"
                      disabled={job.loading}
                      onClick={() => void confirmAndRunComputeSimilarity()}
                    >
                      Compute Sequence Similarity
                    </button>
                    <button
                      className="bg-slate-100 hover:bg-slate-200 text-slate-800 px-4 py-2 rounded-lg text-sm border border-slate-300"
                      disabled={job.loading}
                      onClick={() =>
                        runAction('Load network data', async () => {
                          const data = await loadNetworkData();
                          setNetworkStats({
                            nodes: Number.isFinite(Number(data.nodeTotal)) ? Number(data.nodeTotal) : data.nodes.length,
                            edges: Number.isFinite(Number(data.edgeTotal)) ? Number(data.edgeTotal) : data.edges.length,
                          });
                        })
                      }
                    >
                      Load nodes.csv / edges_similarity.csv
                    </button>
                  </div>
                </div>
                {runtimeMeta?.networkAlignProgress && (
                  runtimeTask === 'network/compute-similarity'
                  || runtimeTask === 'network/data'
                  || runtimeTask === 'clustering/run'
                ) && (
                  <div className="w-full bg-slate-50 p-3 rounded-lg border border-slate-100 space-y-3">
                    <div className="flex justify-between text-xs text-slate-600 mb-2 font-medium">
                      <span>
                        🧪 Sequence Alignment In Progress
                        {runtimeMeta.networkAlignProgress.phase ? `（${runtimeMeta.networkAlignProgress.phase}）` : ''}
                        ：{runtimeMeta.networkAlignProgress.current} / {runtimeMeta.networkAlignProgress.total}
                      </span>
                      <span>
                        {Math.min(100, Math.round((runtimeMeta.networkAlignProgress.current / Math.max(1, runtimeMeta.networkAlignProgress.total)) * 100))}%
                      </span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
                      <div
                        className="bg-indigo-500 h-2.5 rounded-full transition-all duration-300"
                        style={{
                          width: `${Math.min(100, Math.round((runtimeMeta.networkAlignProgress.current / Math.max(1, runtimeMeta.networkAlignProgress.total)) * 100))}%`,
                        }}
                      />
                    </div>

                    {runtimeMeta?.networkAlignStages?.['reference-links'] && (
                      <div>
                        <div className="flex justify-between text-xs text-slate-600 mb-1 font-medium">
                          <span>Reference sequences vs Candidate sequences</span>
                          <span>
                            {runtimeMeta.networkAlignStages['reference-links'].current} / {runtimeMeta.networkAlignStages['reference-links'].total}
                          </span>
                        </div>
                        <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                          <div
                            className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                            style={{
                              width: `${Math.min(100, Math.round((runtimeMeta.networkAlignStages['reference-links'].current / Math.max(1, runtimeMeta.networkAlignStages['reference-links'].total)) * 100))}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}

                    {runtimeMeta?.networkAlignStages?.['candidate-pairwise'] && (
                      <div>
                        <div className="flex justify-between text-xs text-slate-600 mb-1 font-medium">
                          <span>Candidate sequences pairwise alignment</span>
                          <span>
                            {runtimeMeta.networkAlignStages['candidate-pairwise'].current} / {runtimeMeta.networkAlignStages['candidate-pairwise'].total}
                          </span>
                        </div>
                        <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                          <div
                            className="bg-emerald-500 h-2 rounded-full transition-all duration-300"
                            style={{
                              width: `${Math.min(100, Math.round((runtimeMeta.networkAlignStages['candidate-pairwise'].current / Math.max(1, runtimeMeta.networkAlignStages['candidate-pairwise'].total)) * 100))}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="bg-white border border-slate-200 rounded-xl p-4 text-sm">
                  <div className="text-slate-600">Current network size:</div>
                  <div className="mt-2 flex gap-6">
                    <div>Nodes: <span className="font-semibold">{networkStats.nodes}</span></div>
                    <div>Edges: <span className="font-semibold">{networkStats.edges}</span></div>
                  </div>
                </div>
                {renderTailPanels('h-28')}
              </div>
            )}

            {currentView === 'network' && (
              <div className="space-y-4">
                <h1 className="text-2xl font-semibold">Similarity Network</h1>

                {/* ── Browser Graph (Primary) ── */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="text-base font-semibold text-slate-800">Network Visualization</span>
                    <div className="flex items-center gap-2 flex-wrap">
                      <select className="p-1.5 border rounded text-xs" value={browserGraphMode} onChange={(e) => setBrowserGraphMode(e.target.value as any)}>
                        <option value="cytoscape">Cytoscape.js (Organic CoSE)</option>
                        <option value="d3">D3 Force</option>
                      </select>
                      <select className="p-1.5 border rounded text-xs" value={browserGraphCategoryCol} onChange={(e) => setBrowserGraphCategoryCol(e.target.value)}>
                        <option value="class">Class</option>
                        <option value="phylum">Phylum</option>
                        <option value="kingdom">Kingdom</option>
                        <option value="order">Order</option>
                        <option value="family">Family</option>
                        <option value="genus">Genus</option>
                        <option value="species">Species</option>
                        <option value="cluster">Cluster</option>
                      </select>
                      <input
                        type="number"
                        min={40}
                        max={100}
                        step={1}
                        className="w-20 p-1.5 border rounded text-xs"
                        value={browserGraphThreshold}
                        onChange={(e) => setBrowserGraphThreshold(Math.max(40, Math.min(100, Number(e.target.value) || 40)))}
                        title="Browser Graph Load Threshold"
                      />
                      <button
                        className="bg-sky-600 hover:bg-sky-700 text-white px-3 py-1.5 rounded text-xs"
                        disabled={job.loading}
                        onClick={async () => {
                          const data = await fetchBrowserGraphData({ pairwiseThresholdPct: browserGraphThreshold });
                          setBrowserGraphNodes(data.nodes);
                          setBrowserGraphAllEdges(data.edges);
                          setBrowserGraphLoadedThreshold(data.appliedThresholdPct);
                          setBrowserGraphThreshold(data.appliedThresholdPct);
                          setBrowserGraphThresholdAdjusted(Boolean(data.thresholdAdjusted));
                          setBrowserGraphMaxEdges(data.maxEdges);
                          setBrowserGraphVisible(true);
                        }}
                      >
                        Load Network
                      </button>
                    </div>
                  </div>
                  <div className="text-sm text-slate-500">
                    Nodes: <b className="text-slate-700">{networkStats.nodes}</b> · Edges: <b className="text-slate-700">{networkStats.edges}</b>
                  </div>
                  <div className="text-xs text-slate-500">
                    The number above is the load threshold. After clicking “Load Network”, the in-graph slider can only be adjusted within the range of the currently loaded edge set.
                  </div>
                  {browserGraphThresholdAdjusted && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      The browser graph automatically raised the load threshold to {browserGraphLoadedThreshold} to avoid the edge count exceeding {browserGraphMaxEdges}, which could freeze or blank the page.
                    </div>
                  )}
                  {browserGraphVisible && (
                    <NetworkGraph
                      nodes={browserGraphNodes}
                      edges={browserGraphAllEdges}
                      mode={browserGraphMode}
                      categoryColumn={browserGraphCategoryCol as any}
                      initialThreshold={browserGraphLoadedThreshold}
                      minThreshold={browserGraphLoadedThreshold}
                      highlightIds={recommendResults.map((r) => r.id)}
                      height={600}
                    />
                  )}
                </div>

                {/* ── Progress bars ── */}
                {runtimeMeta?.networkAlignProgress && (
                  runtimeTask === 'network/data'
                  || runtimeTask === 'network/push-cytoscape'
                  || runtimeTask === 'clustering/run'
                ) && (
                  <div className="w-full bg-slate-50 p-3 rounded-lg border border-slate-100 space-y-3">
                    <div className="flex justify-between text-xs text-slate-600 mb-2 font-medium">
                      <span>
                        🧪 Sequence Alignment In Progress
                        {runtimeMeta.networkAlignProgress.phase ? `（${runtimeMeta.networkAlignProgress.phase}）` : ''}
                        ：{runtimeMeta.networkAlignProgress.current} / {runtimeMeta.networkAlignProgress.total}
                      </span>
                      <span>
                        {Math.min(100, Math.round((runtimeMeta.networkAlignProgress.current / Math.max(1, runtimeMeta.networkAlignProgress.total)) * 100))}%
                      </span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
                      <div
                        className="bg-indigo-500 h-2.5 rounded-full transition-all duration-300"
                        style={{
                          width: `${Math.min(100, Math.round((runtimeMeta.networkAlignProgress.current / Math.max(1, runtimeMeta.networkAlignProgress.total)) * 100))}%`,
                        }}
                      />
                    </div>

                    {runtimeMeta?.networkAlignStages?.['reference-links'] && (
                      <div>
                        <div className="flex justify-between text-xs text-slate-600 mb-1 font-medium">
                          <span>Reference edge alignment</span>
                          <span>
                            {runtimeMeta.networkAlignStages['reference-links'].current} / {runtimeMeta.networkAlignStages['reference-links'].total}
                          </span>
                        </div>
                        <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                          <div
                            className="bg-emerald-500 h-2 rounded-full transition-all duration-300"
                            style={{
                              width: `${Math.min(100, Math.round((runtimeMeta.networkAlignStages['reference-links'].current / Math.max(1, runtimeMeta.networkAlignStages['reference-links'].total)) * 100))}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}

                    {runtimeMeta?.networkAlignStages?.['candidate-pairwise'] && (
                      <div>
                        <div className="flex justify-between text-xs text-slate-600 mb-1 font-medium">
                          <span>Candidate pairwise alignment</span>
                          <span>
                            {runtimeMeta.networkAlignStages['candidate-pairwise'].current} / {runtimeMeta.networkAlignStages['candidate-pairwise'].total}
                          </span>
                        </div>
                        <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                          <div
                            className="bg-indigo-500 h-2 rounded-full transition-all duration-300"
                            style={{
                              width: `${Math.min(100, Math.round((runtimeMeta.networkAlignStages['candidate-pairwise'].current / Math.max(1, runtimeMeta.networkAlignStages['candidate-pairwise'].total)) * 100))}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="bg-white border border-slate-200 rounded-xl p-6 text-lg">
                  Nodes: <b>{networkStats.nodes}</b> | Edges: <b>{networkStats.edges}</b>
                </div>

                {/* ── Cytoscape Desktop Push (Secondary) ── */}
                <details className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <summary className="px-4 py-3 cursor-pointer select-none text-sm font-medium text-slate-600 hover:bg-slate-50">
                    Push to Cytoscape Desktop (optional)
                  </summary>
                  <div className="px-4 pb-4 pt-2 grid grid-cols-1 md:grid-cols-2 gap-3 border-t border-slate-100">
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Cytoscape base URL</label>
                      <input className="w-full p-2 border rounded text-sm" value={cytoBaseUrl} onChange={(e) => setCytoBaseUrl(e.target.value)} placeholder="http://localhost:1234/v1" />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Collection</label>
                      <input className="w-full p-2 border rounded text-sm" value={cytoCollection} onChange={(e) => setCytoCollection(e.target.value)} placeholder="Similarity" />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Network Title</label>
                      <input className="w-full p-2 border rounded text-sm" value={cytoNetworkTitle} onChange={(e) => setCytoNetworkTitle(e.target.value)} placeholder="Similarity Network" />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Layout</label>
                      <input className="w-full p-2 border rounded text-sm" value={cytoLayout} onChange={(e) => setCytoLayout(e.target.value)} placeholder="force-directed" />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Coloring Category Column</label>
                      <select className="w-full p-2 border rounded text-sm" value={cytoCategoryColumn} onChange={(e) => setCytoCategoryColumn(e.target.value)}>
                        <option value="phylum">Phylum</option>
                        <option value="class">Class</option>
                        <option value="kingdom">Kingdom</option>
                        <option value="species">Species</option>
                        <option value="cluster">Cluster</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Pairwise Threshold (%)</label>
                      <input type="number" min={0} max={100} step={1} className="w-full p-2 border rounded text-sm" value={networkPairwiseThresholdPct} onChange={(e) => setNetworkPairwiseThresholdPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      <input type="checkbox" checked={cytoApplyStyle} onChange={(e) => setCytoApplyStyle(e.target.checked)} />
                      Auto-apply style (color by selected category column, map edge width by weight)
                    </label>
                    <div className="md:col-span-2 flex flex-wrap gap-2">
                      <button
                        className="bg-emerald-700 hover:bg-emerald-800 text-white px-4 py-2 rounded-lg text-sm"
                        disabled={job.loading}
                        onClick={() => runAction(`Push to Cytoscape by threshold (${networkPairwiseThresholdPct}%)`, () => runPushToCytoscape(), 'network-push')}
                      >
                        Push to Cytoscape by Threshold
                      </button>
                    </div>
                    {cytoPushInfo && (
                      <div className="md:col-span-2 bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-900">
                        Pushed to {cytoPushInfo.baseUrl}, networkSUID: <b>{String(cytoPushInfo.networkSuid ?? 'unknown')}</b>; 
                        Nodes {cytoPushInfo.pushedNodes}, Edges {cytoPushInfo.pushedEdges}.
                        {cytoPushInfo.generated ? ' (network CSV was auto-generated this time)' : ''}
                        {cytoPushInfo.styleApplied ? ` Style applied: ${cytoPushInfo.styleName}${cytoPushInfo.categoryColumn ? ` (grouping column ${cytoPushInfo.categoryColumn})` : ''}` : ''}
                        {cytoPushInfo.styleApplied && cytoPushInfo.categoryColumn && cytoPushInfo.categoryColumn !== cytoCategoryColumn
                          ? <span className="text-amber-700 font-medium"> ⚠ Selected column “{cytoCategoryColumn}” has no data, fell back to “{cytoPushInfo.categoryColumn}”</span>
                          : null}
                        {!cytoPushInfo.styleApplied && cytoPushInfo.styleError ? ` Style not applied: ${cytoPushInfo.styleError}` : ''}
                        {cytoPushInfo.layoutApplied ? ` Layout applied: ${cytoPushInfo.layout}` : ''}
                        {!cytoPushInfo.layoutApplied && cytoPushInfo.layoutError ? ` Layout not applied: ${cytoPushInfo.layoutError}` : ''}
                      </div>
                    )}
                  </div>
                </details>

                {renderTailPanels('h-24')}
              </div>
            )}

            {/* ==== Step 9: Recommendation ==== */}
            {currentView === 'recommendation' && (
              <div className="space-y-4">
                <h1 className="text-2xl font-semibold">Candidate Recommendation</h1>
                <PredictedMetricsPanel
                  subWeights={predictedSubWeights}
                  onSubWeightsChange={setPredictedSubWeights}
                  tmTarget={predictedTmTarget}
                  onTmTargetChange={setPredictedTmTarget}
                />
                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                  <h2 className="text-base font-semibold text-slate-900">Strategy 2: Comprehensive Recommendation</h2>
                  <p className="text-sm text-slate-600">
                    Ranks candidate sequences using a multi-dimensional score combining similarity, taxonomic diversity, cluster size, and the Strategy 1 predicted property score. Isolated points (clusters containing only 1 sequence) are excluded by default.
                  </p>
                  <details className="text-xs text-slate-400">
                    <summary className="cursor-pointer select-none">Parameter Description</summary>
                    <ul className="mt-1 ml-4 list-disc space-y-0.5">
                      <li><b>Minimum Cluster Size</b>: the number of sequences in a cluster must be ≥ this value, otherwise excluded. Set to 2 to filter out isolated points.</li>
                      <li><b>Avg Ref Similarity Weight</b>: scoring weight for the candidate's average similarity to all reference sequences.</li>
                      <li><b>Max Ref Similarity Weight</b>: scoring weight for the candidate's similarity to its most similar reference sequence.</li>
                      <li><b>Cluster Size Weight</b>: the larger the candidate's cluster, the higher the score; normalized and multiplied by this weight.</li>
                      <li><b>Taxonomy Diversity Weight</b>: scoring weight for the taxonomic diversity (number of classes) within the candidate's cluster.</li>
                      <li><b>Randomness (Temperature)</b>: 0 = deterministic selection (same parameters give the same result); when &gt;0, sampling within each cluster uses temperature — the larger the value, the more random the result.</li>
                    </ul>
                  </details>
                  <details className="text-xs text-slate-400 mt-1">
                    <summary className="cursor-pointer select-none">Scoring Algorithm Description</summary>
                    <div className="mt-1 ml-2 space-y-1">
                      <p><b>Scoring Formula</b>: Score = w₁·avgRefSim + w₂·maxRefSim + w₃·clusterSizeNorm + w₄·taxDiv</p>
                      <ul className="ml-4 list-disc space-y-0.5">
                        <li><b>avgRefSim</b>: average similarity of the candidate to all edge-connected reference sequences ÷ 100, range [0, 1]</li>
                        <li><b>maxRefSim</b>: similarity of the candidate to its most similar reference sequence ÷ 100, range [0, 1]</li>
                        <li><b>clusterSizeNorm</b>: size of the candidate's cluster ÷ the largest cluster size, range [0, 1]</li>
                        <li><b>taxDiv</b>: number of distinct classes in the candidate's cluster ÷ the maximum number of classes, range [0, 1]</li>
                      </ul>
                      <p><b>Cluster Source</b>: result of cd-hit clustering by sequence similarity threshold. Sequences within the same cluster are highly similar to each other.</p>
                      <p><b>Similarity Data Source</b>: edges in edges_similarity.csv between candidates and reference nodes (is_reference=1).</p>
                      <p><b>Diversity Selection</b>: supports two strategies — “Proportional” allocates slots by cluster size (larger clusters get more), “Round-robin” selects evenly and alternately across clusters.</p>
                      <p><b>Randomness</b>: fully deterministic when Temperature=0; when &gt;0, softmax temperature sampling is used during cluster round-robin: P(i) = exp(score_i/T) / Σexp(score_j/T) — the larger T, the more random.</p>
                    </div>
                  </details>
                  <div className="grid grid-cols-5 gap-3 text-sm">
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Minimum Cluster Size</label>
                      <input type="number" min={1} max={100} step={1} className="w-full p-2 border rounded text-sm"
                        value={recommendMinClusterSize}
                        onChange={(e) => setRecommendMinClusterSize(Math.max(1, Number(e.target.value) || 2))} />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Top N</label>
                      <input type="number" min={1} max={5000} step={10} className="w-full p-2 border rounded text-sm"
                        value={recommendTopN}
                        onChange={(e) => setRecommendTopN(Math.max(1, Math.min(5000, Number(e.target.value) || 50)))} />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Selection Strategy</label>
                      <select className="w-full p-2 border rounded text-sm"
                        value={recommendDiversityMode}
                        onChange={(e) => setRecommendDiversityMode(e.target.value as 'proportional' | 'round-robin')}>
                        <option value="proportional">Proportional</option>
                        <option value="round-robin">Round-robin</option>
                      </select>
                    </div>
                    <div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Threshold: {recommendNetworkConnectivityThreshold}%</label>
                      <input type="range" min={0} max={100} step={1} className="w-full accent-indigo-500 cursor-pointer" draggable={false}
                        style={{ touchAction: 'none' }}
                        value={recommendNetworkConnectivityThreshold}
                        onChange={(e) => setRecommendNetworkConnectivityThreshold(Number(e.target.value))} />
                    </div>
                      <label className="block text-xs text-slate-500 mb-1">Randomness (Temperature): {recommendTemperature.toFixed(2)}</label>
                      <input type="range" min={0} max={1} step={0.05} className="w-full accent-indigo-500 cursor-pointer" draggable={false}
                        style={{ touchAction: 'none' }}
                        value={recommendTemperature}
                        onChange={(e) => setRecommendTemperature(Number(e.target.value))} />
                    </div>
                  </div>
                  <WeightBar weights={recommendWeights} onChange={setRecommendWeights} labels={WEIGHT_LABELS} defaults={DEFAULT_WEIGHTS} />
                  <div className="flex items-center gap-3">
                    <button className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg text-sm"
                      disabled={job.loading}
                      onClick={() => runAction('Candidate recommendation scoring', runRecommendation, 'recommendation')}>
                      Compute Recommendations
                    </button>
                  </div>
                </div>
                {recommendMeta && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm space-y-1">
                    <div>Candidates {recommendMeta.totalCandidates}, references {recommendMeta.totalReferences}, showing top {recommendResults.length}</div>
                    {(recommendMeta.filteredByClusterSize > 0 || recommendMeta.filteredBySimilarity > 0) && (
                      <div className="text-slate-500">
                        Filtered: {recommendMeta.filteredByClusterSize} below minimum cluster size
                        {recommendMeta.filteredBySimilarity > 0 && `, ${recommendMeta.filteredBySimilarity} below similarity threshold`}
                      </div>
                    )}
                    {!recommendMeta.predictedMetricsAvailable && (
                      <div className="text-amber-700">⚠ Strategy 1 predictions haven't been run yet for this task, so the Predicted Score weight contributed 0.</div>
                    )}
                  </div>
                )}
                {recommendResults.length > 0 && (
                  <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          <th className="px-2 py-2 text-left">#</th>
                          <th className="px-2 py-2 text-left">ID</th>
                          <th className="px-2 py-2 text-right">Score</th>
                          <th className="px-2 py-2 text-right">Predicted Score</th>
                          <th className="px-2 py-2 text-right">Avg Ref Sim</th>
                          <th className="px-2 py-2 text-right">Max Ref Sim</th>
                          <th className="px-2 py-2 text-right">Ref Edges</th>
                          <th className="px-2 py-2 text-left">Cluster</th>
                          <th className="px-2 py-2 text-right">Cluster Size</th>
                          <th className="px-2 py-2 text-left">Net Comp</th>
                          <th className="px-2 py-2 text-right">Comp Size</th>
                          <th className="px-2 py-2 text-left">Net Comp</th>
                          <th className="px-2 py-2 text-right">Comp Size</th>
                          <th className="px-2 py-2 text-left">Phylum</th>
                          <th className="px-2 py-2 text-left">Species</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recommendResults.map((c, i) => (
                          <tr key={c.id} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                            <td className="px-2 py-1.5 text-slate-400">{i + 1}</td>
                            <td className="px-2 py-1.5 font-mono text-xs break-all max-w-[200px]">{c.id}</td>
                            <td className="px-2 py-1.5 text-right font-semibold">{c.score.toFixed(4)}</td>
                            <td className="px-2 py-1.5 text-right">{c.predictedScore.toFixed(4)}</td>
                            <td className="px-2 py-1.5 text-right">{(c.avgRefSimilarity * 100).toFixed(1)}%</td>
                            <td className="px-2 py-1.5 text-right">{(c.maxRefSimilarity * 100).toFixed(1)}%</td>
                            <td className="px-2 py-1.5 text-right">{c.refEdgeCount}</td>
                            <td className="px-2 py-1.5">{c.cluster}</td>
                            <td className="px-2 py-1.5 text-right">{c.cluster_size}</td>
                            <td className="px-2 py-1.5">{c.networkComponent}</td>
                            <td className="px-2 py-1.5 text-right">{c.networkComponentSize}</td>
                            <td className="px-2 py-1.5">{c.networkComponent}</td>
                            <td className="px-2 py-1.5 text-right">{c.networkComponentSize}</td>
                            <td className="px-2 py-1.5">{c.phylum}</td>
                            <td className="px-2 py-1.5">{c.species}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {recommendResults.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm"
                      onClick={async () => {
                        try {
                          const data = await exportRecommendedFasta(recommendResults.map(c => c.id));
                          const blob = new Blob([data.fasta], { type: 'text/plain' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url; a.download = `recommended_candidates_${recommendResults.length}.fasta`;
                          a.click(); URL.revokeObjectURL(url);
                        } catch (err: any) { alert('Export failed: ' + (err?.message || err)); }
                      }}>
                      Export FASTA ({recommendResults.length})
                    </button>
                    <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm"
                      onClick={highlightRecommendationsInNetwork}>
                      Highlight in Network
                    </button>
                  </div>
                )}
                {renderTailPanels('h-24')}
              </div>
            )}
            </div>
          </div>
        </div>
      </main>

      {similarityConfirmState.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl space-y-4">
            <div className="text-base font-semibold text-slate-900">Existing Similarity Results Detected</div>
            <div className="text-sm text-slate-600 leading-6">
              This task already has similarity files:
              <div>nodes: {similarityConfirmState.nodeTotal}</div>
              <div>edges: {similarityConfirmState.edgeTotal}</div>
              <div className="mt-2">Recompute and overwrite these results?</div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                className="px-3 py-1.5 rounded border border-slate-300 text-slate-700 text-sm hover:bg-slate-50"
                onClick={cancelSimilarityRecompute}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1.5 rounded bg-indigo-600 text-white text-sm hover:bg-indigo-700"
                onClick={startSimilarityRecomputeFromModal}
              >
                Recompute
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ========== BLAST Pipeline Component ==========

function BlastPipelineProgressPanel({
  stepState,
  activeStep,
  loading,
  lastCompletedStep,
}: {
  stepState: Record<BlastPipelineStepKey, StepStatus>;
  activeStep: BlastPipelineStepKey | null;
  loading: boolean;
  lastCompletedStep?: BlastPipelineStepKey | null;
}) {
  const doneCount = blastPipelineSteps.filter((s) => stepState[s.key] === 'success').length;
  const hasRunning = blastPipelineSteps.some((s) => stepState[s.key] === 'running');
  const total = blastPipelineSteps.length;
  const percent = Math.round(((doneCount + (hasRunning ? 0.35 : 0)) / total) * 100);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-slate-700">Pipeline Progress (BLAST)</div>
        <div className="text-xs text-slate-500">{doneCount}/{total} completed</div>
      </div>
      <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${loading ? 'progress-shimmer bg-emerald-500' : 'bg-emerald-500'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
        {blastPipelineSteps.map((step) => {
          const status = stepState[step.key];
          const running = status === 'running';
          const active = activeStep === step.key;
          return (
            <div
              key={step.key}
              className={`rounded-lg border px-3 py-2 text-xs transition-all duration-300 ${
                status === 'success'
                  ? 'border-emerald-200 bg-emerald-50'
                  : status === 'error'
                    ? 'border-red-200 bg-red-50'
                    : running
                      ? 'border-emerald-300 bg-emerald-50 shadow-sm step-running-glow'
                      : 'border-slate-200 bg-slate-50'
              } ${active ? 'ring-2 ring-emerald-200' : ''} ${status === 'success' && lastCompletedStep === step.key ? 'step-success-pop' : ''}`}
            >
              <div className="flex items-center gap-2">
                {status === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
                {status === 'error' && <AlertCircle className="w-3.5 h-3.5 text-red-600" />}
                {status === 'running' && <Activity className="w-3.5 h-3.5 text-emerald-600 animate-pulse" />}
                {status === 'idle' && <span className="w-2 h-2 rounded-full bg-slate-400 inline-block" />}
                <span className="font-medium text-slate-700">{step.title}</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {status === 'success' && 'Done'}
                {status === 'error' && 'Failed'}
                {status === 'running' && 'Running...'}
                {status === 'idle' && 'Not started'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BlastPipeline({ darkMode, setDarkMode, onBack }: { darkMode: boolean; setDarkMode: (v: boolean | ((p: boolean) => boolean)) => void; onBack: () => void }) {
  const hydratingStateRef = useRef(false);
  const [currentView, setCurrentView] = useState<BlastView>('dashboard');
  const [taskList, setTaskList] = useState<TaskBrief[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState(() => {
    if (typeof window === 'undefined') return 'blast-default';
    return window.localStorage.getItem('enzymeminer.blast.activeTaskId') || 'blast-default';
  });
  const [newTaskId, setNewTaskId] = useState('');

  const [health, setHealth] = useState<any>(null);
  const [job, setJob] = useState<JobState>({ loading: false, message: '', error: '' });
  const [stepState, setStepState] = useState<Record<BlastPipelineStepKey, StepStatus>>(initialBlastStepState);
  const [activeStep, setActiveStep] = useState<BlastPipelineStepKey | null>(null);
  const [runtimeTask, setRuntimeTask] = useState('idle');
  const [runtimeStartedAt, setRuntimeStartedAt] = useState<number | null>(null);
  const [runtimeUpdatedAt, setRuntimeUpdatedAt] = useState<number | null>(null);
  const [runtimeActive, setRuntimeActive] = useState(false);
  const [runtimeMeta, setRuntimeMeta] = useState<{
    networkAlignProgress?: { current: number; total: number; phase?: string };
    networkAlignStages?: {
      'reference-links'?: { current: number; total: number };
      'candidate-pairwise'?: { current: number; total: number };
    };
    [key: string]: any;
  }>({});
  const [runtimeLogs, setRuntimeLogs] = useState<string[]>([]);
  const [autoScrollLog, setAutoScrollLog] = useState(true);
  const [lastCompletedStep, setLastCompletedStep] = useState<BlastPipelineStepKey | null>(null);
  const [completionToast, setCompletionToast] = useState('');
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const actionStartedAtRef = useRef<number>(0);
  const [retryPolicy, setRetryPolicy] = useState<Record<BlastPipelineStepKey, number>>({
    reference: 2,
    'blast-db': 1,
    'blast-search': 0,
    alignment: 1,
    scoring: 2,
    clustering: 1,
    similarity: 1,
    'network-push': 1,
    recommendation: 0,
  });
  const [retryIntervalMs, setRetryIntervalMs] = useState(900);
  const [metrics, setMetrics] = useState<Record<BlastPipelineStepKey, StepMetrics>>(initialBlastMetrics);

  // Step 1: Reference
  const [entrezEmail, setEntrezEmail] = useState(import.meta.env.VITE_DEFAULT_EMAIL || '');
  const [accessions, setAccessions] = useState('');
  const [referencePreview, setReferencePreview] = useState<Array<Record<string, string>>>([]);
  const [referencePage, setReferencePage] = useState(1);
  const referencePageSize = 10;
  const [referenceFastaPath, setReferenceFastaPath] = useState('');
  const [referenceUploadFile, setReferenceUploadFile] = useState<File | null>(null);
  const [referenceImportNotice, setReferenceImportNotice] = useState('');
  const referenceUploadInputRef = useRef<HTMLInputElement | null>(null);
  const [refIdentityIds, setRefIdentityIds] = useState<string[]>([]);
  const [refIdentityMatrix, setRefIdentityMatrix] = useState<number[][]>([]);

  // Step 2: BLAST DB
  const [blastDbSource, setBlastDbSource] = useState<BlastDbSource>('local');
  const [blastTargetFasta, setBlastTargetFasta] = useState('');
  const [blastNcbiDb, setBlastNcbiDb] = useState('nr');
  const [blastDeduplicateRefs, setBlastDeduplicateRefs] = useState(true);
  const [blastDeduplicateIdentity, setBlastDeduplicateIdentity] = useState(0.95);
  const [blastDbInfo, setBlastDbInfo] = useState<{
    dbSource: string;
    dbPath: string | null;
    refDedup: string | null;
    refDedupCount: number;
    refInputCount: number;
  } | null>(null);

  // Step 3: BLAST Search & Filter
  const [blastEvalue, setBlastEvalue] = useState(1e-10);
  const [blastIdentityMin, setBlastIdentityMin] = useState(30);
  const [blastQueryCovMin, setBlastQueryCovMin] = useState(70);
  const [blastSubjectLenMin, setBlastSubjectLenMin] = useState(200);
  const [blastSubjectLenMax, setBlastSubjectLenMax] = useState(800);
  const [blastMaxTargetSeqs, setBlastMaxTargetSeqs] = useState(500);
  const [blastMatrix, setBlastMatrix] = useState('BLOSUM62');
  const [blastWordSize, setBlastWordSize] = useState(3);
  const [blastGapOpen, setBlastGapOpen] = useState(11);
  const [blastGapExtend, setBlastGapExtend] = useState(1);
  const [blastMergeStrategy, setBlastMergeStrategy] = useState<BlastMergeStrategy>('best-evalue');
  const [blastHitsRows, setBlastHitsRows] = useState<Array<Record<string, string>>>([]);
  const [blastFilteredRows, setBlastFilteredRows] = useState<Array<Record<string, string>>>([]);
  const [blastSearchStats, setBlastSearchStats] = useState<{ totalHits: number; uniqueSubjects: number; queriesUsed: number } | null>(null);
  const [blastFilterStats, setBlastFilterStats] = useState<{ kept: number; total: number } | null>(null);
  const [blastSearchPage, setBlastSearchPage] = useState(1);
  const [blastSearchPageSize] = useState(50);
  const [blastSearchTotalPages, setBlastSearchTotalPages] = useState(1);
  const [blastSearchSource, setBlastSearchSource] = useState<'blast_hits_all' | 'blast_hits_filtered'>('blast_hits_all');
  // Filter params (for post-search filter)
  const [blastFilterEvalueMax, setBlastFilterEvalueMax] = useState(1e-10);
  const [blastFilterIdentityMin, setBlastFilterIdentityMin] = useState(30);
  const [blastFilterIdentityMax, setBlastFilterIdentityMax] = useState(100);
  const [blastFilterQueryCovMin, setBlastFilterQueryCovMin] = useState(70);
  const [blastFilterSubjectLenMin, setBlastFilterSubjectLenMin] = useState(200);
  const [blastFilterSubjectLenMax, setBlastFilterSubjectLenMax] = useState(800);

  // Steps 4-8: shared
  const [alignmentPath, setAlignmentPath] = useState('');
  const [refId, setRefId] = useState('');
  const [threshold, setThreshold] = useState(33.6);
  const [autoScoreFromFiltered, setAutoScoreFromFiltered] = useState(false);
  const [scoringRules, setScoringRules] = useState<ScoringRule[]>([]);
  const [scoringPositionMode, setScoringPositionMode] = useState<ScoringPositionMode>('pre');
  const [preAlignmentAnchor, setPreAlignmentAnchor] = useState<PreAlignmentAnchor>('first');
  const [scoringRulesError, setScoringRulesError] = useState('');
  const [scoringRulesSuccess, setScoringRulesSuccess] = useState('');
  const [scoringAllowedDrafts, setScoringAllowedDrafts] = useState<Record<number, string>>({});
  const rulesImportRef = useRef<HTMLInputElement | null>(null);
  const [scoringRows, setScoringRows] = useState<Array<Record<string, string>>>([]);
  const [scoringRunInfo, setScoringRunInfo] = useState<{
    csv?: string;
    alignmentUsed: string;
    autoFromFiltered: boolean;
    total: number;
    passed: number;
    passedFasta?: string;
    passedCount?: number;
    passedMissingInAlignment?: number;
    positionMode?: ScoringPositionMode;
    preAlignmentAnchor?: PreAlignmentAnchor;
    refIdUsed?: string | null;
  } | null>(null);
  const [alignmentPrepInfo, setAlignmentPrepInfo] = useState<{ alignment: string; records: number } | null>(null);
  const [autoDownloadScoringCsv, setAutoDownloadScoringCsv] = useState(true);
  const [thresholdPreview, setThresholdPreview] = useState<{ total: number; passed: number; ratio: number; threshold: number } | null>(null);
  const [alignmentPreviewRows, setAlignmentPreviewRows] = useState<Array<{ id: string; segment: string }>>([]);
  const [alignmentPreviewStart, setAlignmentPreviewStart] = useState(1);
  const [alignmentPreviewEnd, setAlignmentPreviewEnd] = useState(120);
  const [alignmentPreviewOffset, setAlignmentPreviewOffset] = useState(0);
  const [alignmentPreviewLimit] = useState(25);
  const [alignmentPreviewTotalRecords, setAlignmentPreviewTotalRecords] = useState(0);
  const [alignmentPreviewLength, setAlignmentPreviewLength] = useState(0);

  const [candidateFasta, setCandidateFasta] = useState('');
  const [clusterIdentity, setClusterIdentity] = useState(0.85);
  const [clusterWordSize, setClusterWordSize] = useState(5);
  const [clusteringRunInfo, setClusteringRunInfo] = useState<{
    inputFasta: string;
    outputFasta: string;
    clusterFile: string;
    inputCount: number;
    outputCount: number;
    deduplicatedCount: number;
    clusters: number;
  } | null>(null);

  const [networkStats, setNetworkStats] = useState({ nodes: 0, edges: 0 });
  const [cytoBaseUrl, setCytoBaseUrl] = useState('http://localhost:1234/v1');
  const [cytoCollection, setCytoCollection] = useState('Similarity');
  const [cytoNetworkTitle, setCytoNetworkTitle] = useState('Similarity Network');
  const [cytoLayout, setCytoLayout] = useState('force-directed');
  const [cytoCategoryColumn, setCytoCategoryColumn] = useState('phylum');
  const [cytoApplyStyle, setCytoApplyStyle] = useState(true);
  const [networkPairwiseThresholdPct, setNetworkPairwiseThresholdPct] = useState(85);
  const [networkIncludeReferenceLinks, setNetworkIncludeReferenceLinks] = useState(true);
  const [networkSimilarityMethod, setNetworkSimilarityMethod] = useState<'needleman-wunsch' | 'smith-waterman' | 'mmseqs2'>('mmseqs2');
  const [networkSourceFasta, setNetworkSourceFasta] = useState('scored_passed.fasta');
  const [networkReferenceFasta, setNetworkReferenceFasta] = useState(() => defaultTaskReferenceFasta(selectedTaskId));
  const [cytoPushInfo, setCytoPushInfo] = useState<any>(null);

  // ── Browser graph state (BLAST) ──
  const [browserGraphNodes, setBrowserGraphNodes] = useState<BrowserGraphNode[]>([]);
  const [browserGraphEdges, setBrowserGraphEdges] = useState<BrowserGraphEdge[]>([]);
  const [browserGraphAllEdges, setBrowserGraphAllEdges] = useState<BrowserGraphEdge[]>([]);
  const [browserGraphThreshold, setBrowserGraphThreshold] = useState(80);
  const [browserGraphLoadedThreshold, setBrowserGraphLoadedThreshold] = useState(80);
  const [browserGraphThresholdAdjusted, setBrowserGraphThresholdAdjusted] = useState(false);
  const [browserGraphMaxEdges, setBrowserGraphMaxEdges] = useState(20000);
  const [browserGraphMode, setBrowserGraphMode] = useState<'d3' | 'cytoscape'>('cytoscape');
  const [browserGraphCategoryCol, setBrowserGraphCategoryCol] = useState<string>('class');
  const [browserGraphVisible, setBrowserGraphVisible] = useState(false);

  // ── Recommendation state ──
  const [recommendResults, setRecommendResults] = useState<RecommendCandidate[]>([]);
  const [recommendWeights, setRecommendWeights] = useState<RecommendWeights>({ ...DEFAULT_WEIGHTS });
  const [recommendNetworkConnectivityThreshold, setRecommendNetworkConnectivityThreshold] = useState<number>(85);
  const [recommendTopN, setRecommendTopN] = useState(50);
  const [recommendMinClusterSize, setRecommendMinClusterSize] = useState(2);
  const [recommendMinSimilarity, setRecommendMinSimilarity] = useState(0);
  const [recommendTemperature, setRecommendTemperature] = useState(0);
  const [recommendDiversityMode, setRecommendDiversityMode] = useState<'proportional' | 'round-robin'>('proportional');
  const [recommendMeta, setRecommendMeta] = useState<{ totalCandidates: number; totalReferences: number; filteredByClusterSize: number; filteredBySimilarity: number; predictedMetricsAvailable: boolean } | null>(null);
  const [predictedSubWeights, setPredictedSubWeights] = useState<PredictedSubWeights>({ ...DEFAULT_PREDICTED_SUB_WEIGHTS });
  const [predictedTmTarget, setPredictedTmTarget] = useState(60);

  // ---- effects ----
  useEffect(() => {
    setActiveTaskId(selectedTaskId);
    if (typeof window !== 'undefined') window.localStorage.setItem('enzymeminer.blast.activeTaskId', selectedTaskId);
  }, [selectedTaskId]);

  useEffect(() => {
    setNetworkReferenceFasta((prev) => {
      const text = String(prev || '').trim();
      if (!text || /^\/home\/threo\/aox_project\/aox_tasks\/[^/]+\/ref\.fasta$/.test(text)) return defaultTaskReferenceFasta(selectedTaskId);
      return prev;
    });
  }, [selectedTaskId]);

  const refreshTasks = async () => {
    const data = await listTasks();
    const all = data.tasks || [];
    setTaskList(all.filter((t) => t.module === 'blast' || t.id === 'blast-default'));
    if (!all.some((t) => t.id === selectedTaskId)) setSelectedTaskId('blast-default');
  };

  useEffect(() => { void refreshTasks(); }, []);

  // Reset state on task switch + hydrate
  useEffect(() => {
    setReferencePreview([]);
    setBlastHitsRows([]);
    setBlastFilteredRows([]);
    setBlastFilterStats(null);
    setBlastSearchStats(null);
    setBlastDbInfo(null);
    setScoringRows([]);
    setAlignmentPrepInfo(null);
    setAlignmentPath('');
    setAlignmentPreviewRows([]);
    setAlignmentPreviewOffset(0);
    setNetworkStats({ nodes: 0, edges: 0 });
    setRuntimeTask('idle');
    setRuntimeMeta({});
    setRuntimeLogs([]);
    setStepState(initialBlastStepState);
    setLastCompletedStep(null);
    setJob({ loading: true, message: `Loading task progress: ${selectedTaskId}`, error: '' });
    setReferenceFastaPath('');
    setCandidateFasta('');
    setClusteringRunInfo(null);
    setRefId('');
    setNetworkSourceFasta('scored_passed.fasta');
    setNetworkReferenceFasta(defaultTaskReferenceFasta(selectedTaskId));
    setBlastTargetFasta('');
    setBlastSearchPage(1);
    setBlastSearchTotalPages(1);
    setBlastSearchSource('blast_hits_all');
    setAccessions('');

    let cancelled = false;
    hydratingStateRef.current = true;
    const hydrateTaskState = async () => {
      let staleRecommendCache = false;
      setActiveTaskId(selectedTaskId);
      try {
        const data = await loadPipelineState('blast');
        const state = data.exists && data.state && typeof data.state === 'object' ? data.state : {};
        if (cancelled) return;

        if (state.blastCurrentView) setCurrentView(state.blastCurrentView as BlastView);
        if (state.blastStepState && typeof state.blastStepState === 'object') {
          setStepState({ ...initialBlastStepState, ...(state.blastStepState as Record<BlastPipelineStepKey, StepStatus>) });
        }
        if (state.blastLastCompletedStep) setLastCompletedStep(state.blastLastCompletedStep as BlastPipelineStepKey);

        if (typeof state.entrezEmail === 'string') setEntrezEmail(state.entrezEmail);
        if (typeof state.accessions === 'string') setAccessions(state.accessions);
        if (typeof state.referenceFastaPath === 'string') setReferenceFastaPath(state.referenceFastaPath);
        if (typeof state.refId === 'string') setRefId(state.refId);
        if (typeof state.candidateFasta === 'string') setCandidateFasta(state.candidateFasta);
        if (typeof state.alignmentPath === 'string') setAlignmentPath(state.alignmentPath);
        if (typeof state.networkSourceFasta === 'string') setNetworkSourceFasta(state.networkSourceFasta);
        if (typeof state.networkReferenceFasta === 'string' && state.networkReferenceFasta.trim()) {
          setNetworkReferenceFasta(state.networkReferenceFasta.trim());
        }

        // BLAST specific
        if (typeof state.blastDbSource === 'string') setBlastDbSource(state.blastDbSource as BlastDbSource);
        if (typeof state.blastTargetFasta === 'string') setBlastTargetFasta(state.blastTargetFasta);
        if (typeof state.blastNcbiDb === 'string') setBlastNcbiDb(state.blastNcbiDb);
        if (typeof state.blastEvalue === 'number') setBlastEvalue(state.blastEvalue);
        if (typeof state.blastIdentityMin === 'number') setBlastIdentityMin(state.blastIdentityMin);
        if (typeof state.blastQueryCovMin === 'number') setBlastQueryCovMin(state.blastQueryCovMin);
        if (typeof state.blastSubjectLenMin === 'number') setBlastSubjectLenMin(state.blastSubjectLenMin);
        if (typeof state.blastSubjectLenMax === 'number') setBlastSubjectLenMax(state.blastSubjectLenMax);
        if (typeof state.blastMaxTargetSeqs === 'number') setBlastMaxTargetSeqs(state.blastMaxTargetSeqs);
        if (typeof state.blastMergeStrategy === 'string') setBlastMergeStrategy(state.blastMergeStrategy as BlastMergeStrategy);
        if (typeof state.blastFilterEvalueMax === 'number') setBlastFilterEvalueMax(state.blastFilterEvalueMax);
        if (typeof state.blastFilterIdentityMin === 'number') setBlastFilterIdentityMin(state.blastFilterIdentityMin);
        if (typeof state.blastFilterIdentityMax === 'number') setBlastFilterIdentityMax(state.blastFilterIdentityMax);
        if (typeof state.blastFilterQueryCovMin === 'number') setBlastFilterQueryCovMin(state.blastFilterQueryCovMin);
        if (typeof state.blastFilterSubjectLenMin === 'number') setBlastFilterSubjectLenMin(state.blastFilterSubjectLenMin);
        if (typeof state.blastFilterSubjectLenMax === 'number') setBlastFilterSubjectLenMax(state.blastFilterSubjectLenMax);

        // Scoring / clustering / network params
        if (typeof state.threshold === 'number') setThreshold(state.threshold);
        if (typeof state.autoScoreFromFiltered === 'boolean') setAutoScoreFromFiltered(state.autoScoreFromFiltered);
        if (typeof state.scoringPositionMode === 'string') setScoringPositionMode(state.scoringPositionMode as ScoringPositionMode);
        if (typeof state.preAlignmentAnchor === 'string') setPreAlignmentAnchor(state.preAlignmentAnchor as PreAlignmentAnchor);
        if (typeof state.autoDownloadScoringCsv === 'boolean') setAutoDownloadScoringCsv(state.autoDownloadScoringCsv);
        if (typeof state.clusterIdentity === 'number') setClusterIdentity(state.clusterIdentity);
        if (typeof state.clusterWordSize === 'number') setClusterWordSize(state.clusterWordSize);
        if (state.clusteringRunInfo !== undefined) setClusteringRunInfo(state.clusteringRunInfo);
        if (typeof state.networkPairwiseThresholdPct === 'number') setNetworkPairwiseThresholdPct(state.networkPairwiseThresholdPct);
        if (typeof state.networkIncludeReferenceLinks === 'boolean') setNetworkIncludeReferenceLinks(state.networkIncludeReferenceLinks);
        if (typeof state.networkSimilarityMethod === 'string') setNetworkSimilarityMethod(state.networkSimilarityMethod as 'needleman-wunsch' | 'smith-waterman' | 'mmseqs2');
        if (typeof state.cytoBaseUrl === 'string') setCytoBaseUrl(state.cytoBaseUrl);
        if (typeof state.cytoCollection === 'string') setCytoCollection(state.cytoCollection);
        if (typeof state.cytoNetworkTitle === 'string') setCytoNetworkTitle(state.cytoNetworkTitle);
        if (typeof state.cytoLayout === 'string') setCytoLayout(state.cytoLayout);
        if (typeof state.cytoCategoryColumn === 'string') setCytoCategoryColumn(state.cytoCategoryColumn);
        if (typeof state.cytoApplyStyle === 'boolean') setCytoApplyStyle(state.cytoApplyStyle);
        if (state.recommendWeights) setRecommendWeights(normalizeRecommendWeights(state.recommendWeights));
        if (typeof state.recommendTopN === 'number') setRecommendTopN(state.recommendTopN);
        if (typeof state.recommendMinClusterSize === 'number') setRecommendMinClusterSize(state.recommendMinClusterSize);
        if (typeof state.recommendMinSimilarity === 'number') setRecommendMinSimilarity(state.recommendMinSimilarity);
        if (typeof state.recommendTemperature === 'number') setRecommendTemperature(state.recommendTemperature);
        if (state.recommendDiversityMode === 'proportional' || state.recommendDiversityMode === 'round-robin') setRecommendDiversityMode(state.recommendDiversityMode);
        const normalizedRecommend = normalizeSavedRecommendResults(state.recommendResults, state.recommendTopN);
        setRecommendResults(normalizedRecommend.results || []);
        staleRecommendCache = normalizedRecommend.stale;
        if (!normalizedRecommend.stale && state.recommendMeta) setRecommendMeta(state.recommendMeta as any);
        else setRecommendMeta(null);

        // Auto-load artifacts
        let artifacts: Record<string, any> = {};
        try {
          const artRes = await loadTaskArtifacts();
          if (!cancelled) artifacts = artRes.artifacts || {};
        } catch { /* ignore */ }
        if (cancelled) return;

        if (artifacts['ref.csv']?.exists) {
          try {
            const refData = await loadReferencePreview();
            if (!cancelled && refData.exists && refData.preview?.rows?.length) setReferencePreview(refData.preview.rows);
          } catch { /* ignore */ }
        }
        if (artifacts['ref.fasta']?.exists) {
          const artRes = await loadTaskArtifacts();
          if (artRes.workDir && !state.referenceFastaPath) setReferenceFastaPath(artRes.workDir + '/ref.fasta');
        }

        // Load BLAST hits if present
        if (artifacts['blast_hits_all.csv']?.exists) {
          try {
            const firstPage = await loadBlastSearchPage(1, blastSearchPageSize, 'blast_hits_all');
            if (!cancelled && firstPage.preview?.rows?.length) {
              setBlastHitsRows(firstPage.preview.rows);
              setBlastSearchPage(1);
              setBlastSearchTotalPages(firstPage.totalPages);
            }
          } catch { /* ignore */ }
        }

        if (artifacts['blast_hits_filtered.csv']?.exists) {
          try {
            const firstPage = await loadBlastSearchPage(1, blastSearchPageSize, 'blast_hits_filtered');
            if (!cancelled && firstPage.preview?.rows?.length) {
              setBlastFilteredRows(firstPage.preview.rows);
              setBlastFilterStats({
                kept: artifacts['blast_hits_filtered.csv'].rowCount ?? firstPage.preview.rows.length,
                total: artifacts['blast_hits_all.csv']?.rowCount ?? 0,
              });
            }
          } catch { /* ignore */ }
        }

        if (artifacts['nodes.csv']?.exists && artifacts['edges_similarity.csv']?.exists) {
          setNetworkStats({
            nodes: artifacts['nodes.csv'].rowCount ?? 0,
            edges: artifacts['edges_similarity.csv'].rowCount ?? 0,
          });
        }

        setJob({ loading: false, message: `Task progress loaded: ${selectedTaskId}`, error: '' });
        if (staleRecommendCache) {
          setCompletionToast('Detected outdated recommendation cache, please recompute recommendations');
        }
      } catch (err) {
        if (!cancelled) setJob({ loading: false, message: '', error: `Failed to load task progress: ${String(err)}` });
      } finally {
        if (!cancelled) hydratingStateRef.current = false;
      }
    };
    void hydrateTaskState();
    return () => { cancelled = true; hydratingStateRef.current = false; };
  }, [selectedTaskId]);

  // Save pipeline state
  useEffect(() => {
    if (hydratingStateRef.current) return;
    const timer = setTimeout(() => {
      const state = {
        blastCurrentView: currentView,
        blastStepState: stepState,
        blastLastCompletedStep: lastCompletedStep,
        entrezEmail,
        accessions,
        referenceFastaPath,
        refId,
        candidateFasta,
        alignmentPath,
        networkSourceFasta,
        networkReferenceFasta,
        blastDbSource,
        blastTargetFasta,
        blastNcbiDb,
        blastEvalue,
        blastIdentityMin,
        blastQueryCovMin,
        blastSubjectLenMin,
        blastSubjectLenMax,
        blastMaxTargetSeqs,
        blastMergeStrategy,
        blastFilterEvalueMax,
        blastFilterIdentityMin,
        blastFilterIdentityMax,
        blastFilterQueryCovMin,
        blastFilterSubjectLenMin,
        blastFilterSubjectLenMax,
        threshold,
        autoScoreFromFiltered,
        scoringPositionMode,
        preAlignmentAnchor,
        autoDownloadScoringCsv,
        clusterIdentity,
        clusterWordSize,
        clusteringRunInfo,
        networkPairwiseThresholdPct,
        networkIncludeReferenceLinks,
        networkSimilarityMethod,
        cytoBaseUrl,
        cytoCollection,
        cytoNetworkTitle,
        cytoLayout,
        cytoCategoryColumn,
        cytoApplyStyle,
        // Recommendation parameters
        recommendWeights,
        recommendTopN,
        recommendMinClusterSize,
        recommendMinSimilarity,
        recommendTemperature,
        recommendDiversityMode,
        recommendResults,
        recommendMeta,
      };
      void savePipelineState(state, 'blast').catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [
    currentView, stepState, lastCompletedStep, entrezEmail, accessions, referenceFastaPath, refId,
    candidateFasta, alignmentPath, networkSourceFasta, networkReferenceFasta,
    blastDbSource, blastTargetFasta, blastNcbiDb, blastEvalue, blastIdentityMin, blastQueryCovMin,
    blastSubjectLenMin, blastSubjectLenMax, blastMaxTargetSeqs, blastMergeStrategy,
    blastFilterEvalueMax, blastFilterIdentityMin, blastFilterIdentityMax, blastFilterQueryCovMin, blastFilterSubjectLenMin, blastFilterSubjectLenMax,
    threshold, autoScoreFromFiltered, scoringPositionMode, preAlignmentAnchor, autoDownloadScoringCsv,
    clusterIdentity, clusterWordSize, clusteringRunInfo, networkPairwiseThresholdPct, networkIncludeReferenceLinks, networkSimilarityMethod,
    cytoBaseUrl, cytoCollection, cytoNetworkTitle, cytoLayout, cytoCategoryColumn, cytoApplyStyle,
    recommendWeights, recommendTopN, recommendMinClusterSize, recommendMinSimilarity, recommendTemperature, recommendDiversityMode, recommendResults, recommendMeta,
  ]);

  useEffect(() => {
    if (!refId && referencePreview.length > 0) {
      const first = referencePreview[0];
      const acc = first.accession ?? first.id ?? '';
      if (acc) setRefId(acc);
    }
  }, [referencePreview, refId]);

  // Log polling
  useEffect(() => {
    if (!job.loading) return;
    const iv = setInterval(async () => {
      try {
        const data = await loadRuntimeLogs(500);
        setRuntimeActive(Boolean(data.active));
        setRuntimeStartedAt(Number.isFinite(Number(data.startedAt)) ? Number(data.startedAt) : null);
        setRuntimeUpdatedAt(Number.isFinite(Number(data.updatedAt)) ? Number(data.updatedAt) : null);
        setRuntimeTask(data.task || 'idle');
        setRuntimeMeta(data.meta || {});
        setRuntimeLogs(data.lines || []);
        if (autoScrollLog && logContainerRef.current) {
          logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
        }
      } catch { /* ignore */ }
    }, 1200);
    return () => clearInterval(iv);
  }, [job.loading, autoScrollLog]);

  useEffect(() => {
    if (completionToast) {
      const timer = setTimeout(() => setCompletionToast(''), 3500);
      return () => clearTimeout(timer);
    }
  }, [completionToast]);

  const referenceTotalPages = Math.max(1, Math.ceil(referencePreview.length / referencePageSize));
  const pagedReferenceRows = referencePreview.slice((referencePage - 1) * referencePageSize, referencePage * referencePageSize);

  // ---- action runner ----
  async function runAction(label: string, fn: () => Promise<void>, step?: BlastPipelineStepKey, retries?: number, customToast?: string) {
    const started = Date.now();
    actionStartedAtRef.current = started;
    setJob({ loading: true, message: label, error: '' });
    if (step) {
      setActiveStep(step);
      setStepState((prev) => ({ ...prev, [step]: 'running' }));
    }
    const policyRetries = step ? Number(retryPolicy[step]) : 0;
    const totalRetries = typeof retries === 'number' ? retries : Number.isFinite(policyRetries) ? Math.max(0, Math.floor(policyRetries)) : 0;
    try {
      let lastError: unknown = null;
      let attemptsUsed = 0;
      for (let attempt = 0; attempt <= totalRetries; attempt++) {
        attemptsUsed = attempt + 1;
        try {
          if (attempt > 0) setJob({ loading: true, message: `${label} retrying (${attempt}/${totalRetries})`, error: '' });
          await fn();
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < totalRetries) { await sleep(retryIntervalMs); continue; }
        }
      }
      if (lastError) throw lastError;
      if (step) {
        const elapsed = Date.now() - started;
        setMetrics((prev) => ({ ...prev, [step]: { ...prev[step], runs: prev[step].runs + 1, success: prev[step].success + 1, totalMs: prev[step].totalMs + elapsed, retries: prev[step].retries + Math.max(0, attemptsUsed - 1), lastMs: elapsed, lastAttempts: attemptsUsed } }));
      }
      setJob({ loading: false, message: `${label} completed`, error: '' });
      if (step) {
        setStepState((prev) => ({ ...prev, [step]: 'success' }));
        setActiveStep(null);
        setLastCompletedStep(step);
      }
      const stepTitle = step ? (blastPipelineSteps.find((x) => x.key === step)?.title || label) : label;
      setCompletionToast(customToast || `${stepTitle} Done`);
      return true;
    } catch (err) {
      if (step) {
        const elapsed = Date.now() - started;
        setMetrics((prev) => ({ ...prev, [step]: { ...prev[step], runs: prev[step].runs + 1, fail: prev[step].fail + 1, totalMs: prev[step].totalMs + elapsed, lastMs: elapsed } }));
      }
      setJob({ loading: false, message: '', error: String(err) });
      if (step) { setStepState((prev) => ({ ...prev, [step]: 'error' })); setActiveStep(null); }
      return false;
    }
  }

  // ---- step functions ----
  async function runReferenceStep() {
    const list = accessions.split(/[,，;\n]+/).map((x) => x.trim()).filter(Boolean);
    if (!list.length) throw new Error('Please enter at least one accession');
    const data = await fetchReferences(list, entrezEmail);
    setReferencePreview(data.preview?.rows || []);
    setReferencePage(1);
    setReferenceFastaPath(data.fasta || '');
    setReferenceImportNotice('');
  }

  async function runReferenceUploadStep() {
    const uploadFile = validateReferenceFastaUpload(referenceUploadFile);
    const fastaText = validateReferenceFastaText(await uploadFile.text());
    const data = await importReferenceFasta(fastaText, uploadFile.name);
    setReferencePreview(data.preview?.rows || []);
    setReferencePage(1);
    setReferenceFastaPath(data.fasta || '');
    setAccessions('');
    setReferenceUploadFile(null);
    if (referenceUploadInputRef.current) {
      referenceUploadInputRef.current.value = '';
    }
    setReferenceImportNotice(`Imported ${data.rows} reference sequences from file ${uploadFile.name}`);
  }

  async function runRefPairwiseIdentity() {
    const data = await computeRefPairwiseIdentity(referenceFastaPath || undefined);
    setRefIdentityIds(data.ids || []);
    setRefIdentityMatrix(data.matrix || []);
  }

  async function runBlastDbSetup() {
    const data = await buildBlastDb({
      dbSource: blastDbSource,
      targetFasta: blastTargetFasta || undefined,
      ncbiDb: blastNcbiDb,
      deduplicateRefs: blastDeduplicateRefs,
      deduplicateIdentity: blastDeduplicateIdentity,
    });
    setBlastDbInfo(data);
  }

  async function runBlastSearchStep() {
    const data = await runBlastSearch({
      evalue: blastEvalue,
      identityMin: blastIdentityMin,
      queryCovMin: blastQueryCovMin,
      subjectLenMin: blastSubjectLenMin,
      subjectLenMax: blastSubjectLenMax,
      maxTargetSeqs: blastMaxTargetSeqs,
      matrix: blastMatrix,
      wordSize: blastWordSize,
      gapOpen: blastGapOpen,
      gapExtend: blastGapExtend,
      mergeStrategy: blastMergeStrategy,
      dbSource: blastDbSource,
      ncbiDb: blastNcbiDb,
    });
    setBlastSearchStats({ totalHits: data.totalHits, uniqueSubjects: data.uniqueSubjects, queriesUsed: data.queriesUsed });
    setBlastHitsRows(data.preview?.rows || []);
  }

  async function runBlastFilterStep() {
    const data = await filterBlastHits({
      evalueMax: blastFilterEvalueMax,
      identityMin: blastFilterIdentityMin,
      identityMax: blastFilterIdentityMax,
      queryCovMin: blastFilterQueryCovMin,
      subjectLenMin: blastFilterSubjectLenMin,
      subjectLenMax: blastFilterSubjectLenMax,
    });
    setBlastFilterStats({ kept: data.kept, total: data.total });
    setBlastFilteredRows(data.preview?.rows || []);
  }

  async function runAlignmentStep() {
    const data = await prepareScoringAlignment({ referenceFasta: referenceFastaPath || undefined, refId: refId || undefined });
    setAlignmentPrepInfo(data);
    setAlignmentPath(data.alignment || '');
  }

  async function runScoringStep() {
    const data = await runScoring(alignmentPath, refId, threshold, {
      autoFromFiltered: autoScoreFromFiltered,
      referenceFasta: referenceFastaPath || undefined,
      rules: scoringRules.length > 0 ? scoringRules : undefined,
      positionMode: scoringPositionMode,
      preAlignmentAnchor,
    });
    setScoringRunInfo(data);
    setScoringRows(data.preview?.rows || []);
    if (data.passedFasta) setCandidateFasta(data.passedFasta);
    if (autoDownloadScoringCsv && data.csv) {
      try {
        const dl = await downloadScoringCsv(data.csv);
        const url = URL.createObjectURL(dl.blob);
        const a = document.createElement('a');
        a.href = url; a.download = dl.fileName; a.click();
        URL.revokeObjectURL(url);
      } catch { /* ignore */ }
    }
  }

  async function runClusteringStep() {
    const input = candidateFasta || 'scored_passed.fasta';
    setClusteringRunInfo(null);
    const data = await runClustering(input, clusterIdentity, clusterWordSize);
    setCandidateFasta(data.outputFasta);
    setClusteringRunInfo({
      inputFasta: input,
      outputFasta: data.outputFasta,
      clusterFile: data.clusterFile,
      inputCount: data.inputCount,
      outputCount: data.outputCount,
      deduplicatedCount: data.deduplicatedCount,
      clusters: data.clusters,
    });
  }

  async function runComputeSimilarity() {
    const data = await computeNetworkSimilarity({
      includeReferenceLinks: networkIncludeReferenceLinks,
      similarityMethod: networkSimilarityMethod,
      sourceFasta: networkSourceFasta || undefined,
      referenceFasta: networkReferenceFasta || undefined,
    });
    setNetworkStats({ nodes: data.nodes, edges: data.edges });
  }

  async function runNetworkPush() {
    const data = await pushNetworkToCytoscape({
      baseUrl: cytoBaseUrl,
      title: cytoNetworkTitle,
      collection: cytoCollection,
      layout: cytoLayout,
      styleName: `${cytoCategoryColumn}_style`,
      categoryColumn: cytoCategoryColumn,
      applyStyle: cytoApplyStyle,
      pairwiseThresholdPct: networkPairwiseThresholdPct,
      includeReferenceLinks: networkIncludeReferenceLinks,
      similarityMethod: networkSimilarityMethod,
      sourceFasta: networkSourceFasta || undefined,
      referenceFasta: networkReferenceFasta || undefined,
    });
    setCytoPushInfo(data);
  }

  async function runRecommendation() {
    const data = await recommendCandidates({ weights: normalizeRecommendWeights(recommendWeights), topN: recommendTopN, minClusterSize: recommendMinClusterSize, minSimilarity: recommendMinSimilarity, temperature: recommendTemperature, diversityMode: recommendDiversityMode, networkConnectivityThreshold: recommendNetworkConnectivityThreshold, predictedSubWeights: normalizePredictedSubWeights(predictedSubWeights), predictedTmTarget });
    setRecommendResults(data.candidates);
    setRecommendMeta({ totalCandidates: data.totalCandidates, totalReferences: data.totalReferences, filteredByClusterSize: data.filteredByClusterSize, filteredBySimilarity: data.filteredBySimilarity, predictedMetricsAvailable: data.predictedMetricsAvailable });
  }

  async function highlightRecommendationsInNetwork() {
    if (!recommendResults.length) return;
    try {
      setActiveTaskId(selectedTaskId);
      if (!browserGraphVisible || !browserGraphNodes.length || !browserGraphAllEdges.length) {
        const data = await fetchBrowserGraphData({ pairwiseThresholdPct: browserGraphThreshold });
        setBrowserGraphNodes(data.nodes);
        setBrowserGraphAllEdges(data.edges);
        setBrowserGraphLoadedThreshold(data.appliedThresholdPct);
        setBrowserGraphThreshold(data.appliedThresholdPct);
        setBrowserGraphThresholdAdjusted(Boolean(data.thresholdAdjusted));
        setBrowserGraphMaxEdges(data.maxEdges);
        setBrowserGraphVisible(true);
      }
      setCompletionToast(`Highlighted ${recommendResults.length} recommended sequences in the network; return to Similarity Network to view`);
    } catch (err: any) {
      alert('Highlight failed: ' + (err?.message || err));
    }
  }

  async function createTaskAndSwitch() {
    const data = await createTask(newTaskId || undefined, undefined, 'blast');
    setNewTaskId('');
    await refreshTasks();
    setSelectedTaskId(data.task.id);
  }

    async function duplicateSelectedTask() {
    const typed = newTaskId.trim();
    const data = await duplicateTask(selectedTaskId, typed || undefined, typed || undefined);
    setNewTaskId('');
    await refreshTasks();
    setSelectedTaskId(data.task.id);
  }

  async function deleteSelectedTask() {
    if (selectedTaskId === 'blast-default') throw new Error('The default task cannot be deleted');
    await deleteTask(selectedTaskId);
    await refreshTasks();
  }

  const loadAlignmentPreviewPage = async (nextOffset: number) => {
    const preview = await loadScoringAlignmentPreview({
      alignment: alignmentPath,
      start: alignmentPreviewStart,
      end: alignmentPreviewEnd,
      limit: alignmentPreviewLimit,
      offset: Math.max(0, nextOffset),
    });
    setAlignmentPreviewRows(preview.rows || []);
    setAlignmentPreviewOffset(Number(preview.offset || 0));
    setAlignmentPreviewTotalRecords(Number(preview.totalRecords || 0));
    setAlignmentPreviewLength(Number(preview.alignmentLength || 0));
  };

  const clearLogs = async () => {
    await clearRuntimeLogs();
    setRuntimeTask('idle');
    setRuntimeActive(false);
    setRuntimeStartedAt(null);
    setRuntimeUpdatedAt(null);
    setRuntimeMeta({});
    setRuntimeLogs([]);
  };

  const renderTailPanels = (logHeightClass = 'h-40', showRetry = false) => (
    <>
      {showRetry && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3">
          <div className="text-sm font-medium text-slate-700">Retry Strategy</div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
            {blastPipelineSteps.map((s) => (
              <div key={s.key}>
                <label className="block text-xs text-slate-500 mb-1">{s.title}</label>
                <input type="number" min={0} max={5} value={retryPolicy[s.key]}
                  onChange={(e) => setRetryPolicy((prev) => ({ ...prev, [s.key]: Math.max(0, Math.min(5, Number(e.target.value))) }))}
                  className="w-full p-2 bg-slate-50 border border-slate-300 rounded text-sm" />
              </div>
            ))}
            <div>
              <label className="block text-xs text-slate-500 mb-1">Retry Interval (ms)</label>
              <input type="number" min={100} step={100} value={retryIntervalMs}
                onChange={(e) => setRetryIntervalMs(Math.max(100, Number(e.target.value)))}
                className="w-full p-2 bg-slate-50 border border-slate-300 rounded text-sm" />
            </div>
          </div>
        </div>
      )}
      <RuntimeLogsSection
        jobLoading={job.loading}
        runtimeTask={runtimeTask}
        runtimeStartedAt={runtimeStartedAt}
        runtimeUpdatedAt={runtimeUpdatedAt}
        runtimeActive={runtimeActive}
        runtimeMeta={runtimeMeta}
        runtimeLogs={runtimeLogs}
        autoScrollLog={autoScrollLog}
        setAutoScrollLog={setAutoScrollLog}
        logContainerRef={logContainerRef}
        onClearLogs={clearLogs}
        logHeightClass={logHeightClass}
      />
    </>
  );

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50 text-slate-900 font-sans">
      {/* Completion toast */}
      {completionToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 px-5 py-2 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm shadow-lg animate-bounce-in">
          {completionToast}
        </div>
      )}

      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col shadow-sm z-10">
        <div className="h-16 flex items-center justify-between px-4 border-b border-slate-200">
          <button onClick={onBack} className="flex items-center gap-2 text-emerald-600 hover:text-emerald-800 transition-colors" title="Back to home">
            <Activity className="w-6 h-6" />
            <span className="font-semibold text-lg tracking-tight text-slate-900">EnzyMiner</span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-4">
          <nav className="space-y-1 px-3">
            <Section title="Overview" />
            <NavItem icon={<Settings className="w-4 h-4" />} label="Dashboard" active={currentView === 'dashboard'} onClick={() => setCurrentView('dashboard')} />

            <Section title="BLAST Pipeline" />
            <NavItem icon={<List className="w-4 h-4" />} label="1. Reference Input" active={currentView === 'reference'} onClick={() => setCurrentView('reference')} />
            <NavItem icon={<Database className="w-4 h-4" />} label="2. BLAST DB Setup" active={currentView === 'blast-db'} onClick={() => setCurrentView('blast-db')} />
            <NavItem icon={<Search className="w-4 h-4" />} label="3. BLAST Search" active={currentView === 'blast-search'} onClick={() => setCurrentView('blast-search')} />
            <NavItem icon={<Database className="w-4 h-4" />} label="4. Alignment" active={currentView === 'alignment'} onClick={() => setCurrentView('alignment')} />
            <NavItem icon={<CheckCircle2 className="w-4 h-4" />} label="5. Scoring" active={currentView === 'scoring'} onClick={() => setCurrentView('scoring')} />
            <NavItem icon={<Database className="w-4 h-4" />} label="6. Clustering" active={currentView === 'clustering'} onClick={() => setCurrentView('clustering')} />
            <NavItem icon={<Activity className="w-4 h-4" />} label="7. Similarity" active={currentView === 'similarity'} onClick={() => setCurrentView('similarity')} />

            <Section title="Analysis" />
            <NavItem icon={<Network className="w-4 h-4" />} label="Similarity Network" active={currentView === 'network'} onClick={() => setCurrentView('network')} />
            <NavItem icon={<Star className="w-4 h-4" />} label="Recommendation" active={currentView === 'recommendation'} onClick={() => setCurrentView('recommendation')} />
          </nav>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col h-full overflow-hidden">
        <header className="min-h-16 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-8 py-3 shadow-sm z-10">
          <div className="flex items-center text-sm text-slate-500 shrink-0">
            <span>BLAST Pipeline</span>
            <ChevronRight className="w-4 h-4 mx-1" />
            <span className="font-medium text-slate-900 capitalize">{currentView.replace(/-/g, ' ')}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500">Task</span>
              <select className="p-1.5 border border-slate-300 rounded text-xs bg-white" value={selectedTaskId}
                onChange={(e) => setSelectedTaskId(e.target.value)} disabled={job.loading}>
                {taskList.map((t) => (<option key={t.id} value={t.id}>{t.id}</option>))}
              </select>
              <input className="p-1.5 border border-slate-300 rounded text-xs w-32" value={newTaskId}
                onChange={(e) => setNewTaskId(e.target.value)} placeholder="New task ID (optional)" disabled={job.loading} />
              <button className="px-2 py-1.5 rounded bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
                onClick={() => runAction('Create task', createTaskAndSwitch)} disabled={job.loading}>New</button>
              <button className="px-2 py-1.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50"
                onClick={() => runAction('Duplicate task', duplicateSelectedTask)} disabled={job.loading}>Copy</button>
              <button className="px-2 py-1.5 rounded bg-red-600 text-white text-xs hover:bg-red-700 disabled:opacity-50"
                onClick={() => runAction('Delete task', deleteSelectedTask)} disabled={job.loading || selectedTaskId === 'blast-default'}>Delete</button>

            </div>
            <button className="p-2 rounded-lg hover:bg-slate-100" onClick={() => setDarkMode((v) => !v)}
              title={darkMode ? 'Light Mode' : 'Dark Mode'}>
              {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8 space-y-6">
          {/* Status bar */}
          {job.error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <pre className="whitespace-pre-wrap break-all">{job.error}</pre>
            </div>
          )}
          {job.loading && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-sm text-blue-600 flex items-center gap-2">
              <span className="inline-block w-3 h-3 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
              {job.message}
            </div>
          )}

          {/* Progress panel */}
          <BlastPipelineProgressPanel stepState={stepState} activeStep={activeStep} loading={job.loading} lastCompletedStep={lastCompletedStep} />

          {/* ==== Dashboard ==== */}
          {currentView === 'dashboard' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold">BLAST Enzyme Mining Workflow</h1>
              <p className="text-sm text-slate-500">Suitable for cases with few reference sequences (1-5), using BLAST pairwise search against protein databases.</p>
              <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                onClick={() => runAction('Check backend status', async () => { const data = await healthCheck(); setHealth(data); })}>
                Check backend health
              </button>
              {health && (
                <div className="bg-white border border-slate-200 rounded-xl p-4 text-sm space-y-2">
                  <div>taskId: {health.taskId}</div>
                  <div>pipelineRoot: {health.pipelineRoot}</div>
                  <div>workDir: {health.workDir}</div>
                  <div className="flex gap-3 flex-wrap">
                    {Object.entries(health.tools).map(([name, ok]) => (
                      <span key={name} className={`px-2 py-1 rounded ${ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                        {name}: {String(ok)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {renderTailPanels('h-44', true)}
            </div>
          )}

          {/* ==== Step 1: Reference ==== */}
          {currentView === 'reference' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold">1. Reference Input & Download</h1>
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="text-sm font-semibold text-slate-700">Two ways to load reference sequences</div>
                  <div className="mt-1 text-sm text-slate-500">
                    Pick either one to generate this task's ref.csv and ref.fasta. Use Method A when you only have accessions; use Method B when you already have a FASTA file.
                  </div>
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <section className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <span className="rounded-full bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white">Method A</span>
                      <div>
                        <div className="text-sm font-semibold text-slate-800">Fetch online by accession</div>
                        <div className="text-xs text-slate-500">Suitable when you only have accession, protein_id, or UniProt ID</div>
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-slate-700">Entrez Email</label>
                      <input className="w-full rounded-lg border border-slate-200 bg-white p-2 text-sm" value={entrezEmail} onChange={(e) => setEntrezEmail(e.target.value)} />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-slate-700">Accession List</label>
                      <p className="mb-2 text-xs text-slate-500 leading-relaxed">
                        Supports mixed input of <strong>NCBI Protein</strong>, <strong>NCBI Nucleotide</strong>, and <strong>UniProt</strong>; the system automatically detects the source and fetches reference sequences.
                      </p>
                      <textarea className="h-56 w-full rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs placeholder:text-slate-400"
                        value={accessions} onChange={(e) => setAccessions(e.target.value)} placeholder={accessionPlaceholder} />
                    </div>
                    <button className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700" disabled={job.loading}
                      onClick={() => runAction('Download reference sequences', runReferenceStep, 'reference')}>
                      Fetch online and generate ref.csv / ref.fasta
                    </button>
                  </section>
                  <section className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <span className="rounded-full bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white">Method B</span>
                      <div>
                        <div className="text-sm font-semibold text-slate-800">Upload a local FASTA file</div>
                        <div className="text-xs text-slate-500">Suitable when you already have a reference sequence file and want to proceed directly to the BLAST workflow</div>
                      </div>
                    </div>
                    <div className="rounded-xl border border-sky-200 bg-white/80 px-3 py-2 text-xs text-slate-500">
                      Supports .fasta, .fa, .faa, .fas, .fna, .txt; single file limit 20 MB. Importing will directly overwrite the current task's reference set.
                    </div>
                    <input
                      ref={referenceUploadInputRef}
                      type="file"
                      accept=".fasta,.fa,.faa,.fas,.fna,text/plain"
                      className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-sky-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-sky-700 hover:file:bg-sky-200"
                      onChange={(e) => setReferenceUploadFile(e.target.files?.[0] || null)}
                    />
                    <div className="rounded-xl border border-dashed border-sky-300 bg-white/80 px-3 py-3 text-sm text-slate-600">
                      {referenceUploadFile
                        ? `Selected file: ${referenceUploadFile.name} · ${formatFileSize(referenceUploadFile.size)}`
                        : 'No file selected yet. Please choose a local FASTA file before importing.'}
                    </div>
                    <button
                      className="w-full rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
                      disabled={job.loading || !referenceUploadFile}
                      onClick={() => runAction('Upload reference FASTA', runReferenceUploadStep, 'reference')}
                    >
                      Upload, import, and generate ref.csv / ref.fasta
                    </button>
                  </section>
                </div>
                {referenceImportNotice && (
                  <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700">
                    {referenceImportNotice}
                  </div>
                )}
              </div>
              <ReferencePreviewTable rows={pagedReferenceRows} allRows={referencePreview} page={referencePage}
                totalPages={referenceTotalPages} onPageChange={setReferencePage} />
              {referencePreview.length > 0 && (
                <div className="space-y-3">
                  <button className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                    onClick={() => runAction('Compute Pairwise Identity', runRefPairwiseIdentity, 'reference')}>
                    Compute reference sequence pairwise identity
                  </button>
                  <IdentityHeatmap ids={refIdentityIds} matrix={refIdentityMatrix} title="Reference Sequence Pairwise Identity Heatmap" />
                </div>
              )}
              {renderTailPanels('h-28')}
            </div>
          )}

          {/* ==== Step 2: BLAST DB Setup ==== */}
          {currentView === 'blast-db' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold">2. BLAST DB Setup</h1>
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Database Source</label>
                  <select className="w-full p-2 border rounded text-sm" value={blastDbSource}
                    onChange={(e) => setBlastDbSource(e.target.value as BlastDbSource)}>
                    <option value="local">Local FASTA → makeblastdb</option>
                    <option value="ncbi-remote">NCBI Remote Database</option>
                  </select>
                </div>

                {blastDbSource === 'local' && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Target Proteome FASTA Path</label>
                    <input className="w-full p-2 border rounded text-sm font-mono" value={blastTargetFasta}
                      onChange={(e) => setBlastTargetFasta(e.target.value)} placeholder="e.g.: /path/to/proteomes.fasta" />
                    <p className="text-xs text-slate-500 mt-1">Local protein sequence collection, will be built into a BLAST database using makeblastdb</p>
                  </div>
                )}

                {blastDbSource === 'ncbi-remote' && (
                  <div>
                    <label className="block text-sm font-medium mb-1">NCBI Database</label>
                    <select className="w-full p-2 border rounded text-sm" value={blastNcbiDb}
                      onChange={(e) => setBlastNcbiDb(e.target.value)}>
                      <option value="nr">nr（Non-redundant protein）</option>
                      <option value="swissprot">SwissProt</option>
                      <option value="refseq_protein">RefSeq Protein</option>
                      <option value="pdb">PDB</option>
                    </select>
                    <p className="text-xs text-slate-500 mt-1">Uses blastp -remote to search the NCBI remote database directly (slower but requires no local data)</p>
                  </div>
                )}

                <div className="border-t pt-3">
                  <div className="flex items-center gap-3 mb-2">
                    <input type="checkbox" checked={blastDeduplicateRefs} onChange={(e) => setBlastDeduplicateRefs(e.target.checked)}
                      className="accent-emerald-600" />
                    <label className="text-sm text-slate-700">Apply CD-HIT deduplication to reference sequences</label>
                  </div>
                  {blastDeduplicateRefs && (
                    <div className="ml-6">
                      <label className="block text-xs text-slate-500 mb-1">Dedup Identity Threshold</label>
                      <input type="number" step={0.01} min={0.5} max={1} value={blastDeduplicateIdentity}
                        onChange={(e) => setBlastDeduplicateIdentity(Number(e.target.value))}
                        className="p-2 border rounded text-sm w-32" />
                    </div>
                  )}
                </div>

                <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                  onClick={() => runAction('Build BLAST database', runBlastDbSetup, 'blast-db')}>
                  {blastDbSource === 'local' ? 'Build Local BLAST Database' : 'Configure Remote NCBI BLAST'}
                </button>
              </div>

              {blastDbInfo && (
                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 text-sm">
                  <div className="font-medium text-slate-700">Database Build Result</div>
                  <div>Database source: <span className="font-mono">{blastDbInfo.dbSource}</span></div>
                  {blastDbInfo.dbPath && <div>Database path: <span className="font-mono text-xs">{blastDbInfo.dbPath}</span></div>}
                  <div>Reference sequences: {blastDbInfo.refInputCount} → after dedup {blastDbInfo.refDedupCount}</div>
                </div>
              )}

              {renderTailPanels('h-28')}
            </div>
          )}

          {/* ==== Step 3: BLAST Search & Filter ==== */}
          {currentView === 'blast-search' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold">3. BLAST Search & Filter</h1>

              {/* Search parameters */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
                <div className="text-sm font-medium text-slate-700">Search Parameters</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">E-value Threshold</label>
                    <input type="text" value={blastEvalue} onChange={(e) => setBlastEvalue(Number(e.target.value) || 1e-10)}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Minimum Identity (%)</label>
                    <input type="number" value={blastIdentityMin} onChange={(e) => setBlastIdentityMin(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Minimum Query Coverage (%)</label>
                    <input type="number" value={blastQueryCovMin} onChange={(e) => setBlastQueryCovMin(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Max Target Seqs</label>
                    <input type="number" value={blastMaxTargetSeqs} onChange={(e) => setBlastMaxTargetSeqs(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Subject Minimum Length</label>
                    <input type="number" value={blastSubjectLenMin} onChange={(e) => setBlastSubjectLenMin(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Subject Maximum Length</label>
                    <input type="number" value={blastSubjectLenMax} onChange={(e) => setBlastSubjectLenMax(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Substitution Matrix</label>
                    <select className="w-full p-2 border rounded text-sm" value={blastMatrix}
                      onChange={(e) => setBlastMatrix(e.target.value)}>
                      <option>BLOSUM62</option>
                      <option>BLOSUM45</option>
                      <option>BLOSUM80</option>
                      <option>PAM30</option>
                      <option>PAM70</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Merge Strategy</label>
                    <select className="w-full p-2 border rounded text-sm" value={blastMergeStrategy}
                      onChange={(e) => setBlastMergeStrategy(e.target.value as BlastMergeStrategy)}>
                      <option value="best-evalue">Best E-value (keep the best match per subject)</option>
                      <option value="union">Union (keep the best match from every query)</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                    onClick={() => runAction('Run BLAST search', runBlastSearchStep, 'blast-search')}>
                    Run BLAST search
                  </button>
                </div>
              </div>

              {/* BLAST search progress */}
              {runtimeMeta?.blastProgress && runtimeTask === 'blast/search' && job.loading && (() => {
                const bp = runtimeMeta.blastProgress as {
                  current: number; total: number; queryId: string;
                  queryTimings: Array<{ ms: number }>; estimatedRemainingMs: number | null;
                };
                const pct = bp.total > 0 ? Math.round((bp.current / bp.total) * 100) : 0;
                const timings = bp.queryTimings || [];
                const formatTime = (ms: number) => {
                  if (ms < 1000) return `${ms}ms`;
                  const s = ms / 1000;
                  if (s < 60) return `${s.toFixed(1)}s`;
                  const m = Math.floor(s / 60);
                  const rs = Math.round(s % 60);
                  return `${m}m${rs}s`;
                };
                return (
                  <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium text-slate-700">
                        BLAST Search Progress
                      </div>
                      <div className="text-xs text-slate-500">
                        {bp.current}/{bp.total} sequences
                      </div>
                    </div>

                    {/* Progress bar */}
                    <div className="h-3 w-full rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-emerald-500 progress-shimmer transition-all duration-700"
                        style={{ width: `${Math.max(pct, bp.current > 0 ? 2 : 0)}%` }}
                      />
                    </div>

                    {/* Current query */}
                    {bp.queryId && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                        <span className="text-slate-600">Searching:</span>
                        <span className="font-mono text-xs text-slate-800">{bp.queryId}</span>
                        <span className="text-slate-400">({bp.current + 1}/{bp.total})</span>
                      </div>
                    )}

                    {/* ETA */}
                    {bp.estimatedRemainingMs !== null && bp.estimatedRemainingMs > 0 && (
                      <div className="text-xs text-slate-500">
                        Estimated time remaining: <span className="font-medium text-slate-700">{formatTime(bp.estimatedRemainingMs)}</span>
                      </div>
                    )}

                    {/* Per-query timings table */}
                    {timings.length > 0 && (
                      <div className="border-t pt-2">
                        <div className="text-xs font-medium text-slate-500 mb-1.5">Per-sequence Search Time</div>
                        <div className="flex flex-wrap gap-2">
                          {timings.map((t: { ms: number }, i: number) => (
                            <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-200 text-xs">
                              <span className="text-slate-500">Q{i + 1}</span>
                              <span className="font-mono text-slate-700">{formatTime(t.ms)}</span>
                            </div>
                          ))}
                          {bp.current < bp.total && (
                            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-xs">
                              <span className="text-emerald-600">Q{timings.length + 1}</span>
                              <span className="inline-block w-3 h-3 border-2 border-emerald-300 border-t-emerald-600 rounded-full animate-spin" />
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {blastSearchStats && (
                <div className="bg-white border border-slate-200 rounded-xl p-4 text-sm space-y-1">
                  <div className="font-medium text-slate-700">Search Results Overview</div>
                  <div>Queries used: {blastSearchStats.queriesUsed}</div>
                  <div>Raw hit count: {blastSearchStats.totalHits}</div>
                  <div>Unique subjects after dedup: {blastSearchStats.uniqueSubjects}</div>
                </div>
              )}

              {/* Filter section */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
                <div className="text-sm font-medium text-slate-700">Filter Parameters</div>
                <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">E-value ≤</label>
                    <input type="text" value={blastFilterEvalueMax} onChange={(e) => setBlastFilterEvalueMax(Number(e.target.value) || 1e-10)}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Identity ≥ (%)</label>
                    <input type="number" value={blastFilterIdentityMin} onChange={(e) => setBlastFilterIdentityMin(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Identity ≤ (%)</label>
                    <input type="number" value={blastFilterIdentityMax} onChange={(e) => setBlastFilterIdentityMax(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Query Cov ≥ (%)</label>
                    <input type="number" value={blastFilterQueryCovMin} onChange={(e) => setBlastFilterQueryCovMin(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Subject Minimum</label>
                    <input type="number" value={blastFilterSubjectLenMin} onChange={(e) => setBlastFilterSubjectLenMin(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Subject Maximum</label>
                    <input type="number" value={blastFilterSubjectLenMax} onChange={(e) => setBlastFilterSubjectLenMax(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                </div>
                <button className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                  onClick={() => runAction('Filter BLAST hits', runBlastFilterStep, 'blast-search')}>
                  Filter hits
                </button>
                {blastFilterStats && (
                  <div className="text-sm text-slate-600">
                    {blastFilterStats.total} → kept {blastFilterStats.kept}
                  </div>
                )}
              </div>

              {/* NCBI Taxonomy Annotation */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="text-sm font-medium text-slate-700">NCBI Taxonomy Annotation</div>
                <p className="text-xs text-slate-500">
                  Query NCBI Entrez to get taxonomy information (kingdom / phylum / class / species) for BLAST hit sequences, used later for Cytoscape network node coloring.
                </p>
                <button
                  className="bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-lg text-sm"
                  disabled={job.loading}
                  onClick={() => runAction('Annotate BLAST hits', async () => {
                    await annotateBlastHits();
                    // Refresh hits table after annotation
                    const data = await loadBlastSearchPage(1, blastSearchPageSize, blastSearchSource);
                    setBlastSearchPage(1);
                    setBlastSearchTotalPages(data.totalPages);
                    if (blastSearchSource === 'blast_hits_filtered') setBlastFilteredRows(data.preview?.rows || []);
                    else setBlastHitsRows(data.preview?.rows || []);
                  }, 'blast-search')}
                >
                  Query NCBI Taxonomy Info
                </button>
                {/* Annotation progress */}
                {runtimeMeta && typeof (runtimeMeta as any).blastAnnotateProgress === 'number' && runtimeTask === 'blast/annotate' && job.loading && (() => {
                  const pct = (runtimeMeta as any).blastAnnotateProgress as number;
                  const phase = (runtimeMeta as any).blastAnnotatePhase as string || '';
                  return (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <span>{phase === 'fetching' ? 'Fetching taxonomy info from NCBI...' : phase === 'done' ? 'Done' : 'Processing...'}</span>
                        <span>{pct}%</span>
                      </div>
                      <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-violet-500 progress-shimmer transition-all duration-700"
                          style={{ width: `${Math.max(pct, 2)}%` }}
                        />
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Hits table with pagination */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-3 text-sm">
                  <select className="p-1.5 border rounded text-xs" value={blastSearchSource}
                    onChange={(e) => { setBlastSearchSource(e.target.value as any); setBlastSearchPage(1); }}>
                    <option value="blast_hits_all">All Hits</option>
                    <option value="blast_hits_filtered">Filtered</option>
                  </select>
                  <div className="flex gap-2">
                    <button className="px-2 py-1 border rounded text-xs disabled:opacity-50" disabled={blastSearchPage <= 1 || job.loading}
                      onClick={() => runAction('Load previous page', async () => {
                        const prev = Math.max(1, blastSearchPage - 1);
                        const data = await loadBlastSearchPage(prev, blastSearchPageSize, blastSearchSource);
                        setBlastSearchPage(prev);
                        setBlastSearchTotalPages(data.totalPages);
                        if (blastSearchSource === 'blast_hits_filtered') setBlastFilteredRows(data.preview?.rows || []);
                        else setBlastHitsRows(data.preview?.rows || []);
                      })}>Previous Page</button>
                    <span className="text-xs text-slate-500 py-1">{blastSearchPage}/{blastSearchTotalPages}</span>
                    <button className="px-2 py-1 border rounded text-xs disabled:opacity-50" disabled={blastSearchPage >= blastSearchTotalPages || job.loading}
                      onClick={() => runAction('Load next page', async () => {
                        const next = Math.min(blastSearchTotalPages, blastSearchPage + 1);
                        const data = await loadBlastSearchPage(next, blastSearchPageSize, blastSearchSource);
                        setBlastSearchPage(next);
                        setBlastSearchTotalPages(data.totalPages);
                        if (blastSearchSource === 'blast_hits_filtered') setBlastFilteredRows(data.preview?.rows || []);
                        else setBlastHitsRows(data.preview?.rows || []);
                      })}>Next Page</button>
                  </div>
                </div>
                <SimpleTable rows={blastSearchSource === 'blast_hits_filtered' ? blastFilteredRows : blastHitsRows} />
              </div>

              {renderTailPanels('h-28')}
            </div>
          )}

          {/* ==== Step 4: Alignment ==== */}
          {currentView === 'alignment' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold">4. Alignment (MAFFT)</h1>
              <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Filter FASTA (leave blank = backend default)</label>
                  <input className="w-full p-2 border rounded text-sm" value={candidateFasta} onChange={(e) => setCandidateFasta(e.target.value)} placeholder="e.g.: /path/to/hits_filtered.fasta" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Reference FASTA (leave blank = backend default)</label>
                  <input className="w-full p-2 border rounded text-sm" value={referenceFastaPath} onChange={(e) => setReferenceFastaPath(e.target.value)} placeholder="e.g.: /path/to/ref.fasta" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Reference Sequence ID</label>
                  <input className="w-full p-2 border rounded text-sm" value={refId} onChange={(e) => setRefId(e.target.value)} placeholder="Leave blank = automatically use the first reference sequence" />
                </div>
                <button
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm h-10"
                  disabled={job.loading}
                  onClick={() => runAction('Generate alignment file', runAlignmentStep, 'alignment')}
                >
                  Generate Alignment and Load Preview
                </button>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
                  <InputNum label="Column Start" value={alignmentPreviewStart} step={10} onChange={(v) => setAlignmentPreviewStart(Math.max(1, Math.floor(v)))} />
                  <InputNum label="Column End" value={alignmentPreviewEnd} step={10} onChange={(v) => setAlignmentPreviewEnd(Math.max(1, Math.floor(v)))} />
                  <div className="text-xs text-slate-600 md:col-span-2">
                    Alignment file: {alignmentPath || '(none)'}
                  </div>
                  <button
                    className="px-3 py-2 rounded border border-slate-300 text-sm"
                    disabled={job.loading || !alignmentPath}
                    onClick={() => runAction('Refresh alignment preview', async () => {
                      await loadAlignmentPreviewPage(0);
                    })}
                  >
                    Refresh Preview
                  </button>
                  <div className="text-xs text-slate-600">
                    rows: {alignmentPreviewRows.length}/{alignmentPreviewTotalRecords} | alnLen: {alignmentPreviewLength}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
                    disabled={job.loading || alignmentPreviewOffset <= 0 || !alignmentPath}
                    onClick={() => runAction('Previous alignment preview page', async () => {
                      await loadAlignmentPreviewPage(Math.max(0, alignmentPreviewOffset - alignmentPreviewLimit));
                    })}
                  >
                    Previous Page
                  </button>
                  <button
                    className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
                    disabled={job.loading || alignmentPreviewOffset + alignmentPreviewLimit >= alignmentPreviewTotalRecords || !alignmentPath}
                    onClick={() => runAction('Next alignment preview page', async () => {
                      await loadAlignmentPreviewPage(alignmentPreviewOffset + alignmentPreviewLimit);
                    })}
                  >
                    Next Page
                  </button>
                  <span className="text-xs text-slate-500">
                    offset: {alignmentPreviewOffset}
                  </span>
                </div>

                <div className="overflow-auto border rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-2 py-2 text-left">ID</th>
                        <th className="px-2 py-2 text-left">Alignment Segment (Interactive Window)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {alignmentPreviewRows.map((r, idx) => (
                        <tr key={`${r.id}-${idx}`} className="border-b last:border-b-0">
                          <td className="px-2 py-1.5 whitespace-nowrap">{r.id}</td>
                          <td className="px-2 py-1.5 font-mono text-[11px]">{r.segment}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {renderTailPanels('h-28')}
            </div>
          )}

          {/* ==== Step 5: Scoring ==== */}
          {currentView === 'scoring' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold">5. Active Site Scoring</h1>
              <div className="bg-white border border-slate-200 rounded-xl p-3 text-sm text-slate-700 space-y-1.5">
                <div className="font-semibold text-slate-900">Current Run Status</div>
                <div className="text-xs text-slate-600">
                  Most recent alignment file: {(scoringRunInfo?.alignmentUsed || alignmentPath || '(none)')}
                </div>
                <div className="text-xs text-slate-600">
                  Current position mode:
                  {scoringPositionMode === 'pre' ? 'Pre-alignment residue number' : 'Post-alignment column number'}
                  {scoringPositionMode === 'pre'
                    ? (preAlignmentAnchor === 'first' ? ' (default: follows the first sequence)' : ` (anchored by reference ID: ${refId || '(empty)'})`)
                    : ''}
                </div>
                {scoringRunInfo && (
                  <div className="text-xs text-slate-600">
                    Most recent scoring: {scoringRunInfo.passed}/{scoringRunInfo.total} passed threshold
                  </div>
                )}
                {scoringRunInfo?.passedFasta && (
                  <div className="text-xs text-slate-600">
                    Threshold filter module: exported FASTA of passing sequences ({scoringRunInfo.passedCount || 0}) → path {scoringRunInfo.passedFasta}
                  </div>
                )}
                {alignmentPrepInfo && (
                  <div className="text-xs text-slate-600">
                    Most recent alignment-only run: records={alignmentPrepInfo.records} | {alignmentPrepInfo.alignment}
                  </div>
                )}
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Alignment path (leave blank = backend default)</label>
                  <input className="w-full p-2 border rounded text-sm" value={alignmentPath} onChange={(e) => setAlignmentPath(e.target.value)} placeholder="e.g.: /path/to/alignment.fasta" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Reference Sequence ID</label>
                  <input className="w-full p-2 border rounded text-sm" value={refId} onChange={(e) => setRefId(e.target.value)} placeholder="Leave blank = automatically use the first reference sequence" />
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Position Coordinate Mode</label>
                  <select
                    className="w-full p-2 border rounded text-sm"
                    value={scoringPositionMode}
                    onChange={(e) => setScoringPositionMode((e.target.value === 'aligned' ? 'aligned' : 'pre'))}
                  >
                    <option value="pre">Pre-alignment (residue number)</option>
                    <option value="aligned">Post-alignment (MSA column number)</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-700 pb-2">
                  <input
                    type="checkbox"
                    checked={preAlignmentAnchor === 'refid'}
                    disabled={scoringPositionMode !== 'pre'}
                    onChange={(e) => setPreAlignmentAnchor(e.target.checked ? 'refid' : 'first')}
                  />
                  Use reference ID anchoring in pre-alignment mode (off = default to the first sequence)
                </label>
                <div className="text-xs text-slate-500 pb-2">
                  Pre-alignment: automatically maps anchor sequence residue numbers to MSA columns; Post-alignment: treats pos directly as the column number.
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-sm text-slate-700">Scoring Rules (directly editable)</div>
                  <div className="text-xs text-slate-500">Current rule count: {scoringRules.length}</div>
                </div>

                <div className="overflow-auto border rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-2 py-2 text-left">Pos</th>
                        <th className="px-2 py-2 text-left">Allowed (comma separated)</th>
                        <th className="px-2 py-2 text-left">Score</th>
                        <th className="px-2 py-2 text-left">Label</th>
                        <th className="px-2 py-2 text-left">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scoringRules.map((rule, idx) => (
                        <tr key={`${rule.label}-${idx}`} className="border-b last:border-b-0">
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              className="w-24 p-1 border rounded"
                              value={rule.pos}
                              onChange={(e) => {
                                const pos = Number(e.target.value);
                                setScoringRules((prev) => prev.map((r, i) => (i === idx ? { ...r, pos } : r)));
                                setScoringRulesSuccess('');
                              }}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              className="w-full p-1 border rounded font-mono"
                              value={scoringAllowedDrafts[idx] ?? rule.allowed.join(',')}
                              onChange={(e) => {
                                const raw = e.target.value;
                                const allowed = parseAllowedInput(raw);
                                setScoringAllowedDrafts((prev) => ({ ...prev, [idx]: raw }));
                                setScoringRules((prev) => prev.map((r, i) => (i === idx ? { ...r, allowed } : r)));
                                setScoringRulesSuccess('');
                              }}
                              onBlur={(e) => {
                                const normalized = parseAllowedInput(e.target.value).join(',');
                                setScoringAllowedDrafts((prev) => ({ ...prev, [idx]: normalized }));
                              }}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              step="0.1"
                              className="w-24 p-1 border rounded"
                              value={rule.score}
                              onChange={(e) => {
                                const score = Number(e.target.value);
                                setScoringRules((prev) => prev.map((r, i) => (i === idx ? { ...r, score } : r)));
                                setScoringRulesSuccess('');
                              }}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              className="w-full p-1 border rounded"
                              value={rule.label}
                              onChange={(e) => {
                                const label = e.target.value;
                                setScoringRules((prev) => prev.map((r, i) => (i === idx ? { ...r, label } : r)));
                                setScoringRulesSuccess('');
                              }}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <button
                              className="px-2 py-1 border rounded text-red-700 border-red-300 disabled:opacity-50"
                              onClick={() => {
                                setScoringRules((prev) => prev.filter((_, i) => i !== idx));
                                setScoringAllowedDrafts({});
                                setScoringRulesSuccess('');
                              }}
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    className="px-3 py-1.5 rounded border border-emerald-300 text-sm text-emerald-700 hover:bg-emerald-50"
                    onClick={() => {
                      setScoringRules(clonePeAaoScoringRules());
                      setScoringAllowedDrafts({});
                      setScoringRulesError('');
                      setScoringRulesSuccess(`Applied PeAAO rule template: ${peAaoScoringRules.length} rules`);
                    }}
                  >
                    Apply PeAAO Rule Template (Overwrite)
                  </button>
                  <button
                    className="px-3 py-1.5 rounded border border-slate-300 text-sm hover:bg-slate-50"
                    onClick={() => {
                      setScoringRules((prev) => [
                        ...prev,
                        {
                          pos: 1,
                          allowed: ['A'],
                          score: 0,
                          label: `rule_${prev.length + 1}`,
                        },
                      ]);
                      setScoringAllowedDrafts({});
                      setScoringRulesSuccess('');
                    }}
                  >
                    Add Rule
                  </button>
                  <button
                    className="px-3 py-1.5 rounded border border-slate-300 text-sm hover:bg-slate-50"
                    onClick={() => rulesImportRef.current?.click()}
                  >
                    Import Rules JSON
                  </button>
                  <button
                    className="px-3 py-1.5 rounded border border-slate-300 text-sm hover:bg-slate-50"
                    onClick={() => {
                      const text = JSON.stringify(scoringRules, null, 2);
                      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = 'scoring_rules.json';
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Export Rules JSON
                  </button>
                  <input
                    ref={rulesImportRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) {
                        return;
                      }
                      try {
                        const text = await file.text();
                        const parsed = parseScoringRulesInput(JSON.parse(text));
                        setScoringRules(parsed);
                        setScoringAllowedDrafts({});
                        setScoringRulesError('');
                        setScoringRulesSuccess(`Import successful, ${parsed.length} rules`);
                      } catch (err) {
                        setScoringRulesError(`Import failed: ${String(err)}`);
                        setScoringRulesSuccess('');
                      } finally {
                        e.currentTarget.value = '';
                      }
                    }}
                  />
                  <div className="text-xs text-slate-500">Supports importing/exporting JSON; fields are pos / allowed / score / label; allowed may include "Uni"</div>
                </div>

                {scoringRulesError && (
                  <div className="text-xs text-red-600 border border-red-200 bg-red-50 rounded p-2">{scoringRulesError}</div>
                )}

                {scoringRulesSuccess && !scoringRulesError && (
                  <div className="text-xs text-emerald-700 border border-emerald-200 bg-emerald-50 rounded p-2">
                    {scoringRulesSuccess}
                  </div>
                )}

                <button
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm h-10"
                  disabled={job.loading || Boolean(scoringRulesError)}
                  title={
                    scoringRulesError
                      ? `Rule validation failed: ${scoringRulesError}`
                      : 'Run Scoring (Based on Step 4 Alignment)'
                  }
                  onClick={() => runAction('Run active-site scoring', runScoringStep, 'scoring')}
                >
                  Run Scoring (Based on Step 4 Alignment)
                </button>

                <div className="pt-1 border-t border-slate-100">
                  <label className="flex items-center gap-2 text-sm text-slate-700 pb-2">
                    <input
                      type="checkbox"
                      checked={autoDownloadScoringCsv}
                      onChange={(e) => setAutoDownloadScoringCsv(e.target.checked)}
                    />
                    Automatically download the full CSV after scoring succeeds
                  </label>
                  <InputNum label="Threshold (set after scoring)" value={threshold} step={0.1} onChange={setThreshold} />
                  <div className="text-xs text-slate-500 mt-1">Recommended to run scoring first, then adjust the threshold based on results and re-run the statistics.</div>
                  {thresholdPreview && (
                    <div className="mt-2 text-xs text-indigo-700 border border-indigo-200 bg-indigo-50 rounded p-2">
                      Threshold estimate (based on current scored_results.csv): at threshold {thresholdPreview.threshold}, {thresholdPreview.passed}/{thresholdPreview.total}（{(thresholdPreview.ratio * 100).toFixed(1)}%）.
                      To have clustering use this threshold result, please re-run scoring.
                    </div>
                  )}
                </div>

                {Boolean(scoringRulesError) && (
                  <div className="text-xs text-amber-700 border border-amber-200 bg-amber-50 rounded p-2">
                    There are errors in the current rules; scoring is disabled. Please fix the red error messages above first.
                  </div>
                )}
              </div>
              <SimpleTable rows={scoringRows} />
              {renderTailPanels('h-28')}
            </div>
          )}

          {/* ==== Step 6: Clustering ==== */}
          {currentView === 'clustering' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold">6. Clustering</h1>
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <InputNum label="CD-HIT Identity" value={clusterIdentity} step={0.01} onChange={setClusterIdentity} />
                  <InputNum label="Word Size" value={clusterWordSize} step={1} onChange={setClusterWordSize} />
                </div>
                <label className="block text-sm font-medium">Input FASTA</label>
                <input className="w-full p-2 border rounded text-sm font-mono" value={candidateFasta}
                  onChange={(e) => setCandidateFasta(e.target.value)} placeholder="scored_passed.fasta" />
                <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                  onClick={() => runAction('Run clustering', runClusteringStep, 'clustering')}>
                  Run CD-HIT Clustering
                </button>
              </div>
              {clusteringRunInfo && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-3 text-sm text-emerald-950">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <h2 className="text-base font-semibold text-emerald-900">Clustering Results</h2>
                    <span className="text-xs text-emerald-700">
                      Identity {Math.round(clusterIdentity * 100)}% · Word Size {clusterWordSize}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                      <div className="text-xs text-emerald-700">Input Sequences</div>
                      <div className="text-xl font-semibold">{clusteringRunInfo.inputCount}</div>
                    </div>
                    <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                      <div className="text-xs text-emerald-700">Kept After Dedup</div>
                      <div className="text-xl font-semibold">{clusteringRunInfo.outputCount}</div>
                    </div>
                    <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                      <div className="text-xs text-emerald-700">Removed by Dedup</div>
                      <div className="text-xl font-semibold">{clusteringRunInfo.deduplicatedCount}</div>
                    </div>
                    <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                      <div className="text-xs text-emerald-700">Cluster Count</div>
                      <div className="text-xl font-semibold">{clusteringRunInfo.clusters}</div>
                    </div>
                  </div>
                  <div className="text-xs text-emerald-800 space-y-1">
                    <div>Input: {clusteringRunInfo.inputFasta}</div>
                    <div>Output FASTA: {clusteringRunInfo.outputFasta}</div>
                    <div>Cluster file: {clusteringRunInfo.clusterFile}</div>
                  </div>
                </div>
              )}
              {renderTailPanels('h-28')}
            </div>
          )}

          {/* ==== Step 7: Similarity ==== */}
          {currentView === 'similarity' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold">7. Similarity</h1>
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium mb-1">Similarity Method</label>
                    <select className="w-full p-2 border rounded text-sm" value={networkSimilarityMethod}
                      onChange={(e) => setNetworkSimilarityMethod(e.target.value as 'needleman-wunsch' | 'smith-waterman' | 'mmseqs2')}>
                      <option value="needleman-wunsch">Needleman-Wunsch (Global)</option>
                      <option value="smith-waterman">Smith-Waterman (Local)</option>
                      <option value="mmseqs2">MMseqs2 (Fast Pairwise)</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-3 pt-6">
                    <input type="checkbox" checked={networkIncludeReferenceLinks}
                      onChange={(e) => setNetworkIncludeReferenceLinks(e.target.checked)} />
                    <label className="text-sm text-slate-700">Include Reference Sequence Links</label>
                  </div>
                </div>
                <label className="block text-sm font-medium">Source FASTA</label>
                <input className="w-full p-2 border rounded text-sm font-mono" value={networkSourceFasta}
                  onChange={(e) => setNetworkSourceFasta(e.target.value)} />
                <label className="block text-sm font-medium">Reference FASTA</label>
                <input className="w-full p-2 border rounded text-sm font-mono" value={networkReferenceFasta}
                  onChange={(e) => setNetworkReferenceFasta(e.target.value)} />
                <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                  onClick={() => runAction('Compute similarity', runComputeSimilarity, 'similarity')}>
                  Compute Sequence Similarity
                </button>
              </div>
              {networkStats.nodes > 0 && (
                <div className="bg-white border border-slate-200 rounded-xl p-4 text-sm">
                  Nodes: {networkStats.nodes} | Edges: {networkStats.edges}
                </div>
              )}
              {runtimeMeta?.networkAlignProgress && (
                runtimeTask === 'network/compute-similarity'
                || runtimeTask === 'network/data'
                || runtimeTask === 'clustering/run'
              ) && (
                <div className="w-full bg-slate-50 p-3 rounded-lg border border-slate-100 space-y-3">
                  <div className="flex justify-between text-xs text-slate-600 mb-2 font-medium">
                    <span>
                      🧪 Sequence Alignment In Progress
                      {runtimeMeta.networkAlignProgress.phase ? `（${runtimeMeta.networkAlignProgress.phase}）` : ''}
                      ：{runtimeMeta.networkAlignProgress.current} / {runtimeMeta.networkAlignProgress.total}
                    </span>
                    <span>
                      {Math.min(100, Math.round((runtimeMeta.networkAlignProgress.current / Math.max(1, runtimeMeta.networkAlignProgress.total)) * 100))}%
                    </span>
                  </div>
                  <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
                    <div
                      className="bg-indigo-500 h-2.5 rounded-full transition-all duration-300"
                      style={{
                        width: `${Math.min(100, Math.round((runtimeMeta.networkAlignProgress.current / Math.max(1, runtimeMeta.networkAlignProgress.total)) * 100))}%`,
                      }}
                    />
                  </div>

                  {runtimeMeta?.networkAlignStages?.['reference-links'] && (
                    <div>
                      <div className="flex justify-between text-xs text-slate-600 mb-1 font-medium">
                        <span>Reference sequences vs Candidate sequences</span>
                        <span>
                          {runtimeMeta.networkAlignStages['reference-links'].current} / {runtimeMeta.networkAlignStages['reference-links'].total}
                        </span>
                      </div>
                      <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                          style={{
                            width: `${Math.min(100, Math.round((runtimeMeta.networkAlignStages['reference-links'].current / Math.max(1, runtimeMeta.networkAlignStages['reference-links'].total)) * 100))}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {runtimeMeta?.networkAlignStages?.['candidate-pairwise'] && (
                    <div>
                      <div className="flex justify-between text-xs text-slate-600 mb-1 font-medium">
                        <span>Candidate sequences pairwise alignment</span>
                        <span>
                          {runtimeMeta.networkAlignStages['candidate-pairwise'].current} / {runtimeMeta.networkAlignStages['candidate-pairwise'].total}
                        </span>
                      </div>
                      <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-emerald-500 h-2 rounded-full transition-all duration-300"
                          style={{
                            width: `${Math.min(100, Math.round((runtimeMeta.networkAlignStages['candidate-pairwise'].current / Math.max(1, runtimeMeta.networkAlignStages['candidate-pairwise'].total)) * 100))}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
              {renderTailPanels('h-28')}
            </div>
          )}

          {/* ==== Step 8: Network Push ==== */}
          {currentView === 'network' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold">Similarity Network</h1>

              {/* ── Browser Graph (Primary) ── */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-base font-semibold text-slate-800">Network Visualization</span>
                  <div className="flex items-center gap-2 flex-wrap">
                    <select className="p-1.5 border rounded text-xs" value={browserGraphMode} onChange={(e) => setBrowserGraphMode(e.target.value as any)}>
                      <option value="cytoscape">Cytoscape.js (Organic CoSE)</option>
                      <option value="d3">D3 Force</option>
                    </select>
                    <select className="p-1.5 border rounded text-xs" value={browserGraphCategoryCol} onChange={(e) => setBrowserGraphCategoryCol(e.target.value)}>
                      <option value="class">Class</option>
                      <option value="phylum">Phylum</option>
                      <option value="kingdom">Kingdom</option>
                      <option value="order">Order</option>
                      <option value="family">Family</option>
                      <option value="genus">Genus</option>
                      <option value="species">Species</option>
                      <option value="cluster">Cluster</option>
                    </select>
                    <input
                      type="number"
                      min={40}
                      max={100}
                      step={1}
                      className="w-20 p-1.5 border rounded text-xs"
                      value={browserGraphThreshold}
                      onChange={(e) => setBrowserGraphThreshold(Math.max(40, Math.min(100, Number(e.target.value) || 40)))}
                      title="Browser Graph Load Threshold"
                    />
                    <button
                      className="bg-sky-600 hover:bg-sky-700 text-white px-3 py-1.5 rounded text-xs"
                      disabled={job.loading}
                      onClick={async () => {
                        const data = await fetchBrowserGraphData({ pairwiseThresholdPct: browserGraphThreshold });
                        setBrowserGraphNodes(data.nodes);
                        setBrowserGraphAllEdges(data.edges);
                        setBrowserGraphLoadedThreshold(data.appliedThresholdPct);
                        setBrowserGraphThreshold(data.appliedThresholdPct);
                        setBrowserGraphThresholdAdjusted(Boolean(data.thresholdAdjusted));
                        setBrowserGraphMaxEdges(data.maxEdges);
                        setBrowserGraphVisible(true);
                      }}
                    >
                      Load Network
                    </button>
                  </div>
                </div>
                <div className="text-xs text-slate-500">
                  The number above is the load threshold. After clicking “Load Network”, the in-graph slider can only be adjusted within the range of the currently loaded edge set.
                </div>
                {browserGraphThresholdAdjusted && (
                  <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    The browser graph automatically raised the load threshold to {browserGraphLoadedThreshold} to avoid the edge count exceeding {browserGraphMaxEdges}, which could freeze or blank the page.
                  </div>
                )}
                {browserGraphVisible && (
                  <NetworkGraph
                    nodes={browserGraphNodes}
                    edges={browserGraphAllEdges}
                    mode={browserGraphMode}
                    categoryColumn={browserGraphCategoryCol as any}
                    initialThreshold={browserGraphLoadedThreshold}
                    minThreshold={browserGraphLoadedThreshold}
                    highlightIds={recommendResults.map((r) => r.id)}
                    height={600}
                  />
                )}
              </div>

              {/* ── Cytoscape Desktop Push (Secondary) ── */}
              <details className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <summary className="px-4 py-3 cursor-pointer select-none text-sm font-medium text-slate-600 hover:bg-slate-50">
                  Push to Cytoscape Desktop (optional)
                </summary>
                <div className="px-4 pb-4 pt-2 space-y-3 border-t border-slate-100">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">Cytoscape URL</label>
                      <input className="w-full p-2 border rounded text-sm font-mono" value={cytoBaseUrl} onChange={(e) => setCytoBaseUrl(e.target.value)} />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Collection</label>
                      <input className="w-full p-2 border rounded text-sm" value={cytoCollection} onChange={(e) => setCytoCollection(e.target.value)} />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Network Title</label>
                      <input className="w-full p-2 border rounded text-sm" value={cytoNetworkTitle} onChange={(e) => setCytoNetworkTitle(e.target.value)} />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Layout</label>
                      <input className="w-full p-2 border rounded text-sm" value={cytoLayout} onChange={(e) => setCytoLayout(e.target.value)} />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Coloring Category Column</label>
                      <select className="w-full p-2 border rounded text-sm" value={cytoCategoryColumn} onChange={(e) => setCytoCategoryColumn(e.target.value)}>
                        <option value="phylum">Phylum</option>
                        <option value="class">Class</option>
                        <option value="kingdom">Kingdom</option>
                        <option value="species">Species</option>
                        <option value="cluster">Cluster</option>
                      </select>
                    </div>
                    <InputNum label="Pairwise Threshold (%)" value={networkPairwiseThresholdPct} step={1} onChange={setNetworkPairwiseThresholdPct} />
                  </div>
                  <div className="flex items-center gap-3">
                    <input type="checkbox" checked={cytoApplyStyle} onChange={(e) => setCytoApplyStyle(e.target.checked)} />
                    <label className="text-sm text-slate-700">Apply Style</label>
                  </div>
                  <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                    onClick={() => runAction('Push to Cytoscape', runNetworkPush, 'network-push')}>
                    Push to Cytoscape
                  </button>
                  {cytoPushInfo && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm space-y-1">
                      <div>Network SUID: {cytoPushInfo.networkSuid}</div>
                      <div>Pushed Nodes: {cytoPushInfo.pushedNodes} | Edges: {cytoPushInfo.pushedEdges}</div>
                      {cytoPushInfo.styleApplied && cytoPushInfo.categoryColumn && (
                        <div>Style applied: {cytoPushInfo.styleName} (grouping column {cytoPushInfo.categoryColumn})
                          {cytoPushInfo.categoryColumn !== cytoCategoryColumn && (
                            <span className="text-amber-700 font-medium"> ⚠ Selected column “{cytoCategoryColumn}” has no data, fell back to “{cytoPushInfo.categoryColumn}”</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </details>
              {runtimeMeta?.networkAlignProgress && (
                runtimeTask === 'network/data'
                || runtimeTask === 'network/push-cytoscape'
                || runtimeTask === 'clustering/run'
              ) && (
                <div className="w-full bg-slate-50 p-3 rounded-lg border border-slate-100 space-y-3">
                  <div className="flex justify-between text-xs text-slate-600 mb-2 font-medium">
                    <span>
                      🧪 Sequence Alignment In Progress
                      {runtimeMeta.networkAlignProgress.phase ? `（${runtimeMeta.networkAlignProgress.phase}）` : ''}
                      ：{runtimeMeta.networkAlignProgress.current} / {runtimeMeta.networkAlignProgress.total}
                    </span>
                    <span>
                      {Math.min(100, Math.round((runtimeMeta.networkAlignProgress.current / Math.max(1, runtimeMeta.networkAlignProgress.total)) * 100))}%
                    </span>
                  </div>
                  <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
                    <div
                      className="bg-indigo-500 h-2.5 rounded-full transition-all duration-300"
                      style={{
                        width: `${Math.min(100, Math.round((runtimeMeta.networkAlignProgress.current / Math.max(1, runtimeMeta.networkAlignProgress.total)) * 100))}%`,
                      }}
                    />
                  </div>

                  {runtimeMeta?.networkAlignStages?.['reference-links'] && (
                    <div>
                      <div className="flex justify-between text-xs text-slate-600 mb-1 font-medium">
                        <span>Reference edge alignment</span>
                        <span>
                          {runtimeMeta.networkAlignStages['reference-links'].current} / {runtimeMeta.networkAlignStages['reference-links'].total}
                        </span>
                      </div>
                      <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                          style={{
                            width: `${Math.min(100, Math.round((runtimeMeta.networkAlignStages['reference-links'].current / Math.max(1, runtimeMeta.networkAlignStages['reference-links'].total)) * 100))}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {runtimeMeta?.networkAlignStages?.['candidate-pairwise'] && (
                    <div>
                      <div className="flex justify-between text-xs text-slate-600 mb-1 font-medium">
                        <span>Candidate sequences pairwise alignment</span>
                        <span>
                          {runtimeMeta.networkAlignStages['candidate-pairwise'].current} / {runtimeMeta.networkAlignStages['candidate-pairwise'].total}
                        </span>
                      </div>
                      <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-emerald-500 h-2 rounded-full transition-all duration-300"
                          style={{
                            width: `${Math.min(100, Math.round((runtimeMeta.networkAlignStages['candidate-pairwise'].current / Math.max(1, runtimeMeta.networkAlignStages['candidate-pairwise'].total)) * 100))}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {renderTailPanels('h-28')}
            </div>
          )}

          {/* ==== Step 9: Recommendation ==== */}
          {currentView === 'recommendation' && (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold">Candidate Recommendation</h1>
              <PredictedMetricsPanel
                subWeights={predictedSubWeights}
                onSubWeightsChange={setPredictedSubWeights}
                tmTarget={predictedTmTarget}
                onTmTargetChange={setPredictedTmTarget}
              />
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <h2 className="text-base font-semibold text-slate-900">Strategy 2: Comprehensive Recommendation</h2>
                <p className="text-sm text-slate-600">
                  Ranks candidate sequences using a multi-dimensional score combining similarity, taxonomic diversity, cluster size, and the Strategy 1 predicted property score. Isolated points (clusters containing only 1 sequence) are excluded by default.
                </p>
                <details className="text-xs text-slate-400">
                  <summary className="cursor-pointer select-none">Parameter Description</summary>
                  <ul className="mt-1 ml-4 list-disc space-y-0.5">
                    <li><b>Minimum Cluster Size</b>: the number of sequences in a cluster must be ≥ this value, otherwise excluded. Set to 2 to filter out isolated points.</li>
                    <li><b>Avg Ref Similarity Weight</b>: scoring weight for the candidate's average similarity to all reference sequences.</li>
                    <li><b>Max Ref Similarity Weight</b>: scoring weight for the candidate's similarity to its most similar reference sequence.</li>
                    <li><b>Cluster Size Weight</b>: the larger the candidate's cluster, the higher the score; normalized and multiplied by this weight.</li>
                    <li><b>Taxonomy Diversity Weight</b>: scoring weight for the taxonomic diversity (number of classes) within the candidate's cluster.</li>
                    <li><b>Randomness (Temperature)</b>: 0 = deterministic selection (same parameters give the same result); when &gt;0, sampling within each cluster uses temperature — the larger the value, the more random the result.</li>
                  </ul>
                </details>
                <details className="text-xs text-slate-400 mt-1">
                  <summary className="cursor-pointer select-none">Scoring Algorithm Description</summary>
                  <div className="mt-1 ml-2 space-y-1">
                    <p><b>Scoring Formula</b>: Score = w₁·avgRefSim + w₂·maxRefSim + w₃·clusterSizeNorm + w₄·taxDiv</p>
                    <ul className="ml-4 list-disc space-y-0.5">
                      <li><b>avgRefSim</b>: average similarity of the candidate to all edge-connected reference sequences ÷ 100, range [0, 1]</li>
                      <li><b>maxRefSim</b>: similarity of the candidate to its most similar reference sequence ÷ 100, range [0, 1]</li>
                      <li><b>clusterSizeNorm</b>: size of the candidate's cluster ÷ the largest cluster size, range [0, 1]</li>
                      <li><b>taxDiv</b>: number of distinct classes in the candidate's cluster ÷ the maximum number of classes, range [0, 1]</li>
                    </ul>
                    <p><b>Cluster Source</b>: result of cd-hit clustering by sequence similarity threshold. Sequences within the same cluster are highly similar to each other.</p>
                    <p><b>Similarity Data Source</b>: edges in edges_similarity.csv between candidates and reference nodes (is_reference=1).</p>
                    <p><b>Diversity Selection</b>: supports two strategies — “Proportional” allocates slots by cluster size (larger clusters get more), “Round-robin” selects evenly and alternately across clusters.</p>
                    <p><b>Randomness</b>: fully deterministic when Temperature=0; when &gt;0, softmax temperature sampling is used during cluster round-robin: P(i) = exp(score_i/T) / Σexp(score_j/T) — the larger T, the more random.</p>
                  </div>
                </details>
                <div className="grid grid-cols-5 gap-3 text-sm">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Minimum Cluster Size</label>
                    <input type="number" min={1} max={100} step={1} className="w-full p-2 border rounded text-sm"
                      value={recommendMinClusterSize}
                      onChange={(e) => setRecommendMinClusterSize(Math.max(1, Number(e.target.value) || 2))} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Top N</label>
                    <input type="number" min={1} max={5000} step={10} className="w-full p-2 border rounded text-sm"
                      value={recommendTopN}
                      onChange={(e) => setRecommendTopN(Math.max(1, Math.min(5000, Number(e.target.value) || 50)))} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Selection Strategy</label>
                    <select className="w-full p-2 border rounded text-sm"
                      value={recommendDiversityMode}
                      onChange={(e) => setRecommendDiversityMode(e.target.value as 'proportional' | 'round-robin')}>
                      <option value="proportional">Proportional</option>
                      <option value="round-robin">Round-robin</option>
                    </select>
                  </div>
                  <div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Threshold: {recommendNetworkConnectivityThreshold}%</label>
                      <input type="range" min={0} max={100} step={1} className="w-full accent-indigo-500 cursor-pointer" draggable={false}
                        style={{ touchAction: 'none' }}
                        value={recommendNetworkConnectivityThreshold}
                        onChange={(e) => setRecommendNetworkConnectivityThreshold(Number(e.target.value))} />
                    </div>
                    <label className="block text-xs text-slate-500 mb-1">Randomness (Temperature): {recommendTemperature.toFixed(2)}</label>
                    <input type="range" min={0} max={1} step={0.05} className="w-full accent-indigo-500 cursor-pointer" draggable={false}
                      style={{ touchAction: 'none' }}
                      value={recommendTemperature}
                      onChange={(e) => setRecommendTemperature(Number(e.target.value))} />
                  </div>
                </div>
                <WeightBar weights={recommendWeights} onChange={setRecommendWeights} labels={WEIGHT_LABELS} defaults={DEFAULT_WEIGHTS} />
                <div className="flex items-center gap-3">
                  <button className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg text-sm"
                    disabled={job.loading}
                    onClick={() => runAction('Candidate recommendation scoring', runRecommendation, 'recommendation')}>
                    Compute Recommendations
                  </button>
                </div>
              </div>
              {recommendMeta && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm space-y-1">
                  <div>Candidates {recommendMeta.totalCandidates}, references {recommendMeta.totalReferences}, showing top {recommendResults.length}</div>
                  {(recommendMeta.filteredByClusterSize > 0 || recommendMeta.filteredBySimilarity > 0) && (
                    <div className="text-slate-500">
                      Filtered: {recommendMeta.filteredByClusterSize} below minimum cluster size
                      {recommendMeta.filteredBySimilarity > 0 && `, ${recommendMeta.filteredBySimilarity} below similarity threshold`}
                    </div>
                  )}
                  {!recommendMeta.predictedMetricsAvailable && (
                    <div className="text-amber-700">⚠ Strategy 1 predictions haven't been run yet for this task, so the Predicted Score weight contributed 0.</div>
                  )}
                </div>
              )}
              {recommendResults.length > 0 && (
                <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 sticky top-0">
                      <tr>
                        <th className="px-2 py-2 text-left">#</th>
                        <th className="px-2 py-2 text-left">ID</th>
                        <th className="px-2 py-2 text-right">Score</th>
                        <th className="px-2 py-2 text-right">Predicted Score</th>
                        <th className="px-2 py-2 text-right">Avg Ref Sim</th>
                        <th className="px-2 py-2 text-right">Max Ref Sim</th>
                        <th className="px-2 py-2 text-right">Ref Edges</th>
                        <th className="px-2 py-2 text-left">Cluster</th>
                        <th className="px-2 py-2 text-right">Cluster Size</th>
                        <th className="px-2 py-2 text-left">Net Comp</th>
                        <th className="px-2 py-2 text-right">Comp Size</th>
                        <th className="px-2 py-2 text-left">Net Comp</th>
                        <th className="px-2 py-2 text-right">Comp Size</th>
                        <th className="px-2 py-2 text-left">Phylum</th>
                        <th className="px-2 py-2 text-left">Species</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recommendResults.map((c, i) => (
                        <tr key={c.id} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                          <td className="px-2 py-1.5 text-slate-400">{i + 1}</td>
                          <td className="px-2 py-1.5 font-mono text-xs break-all max-w-[200px]">{c.id}</td>
                          <td className="px-2 py-1.5 text-right font-semibold">{c.score.toFixed(4)}</td>
                          <td className="px-2 py-1.5 text-right">{c.predictedScore.toFixed(4)}</td>
                          <td className="px-2 py-1.5 text-right">{(c.avgRefSimilarity * 100).toFixed(1)}%</td>
                          <td className="px-2 py-1.5 text-right">{(c.maxRefSimilarity * 100).toFixed(1)}%</td>
                          <td className="px-2 py-1.5 text-right">{c.refEdgeCount}</td>
                          <td className="px-2 py-1.5">{c.cluster}</td>
                          <td className="px-2 py-1.5 text-right">{c.cluster_size}</td>
                          <td className="px-2 py-1.5">{c.phylum}</td>
                          <td className="px-2 py-1.5">{c.species}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {recommendResults.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm"
                    onClick={async () => {
                      try {
                        const data = await exportRecommendedFasta(recommendResults.map(c => c.id));
                        const blob = new Blob([data.fasta], { type: 'text/plain' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url; a.download = `recommended_candidates_${recommendResults.length}.fasta`;
                        a.click(); URL.revokeObjectURL(url);
                      } catch (err: any) { alert('Export failed: ' + (err?.message || err)); }
                    }}>
                    Export FASTA ({recommendResults.length})
                  </button>
                  <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm"
                    onClick={highlightRecommendationsInNetwork}>
                    Highlight in Network
                  </button>
                </div>
              )}
              {renderTailPanels('h-28')}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ========== Compare Pipeline ==========

function ComparePipeline({ darkMode, setDarkMode, onBack }: { darkMode: boolean; setDarkMode: (v: boolean | ((p: boolean) => boolean)) => void; onBack: () => void }) {
  const hydratingStateRef = useRef(false);

  // ── Compare task management ──
  const [compareTaskList, setCompareTaskList] = useState<TaskBrief[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem('enzymeminer.compare.activeTaskId') || '';
  });
  const [newTaskId, setNewTaskId] = useState('');

  // ── Source task selection (A/B dropdowns) ──
  const [sourceTasks, setSourceTasks] = useState<Array<{ id: string; module: string | null; name: string }>>([]);
  const [taskAId, setTaskAId] = useState('');
  const [taskBId, setTaskBId] = useState('');
  const [taskAInfo, setTaskAInfo] = useState<CompareTaskInfo | null>(null);
  const [taskBInfo, setTaskBInfo] = useState<CompareTaskInfo | null>(null);
  const [keepReferences, setKeepReferences] = useState(true);
  const [loading, setLoading] = useState(false);
  const [hydrating, setHydrating] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState('');
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);

  // Similarity + Cytoscape state
  const [similarityStatus, setSimilarityStatus] = useState<{ nodes: number; edges: number } | null>(null);
  const [cytoBaseUrl, setCytoBaseUrl] = useState('http://localhost:1234/v1');
  const [cytoLayout, setCytoLayout] = useState('force-directed');
  const [cytoCategoryColumn, setCytoCategoryColumn] = useState('source_task');
  const [cytoApplyStyle, setCytoApplyStyle] = useState(true);
  const [networkPairwiseThresholdPct, setNetworkPairwiseThresholdPct] = useState(85);
  const [networkIncludeReferenceLinks, setNetworkIncludeReferenceLinks] = useState(true);
  const [networkSimilarityMethod, setNetworkSimilarityMethod] = useState<'needleman-wunsch' | 'smith-waterman' | 'mmseqs2'>('mmseqs2');
  const [cytoPushInfo, setCytoPushInfo] = useState<{ networkSuid: number | null; pushedNodes: number; pushedEdges: number; styleName?: string; categoryColumn?: string | null; styleApplied?: boolean } | null>(null);

  // Browser graph state (Compare)
  const [browserGraphNodes, setBrowserGraphNodes] = useState<BrowserGraphNode[]>([]);
  const [browserGraphEdges, setBrowserGraphEdges] = useState<BrowserGraphEdge[]>([]);
  const [browserGraphAllEdges, setBrowserGraphAllEdges] = useState<BrowserGraphEdge[]>([]);
  const [browserGraphThreshold, setBrowserGraphThreshold] = useState(80);
  const [browserGraphLoadedThreshold, setBrowserGraphLoadedThreshold] = useState(80);
  const [browserGraphThresholdAdjusted, setBrowserGraphThresholdAdjusted] = useState(false);
  const [browserGraphMaxEdges, setBrowserGraphMaxEdges] = useState(20000);
  const [browserGraphMode, setBrowserGraphMode] = useState<'d3' | 'cytoscape'>('cytoscape');
  const [browserGraphCategoryCol, setBrowserGraphCategoryCol] = useState<string>('source_task');
  const [browserGraphVisible, setBrowserGraphVisible] = useState(false);

  // Recommendation state
  const [recommendResults, setRecommendResults] = useState<RecommendCandidate[]>([]);
  const [recommendWeights, setRecommendWeights] = useState<RecommendWeights>({ ...DEFAULT_WEIGHTS });
  const [recommendNetworkConnectivityThreshold, setRecommendNetworkConnectivityThreshold] = useState<number>(85);
  const [recommendTopN, setRecommendTopN] = useState(50);
  const [recommendMinClusterSize, setRecommendMinClusterSize] = useState(2);
  const [recommendMinSimilarity, setRecommendMinSimilarity] = useState(0);
  const [recommendTemperature, setRecommendTemperature] = useState(0);
  const [recommendDiversityMode, setRecommendDiversityMode] = useState<'proportional' | 'round-robin'>('proportional');
  const [recommendMeta, setRecommendMeta] = useState<{ totalCandidates: number; totalReferences: number; filteredByClusterSize: number; filteredBySimilarity: number; predictedMetricsAvailable: boolean } | null>(null);
  const [predictedSubWeights, setPredictedSubWeights] = useState<PredictedSubWeights>({ ...DEFAULT_PREDICTED_SUB_WEIGHTS });
  const [predictedTmTarget, setPredictedTmTarget] = useState(60);

  // Runtime logs + progress
  const [runtimeMeta, setRuntimeMeta] = useState<{
    networkAlignProgress?: { current: number; total: number; phase?: string };
    networkAlignStages?: {
      'reference-links'?: { current: number; total: number };
      'candidate-pairwise'?: { current: number; total: number };
    };
  }>({});
  const [runtimeLogs, setRuntimeLogs] = useState<string[]>([]);
  const [runtimeTask, setRuntimeTask] = useState('idle');
  const [runtimeStartedAt, setRuntimeStartedAt] = useState<number | null>(null);
  const [runtimeUpdatedAt, setRuntimeUpdatedAt] = useState<number | null>(null);
  const [runtimeActive, setRuntimeActive] = useState(false);
  const [autoScrollLog, setAutoScrollLog] = useState(true);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  // ── Effect: Poll runtime logs when loading ──
  useEffect(() => {
    if (!loading) {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await loadRuntimeLogs(240);
        if (!cancelled) {
          setRuntimeActive(Boolean(data.active));
          setRuntimeStartedAt(Number.isFinite(Number(data.startedAt)) ? Number(data.startedAt) : null);
          setRuntimeUpdatedAt(Number.isFinite(Number(data.updatedAt)) ? Number(data.updatedAt) : null);
          setRuntimeTask(data.task);
          setRuntimeMeta(data.meta || {});
          setRuntimeLogs(data.lines);
        }
      } catch { /* ignore */ }
    };
    void poll();
    const timer = setInterval(poll, 300);
    return () => { cancelled = true; clearInterval(timer); };
  }, [loading]);

  // Auto-scroll log
  useEffect(() => {
    if (!autoScrollLog) return;
    const box = logContainerRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [runtimeLogs, autoScrollLog]);

  // ── Effect: Sync activeTaskId + localStorage ──
  useEffect(() => {
    if (selectedTaskId) {
      setActiveTaskId(selectedTaskId);
      if (typeof window !== 'undefined') window.localStorage.setItem('enzymeminer.compare.activeTaskId', selectedTaskId);
    }
  }, [selectedTaskId]);

  // ── Refresh compare task list ──
  const refreshCompareTasks = async () => {
    const data = await listTasks();
    const all = data.tasks || [];
    const compareTasks = all.filter((t) => t.module === 'compare');
    setCompareTaskList(compareTasks);
    if (!selectedTaskId) {
      setSelectedTaskId(compareTasks.length > 0 ? compareTasks[0].id : '');
      return;
    }
    if (!compareTasks.some((t) => t.id === selectedTaskId)) {
      setSelectedTaskId(compareTasks.length > 0 ? compareTasks[0].id : '');
    }
  };

  // ── Refresh source tasks (non-compare, for A/B dropdowns) ──
  const refreshSourceTasks = async () => {
    const data = await listTasks();
    if (data.tasks) {
      setSourceTasks(data.tasks.filter((t) => t.module !== 'compare').map((t) => ({ id: t.id, module: t.module, name: t.name || t.id })));
    }
  };

  // On mount: load both lists
  useEffect(() => {
    void refreshCompareTasks();
    void refreshSourceTasks();
  }, []);

  // ── Load task info when both source tasks selected ──
  useEffect(() => {
    if (!taskAId || !taskBId) {
      setTaskAInfo(null);
      setTaskBInfo(null);
      return;
    }
    setError('');
    loadCompareTaskInfo(taskAId, taskBId).then(data => {
      if (data.ok) {
        setTaskAInfo(data.taskA);
        setTaskBInfo(data.taskB);
      } else {
        setError(data.message || 'Failed to load task info');
      }
    }).catch(err => setError(String(err)));
  }, [taskAId, taskBId]);

  // ── Effect: Hydrate on task switch ──
  useEffect(() => {
    if (!selectedTaskId) return;

    // Reset state
    setTaskAId('');
    setTaskBId('');
    setTaskAInfo(null);
    setTaskBInfo(null);
    setCompareResult(null);
    setSimilarityStatus(null);
    setCytoPushInfo(null);
    setError('');
    setHydrating(true);
    setStatusMessage(`Loading task progress: ${selectedTaskId}`);

    let cancelled = false;
    hydratingStateRef.current = true;

    const hydrateTaskState = async () => {
      let staleRecommendCache = false;
      setActiveTaskId(selectedTaskId);
      try {
        const data = await loadPipelineState('compare');
        const state = data.exists && data.state && typeof data.state === 'object' ? data.state : {};
        if (cancelled) return;

        // Restore source task selections
        if (typeof state.taskAId === 'string') setTaskAId(state.taskAId);
        if (typeof state.taskBId === 'string') setTaskBId(state.taskBId);
        if (typeof state.keepReferences === 'boolean') setKeepReferences(state.keepReferences);
        if (state.compareResult && typeof state.compareResult === 'object') setCompareResult(state.compareResult as CompareResult);

        // Restore similarity/cytoscape params
        if (typeof state.networkPairwiseThresholdPct === 'number') setNetworkPairwiseThresholdPct(state.networkPairwiseThresholdPct);
        if (typeof state.networkIncludeReferenceLinks === 'boolean') setNetworkIncludeReferenceLinks(state.networkIncludeReferenceLinks);
        if (typeof state.networkSimilarityMethod === 'string') setNetworkSimilarityMethod(state.networkSimilarityMethod as 'needleman-wunsch' | 'smith-waterman' | 'mmseqs2');
        if (typeof state.cytoBaseUrl === 'string') setCytoBaseUrl(state.cytoBaseUrl);
        if (typeof state.cytoLayout === 'string') setCytoLayout(state.cytoLayout);
        if (typeof state.cytoCategoryColumn === 'string') setCytoCategoryColumn(state.cytoCategoryColumn);
        if (typeof state.cytoApplyStyle === 'boolean') setCytoApplyStyle(state.cytoApplyStyle);
        if (state.recommendWeights) setRecommendWeights(normalizeRecommendWeights(state.recommendWeights));
        if (typeof state.recommendTopN === 'number') setRecommendTopN(state.recommendTopN);
        if (typeof state.recommendMinClusterSize === 'number') setRecommendMinClusterSize(state.recommendMinClusterSize);
        if (typeof state.recommendMinSimilarity === 'number') setRecommendMinSimilarity(state.recommendMinSimilarity);
        if (typeof state.recommendTemperature === 'number') setRecommendTemperature(state.recommendTemperature);
        const normalizedRecommend = normalizeSavedRecommendResults(state.recommendResults, state.recommendTopN);
        setRecommendResults(normalizedRecommend.results || []);
        staleRecommendCache = normalizedRecommend.stale;
        if (!normalizedRecommend.stale && state.recommendMeta) setRecommendMeta(state.recommendMeta as any);
        else setRecommendMeta(null);

        // Check if similarity artifacts exist
        try {
          const artRes = await loadTaskArtifacts();
          const artifacts = artRes.artifacts || {};
          if (!cancelled && artifacts['nodes.csv']?.exists && artifacts['edges_similarity.csv']?.exists) {
            setSimilarityStatus({
              nodes: artifacts['nodes.csv'].rowCount ?? 0,
              edges: artifacts['edges_similarity.csv'].rowCount ?? 0,
            });
          }
        } catch { /* ignore */ }

        if (!cancelled) {
          setStatusMessage(
            staleRecommendCache
              ? `Task progress loaded: ${selectedTaskId}; Detected outdated recommendation cache, please recompute recommendations`
              : (data.exists ? `Task progress loaded: ${selectedTaskId}` : `New task: ${selectedTaskId}`),
          );
        }
      } catch (err) {
        if (!cancelled) setError(`Failed to load task progress: ${String(err)}`);
      } finally {
        if (!cancelled) {
          hydratingStateRef.current = false;
          setHydrating(false);
        }
      }
    };

    void hydrateTaskState();
    return () => { cancelled = true; hydratingStateRef.current = false; };
  }, [selectedTaskId]);

  // ── Effect: Debounced save ──
  useEffect(() => {
    if (hydratingStateRef.current || !selectedTaskId) return;
    const timer = setTimeout(() => {
      const state = {
        taskAId,
        taskBId,
        keepReferences,
        compareResult,
        networkPairwiseThresholdPct,
        networkIncludeReferenceLinks,
        networkSimilarityMethod,
        cytoBaseUrl,
        cytoLayout,
        cytoCategoryColumn,
        cytoApplyStyle,
        recommendWeights,
        recommendTopN,
        recommendMinClusterSize,
        recommendMinSimilarity,
        recommendTemperature,
        recommendResults,
        recommendMeta,
      };
      void savePipelineState(state, 'compare').catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [selectedTaskId, taskAId, taskBId, keepReferences, compareResult, networkPairwiseThresholdPct, networkIncludeReferenceLinks, networkSimilarityMethod, cytoBaseUrl, cytoLayout, cytoCategoryColumn, cytoApplyStyle, recommendWeights, recommendTopN, recommendMinClusterSize, recommendMinSimilarity, recommendTemperature, recommendResults, recommendMeta]);

  // ── Task actions ──
  const createTaskAndSwitch = async () => {
    const typed = newTaskId.trim();
    const data = await createTask(typed || undefined, typed || undefined, 'compare');
    const created = data.task?.id;
    await refreshCompareTasks();
    if (created) setSelectedTaskId(created);
    setNewTaskId('');
  };

  const duplicateSelectedTask = async () => {
    if (!selectedTaskId) return;
    const typed = newTaskId.trim();
    const data = await duplicateTask(selectedTaskId, typed || undefined, typed || undefined);
    const created = data.task?.id;
    await refreshCompareTasks();
    if (created) {
      setSelectedTaskId(created);
    }
    setNewTaskId('');
  };


  const deleteSelectedTask = async () => {
    if (!selectedTaskId) return;
    await deleteTask(selectedTaskId);
    await refreshCompareTasks();
  };

  const moduleLabel = (mod: string | null) => {
    if (mod === 'blast') return 'BLAST';
    if (mod === 'hmmer') return 'HMMER';
    if (mod === 'compare') return 'Compare';
    return 'HMMER';
  };

  // ── Compare operations ──
  const doRecommend = async () => {
    if (!selectedTaskId) return;
    setLoading(true);
    setError('');
    try {
      setActiveTaskId(selectedTaskId);
      const data = await recommendCandidates({ weights: normalizeRecommendWeights(recommendWeights), topN: recommendTopN, minClusterSize: recommendMinClusterSize, minSimilarity: recommendMinSimilarity, temperature: recommendTemperature, diversityMode: recommendDiversityMode, networkConnectivityThreshold: recommendNetworkConnectivityThreshold, predictedSubWeights: normalizePredictedSubWeights(predictedSubWeights), predictedTmTarget });
      setRecommendResults(data.candidates);
      setRecommendMeta({ totalCandidates: data.totalCandidates, totalReferences: data.totalReferences, filteredByClusterSize: data.filteredByClusterSize, filteredBySimilarity: data.filteredBySimilarity, predictedMetricsAvailable: data.predictedMetricsAvailable });
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  const highlightRecommendationsInNetwork = async () => {
    if (!selectedTaskId || !recommendResults.length) return;
    setLoading(true);
    setError('');
    try {
      setActiveTaskId(selectedTaskId);
      if (!browserGraphVisible || !browserGraphNodes.length || !browserGraphAllEdges.length) {
        const data = await fetchBrowserGraphData({ pairwiseThresholdPct: browserGraphThreshold });
        setBrowserGraphNodes(data.nodes);
        setBrowserGraphAllEdges(data.edges);
        setBrowserGraphLoadedThreshold(data.appliedThresholdPct);
        setBrowserGraphThreshold(data.appliedThresholdPct);
        setBrowserGraphThresholdAdjusted(Boolean(data.thresholdAdjusted));
        setBrowserGraphMaxEdges(data.maxEdges);
        setBrowserGraphVisible(true);
      }
      setStatusMessage(`Highlighted ${recommendResults.length} recommended sequences in the network; return to Similarity Network to view`);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  const doIntersect = async () => {
    if (!taskAId || !taskBId || !selectedTaskId) return;
    setLoading(true);
    setError('');
    setCompareResult(null);
    setSimilarityStatus(null);
    setCytoPushInfo(null);
    try {
      const data = await compareIntersect({ taskA: taskAId, taskB: taskBId, keepReferences, targetTaskId: selectedTaskId });
      if (!data.ok) throw new Error(data.message || 'Intersection failed');
      setCompareResult(data);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  const doMerge = async () => {
    if (!taskAId || !taskBId || !selectedTaskId) return;
    setLoading(true);
    setError('');
    setCompareResult(null);
    setSimilarityStatus(null);
    setCytoPushInfo(null);
    try {
      const data = await compareMerge({ taskA: taskAId, taskB: taskBId, keepReferences, targetTaskId: selectedTaskId });
      if (!data.ok) throw new Error(data.message || 'Merge failed');
      setCompareResult(data);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  const doComputeSimilarity = async () => {
    if (!selectedTaskId) return;
    setLoading(true);
    setError('');
    try {
      setActiveTaskId(selectedTaskId);
      const data = await computeNetworkSimilarity({
        includeReferenceLinks: networkIncludeReferenceLinks,
        similarityMethod: networkSimilarityMethod,
      });
      if (!data.ok) throw new Error(data.message || 'Similarity computation failed');
      setSimilarityStatus({ nodes: data.nodes, edges: data.edges });
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  const doPushCytoscape = async () => {
    if (!selectedTaskId) return;
    setLoading(true);
    setError('');
    try {
      setActiveTaskId(selectedTaskId);
      const data = await pushNetworkToCytoscape({
        baseUrl: cytoBaseUrl,
        layout: cytoLayout,
        title: `Compare: ${taskAId} vs ${taskBId}${compareResult ? ` (${compareResult.operation})` : ''}`,
        collection: 'Compare',
        styleName: `${cytoCategoryColumn}_style`,
        categoryColumn: cytoCategoryColumn,
        applyStyle: cytoApplyStyle,
        pairwiseThresholdPct: networkPairwiseThresholdPct,
        includeReferenceLinks: networkIncludeReferenceLinks,
        similarityMethod: networkSimilarityMethod,
      });
      if (!data.ok) throw new Error(data.message || 'Push failed');
      setCytoPushInfo({
        networkSuid: data.networkSuid,
        pushedNodes: data.pushedNodes,
        pushedEdges: data.pushedEdges,
        styleName: data.styleName,
        categoryColumn: data.categoryColumn,
        styleApplied: data.styleApplied,
      });
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`min-h-screen ${darkMode ? 'dark bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-900'} font-sans`}>
      {/* Header */}
      <header className={`${darkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'} border-b shadow-sm`}>
        <div className="max-w-6xl mx-auto px-8 min-h-16 py-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={onBack} className="text-sm text-slate-500 hover:text-slate-700 mr-2">← Back</button>
            <GitCompareArrows className="w-6 h-6 text-amber-600" />
            <span className="text-xl font-bold tracking-tight">Network Comparison</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500">Task</span>
              <select
                className="p-1.5 border border-slate-300 rounded text-xs bg-white"
                value={selectedTaskId}
                onChange={(e) => setSelectedTaskId(e.target.value)}
                disabled={loading}
              >
                {compareTaskList.length === 0 && !selectedTaskId && (
                  <option value="">-- Please create a task --</option>
                )}
                {compareTaskList.map((t) => (
                  <option key={t.id} value={t.id}>{t.id}</option>
                ))}
              </select>
              <input
                className="p-1.5 border border-slate-300 rounded text-xs w-32"
                value={newTaskId}
                onChange={(e) => setNewTaskId(e.target.value)}
                placeholder="New task ID (optional)"
                disabled={loading}
              />
              <button
                className="px-2 py-1.5 rounded bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
                onClick={createTaskAndSwitch}
                disabled={loading}
              >
                New
              </button>
              <button
                className="px-2 py-1.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50"
                onClick={duplicateSelectedTask}
                disabled={loading || !selectedTaskId}
              >
                Copy
              </button>
              <button
                className="px-2 py-1.5 rounded bg-red-600 text-white text-xs hover:bg-red-700 disabled:opacity-50"
                onClick={deleteSelectedTask}
                disabled={loading || !selectedTaskId}
              >
                Delete
              </button>
            </div>
            <button
              className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
              onClick={() => setDarkMode((v: boolean) => !v)}
            >
              {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-8 py-8 space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">{error}</div>
        )}
        {hydrating && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-sm text-blue-600 flex items-center gap-2">
            <span className="inline-block w-3 h-3 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
            {statusMessage}
          </div>
        )}
        {!hydrating && statusMessage && !error && (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm text-slate-500">{statusMessage}</div>
        )}

        {!selectedTaskId && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center text-sm text-amber-700">
            Please create a comparison task in the top right first, then select the two source tasks to compare.
          </div>
        )}

        {/* Step 1: Select Source Tasks */}
        {selectedTaskId && (
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 shadow-sm">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="w-7 h-7 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-sm font-bold">1</span>
              Select the Two Tasks to Compare
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Task A</label>
                <select className="w-full p-2 border rounded text-sm" value={taskAId} onChange={e => setTaskAId(e.target.value)}>
                  <option value="">-- Select a task --</option>
                  {sourceTasks.map(t => (
                    <option key={t.id} value={t.id}>[{moduleLabel(t.module)}] {t.name || t.id}</option>
                  ))}
                </select>
                {taskAInfo && (
                  <div className="mt-2 text-xs text-slate-600 bg-slate-50 rounded p-2 space-y-1">
                    <div>Type: <b>{moduleLabel(taskAInfo.module)}</b></div>
                    <div>Reference sequences: <b>{taskAInfo.referenceCount}</b></div>
                    <div>Candidate sequences: <b>{taskAInfo.candidateCount}</b></div>
                    <div>Nodes.csv: {taskAInfo.hasNodesCsv ? <span className="text-green-600">{taskAInfo.nodesCount} nodes</span> : <span className="text-slate-400">None</span>}</div>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Task B</label>
                <select className="w-full p-2 border rounded text-sm" value={taskBId} onChange={e => setTaskBId(e.target.value)}>
                  <option value="">-- Select a task --</option>
                  {sourceTasks.map(t => (
                    <option key={t.id} value={t.id}>[{moduleLabel(t.module)}] {t.name || t.id}</option>
                  ))}
                </select>
                {taskBInfo && (
                  <div className="mt-2 text-xs text-slate-600 bg-slate-50 rounded p-2 space-y-1">
                    <div>Type: <b>{moduleLabel(taskBInfo.module)}</b></div>
                    <div>Reference sequences: <b>{taskBInfo.referenceCount}</b></div>
                    <div>Candidate sequences: <b>{taskBInfo.candidateCount}</b></div>
                    <div>Nodes.csv: {taskBInfo.hasNodesCsv ? <span className="text-green-600">{taskBInfo.nodesCount} nodes</span> : <span className="text-slate-400">None</span>}</div>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Step 2: Operations */}
        {selectedTaskId && taskAId && taskBId && taskAInfo && taskBInfo && (
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 shadow-sm">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="w-7 h-7 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-sm font-bold">2</span>
              Intersect / Merge
            </h2>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={keepReferences} onChange={e => setKeepReferences(e.target.checked)} />
              Keep Reference Sequences
            </label>
            <div className="flex flex-wrap gap-3">
              <button
                className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                disabled={loading}
                onClick={doIntersect}
              >
                {loading ? 'Processing...' : 'Intersect'}
              </button>
              <button
                className="bg-teal-600 hover:bg-teal-700 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                disabled={loading}
                onClick={doMerge}
              >
                {loading ? 'Processing...' : 'Merge Networks'}
              </button>
            </div>

            {compareResult && (
              <div className={`${compareResult.operation === 'intersect' ? 'bg-blue-50 border-blue-200' : 'bg-teal-50 border-teal-200'} border rounded-xl p-4 text-sm space-y-1`}>
                <div className="font-semibold">{compareResult.operation === 'intersect' ? 'Intersect' : 'Merge'} Complete</div>
                <div>Target task: <b>{compareResult.targetTaskId}</b></div>
                <div>Total sequences: <b>{compareResult.totalSequences}</b> (candidates {compareResult.candidateCount} + references {compareResult.referenceCount})</div>
                <div>Matched pairs: <b>{compareResult.matchedPairs}</b></div>
                {compareResult.operation === 'merge' && (
                  <>
                    <div>Only in A: <b>{compareResult.uniqueToA ?? 0}</b> | Only in B: <b>{compareResult.uniqueToB ?? 0}</b> | In both: <b>{compareResult.inBoth ?? 0}</b></div>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {/* Step 3: Compute Similarity */}
        {selectedTaskId && (compareResult || similarityStatus) && (
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 shadow-sm">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="w-7 h-7 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-sm font-bold">3</span>
              Compute Sequence Similarity
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Alignment Method</label>
                <select className="w-full p-2 border rounded text-sm" value={networkSimilarityMethod}
                  onChange={e => setNetworkSimilarityMethod(e.target.value as 'needleman-wunsch' | 'smith-waterman' | 'mmseqs2')}>
                  <option value="needleman-wunsch">Needleman-Wunsch</option>
                  <option value="smith-waterman">Smith-Waterman</option>
                  <option value="mmseqs2">MMseqs2 (Fast Pairwise)</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-600 col-span-2">
                <input type="checkbox" checked={networkIncludeReferenceLinks}
                  onChange={e => setNetworkIncludeReferenceLinks(e.target.checked)} />
                Include Edges Between Reference Sequences
              </label>
            </div>
            <button
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
              disabled={loading}
              onClick={doComputeSimilarity}
            >
              {loading ? 'Computing...' : 'Compute Sequence Similarity'}
            </button>
            {loading && runtimeMeta?.networkAlignProgress && (
              <div className="w-full bg-slate-50 p-3 rounded-lg border border-slate-100 space-y-3">
                <div className="flex justify-between text-xs text-slate-600 mb-2 font-medium">
                  <span>
                    🧪 Sequence Alignment In Progress
                    {runtimeMeta.networkAlignProgress.phase ? `（${runtimeMeta.networkAlignProgress.phase}）` : ''}
                    ：{runtimeMeta.networkAlignProgress.current} / {runtimeMeta.networkAlignProgress.total}
                  </span>
                  <span>
                    {Math.min(100, Math.round((runtimeMeta.networkAlignProgress.current / Math.max(1, runtimeMeta.networkAlignProgress.total)) * 100))}%
                  </span>
                </div>
                <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
                  <div
                    className="bg-indigo-500 h-2.5 rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.min(100, Math.round((runtimeMeta.networkAlignProgress.current / Math.max(1, runtimeMeta.networkAlignProgress.total)) * 100))}%`,
                    }}
                  />
                </div>
                {runtimeMeta?.networkAlignStages?.['reference-links'] && (
                  <div>
                    <div className="flex justify-between text-xs text-slate-600 mb-1 font-medium">
                      <span>Reference sequences vs Candidate sequences</span>
                      <span>{runtimeMeta.networkAlignStages['reference-links'].current} / {runtimeMeta.networkAlignStages['reference-links'].total}</span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                      <div className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${Math.min(100, Math.round((runtimeMeta.networkAlignStages['reference-links'].current / Math.max(1, runtimeMeta.networkAlignStages['reference-links'].total)) * 100))}%` }} />
                    </div>
                  </div>
                )}
                {runtimeMeta?.networkAlignStages?.['candidate-pairwise'] && (
                  <div>
                    <div className="flex justify-between text-xs text-slate-600 mb-1 font-medium">
                      <span>Candidate sequences pairwise alignment</span>
                      <span>{runtimeMeta.networkAlignStages['candidate-pairwise'].current} / {runtimeMeta.networkAlignStages['candidate-pairwise'].total}</span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                      <div className="bg-emerald-500 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${Math.min(100, Math.round((runtimeMeta.networkAlignStages['candidate-pairwise'].current / Math.max(1, runtimeMeta.networkAlignStages['candidate-pairwise'].total)) * 100))}%` }} />
                    </div>
                  </div>
                )}
              </div>
            )}
            {similarityStatus && (
              <div className="bg-indigo-50 border border-indigo-200 rounded p-3 text-sm">
                Similarity computed: Nodes <b>{similarityStatus.nodes}</b>, Edges <b>{similarityStatus.edges}</b>
              </div>
            )}
          </section>
        )}

        {/* Step 4: Network Visualization + Optional Cytoscape Push */}
        {selectedTaskId && similarityStatus && (
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 shadow-sm">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="w-7 h-7 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-sm font-bold">4</span>
              Similarity Network
            </h2>

            {/* ── Browser Graph (Primary) ── */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-base font-semibold text-slate-800">Network Visualization</span>
              <div className="flex items-center gap-2 flex-wrap">
                <select className="p-1.5 border rounded text-xs" value={browserGraphMode} onChange={(e) => setBrowserGraphMode(e.target.value as any)}>
                  <option value="cytoscape">Cytoscape.js (Organic CoSE)</option>
                  <option value="d3">D3 Force</option>
                </select>
                <select className="p-1.5 border rounded text-xs" value={browserGraphCategoryCol} onChange={(e) => setBrowserGraphCategoryCol(e.target.value)}>
                  <option value="source_task">Source Task</option>
                  <option value="class">Class</option>
                  <option value="phylum">Phylum</option>
                  <option value="kingdom">Kingdom</option>
                  <option value="cluster">Cluster</option>
                  <option value="species">Species</option>
                </select>
                <input
                  type="number"
                  min={40}
                  max={100}
                  step={1}
                  className="w-20 p-1.5 border rounded text-xs"
                  value={browserGraphThreshold}
                  onChange={(e) => setBrowserGraphThreshold(Math.max(40, Math.min(100, Number(e.target.value) || 40)))}
                  title="Browser Graph Load Threshold"
                />
                <button
                  className="bg-sky-600 hover:bg-sky-700 text-white px-3 py-1.5 rounded text-xs disabled:opacity-50"
                  disabled={loading}
                  onClick={async () => {
                    setLoading(true);
                    try {
                      setActiveTaskId(selectedTaskId);
                      const data = await fetchBrowserGraphData({ pairwiseThresholdPct: browserGraphThreshold });
                      setBrowserGraphNodes(data.nodes);
                      setBrowserGraphAllEdges(data.edges);
                      setBrowserGraphLoadedThreshold(data.appliedThresholdPct);
                      setBrowserGraphThreshold(data.appliedThresholdPct);
                      setBrowserGraphThresholdAdjusted(Boolean(data.thresholdAdjusted));
                      setBrowserGraphMaxEdges(data.maxEdges);
                      setBrowserGraphVisible(true);
                    } catch (err: any) {
                      setError(String(err?.message || err));
                    } finally {
                      setLoading(false);
                    }
                  }}
                >
                  Load Network
                </button>
              </div>
            </div>
            <div className="text-xs text-slate-500">
              The number above is the load threshold. After clicking “Load Network”, the in-graph slider can only be adjusted within the range of the currently loaded edge set.
            </div>
            {browserGraphThresholdAdjusted && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                The browser graph automatically raised the load threshold to {browserGraphLoadedThreshold} to avoid the edge count exceeding {browserGraphMaxEdges}, which could freeze or blank the page.
              </div>
            )}
            {browserGraphVisible && (
              <NetworkGraph
                nodes={browserGraphNodes}
                edges={browserGraphAllEdges}
                mode={browserGraphMode}
                categoryColumn={browserGraphCategoryCol as any}
                initialThreshold={browserGraphLoadedThreshold}
                minThreshold={browserGraphLoadedThreshold}
                highlightIds={recommendResults.map((r) => r.id)}
                height={600}
              />
            )}

            {/* ── Cytoscape Desktop Push (Secondary) ── */}
            <details className="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden">
              <summary className="px-4 py-3 cursor-pointer select-none text-sm font-medium text-slate-600 hover:bg-slate-100">
                Push to Cytoscape Desktop (optional)
              </summary>
              <div className="px-4 pb-4 pt-2 space-y-3 border-t border-slate-100">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Edge Threshold (%)</label>
                    <input type="number" min={0} max={100} step={1} className="w-full p-2 border rounded text-sm" value={networkPairwiseThresholdPct} onChange={e => setNetworkPairwiseThresholdPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">CyREST URL</label>
                    <input className="w-full p-2 border rounded text-sm" value={cytoBaseUrl} onChange={e => setCytoBaseUrl(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Layout</label>
                    <input className="w-full p-2 border rounded text-sm" value={cytoLayout} onChange={e => setCytoLayout(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Coloring Category Column</label>
                    <select className="w-full p-2 border rounded text-sm" value={cytoCategoryColumn} onChange={e => setCytoCategoryColumn(e.target.value)}>
                      <option value="source_task">Source Task</option>
                      <option value="phylum">Phylum</option>
                      <option value="class">Class</option>
                      <option value="kingdom">Kingdom</option>
                      <option value="species">Species</option>
                      <option value="cluster">Cluster</option>
                    </select>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <input type="checkbox" checked={cytoApplyStyle} onChange={e => setCytoApplyStyle(e.target.checked)} />
                  Auto-apply Style
                </label>
                <button
                  className="bg-emerald-700 hover:bg-emerald-800 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                  disabled={loading}
                  onClick={doPushCytoscape}
                >
                  {loading ? 'Pushing...' : 'Push to Cytoscape'}
                </button>
                {cytoPushInfo && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-900">
                    Pushed. networkSUID: <b>{String(cytoPushInfo.networkSuid ?? 'unknown')}</b>; 
                    Nodes {cytoPushInfo.pushedNodes}, Edges {cytoPushInfo.pushedEdges}.
                    {cytoPushInfo.styleApplied && cytoPushInfo.categoryColumn && (
                      <span> Style applied: {cytoPushInfo.styleName} (grouping column {cytoPushInfo.categoryColumn})</span>
                    )}
                  </div>
                )}
              </div>
            </details>
          </section>
        )}

        {/* Step 5: Candidate Recommendation */}
        {selectedTaskId && similarityStatus && (
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 shadow-sm">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="w-7 h-7 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-sm font-bold">5</span>
              Candidate Recommendation
            </h2>
            <PredictedMetricsPanel
              subWeights={predictedSubWeights}
              onSubWeightsChange={setPredictedSubWeights}
              tmTarget={predictedTmTarget}
              onTmTargetChange={setPredictedTmTarget}
            />
            <h3 className="text-base font-semibold text-slate-900">Strategy 2: Comprehensive Recommendation</h3>
            <p className="text-sm text-slate-600">
              Ranks candidate sequences using a multi-dimensional score combining similarity, taxonomic diversity, cluster size, and the Strategy 1 predicted property score. Isolated points (clusters containing only 1 sequence) are excluded by default.
            </p>
            <details className="text-xs text-slate-400">
              <summary className="cursor-pointer select-none">Parameter Description</summary>
              <ul className="mt-1 ml-4 list-disc space-y-0.5">
                <li><b>Minimum Cluster Size</b>: the number of sequences in a cluster must be ≥ this value, otherwise excluded. Set to 2 to filter out isolated points.</li>
                <li><b>Avg Ref Similarity Weight</b>: scoring weight for the candidate's average similarity to all reference sequences.</li>
                <li><b>Max Ref Similarity Weight</b>: scoring weight for the candidate's similarity to its most similar reference sequence.</li>
                <li><b>Cluster Size Weight</b>: the larger the candidate's cluster, the higher the score; normalized and multiplied by this weight.</li>
                <li><b>Taxonomy Diversity Weight</b>: scoring weight for the taxonomic diversity (number of classes) within the candidate's cluster.</li>
                <li><b>Randomness (Temperature)</b>: 0 = deterministic selection (same parameters give the same result); when &gt;0, sampling within each cluster uses temperature — the larger the value, the more random the result.</li>
              </ul>
            </details>
            <details className="text-xs text-slate-400 mt-1">
              <summary className="cursor-pointer select-none">Scoring Algorithm Description</summary>
              <div className="mt-1 ml-2 space-y-1">
                <p><b>Scoring Formula</b>: Score = w₁·avgRefSim + w₂·maxRefSim + w₃·clusterSizeNorm + w₄·taxDiv</p>
                <ul className="ml-4 list-disc space-y-0.5">
                  <li><b>avgRefSim</b>: average similarity of the candidate to all edge-connected reference sequences ÷ 100, range [0, 1]</li>
                  <li><b>maxRefSim</b>: similarity of the candidate to its most similar reference sequence ÷ 100, range [0, 1]</li>
                  <li><b>clusterSizeNorm</b>: size of the candidate's cluster ÷ the largest cluster size, range [0, 1]</li>
                  <li><b>taxDiv</b>: number of distinct classes in the candidate's cluster ÷ the maximum number of classes, range [0, 1]</li>
                </ul>
                <p><b>Cluster Source</b>: result of cd-hit clustering by sequence similarity threshold. Sequences within the same cluster are highly similar to each other.</p>
                <p><b>Similarity Data Source</b>: edges in edges_similarity.csv between candidates and reference nodes (is_reference=1).</p>
                <p><b>Diversity Selection</b>: supports two strategies — “Proportional” allocates slots by cluster size (larger clusters get more), “Round-robin” selects evenly and alternately across clusters.</p>
                <p><b>Randomness</b>: fully deterministic when Temperature=0; when &gt;0, softmax temperature sampling is used during cluster round-robin: P(i) = exp(score_i/T) / Σexp(score_j/T) — the larger T, the more random.</p>
              </div>
            </details>
            <div className="grid grid-cols-5 gap-3 text-sm">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Minimum Cluster Size</label>
                <input type="number" min={1} max={100} step={1} className="w-full p-2 border rounded text-sm"
                  value={recommendMinClusterSize}
                  onChange={(e) => setRecommendMinClusterSize(Math.max(1, Number(e.target.value) || 2))} />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Top N</label>
                <input type="number" min={1} max={5000} step={10} className="w-full p-2 border rounded text-sm"
                  value={recommendTopN}
                  onChange={(e) => setRecommendTopN(Math.max(1, Math.min(5000, Number(e.target.value) || 50)))} />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Selection Strategy</label>
                <select className="w-full p-2 border rounded text-sm"
                  value={recommendDiversityMode}
                  onChange={(e) => setRecommendDiversityMode(e.target.value as 'proportional' | 'round-robin')}>
                  <option value="proportional">Proportional</option>
                  <option value="round-robin">Round-robin</option>
                </select>
              </div>
              <div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Threshold: {recommendNetworkConnectivityThreshold}%</label>
                      <input type="range" min={0} max={100} step={1} className="w-full accent-indigo-500 cursor-pointer" draggable={false}
                        style={{ touchAction: 'none' }}
                        value={recommendNetworkConnectivityThreshold}
                        onChange={(e) => setRecommendNetworkConnectivityThreshold(Number(e.target.value))} />
                    </div>
                <label className="block text-xs text-slate-500 mb-1">Randomness (Temperature): {recommendTemperature.toFixed(2)}</label>
                <input type="range" min={0} max={1} step={0.05} className="w-full accent-indigo-500 cursor-pointer" draggable={false}
                  style={{ touchAction: 'none' }}
                  value={recommendTemperature}
                  onChange={(e) => setRecommendTemperature(Number(e.target.value))} />
              </div>
            </div>
            <WeightBar weights={recommendWeights} onChange={setRecommendWeights} labels={WEIGHT_LABELS} defaults={DEFAULT_WEIGHTS} />
            <button
              className="bg-amber-600 hover:bg-amber-700 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
              disabled={loading}
              onClick={doRecommend}
            >
              {loading ? 'Computing...' : 'Compute Recommendations'}
            </button>
            {recommendMeta && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm space-y-1">
                <div>Candidates {recommendMeta.totalCandidates}, references {recommendMeta.totalReferences}, showing top {recommendResults.length}</div>
                {(recommendMeta.filteredByClusterSize > 0 || recommendMeta.filteredBySimilarity > 0) && (
                  <div className="text-slate-500">
                    Filtered: {recommendMeta.filteredByClusterSize} below minimum cluster size
                    {recommendMeta.filteredBySimilarity > 0 && `, ${recommendMeta.filteredBySimilarity} below similarity threshold`}
                  </div>
                )}
                {!recommendMeta.predictedMetricsAvailable && (
                  <div className="text-amber-700">⚠ Strategy 1 predictions haven't been run yet for this task, so the Predicted Score weight contributed 0.</div>
                )}
              </div>
            )}
            {recommendResults.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="px-2 py-2 text-left">#</th>
                      <th className="px-2 py-2 text-left">ID</th>
                      <th className="px-2 py-2 text-right">Score</th>
                      <th className="px-2 py-2 text-right">Predicted Score</th>
                      <th className="px-2 py-2 text-right">Avg Ref Sim</th>
                      <th className="px-2 py-2 text-right">Max Ref Sim</th>
                      <th className="px-2 py-2 text-right">Ref Edges</th>
                      <th className="px-2 py-2 text-left">Cluster</th>
                      <th className="px-2 py-2 text-right">Cluster Size</th>
                      <th className="px-2 py-2 text-left">Phylum</th>
                      <th className="px-2 py-2 text-left">Species</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recommendResults.map((c, i) => (
                      <tr key={c.id} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                        <td className="px-2 py-1.5 text-slate-400">{i + 1}</td>
                        <td className="px-2 py-1.5 font-mono text-xs break-all max-w-[200px]">{c.id}</td>
                        <td className="px-2 py-1.5 text-right font-semibold">{c.score.toFixed(4)}</td>
                        <td className="px-2 py-1.5 text-right">{c.predictedScore.toFixed(4)}</td>
                        <td className="px-2 py-1.5 text-right">{(c.avgRefSimilarity * 100).toFixed(1)}%</td>
                        <td className="px-2 py-1.5 text-right">{(c.maxRefSimilarity * 100).toFixed(1)}%</td>
                        <td className="px-2 py-1.5 text-right">{c.refEdgeCount}</td>
                        <td className="px-2 py-1.5">{c.cluster}</td>
                        <td className="px-2 py-1.5 text-right">{c.cluster_size}</td>
                        <td className="px-2 py-1.5">{c.networkComponent}</td>
                        <td className="px-2 py-1.5 text-right">{c.networkComponentSize}</td>
                        <td className="px-2 py-1.5">{c.networkComponent}</td>
                        <td className="px-2 py-1.5 text-right">{c.networkComponentSize}</td>
                        <td className="px-2 py-1.5">{c.phylum}</td>
                        <td className="px-2 py-1.5">{c.species}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {recommendResults.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm"
                  onClick={async () => {
                    try {
                      const data = await exportRecommendedFasta(recommendResults.map(c => c.id));
                      const blob = new Blob([data.fasta], { type: 'text/plain' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url; a.download = `recommended_candidates_${recommendResults.length}.fasta`;
                      a.click(); URL.revokeObjectURL(url);
                    } catch (err: any) { alert('Export failed: ' + (err?.message || err)); }
                  }}>
                  Export FASTA ({recommendResults.length})
                </button>
                <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm"
                  onClick={highlightRecommendationsInNetwork}>
                  Highlight in Network
                </button>
              </div>
            )}
          </section>
        )}

        {/* Runtime Logs */}
        {runtimeLogs.length > 0 && (
          <section className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-slate-700">Run Log</h3>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span>Total time: {formatRuntimeDurationLabel(runtimeStartedAt, runtimeUpdatedAt, runtimeActive) || '-'}</span>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={autoScrollLog} onChange={e => setAutoScrollLog(e.target.checked)} />
                  Auto-scroll
                </label>
              </div>
            </div>
            <div
              ref={logContainerRef}
              className="bg-slate-900 text-green-400 text-xs font-mono p-3 rounded-lg overflow-auto max-h-48 whitespace-pre-wrap"
            >
              {runtimeLogs.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

// ========== Top-level App: Home page + module routing ==========

type AppModule = 'home' | 'hmmer' | 'blast' | 'compare';

export default function App() {
  const [activeModule, setActiveModule] = useState<AppModule>(() => {
    if (typeof window === 'undefined') return 'home';
    return (window.localStorage.getItem('enzymeminer.activeModule') as AppModule) || 'home';
  });

  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window === 'undefined') return false;
    const saved = window.localStorage.getItem('enzymeminer.darkMode');
    if (saved !== null) return saved === 'true';
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    window.localStorage.setItem('enzymeminer.darkMode', String(darkMode));
  }, [darkMode]);

  useEffect(() => {
    window.localStorage.setItem('enzymeminer.activeModule', activeModule);
  }, [activeModule]);

  if (activeModule === 'hmmer') {
    return <HmmerPipeline darkMode={darkMode} setDarkMode={setDarkMode} onBack={() => setActiveModule('home')} />;
  }

  if (activeModule === 'blast') {
    return <BlastPipeline darkMode={darkMode} setDarkMode={setDarkMode} onBack={() => setActiveModule('home')} />;
  }

  if (activeModule === 'compare') {
    return <ComparePipeline darkMode={darkMode} setDarkMode={setDarkMode} onBack={() => setActiveModule('home')} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FlaskConical className="w-7 h-7 text-indigo-600" />
            <span className="text-xl font-bold tracking-tight">EnzyMiner</span>
          </div>
          <button
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
            onClick={() => setDarkMode((v) => !v)}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-6xl mx-auto px-8 py-12">
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Workflow Modules</h1>
          <p className="text-slate-500">Select a module to start working</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* BLAST Pipeline Module */}
          <button
            onClick={() => setActiveModule('blast')}
            className="group text-left bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md hover:border-emerald-300 transition-all duration-200"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600 group-hover:bg-emerald-100 transition-colors">
                <Database className="w-5 h-5" />
              </div>
              <h2 className="text-lg font-semibold text-slate-900">BLAST Enzyme Mining Workflow</h2>
            </div>
            <p className="text-sm text-slate-500 mb-4 leading-relaxed">
              Based on BLAST pairwise search against protein databases; suitable when there are few reference sequences (1-5).
              Supports local databases and NCBI remote search.
            </p>
            <div className="flex items-center gap-1 text-sm font-medium text-emerald-600 group-hover:text-emerald-700">
              Enter Module <ArrowRight className="w-4 h-4" />
            </div>
          </button>

          {/* HMMER Pipeline Module */}
          <button
            onClick={() => setActiveModule('hmmer')}
            className="group text-left bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md hover:border-indigo-300 transition-all duration-200"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-600 group-hover:bg-indigo-100 transition-colors">
                <Search className="w-5 h-5" />
              </div>
              <h2 className="text-lg font-semibold text-slate-900">HMMER Novel Enzyme Mining Workflow</h2>
            </div>
            <p className="text-sm text-slate-500 mb-4 leading-relaxed">
              Uses HMM profile search against protein databases to screen candidate enzyme sequences, followed by scoring, clustering, and similarity network analysis.
              Supports NCBI Protein, UniProt, and nucleotide sequence input.
            </p>
            <div className="flex items-center gap-1 text-sm font-medium text-indigo-600 group-hover:text-indigo-700">
              Enter Module <ArrowRight className="w-4 h-4" />
            </div>
          </button>

          {/* Compare Module */}
          <button
            onClick={() => setActiveModule('compare')}
            className="group text-left bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md hover:border-amber-300 transition-all duration-200"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center text-amber-600 group-hover:bg-amber-100 transition-colors">
                <GitCompareArrows className="w-5 h-5" />
              </div>
              <h2 className="text-lg font-semibold text-slate-900">Network Comparison</h2>
            </div>
            <p className="text-sm text-slate-500 mb-4 leading-relaxed">
              Select any two tasks from HMMER or BLAST to intersect or merge their sequence sets.
              Supports cross-module comparison, generating a comparison network and pushing it to Cytoscape.
            </p>
            <div className="flex items-center gap-1 text-sm font-medium text-amber-600 group-hover:text-amber-700">
              Enter Module <ArrowRight className="w-4 h-4" />
            </div>
          </button>
        </div>
      </main>
    </div>
  );
}

function Section({ title }: { title: string }) {
  return <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 px-3 mt-4">{title}</div>;
}

function StatusBadge({ job }: { job: JobState }) {
  if (job.loading) {
    return (
      <span className="text-sm text-blue-600 flex items-center gap-2">
        <span className="inline-block w-3 h-3 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />
        Running...
      </span>
    );
  }
  if (job.error) {
    return (
      <span className="text-sm text-red-600 flex items-center gap-1">
        <AlertCircle className="w-4 h-4" />
        Failed
      </span>
    );
  }
  return <span className="text-sm text-emerald-600">Ready</span>;
}

function PipelineProgressPanel({
  stepState,
  activeStep,
  loading,
  lastCompletedStep,
  ebiSubStepState,
  showSearchSubProgress,
}: {
  stepState: Record<PipelineStepKey, StepStatus>;
  activeStep: PipelineStepKey | null;
  loading: boolean;
  lastCompletedStep?: PipelineStepKey | null;
  ebiSubStepState: EbiSubStepState;
  showSearchSubProgress: boolean;
}) {
  const doneCount = pipelineSteps.filter((s) => stepState[s.key] === 'success').length;
  const hasRunning = pipelineSteps.some((s) => stepState[s.key] === 'running');
  const total = pipelineSteps.length;
  const percent = Math.round(((doneCount + (hasRunning ? 0.35 : 0)) / total) * 100);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-slate-700">Pipeline Progress</div>
        <div className="text-xs text-slate-500">{doneCount}/{total} completed</div>
      </div>

      <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${loading ? 'progress-shimmer bg-indigo-500' : 'bg-indigo-500'}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-6 gap-2">
        {pipelineSteps.map((step) => {
          const status = stepState[step.key];
          const running = status === 'running';
          const active = activeStep === step.key;
          return (
            <div
              key={step.key}
              className={`rounded-lg border px-3 py-2 text-xs transition-all duration-300 ${
                status === 'success'
                  ? 'border-emerald-200 bg-emerald-50'
                  : status === 'error'
                    ? 'border-red-200 bg-red-50'
                    : running
                      ? 'border-indigo-300 bg-indigo-50 shadow-sm step-running-glow'
                      : 'border-slate-200 bg-slate-50'
                          } ${active ? 'ring-2 ring-indigo-200' : ''} ${status === 'success' && lastCompletedStep === step.key ? 'step-success-pop' : ''}`}
            >
              <div className="flex items-center gap-2">
                {status === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
                {status === 'error' && <AlertCircle className="w-3.5 h-3.5 text-red-600" />}
                {status === 'running' && <Activity className="w-3.5 h-3.5 text-indigo-600 animate-pulse" />}
                {status === 'idle' && <span className="w-2 h-2 rounded-full bg-slate-400 inline-block" />}
                <span className="font-medium text-slate-700">{step.title}</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {status === 'success' && 'Done'}
                {status === 'error' && 'Failed'}
                {status === 'running' && 'Running...'}
                {status === 'idle' && 'Not started'}
              </div>
            </div>
          );
        })}
      </div>

      {showSearchSubProgress && (
        <div className="border-t border-slate-100 pt-2">
          <div className="text-xs text-slate-500 mb-2">Search Sub-progress (EBI 3 Stages)</div>
          <div className="flex items-center gap-2 overflow-x-auto">
            {[
              { key: 'submit' as EbiSubStepKey, title: 'Submit' },
              { key: 'download' as EbiSubStepKey, title: 'Download' },
              { key: 'enrich' as EbiSubStepKey, title: 'Fill + Consistency' },
            ].map((item, idx, arr) => {
              const status = ebiSubStepState[item.key];
              return (
                <React.Fragment key={item.key}>
                  <div
                    className={`rounded-md border px-2 py-1 text-[11px] whitespace-nowrap ${
                      status === 'success'
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                        : status === 'running'
                          ? 'border-indigo-300 bg-indigo-50 text-indigo-800'
                          : status === 'error'
                            ? 'border-rose-300 bg-rose-50 text-rose-800'
                            : 'border-slate-200 bg-slate-50 text-slate-500'
                    }`}
                  >
                    {item.title} · {status === 'success' ? 'Done' : status === 'running' ? 'Running' : status === 'error' ? 'Failed' : 'Not started'}
                  </div>
                  {idx < arr.length - 1 && <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ObservabilityPanel({ metrics }: { metrics: Record<PipelineStepKey, StepMetrics> }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3">
      <div className="text-sm font-medium text-slate-700">API Observability Panel</div>
      <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
        {pipelineSteps.map((s) => {
          const m = metrics[s.key];
          const avg = m.runs > 0 ? Math.round(m.totalMs / m.runs) : 0;
          return (
            <div key={s.key} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-1">
              <div className="font-medium text-slate-700">{s.title}</div>
              <div className="text-slate-600">Success/Fail: {m.success}/{m.fail}</div>
              <div className="text-slate-600">Avg time: {avg} ms</div>
              <div className="text-slate-600">Total retries: {m.retries}</div>
              <div className="text-slate-600">Last time: {m.lastMs} ms</div>
              <div className="text-slate-600">Last attempts: {m.lastAttempts || 0}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RetryPolicyPanel({
  retryPolicy,
  setRetryPolicy,
  retryIntervalMs,
  setRetryIntervalMs,
}: {
  retryPolicy: Record<PipelineStepKey, number>;
  setRetryPolicy: React.Dispatch<React.SetStateAction<Record<PipelineStepKey, number>>>;
  retryIntervalMs: number;
  setRetryIntervalMs: React.Dispatch<React.SetStateAction<number>>;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3">
      <div className="text-sm font-medium text-slate-700">Retry Strategy</div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
        {pipelineSteps.map((s) => (
          <div key={s.key}>
            <label className="block text-xs text-slate-500 mb-1">{s.title}</label>
            <input
              type="number"
              min={0}
              max={5}
              value={retryPolicy[s.key]}
              onChange={(e) =>
                setRetryPolicy((prev) => ({
                  ...prev,
                  [s.key]: Math.max(0, Math.min(5, Number(e.target.value))),
                }))
              }
              className="w-full p-2 bg-slate-50 border border-slate-300 rounded text-sm"
            />
          </div>
        ))}
        <div>
          <label className="block text-xs text-slate-500 mb-1">Retry Interval (ms)</label>
          <input
            type="number"
            min={100}
            step={100}
            value={retryIntervalMs}
            onChange={(e) => setRetryIntervalMs(Math.max(100, Number(e.target.value)))}
            className="w-full p-2 bg-slate-50 border border-slate-300 rounded text-sm"
          />
        </div>
      </div>
    </div>
  );
}

function RuntimeLogsSection({
  jobLoading,
  runtimeTask,
  runtimeStartedAt,
  runtimeUpdatedAt,
  runtimeActive,
  runtimeMeta,
  runtimeLogs,
  autoScrollLog,
  setAutoScrollLog,
  logContainerRef,
  onClearLogs,
  logHeightClass,
}: {
  jobLoading: boolean;
  runtimeTask: string;
  runtimeStartedAt: number | null;
  runtimeUpdatedAt: number | null;
  runtimeActive: boolean;
  runtimeMeta: Record<string, any>;
  runtimeLogs: string[];
  autoScrollLog: boolean;
  setAutoScrollLog: React.Dispatch<React.SetStateAction<boolean>>;
  logContainerRef: React.RefObject<HTMLDivElement | null>;
  onClearLogs: () => Promise<void>;
  logHeightClass: string;
}) {
  const runtimeDurationLabel = formatRuntimeDurationLabel(runtimeStartedAt, runtimeUpdatedAt, runtimeActive);

  return (
    <div className="bg-slate-950 text-slate-100 rounded-xl border border-slate-800 overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900">
        <div className="text-xs font-medium tracking-wide">Runtime Logs</div>
        <div className="text-[11px] text-slate-300 flex items-center gap-3">
          <button
            className="px-2 py-0.5 border border-slate-600 rounded hover:bg-slate-800"
            onClick={onClearLogs}
          >
            Clear Log
          </button>
          <button
            className="px-2 py-0.5 border border-slate-600 rounded hover:bg-slate-800"
            onClick={() => setAutoScrollLog((v) => !v)}
          >
            Auto-scroll: {autoScrollLog ? 'On' : 'Off'}
          </button>
          {jobLoading && <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />}
          task: {runtimeTask}
          {runtimeDurationLabel ? ` | Total time: ${runtimeDurationLabel}` : ''}
          {runtimeMeta?.ebiJobId ? ` | EBI Job: ${runtimeMeta.ebiJobId}` : ''}
        </div>
      </div>
      <LogPanel logs={runtimeLogs} logContainerRef={logContainerRef} heightClass={logHeightClass} />
    </div>
  );
}

function PageTailPanels({
  showRetry,
  retryPolicy,
  setRetryPolicy,
  retryIntervalMs,
  setRetryIntervalMs,
  jobLoading,
  runtimeTask,
  runtimeStartedAt,
  runtimeUpdatedAt,
  runtimeActive,
  runtimeMeta,
  runtimeLogs,
  autoScrollLog,
  setAutoScrollLog,
  logContainerRef,
  onClearLogs,
  logHeightClass,
}: {
  showRetry: boolean;
  retryPolicy: Record<PipelineStepKey, number>;
  setRetryPolicy: React.Dispatch<React.SetStateAction<Record<PipelineStepKey, number>>>;
  retryIntervalMs: number;
  setRetryIntervalMs: React.Dispatch<React.SetStateAction<number>>;
  jobLoading: boolean;
  runtimeTask: string;
  runtimeStartedAt: number | null;
  runtimeUpdatedAt: number | null;
  runtimeActive: boolean;
  runtimeMeta: Record<string, any>;
  runtimeLogs: string[];
  autoScrollLog: boolean;
  setAutoScrollLog: React.Dispatch<React.SetStateAction<boolean>>;
  logContainerRef: React.RefObject<HTMLDivElement | null>;
  onClearLogs: () => Promise<void>;
  logHeightClass: string;
}) {
  return (
    <>
      {showRetry && (
        <RetryPolicyPanel
          retryPolicy={retryPolicy}
          setRetryPolicy={setRetryPolicy}
          retryIntervalMs={retryIntervalMs}
          setRetryIntervalMs={setRetryIntervalMs}
        />
      )}
      <RuntimeLogsSection
        jobLoading={jobLoading}
        runtimeTask={runtimeTask}
        runtimeStartedAt={runtimeStartedAt}
        runtimeUpdatedAt={runtimeUpdatedAt}
        runtimeActive={runtimeActive}
        runtimeMeta={runtimeMeta}
        runtimeLogs={runtimeLogs}
        autoScrollLog={autoScrollLog}
        setAutoScrollLog={setAutoScrollLog}
        logContainerRef={logContainerRef}
        onClearLogs={onClearLogs}
        logHeightClass={logHeightClass}
      />
    </>
  );
}

function LogPanel({
  logs,
  logContainerRef,
  heightClass,
}: {
  logs: string[];
  logContainerRef: React.RefObject<HTMLDivElement | null>;
  heightClass?: string;
}) {
  const [level, setLevel] = useState<'all' | 'stderr' | 'stdout' | 'cmd' | 'task'>('all');
  const [foldRepeated, setFoldRepeated] = useState(true);

  const errorLines = logs.filter((line) => isLikelyErrorLogLine(line)).slice(-5);

  const filteredLogs = useMemo(() => {
    if (level === 'all') {
      return logs;
    }
    return logs.filter((line) => line.toLowerCase().includes(`[${level}]`));
  }, [logs, level]);

  const displayLogs = useMemo(() => {
    if (!foldRepeated) {
      return filteredLogs;
    }
    const out: string[] = [];
    let prev = '';
    let count = 0;
    for (const line of filteredLogs) {
      if (line === prev) {
        count += 1;
      } else {
        if (prev) {
          out.push(count > 1 ? `${prev} (x${count})` : prev);
        }
        prev = line;
        count = 1;
      }
    }
    if (prev) {
      out.push(count > 1 ? `${prev} (x${count})` : prev);
    }
    return out;
  }, [filteredLogs, foldRepeated]);

  const downloadLogs = () => {
    const text = logs.join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `runtime-logs-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyLine = async (line: string) => {
    try {
      await navigator.clipboard.writeText(line);
    } catch {
      // ignore clipboard errors
    }
  };

  const getLineClass = (line: string) => {
    if (isLikelyErrorLogLine(line)) {
      return 'text-red-300';
    }
    if (/\[cmd\]/i.test(line)) {
      return 'text-indigo-300';
    }
    if (/\[task\]/i.test(line)) {
      return 'text-amber-300';
    }
    return 'text-slate-200';
  };

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center gap-2 flex-wrap text-[11px]">
        <select
          className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200"
          value={level}
          onChange={(e) => setLevel(e.target.value as 'all' | 'stderr' | 'stdout' | 'cmd' | 'task')}
        >
          <option value="all">All</option>
          <option value="stderr">stderr</option>
          <option value="stdout">stdout</option>
          <option value="cmd">cmd</option>
          <option value="task">task</option>
        </select>
        <button
          className="px-2 py-1 border border-slate-700 rounded hover:bg-slate-900"
          onClick={() => setFoldRepeated((v) => !v)}
        >
          Collapse repeats: {foldRepeated ? 'On' : 'Off'}
        </button>
        <button className="px-2 py-1 border border-slate-700 rounded hover:bg-slate-900" onClick={downloadLogs}>
          Download Log
        </button>
      </div>

      {errorLines.length > 0 && (
        <div className="mb-2 p-2 rounded border border-red-900 bg-red-950/40 text-[11px] font-mono space-y-1">
          <div className="text-red-300 font-semibold">Recent Errors</div>
          {errorLines.map((line, idx) => (
            <div key={`${line}-${idx}`} className="text-red-200 break-all flex items-start gap-2">
              <span className="flex-1">{line}</span>
              <button className="px-1.5 py-0.5 border border-red-800 rounded text-[10px]" onClick={() => copyLine(line)}>
                Copy
              </button>
            </div>
          ))}
        </div>
      )}

      <div ref={logContainerRef} className={`${heightClass ?? 'h-40'} overflow-auto font-mono text-[11px] leading-5 rounded border border-slate-800 bg-slate-950 p-2`}>
        {displayLogs.length === 0 ? (
          <div className="text-slate-500">[log] No output yet</div>
        ) : (
          displayLogs.map((line, idx) => (
            <div key={`${line}-${idx}`} className={`${getLineClass(line)} break-all`}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-all duration-200 ${
        active ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      <div className={active ? 'text-indigo-600' : 'text-slate-400'}>{icon}</div>
      {label}
    </button>
  );
}

function IdentityHeatmap({
  ids,
  matrix,
  title,
  lowerBound,
  onLowerBoundChange,
  excludedIds,
  onExcludedIdsChange,
}: {
  ids: string[];
  matrix: number[][];
  title: string;
  lowerBound?: number;
  onLowerBoundChange?: (v: number) => void;
  excludedIds?: Set<string>;
  onExcludedIdsChange?: (s: Set<string>) => void;
}) {
  const n = ids.length;
  if (n === 0) return null;

  const wrapRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [sortMode, setSortMode] = useState<'original' | 'cluster'>('original');

  // Hierarchical-ish reorder: sort by average identity descending so similar seqs are adjacent
  const order = useMemo(() => {
    const idx = Array.from({ length: n }, (_, i) => i);
    if (sortMode === 'original') return idx;
    // Phase 1: single-linkage clustering — group sequences into clusters
    // Use median identity as threshold
    const offDiagVals: number[] = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) offDiagVals.push(matrix[i][j]);
    offDiagVals.sort((a, b) => a - b);
    const threshold = offDiagVals.length ? offDiagVals[Math.floor(offDiagVals.length * 0.75)] : 50;
    // Union-find
    const parent = idx.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a: number, b: number) => { parent[find(a)] = find(b); };
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (matrix[i][j] >= threshold) union(i, j);
    // Collect clusters
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(i);
    }
    // Phase 2: sort clusters by descending within-cluster avg identity
    const clusterList = [...groups.values()];
    const withinAvg = (members: number[]) => {
      if (members.length <= 1) return 0;
      let s = 0, cnt = 0;
      for (let a = 0; a < members.length; a++)
        for (let b = a + 1; b < members.length; b++) { s += matrix[members[a]][members[b]]; cnt++; }
      return s / cnt;
    };
    clusterList.sort((a, b) => withinAvg(b) - withinAvg(a));
    // Phase 3: within each cluster, greedy NN ordering
    const result: number[] = [];
    for (const members of clusterList) {
      if (members.length === 1) { result.push(members[0]); continue; }
      // Start from seq with highest avg identity within this cluster
      const avgInCluster = members.map(m => {
        let s = 0;
        for (const o of members) if (o !== m) s += matrix[m][o];
        return s / (members.length - 1);
      });
      const visited = new Set<number>();
      let cur = members[avgInCluster.indexOf(Math.max(...avgInCluster))];
      for (let step = 0; step < members.length; step++) {
        result.push(cur);
        visited.add(cur);
        let best = -1, bestSim = -1;
        for (const j of members) {
          if (!visited.has(j) && matrix[cur][j] > bestSim) { bestSim = matrix[cur][j]; best = j; }
        }
        if (best === -1) break;
        cur = best;
      }
    }
    return result;
  }, [n, matrix, sortMode]);

  const cellSize = Math.max(18, Math.min(40, Math.floor(600 / n)));
  const labelWidth = Math.min(140, Math.max(60, ...ids.map((id) => id.length * 6)));
  const colHeaderHeight = cellSize + 4;
  const svgW = labelWidth + n * cellSize + 60;
  const svgH = colHeaderHeight + n * cellSize + 20;

  function heatColor(pct: number) {
    const t = Math.max(0, Math.min(1, pct / 100));
    if (t < 0.5) {
      const s = t / 0.5;
      return `rgb(${Math.round(66 + s * 189)},${Math.round(133 + s * 122)},${Math.round(244 - s * 144)})`;
    }
    const s = (t - 0.5) / 0.5;
    return `rgb(${Math.round(255 - s * 35)},${Math.round(255 - s * 217)},${Math.round(100 - s * 62)})`;
  }

  // Stats (off-diagonal, excluding self-comparisons)
  const offDiag: number[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) offDiag.push(matrix[order[i]][order[j]]);
  const minVal = offDiag.length ? Math.min(...offDiag) : 0;
  const maxVal = offDiag.length ? Math.max(...offDiag) : 100;
  const mean = offDiag.length ? offDiag.reduce((a, b) => a + b, 0) / offDiag.length : 0;
  const sorted = [...offDiag].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  // Per-sequence max identity to any other
  const maxIdentityPerSeq = useMemo(() => {
    return ids.map((_, i) => {
      let mx = 0;
      for (let j = 0; j < n; j++) if (j !== i) mx = Math.max(mx, matrix[i][j]);
      return mx;
    });
  }, [ids, matrix, n]);

  // Sequences that would be excluded by the lower bound
  const belowLowerBound = useMemo(() => {
    if (!lowerBound || lowerBound <= 0) return new Set<string>();
    const s = new Set<string>();
    for (let i = 0; i < n; i++) {
      if (maxIdentityPerSeq[i] < lowerBound) s.add(ids[i]);
    }
    return s;
  }, [lowerBound, maxIdentityPerSeq, ids, n]);

  const handleCellClick = useCallback(
    (seqId: string) => {
      if (!onExcludedIdsChange || !excludedIds) return;
      const next = new Set(excludedIds);
      if (next.has(seqId)) next.delete(seqId);
      else next.add(seqId);
      onExcludedIdsChange(next);
    },
    [excludedIds, onExcludedIdsChange],
  );

  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h3>
        <div className="flex items-center gap-2">
          <button
            className={`text-xs px-2 py-1 rounded ${sortMode === 'original' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
            onClick={() => setSortMode('original')}
          >
            Original Order
          </button>
          <button
            className={`text-xs px-2 py-1 rounded ${sortMode === 'cluster' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
            onClick={() => setSortMode('cluster')}
          >
            Sort by Similarity
          </button>
        </div>
      </div>
      <div className="flex gap-6 text-xs text-slate-500 dark:text-slate-400">
        <span>Sequence count: {n}</span>
        <span>Min: {minVal.toFixed(1)}%</span>
        <span>Max: {maxVal.toFixed(1)}%</span>
        <span>Mean: {mean.toFixed(1)}%</span>
        <span>Median: {median.toFixed(1)}%</span>
        {belowLowerBound.size > 0 && (
          <span className="text-red-500 font-medium">
            Below lower bound: {belowLowerBound.size}
          </span>
        )}
      </div>
      {onLowerBoundChange !== undefined && (
        <div className="flex items-center gap-3">
          <label className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">Identity Lower Bound (%):</label>
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={lowerBound ?? 0}
            onChange={(e) => onLowerBoundChange(Number(e.target.value))}
            className="flex-1 h-1 accent-indigo-600"
          />
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={lowerBound ?? 0}
            onChange={(e) => onLowerBoundChange(Number(e.target.value))}
            className="w-16 text-xs p-1 border rounded text-center dark:bg-slate-700 dark:border-slate-600 dark:text-slate-200"
          />
        </div>
      )}
      <div ref={wrapRef} className="overflow-auto relative flex justify-center" style={{ maxWidth: '100%', maxHeight: 700 }}>
        <svg width={svgW} height={svgH} className="block">
          {/* Row labels */}
          {order.map((oi, i) => {
            const id = ids[oi];
            const isBelowBound = belowLowerBound.has(id);
            const isExcluded = excludedIds?.has(id);
            return (
              <text
                key={`rl-${i}`}
                x={labelWidth - 4}
                y={colHeaderHeight + i * cellSize + cellSize / 2 + 4}
                textAnchor="end"
                className={`text-[10px] cursor-pointer ${isExcluded ? 'fill-red-400' : isBelowBound ? 'fill-amber-500' : 'fill-slate-600 dark:fill-slate-300'}`}
                textDecoration={isExcluded || isBelowBound ? 'line-through' : undefined}
                onClick={() => handleCellClick(id)}
              >
                {id.length > 18 ? id.slice(0, 16) + '…' : id}
              </text>
            );
          })}
          {/* Column index numbers */}
          {order.map((_oj, j) => (
            <text
              key={`ci-${j}`}
              x={labelWidth + j * cellSize + cellSize / 2}
              y={colHeaderHeight - 4}
              textAnchor="middle"
              className="text-[9px] fill-slate-400 dark:fill-slate-500"
            >
              {j + 1}
            </text>
          ))}
          {/* Cells */}
          {order.map((oi, i) =>
            order.map((oj, j) => {
              const val = matrix[oi][oj];
              const isExRow = excludedIds?.has(ids[oi]);
              const isExCol = excludedIds?.has(ids[oj]);
              return (
                <rect
                  key={`c-${i}-${j}`}
                  x={labelWidth + j * cellSize}
                  y={colHeaderHeight + i * cellSize}
                  width={cellSize - 1}
                  height={cellSize - 1}
                  fill={heatColor(val)}
                  rx={cellSize > 8 ? 2 : 0}
                  opacity={isExRow || isExCol ? 0.25 : 1}
                  className="cursor-pointer"
                  onMouseEnter={(e) => {
                    const rect = (e.target as SVGRectElement).getBoundingClientRect();
                    setTooltip({
                      x: rect.x + rect.width / 2,
                      y: rect.y,
                      text: `${ids[oi]} × ${ids[oj]}: ${val.toFixed(1)}%`,
                    });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                  onClick={() => handleCellClick(ids[oi])}
                />
              );
            }),
          )}
          {/* Lower-bound gray overlay on affected rows/columns */}
          {lowerBound != null && lowerBound > 0 && order.map((oi, i) => {
            if (!belowLowerBound.has(ids[oi])) return null;
            return (
              <React.Fragment key={`lb-${i}`}>
                <rect
                  x={labelWidth}
                  y={colHeaderHeight + i * cellSize}
                  width={n * cellSize}
                  height={cellSize}
                  fill="rgba(148,163,184,0.45)"
                  pointerEvents="none"
                />
                <rect
                  x={labelWidth + i * cellSize}
                  y={colHeaderHeight}
                  width={cellSize}
                  height={n * cellSize}
                  fill="rgba(148,163,184,0.45)"
                  pointerEvents="none"
                />
              </React.Fragment>
            );
          })}
          {/* Color scale legend */}
          {[0, 25, 50, 75, 100].map((v, i) => (
            <React.Fragment key={`leg-${i}`}>
              <rect
                x={labelWidth + n * cellSize + 10}
                y={colHeaderHeight + i * 30}
                width={16}
                height={20}
                fill={heatColor(v)}
                rx={2}
              />
              <text
                x={labelWidth + n * cellSize + 30}
                y={colHeaderHeight + i * 30 + 14}
                className="text-[9px] fill-slate-500"
              >
                {v}%
              </text>
            </React.Fragment>
          ))}
        </svg>
        {tooltip && (
          <div
            className="fixed z-50 bg-slate-800 text-white text-xs px-2 py-1 rounded pointer-events-none"
            style={{ left: tooltip.x, top: tooltip.y - 28, transform: 'translateX(-50%)' }}
          >
            {tooltip.text}
          </div>
        )}
      </div>
      {/* Column index legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-slate-500 dark:text-slate-400 leading-tight">
        {order.map((oj, j) => {
          const id = ids[oj];
          const isBelowBound = belowLowerBound.has(id);
          const isExcluded = excludedIds?.has(id);
          return (
            <span
              key={`legend-${j}`}
              className={`cursor-pointer ${isExcluded ? 'text-red-400 line-through' : isBelowBound ? 'text-amber-500 line-through' : ''}`}
              onClick={() => handleCellClick(id)}
            >
              <span className="text-slate-400 dark:text-slate-500">{j + 1}.</span>{id}
            </span>
          );
        })}
      </div>
      {excludedIds && excludedIds.size > 0 && (
        <div className="text-xs text-slate-500 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-red-500 font-medium">Manually excluded: {excludedIds.size}</span>
            <button
              className="text-indigo-600 hover:underline"
              onClick={() => onExcludedIdsChange?.(new Set())}
            >
              Clear All
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {[...excludedIds].map((id) => (
              <span
                key={id}
                className="bg-red-50 text-red-600 px-1.5 py-0.5 rounded cursor-pointer hover:bg-red-100"
                onClick={() => handleCellClick(id)}
              >
                {id} ✕
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InputNum({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full p-2 bg-slate-50 border border-slate-300 rounded-md text-sm outline-none"
      />
    </div>
  );
}

function SimpleTable({
  rows,
  highlightValue,
  highlightColumn,
  onRowClick,
}: {
  rows: Array<Record<string, string>>;
  highlightValue?: string;
  highlightColumn?: string;
  onRowClick?: (row: Record<string, string>) => void;
}) {
  if (!rows.length) {
    return null;
  }

  const headers = Object.keys(rows[0]);
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-auto">
      <table className="w-full text-sm text-left whitespace-nowrap">
        <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
          <tr>
            {headers.map((h) => (
              <th className="px-4 py-2" key={h}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {rows.map((row, i) => (
            <tr
              key={i}
              className={`${highlightValue && highlightColumn && String(row[highlightColumn] ?? '') === highlightValue ? 'bg-red-50' : ''} ${onRowClick ? 'cursor-pointer hover:bg-slate-50' : ''}`}
              onClick={() => onRowClick?.(row)}
            >
              {headers.map((h) => (
                <td key={h} className="px-4 py-2 text-slate-700">
                  {String(row[h] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReferencePreviewTable({
  rows,
  allRows,
  page,
  totalPages,
  onPageChange,
  title,
}: {
  rows: Array<Record<string, string>>;
  allRows: Array<Record<string, string>>;
  page: number;
  totalPages: number;
  onPageChange: (next: number) => void;
  title?: string;
}) {
  if (!allRows.length) {
    return null;
  }

  const rawHeaders = Object.keys(allRows[0]).filter((h) => h !== 'sequence');
  // Reorder: put 'length' right after accession-like columns (accession, id, input)
  const isAccessionColumn = (name: string) => /^(accession|id|input)$/i.test(name);
  const headers = (() => {
    const lengthIdx = rawHeaders.indexOf('length');
    if (lengthIdx < 0) return rawHeaders;
    const without = rawHeaders.filter((h) => h !== 'length');
    const lastAccIdx = without.reduce((acc, h, i) => (isAccessionColumn(h) ? i : acc), -1);
    without.splice(lastAccIdx + 1, 0, 'length');
    return without;
  })();
  const displayTitle = title || 'Reference Preview';
  const pageSize = Math.ceil(allRows.length / totalPages);
  const start = (page - 1) * pageSize + 1;
  const end = start + rows.length - 1;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-auto">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 text-xs text-slate-600">
        <span>{displayTitle}: page {page}/{totalPages} ({start}-{end} / {allRows.length})</span>
        <div className="flex items-center gap-2">
          <button
            className="px-2 py-1 border rounded disabled:opacity-50"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            Previous Page
          </button>
          <button
            className="px-2 py-1 border rounded disabled:opacity-50"
            disabled={page >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          >
            Next Page
          </button>
        </div>
      </div>
      <table className="w-full text-sm text-left whitespace-nowrap">
        <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b border-slate-200">
          <tr>
            {headers.map((h) => (
              <th className="px-4 py-2" key={h}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {rows.map((row, i) => (
            <tr key={i}>
              {headers.map((h) => {
                const value = String(row[h] ?? '');
                const isAccession = isAccessionColumn(h) && value.trim().length > 0;
                const linkUrl = (() => {
                  if (!isAccession) return '';
                  if (h === 'input' && row.type === 'ncbi_nucleotide') {
                    return `https://www.ncbi.nlm.nih.gov/nuccore/${encodeURIComponent(value)}`;
                  }
                  if (row.type === 'uniprot') {
                    return `https://www.uniprot.org/uniprot/${encodeURIComponent(value)}`;
                  }
                  return `https://www.ncbi.nlm.nih.gov/protein/${encodeURIComponent(value)}`;
                })();
                return (
                  <td key={h} className="px-4 py-2 text-slate-700">
                    {isAccession ? (
                      <a
                        href={linkUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-indigo-600 hover:text-indigo-800 underline"
                      >
                        {value}
                      </a>
                    ) : (
                      value
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
