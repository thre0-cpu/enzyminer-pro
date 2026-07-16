import React, { useEffect, useMemo, useRef, useState } from 'react';

import { downloadButtonClass, downloadSelectClass, outlinedActionButtonClass } from './uiStyles';

import {
  exportCandidateCsv,
  exportRecommendedFasta,
  filterPredictedCandidates,
  setActiveTaskId,
} from './api';
import type {
  ManualFilterCondition,
  ManualFilterField,
  ManualFilterRow,
  PredictedSubWeights,
  RecommendCandidate,
} from './api';

type SaveFormat = 'fasta' | 'csv';

export type AppliedCandidateFilter = {
  conditions: ManualFilterCondition[];
  filteredCount: number;
  totalCandidates: number;
};

type CandidateSaveControlsProps = {
  ids: string[];
  candidates?: RecommendCandidate[];
  taskId?: string;
  filePrefix?: string;
  predictionOptions?: { subWeights?: Partial<PredictedSubWeights>; tmTarget?: number };
};

export function CandidateSaveControls({
  ids,
  candidates,
  taskId,
  filePrefix = 'selected_candidates',
  predictionOptions,
}: CandidateSaveControlsProps) {
  const [format, setFormat] = useState<SaveFormat>('fasta');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!ids.length || saving) return;
    setSaving(true);
    try {
      if (taskId) setActiveTaskId(taskId);
      const content = format === 'fasta'
        ? (await exportRecommendedFasta(ids)).fasta
        : `\uFEFF${(await exportCandidateCsv(ids, candidates, predictionOptions)).csv}`;
      const blob = new Blob(
        [content],
        { type: format === 'fasta' ? 'text/plain;charset=utf-8' : 'text/csv;charset=utf-8' },
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${filePrefix}_${ids.length}.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error: any) {
      alert(`Save failed: ${error?.message || error}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-emerald-700 shadow-sm">
      <button
        type="button"
        className={downloadButtonClass(saving || ids.length === 0)}
        onClick={handleSave}
        disabled={saving || ids.length === 0}
      >
        {saving ? 'Saving…' : `Save Selected (${ids.length})`}
      </button>
      <select
        aria-label="Candidate save format"
        value={format}
        onChange={(event) => setFormat(event.target.value as SaveFormat)}
        disabled={saving || ids.length === 0}
        className={downloadSelectClass}
      >
        <option value="fasta">FASTA</option>
        <option value="csv">CSV</option>
      </select>
    </div>
  );
}

export function SystemRecommendationResults({
  candidates,
  taskId,
  onHighlight,
}: {
  candidates: RecommendCandidate[];
  taskId?: string;
  onHighlight?: () => void | Promise<void>;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(candidates.map((candidate) => candidate.id)));

  const candidateKey = useMemo(() => candidates.map((candidate) => candidate.id).join('\u0001'), [candidates]);
  useEffect(() => {
    setSelectedIds(new Set(candidates.map((candidate) => candidate.id)));
    setPage(1);
  }, [candidateKey, candidates]);

  const totalPages = Math.max(1, Math.ceil(candidates.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageCandidates = candidates.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectedCandidates = candidates.filter((candidate) => selectedIds.has(candidate.id));
  const currentPageAllSelected = pageCandidates.length > 0 && pageCandidates.every((candidate) => selectedIds.has(candidate.id));

  const addIds = (ids: string[]) => setSelectedIds((previous) => {
    const next = new Set(previous);
    ids.forEach((id) => next.add(id));
    return next;
  });
  const removeIds = (ids: string[]) => setSelectedIds((previous) => {
    const next = new Set(previous);
    ids.forEach((id) => next.delete(id));
    return next;
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={outlinedActionButtonClass(pageCandidates.length === 0)}
            disabled={pageCandidates.length === 0}
            onClick={() => addIds(pageCandidates.map((candidate) => candidate.id))}
          >
            Select Current Page
          </button>
          <button
            type="button"
            className={outlinedActionButtonClass(candidates.length === 0)}
            disabled={candidates.length === 0}
            onClick={() => setSelectedIds(new Set(candidates.map((candidate) => candidate.id)))}
          >
            Select All {candidates.length}
          </button>
          <button
            type="button"
            className={outlinedActionButtonClass(selectedIds.size === 0)}
            disabled={selectedIds.size === 0}
            onClick={() => setSelectedIds(new Set())}
          >
            Clear Selection
          </button>
          <span className="text-xs text-slate-500">Selected {selectedIds.size} of {candidates.length}</span>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-500">
          Rows per page
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50">
            <tr>
              <th className="px-2 py-2 text-left">
                <input
                  type="checkbox"
                  aria-label="Select all recommendations on current page"
                  checked={currentPageAllSelected}
                  onChange={(event) => event.target.checked
                    ? addIds(pageCandidates.map((candidate) => candidate.id))
                    : removeIds(pageCandidates.map((candidate) => candidate.id))}
                />
              </th>
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
            {pageCandidates.map((candidate, index) => {
              const absoluteIndex = (safePage - 1) * pageSize + index;
              return (
                <tr key={candidate.id} className={index % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${candidate.id}`}
                      checked={selectedIds.has(candidate.id)}
                      onChange={(event) => event.target.checked ? addIds([candidate.id]) : removeIds([candidate.id])}
                    />
                  </td>
                  <td className="px-2 py-1.5 text-slate-400">{absoluteIndex + 1}</td>
                  <td className="max-w-[220px] break-all px-2 py-1.5 font-mono">{candidate.id}</td>
                  <td className="px-2 py-1.5 text-right font-semibold">{candidate.score.toFixed(4)}</td>
                  <td className="px-2 py-1.5 text-right">{candidate.predictedScore.toFixed(4)}</td>
                  <td className="px-2 py-1.5 text-right">{(candidate.avgRefSimilarity * 100).toFixed(1)}%</td>
                  <td className="px-2 py-1.5 text-right">{(candidate.maxRefSimilarity * 100).toFixed(1)}%</td>
                  <td className="px-2 py-1.5 text-right">{candidate.refEdgeCount}</td>
                  <td className="px-2 py-1.5">{candidate.cluster}</td>
                  <td className="px-2 py-1.5 text-right">{candidate.cluster_size}</td>
                  <td className="px-2 py-1.5">{candidate.phylum}</td>
                  <td className="px-2 py-1.5">{candidate.species}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <button
            type="button"
            className={outlinedActionButtonClass(safePage <= 1)}
            disabled={safePage <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            Previous
          </button>
          <span>Page {safePage} / {totalPages}</span>
          <button
            type="button"
            className={outlinedActionButtonClass(safePage >= totalPages)}
            disabled={safePage >= totalPages}
            onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
          >
            Next
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <CandidateSaveControls
            ids={selectedCandidates.map((candidate) => candidate.id)}
            candidates={selectedCandidates}
            taskId={taskId}
            filePrefix="recommended_candidates"
          />
          {onHighlight && (
            <button
              type="button"
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700"
              onClick={() => void onHighlight()}
            >
              Highlight in Network
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type UiFilterCondition = ManualFilterCondition & { key: string };
type ManualSort = { field: ManualFilterField; direction: 'asc' | 'desc' };

const TEXT_FIELD_OPTIONS: Array<{ value: ManualFilterField; label: string }> = [
  { value: 'id', label: 'Sequence ID' },
  { value: 'ec', label: 'EC (Top 1–3)' },
  { value: 'ec_top1', label: 'EC Top 1' },
  { value: 'ec_top2', label: 'EC Top 2' },
  { value: 'ec_top3', label: 'EC Top 3' },
  { value: 'uniprot_accession', label: 'UniProt Accession' },
  { value: 'uniprot_identifier', label: 'UniProt Identifier' },
  { value: 'description', label: 'Description' },
  { value: 'taxonomy_id', label: 'Taxonomy ID' },
  { value: 'kingdom', label: 'Kingdom' },
  { value: 'phylum', label: 'Phylum' },
  { value: 'class', label: 'Class' },
  { value: 'order', label: 'Order' },
  { value: 'family', label: 'Family' },
  { value: 'genus', label: 'Genus' },
  { value: 'species', label: 'Species' },
];

const NUMERIC_FIELD_OPTIONS: Array<{ value: ManualFilterField; label: string }> = [
  { value: 'length', label: 'Sequence Length' },
  { value: 'hmm_score', label: 'HMM Score' },
  { value: 'evalue', label: 'E-value' },
  { value: 'bitscore', label: 'Bit Score' },
  { value: 'pident', label: 'Identity (%)' },
  { value: 'qcovs', label: 'Query Coverage (%)' },
  { value: 'kcat', label: 'kcat' },
  { value: 'km', label: 'Km' },
  { value: 'catalytic_efficiency', label: 'kcat / Km' },
  { value: 'solubility', label: 'Solubility' },
  { value: 'tm', label: 'Tm' },
  { value: 'predicted_score', label: 'Predicted Score' },
];

const TEXT_FIELDS = new Set(TEXT_FIELD_OPTIONS.map((option) => option.value));
const TEXT_OPERATORS: Array<{ value: ManualFilterCondition['operator']; label: string }> = [
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'starts_with', label: 'starts with' },
];
const NUMERIC_OPERATORS: Array<{ value: ManualFilterCondition['operator']; label: string }> = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'eq', label: '=' },
  { value: 'between', label: 'between' },
];

function createCondition(field: ManualFilterField = 'ec'): UiFilterCondition {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    field,
    operator: TEXT_FIELDS.has(field) ? 'contains' : 'gte',
    value: '',
    ecScope: field === 'ec' ? 'any' : undefined,
  };
}

function normalizeStoredConditions(value: unknown): UiFilterCondition[] {
  if (!Array.isArray(value)) return [createCondition()];
  const allowedFields = new Set([...TEXT_FIELD_OPTIONS, ...NUMERIC_FIELD_OPTIONS].map((option) => option.value));
  const rows = value.slice(0, 20).flatMap((raw: any) => {
    const field = String(raw?.field || '') as ManualFilterField;
    if (!allowedFields.has(field)) return [];
    const condition = createCondition(field);
    const operators = TEXT_FIELDS.has(field) ? TEXT_OPERATORS : NUMERIC_OPERATORS;
    const operator = operators.some((item) => item.value === raw?.operator)
      ? raw.operator as ManualFilterCondition['operator']
      : condition.operator;
    return [{
      ...condition,
      operator,
      value: raw?.value ?? '',
      value2: raw?.value2 ?? '',
      ecScope: ['any', 'top1', 'top2', 'top3'].includes(raw?.ecScope) ? raw.ecScope : condition.ecScope,
    }];
  });
  return rows.length ? rows : [createCondition()];
}

function activeManualFilterConditions(conditions: UiFilterCondition[]): ManualFilterCondition[] {
  const active: ManualFilterCondition[] = [];
  for (const { key: _key, ...condition } of conditions) {
    const rawValue = condition.value;
    if (TEXT_FIELDS.has(condition.field)) {
      const value = String(rawValue ?? '').trim();
      if (value) active.push({ ...condition, value });
      continue;
    }
    if (rawValue === '' || rawValue === null || rawValue === undefined) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    if (condition.operator === 'between') {
      if (condition.value2 === '' || condition.value2 === null || condition.value2 === undefined) continue;
      const value2 = Number(condition.value2);
      if (!Number.isFinite(value2)) continue;
      active.push({ ...condition, value, value2 });
      continue;
    }
    active.push({ ...condition, value, value2: undefined });
  }
  return active;
}

function formatMetric(value: number | null, digits = 4) {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value !== 0 && (Math.abs(value) < 0.001 || Math.abs(value) >= 100000)) return value.toExponential(3);
  return value.toFixed(digits).replace(/\.?0+$/, '');
}

export function ManualFilteringPanel({
  taskId,
  subWeights,
  tmTarget,
  onAppliedFilterChange,
}: {
  taskId: string;
  subWeights: PredictedSubWeights;
  tmTarget: number;
  onAppliedFilterChange?: (state: AppliedCandidateFilter) => void;
}) {
  const storageKey = `enzymeminer:manual-filter:${taskId || 'default'}`;
  const savedState = useMemo(() => {
    if (typeof window === 'undefined') return null;
    try {
      return JSON.parse(window.localStorage.getItem(storageKey) || 'null');
    } catch {
      return null;
    }
  }, [storageKey]);

  const [conditions, setConditions] = useState<UiFilterCondition[]>(() => normalizeStoredConditions(savedState?.conditions));
  const [sort, setSort] = useState<ManualSort>(() => ({
    field: [...TEXT_FIELD_OPTIONS, ...NUMERIC_FIELD_OPTIONS].some((option) => option.value === savedState?.sort?.field)
      ? savedState.sort.field
      : 'predicted_score',
    direction: savedState?.sort?.direction === 'asc' ? 'asc' : 'desc',
  }));
  const [pageSize, setPageSize] = useState(() => [25, 50, 100, 200].includes(Number(savedState?.pageSize)) ? Number(savedState.pageSize) : 50);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(
    Array.isArray(savedState?.selectedIds) ? savedState.selectedIds.map(String).filter(Boolean) : [],
  ));
  const [rows, setRows] = useState<ManualFilterRow[]>([]);
  const [matchingIds, setMatchingIds] = useState<string[]>([]);
  const [totalPredicted, setTotalPredicted] = useState(0);
  const [filteredCount, setFilteredCount] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const initialQueryRef = useRef({ conditions, sort, pageSize });
  const appliedQueryRef = useRef({ conditions, sort, pageSize });
  const loadingRef = useRef(false);
  const predictionOptionsRef = useRef({ subWeights, tmTarget });
  const appliedFilterChangeRef = useRef(onAppliedFilterChange);
  predictionOptionsRef.current = { subWeights, tmTarget };
  appliedFilterChangeRef.current = onAppliedFilterChange;

  useEffect(() => {
    if (typeof window === 'undefined' || !taskId) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({
        conditions: conditions.map(({ key: _key, ...condition }) => condition),
        sort,
        pageSize,
        selectedIds: Array.from(selectedIds),
      }));
    } catch {
      // Persistence is optional; filtering remains fully functional without it.
    }
  }, [conditions, pageSize, selectedIds, sort, storageKey, taskId]);

  const executeFilter = async (
    requestedPage: number,
    query: { conditions: UiFilterCondition[]; sort: ManualSort; pageSize: number },
  ) => {
    if (!taskId || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError('');
    try {
      setActiveTaskId(taskId);
      const appliedConditions = activeManualFilterConditions(query.conditions);
      const data = await filterPredictedCandidates({
        conditions: appliedConditions,
        logic: 'and',
        page: requestedPage,
        pageSize: query.pageSize,
        sort: query.sort,
        includeAllIds: true,
        subWeights: predictionOptionsRef.current.subWeights,
        tmTarget: predictionOptionsRef.current.tmTarget,
      });
      appliedQueryRef.current = query;
      setRows(data.rows);
      setMatchingIds(data.matchingIds || []);
      setTotalPredicted(data.totalPredicted);
      setFilteredCount(data.filteredCount);
      appliedFilterChangeRef.current?.({
        conditions: appliedConditions,
        filteredCount: data.filteredCount,
        totalCandidates: data.totalPredicted,
      });
      setPage(data.page);
      setTotalPages(data.totalPages);
      const validIds = new Set(data.matchingIds || []);
      setSelectedIds((previous) => new Set(Array.from(previous).filter((id) => validIds.has(id))));
    } catch (caught: any) {
      setError(String(caught?.message || caught));
      setRows([]);
      setMatchingIds([]);
      setTotalPredicted(0);
      setFilteredCount(0);
      appliedFilterChangeRef.current?.({ conditions: [], filteredCount: 0, totalCandidates: 0 });
      setTotalPages(1);
      setSelectedIds(new Set());
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    void executeFilter(1, initialQueryRef.current);
    const refreshAfterPrediction = () => void executeFilter(1, appliedQueryRef.current);
    window.addEventListener('enzymeminer:predictions-updated', refreshAfterPrediction);
    return () => window.removeEventListener('enzymeminer:predictions-updated', refreshAfterPrediction);
    // This panel is keyed by task id in its parents, so listeners and the initial request are recreated per task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateCondition = (key: string, patch: Partial<UiFilterCondition>) => {
    setConditions((previous) => previous.map((condition) => {
      if (condition.key !== key) return condition;
      const next = { ...condition, ...patch };
      if (patch.field) {
        const isText = TEXT_FIELDS.has(patch.field);
        next.operator = isText ? 'contains' : 'gte';
        next.value = '';
        next.value2 = '';
        next.ecScope = patch.field === 'ec' ? 'any' : undefined;
      }
      return next;
    }));
  };

  const addIds = (ids: string[]) => setSelectedIds((previous) => {
    const next = new Set(previous);
    ids.forEach((id) => next.add(id));
    return next;
  });
  const removeIds = (ids: string[]) => setSelectedIds((previous) => {
    const next = new Set(previous);
    ids.forEach((id) => next.delete(id));
    return next;
  });
  const currentPageAllSelected = rows.length > 0 && rows.every((row) => selectedIds.has(row.id));

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <h3 className="text-sm font-semibold text-slate-800">2.1 Optional Candidate Pool Filters</h3>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          Apply hard filters to candidates with completed property predictions. Conditions are combined with AND.
          With no active condition, Recommendation uses every candidate. Applied conditions define the automatic recommendation pool; table checkboxes only control export.
        </p>
      </div>

      <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
        {conditions.map((condition, index) => {
          const isText = TEXT_FIELDS.has(condition.field);
          const operatorOptions = isText ? TEXT_OPERATORS : NUMERIC_OPERATORS;
          return (
            <div key={condition.key} className="grid gap-2 md:grid-cols-[1.35fr_1fr_1.35fr_auto]">
              <select
                aria-label={`Filter field ${index + 1}`}
                value={condition.field}
                onChange={(event) => updateCondition(condition.key, { field: event.target.value as ManualFilterField })}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
              >
                <optgroup label="Text fields">
                  {TEXT_FIELD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </optgroup>
                <optgroup label="Numeric fields">
                  {NUMERIC_FIELD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </optgroup>
              </select>
              <select
                aria-label={`Filter operator ${index + 1}`}
                value={condition.operator}
                onChange={(event) => updateCondition(condition.key, { operator: event.target.value as ManualFilterCondition['operator'] })}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
              >
                {operatorOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <div className="flex gap-2">
                {condition.field === 'ec' && (
                  <select
                    aria-label={`EC scope ${index + 1}`}
                    value={condition.ecScope || 'any'}
                    onChange={(event) => updateCondition(condition.key, { ecScope: event.target.value as UiFilterCondition['ecScope'] })}
                    className="min-w-[104px] rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs text-slate-700"
                  >
                    <option value="any">Any Top 1–3</option>
                    <option value="top1">Top 1</option>
                    <option value="top2">Top 2</option>
                    <option value="top3">Top 3</option>
                  </select>
                )}
                <input
                  type={isText ? 'text' : 'number'}
                  step={isText ? undefined : 'any'}
                  value={condition.value}
                  placeholder={condition.field === 'ec' ? 'e.g. 1.1.3' : 'Value'}
                  onChange={(event) => updateCondition(condition.key, { value: event.target.value })}
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                />
                {condition.operator === 'between' && (
                  <input
                    type="number"
                    step="any"
                    value={condition.value2 ?? ''}
                    placeholder="Max"
                    onChange={(event) => updateCondition(condition.key, { value2: event.target.value })}
                    className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  />
                )}
              </div>
              <button
                type="button"
                aria-label={`Remove filter ${index + 1}`}
                className="rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={conditions.length === 1}
                onClick={() => setConditions((previous) => previous.filter((item) => item.key !== condition.key))}
              >
                Remove
              </button>
            </div>
          );
        })}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <button
            type="button"
            className={outlinedActionButtonClass(conditions.length >= 20)}
            disabled={conditions.length >= 20}
            onClick={() => setConditions((previous) => [...previous, createCondition('kcat')])}
          >
            + Add Condition
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-slate-500">
              Sort
              <select
                value={sort.field}
                onChange={(event) => setSort((previous) => ({ ...previous, field: event.target.value as ManualFilterField }))}
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-slate-700"
              >
                {[...NUMERIC_FIELD_OPTIONS, ...TEXT_FIELD_OPTIONS].map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <select
                aria-label="Sort direction"
                value={sort.direction}
                onChange={(event) => setSort((previous) => ({ ...previous, direction: event.target.value as 'asc' | 'desc' }))}
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-slate-700"
              >
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </label>
            <button
              type="button"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              disabled={loading}
              onClick={() => {
                const resetConditions = [createCondition()];
                const resetSort: ManualSort = { field: 'predicted_score', direction: 'desc' };
                setConditions(resetConditions);
                setSort(resetSort);
                setSelectedIds(new Set());
                void executeFilter(1, { conditions: resetConditions, sort: resetSort, pageSize });
              }}
            >
              Reset
            </button>
            <button
              type="button"
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm text-white hover:bg-amber-700 disabled:cursor-wait disabled:opacity-60"
              disabled={loading}
              onClick={() => void executeFilter(1, { conditions, sort, pageSize })}
            >
              {loading ? 'Filtering…' : 'Apply Filters'}
            </button>
          </div>
        </div>
      </div>

      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}

      {!error && totalPredicted === 0 && !loading && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          No completed property predictions were found. Property-based filters need prediction results, but Recommendation can still run on all candidates when no filter is active.
        </div>
      )}

      {totalPredicted > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-slate-600">
              Matched <span className="font-semibold text-slate-900">{filteredCount}</span> of {totalPredicted} predicted candidates
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={outlinedActionButtonClass(rows.length === 0)} disabled={rows.length === 0} onClick={() => addIds(rows.map((row) => row.id))}>
                Select Current Page
              </button>
              <button type="button" className={outlinedActionButtonClass(matchingIds.length === 0)} disabled={matchingIds.length === 0} onClick={() => setSelectedIds(new Set(matchingIds))}>
                Select All {filteredCount}
              </button>
              <button type="button" className={outlinedActionButtonClass(selectedIds.size === 0)} disabled={selectedIds.size === 0} onClick={() => setSelectedIds(new Set())}>
                Clear Selection
              </button>
              <span className="text-xs text-slate-500">Selected {selectedIds.size}</span>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th className="px-2 py-2 text-left">
                    <input
                      type="checkbox"
                      aria-label="Select all filtered rows on current page"
                      checked={currentPageAllSelected}
                      onChange={(event) => event.target.checked ? addIds(rows.map((row) => row.id)) : removeIds(rows.map((row) => row.id))}
                    />
                  </th>
                  <th className="px-2 py-2 text-left">#</th>
                  <th className="px-2 py-2 text-left">ID</th>
                  <th className="px-2 py-2 text-left">EC Top 1–3</th>
                  <th className="px-2 py-2 text-right">kcat</th>
                  <th className="px-2 py-2 text-right">Km</th>
                  <th className="px-2 py-2 text-right">kcat/Km</th>
                  <th className="px-2 py-2 text-right">Solubility</th>
                  <th className="px-2 py-2 text-right">Tm</th>
                  <th className="px-2 py-2 text-right">Pred. Score</th>
                  <th className="px-2 py-2 text-right">Length</th>
                  <th className="px-2 py-2 text-left">Species</th>
                  <th className="px-2 py-2 text-left">Description</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.id} className={index % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.id}`}
                        checked={selectedIds.has(row.id)}
                        onChange={(event) => event.target.checked ? addIds([row.id]) : removeIds([row.id])}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-slate-400">{(page - 1) * pageSize + index + 1}</td>
                    <td className="max-w-[210px] break-all px-2 py-1.5 font-mono">{row.id}</td>
                    <td className="min-w-[130px] px-2 py-1.5">
                      <div>{row.ec_top1 || '—'}</div>
                      {(row.ec_top2 || row.ec_top3) && <div className="text-[10px] text-slate-400">{[row.ec_top2, row.ec_top3].filter(Boolean).join(', ')}</div>}
                    </td>
                    <td className="px-2 py-1.5 text-right">{formatMetric(row.kcat)}</td>
                    <td className="px-2 py-1.5 text-right">{formatMetric(row.km)}</td>
                    <td className="px-2 py-1.5 text-right font-medium">{formatMetric(row.catalytic_efficiency)}</td>
                    <td className="px-2 py-1.5 text-right">{formatMetric(row.solubility)}</td>
                    <td className="px-2 py-1.5 text-right">{formatMetric(row.tm, 2)}</td>
                    <td className="px-2 py-1.5 text-right">{formatMetric(row.predicted_score)}</td>
                    <td className="px-2 py-1.5 text-right">{row.length ?? '—'}</td>
                    <td className="max-w-[180px] px-2 py-1.5">{row.species || '—'}</td>
                    <td className="max-w-[280px] truncate px-2 py-1.5" title={row.description}>{row.description || '—'}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={13} className="px-3 py-8 text-center text-sm text-slate-500">No candidates match the current filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <button type="button" className={outlinedActionButtonClass(page <= 1 || loading)} disabled={page <= 1 || loading} onClick={() => void executeFilter(page - 1, appliedQueryRef.current)}>Previous</button>
              <span>Page {page} / {totalPages}</span>
              <button type="button" className={outlinedActionButtonClass(page >= totalPages || loading)} disabled={page >= totalPages || loading} onClick={() => void executeFilter(page + 1, appliedQueryRef.current)}>Next</button>
              <label className="ml-2 flex items-center gap-2">
                Rows per page
                <select
                  value={pageSize}
                  onChange={(event) => {
                    const nextPageSize = Number(event.target.value);
                    setPageSize(nextPageSize);
                    const query = { ...appliedQueryRef.current, pageSize: nextPageSize };
                    void executeFilter(1, query);
                  }}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700"
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                </select>
              </label>
            </div>
            <CandidateSaveControls
              ids={Array.from(selectedIds)}
              taskId={taskId}
              filePrefix="filtered_candidates"
              predictionOptions={{ subWeights, tmTarget }}
            />
          </div>
        </>
      )}
    </section>
  );
}
