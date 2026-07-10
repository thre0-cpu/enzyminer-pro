export type ApiResult<T> = {
  ok: boolean;
  message?: string;
  details?: string;
} & T;

export type ScoringRule = {
  pos: number;
  allowed: string[];
  score: number;
  label: string;
};

export type ScoringPositionMode = 'pre' | 'aligned';
export type PreAlignmentAnchor = 'first' | 'refid';

let activeTaskId = 'default';

function withTaskId(url: string) {
  const [base, hash = ''] = url.split('#');
  const [path, query = ''] = base.split('?');
  const params = new URLSearchParams(query);
  params.set('taskId', activeTaskId);
  const next = `${path}?${params.toString()}`;
  return hash ? `${next}#${hash}` : next;
}

export function setActiveTaskId(taskId: string) {
  activeTaskId = String(taskId || 'default');
}

export function getActiveTaskId() {
  return activeTaskId;
}

async function parseJsonSafe(response: Response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> || {}),
  };
  if (import.meta.env.VITE_API_KEY) {
    headers['x-api-key'] = import.meta.env.VITE_API_KEY;
  }
  const response = await fetch(withTaskId(url), { ...init, headers });
  const payload = await parseJsonSafe(response);
  if (!response.ok || payload?.ok === false) {
    if (response.status === 409) {
      const taskMsg = payload?.message ? `（${payload.message}）` : '';
      throw new Error(`A task is already running in the backend, please wait for it to finish before trying again${taskMsg}`);
    }
    const message = payload?.message || `Request failed: ${response.status}`;
    const details = payload?.details || '';
    throw new Error(details ? `${message}\n${details}` : message);
  }
  return payload as ApiResult<T>;
}

export function healthCheck() {
  return request<{
    pipelineRoot: string;
    workDir: string;
    taskId: string;
    pythonBin: string;
    tools: Record<string, boolean>;
  }>('/api/health');
}

export function listTasks() {
  return request<{
    tasks: Array<{
      id: string;
      workDir: string;
      module: string | null;
      name: string;
      createdAt: number;
      updatedAt: number;
    }>;
  }>('/api/tasks');
}

export function createTask(taskId?: string, name?: string, module?: 'hmmer' | 'blast' | 'compare') {
  return request<{
    task: {
      id: string;
      workDir: string;
      createdAt: number;
      name: string;
      note: string;
      module: string | null;
    };
  }>('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, name, module }),
  });
}

export function deleteTask(taskId: string) {
  return request<{ taskId: string }>(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  });
}

export function duplicateTask(srcTaskId: string, newTaskId?: string, name?: string) {
  return request<{
    task: {
      id: string;
      workDir: string;
      createdAt: number;
      name: string;
      note: string;
      module: string | null;
    };
  }>(`/api/tasks/${encodeURIComponent(srcTaskId)}/duplicate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newTaskId, name }),
  });
}

export function fetchReferences(accessionList: string[], email: string) {
  return request<{
    rows: number;
    csv: string;
    fasta: string;
    preview: { headers: string[]; rows: Array<Record<string, string>> };
  }>('/api/reference/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessionList, email }),
  });
}

export function importReferenceFasta(fastaText: string, sourceName?: string) {
  return request<{
    rows: number;
    csv: string;
    fasta: string;
    sourceName: string;
    preview: { headers: string[]; rows: Array<Record<string, string>> };
  }>('/api/reference/import-fasta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fastaText, sourceName }),
  });
}

export function loadReferencePreview() {
  return request<{
    exists: boolean;
    preview: { headers: string[]; rows: Array<Record<string, string>>; total: number };
  }>('/api/reference/preview');
}

export function loadCdhitPreview() {
  return request<{
    exists: boolean;
    preview: { headers: string[]; rows: Array<Record<string, string>>; total: number };
  }>('/api/hmm/cdhit-preview');
}

export function computeRefPairwiseIdentity(fastaPath?: string) {
  return request<{
    ids: string[];
    matrix: number[][];
  }>('/api/reference/pairwise-identity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fastaPath }),
  });
}

export function buildHmm(
  identity: number,
  wordSize: number,
  refFasta: string,
  opts?: { coverageLong?: number; coverageShort?: number; identityLowerBound?: number },
) {
  return request<{
    outputs: {
      refInput: string;
      ref90: string;
      ref90Aln: string;
      hmm: string;
    };
    stats: {
      inputCount: number;
      outputCount: number;
      clusterCount: number;
      clusters: Array<{ name: string; size: number; representative: string }>;
      lowerBoundRemoved?: string[];
    };
  }>('/api/hmm/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity, wordSize, refFasta, coverageLong: opts?.coverageLong, coverageShort: opts?.coverageShort, identityLowerBound: opts?.identityLowerBound }),
  });
}

export function runHmmSearch(
  targetFasta: string,
  hmmFile: string,
  options?: {
    mode?: 'local' | 'ebi';
    database?: string;
  },
) {
  return request<{
    tblout: string;
    hitsCsv: string;
    mode?: 'local' | 'ebi';
    jobId?: string;
    pageCount?: number;
    failedPages?: number;
    failedPageNumbers?: number[];
    preview: { headers: string[]; rows: Array<Record<string, string>> };
  }>('/api/search/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetFasta,
      hmmFile,
      mode: options?.mode || 'local',
      database: options?.database || 'refprot',
    }),
  });
}

export function monitorEbiHmmSearch(hmmFile: string, database: string) {
  return request<{
    jobId: string;
    pageCount: number;
    status: string;
  }>('/api/search/ebi/monitor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hmmFile, database }),
  });
}

export function downloadEbiHmmSearchResults(jobId: string) {
  return request<{
    mode?: 'ebi';
    jobId: string;
    pageCount: number;
    failedPages: number;
    failedPageNumbers?: number[];
    tblout: string | null;
    hitsCsv: string;
    preview: { headers: string[]; rows: Array<Record<string, string>> };
  }>('/api/search/ebi/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId }),
  });
}

export function fillUniProt(taskId: string) {
  return request<{
    ok: boolean;
    hitsCsv?: string;
    preview?: any;
  }>("/api/search/ebi/uniprot-fill", {
    method: "POST",
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
  });
}

export function retryFailedEbiPages(jobId: string, failedPageNumbers?: number[]) {
  return request<{
    mode?: 'ebi';
    jobId: string;
    retriedPages: number;
    insertedRows: number;
    totalRows: number;
    failedPages: number;
    failedPageNumbers?: number[];
    hitsCsv: string;
    preview: { headers: string[]; rows: Array<Record<string, string>> };
  }>('/api/search/ebi/retry-failed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, failedPages: failedPageNumbers }),
  });
}

export function filterHits(scoreMin: number, lenMin: number, lenMax: number) {
  return request<{
    total: number;
    kept: number;
    csv: string;
    filteredFasta: string | null;
    fastaCount: number;
    preview: { headers: string[]; rows: Array<Record<string, string>> };
  }>('/api/search/filter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scoreMin, lenMin, lenMax }),
  });
}

export function filterHitsByTargets(targets: string[]) {
  return request<{
    total: number;
    kept: number;
    csv: string;
    filteredFasta: string | null;
    fastaCount: number;
    preview: { headers: string[]; rows: Array<Record<string, string>> };
  }>('/api/search/filter-box', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targets }),
  });
}

export function runSearchConsistencyCheck(source: 'hits_all' | 'filtered' = 'hits_all') {
  return request<{
    source: string;
    file: string;
    total: number;
    checked: number;
    mismatch: number;
    filled: number;
    updated: boolean;
    preview: { headers: string[]; rows: Array<Record<string, string>> };
  }>('/api/search/consistency-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
}

export function loadSearchPage(page: number, pageSize: number, source: 'hits_all' | 'filtered' = 'hits_all') {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    source,
  });
  return request<{
    source: string;
    file: string;
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    preview: { headers: string[]; rows: Array<Record<string, string>>; total: number };
  }>(`/api/search/page?${params.toString()}`);
}

export function loadPipelineState(module?: 'hmmer' | 'blast' | 'compare') {
  const qs = module ? `?module=${module}` : '';
  return request<{
    taskId: string;
    exists: boolean;
    state: Record<string, any> | null;
  }>(`/api/pipeline/state${qs}`);
}

export function savePipelineState(state: Record<string, any>, module?: 'hmmer' | 'blast' | 'compare') {
  return request<{
    taskId: string;
    saved: boolean;
  }>('/api/pipeline/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, module }),
  });
}

export type ArtifactEntry = {
  exists: boolean;
  size?: number;
  rowCount?: number;
  meta?: Record<string, any>;
};

export function loadTaskArtifacts() {
  return request<{
    taskId: string;
    workDir: string;
    artifacts: Record<string, ArtifactEntry>;
  }>('/api/task/artifacts');
}

export function runScoring(
  alignment: string,
  refId: string,
  threshold: number,
  opts?: {
    autoFromFiltered?: boolean;
    filteredFasta?: string;
    referenceFasta?: string;
    rules?: ScoringRule[];
    positionMode?: ScoringPositionMode;
    preAlignmentAnchor?: PreAlignmentAnchor;
  },
) {
  return request<{
    total: number;
    passed: number;
    csv: string;
    passedFasta?: string;
    passedCount?: number;
    passedMissingInAlignment?: number;
    alignmentUsed: string;
    autoFromFiltered: boolean;
    rulesCount?: number | null;
    positionMode?: ScoringPositionMode;
    preAlignmentAnchor?: PreAlignmentAnchor;
    refIdUsed?: string | null;
    preview: { headers: string[]; rows: Array<Record<string, string>> };
  }>('/api/scoring/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      alignment,
      refId,
      threshold,
      autoFromFiltered: Boolean(opts?.autoFromFiltered),
      filteredFasta: opts?.filteredFasta,
      referenceFasta: opts?.referenceFasta,
      rules: opts?.rules,
      positionMode: opts?.positionMode || 'pre',
      preAlignmentAnchor: opts?.preAlignmentAnchor || 'first',
    }),
  });
}

export async function downloadScoringCsv(csvPath?: string) {
  const params = new URLSearchParams();
  params.set('taskId', activeTaskId);
  if (csvPath) {
    params.set('csv', csvPath);
  }
  const response = await fetch(`/api/scoring/download?${params.toString()}`);
  if (!response.ok) {
    let details = '';
    try {
      details = await response.text();
    } catch {
      details = '';
    }
    throw new Error(details || `Request failed: ${response.status}`);
  }
  const blob = await response.blob();
  const cd = response.headers.get('content-disposition') || '';
  const m = cd.match(/filename="?([^";]+)"?/i);
  const fileName = (m && m[1]) ? m[1] : 'scored_results.csv';
  return { blob, fileName };
}

export function previewScoringThreshold(threshold: number, csvPath?: string) {
  const params = new URLSearchParams();
  params.set('threshold', String(threshold));
  if (csvPath) {
    params.set('csv', csvPath);
  }
  return request<{
    csv: string;
    threshold: number;
    total: number;
    passed: number;
    ratio: number;
  }>(`/api/scoring/threshold-preview?${params.toString()}`);
}

export function prepareScoringAlignment(opts?: {
  filteredFasta?: string;
  referenceFasta?: string;
  refId?: string;
}) {
  return request<{
    inputFasta: string;
    alignment: string;
    records: number;
  }>('/api/scoring/prepare-alignment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filteredFasta: opts?.filteredFasta,
      referenceFasta: opts?.referenceFasta,
      refId: opts?.refId,
    }),
  });
}

export function loadScoringAlignmentPreview(opts?: {
  alignment?: string;
  start?: number;
  end?: number;
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (opts?.alignment) params.set('alignment', opts.alignment);
  params.set('start', String(opts?.start ?? 1));
  params.set('end', String(opts?.end ?? 120));
  params.set('limit', String(opts?.limit ?? 40));
  params.set('offset', String(opts?.offset ?? 0));
  return request<{
    alignment: string;
    start: number;
    end: number;
    limit: number;
    offset: number;
    totalRecords: number;
    alignmentLength: number;
    rows: Array<{ id: string; segment: string }>;
  }>(`/api/scoring/alignment-preview?${params.toString()}`);
}

export function runClustering(inputFasta: string, identity: number, wordSize: number) {
  return request<{
    outputFasta: string;
    clusterFile: string;
    inputCount: number;
    outputCount: number;
    deduplicatedCount: number;
    clusters: number;
  }>('/api/clustering/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputFasta, identity, wordSize }),
  });
}

export function loadNetworkData(opts?: {
  forceRebuild?: boolean;
  includeReferenceLinks?: boolean;
  similarityMethod?: 'needleman-wunsch' | 'smith-waterman' | 'mmseqs2';
}) {
  const qp = new URLSearchParams();
  if (opts?.forceRebuild) {
    qp.set('forceRebuild', 'true');
  }
  if (opts?.includeReferenceLinks) {
    qp.set('includeReferenceLinks', 'true');
  }
  if (opts?.similarityMethod) {
    qp.set('similarityMethod', String(opts.similarityMethod));
  }
  const url = qp.toString() ? `/api/network/data?${qp.toString()}` : '/api/network/data';
  return request<{
    edges: Array<Record<string, string>>;
    nodes: Array<Record<string, string>>;
    edgeTotal?: number;
    nodeTotal?: number;
  }>(url);
}

export function computeNetworkSimilarity(opts?: {
  includeReferenceLinks?: boolean;
  similarityMethod?: 'needleman-wunsch' | 'smith-waterman' | 'mmseqs2';
  sourceFasta?: string;
  referenceFasta?: string;
}) {
  return request<{
    nodesCsv: string;
    edgesCsv: string;
    nodes: number;
    edges: number;
    similarityMethod: 'needleman-wunsch' | 'smith-waterman' | 'mmseqs2';
    includeReferenceLinks: boolean;
  }>('/api/network/compute-similarity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      includeReferenceLinks: opts?.includeReferenceLinks,
      similarityMethod: opts?.similarityMethod,
      sourceFasta: opts?.sourceFasta,
      referenceFasta: opts?.referenceFasta,
    }),
  });
}

export function loadNetworkSimilarityStatus() {
  return request<{
    taskId: string;
    exists: boolean;
    nodesExists: boolean;
    edgesExists: boolean;
    nodeTotal: number;
    edgeTotal: number;
    nodesCsv: string;
    edgesCsv: string;
  }>('/api/network/similarity-status');
}

export type BrowserGraphNode = {
  id: string;
  cluster: string;
  cluster_size: number;
  is_reference: string;
  kingdom: string;
  phylum: string;
  class: string;
  order: string;
  family: string;
  genus: string;
  species: string;
};

export type BrowserGraphEdge = {
  source: string;
  target: string;
  weight: number;
  similarity: number | null;
};

export function fetchBrowserGraphData(opts?: { pairwiseThresholdPct?: number; maxEdges?: number }) {
  return request<{
    nodes: BrowserGraphNode[];
    edges: BrowserGraphEdge[];
    nodeCount: number;
    edgeCount: number;
    requestedThresholdPct: number;
    appliedThresholdPct: number;
    thresholdAdjusted: boolean;
    maxEdges: number;
  }>('/api/network/browser-graph', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairwiseThresholdPct: opts?.pairwiseThresholdPct, maxEdges: opts?.maxEdges }),
  });
}

export function pushNetworkToCytoscape(opts?: {
  baseUrl?: string;
  title?: string;
  collection?: string;
  layout?: string;
  styleName?: string;
  categoryColumn?: string;
  applyStyle?: boolean;
  pairwiseThresholdPct?: number;
  forceRebuild?: boolean;
  includeReferenceLinks?: boolean;
  similarityMethod?: 'needleman-wunsch' | 'smith-waterman' | 'mmseqs2';
  sourceFasta?: string;
  referenceFasta?: string;
}) {
  return request<{
    baseUrl: string;
    networkSuid: number | null;
    generated: boolean;
    nodesCsv: string;
    edgesCsv: string;
    pushedNodes: number;
    pushedEdges: number;
    pairwiseThresholdPct?: number | null;
    includeReferenceLinks?: boolean;
    similarityMethod?: string | null;
    collection: string;
    title: string;
    layout: string;
    styleName: string;
    styleApplied: boolean;
    styleError?: string;
    categoryColumn?: string | null;
    layoutApplied: boolean;
    layoutError?: string;
  }>('/api/network/push-cytoscape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: opts?.baseUrl,
      title: opts?.title,
      collection: opts?.collection,
      layout: opts?.layout,
      styleName: opts?.styleName,
      categoryColumn: opts?.categoryColumn,
      applyStyle: opts?.applyStyle,
      pairwiseThresholdPct: opts?.pairwiseThresholdPct,
      forceRebuild: opts?.forceRebuild,
      includeReferenceLinks: opts?.includeReferenceLinks,
      similarityMethod: opts?.similarityMethod,
      sourceFasta: opts?.sourceFasta,
      referenceFasta: opts?.referenceFasta,
    }),
  });
}

export type RecommendCandidate = {
  id: string;
  cluster: string;
  cluster_size: number;
  networkComponent: string;
  networkComponentSize: number;
  representative: boolean;
  kingdom: string;
  phylum: string;
  class: string;
  species: string;
  avgRefSimilarity: number;
  maxRefSimilarity: number;
  clusterSizeNorm: number;
  networkComponentSizeNorm: number;
  taxonomyDiversity: number;
  predictedScore: number;
  score: number;
  refEdgeCount: number;
};

export type RecommendWeights = {
  avgRefSimilarity: number;
  maxRefSimilarity: number;
  clusterSize: number;
  networkComponentSize: number;
  taxonomyDiversity: number;
  predictedScore: number;
};

export type PredictedSubWeights = {
  kcat: number;
  solubility: number;
  tm: number;
};

export type PredictedMetricsRow = {
  id: string;
  kcat: number;
  solubility: number;
  tm: number;
  kcatNorm: number;
  solubilityNorm: number;
  tmNorm: number;
  predictedScore: number;
};

export function predictNetworkMetrics(opts?: {
  forceRecompute?: boolean;
  subWeights?: Partial<PredictedSubWeights>;
  tmTarget?: number;
}) {
  return request<{
    count: number;
    recomputedCount: number;
    tmTarget: number;
    subWeights: PredictedSubWeights;
    rows: PredictedMetricsRow[];
  }>('/api/network/predict-metrics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      forceRecompute: opts?.forceRecompute,
      subWeights: opts?.subWeights,
      tmTarget: opts?.tmTarget,
    }),
  });
}

export function recommendCandidates(opts?: {
  weights?: Partial<RecommendWeights>;
  topN?: number;
  minClusterSize?: number;
  minSimilarity?: number;
  temperature?: number;
  networkConnectivityThreshold?: number;
  diversityMode?: 'proportional' | 'round-robin';
  predictedSubWeights?: Partial<PredictedSubWeights>;
  predictedTmTarget?: number;
}) {
  return request<{
    totalCandidates: number;
    totalReferences: number;
    filteredByClusterSize: number;
    filteredBySimilarity: number;
    minClusterSize: number;
    minSimilarity: number;
    temperature: number;
    diversityMode: string;
    weights: RecommendWeights;
    predictedSubWeights: PredictedSubWeights;
    predictedTmTarget: number;
    predictedMetricsAvailable: boolean;
    candidates: RecommendCandidate[];
  }>('/api/network/recommend-candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      weights: opts?.weights,
      topN: opts?.topN,
      minClusterSize: opts?.minClusterSize,
      minSimilarity: opts?.minSimilarity,
      temperature: opts?.temperature,
      networkConnectivityThreshold: opts?.networkConnectivityThreshold,
      diversityMode: opts?.diversityMode,
      predictedSubWeights: opts?.predictedSubWeights,
      predictedTmTarget: opts?.predictedTmTarget,
    }),
  });
}

export function exportRecommendedFasta(ids: string[]) {
  return request<{ fasta: string; foundCount: number; requestedCount: number }>('/api/network/export-recommended-fasta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

export function highlightCytoscapeNodes(ids: string[], baseUrl?: string, networkSuid?: number | null) {
  return request<{ selectedCount: number; requestedCount: number; networkSuid: number }>('/api/network/highlight-cytoscape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, baseUrl, networkSuid }),
  });
}

export function loadRuntimeLogs(limit = 200) {
  return request<{
    active: boolean;
    task: string;
    startedAt: number | null;
    updatedAt: number | null;
    meta?: {
      ebiJobId?: string;
      ebiDatabase?: string;
      ebiDownloadProgress?: { current: number; total: number };
      uniprotProgress?: number;
      uniprotPhase?: string;
      consistencyProgress?: number;
      networkAlignProgress?: { current: number; total: number; phase?: string };
      networkAlignStages?: {
        'reference-links'?: { current: number; total: number };
        'candidate-pairwise'?: { current: number; total: number };
      };
      blastProgress?: {
        current: number;
        total: number;
        queryId: string;
        queryTimings: Array<{ ms: number }>;
        estimatedRemainingMs: number | null;
      };
      blastAnnotateProgress?: number;
      blastAnnotatePhase?: string;
    };
    lines: string[];
  }>(`/api/runtime/logs?limit=${limit}`);
}

export function clearRuntimeLogs() {
  return request<Record<string, never>>('/api/runtime/logs/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

// ===== BLAST Pipeline APIs =====

export type BlastDbSource = 'local' | 'ncbi-remote';
export type BlastMergeStrategy = 'best-evalue' | 'union';

export function buildBlastDb(opts: {
  dbSource: BlastDbSource;
  targetFasta?: string;
  ncbiDb?: string;
  deduplicateRefs?: boolean;
  deduplicateIdentity?: number;
}) {
  return request<{
    dbSource: BlastDbSource;
    dbPath: string | null;
    refDedup: string | null;
    refDedupCount: number;
    refInputCount: number;
  }>('/api/blast/build-db', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export function runBlastSearch(opts: {
  evalue?: number;
  identityMin?: number;
  queryCovMin?: number;
  subjectLenMin?: number;
  subjectLenMax?: number;
  maxTargetSeqs?: number;
  matrix?: string;
  wordSize?: number;
  gapOpen?: number;
  gapExtend?: number;
  mergeStrategy?: BlastMergeStrategy;
  dbSource?: BlastDbSource;
  ncbiDb?: string;
}) {
  return request<{
    mode: BlastDbSource;
    hitsCsv: string;
    totalHits: number;
    uniqueSubjects: number;
    queriesUsed: number;
    preview: { headers: string[]; rows: Array<Record<string, string>> };
  }>('/api/blast/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export function filterBlastHits(opts: {
  evalueMax?: number;
  identityMin?: number;
  identityMax?: number;
  queryCovMin?: number;
  subjectLenMin?: number;
  subjectLenMax?: number;
}) {
  return request<{
    total: number;
    kept: number;
    csv: string;
    filteredFasta: string | null;
    fastaCount: number;
    preview: { headers: string[]; rows: Array<Record<string, string>> };
  }>('/api/blast/filter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export function annotateBlastHits() {
  return request<{
    ok: boolean;
    hitsCsv: string;
    preview: { headers: string[]; rows: Array<Record<string, string>>; total: number };
  }>('/api/blast/annotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export function loadBlastSearchPage(page: number, pageSize: number, source: 'blast_hits_all' | 'blast_hits_filtered' = 'blast_hits_all') {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    source,
  });
  return request<{
    source: string;
    file: string;
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    preview: { headers: string[]; rows: Array<Record<string, string>>; total: number };
  }>(`/api/blast/page?${params.toString()}`);
}

// ── Compare Module ──

export type CompareTaskInfo = {
  taskId: string;
  name: string;
  module: string | null;
  referenceCount: number;
  candidateCount: number;
  nodesCount: number;
  hasNodesCsv: boolean;
};

export function loadCompareTaskInfo(taskA: string, taskB: string) {
  return request<{ taskA: CompareTaskInfo; taskB: CompareTaskInfo }>(
    `/api/compare/task-info?taskA=${encodeURIComponent(taskA)}&taskB=${encodeURIComponent(taskB)}`,
  );
}

export type CompareResult = {
  targetTaskId: string;
  operation: 'intersect' | 'merge';
  taskA: string;
  taskB: string;
  keepReferences: boolean;
  totalSequences: number;
  candidateCount: number;
  referenceCount: number;
  matchedPairs: number;
  uniqueToA?: number;
  uniqueToB?: number;
  inBoth?: number;
};

export function compareIntersect(opts: { taskA: string; taskB: string; keepReferences?: boolean; targetTaskId: string }) {
  return request<CompareResult>('/api/compare/intersect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export function compareMerge(opts: { taskA: string; taskB: string; keepReferences?: boolean; targetTaskId: string }) {
  return request<CompareResult>('/api/compare/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}
