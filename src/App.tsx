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
import type { BlastDbSource, BlastMergeStrategy, CompareTaskInfo, CompareResult, PreAlignmentAnchor, ScoringPositionMode, ScoringRule, RecommendCandidate, RecommendWeights, BrowserGraphNode, BrowserGraphEdge } from './api';
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

const accessionPlaceholder = ['例如：', 'AAC72747.1', 'KDQ24956.1', '9AVH_A', 'MF540777', 'P46881'].join('\n');

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
    throw new Error('请先选择一个 FASTA 文件');
  }
  if (!/\.(fasta|fa|faa|fas|fna|txt)$/i.test(file.name)) {
    throw new Error('仅支持 .fasta, .fa, .faa, .fas, .fna 或 .txt 文件');
  }
  if (file.size <= 0) {
    throw new Error('所选文件为空');
  }
  if (file.size > MAX_REFERENCE_FASTA_UPLOAD_BYTES) {
    throw new Error(`文件过大，当前限制为 ${formatFileSize(MAX_REFERENCE_FASTA_UPLOAD_BYTES)}`);
  }
  return file;
}

function validateReferenceFastaText(text: string) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('>')) {
    throw new Error('FASTA 文件格式无效：内容必须以 > 开头');
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
    throw new Error('规则必须是非空数组');
  }

  return parsed.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`第 ${idx + 1} 条规则必须是对象`);
    }
    const rule = item as Record<string, unknown>;

    const pos = Number(rule.pos);
    if (!Number.isInteger(pos) || pos <= 0) {
      throw new Error(`第 ${idx + 1} 条规则的 pos 非法`);
    }

    const score = Number(rule.score);
    if (!Number.isFinite(score)) {
      throw new Error(`第 ${idx + 1} 条规则的 score 非法`);
    }

    const label = String(rule.label ?? '').trim();
    if (!label) {
      throw new Error(`第 ${idx + 1} 条规则的 label 不能为空`);
    }

    if (!Array.isArray(rule.allowed) || rule.allowed.length === 0) {
      throw new Error(`第 ${idx + 1} 条规则的 allowed 必须是非空数组`);
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
      throw new Error(`第 ${idx + 1} 条规则的 allowed 不能为空`);
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
const WEIGHT_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#8b5cf6', '#f59e0b']; // indigo, sky, emerald, amber
const DEFAULT_WEIGHTS: RecommendWeights = { avgRefSimilarity: 0.35, maxRefSimilarity: 0.25, clusterSize: 0.15, networkComponentSize: 0.15, taxonomyDiversity: 0.1 };
const WEIGHT_LABELS: { key: keyof RecommendWeights; label: string }[] = [
  { key: 'avgRefSimilarity', label: 'Avg Ref Sim' },
  { key: 'maxRefSimilarity', label: 'Max Ref Sim' },
  { key: 'clusterSize', label: 'Cluster Size' },
  { key: 'networkComponentSize', label: 'Net Comp Size' },
  { key: 'taxonomyDiversity', label: 'Tax Diversity' },
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

function normalizeRecommendWeights(weights: unknown): RecommendWeights {
  if (!weights || typeof weights !== 'object') {
    return { ...DEFAULT_WEIGHTS };
  }

  const raw = weights as Partial<Record<keyof RecommendWeights, unknown>>;
  const parsed: RecommendWeights = {
    avgRefSimilarity: Number.isFinite(Number(raw.avgRefSimilarity)) ? Math.max(0, Number(raw.avgRefSimilarity)) : 0,
    maxRefSimilarity: Number.isFinite(Number(raw.maxRefSimilarity)) ? Math.max(0, Number(raw.maxRefSimilarity)) : 0,
    clusterSize: Number.isFinite(Number(raw.clusterSize)) ? Math.max(0, Number(raw.clusterSize)) : 0,
    networkComponentSize: Number.isFinite(Number(raw.networkComponentSize)) ? Math.max(0, Number(raw.networkComponentSize)) : 0,
    taxonomyDiversity: Number.isFinite(Number(raw.taxonomyDiversity)) ? Math.max(0, Number(raw.taxonomyDiversity)) : 0,
  };

  const total = Object.values(parsed).reduce((s, v) => s + v, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return { ...DEFAULT_WEIGHTS };
  }

  return {
    avgRefSimilarity: parsed.avgRefSimilarity / total,
    maxRefSimilarity: parsed.maxRefSimilarity / total,
    clusterSize: parsed.clusterSize / total,
    networkComponentSize: parsed.networkComponentSize / total,
    taxonomyDiversity: parsed.taxonomyDiversity / total,
  };
}

function WeightBar({ weights, onChange }: { weights: RecommendWeights; onChange: (w: RecommendWeights) => void }) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);

  // Convert weights to cumulative positions (3 dividers)
  const normalizedWeights = useMemo(() => normalizeRecommendWeights(weights), [weights]);
  const vals = WEIGHT_LABELS.map(({ key }) => normalizedWeights[key]);
  const total = vals.reduce((s, v) => s + v, 0) || 1;
  const normed = vals.map(v => v / total);
  const cumulative = normed.reduce<number[]>((acc, v, i) => {
    acc.push((acc[i - 1] ?? 0) + v);
    return acc;
  }, []);
  // divider positions: cumulative[0], cumulative[1], cumulative[2]  (cumulative[3] = 1)
  const dividers = cumulative.slice(0, 4);

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
    const minGap = 0;
    const lo = idx === 0 ? minGap : dividers[idx - 1] + minGap;
    const hi = idx === 3 ? 1 - minGap : dividers[idx + 1] - minGap;
    const clamped = Math.max(lo, Math.min(hi, pct));
    const newDiv = [...dividers];
    newDiv[idx] = clamped;
    // Derive weights from divider positions
    const segs = [newDiv[0], newDiv[1] - newDiv[0], newDiv[2] - newDiv[1], newDiv[3] - newDiv[2], 1 - newDiv[3]];
    const next: RecommendWeights = {
      avgRefSimilarity: Number(segs[0].toFixed(2)),
      maxRefSimilarity: Number(segs[1].toFixed(2)),
      clusterSize: Number(segs[2].toFixed(2)),
      networkComponentSize: Number(segs[3].toFixed(2)),
      taxonomyDiversity: Number(segs[4].toFixed(2)),
    };
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
              style={{ left: `${left * 100}%`, width: `${w * 100}%`, backgroundColor: WEIGHT_COLORS[i] }}
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
      <div className="flex items-center gap-3 text-[10px] text-slate-500">
        {WEIGHT_LABELS.map(({ key, label }, i) => (
          <span key={key} className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: WEIGHT_COLORS[i] }} />
            {label} {(normalizedWeights[key] * 100).toFixed(0)}%
          </span>
        ))}
        <button
          type="button"
          className="ml-auto text-[10px] text-slate-400 hover:text-indigo-500 underline"
          onClick={() => onChange({ ...DEFAULT_WEIGHTS })}
        >
          恢复默认
        </button>
      </div>
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
  const [recommendWeights, setRecommendWeights] = useState<RecommendWeights>({ avgRefSimilarity: 0.35, maxRefSimilarity: 0.25, clusterSize: 0.15, networkComponentSize: 0.15, taxonomyDiversity: 0.1 });
  const [recommendNetworkConnectivityThreshold, setRecommendNetworkConnectivityThreshold] = useState<number>(85);
  const [recommendTopN, setRecommendTopN] = useState(50);
  const [recommendMinClusterSize, setRecommendMinClusterSize] = useState(2);
  const [recommendMinSimilarity, setRecommendMinSimilarity] = useState(0);
  const [recommendTemperature, setRecommendTemperature] = useState(0);
  const [recommendDiversityMode, setRecommendDiversityMode] = useState<'proportional' | 'round-robin'>('proportional');
  const [recommendMeta, setRecommendMeta] = useState<{ totalCandidates: number; totalReferences: number; filteredByClusterSize: number; filteredBySimilarity: number } | null>(null);

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
    setJob({ loading: true, message: `加载任务进度: ${selectedTaskId}`, error: '' });
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

        setJob({ loading: false, message: `已载入任务进度: ${selectedTaskId}`, error: '' });
        if (staleRecommendCache) {
          setCompletionToast('检测到旧版推荐缓存已失效，请重新计算推荐');
        }
      } catch (err) {
        if (!cancelled) {
          setJob({ loading: false, message: '', error: `载入任务进度失败: ${String(err)}` });
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
    
    // 如果数量极大，前端渲染散点图会极度卡顿（特别是在框选触发渲染时），故进行均匀采样降级
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
              message: markError ? '' : '后端任务已结束，已自动解除前端运行锁',
              error: markError ? '后端任务结束但返回失败，已自动解除前端运行锁' : '',
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
          setRuntimeLogs((prev) => (prev.length ? prev : ['[log] 暂时无法读取后端日志'])) ;
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
      setScoringRulesSuccess(`规则已自动校验通过，共 ${parsed.length} 条，满分 ${maxScore}`);
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
            setJob({ loading: true, message: `${label} 重试中 (${attempt}/${totalRetries})`, error: '' });
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

      setJob({ loading: false, message: `${label} 完成`, error: '' });
      if (step) {
        setStepState((prev) => ({ ...prev, [step]: 'success' }));
        setActiveStep(null);
        setLastCompletedStep(step);
      }
      const stepTitle = step ? (pipelineSteps.find((x) => x.key === step)?.title || label) : label;
      setCompletionToast(customToast || `${stepTitle} 完成`);
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
      throw new Error('默认任务不可删除');
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
    setReferenceImportNotice(`已从文件 ${uploadFile.name} 导入 ${data.rows} 条参考序列`);
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
      throw new Error('请先执行第一步：提交任务');
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
      setJob({ loading: true, message: '正在补全UniProt数据（需拉取大量序列信息，由后端并发执行）...', error: '' });
      const res = await fillUniProt(selectedTaskId);
      if (res.ok) {
        setJob({ loading: true, message: 'UniProt 拉取完成，正在执行长度一致性检查...', error: '' });
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
        throw new Error('补全失败: ' + res.message);
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
      setScoringRulesSuccess(`规则校验通过，共 ${customRules.length} 条，满分 ${maxScore}`);
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
        const note = `已自动下载打分结果: ${fileName}`;
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
      setJob({ loading: false, message: '已确认，开始重新计算序列相似性...', error: '' });
      await runAction('计算序列相似性', runComputeSimilarity, 'similarity');
    } catch (err) {
      setJob({ loading: false, message: '', error: `计算前检查失败: ${String(err)}` });
    }
  };

  const cancelSimilarityRecompute = () => {
    setSimilarityConfirmState((prev) => ({ ...prev, open: false }));
    setJob({ loading: false, message: '已取消重新计算，相似性结果保持不变', error: '' });
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
    setJob({ loading: false, message: '已确认，开始重新计算序列相似性...', error: '' });
    void runAction('计算序列相似性', runComputeSimilarity, 'similarity');
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
    const data = await recommendCandidates({ weights: normalizeRecommendWeights(recommendWeights), topN: recommendTopN, minClusterSize: recommendMinClusterSize, minSimilarity: recommendMinSimilarity, temperature: recommendTemperature, diversityMode: recommendDiversityMode, networkConnectivityThreshold: recommendNetworkConnectivityThreshold });
    setRecommendResults(data.candidates);
    setRecommendMeta({ totalCandidates: data.totalCandidates, totalReferences: data.totalReferences, filteredByClusterSize: data.filteredByClusterSize, filteredBySimilarity: data.filteredBySimilarity });
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
      setCompletionToast(`已在网络中高亮 ${recommendResults.length} 条推荐序列，请返回 Similarity Network 查看`);
    } catch (err: any) {
      alert('高亮失败: ' + (err?.message || err));
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
          <button onClick={onBack} className="flex items-center gap-2 text-indigo-600 hover:text-indigo-800 transition-colors" title="返回主页">
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
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8 shadow-sm z-10">
          <div className="flex items-center text-sm text-slate-500">
            <span>Pipeline</span>
            <ChevronRight className="w-4 h-4 mx-1" />
            <span className="font-medium text-slate-900 capitalize">{currentView.replace('-', ' ')}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">任务</span>
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
                placeholder="新任务ID(可选)"
                disabled={job.loading}
              />
              <button
                className="px-2 py-1.5 rounded bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
                onClick={() => runAction('新建任务', createTaskAndSwitch)}
                disabled={job.loading}
              >
                新建
              </button>
              <button
                className="px-2 py-1.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50"
                onClick={() => runAction('复制任务', duplicateSelectedTask)}
                disabled={job.loading}
              >
                复制
              </button>
              <button
                className="px-2 py-1.5 rounded bg-red-600 text-white text-xs hover:bg-red-700 disabled:opacity-50"
                onClick={() => runAction('删除任务', deleteSelectedTask)}
                disabled={job.loading || selectedTaskId === 'hmmer-default'}
              >
                删除
              </button>
            </div>
            <StatusBadge job={job} />
            <button
              className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
              onClick={() => setDarkMode((v) => !v)}
              title={darkMode ? '切换为浅色模式' : '切换为深色模式'}
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
                    runAction('检查后端状态', async () => {
                      const data = await healthCheck();
                      setHealth(data);
                    })
                  }
                >
                  检查后端健康状态
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
                    <div className="text-sm font-semibold text-slate-700">两种加载参考序列的方法</div>
                    <div className="mt-1 text-sm text-slate-500">
                      任选一种即可生成当前任务的 ref.csv 和 ref.fasta。只有序列号时用方式 A；已经有本地 FASTA 文件时直接用方式 B。
                    </div>
                  </div>
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <section className="rounded-2xl border border-indigo-200 bg-indigo-50/70 p-4 space-y-3">
                      <div className="flex items-center gap-3">
                        <span className="rounded-full bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white">方式 A</span>
                        <div>
                          <div className="text-sm font-semibold text-slate-800">按 accession 在线拉取</div>
                          <div className="text-xs text-slate-500">适合只有 accession、protein_id 或 UniProt ID 的情况</div>
                        </div>
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-slate-700">Entrez Email</label>
                        <input className="w-full rounded-lg border border-slate-200 bg-white p-2 text-sm" value={entrezEmail} onChange={(e) => setEntrezEmail(e.target.value)} />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-slate-700">Accession List</label>
                        <p className="mb-2 text-xs text-slate-500 leading-relaxed">
                          支持 <strong>NCBI Protein</strong>、<strong>NCBI Nucleotide</strong>、<strong>UniProt</strong> 混合输入，系统会自动识别来源并拉取序列。
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
                        onClick={() => runAction('下载参考序列', runReferenceStep, 'reference')}
                      >
                        在线拉取并生成 ref.csv / ref.fasta
                      </button>
                    </section>
                    <section className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4 space-y-3">
                      <div className="flex items-center gap-3">
                        <span className="rounded-full bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white">方式 B</span>
                        <div>
                          <div className="text-sm font-semibold text-slate-800">上传本地 FASTA 文件</div>
                          <div className="text-xs text-slate-500">适合你已经整理好参考序列文件，想直接导入时使用</div>
                        </div>
                      </div>
                      <div className="rounded-xl border border-sky-200 bg-white/80 px-3 py-2 text-xs text-slate-500">
                        支持 .fasta、.fa、.faa、.fas、.fna、.txt，单文件限制 20 MB。导入后会直接覆盖当前任务的参考集。
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
                          ? `已选择文件：${referenceUploadFile.name} · ${formatFileSize(referenceUploadFile.size)}`
                          : '尚未选择文件。请选择一个本地 FASTA 文件后再导入。'}
                      </div>
                      <button
                        className="w-full rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
                        disabled={job.loading || !referenceUploadFile}
                        onClick={() => runAction('上传参考 FASTA', runReferenceUploadStep, 'reference')}
                      >
                        上传导入并生成 ref.csv / ref.fasta
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
                      onClick={() => runAction('计算参考序列 Pairwise Identity', runRefPairwiseIdentity, 'reference')}
                    >
                      计算参考序列 Pairwise Identity（自动推荐 CD-HIT 阈值）
                    </button>
                    <IdentityHeatmap
                      ids={refIdentityIds}
                      matrix={refIdentityMatrix}
                      title="参考序列 Pairwise Identity 热图"
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
                    <label className="block text-sm font-medium mb-1">Reference FASTA（自动承接上一步；留空=后端默认）</label>
                    <input
                      className="w-full p-2 border rounded text-sm"
                      value={referenceFastaPath}
                      onChange={(e) => setReferenceFastaPath(e.target.value)}
                      placeholder="例如: /path/to/ref.fasta"
                    />
                  </div>
                  <InputNum label="Identity 下界 (%)" value={identityLowerBound} step={0.1} onChange={setIdentityLowerBound} />
                  <InputNum label="去重上界 (%)" value={+(cdhitIdentity * 100).toFixed(1)} step={0.1} onChange={(v) => setCdhitIdentity(v / 100)} />
                  <div className="md:col-span-2 flex items-end">
                    <button
                      className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm h-10 flex items-center justify-center gap-2 w-full"
                      disabled={job.loading}
                      onClick={() => runAction('构建 HMM', runHmmBuildStep, 'hmm')}
                    >
                      <Play className="w-4 h-4" />
                      运行 CD-HIT + MAFFT + hmmbuild
                    </button>
                  </div>
                </div>
                {hmmBuildStats && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                    <h3 className="text-sm font-semibold text-slate-700">CD-HIT 聚类统计</h3>
                    <div className="flex gap-6 text-sm flex-wrap">
                      <span>输入序列: <strong>{hmmBuildStats.inputCount}</strong></span>
                      {hmmBuildStats.lowerBoundRemoved && hmmBuildStats.lowerBoundRemoved.length > 0 && (
                        <span className="text-red-500">
                          下界过滤移除: <strong>{hmmBuildStats.lowerBoundRemoved.length}</strong> 条
                        </span>
                      )}
                      <span>→ 聚类后代表序列: <strong>{hmmBuildStats.outputCount}</strong></span>
                      <span>聚类数: <strong>{hmmBuildStats.clusterCount}</strong></span>
                      <span className="text-slate-400">
                        (去除 {hmmBuildStats.inputCount - hmmBuildStats.outputCount} 条冗余，
                        保留 {((hmmBuildStats.outputCount / Math.max(1, hmmBuildStats.inputCount)) * 100).toFixed(1)}%)
                      </span>
                    </div>
                    {hmmBuildStats.lowerBoundRemoved && hmmBuildStats.lowerBoundRemoved.length > 0 && (
                      <details className="text-xs text-red-500">
                        <summary className="cursor-pointer hover:text-red-700">查看下界过滤移除的序列</summary>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {hmmBuildStats.lowerBoundRemoved.map((id) => (
                            <span key={id} className="bg-red-50 px-1.5 py-0.5 rounded">{id}</span>
                          ))}
                        </div>
                      </details>
                    )}
                    {hmmBuildStats.clusters.length > 0 && hmmBuildStats.clusters.length <= 50 && (
                      <details className="text-xs text-slate-500">
                        <summary className="cursor-pointer hover:text-slate-700">展开聚类详情</summary>
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
                  title="CD-HIT 聚类后代表序列"
                />
                {hmmBuildStats && (
                  <div className="space-y-3">
                    <button
                      className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg text-sm"
                      disabled={job.loading}
                      onClick={() => runAction('计算聚类后 Pairwise Identity', runPostCdhitPairwiseIdentity, 'hmm')}
                    >
                      计算聚类后序列 Pairwise Identity
                    </button>
                    <IdentityHeatmap ids={postCdhitIdentityIds} matrix={postCdhitIdentityMatrix} title="CD-HIT 聚类后 Pairwise Identity 热图" />
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
                    EBI 任务正在运行: Job ID = {runtimeMeta.ebiJobId}
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
                      {searchMode === 'ebi' ? '当前走 EBI 在线服务器，可能更慢。' : '当前走本地 hmmsearch。'}
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
                      <label className="block text-xs text-slate-500 mb-1">Target FASTA 路径（留空=后端默认）</label>
                      <input
                        className="w-full p-2 border rounded text-sm"
                        value={targetFasta}
                        onChange={(e) => setTargetFasta(e.target.value)}
                        placeholder="例如: /path/to/target.fasta"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">HMM 文件路径（留空=后端默认）</label>
                    <input
                      className="w-full p-2 border rounded text-sm"
                      value={hmmFile}
                      onChange={(e) => setHmmFile(e.target.value)}
                      placeholder="例如: /path/to/ref.hmm"
                    />
                  </div>
                  {searchMode === 'ebi' ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 overflow-x-auto pb-1">
                        {[
                          { key: 'submit' as EbiSubStepKey, title: '1. 提交任务到服务器', desc: ebiStageJobId ? `Job ID: ${ebiStageJobId}` : '生成并提交 EBI job' },
                          { key: 'download' as EbiSubStepKey, title: '2. 下载 HMMER 结果', desc: allHmmRows.length > 0 ? `已载入 ${allHmmRows.length} 条` : '分页下载并解析为 hits_all' },
                          { key: 'enrich' as EbiSubStepKey, title: '3. 拉长度并一致性补齐', desc: consistencyStats ? `filled=${consistencyStats.filled}` : '补全 UniProt 后执行长度一致性检查' },
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
                                {isDone && <div className="mt-1 font-semibold">这一段完成</div>}
                              </div>
                              {idx < arr.length - 1 && <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />}
                            </React.Fragment>
                          );
                        })}
                      </div>

                      {ebiStageFailedPages !== null && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-800">
                          下载阶段失败页数: {ebiStageFailedPages}
                          {ebiStageFailedPageNumbers.length > 0 && (
                            <span> | 失败页码: {ebiStageFailedPageNumbers.slice(0, 20).join(', ')}{ebiStageFailedPageNumbers.length > 20 ? ' ...' : ''}</span>
                          )}
                        </div>
                      )}

                      <button
                        className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm transition-colors disabled:bg-slate-200 disabled:text-slate-500"
                        disabled={job.loading}
                        onClick={() => {
                          const next = getNextEbiSubStep();
                          const labelMap: Record<EbiSubStepKey, string> = {
                            submit: '第一段：提交任务到服务器',
                            download: '第二段：下载 HMMER 结果',
                            enrich: '第三段：拉长度并一致性补齐',
                          };
                          const stepForProgress: PipelineStepKey | undefined = next === 'enrich' ? 'search' : undefined;
                          runAction(labelMap[next], runNextEbiSubStep, stepForProgress, undefined, `${labelMap[next]} 完成`);
                        }}
                      >
                        <Play className="inline w-4 h-4 mr-1" />
                        {ebiSubStepState.submit === 'success' && ebiSubStepState.download === 'success' && ebiSubStepState.enrich === 'success'
                          ? '三段均已完成（可重跑第三段）'
                          : `继续下一段：${getNextEbiSubStep() === 'submit' ? '提交任务' : getNextEbiSubStep() === 'download' ? '下载结果' : '拉长度并补齐'}`}
                      </button>
                    </div>
                  ) : (
                    <button
                      className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm"
                      disabled={job.loading}
                      onClick={() => runAction('运行 hmmsearch', runSearchStep, 'search')}
                    >
                      <Search className="inline w-4 h-4 mr-1" />
                      提交 hmmsearch
                    </button>
                  )}

                  {typeof runtimeMeta?.uniprotProgress === 'number' && runtimeTask === 'search/uniprot-fill' && (
                    <div className="w-full mt-4 bg-slate-50 p-3 rounded-lg border border-slate-100">
                      <div className="flex justify-between text-xs text-slate-600 mb-2 font-medium">
                        <span>
                          🧬 正在并发拉取 UniProt 数据...
                          {runtimeMeta.uniprotPhase === 'writing' ? '（正在写入结果文件）' : ''}
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
                        <span>📏 正在执行长度一致性检查...</span>
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
                        <span>⏬ 正在下载并解析结果页 ({runtimeMeta.ebiDownloadProgress.current} / {runtimeMeta.ebiDownloadProgress.total})</span>
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
                    onClick={() => runAction('过滤 hits', runFilterStep, 'search')}
                  >
                    {filterStats ? `保存过滤结果（已筛 ${filterStats.kept}/${filterStats.total}）` : '保存过滤结果'}
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
                      if (!dom || !W) return <div className="flex items-center justify-center h-full text-slate-400 text-sm">{hitsRows.length ? '数据加载中...' : '暂无数据'}</div>;
                      const xRange = dom.xMax - dom.xMin;
                      const yRange = dom.yMax - dom.yMin;
                      if (xRange <= 0 || yRange <= 0) return <div className="flex items-center justify-center h-full text-slate-400 text-sm">数据范围为零，无法绘图</div>;
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
                        已框选 {selectionBoxes.length} 个区域，命中 {filteredRows.length} 条。Shift + 拖拽可新增框选，拖动已有框可平移。
                      </span>
                    ) : (
                      <span>先展示全部 HMM 结果。可在图上拖拽画框过滤，滚轮缩放，Shift + 拖拽可多框选择。</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="px-3 py-1.5 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-100"
                      onClick={resetZoom}
                    >
                      重置缩放
                    </button>
                    <button
                      className="px-3 py-1.5 rounded border border-amber-300 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                      disabled={!selectionBoxes.length}
                      onClick={syncBoxesToFilter}
                      title="将框选区域的边界同步到上方的筛选输入框"
                    >
                      同步到筛选
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
                      清除框选
                    </button>
                    <button
                      className="px-3 py-1.5 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                      disabled={!filteredRows.length || job.loading}
                      onClick={() =>
                        runAction('保存框选结果到后端', async () => {
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
                      保存框选为后端过滤
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
                      runAction('加载上一页', async () => {
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
                    上一页
                  </button>
                  <button
                    className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
                    disabled={job.loading || selectionBoxes.length > 0}
                    onClick={() =>
                      runAction('刷新当前页', async () => {
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
                    刷新
                  </button>
                  <button
                    className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
                    disabled={job.loading || searchPage >= searchTotalPages || selectionBoxes.length > 0}
                    onClick={() =>
                      runAction('加载下一页', async () => {
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
                    下一页
                  </button>
                  <span className="text-sm text-slate-600">
                    数据源: {searchSource} | 第 {searchPage} / {searchTotalPages} 页 {selectionBoxes.length > 0 ? '| 框选中（分页已锁定）' : ''}
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
                    <label className="block text-xs text-slate-500 mb-1">筛选 FASTA（留空=后端默认）</label>
                    <input className="w-full p-2 border rounded text-sm" value={candidateFasta} onChange={(e) => setCandidateFasta(e.target.value)} placeholder="例如: /path/to/hits_filtered.fasta" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">参考 FASTA（留空=后端默认）</label>
                    <input className="w-full p-2 border rounded text-sm" value={referenceFastaPath} onChange={(e) => setReferenceFastaPath(e.target.value)} placeholder="例如: /path/to/ref.fasta" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">参考序列 ID</label>
                    <input className="w-full p-2 border rounded text-sm" value={refId} onChange={(e) => setRefId(e.target.value)} placeholder="留空=自动使用参考序列第一条" />
                  </div>
                  <button
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm h-10"
                    disabled={job.loading}
                    onClick={() => runAction('生成对齐文件', runAlignmentStep, 'alignment')}
                  >
                    生成对齐并载入预览
                  </button>
                </div>

                {runtimeMeta?.alignmentProgress && runtimeTask === 'scoring/prepare-alignment' && job.loading && (
                  <div className="w-full bg-slate-50 p-3 rounded-lg border border-slate-100">
                    <div className="flex justify-between text-xs text-slate-600 mb-2 font-medium">
                      <span>
                        🧬 正在准备 Alignment
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
                    <InputNum label="列起点" value={alignmentPreviewStart} step={10} onChange={(v) => setAlignmentPreviewStart(Math.max(1, Math.floor(v)))} />
                    <InputNum label="列终点" value={alignmentPreviewEnd} step={10} onChange={(v) => setAlignmentPreviewEnd(Math.max(1, Math.floor(v)))} />
                    <div className="text-xs text-slate-600 md:col-span-2">
                      对齐文件: {alignmentPath || '(暂无)'}
                    </div>
                    <button
                      className="px-3 py-2 rounded border border-slate-300 text-sm"
                      disabled={job.loading || !alignmentPath}
                      onClick={() => runAction('刷新对齐预览', async () => {
                        await loadAlignmentPreviewPage(0);
                      })}
                    >
                      刷新预览
                    </button>
                    <div className="text-xs text-slate-600">
                      rows: {alignmentPreviewRows.length}/{alignmentPreviewTotalRecords} | alnLen: {alignmentPreviewLength}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
                      disabled={job.loading || alignmentPreviewOffset <= 0 || !alignmentPath}
                      onClick={() => runAction('对齐预览上一页', async () => {
                        await loadAlignmentPreviewPage(Math.max(0, alignmentPreviewOffset - alignmentPreviewLimit));
                      })}
                    >
                      上一页
                    </button>
                    <button
                      className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
                      disabled={job.loading || alignmentPreviewOffset + alignmentPreviewLimit >= alignmentPreviewTotalRecords || !alignmentPath}
                      onClick={() => runAction('对齐预览下一页', async () => {
                        await loadAlignmentPreviewPage(alignmentPreviewOffset + alignmentPreviewLimit);
                      })}
                    >
                      下一页
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
                          <th className="px-2 py-2 text-left">对齐片段（交互窗口）</th>
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
                  <div className="font-semibold text-slate-900">当前运行状态</div>
                  <div className="text-xs text-slate-600">
                    最近一次对齐文件：{(scoringRunInfo?.alignmentUsed || alignmentPath || '(暂无)')}
                  </div>
                  <div className="text-xs text-slate-600">
                    当前位点模式：
                    {scoringPositionMode === 'pre' ? '对齐前残基编号' : '对齐后列号'}
                    {scoringPositionMode === 'pre'
                      ? (preAlignmentAnchor === 'first' ? '（默认跟随第一条序列）' : `（按参考ID锚定: ${refId || '(空)'})`)
                      : ''}
                  </div>
                  {scoringRunInfo && (
                    <div className="text-xs text-slate-600">
                      最近一次打分：{scoringRunInfo.passed}/{scoringRunInfo.total} 通过阈值
                    </div>
                  )}
                  {scoringRunInfo?.passedFasta && (
                    <div className="text-xs text-slate-600">
                      阈值筛选模块：已导出通过序列 FASTA ({scoringRunInfo.passedCount || 0} 条) → 路径 {scoringRunInfo.passedFasta}
                    </div>
                  )}
                  {alignmentPrepInfo && (
                    <div className="text-xs text-slate-600">
                      最近一次仅对齐：records={alignmentPrepInfo.records} | {alignmentPrepInfo.alignment}
                    </div>
                  )}
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Alignment 路径（留空=后端默认）</label>
                    <input className="w-full p-2 border rounded text-sm" value={alignmentPath} onChange={(e) => setAlignmentPath(e.target.value)} placeholder="例如: /path/to/alignment.fasta" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">参考序列 ID</label>
                    <input className="w-full p-2 border rounded text-sm" value={refId} onChange={(e) => setRefId(e.target.value)} placeholder="留空=自动使用参考序列第一条" />
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">位点坐标模式</label>
                    <select
                      className="w-full p-2 border rounded text-sm"
                      value={scoringPositionMode}
                      onChange={(e) => setScoringPositionMode((e.target.value === 'aligned' ? 'aligned' : 'pre'))}
                    >
                      <option value="pre">对齐前（残基编号）</option>
                      <option value="aligned">对齐后（MSA 列号）</option>
                    </select>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-slate-700 pb-2">
                    <input
                      type="checkbox"
                      checked={preAlignmentAnchor === 'refid'}
                      disabled={scoringPositionMode !== 'pre'}
                      onChange={(e) => setPreAlignmentAnchor(e.target.checked ? 'refid' : 'first')}
                    />
                    对齐前模式使用参考ID锚定（关闭=默认第一条序列）
                  </label>
                  <div className="text-xs text-slate-500 pb-2">
                    对齐前: 按锚序列残基编号自动映射到 MSA 列；对齐后: 直接把 pos 当列号。
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="text-sm text-slate-700">打分规则（可直接编辑）</div>
                    <div className="text-xs text-slate-500">当前规则数: {scoringRules.length}</div>
                  </div>

                  <div className="overflow-auto border rounded">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 border-b">
                        <tr>
                          <th className="px-2 py-2 text-left">Pos</th>
                          <th className="px-2 py-2 text-left">Allowed (comma separated)</th>
                          <th className="px-2 py-2 text-left">Score</th>
                          <th className="px-2 py-2 text-left">Label</th>
                          <th className="px-2 py-2 text-left">操作</th>
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
                                删除
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
                        setScoringRulesSuccess(`已应用 PeAAO 规则模板，共 ${peAaoScoringRules.length} 条，满分 ${maxScore}`);
                      }}
                    >
                      应用 PeAAO 规则模板（覆盖）
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
                      新增规则
                    </button>
                    <button
                      className="px-3 py-1.5 rounded border border-slate-300 text-sm hover:bg-slate-50"
                      onClick={() => rulesImportRef.current?.click()}
                    >
                      导入规则 JSON
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
                      导出规则 JSON
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
                          setScoringRulesSuccess(`导入成功，规则数 ${parsed.length}，满分 ${maxScore}`);
                        } catch (err) {
                          setScoringRulesError(`导入失败: ${String(err)}`);
                          setScoringRulesSuccess('');
                        } finally {
                          e.currentTarget.value = '';
                        }
                      }}
                    />
                    <div className="text-xs text-slate-500">支持导入/导出 JSON，字段为 pos / allowed / score / label；allowed 可含 "Uni"</div>
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
                        ? `规则校验未通过: ${scoringRulesError}`
                        : '执行打分（基于第4步 Alignment）'
                    }
                    onClick={() => runAction('执行活性位点打分', runScoringStep, 'scoring')}
                  >
                    执行打分（基于第4步 Alignment）
                  </button>

                  <div className="pt-1 border-t border-slate-100">
                    <label className="flex items-center gap-2 text-sm text-slate-700 pb-2">
                      <input
                        type="checkbox"
                        checked={autoDownloadScoringCsv}
                        onChange={(e) => setAutoDownloadScoringCsv(e.target.checked)}
                      />
                      打分成功后自动下载完整 CSV
                    </label>
                    <InputNum label="Threshold（打分后设置）" value={threshold} step={0.1} onChange={setThreshold} />
                    <div className="text-xs text-slate-500 mt-1">建议先运行打分，再根据结果调整阈值并重跑统计。</div>
                    {thresholdPreview && (
                      <div className="mt-2 text-xs text-indigo-700 border border-indigo-200 bg-indigo-50 rounded p-2">
                        阈值预估（基于当前 scored_results.csv）：阈值 {thresholdPreview.threshold} 时通过 {thresholdPreview.passed}/{thresholdPreview.total}（{(thresholdPreview.ratio * 100).toFixed(1)}%）。
                        若要让聚类使用该阈值结果，请重跑一次打分。
                      </div>
                    )}
                  </div>

                  {Boolean(scoringRulesError) && (
                    <div className="text-xs text-amber-700 border border-amber-200 bg-amber-50 rounded p-2">
                      当前规则存在错误，已禁止运行打分。请先修正上方红色错误提示。
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
                    <label className="block text-xs text-slate-500 mb-1">Candidate FASTA 路径（留空=后端默认）</label>
                    <input className="w-full p-2 border rounded text-sm" value={candidateFasta} onChange={(e) => setCandidateFasta(e.target.value)} placeholder="例如: /path/to/hits_filtered.fasta" />
                  </div>
                  <InputNum label="Identity (-c)" value={clusterIdentity} step={0.01} onChange={setClusterIdentity} />
                  <InputNum label="Word size (-n)" value={clusterWordSize} step={1} onChange={setClusterWordSize} />
                  <button
                    className="bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-lg text-sm h-10"
                    disabled={job.loading}
                    onClick={() => runAction(`运行 CD-HIT ${Math.round(clusterIdentity * 100)}%`, runClusteringStep, 'clustering')}
                  >
                    运行聚类
                  </button>
                  <button
                    className="bg-slate-100 hover:bg-slate-200 text-slate-800 px-4 py-2 rounded-lg text-sm h-10 border border-slate-300"
                    disabled={job.loading}
                    onClick={() => runAction('跳过 Clustering', skipClusteringStep, 'clustering', 0, '6. Clustering 已跳过，未执行任何比对')}
                  >
                    跳过聚类，进入 Similarity
                  </button>
                </div>
                <div className="text-xs text-slate-500">
                  第6步只负责 CD-HIT；若跳过，不会触发任何比对。序列比对仅在 Similarity 页点击“计算序列相似性”后执行。
                </div>
                {clusteringRunInfo && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-3 text-sm text-emerald-950">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <h2 className="text-base font-semibold text-emerald-900">聚类结果</h2>
                      <span className="text-xs text-emerald-700">
                        Identity {Math.round(clusterIdentity * 100)}% · Word Size {clusterWordSize}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                        <div className="text-xs text-emerald-700">输入序列</div>
                        <div className="text-xl font-semibold">{clusteringRunInfo.inputCount}</div>
                      </div>
                      <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                        <div className="text-xs text-emerald-700">去重后保留</div>
                        <div className="text-xl font-semibold">{clusteringRunInfo.outputCount}</div>
                      </div>
                      <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                        <div className="text-xs text-emerald-700">去重掉</div>
                        <div className="text-xl font-semibold">{clusteringRunInfo.deduplicatedCount}</div>
                      </div>
                      <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                        <div className="text-xs text-emerald-700">聚类数</div>
                        <div className="text-xl font-semibold">{clusteringRunInfo.clusters}</div>
                      </div>
                    </div>
                    <div className="text-xs text-emerald-800 space-y-1 break-all">
                      <div>输入: {clusteringRunInfo.inputFasta}</div>
                      <div>输出 FASTA: {clusteringRunInfo.outputFasta}</div>
                      <div>Cluster 文件: {clusteringRunInfo.clusterFile}</div>
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
                    <label className="block text-xs text-slate-500 mb-1">Candidate FASTA 路径（留空=后端自动选择）</label>
                    <input
                      className="w-full p-2 border rounded text-sm"
                      value={networkSourceFasta}
                      onChange={(e) => setNetworkSourceFasta(e.target.value)}
                      placeholder="例如: /path/to/scored_passed.fasta"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs text-slate-500 mb-1">Reference FASTA 路径（留空=后端默认参考）</label>
                    <input
                      className="w-full p-2 border rounded text-sm"
                      value={networkReferenceFasta}
                      onChange={(e) => setNetworkReferenceFasta(e.target.value)}
                      placeholder="例如: /path/to/ref.fasta"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">相似性算法</label>
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
                    参考序列与候选序列计算相似性连边
                  </label>
                  <div className="md:col-span-2 flex flex-wrap gap-2">
                    <button
                      className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm"
                      disabled={job.loading}
                      onClick={() => void confirmAndRunComputeSimilarity()}
                    >
                      计算序列相似性
                    </button>
                    <button
                      className="bg-slate-100 hover:bg-slate-200 text-slate-800 px-4 py-2 rounded-lg text-sm border border-slate-300"
                      disabled={job.loading}
                      onClick={() =>
                        runAction('读取网络数据', async () => {
                          const data = await loadNetworkData();
                          setNetworkStats({
                            nodes: Number.isFinite(Number(data.nodeTotal)) ? Number(data.nodeTotal) : data.nodes.length,
                            edges: Number.isFinite(Number(data.edgeTotal)) ? Number(data.edgeTotal) : data.edges.length,
                          });
                        })
                      }
                    >
                      读取 nodes.csv / edges_similarity.csv
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
                        🧪 序列比对进行中
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
                          <span>参考序列 vs 候选序列</span>
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
                          <span>候选序列两两比对</span>
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
                  <div className="text-slate-600">当前网络规模：</div>
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
                    <span className="text-base font-semibold text-slate-800">网络可视化</span>
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
                        title="浏览器图加载阈值"
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
                        加载网络
                      </button>
                    </div>
                  </div>
                  <div className="text-sm text-slate-500">
                    Nodes: <b className="text-slate-700">{networkStats.nodes}</b> · Edges: <b className="text-slate-700">{networkStats.edges}</b>
                  </div>
                  <div className="text-xs text-slate-500">
                    上面的数字是加载阈值。点“加载网络”后，图内滑块只能在本次已加载边集的范围内调整。
                  </div>
                  {browserGraphThresholdAdjusted && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      浏览器图已自动将加载阈值提高到 {browserGraphLoadedThreshold}，以避免边数超过 {browserGraphMaxEdges} 导致页面卡死或白屏。
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
                        🧪 序列比对进行中
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
                          <span>参考连边比对</span>
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
                          <span>候选两两比对</span>
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
                    推送到 Cytoscape Desktop（可选）
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
                      <label className="block text-xs text-slate-500 mb-1">着色分类列</label>
                      <select className="w-full p-2 border rounded text-sm" value={cytoCategoryColumn} onChange={(e) => setCytoCategoryColumn(e.target.value)}>
                        <option value="phylum">Phylum</option>
                        <option value="class">Class</option>
                        <option value="kingdom">Kingdom</option>
                        <option value="species">Species</option>
                        <option value="cluster">Cluster</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">Pairwise 阈值（%）</label>
                      <input type="number" min={0} max={100} step={1} className="w-full p-2 border rounded text-sm" value={networkPairwiseThresholdPct} onChange={(e) => setNetworkPairwiseThresholdPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      <input type="checkbox" checked={cytoApplyStyle} onChange={(e) => setCytoApplyStyle(e.target.checked)} />
                      自动应用样式（按所选分类列上色，按 weight 映射边宽）
                    </label>
                    <div className="md:col-span-2 flex flex-wrap gap-2">
                      <button
                        className="bg-emerald-700 hover:bg-emerald-800 text-white px-4 py-2 rounded-lg text-sm"
                        disabled={job.loading}
                        onClick={() => runAction(`按阈值推送到 Cytoscape（${networkPairwiseThresholdPct}%）`, () => runPushToCytoscape(), 'network-push')}
                      >
                        按阈值推送到 Cytoscape
                      </button>
                    </div>
                    {cytoPushInfo && (
                      <div className="md:col-span-2 bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-900">
                        已推送到 {cytoPushInfo.baseUrl}，networkSUID: <b>{String(cytoPushInfo.networkSuid ?? 'unknown')}</b>；
                        节点 {cytoPushInfo.pushedNodes}，边 {cytoPushInfo.pushedEdges}。
                        {cytoPushInfo.generated ? '（本次自动生成了网络 CSV）' : ''}
                        {cytoPushInfo.styleApplied ? ` 样式已应用：${cytoPushInfo.styleName}${cytoPushInfo.categoryColumn ? `（分组列 ${cytoPushInfo.categoryColumn}）` : ''}` : ''}
                        {cytoPushInfo.styleApplied && cytoPushInfo.categoryColumn && cytoPushInfo.categoryColumn !== cytoCategoryColumn
                          ? <span className="text-amber-700 font-medium"> ⚠ 所选「{cytoCategoryColumn}」列无数据，已回退到「{cytoPushInfo.categoryColumn}」</span>
                          : null}
                        {!cytoPushInfo.styleApplied && cytoPushInfo.styleError ? ` 样式未应用：${cytoPushInfo.styleError}` : ''}
                        {cytoPushInfo.layoutApplied ? ` 布局已应用：${cytoPushInfo.layout}` : ''}
                        {!cytoPushInfo.layoutApplied && cytoPushInfo.layoutError ? ` 布局未应用：${cytoPushInfo.layoutError}` : ''}
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
                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                  <p className="text-sm text-slate-600">
                    综合相似度、分类学多样性和 cluster 大小，对候选序列进行多维评分排序。孤立点（cluster 仅含 1 条序列）默认排除。
                  </p>
                  <details className="text-xs text-slate-400">
                    <summary className="cursor-pointer select-none">参数说明</summary>
                    <ul className="mt-1 ml-4 list-disc space-y-0.5">
                      <li><b>最小 Cluster 大小</b>：cluster 中序列数量必须 ≥ 此值，否则排除。设为 2 即过滤孤立点。</li>
                      <li><b>Avg Ref Similarity 权重</b>：候选与所有参考序列平均相似度的评分权重。</li>
                      <li><b>Max Ref Similarity 权重</b>：候选与最相似参考序列之间相似度的评分权重。</li>
                      <li><b>Cluster Size 权重</b>：候选所在 cluster 越大得分越高，归一化后乘以此权重。</li>
                      <li><b>Taxonomy Diversity 权重</b>：候选所在 cluster 的分类学多样性（纲的数量）评分权重。</li>
                      <li><b>随机性 (Temperature)</b>：0 = 确定性选取（同参数同结果），&gt;0 时在每个 cluster 内按温度采样，值越大结果越随机。</li>
                    </ul>
                  </details>
                  <details className="text-xs text-slate-400 mt-1">
                    <summary className="cursor-pointer select-none">评分算法说明</summary>
                    <div className="mt-1 ml-2 space-y-1">
                      <p><b>评分公式</b>：Score = w₁·avgRefSim + w₂·maxRefSim + w₃·clusterSizeNorm + w₄·taxDiv</p>
                      <ul className="ml-4 list-disc space-y-0.5">
                        <li><b>avgRefSim</b>：候选与所有有边连接的参考序列的平均相似度 ÷ 100，范围 [0, 1]</li>
                        <li><b>maxRefSim</b>：候选与最相似参考序列的相似度 ÷ 100，范围 [0, 1]</li>
                        <li><b>clusterSizeNorm</b>：候选所在 cluster 大小 ÷ 最大 cluster 大小，范围 [0, 1]</li>
                        <li><b>taxDiv</b>：候选所在 cluster 中 class 种类数 ÷ 最大 class 种类数，范围 [0, 1]</li>
                      </ul>
                      <p><b>Cluster 来源</b>：cd-hit 按序列相似度阈值聚类的结果。同一 cluster 内的序列彼此高度相似。</p>
                      <p><b>相似度数据来源</b>：edges_similarity.csv 中候选与参考节点（is_reference=1）之间的边。</p>
                      <p><b>多样性选取</b>：支持两种策略——「按比例分配」按 cluster 大小分配名额（大 cluster 取更多），「均匀轮询」各 cluster 均匀轮流选取。</p>
                      <p><b>随机性</b>：Temperature=0 时完全确定，&gt;0 时在 cluster 轮询中使用 softmax 温度采样：P(i) = exp(score_i/T) / Σexp(score_j/T)，T 越大越随机。</p>
                    </div>
                  </details>
                  <div className="grid grid-cols-5 gap-3 text-sm">
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">最小 Cluster 大小</label>
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
                      <label className="block text-xs text-slate-500 mb-1">选取策略</label>
                      <select className="w-full p-2 border rounded text-sm"
                        value={recommendDiversityMode}
                        onChange={(e) => setRecommendDiversityMode(e.target.value as 'proportional' | 'round-robin')}>
                        <option value="proportional">按比例分配</option>
                        <option value="round-robin">均匀轮询</option>
                      </select>
                    </div>
                    <div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">阈值: {recommendNetworkConnectivityThreshold}%</label>
                      <input type="range" min={0} max={100} step={1} className="w-full accent-indigo-500 cursor-pointer" draggable={false}
                        style={{ touchAction: 'none' }}
                        value={recommendNetworkConnectivityThreshold}
                        onChange={(e) => setRecommendNetworkConnectivityThreshold(Number(e.target.value))} />
                    </div>
                      <label className="block text-xs text-slate-500 mb-1">随机性 (Temperature): {recommendTemperature.toFixed(2)}</label>
                      <input type="range" min={0} max={1} step={0.05} className="w-full accent-indigo-500 cursor-pointer" draggable={false}
                        style={{ touchAction: 'none' }}
                        value={recommendTemperature}
                        onChange={(e) => setRecommendTemperature(Number(e.target.value))} />
                    </div>
                  </div>
                  <WeightBar weights={recommendWeights} onChange={setRecommendWeights} />
                  <div className="flex items-center gap-3">
                    <button className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg text-sm"
                      disabled={job.loading}
                      onClick={() => runAction('候选推荐评分', runRecommendation, 'recommendation')}>
                      计算推荐
                    </button>
                  </div>
                </div>
                {recommendMeta && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm space-y-1">
                    <div>候选 {recommendMeta.totalCandidates} 条，参考 {recommendMeta.totalReferences} 条，展示前 {recommendResults.length} 条</div>
                    {(recommendMeta.filteredByClusterSize > 0 || recommendMeta.filteredBySimilarity > 0) && (
                      <div className="text-slate-500">
                        已过滤：cluster 大小不足 {recommendMeta.filteredByClusterSize} 条
                        {recommendMeta.filteredBySimilarity > 0 && `，相似度不足 ${recommendMeta.filteredBySimilarity} 条`}
                      </div>
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
                        } catch (err: any) { alert('导出失败: ' + (err?.message || err)); }
                      }}>
                      导出 FASTA（{recommendResults.length} 条）
                    </button>
                    <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm"
                      onClick={highlightRecommendationsInNetwork}>
                      在网络中高亮
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
            <div className="text-base font-semibold text-slate-900">检测到已有相似性结果</div>
            <div className="text-sm text-slate-600 leading-6">
              当前任务已存在相似性文件：
              <div>nodes: {similarityConfirmState.nodeTotal}</div>
              <div>edges: {similarityConfirmState.edgeTotal}</div>
              <div className="mt-2">是否重新计算并覆盖这些结果？</div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                className="px-3 py-1.5 rounded border border-slate-300 text-slate-700 text-sm hover:bg-slate-50"
                onClick={cancelSimilarityRecompute}
              >
                取消
              </button>
              <button
                className="px-3 py-1.5 rounded bg-indigo-600 text-white text-sm hover:bg-indigo-700"
                onClick={startSimilarityRecomputeFromModal}
              >
                重新计算
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
        <div className="text-sm font-medium text-slate-700">Pipeline 进度（BLAST）</div>
        <div className="text-xs text-slate-500">{doneCount}/{total} 已完成</div>
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
                {status === 'success' && '完成'}
                {status === 'error' && '失败'}
                {status === 'running' && '运行中...'}
                {status === 'idle' && '未开始'}
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
  const [recommendWeights, setRecommendWeights] = useState<RecommendWeights>({ avgRefSimilarity: 0.35, maxRefSimilarity: 0.25, clusterSize: 0.15, networkComponentSize: 0.15, taxonomyDiversity: 0.1 });
  const [recommendNetworkConnectivityThreshold, setRecommendNetworkConnectivityThreshold] = useState<number>(85);
  const [recommendTopN, setRecommendTopN] = useState(50);
  const [recommendMinClusterSize, setRecommendMinClusterSize] = useState(2);
  const [recommendMinSimilarity, setRecommendMinSimilarity] = useState(0);
  const [recommendTemperature, setRecommendTemperature] = useState(0);
  const [recommendDiversityMode, setRecommendDiversityMode] = useState<'proportional' | 'round-robin'>('proportional');
  const [recommendMeta, setRecommendMeta] = useState<{ totalCandidates: number; totalReferences: number; filteredByClusterSize: number; filteredBySimilarity: number } | null>(null);

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
    setJob({ loading: true, message: `加载任务进度: ${selectedTaskId}`, error: '' });
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

        setJob({ loading: false, message: `已载入任务进度: ${selectedTaskId}`, error: '' });
        if (staleRecommendCache) {
          setCompletionToast('检测到旧版推荐缓存已失效，请重新计算推荐');
        }
      } catch (err) {
        if (!cancelled) setJob({ loading: false, message: '', error: `载入任务进度失败: ${String(err)}` });
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
          if (attempt > 0) setJob({ loading: true, message: `${label} 重试中 (${attempt}/${totalRetries})`, error: '' });
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
      setJob({ loading: false, message: `${label} 完成`, error: '' });
      if (step) {
        setStepState((prev) => ({ ...prev, [step]: 'success' }));
        setActiveStep(null);
        setLastCompletedStep(step);
      }
      const stepTitle = step ? (blastPipelineSteps.find((x) => x.key === step)?.title || label) : label;
      setCompletionToast(customToast || `${stepTitle} 完成`);
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
    if (!list.length) throw new Error('请输入至少一个 accession');
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
    setReferenceImportNotice(`已从文件 ${uploadFile.name} 导入 ${data.rows} 条参考序列`);
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
    const data = await recommendCandidates({ weights: normalizeRecommendWeights(recommendWeights), topN: recommendTopN, minClusterSize: recommendMinClusterSize, minSimilarity: recommendMinSimilarity, temperature: recommendTemperature, diversityMode: recommendDiversityMode, networkConnectivityThreshold: recommendNetworkConnectivityThreshold });
    setRecommendResults(data.candidates);
    setRecommendMeta({ totalCandidates: data.totalCandidates, totalReferences: data.totalReferences, filteredByClusterSize: data.filteredByClusterSize, filteredBySimilarity: data.filteredBySimilarity });
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
      setCompletionToast(`已在网络中高亮 ${recommendResults.length} 条推荐序列，请返回 Similarity Network 查看`);
    } catch (err: any) {
      alert('高亮失败: ' + (err?.message || err));
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
    if (selectedTaskId === 'blast-default') throw new Error('默认任务不可删除');
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
          <div className="text-sm font-medium text-slate-700">重试策略</div>
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
              <label className="block text-xs text-slate-500 mb-1">重试间隔(ms)</label>
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
          <button onClick={onBack} className="flex items-center gap-2 text-emerald-600 hover:text-emerald-800 transition-colors" title="返回主页">
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
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8 shadow-sm z-10">
          <div className="flex items-center text-sm text-slate-500">
            <span>BLAST Pipeline</span>
            <ChevronRight className="w-4 h-4 mx-1" />
            <span className="font-medium text-slate-900 capitalize">{currentView.replace(/-/g, ' ')}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">任务</span>
              <select className="p-1.5 border border-slate-300 rounded text-xs bg-white" value={selectedTaskId}
                onChange={(e) => setSelectedTaskId(e.target.value)} disabled={job.loading}>
                {taskList.map((t) => (<option key={t.id} value={t.id}>{t.id}</option>))}
              </select>
              <input className="p-1.5 border border-slate-300 rounded text-xs w-32" value={newTaskId}
                onChange={(e) => setNewTaskId(e.target.value)} placeholder="新任务ID(可选)" disabled={job.loading} />
              <button className="px-2 py-1.5 rounded bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
                onClick={() => runAction('新建任务', createTaskAndSwitch)} disabled={job.loading}>新建</button>
              <button className="px-2 py-1.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50"
                onClick={() => runAction('复制任务', duplicateSelectedTask)} disabled={job.loading}>复制</button>
              <button className="px-2 py-1.5 rounded bg-red-600 text-white text-xs hover:bg-red-700 disabled:opacity-50"
                onClick={() => runAction('删除任务', deleteSelectedTask)} disabled={job.loading || selectedTaskId === 'blast-default'}>删除</button>

            </div>
            <button className="p-2 rounded-lg hover:bg-slate-100" onClick={() => setDarkMode((v) => !v)}
              title={darkMode ? '浅色模式' : '深色模式'}>
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
              <h1 className="text-2xl font-semibold">BLAST 酶挖掘工作流</h1>
              <p className="text-sm text-slate-500">适用于参考序列较少（1-5条）的情况，基于 BLAST pairwise 搜索蛋白质数据库。</p>
              <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                onClick={() => runAction('检查后端状态', async () => { const data = await healthCheck(); setHealth(data); })}>
                检查后端健康状态
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
                  <div className="text-sm font-semibold text-slate-700">两种加载参考序列的方法</div>
                  <div className="mt-1 text-sm text-slate-500">
                    任选一种即可生成当前任务的 ref.csv 和 ref.fasta。只有 accession 时用方式 A；已有 FASTA 文件时直接用方式 B。
                  </div>
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <section className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <span className="rounded-full bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white">方式 A</span>
                      <div>
                        <div className="text-sm font-semibold text-slate-800">按 accession 在线拉取</div>
                        <div className="text-xs text-slate-500">适合只有 accession、protein_id 或 UniProt ID 的情况</div>
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-slate-700">Entrez Email</label>
                      <input className="w-full rounded-lg border border-slate-200 bg-white p-2 text-sm" value={entrezEmail} onChange={(e) => setEntrezEmail(e.target.value)} />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-slate-700">Accession List</label>
                      <p className="mb-2 text-xs text-slate-500 leading-relaxed">
                        支持 <strong>NCBI Protein</strong>、<strong>NCBI Nucleotide</strong>、<strong>UniProt</strong> 混合输入，系统会自动识别来源并拉取参考序列。
                      </p>
                      <textarea className="h-56 w-full rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs placeholder:text-slate-400"
                        value={accessions} onChange={(e) => setAccessions(e.target.value)} placeholder={accessionPlaceholder} />
                    </div>
                    <button className="w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700" disabled={job.loading}
                      onClick={() => runAction('下载参考序列', runReferenceStep, 'reference')}>
                      在线拉取并生成 ref.csv / ref.fasta
                    </button>
                  </section>
                  <section className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <span className="rounded-full bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white">方式 B</span>
                      <div>
                        <div className="text-sm font-semibold text-slate-800">上传本地 FASTA 文件</div>
                        <div className="text-xs text-slate-500">适合你已经有参考序列文件，希望直接进入后续 BLAST 流程</div>
                      </div>
                    </div>
                    <div className="rounded-xl border border-sky-200 bg-white/80 px-3 py-2 text-xs text-slate-500">
                      支持 .fasta、.fa、.faa、.fas、.fna、.txt，单文件限制 20 MB。导入后会直接覆盖当前任务的参考集。
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
                        ? `已选择文件：${referenceUploadFile.name} · ${formatFileSize(referenceUploadFile.size)}`
                        : '尚未选择文件。请选择一个本地 FASTA 文件后再导入。'}
                    </div>
                    <button
                      className="w-full rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
                      disabled={job.loading || !referenceUploadFile}
                      onClick={() => runAction('上传参考 FASTA', runReferenceUploadStep, 'reference')}
                    >
                      上传导入并生成 ref.csv / ref.fasta
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
                    onClick={() => runAction('计算 Pairwise Identity', runRefPairwiseIdentity, 'reference')}>
                    计算参考序列 Pairwise Identity
                  </button>
                  <IdentityHeatmap ids={refIdentityIds} matrix={refIdentityMatrix} title="参考序列 Pairwise Identity 热图" />
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
                  <label className="block text-sm font-medium mb-1">数据库来源</label>
                  <select className="w-full p-2 border rounded text-sm" value={blastDbSource}
                    onChange={(e) => setBlastDbSource(e.target.value as BlastDbSource)}>
                    <option value="local">本地 FASTA → makeblastdb</option>
                    <option value="ncbi-remote">NCBI 远程数据库</option>
                  </select>
                </div>

                {blastDbSource === 'local' && (
                  <div>
                    <label className="block text-sm font-medium mb-1">目标蛋白质组 FASTA 路径</label>
                    <input className="w-full p-2 border rounded text-sm font-mono" value={blastTargetFasta}
                      onChange={(e) => setBlastTargetFasta(e.target.value)} placeholder="例如: /path/to/proteomes.fasta" />
                    <p className="text-xs text-slate-500 mt-1">本地蛋白质序列集合，将用 makeblastdb 构建为 BLAST 数据库</p>
                  </div>
                )}

                {blastDbSource === 'ncbi-remote' && (
                  <div>
                    <label className="block text-sm font-medium mb-1">NCBI 数据库</label>
                    <select className="w-full p-2 border rounded text-sm" value={blastNcbiDb}
                      onChange={(e) => setBlastNcbiDb(e.target.value)}>
                      <option value="nr">nr（Non-redundant protein）</option>
                      <option value="swissprot">SwissProt</option>
                      <option value="refseq_protein">RefSeq Protein</option>
                      <option value="pdb">PDB</option>
                    </select>
                    <p className="text-xs text-slate-500 mt-1">使用 blastp -remote 直接搜索 NCBI 远程数据库（较慢但无需本地数据）</p>
                  </div>
                )}

                <div className="border-t pt-3">
                  <div className="flex items-center gap-3 mb-2">
                    <input type="checkbox" checked={blastDeduplicateRefs} onChange={(e) => setBlastDeduplicateRefs(e.target.checked)}
                      className="accent-emerald-600" />
                    <label className="text-sm text-slate-700">对参考序列做 CD-HIT 去冗余</label>
                  </div>
                  {blastDeduplicateRefs && (
                    <div className="ml-6">
                      <label className="block text-xs text-slate-500 mb-1">去冗余 Identity 阈值</label>
                      <input type="number" step={0.01} min={0.5} max={1} value={blastDeduplicateIdentity}
                        onChange={(e) => setBlastDeduplicateIdentity(Number(e.target.value))}
                        className="p-2 border rounded text-sm w-32" />
                    </div>
                  )}
                </div>

                <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                  onClick={() => runAction('构建 BLAST 数据库', runBlastDbSetup, 'blast-db')}>
                  {blastDbSource === 'local' ? '构建本地 BLAST 数据库' : '配置远程 NCBI BLAST'}
                </button>
              </div>

              {blastDbInfo && (
                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 text-sm">
                  <div className="font-medium text-slate-700">数据库构建结果</div>
                  <div>数据库来源: <span className="font-mono">{blastDbInfo.dbSource}</span></div>
                  {blastDbInfo.dbPath && <div>数据库路径: <span className="font-mono text-xs">{blastDbInfo.dbPath}</span></div>}
                  <div>参考序列: {blastDbInfo.refInputCount} 条 → 去冗余后 {blastDbInfo.refDedupCount} 条</div>
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
                <div className="text-sm font-medium text-slate-700">搜索参数</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">E-value 阈值</label>
                    <input type="text" value={blastEvalue} onChange={(e) => setBlastEvalue(Number(e.target.value) || 1e-10)}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">最低 Identity (%)</label>
                    <input type="number" value={blastIdentityMin} onChange={(e) => setBlastIdentityMin(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">最低 Query Coverage (%)</label>
                    <input type="number" value={blastQueryCovMin} onChange={(e) => setBlastQueryCovMin(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Max Target Seqs</label>
                    <input type="number" value={blastMaxTargetSeqs} onChange={(e) => setBlastMaxTargetSeqs(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Subject 最短长度</label>
                    <input type="number" value={blastSubjectLenMin} onChange={(e) => setBlastSubjectLenMin(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Subject 最长长度</label>
                    <input type="number" value={blastSubjectLenMax} onChange={(e) => setBlastSubjectLenMax(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">替换矩阵</label>
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
                    <label className="block text-xs text-slate-500 mb-1">合并策略</label>
                    <select className="w-full p-2 border rounded text-sm" value={blastMergeStrategy}
                      onChange={(e) => setBlastMergeStrategy(e.target.value as BlastMergeStrategy)}>
                      <option value="best-evalue">Best E-value（每个 subject 保留最优）</option>
                      <option value="union">Union（保留所有 query 的最优匹配）</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                    onClick={() => runAction('运行 BLAST 搜索', runBlastSearchStep, 'blast-search')}>
                    运行 BLAST 搜索
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
                        BLAST 搜索进度
                      </div>
                      <div className="text-xs text-slate-500">
                        {bp.current}/{bp.total} 序列
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
                        <span className="text-slate-600">正在搜索:</span>
                        <span className="font-mono text-xs text-slate-800">{bp.queryId}</span>
                        <span className="text-slate-400">({bp.current + 1}/{bp.total})</span>
                      </div>
                    )}

                    {/* ETA */}
                    {bp.estimatedRemainingMs !== null && bp.estimatedRemainingMs > 0 && (
                      <div className="text-xs text-slate-500">
                        预计剩余时间: <span className="font-medium text-slate-700">{formatTime(bp.estimatedRemainingMs)}</span>
                      </div>
                    )}

                    {/* Per-query timings table */}
                    {timings.length > 0 && (
                      <div className="border-t pt-2">
                        <div className="text-xs font-medium text-slate-500 mb-1.5">各序列搜索耗时</div>
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
                  <div className="font-medium text-slate-700">搜索结果概览</div>
                  <div>使用 query 数: {blastSearchStats.queriesUsed}</div>
                  <div>原始命中数: {blastSearchStats.totalHits}</div>
                  <div>去重后 unique subjects: {blastSearchStats.uniqueSubjects}</div>
                </div>
              )}

              {/* Filter section */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
                <div className="text-sm font-medium text-slate-700">过滤参数</div>
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
                    <label className="block text-xs text-slate-500 mb-1">Subject 最短</label>
                    <input type="number" value={blastFilterSubjectLenMin} onChange={(e) => setBlastFilterSubjectLenMin(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Subject 最长</label>
                    <input type="number" value={blastFilterSubjectLenMax} onChange={(e) => setBlastFilterSubjectLenMax(Number(e.target.value))}
                      className="w-full p-2 border rounded text-sm" />
                  </div>
                </div>
                <button className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                  onClick={() => runAction('过滤 BLAST 命中', runBlastFilterStep, 'blast-search')}>
                  过滤 hits
                </button>
                {blastFilterStats && (
                  <div className="text-sm text-slate-600">
                    {blastFilterStats.total} 条 → 保留 {blastFilterStats.kept} 条
                  </div>
                )}
              </div>

              {/* NCBI Taxonomy Annotation */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="text-sm font-medium text-slate-700">NCBI 分类注释</div>
                <p className="text-xs text-slate-500">
                  查询 NCBI Entrez 获取 BLAST 命中序列的分类学信息（kingdom / phylum / class / species），用于后续 Cytoscape 网络节点着色。
                </p>
                <button
                  className="bg-violet-600 hover:bg-violet-700 text-white px-4 py-2 rounded-lg text-sm"
                  disabled={job.loading}
                  onClick={() => runAction('注释 BLAST 命中', async () => {
                    await annotateBlastHits();
                    // Refresh hits table after annotation
                    const data = await loadBlastSearchPage(1, blastSearchPageSize, blastSearchSource);
                    setBlastSearchPage(1);
                    setBlastSearchTotalPages(data.totalPages);
                    if (blastSearchSource === 'blast_hits_filtered') setBlastFilteredRows(data.preview?.rows || []);
                    else setBlastHitsRows(data.preview?.rows || []);
                  }, 'blast-search')}
                >
                  查询 NCBI 分类信息
                </button>
                {/* Annotation progress */}
                {runtimeMeta && typeof (runtimeMeta as any).blastAnnotateProgress === 'number' && runtimeTask === 'blast/annotate' && job.loading && (() => {
                  const pct = (runtimeMeta as any).blastAnnotateProgress as number;
                  const phase = (runtimeMeta as any).blastAnnotatePhase as string || '';
                  return (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <span>{phase === 'fetching' ? '正在从 NCBI 获取分类信息...' : phase === 'done' ? '完成' : '处理中...'}</span>
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
                    <option value="blast_hits_all">全部命中</option>
                    <option value="blast_hits_filtered">过滤后</option>
                  </select>
                  <div className="flex gap-2">
                    <button className="px-2 py-1 border rounded text-xs disabled:opacity-50" disabled={blastSearchPage <= 1 || job.loading}
                      onClick={() => runAction('加载上一页', async () => {
                        const prev = Math.max(1, blastSearchPage - 1);
                        const data = await loadBlastSearchPage(prev, blastSearchPageSize, blastSearchSource);
                        setBlastSearchPage(prev);
                        setBlastSearchTotalPages(data.totalPages);
                        if (blastSearchSource === 'blast_hits_filtered') setBlastFilteredRows(data.preview?.rows || []);
                        else setBlastHitsRows(data.preview?.rows || []);
                      })}>上一页</button>
                    <span className="text-xs text-slate-500 py-1">{blastSearchPage}/{blastSearchTotalPages}</span>
                    <button className="px-2 py-1 border rounded text-xs disabled:opacity-50" disabled={blastSearchPage >= blastSearchTotalPages || job.loading}
                      onClick={() => runAction('加载下一页', async () => {
                        const next = Math.min(blastSearchTotalPages, blastSearchPage + 1);
                        const data = await loadBlastSearchPage(next, blastSearchPageSize, blastSearchSource);
                        setBlastSearchPage(next);
                        setBlastSearchTotalPages(data.totalPages);
                        if (blastSearchSource === 'blast_hits_filtered') setBlastFilteredRows(data.preview?.rows || []);
                        else setBlastHitsRows(data.preview?.rows || []);
                      })}>下一页</button>
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
                  <label className="block text-xs text-slate-500 mb-1">筛选 FASTA（留空=后端默认）</label>
                  <input className="w-full p-2 border rounded text-sm" value={candidateFasta} onChange={(e) => setCandidateFasta(e.target.value)} placeholder="例如: /path/to/hits_filtered.fasta" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">参考 FASTA（留空=后端默认）</label>
                  <input className="w-full p-2 border rounded text-sm" value={referenceFastaPath} onChange={(e) => setReferenceFastaPath(e.target.value)} placeholder="例如: /path/to/ref.fasta" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">参考序列 ID</label>
                  <input className="w-full p-2 border rounded text-sm" value={refId} onChange={(e) => setRefId(e.target.value)} placeholder="留空=自动使用参考序列第一条" />
                </div>
                <button
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm h-10"
                  disabled={job.loading}
                  onClick={() => runAction('生成对齐文件', runAlignmentStep, 'alignment')}
                >
                  生成对齐并载入预览
                </button>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
                  <InputNum label="列起点" value={alignmentPreviewStart} step={10} onChange={(v) => setAlignmentPreviewStart(Math.max(1, Math.floor(v)))} />
                  <InputNum label="列终点" value={alignmentPreviewEnd} step={10} onChange={(v) => setAlignmentPreviewEnd(Math.max(1, Math.floor(v)))} />
                  <div className="text-xs text-slate-600 md:col-span-2">
                    对齐文件: {alignmentPath || '(暂无)'}
                  </div>
                  <button
                    className="px-3 py-2 rounded border border-slate-300 text-sm"
                    disabled={job.loading || !alignmentPath}
                    onClick={() => runAction('刷新对齐预览', async () => {
                      await loadAlignmentPreviewPage(0);
                    })}
                  >
                    刷新预览
                  </button>
                  <div className="text-xs text-slate-600">
                    rows: {alignmentPreviewRows.length}/{alignmentPreviewTotalRecords} | alnLen: {alignmentPreviewLength}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
                    disabled={job.loading || alignmentPreviewOffset <= 0 || !alignmentPath}
                    onClick={() => runAction('对齐预览上一页', async () => {
                      await loadAlignmentPreviewPage(Math.max(0, alignmentPreviewOffset - alignmentPreviewLimit));
                    })}
                  >
                    上一页
                  </button>
                  <button
                    className="px-3 py-1.5 rounded border border-slate-300 text-sm disabled:opacity-50"
                    disabled={job.loading || alignmentPreviewOffset + alignmentPreviewLimit >= alignmentPreviewTotalRecords || !alignmentPath}
                    onClick={() => runAction('对齐预览下一页', async () => {
                      await loadAlignmentPreviewPage(alignmentPreviewOffset + alignmentPreviewLimit);
                    })}
                  >
                    下一页
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
                        <th className="px-2 py-2 text-left">对齐片段（交互窗口）</th>
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
                <div className="font-semibold text-slate-900">当前运行状态</div>
                <div className="text-xs text-slate-600">
                  最近一次对齐文件：{(scoringRunInfo?.alignmentUsed || alignmentPath || '(暂无)')}
                </div>
                <div className="text-xs text-slate-600">
                  当前位点模式：
                  {scoringPositionMode === 'pre' ? '对齐前残基编号' : '对齐后列号'}
                  {scoringPositionMode === 'pre'
                    ? (preAlignmentAnchor === 'first' ? '（默认跟随第一条序列）' : `（按参考ID锚定: ${refId || '(空)'})`)
                    : ''}
                </div>
                {scoringRunInfo && (
                  <div className="text-xs text-slate-600">
                    最近一次打分：{scoringRunInfo.passed}/{scoringRunInfo.total} 通过阈值
                  </div>
                )}
                {scoringRunInfo?.passedFasta && (
                  <div className="text-xs text-slate-600">
                    阈值筛选模块：已导出通过序列 FASTA ({scoringRunInfo.passedCount || 0} 条) → 路径 {scoringRunInfo.passedFasta}
                  </div>
                )}
                {alignmentPrepInfo && (
                  <div className="text-xs text-slate-600">
                    最近一次仅对齐：records={alignmentPrepInfo.records} | {alignmentPrepInfo.alignment}
                  </div>
                )}
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Alignment 路径（留空=后端默认）</label>
                  <input className="w-full p-2 border rounded text-sm" value={alignmentPath} onChange={(e) => setAlignmentPath(e.target.value)} placeholder="例如: /path/to/alignment.fasta" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">参考序列 ID</label>
                  <input className="w-full p-2 border rounded text-sm" value={refId} onChange={(e) => setRefId(e.target.value)} placeholder="留空=自动使用参考序列第一条" />
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">位点坐标模式</label>
                  <select
                    className="w-full p-2 border rounded text-sm"
                    value={scoringPositionMode}
                    onChange={(e) => setScoringPositionMode((e.target.value === 'aligned' ? 'aligned' : 'pre'))}
                  >
                    <option value="pre">对齐前（残基编号）</option>
                    <option value="aligned">对齐后（MSA 列号）</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-700 pb-2">
                  <input
                    type="checkbox"
                    checked={preAlignmentAnchor === 'refid'}
                    disabled={scoringPositionMode !== 'pre'}
                    onChange={(e) => setPreAlignmentAnchor(e.target.checked ? 'refid' : 'first')}
                  />
                  对齐前模式使用参考ID锚定（关闭=默认第一条序列）
                </label>
                <div className="text-xs text-slate-500 pb-2">
                  对齐前: 按锚序列残基编号自动映射到 MSA 列；对齐后: 直接把 pos 当列号。
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-sm text-slate-700">打分规则（可直接编辑）</div>
                  <div className="text-xs text-slate-500">当前规则数: {scoringRules.length}</div>
                </div>

                <div className="overflow-auto border rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b">
                      <tr>
                        <th className="px-2 py-2 text-left">Pos</th>
                        <th className="px-2 py-2 text-left">Allowed (comma separated)</th>
                        <th className="px-2 py-2 text-left">Score</th>
                        <th className="px-2 py-2 text-left">Label</th>
                        <th className="px-2 py-2 text-left">操作</th>
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
                              删除
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
                      setScoringRulesSuccess(`已应用 PeAAO 规则模板，共 ${peAaoScoringRules.length} 条`);
                    }}
                  >
                    应用 PeAAO 规则模板（覆盖）
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
                    新增规则
                  </button>
                  <button
                    className="px-3 py-1.5 rounded border border-slate-300 text-sm hover:bg-slate-50"
                    onClick={() => rulesImportRef.current?.click()}
                  >
                    导入规则 JSON
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
                    导出规则 JSON
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
                        setScoringRulesSuccess(`导入成功，规则数 ${parsed.length}`);
                      } catch (err) {
                        setScoringRulesError(`导入失败: ${String(err)}`);
                        setScoringRulesSuccess('');
                      } finally {
                        e.currentTarget.value = '';
                      }
                    }}
                  />
                  <div className="text-xs text-slate-500">支持导入/导出 JSON，字段为 pos / allowed / score / label；allowed 可含 "Uni"</div>
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
                      ? `规则校验未通过: ${scoringRulesError}`
                      : '执行打分（基于第4步 Alignment）'
                  }
                  onClick={() => runAction('执行活性位点打分', runScoringStep, 'scoring')}
                >
                  执行打分（基于第4步 Alignment）
                </button>

                <div className="pt-1 border-t border-slate-100">
                  <label className="flex items-center gap-2 text-sm text-slate-700 pb-2">
                    <input
                      type="checkbox"
                      checked={autoDownloadScoringCsv}
                      onChange={(e) => setAutoDownloadScoringCsv(e.target.checked)}
                    />
                    打分成功后自动下载完整 CSV
                  </label>
                  <InputNum label="Threshold（打分后设置）" value={threshold} step={0.1} onChange={setThreshold} />
                  <div className="text-xs text-slate-500 mt-1">建议先运行打分，再根据结果调整阈值并重跑统计。</div>
                  {thresholdPreview && (
                    <div className="mt-2 text-xs text-indigo-700 border border-indigo-200 bg-indigo-50 rounded p-2">
                      阈值预估（基于当前 scored_results.csv）：阈值 {thresholdPreview.threshold} 时通过 {thresholdPreview.passed}/{thresholdPreview.total}（{(thresholdPreview.ratio * 100).toFixed(1)}%）。
                      若要让聚类使用该阈值结果，请重跑一次打分。
                    </div>
                  )}
                </div>

                {Boolean(scoringRulesError) && (
                  <div className="text-xs text-amber-700 border border-amber-200 bg-amber-50 rounded p-2">
                    当前规则存在错误，已禁止运行打分。请先修正上方红色错误提示。
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
                <label className="block text-sm font-medium">输入 FASTA</label>
                <input className="w-full p-2 border rounded text-sm font-mono" value={candidateFasta}
                  onChange={(e) => setCandidateFasta(e.target.value)} placeholder="scored_passed.fasta" />
                <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                  onClick={() => runAction('运行聚类', runClusteringStep, 'clustering')}>
                  运行 CD-HIT 聚类
                </button>
              </div>
              {clusteringRunInfo && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 space-y-3 text-sm text-emerald-950">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <h2 className="text-base font-semibold text-emerald-900">聚类结果</h2>
                    <span className="text-xs text-emerald-700">
                      Identity {Math.round(clusterIdentity * 100)}% · Word Size {clusterWordSize}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                      <div className="text-xs text-emerald-700">输入序列</div>
                      <div className="text-xl font-semibold">{clusteringRunInfo.inputCount}</div>
                    </div>
                    <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                      <div className="text-xs text-emerald-700">去重后保留</div>
                      <div className="text-xl font-semibold">{clusteringRunInfo.outputCount}</div>
                    </div>
                    <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                      <div className="text-xs text-emerald-700">去重掉</div>
                      <div className="text-xl font-semibold">{clusteringRunInfo.deduplicatedCount}</div>
                    </div>
                    <div className="bg-white/70 rounded-lg border border-emerald-100 p-3">
                      <div className="text-xs text-emerald-700">聚类数</div>
                      <div className="text-xl font-semibold">{clusteringRunInfo.clusters}</div>
                    </div>
                  </div>
                  <div className="text-xs text-emerald-800 space-y-1">
                    <div>输入: {clusteringRunInfo.inputFasta}</div>
                    <div>输出 FASTA: {clusteringRunInfo.outputFasta}</div>
                    <div>Cluster 文件: {clusteringRunInfo.clusterFile}</div>
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
                    <label className="block text-sm font-medium mb-1">相似性方法</label>
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
                    <label className="text-sm text-slate-700">包含参考序列链接</label>
                  </div>
                </div>
                <label className="block text-sm font-medium">Source FASTA</label>
                <input className="w-full p-2 border rounded text-sm font-mono" value={networkSourceFasta}
                  onChange={(e) => setNetworkSourceFasta(e.target.value)} />
                <label className="block text-sm font-medium">Reference FASTA</label>
                <input className="w-full p-2 border rounded text-sm font-mono" value={networkReferenceFasta}
                  onChange={(e) => setNetworkReferenceFasta(e.target.value)} />
                <button className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm" disabled={job.loading}
                  onClick={() => runAction('计算相似性', runComputeSimilarity, 'similarity')}>
                  计算序列相似性
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
                      🧪 序列比对进行中
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
                        <span>参考序列 vs 候选序列</span>
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
                        <span>候选序列两两比对</span>
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
                  <span className="text-base font-semibold text-slate-800">网络可视化</span>
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
                      title="浏览器图加载阈值"
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
                      加载网络
                    </button>
                  </div>
                </div>
                <div className="text-xs text-slate-500">
                  上面的数字是加载阈值。点“加载网络”后，图内滑块只能在本次已加载边集的范围内调整。
                </div>
                {browserGraphThresholdAdjusted && (
                  <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    浏览器图已自动将加载阈值提高到 {browserGraphLoadedThreshold}，以避免边数超过 {browserGraphMaxEdges} 导致页面卡死或白屏。
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
                  推送到 Cytoscape Desktop（可选）
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
                      <label className="block text-sm font-medium mb-1">着色分类列</label>
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
                    onClick={() => runAction('推送到 Cytoscape', runNetworkPush, 'network-push')}>
                    Push to Cytoscape
                  </button>
                  {cytoPushInfo && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm space-y-1">
                      <div>Network SUID: {cytoPushInfo.networkSuid}</div>
                      <div>Pushed Nodes: {cytoPushInfo.pushedNodes} | Edges: {cytoPushInfo.pushedEdges}</div>
                      {cytoPushInfo.styleApplied && cytoPushInfo.categoryColumn && (
                        <div>样式已应用：{cytoPushInfo.styleName}（分组列 {cytoPushInfo.categoryColumn}）
                          {cytoPushInfo.categoryColumn !== cytoCategoryColumn && (
                            <span className="text-amber-700 font-medium"> ⚠ 所选「{cytoCategoryColumn}」列无数据，已回退到「{cytoPushInfo.categoryColumn}」</span>
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
                      🧪 序列比对进行中
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
                        <span>参考连边比对</span>
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
                        <span>候选序列两两比对</span>
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
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                <p className="text-sm text-slate-600">
                  综合相似度、分类学多样性和 cluster 大小，对候选序列进行多维评分排序。孤立点（cluster 仅含 1 条序列）默认排除。
                </p>
                <details className="text-xs text-slate-400">
                  <summary className="cursor-pointer select-none">参数说明</summary>
                  <ul className="mt-1 ml-4 list-disc space-y-0.5">
                    <li><b>最小 Cluster 大小</b>：cluster 中序列数量必须 ≥ 此值，否则排除。设为 2 即过滤孤立点。</li>
                    <li><b>Avg Ref Similarity 权重</b>：候选与所有参考序列平均相似度的评分权重。</li>
                    <li><b>Max Ref Similarity 权重</b>：候选与最相似参考序列之间相似度的评分权重。</li>
                    <li><b>Cluster Size 权重</b>：候选所在 cluster 越大得分越高，归一化后乘以此权重。</li>
                    <li><b>Taxonomy Diversity 权重</b>：候选所在 cluster 的分类学多样性（纲的数量）评分权重。</li>
                    <li><b>随机性 (Temperature)</b>：0 = 确定性选取（同参数同结果），&gt;0 时在每个 cluster 内按温度采样，值越大结果越随机。</li>
                  </ul>
                </details>
                <details className="text-xs text-slate-400 mt-1">
                  <summary className="cursor-pointer select-none">评分算法说明</summary>
                  <div className="mt-1 ml-2 space-y-1">
                    <p><b>评分公式</b>：Score = w₁·avgRefSim + w₂·maxRefSim + w₃·clusterSizeNorm + w₄·taxDiv</p>
                    <ul className="ml-4 list-disc space-y-0.5">
                      <li><b>avgRefSim</b>：候选与所有有边连接的参考序列的平均相似度 ÷ 100，范围 [0, 1]</li>
                      <li><b>maxRefSim</b>：候选与最相似参考序列的相似度 ÷ 100，范围 [0, 1]</li>
                      <li><b>clusterSizeNorm</b>：候选所在 cluster 大小 ÷ 最大 cluster 大小，范围 [0, 1]</li>
                      <li><b>taxDiv</b>：候选所在 cluster 中 class 种类数 ÷ 最大 class 种类数，范围 [0, 1]</li>
                    </ul>
                    <p><b>Cluster 来源</b>：cd-hit 按序列相似度阈值聚类的结果。同一 cluster 内的序列彼此高度相似。</p>
                    <p><b>相似度数据来源</b>：edges_similarity.csv 中候选与参考节点（is_reference=1）之间的边。</p>
                    <p><b>多样性选取</b>：支持两种策略——「按比例分配」按 cluster 大小分配名额（大 cluster 取更多），「均匀轮询」各 cluster 均匀轮流选取。</p>
                    <p><b>随机性</b>：Temperature=0 时完全确定，&gt;0 时在 cluster 轮询中使用 softmax 温度采样：P(i) = exp(score_i/T) / Σexp(score_j/T)，T 越大越随机。</p>
                  </div>
                </details>
                <div className="grid grid-cols-5 gap-3 text-sm">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">最小 Cluster 大小</label>
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
                    <label className="block text-xs text-slate-500 mb-1">选取策略</label>
                    <select className="w-full p-2 border rounded text-sm"
                      value={recommendDiversityMode}
                      onChange={(e) => setRecommendDiversityMode(e.target.value as 'proportional' | 'round-robin')}>
                      <option value="proportional">按比例分配</option>
                      <option value="round-robin">均匀轮询</option>
                    </select>
                  </div>
                  <div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">阈值: {recommendNetworkConnectivityThreshold}%</label>
                      <input type="range" min={0} max={100} step={1} className="w-full accent-indigo-500 cursor-pointer" draggable={false}
                        style={{ touchAction: 'none' }}
                        value={recommendNetworkConnectivityThreshold}
                        onChange={(e) => setRecommendNetworkConnectivityThreshold(Number(e.target.value))} />
                    </div>
                    <label className="block text-xs text-slate-500 mb-1">随机性 (Temperature): {recommendTemperature.toFixed(2)}</label>
                    <input type="range" min={0} max={1} step={0.05} className="w-full accent-indigo-500 cursor-pointer" draggable={false}
                      style={{ touchAction: 'none' }}
                      value={recommendTemperature}
                      onChange={(e) => setRecommendTemperature(Number(e.target.value))} />
                  </div>
                </div>
                <WeightBar weights={recommendWeights} onChange={setRecommendWeights} />
                <div className="flex items-center gap-3">
                  <button className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg text-sm"
                    disabled={job.loading}
                    onClick={() => runAction('候选推荐评分', runRecommendation, 'recommendation')}>
                    计算推荐
                  </button>
                </div>
              </div>
              {recommendMeta && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm space-y-1">
                  <div>候选 {recommendMeta.totalCandidates} 条，参考 {recommendMeta.totalReferences} 条，展示前 {recommendResults.length} 条</div>
                  {(recommendMeta.filteredByClusterSize > 0 || recommendMeta.filteredBySimilarity > 0) && (
                    <div className="text-slate-500">
                      已过滤：cluster 大小不足 {recommendMeta.filteredByClusterSize} 条
                      {recommendMeta.filteredBySimilarity > 0 && `，相似度不足 ${recommendMeta.filteredBySimilarity} 条`}
                    </div>
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
                      } catch (err: any) { alert('导出失败: ' + (err?.message || err)); }
                    }}>
                    导出 FASTA（{recommendResults.length} 条）
                  </button>
                  <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm"
                    onClick={highlightRecommendationsInNetwork}>
                    在网络中高亮
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
  const [recommendWeights, setRecommendWeights] = useState<RecommendWeights>({ avgRefSimilarity: 0.35, maxRefSimilarity: 0.25, clusterSize: 0.15, networkComponentSize: 0.15, taxonomyDiversity: 0.1 });
  const [recommendNetworkConnectivityThreshold, setRecommendNetworkConnectivityThreshold] = useState<number>(85);
  const [recommendTopN, setRecommendTopN] = useState(50);
  const [recommendMinClusterSize, setRecommendMinClusterSize] = useState(2);
  const [recommendMinSimilarity, setRecommendMinSimilarity] = useState(0);
  const [recommendTemperature, setRecommendTemperature] = useState(0);
  const [recommendDiversityMode, setRecommendDiversityMode] = useState<'proportional' | 'round-robin'>('proportional');
  const [recommendMeta, setRecommendMeta] = useState<{ totalCandidates: number; totalReferences: number; filteredByClusterSize: number; filteredBySimilarity: number } | null>(null);

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
    setStatusMessage(`加载任务进度: ${selectedTaskId}`);

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
              ? `已载入任务进度: ${selectedTaskId}；检测到旧版推荐缓存已失效，请重新计算推荐`
              : (data.exists ? `已载入任务进度: ${selectedTaskId}` : `新任务: ${selectedTaskId}`),
          );
        }
      } catch (err) {
        if (!cancelled) setError(`载入任务进度失败: ${String(err)}`);
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
      const data = await recommendCandidates({ weights: normalizeRecommendWeights(recommendWeights), topN: recommendTopN, minClusterSize: recommendMinClusterSize, minSimilarity: recommendMinSimilarity, temperature: recommendTemperature, diversityMode: recommendDiversityMode, networkConnectivityThreshold: recommendNetworkConnectivityThreshold });
      setRecommendResults(data.candidates);
      setRecommendMeta({ totalCandidates: data.totalCandidates, totalReferences: data.totalReferences, filteredByClusterSize: data.filteredByClusterSize, filteredBySimilarity: data.filteredBySimilarity });
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
      setStatusMessage(`已在网络中高亮 ${recommendResults.length} 条推荐序列，请返回 Similarity Network 查看`);
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
        <div className="max-w-6xl mx-auto px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="text-sm text-slate-500 hover:text-slate-700 mr-2">← 返回</button>
            <GitCompareArrows className="w-6 h-6 text-amber-600" />
            <span className="text-xl font-bold tracking-tight">网络对比</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">任务</span>
              <select
                className="p-1.5 border border-slate-300 rounded text-xs bg-white"
                value={selectedTaskId}
                onChange={(e) => setSelectedTaskId(e.target.value)}
                disabled={loading}
              >
                {compareTaskList.length === 0 && !selectedTaskId && (
                  <option value="">-- 请新建任务 --</option>
                )}
                {compareTaskList.map((t) => (
                  <option key={t.id} value={t.id}>{t.id}</option>
                ))}
              </select>
              <input
                className="p-1.5 border border-slate-300 rounded text-xs w-32"
                value={newTaskId}
                onChange={(e) => setNewTaskId(e.target.value)}
                placeholder="新任务ID(可选)"
                disabled={loading}
              />
              <button
                className="px-2 py-1.5 rounded bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
                onClick={createTaskAndSwitch}
                disabled={loading}
              >
                新建
              </button>
              <button
                className="px-2 py-1.5 rounded bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50"
                onClick={duplicateSelectedTask}
                disabled={loading || !selectedTaskId}
              >
                复制
              </button>
              <button
                className="px-2 py-1.5 rounded bg-red-600 text-white text-xs hover:bg-red-700 disabled:opacity-50"
                onClick={deleteSelectedTask}
                disabled={loading || !selectedTaskId}
              >
                删除
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
            请先在右上方新建一个对比任务，然后选择要对比的两个来源任务。
          </div>
        )}

        {/* Step 1: Select Source Tasks */}
        {selectedTaskId && (
          <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 shadow-sm">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="w-7 h-7 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center text-sm font-bold">1</span>
              选择要对比的两个任务
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-slate-500 mb-1">任务 A</label>
                <select className="w-full p-2 border rounded text-sm" value={taskAId} onChange={e => setTaskAId(e.target.value)}>
                  <option value="">-- 选择任务 --</option>
                  {sourceTasks.map(t => (
                    <option key={t.id} value={t.id}>[{moduleLabel(t.module)}] {t.name || t.id}</option>
                  ))}
                </select>
                {taskAInfo && (
                  <div className="mt-2 text-xs text-slate-600 bg-slate-50 rounded p-2 space-y-1">
                    <div>类型：<b>{moduleLabel(taskAInfo.module)}</b></div>
                    <div>参考序列：<b>{taskAInfo.referenceCount}</b></div>
                    <div>候选序列：<b>{taskAInfo.candidateCount}</b></div>
                    <div>Nodes.csv：{taskAInfo.hasNodesCsv ? <span className="text-green-600">{taskAInfo.nodesCount} 节点</span> : <span className="text-slate-400">无</span>}</div>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">任务 B</label>
                <select className="w-full p-2 border rounded text-sm" value={taskBId} onChange={e => setTaskBId(e.target.value)}>
                  <option value="">-- 选择任务 --</option>
                  {sourceTasks.map(t => (
                    <option key={t.id} value={t.id}>[{moduleLabel(t.module)}] {t.name || t.id}</option>
                  ))}
                </select>
                {taskBInfo && (
                  <div className="mt-2 text-xs text-slate-600 bg-slate-50 rounded p-2 space-y-1">
                    <div>类型：<b>{moduleLabel(taskBInfo.module)}</b></div>
                    <div>参考序列：<b>{taskBInfo.referenceCount}</b></div>
                    <div>候选序列：<b>{taskBInfo.candidateCount}</b></div>
                    <div>Nodes.csv：{taskBInfo.hasNodesCsv ? <span className="text-green-600">{taskBInfo.nodesCount} 节点</span> : <span className="text-slate-400">无</span>}</div>
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
              交集 / 合并
            </h2>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={keepReferences} onChange={e => setKeepReferences(e.target.checked)} />
              保留参考序列
            </label>
            <div className="flex flex-wrap gap-3">
              <button
                className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                disabled={loading}
                onClick={doIntersect}
              >
                {loading ? '处理中...' : '取交集'}
              </button>
              <button
                className="bg-teal-600 hover:bg-teal-700 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                disabled={loading}
                onClick={doMerge}
              >
                {loading ? '处理中...' : '合并网络'}
              </button>
            </div>

            {compareResult && (
              <div className={`${compareResult.operation === 'intersect' ? 'bg-blue-50 border-blue-200' : 'bg-teal-50 border-teal-200'} border rounded-xl p-4 text-sm space-y-1`}>
                <div className="font-semibold">{compareResult.operation === 'intersect' ? '交集' : '合并'}完成</div>
                <div>目标任务：<b>{compareResult.targetTaskId}</b></div>
                <div>总序列数：<b>{compareResult.totalSequences}</b>（候选 {compareResult.candidateCount} + 参考 {compareResult.referenceCount}）</div>
                <div>匹配对数：<b>{compareResult.matchedPairs}</b></div>
                {compareResult.operation === 'merge' && (
                  <>
                    <div>仅在 A：<b>{compareResult.uniqueToA ?? 0}</b> | 仅在 B：<b>{compareResult.uniqueToB ?? 0}</b> | 两者共有：<b>{compareResult.inBoth ?? 0}</b></div>
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
              计算序列相似性
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
              <div>
                <label className="block text-xs text-slate-500 mb-1">比对方法</label>
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
                包含参考序列间连边
              </label>
            </div>
            <button
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
              disabled={loading}
              onClick={doComputeSimilarity}
            >
              {loading ? '计算中...' : '计算序列相似性'}
            </button>
            {loading && runtimeMeta?.networkAlignProgress && (
              <div className="w-full bg-slate-50 p-3 rounded-lg border border-slate-100 space-y-3">
                <div className="flex justify-between text-xs text-slate-600 mb-2 font-medium">
                  <span>
                    🧪 序列比对进行中
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
                      <span>参考序列 vs 候选序列</span>
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
                      <span>候选序列两两比对</span>
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
                相似性已计算：Nodes <b>{similarityStatus.nodes}</b>，Edges <b>{similarityStatus.edges}</b>
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
              <span className="text-base font-semibold text-slate-800">网络可视化</span>
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
                  title="浏览器图加载阈值"
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
                  加载网络
                </button>
              </div>
            </div>
            <div className="text-xs text-slate-500">
              上面的数字是加载阈值。点“加载网络”后，图内滑块只能在本次已加载边集的范围内调整。
            </div>
            {browserGraphThresholdAdjusted && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                浏览器图已自动将加载阈值提高到 {browserGraphLoadedThreshold}，以避免边数超过 {browserGraphMaxEdges} 导致页面卡死或白屏。
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
                推送到 Cytoscape Desktop（可选）
              </summary>
              <div className="px-4 pb-4 pt-2 space-y-3 border-t border-slate-100">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Edge 阈值（%）</label>
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
                    <label className="block text-xs text-slate-500 mb-1">着色分类列</label>
                    <select className="w-full p-2 border rounded text-sm" value={cytoCategoryColumn} onChange={e => setCytoCategoryColumn(e.target.value)}>
                      <option value="source_task">Source Task（来源任务）</option>
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
                  自动应用样式
                </label>
                <button
                  className="bg-emerald-700 hover:bg-emerald-800 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                  disabled={loading}
                  onClick={doPushCytoscape}
                >
                  {loading ? '推送中...' : '推送到 Cytoscape'}
                </button>
                {cytoPushInfo && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-900">
                    已推送 networkSUID: <b>{String(cytoPushInfo.networkSuid ?? 'unknown')}</b>；
                    节点 {cytoPushInfo.pushedNodes}，边 {cytoPushInfo.pushedEdges}。
                    {cytoPushInfo.styleApplied && cytoPushInfo.categoryColumn && (
                      <span> 样式已应用：{cytoPushInfo.styleName}（分组列 {cytoPushInfo.categoryColumn}）</span>
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
              候选推荐
            </h2>
            <p className="text-sm text-slate-600">
              综合相似度、分类学多样性和 cluster 大小，对候选序列进行多维评分排序。孤立点（cluster 仅含 1 条序列）默认排除。
            </p>
            <details className="text-xs text-slate-400">
              <summary className="cursor-pointer select-none">参数说明</summary>
              <ul className="mt-1 ml-4 list-disc space-y-0.5">
                <li><b>最小 Cluster 大小</b>：cluster 中序列数量必须 ≥ 此值，否则排除。设为 2 即过滤孤立点。</li>
                <li><b>Avg Ref Similarity 权重</b>：候选与所有参考序列平均相似度的评分权重。</li>
                <li><b>Max Ref Similarity 权重</b>：候选与最相似参考序列之间相似度的评分权重。</li>
                <li><b>Cluster Size 权重</b>：候选所在 cluster 越大得分越高，归一化后乘以此权重。</li>
                <li><b>Taxonomy Diversity 权重</b>：候选所在 cluster 的分类学多样性（纲的数量）评分权重。</li>
                <li><b>随机性 (Temperature)</b>：0 = 确定性选取（同参数同结果），&gt;0 时在每个 cluster 内按温度采样，值越大结果越随机。</li>
              </ul>
            </details>
            <details className="text-xs text-slate-400 mt-1">
              <summary className="cursor-pointer select-none">评分算法说明</summary>
              <div className="mt-1 ml-2 space-y-1">
                <p><b>评分公式</b>：Score = w₁·avgRefSim + w₂·maxRefSim + w₃·clusterSizeNorm + w₄·taxDiv</p>
                <ul className="ml-4 list-disc space-y-0.5">
                  <li><b>avgRefSim</b>：候选与所有有边连接的参考序列的平均相似度 ÷ 100，范围 [0, 1]</li>
                  <li><b>maxRefSim</b>：候选与最相似参考序列的相似度 ÷ 100，范围 [0, 1]</li>
                  <li><b>clusterSizeNorm</b>：候选所在 cluster 大小 ÷ 最大 cluster 大小，范围 [0, 1]</li>
                  <li><b>taxDiv</b>：候选所在 cluster 中 class 种类数 ÷ 最大 class 种类数，范围 [0, 1]</li>
                </ul>
                <p><b>Cluster 来源</b>：cd-hit 按序列相似度阈值聚类的结果。同一 cluster 内的序列彼此高度相似。</p>
                <p><b>相似度数据来源</b>：edges_similarity.csv 中候选与参考节点（is_reference=1）之间的边。</p>
                <p><b>多样性选取</b>：支持两种策略——「按比例分配」按 cluster 大小分配名额（大 cluster 取更多），「均匀轮询」各 cluster 均匀轮流选取。</p>
                <p><b>随机性</b>：Temperature=0 时完全确定，&gt;0 时在 cluster 轮询中使用 softmax 温度采样：P(i) = exp(score_i/T) / Σexp(score_j/T)，T 越大越随机。</p>
              </div>
            </details>
            <div className="grid grid-cols-5 gap-3 text-sm">
              <div>
                <label className="block text-xs text-slate-500 mb-1">最小 Cluster 大小</label>
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
                <label className="block text-xs text-slate-500 mb-1">选取策略</label>
                <select className="w-full p-2 border rounded text-sm"
                  value={recommendDiversityMode}
                  onChange={(e) => setRecommendDiversityMode(e.target.value as 'proportional' | 'round-robin')}>
                  <option value="proportional">按比例分配</option>
                  <option value="round-robin">均匀轮询</option>
                </select>
              </div>
              <div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">阈值: {recommendNetworkConnectivityThreshold}%</label>
                      <input type="range" min={0} max={100} step={1} className="w-full accent-indigo-500 cursor-pointer" draggable={false}
                        style={{ touchAction: 'none' }}
                        value={recommendNetworkConnectivityThreshold}
                        onChange={(e) => setRecommendNetworkConnectivityThreshold(Number(e.target.value))} />
                    </div>
                <label className="block text-xs text-slate-500 mb-1">随机性 (Temperature): {recommendTemperature.toFixed(2)}</label>
                <input type="range" min={0} max={1} step={0.05} className="w-full accent-indigo-500 cursor-pointer" draggable={false}
                  style={{ touchAction: 'none' }}
                  value={recommendTemperature}
                  onChange={(e) => setRecommendTemperature(Number(e.target.value))} />
              </div>
            </div>
            <WeightBar weights={recommendWeights} onChange={setRecommendWeights} />
            <button
              className="bg-amber-600 hover:bg-amber-700 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
              disabled={loading}
              onClick={doRecommend}
            >
              {loading ? '计算中...' : '计算推荐'}
            </button>
            {recommendMeta && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm space-y-1">
                <div>候选 {recommendMeta.totalCandidates} 条，参考 {recommendMeta.totalReferences} 条，展示前 {recommendResults.length} 条</div>
                {(recommendMeta.filteredByClusterSize > 0 || recommendMeta.filteredBySimilarity > 0) && (
                  <div className="text-slate-500">
                    已过滤：cluster 大小不足 {recommendMeta.filteredByClusterSize} 条
                    {recommendMeta.filteredBySimilarity > 0 && `，相似度不足 ${recommendMeta.filteredBySimilarity} 条`}
                  </div>
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
                    } catch (err: any) { alert('导出失败: ' + (err?.message || err)); }
                  }}>
                  导出 FASTA（{recommendResults.length} 条）
                </button>
                <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm"
                  onClick={highlightRecommendationsInNetwork}>
                  在网络中高亮
                </button>
              </div>
            )}
          </section>
        )}

        {/* Runtime Logs */}
        {runtimeLogs.length > 0 && (
          <section className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-slate-700">运行日志</h3>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span>总耗时：{formatRuntimeDurationLabel(runtimeStartedAt, runtimeUpdatedAt, runtimeActive) || '-'}</span>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={autoScrollLog} onChange={e => setAutoScrollLog(e.target.checked)} />
                  自动滚动
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
            title={darkMode ? '切换为浅色模式' : '切换为深色模式'}
          >
            {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-6xl mx-auto px-8 py-12">
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-slate-900 mb-2">工作流模块</h1>
          <p className="text-slate-500">选择一个模块开始工作</p>
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
              <h2 className="text-lg font-semibold text-slate-900">BLAST 酶挖掘工作流</h2>
            </div>
            <p className="text-sm text-slate-500 mb-4 leading-relaxed">
              基于 BLAST pairwise 搜索蛋白质数据库，适用于参考序列较少（1-5条）的情况。
              支持本地数据库和 NCBI 远程搜索。
            </p>
            <div className="flex items-center gap-1 text-sm font-medium text-emerald-600 group-hover:text-emerald-700">
              进入模块 <ArrowRight className="w-4 h-4" />
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
              <h2 className="text-lg font-semibold text-slate-900">HMMER 新酶挖掘工作流</h2>
            </div>
            <p className="text-sm text-slate-500 mb-4 leading-relaxed">
              基于 HMM profile 搜索蛋白质数据库，筛选候选酶序列，进行评分、聚类和相似性网络分析。
              支持 NCBI Protein、UniProt 和核酸序列输入。
            </p>
            <div className="flex items-center gap-1 text-sm font-medium text-indigo-600 group-hover:text-indigo-700">
              进入模块 <ArrowRight className="w-4 h-4" />
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
              <h2 className="text-lg font-semibold text-slate-900">网络对比</h2>
            </div>
            <p className="text-sm text-slate-500 mb-4 leading-relaxed">
              选择 HMMER 或 BLAST 的任意两个任务，取交集或合并序列集合。
              支持跨模块比较，生成对比网络并推送到 Cytoscape。
            </p>
            <div className="flex items-center gap-1 text-sm font-medium text-amber-600 group-hover:text-amber-700">
              进入模块 <ArrowRight className="w-4 h-4" />
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
        运行中...
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
        <div className="text-sm font-medium text-slate-700">Pipeline 进度</div>
        <div className="text-xs text-slate-500">{doneCount}/{total} 已完成</div>
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
                {status === 'success' && '完成'}
                {status === 'error' && '失败'}
                {status === 'running' && '运行中...'}
                {status === 'idle' && '未开始'}
              </div>
            </div>
          );
        })}
      </div>

      {showSearchSubProgress && (
        <div className="border-t border-slate-100 pt-2">
          <div className="text-xs text-slate-500 mb-2">Search 子进度（EBI 三段）</div>
          <div className="flex items-center gap-2 overflow-x-auto">
            {[
              { key: 'submit' as EbiSubStepKey, title: '提交' },
              { key: 'download' as EbiSubStepKey, title: '下载' },
              { key: 'enrich' as EbiSubStepKey, title: '补齐+一致性' },
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
                    {item.title} · {status === 'success' ? '完成' : status === 'running' ? '运行中' : status === 'error' ? '失败' : '未开始'}
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
      <div className="text-sm font-medium text-slate-700">接口观测面板</div>
      <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
        {pipelineSteps.map((s) => {
          const m = metrics[s.key];
          const avg = m.runs > 0 ? Math.round(m.totalMs / m.runs) : 0;
          return (
            <div key={s.key} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-1">
              <div className="font-medium text-slate-700">{s.title}</div>
              <div className="text-slate-600">成功/失败: {m.success}/{m.fail}</div>
              <div className="text-slate-600">平均耗时: {avg} ms</div>
              <div className="text-slate-600">重试总数: {m.retries}</div>
              <div className="text-slate-600">最近耗时: {m.lastMs} ms</div>
              <div className="text-slate-600">最近尝试: {m.lastAttempts || 0} 次</div>
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
      <div className="text-sm font-medium text-slate-700">重试策略</div>
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
          <label className="block text-xs text-slate-500 mb-1">重试间隔(ms)</label>
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
            清空日志
          </button>
          <button
            className="px-2 py-0.5 border border-slate-600 rounded hover:bg-slate-800"
            onClick={() => setAutoScrollLog((v) => !v)}
          >
            自动滚动: {autoScrollLog ? '开' : '关'}
          </button>
          {jobLoading && <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />}
          task: {runtimeTask}
          {runtimeDurationLabel ? ` | 总耗时: ${runtimeDurationLabel}` : ''}
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
          <option value="all">全部</option>
          <option value="stderr">stderr</option>
          <option value="stdout">stdout</option>
          <option value="cmd">cmd</option>
          <option value="task">task</option>
        </select>
        <button
          className="px-2 py-1 border border-slate-700 rounded hover:bg-slate-900"
          onClick={() => setFoldRepeated((v) => !v)}
        >
          折叠重复: {foldRepeated ? '开' : '关'}
        </button>
        <button className="px-2 py-1 border border-slate-700 rounded hover:bg-slate-900" onClick={downloadLogs}>
          下载日志
        </button>
      </div>

      {errorLines.length > 0 && (
        <div className="mb-2 p-2 rounded border border-red-900 bg-red-950/40 text-[11px] font-mono space-y-1">
          <div className="text-red-300 font-semibold">最近错误</div>
          {errorLines.map((line, idx) => (
            <div key={`${line}-${idx}`} className="text-red-200 break-all flex items-start gap-2">
              <span className="flex-1">{line}</span>
              <button className="px-1.5 py-0.5 border border-red-800 rounded text-[10px]" onClick={() => copyLine(line)}>
                复制
              </button>
            </div>
          ))}
        </div>
      )}

      <div ref={logContainerRef} className={`${heightClass ?? 'h-40'} overflow-auto font-mono text-[11px] leading-5 rounded border border-slate-800 bg-slate-950 p-2`}>
        {displayLogs.length === 0 ? (
          <div className="text-slate-500">[log] 尚无输出</div>
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
            原始顺序
          </button>
          <button
            className={`text-xs px-2 py-1 rounded ${sortMode === 'cluster' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
            onClick={() => setSortMode('cluster')}
          >
            按相似度排列
          </button>
        </div>
      </div>
      <div className="flex gap-6 text-xs text-slate-500 dark:text-slate-400">
        <span>序列数: {n}</span>
        <span>Min: {minVal.toFixed(1)}%</span>
        <span>Max: {maxVal.toFixed(1)}%</span>
        <span>Mean: {mean.toFixed(1)}%</span>
        <span>Median: {median.toFixed(1)}%</span>
        {belowLowerBound.size > 0 && (
          <span className="text-red-500 font-medium">
            低于下界: {belowLowerBound.size} 条
          </span>
        )}
      </div>
      {onLowerBoundChange !== undefined && (
        <div className="flex items-center gap-3">
          <label className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">Identity 下界 (%):</label>
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
            <span className="text-red-500 font-medium">手动排除: {excludedIds.size} 条</span>
            <button
              className="text-indigo-600 hover:underline"
              onClick={() => onExcludedIdsChange?.(new Set())}
            >
              清除全部
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
  const displayTitle = title || 'Reference 预览';
  const pageSize = Math.ceil(allRows.length / totalPages);
  const start = (page - 1) * pageSize + 1;
  const end = start + rows.length - 1;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-auto">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 text-xs text-slate-600">
        <span>{displayTitle}：第 {page}/{totalPages} 页（{start}-{end} / {allRows.length}）</span>
        <div className="flex items-center gap-2">
          <button
            className="px-2 py-1 border rounded disabled:opacity-50"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            上一页
          </button>
          <button
            className="px-2 py-1 border rounded disabled:opacity-50"
            disabled={page >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          >
            下一页
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
