import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'enzymeminer-test-'));
const tasksRoot = path.join(tempRoot, 'tasks');
await fs.mkdir(tasksRoot, { recursive: true });

// Deterministic stand-in for the Biopython pairwise worker. The final short
// batch pauses long enough for the test to inspect live progress metadata.
const fakePythonPath = path.join(tempRoot, 'fake-pairwise-python.mjs');
await fs.writeFile(fakePythonPath, `#!/usr/bin/env node
import fs from 'node:fs/promises';

const [scriptPath, inputPath, outputPath] = process.argv.slice(2);
if (!scriptPath || scriptPath === '-c' || !inputPath || !outputPath) {
  process.exit(1);
}
const payload = JSON.parse(await fs.readFile(inputPath, 'utf-8'));
const count = Array.isArray(payload?.pairs) ? payload.pairs.length : 0;
const phase = String(payload?.phase || 'pairwise');
console.log('PROGRESS|' + phase + '|0|' + count);
await new Promise((resolve) => setTimeout(resolve, count < 5000 ? 350 : 20));
console.log('PROGRESS|' + phase + '|' + count + '|' + count);
await fs.writeFile(outputPath, JSON.stringify({ results: new Array(count).fill(90) }), 'utf-8');
`);
await fs.chmod(fakePythonPath, 0o755);

const fakeStats = {
  cataProBatches: [],
  solubilityBatches: [],
  ecBatches: [],
  tmItems: 0,
  legacyPredictCalls: 0,
  ebiDatabaseRequests: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fakePredictor = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/docs')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.url === '/ebi/databases' && req.method === 'GET') {
    fakeStats.ebiDatabaseRequests++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([
      { id: 'pfam', type: 'hmm', status: 'enabled', name: 'Pfam', version: '37.2', release_date: '2025-01-01', order: 1 },
      { id: 'refprot', type: 'seq', status: 'enabled', name: 'Reference Proteomes', version: '2025_01', release_date: '2025-01-01', order: 1 },
      { id: 'swissprot', type: 'seq', status: 'enabled', name: 'SwissProt', version: '2025_01', release_date: '2025-01-01', order: 2 },
      { id: 'disabled-db', type: 'seq', status: 'disabled', name: 'Disabled', version: 'old', release_date: null, order: 3 },
    ]));
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
    const results = payload.map((item, index) => String(item.sequence).startsWith('Z')
      ? { index, enzyme_name: item.name, status: 'error', message: 'simulated EC item failure' }
      : {
          index,
          enzyme_name: item.name,
          status: 'success',
          results: [{ ec: `1.1.1.${index + 1}`, score: 0.9 - index * 0.01 }],
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
process.env.EBI_HMMER_DATABASES_URL = `${fakeUrl}/ebi/databases`;
process.env.PREDICTION_BATCH_SIZE = '2';
process.env.PREDICTION_REQUEST_TIMEOUT_MS = '5000';
process.env.API_KEY = '';
process.env.ALLOWED_ORIGINS = '';
process.env.PIPELINE_PYTHON = fakePythonPath;

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
  assert.equal(health.body.version, '1.1.0');
  assert.equal(health.body.license, 'Apache-2.0');
  assert.equal(typeof health.body.tools.mmseqs, 'boolean');
  assert.deepEqual(Object.keys(health.body.pythonPackages).sort(), ['biopython', 'pandas', 'requests', 'tqdm']);

  const allowedOrigin = await fetch(`${baseUrl}/api/health`, { headers: { origin: 'http://localhost:3000' } });
  assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  const blockedOrigin = await fetch(`${baseUrl}/api/health`, { headers: { origin: 'http://evil.example' } });
  assert.equal(blockedOrigin.headers.get('access-control-allow-origin'), null);
});

test('EBI database metadata exposes only enabled sequence databases and uses its cache', async () => {
  const first = await api('/api/search/ebi/databases');
  assert.equal(first.response.status, 200);
  assert.equal(first.body.source, 'live');
  assert.deepEqual(first.body.databases.map((item) => item.id), ['refprot', 'swissprot']);
  assert.equal(first.body.databases[0].version, '2025_01');
  assert.equal(first.body.databases[0].releaseDate, '2025-01-01');
  assert.equal(first.body.databases[0].sequenceCount, 89_460_830);
  assert.equal(first.body.databases[0].sequenceCountSource, 'ebi-search-stats');

  const cached = await api('/api/search/ebi/databases');
  assert.equal(cached.response.status, 200);
  assert.equal(cached.body.source, 'cache');
  assert.equal(fakeStats.ebiDatabaseRequests, 1);
});

test('scoring results support server-side pagination', async () => {
  const taskDir = path.join(tasksRoot, 'scoring-page-task');
  await fs.mkdir(taskDir, { recursive: true });
  const rows = Array.from({ length: 61 }, (_, index) => `candidate_${index + 1},${index + 1}`);
  await fs.writeFile(path.join(taskDir, 'scored_results.csv'), `id,score\n${rows.join('\n')}\n`);

  const secondPage = await api('/api/scoring/page?taskId=scoring-page-task&page=2&pageSize=25');
  assert.equal(secondPage.response.status, 200);
  assert.equal(secondPage.body.page, 2);
  assert.equal(secondPage.body.pageSize, 25);
  assert.equal(secondPage.body.total, 61);
  assert.equal(secondPage.body.totalPages, 3);
  assert.equal(secondPage.body.preview.rows.length, 25);
  assert.equal(secondPage.body.preview.rows[0].id, 'candidate_26');

  const clampedPage = await api('/api/scoring/page?taskId=scoring-page-task&page=99&pageSize=25');
  assert.equal(clampedPage.response.status, 200);
  assert.equal(clampedPage.body.page, 3);
  assert.equal(clampedPage.body.preview.rows.length, 11);
  assert.equal(clampedPage.body.preview.rows[0].id, 'candidate_51');
});

test('alignment preview stays bounded and the generated MAFFT FASTA can be downloaded', async () => {
  const taskId = 'alignment-preview-task';
  const taskDir = path.join(tasksRoot, taskId);
  await fs.mkdir(taskDir, { recursive: true });
  const fasta = [
    '>seq1',
    'A'.repeat(300),
    '>seq2',
    `${'A'.repeat(5)}--${'A'.repeat(243)}${'C'.repeat(50)}`,
    '>seq3',
    `${'A'.repeat(240)}${'G'.repeat(60)}`,
    '',
  ].join('\n');
  await fs.writeFile(path.join(taskDir, 'scoring_input_auto.mafft.fasta'), fasta);

  const preview = await api(`/api/scoring/alignment-preview?taskId=${taskId}&start=1&end=999&limit=2`);
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.alignmentLength, 300);
  assert.equal(preview.body.totalRecords, 3);
  assert.equal(preview.body.rows.length, 2);
  assert.equal(preview.body.rows[0].segment.length, 240);
  assert.equal(preview.body.consensus, 'A'.repeat(240));
  assert.equal(preview.body.conservation.length, 240);
  assert.equal(preview.body.conservation[0], 1);
  assert.equal(preview.body.conservation[5], 0.6667);
  assert.equal(preview.body.conservation[6], 0.6667);
  assert.equal(preview.body.conservation[7], 1);
  assert.equal(preview.body.maxPreviewColumns, 240);
  assert.equal(preview.body.columnsTruncated, true);

  const referencePreview = await api(
    `/api/scoring/alignment-preview?taskId=${taskId}&start=1&end=120&limit=2&referenceId=seq2`,
  );
  assert.equal(referencePreview.response.status, 200);
  assert.equal(referencePreview.body.referenceId, 'seq2');
  assert.equal(referencePreview.body.referenceMatched, true);
  assert.equal(referencePreview.body.referenceSegment.slice(5, 7), '--');
  assert.equal(referencePreview.body.rows[0].id, 'seq2');
  assert.equal(referencePreview.body.rows[0].isReference, true);
  assert.equal(referencePreview.body.rows[1].id, 'seq1');

  const pagedReferencePreview = await api(
    `/api/scoring/alignment-preview?taskId=${taskId}&start=1&end=120&limit=1&offset=2&referenceId=seq2`,
  );
  assert.equal(pagedReferencePreview.response.status, 200);
  assert.equal(pagedReferencePreview.body.rows[0].id, 'seq3');
  assert.equal(pagedReferencePreview.body.rows[0].isReference, false);
  assert.equal(pagedReferencePreview.body.referenceSegment.slice(5, 7), '--');

  const finalWindow = await api(`/api/scoring/alignment-preview?taskId=${taskId}&start=241&end=999`);
  assert.equal(finalWindow.response.status, 200);
  assert.equal(finalWindow.body.start, 241);
  assert.equal(finalWindow.body.end, 300);
  assert.equal(finalWindow.body.rows[0].segment.length, 60);
  assert.equal(finalWindow.body.columnsTruncated, false);
  assert.equal(finalWindow.body.consensus[0], 'A');
  assert.equal(finalWindow.body.conservation[0], 0.6667);

  const download = await api(`/api/scoring/alignment-download?taskId=${taskId}`);
  assert.equal(download.response.status, 200);
  assert.match(download.response.headers.get('content-type') || '', /^text\/x-fasta/);
  assert.match(
    download.response.headers.get('content-disposition') || '',
    /filename="scoring_input_auto\.mafft\.fasta"/,
  );
  assert.equal(download.body, fasta);

  const unsupported = await api(`/api/scoring/alignment-download?taskId=${taskId}&alignment=other.fasta`);
  assert.equal(unsupported.response.status, 400);
});

test('similarity load and normal compute reuse the exact existing CSV files without recalculation', async () => {
  const taskId = 'similarity-cache-task';
  const taskDir = path.join(tasksRoot, taskId);
  await fs.mkdir(taskDir, { recursive: true });
  const nodesCsv = [
    'id,cluster,cluster_size,is_reference',
    'candidate_1,Cluster_0,2,0',
    'candidate_2,Cluster_0,2,0',
    'reference_1,Reference,1,1',
  ].join('\n') + '\n';
  const edgesCsv = [
    'source,target,similarity,weight,cluster',
    'candidate_1,candidate_2,91.5,0.915,Cluster_0',
    'reference_1,candidate_1,72.0,0.72,Reference',
  ].join('\n') + '\n';
  await fs.writeFile(path.join(taskDir, 'nodes.csv'), nodesCsv);
  await fs.writeFile(path.join(taskDir, 'edges_similarity.csv'), edgesCsv);

  // Even legacy query flags must not turn the read-only Load endpoint into a computation.
  const loaded = await api(`/api/network/data?taskId=${taskId}&forceRebuild=true&similarityMethod=smith-waterman&includeReferenceLinks=false`);
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.body.generated, false);
  assert.equal(loaded.body.reused, true);
  assert.equal(loaded.body.nodeTotal, 3);
  assert.equal(loaded.body.edgeTotal, 2);

  // A normal Compute click also reuses the files. Only forceRecompute=true may replace them.
  const reused = await api(`/api/network/compute-similarity?taskId=${taskId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      similarityMethod: 'smith-waterman',
      includeReferenceLinks: false,
      forceRecompute: false,
    }),
  });
  assert.equal(reused.response.status, 200);
  assert.equal(reused.body.reused, true);
  assert.equal(reused.body.generated, false);
  assert.equal(reused.body.nodes, 3);
  assert.equal(reused.body.edges, 2);
  assert.equal(reused.body.recomputedAt, null);
  assert.equal(await fs.readFile(path.join(taskDir, 'nodes.csv'), 'utf-8'), nodesCsv);
  assert.equal(await fs.readFile(path.join(taskDir, 'edges_similarity.csv'), 'utf-8'), edgesCsv);
  await assert.rejects(fs.access(path.join(taskDir, 'network_build_meta.json')));

  const legacyStatus = await api(`/api/network/similarity-status?taskId=${taskId}&similarityMethod=smith-waterman&includeReferenceLinks=false`);
  assert.equal(legacyStatus.response.status, 200);
  assert.equal(legacyStatus.body.state, 'legacy');

  const missing = await api('/api/network/data?taskId=similarity-cache-missing');
  assert.equal(missing.response.status, 404);
  assert.match(String(missing.body.message || ''), /Compute sequence similarity first/i);
});

test('similarity uses exactly the clustered FASTA representatives and rebuilds stale artifacts', async () => {
  const taskId = 'clustered-similarity-input-task';
  const taskDir = path.join(tasksRoot, taskId);
  await fs.mkdir(taskDir, { recursive: true });

  const clusteredFastaPath = path.join(taskDir, 'candidates_cdhit85.fasta');
  await fs.writeFile(clusteredFastaPath, [
    '>candidate_A',
    'AAAAAAAAAA',
    '>candidate_C',
    'CCCCCCCCCC',
    '',
  ].join('\n'));
  await fs.writeFile(`${clusteredFastaPath}.clstr`, [
    '>Cluster 0',
    '0 10aa, >candidate_A... *',
    '1 10aa, >candidate_B... at 90.00%',
    '>Cluster 1',
    '0 10aa, >candidate_C... *',
    '',
  ].join('\n'));

  // Simulate similarity CSVs created before a new clustering run. The stale
  // marker must prevent a normal Compute click from reusing these entries.
  await fs.writeFile(path.join(taskDir, 'nodes.csv'), 'id,is_reference\nobsolete_candidate,0\n');
  await fs.writeFile(
    path.join(taskDir, 'edges_similarity.csv'),
    'source,target,similarity,weight,cluster\nobsolete_candidate,old_peer,90,0.9,Old\n',
  );
  await fs.writeFile(path.join(taskDir, '.network_similarity_stale.json'), JSON.stringify({
    reason: 'clustering-output-changed',
    sourceFastaPath: clusteredFastaPath,
  }));

  const staleLoad = await api(`/api/network/data?taskId=${taskId}`);
  assert.equal(staleLoad.response.status, 409);
  assert.equal(staleLoad.body.stale, true);

  const computed = await api(`/api/network/compute-similarity?taskId=${taskId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      similarityMethod: 'needleman-wunsch',
      includeReferenceLinks: false,
      sourceFasta: clusteredFastaPath,
      forceRecompute: false,
    }),
  });
  assert.equal(computed.response.status, 200);
  assert.equal(computed.body.reused, false);
  assert.equal(computed.body.generated, true);
  assert.equal(computed.body.candidateNodes, 2);
  assert.equal(computed.body.referenceNodes, 0);
  assert.equal(computed.body.nodes, 2);
  assert.equal(computed.body.edges, 1);

  const loaded = await api(`/api/network/data?taskId=${taskId}`);
  assert.equal(loaded.response.status, 200);
  assert.deepEqual(loaded.body.nodes.map((row) => row.id), ['candidate_A', 'candidate_C']);
  assert.ok(!loaded.body.nodes.some((row) => row.id === 'candidate_B'));
  assert.ok(!loaded.body.nodes.some((row) => row.id === 'obsolete_candidate'));

  const status = await api(`/api/network/similarity-status?taskId=${taskId}`);
  assert.equal(status.response.status, 200);
  assert.equal(status.body.state, 'ready');
  assert.equal(status.body.stale, false);
  assert.equal(status.body.nodeTotal, 2);

  // The signature prevents a CSV built with one method from being displayed
  // as if it matched a different method. This remains a read-only check.
  const staleByMethod = await api(`/api/network/similarity-status?taskId=${taskId}&sourceFasta=${encodeURIComponent(clusteredFastaPath)}&similarityMethod=smith-waterman&includeReferenceLinks=false`);
  assert.equal(staleByMethod.response.status, 200);
  assert.equal(staleByMethod.body.state, 'stale');
  const blockedStaleLoad = await api(`/api/network/data?taskId=${taskId}&sourceFasta=${encodeURIComponent(clusteredFastaPath)}&similarityMethod=smith-waterman&includeReferenceLinks=false`);
  assert.equal(blockedStaleLoad.response.status, 409);
  assert.equal(blockedStaleLoad.body.stale, true);
  await assert.rejects(fs.access(path.join(taskDir, '.network_similarity_stale.json')));
});

test('candidate pairwise progress remains global across the final 5000-pair batch boundary', async () => {
  const taskId = 'similarity-progress-task';
  const taskDir = path.join(tasksRoot, taskId);
  await fs.mkdir(taskDir, { recursive: true });

  const candidates = Array.from({ length: 102 }, (_, index) => ({
    id: `candidate_${index + 1}`,
    sequence: `M${'A'.repeat(20)}${index % 10}`,
  }));
  const fasta = candidates.map((item) => `>${item.id}\n${item.sequence}`).join('\n') + '\n';
  const cluster = [
    '>Cluster 0',
    ...candidates.map((item, index) => `${index}\t22aa, >${item.id}... ${index === 0 ? '*' : 'at 90%'}`),
  ].join('\n') + '\n';

  await fs.writeFile(path.join(taskDir, 'candidates.fasta'), fasta);
  await fs.writeFile(path.join(taskDir, 'candidates_cdhit85.fasta'), fasta);
  await fs.writeFile(path.join(taskDir, 'candidates_cdhit85.fasta.clstr'), cluster);

  const computePromise = api(`/api/network/compute-similarity?taskId=${taskId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      forceRecompute: true,
      similarityMethod: 'needleman-wunsch',
      includeReferenceLinks: false,
      sourceFasta: 'candidates.fasta',
    }),
  });

  const expectedPairs = (102 * 101) / 2;
  let liveProgress = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const runtime = await api(`/api/runtime/logs?taskId=${taskId}&limit=50`);
    const stage = runtime.body?.meta?.networkAlignStages?.['candidate-pairwise'];
    if (runtime.body?.active && stage?.total === expectedPairs && stage.current >= 5000 && stage.current < expectedPairs) {
      liveProgress = runtime.body.meta;
      break;
    }
    await sleep(15);
  }

  assert.ok(liveProgress, 'expected to observe the final partial batch while the task was active');
  assert.equal(liveProgress.networkAlignProgress.current, 5000);
  assert.equal(liveProgress.networkAlignProgress.total, expectedPairs);
  assert.equal(liveProgress.networkAlignStages['candidate-pairwise'].current, 5000);
  assert.equal(liveProgress.networkAlignStages['candidate-pairwise'].total, expectedPairs);

  const computed = await computePromise;
  assert.equal(computed.response.status, 200);
  assert.equal(computed.body.generated, true);
  assert.equal(computed.body.nodes, 102);
  assert.equal(computed.body.edges, expectedPairs);

  const completed = await api(`/api/runtime/logs?taskId=${taskId}&limit=50`);
  assert.equal(completed.body.active, false);
  assert.equal(completed.body.meta.networkAlignProgress.current, expectedPairs);
  assert.equal(completed.body.meta.networkAlignProgress.total, expectedPairs);
  assert.equal(completed.body.meta.networkAlignStages['candidate-pairwise'].current, expectedPairs);
  assert.equal(completed.body.meta.networkAlignStages['candidate-pairwise'].total, expectedPairs);
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

  const blockedPage = await api(`/api/scoring/page?taskId=security-task&csv=${encodeURIComponent(secretPath)}`);
  assert.equal(blockedPage.response.status, 400);
  assert.doesNotMatch(JSON.stringify(blockedPage.body), /should-not-be-readable/);

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

  const readyStatus = await api('/api/network/prediction-status?taskId=prediction-task&smiles=CCO');
  assert.equal(readyStatus.response.status, 200);
  assert.equal(readyStatus.body.state, 'ready');
  assert.equal(readyStatus.body.cachedCount, 2);
  const cachedRead = await api('/api/network/predicted-metrics?taskId=prediction-task&smiles=CCO&kcatWeight=1&solubilityWeight=0&tmWeight=0');
  assert.equal(cachedRead.response.status, 200);
  assert.equal(cachedRead.body.recomputedCount, 0);
  assert.equal(cachedRead.body.rows.length, 2);

  const staleBySmiles = await api('/api/network/prediction-status?taskId=prediction-task&smiles=CCC');
  assert.equal(staleBySmiles.response.status, 200);
  assert.equal(staleBySmiles.body.state, 'stale');
  const blockedCachedRead = await api('/api/network/predicted-metrics?taskId=prediction-task&smiles=CCC');
  assert.equal(blockedCachedRead.response.status, 409);

  const beforeSmilesChange = {
    cataPro: fakeStats.cataProBatches.length,
    solubility: fakeStats.solubilityBatches.length,
    ec: fakeStats.ecBatches.length,
    tm: fakeStats.tmItems,
  };
  const changedSmiles = await requestPrediction('CCC');
  assert.equal(changedSmiles.body.recomputedCount, 2);
  assert.equal(fakeStats.cataProBatches.length, beforeSmilesChange.cataPro + 1);
  assert.equal(fakeStats.solubilityBatches.length, beforeSmilesChange.solubility);
  assert.equal(fakeStats.ecBatches.length, beforeSmilesChange.ec);
  assert.equal(fakeStats.tmItems, beforeSmilesChange.tm);

  await fs.writeFile(path.join(taskDir, 'candidates.fasta'), '>candA\nAAAAAAAAAAA\n>candB\nCCCCCCCCCC\n');
  const beforeSequenceChange = {
    cataPro: fakeStats.cataProBatches.length,
    solubility: fakeStats.solubilityBatches.length,
    ec: fakeStats.ecBatches.length,
    tm: fakeStats.tmItems,
  };
  const changedSequence = await requestPrediction('CCC');
  assert.equal(changedSequence.body.recomputedCount, 1);
  assert.equal(fakeStats.cataProBatches.length, beforeSequenceChange.cataPro + 1);
  assert.equal(fakeStats.solubilityBatches.length, beforeSequenceChange.solubility + 1);
  assert.equal(fakeStats.ecBatches.length, beforeSequenceChange.ec + 1);
  assert.equal(fakeStats.tmItems, beforeSequenceChange.tm + 1);

  const meta = JSON.parse(await fs.readFile(path.join(taskDir, 'predicted_metrics.meta.json'), 'utf-8'));
  assert.equal(meta.version, 2);
  assert.equal(meta.smiles, 'CCC');
  assert.equal(meta.predictors.tm.mode, 'real');
  assert.equal(fakeStats.legacyPredictCalls, 0);
  assert.match(meta.fingerprint, /^[a-f0-9]{64}$/);
});


test('normal Run reuses a cached EC mock fallback instead of retrying EC', async () => {
  const taskId = 'ec-mock-cache-task';
  const taskDir = path.join(tasksRoot, taskId);
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(path.join(taskDir, 'nodes.csv'), 'id,is_reference\necFallback,0\n');
  await fs.writeFile(path.join(taskDir, 'candidates.fasta'), '>ecFallback\nZZZZZZZZZZ\n');

  const requestPrediction = (forceRecompute = false) => api(`/api/network/predict-metrics?taskId=${taskId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ smiles: 'CCO', forceRecompute }),
  });
  const counts = () => ({
    cataPro: fakeStats.cataProBatches.length,
    solubility: fakeStats.solubilityBatches.length,
    ec: fakeStats.ecBatches.length,
    tm: fakeStats.tmItems,
  });

  const beforeFirst = counts();
  const first = await requestPrediction();
  assert.equal(first.response.status, 200);
  assert.equal(first.body.recomputedCount, 1);
  assert.equal(first.body.rows[0].sources.ec, 'mock');
  assert.deepEqual(counts(), {
    cataPro: beforeFirst.cataPro + 1,
    solubility: beforeFirst.solubility + 1,
    ec: beforeFirst.ec + 1,
    tm: beforeFirst.tm + 1,
  });

  const afterFirst = counts();
  const cached = await requestPrediction();
  assert.equal(cached.response.status, 200);
  assert.equal(cached.body.recomputedCount, 0);
  assert.equal(cached.body.rows[0].sources.ec, 'mock');
  assert.equal(cached.body.rows[0].ec_top1, first.body.rows[0].ec_top1);
  assert.deepEqual(counts(), afterFirst, 'ordinary Run must not call any predictor when cache inputs match');

  const forced = await requestPrediction(true);
  assert.equal(forced.response.status, 200);
  assert.equal(forced.body.recomputedCount, 1);
  assert.deepEqual(counts(), {
    cataPro: afterFirst.cataPro + 1,
    solubility: afterFirst.solubility + 1,
    ec: afterFirst.ec + 1,
    tm: afterFirst.tm + 1,
  });
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


test('recommended CSV export merges sequence, source metadata, recommendation scores, and predictions', async () => {
  const taskId = 'recommended-export-task';
  const taskDir = path.join(tasksRoot, taskId);
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(
    path.join(taskDir, 'candidates.fasta'),
    '>sp|P12345|TEST_ENZYME exported candidate\nMKTIIALSYIFCLVFADY\n',
  );
  await fs.writeFile(
    path.join(taskDir, 'hits_filtered.csv'),
    [
      'target,hmm_score,evalue,length,sequence,uniprot_accession,uniprot_identifier,taxonomy_id,kingdom,phylum,class,species,description,external_link',
      'P12345,245.7,1e-40,18,,P12345,TEST_ENZYME,9606,Eukaryota,Chordata,Mammalia,Homo sapiens,"Oxidase, alpha ""test""",https://example.test/P12345',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(taskDir, 'predicted_metrics.csv'),
    [
      'id,kcat,km,solubility,tm,ec_top1,ec_score1,ec_top2,ec_score2,ec_top3,ec_score3,cataPro_source,solubility_source,tm_source,ec_source',
      'P12345,20,4,0.82,68.5,1.1.1.1,0.91,2.2.2.2,0.12,,,real,real,real,real',
    ].join('\n'),
  );

  const candidate = {
    id: 'P12345',
    cluster: 'P12345',
    cluster_size: 7,
    networkComponent: 'P12345',
    networkComponentSize: 7,
    representative: true,
    kingdom: 'Eukaryota',
    phylum: 'Chordata',
    class: 'Mammalia',
    order: 'Primates',
    family: 'Hominidae',
    genus: 'Homo',
    species: 'Homo sapiens',
    avgRefSimilarity: 0.72,
    maxRefSimilarity: 0.88,
    clusterSizeNorm: 0.7,
    networkComponentSizeNorm: 0.7,
    taxonomyDiversity: 0.5,
    predictedScore: 0.81,
    score: 0.84,
    refEdgeCount: 3,
  };
  const result = await api(`/api/network/export-recommended-csv?taskId=${taskId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [candidate.id], candidates: [candidate] }),
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.body.foundCount, 1);
  assert.equal(result.body.requestedCount, 1);
  const [headerLine, rowLine] = result.body.csv.split('\n');
  const parseLine = (line) => {
    const cells = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
      if (line[index] === '"') {
        if (quoted && line[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = !quoted;
        }
      } else if (line[index] === ',' && !quoted) {
        cells.push(cell);
        cell = '';
      } else {
        cell += line[index];
      }
    }
    cells.push(cell);
    return cells;
  };
  const headers = parseLine(headerLine);
  const values = parseLine(rowLine);
  const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  assert.equal(row.id, 'P12345');
  assert.equal(row.sequence, 'MKTIIALSYIFCLVFADY');
  assert.equal(row.length, '18');
  assert.equal(row.hmm_score, '245.7');
  assert.equal(row.uniprot_identifier, 'TEST_ENZYME');
  assert.equal(row.description, 'Oxidase, alpha "test"');
  assert.equal(row.order, 'Primates');
  assert.equal(row.recommendation_score, '0.84');
  assert.equal(row.kcat, '20');
  assert.equal(row.km, '4');
  assert.equal(row.catalytic_efficiency, '5');
  assert.equal(row.solubility, '0.82');
  assert.equal(row.tm, '68.5');
  assert.equal(row.ec_top1, '1.1.1.1');
  assert.equal(row.predicted_score, '0.81');
});

test('manual filtering supports five simulated candidate-screening scenarios', async (t) => {
  const taskId = 'manual-filter-task';
  const taskDir = path.join(tasksRoot, taskId);
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(
    path.join(taskDir, 'candidates.fasta'),
    [
      '>candA', 'AAAAAAAAAA',
      '>candB', 'BBBBBBBBBBBB',
      '>candC', 'CCCCCCCC',
      '>candD', 'DDDDDDDDDDDDDD',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(taskDir, 'hits_filtered.csv'),
    [
      'target,hmm_score,evalue,uniprot_accession,uniprot_identifier,taxonomy_id,kingdom,phylum,class,species,description',
      'candA,200,1e-30,A0,A_ZERO,1,Bacteria,Firmicutes,Bacilli,Species A,Alpha oxidase',
      'candB,150,1e-20,B0,B_ZERO,2,Bacteria,Proteobacteria,Gammaproteobacteria,Species B,Beta oxidase',
      'candC,100,1e-10,C0,C_ZERO,3,Eukaryota,Chordata,Mammalia,Species C,Gamma enzyme',
      'candD,50,1e-5,D0,D_ZERO,4,Archaea,Euryarchaeota,Methanobacteria,Species D,Delta enzyme',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(taskDir, 'predicted_metrics.csv'),
    [
      'id,kcat,km,solubility,tm,ec_top1,ec_score1,ec_top2,ec_score2,ec_top3,ec_score3,cataPro_source,solubility_source,tm_source,ec_source',
      'candA,20,2,0.8,65,1.1.3.1,0.9,2.2.2.2,0.1,3.3.3.3,0.05,real,real,real,real',
      'candB,30,10,0.7,70,4.4.4.4,0.8,1.1.3.2,0.7,5.5.5.5,0.1,real,real,real,real',
      'candC,5,0.5,0.9,55,6.6.6.6,0.8,7.7.7.7,0.2,1.1.3.3,0.6,real,real,real,real',
      'candD,1,1,0.2,40,8.8.8.8,0.9,9.9.9.9,0.1,0.0.0.0,0.05,mock,mock,mock,mock',
    ].join('\n'),
  );

  const filter = (body) => api(`/api/network/filter-predicted-candidates?taskId=${taskId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ includeAllIds: true, page: 1, pageSize: 50, ...body }),
  });

  await t.test('scenario 1: EC substring matches any of the top three EC predictions', async () => {
    const result = await filter({
      conditions: [{ field: 'ec', operator: 'contains', value: '1.1.3', ecScope: 'any' }],
      sort: { field: 'id', direction: 'asc' },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.totalPredicted, 4);
    assert.equal(result.body.filteredCount, 3);
    assert.deepEqual(result.body.matchingIds, ['candA', 'candB', 'candC']);
    assert.equal(result.body.rows[0].length, 10);
    assert.equal(result.body.rows[0].hmm_score, 200);
    assert.equal(result.body.rows[0].species, 'Species A');
  });

  await t.test('scenario 2: EC substring can be restricted to top-1 only', async () => {
    const result = await filter({
      conditions: [{ field: 'ec', operator: 'contains', value: '1.1.3', ecScope: 'top1' }],
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.filteredCount, 1);
    assert.deepEqual(result.body.matchingIds, ['candA']);
  });

  await t.test('scenario 3: EC and kcat conditions are combined with AND', async () => {
    const result = await filter({
      conditions: [
        { field: 'ec', operator: 'contains', value: '1.1.3', ecScope: 'any' },
        { field: 'kcat', operator: 'gt', value: 15 },
      ],
      sort: { field: 'kcat', direction: 'desc' },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.filteredCount, 2);
    assert.deepEqual(result.body.matchingIds, ['candB', 'candA']);
    assert.equal(result.body.rows[0].catalytic_efficiency, 3);
  });

  await t.test('scenario 4: derived kcat/Km and solubility range filters work together', async () => {
    const result = await filter({
      conditions: [
        { field: 'catalytic_efficiency', operator: 'gt', value: 5 },
        { field: 'solubility', operator: 'between', value: 0.75, value2: 0.95 },
      ],
      sort: { field: 'solubility', direction: 'asc' },
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.matchingIds, ['candA', 'candC']);
  });

  await t.test('scenario 5: server-side sorting, pagination, and select-all IDs stay consistent', async () => {
    const request = {
      conditions: [
        { field: 'ec', operator: 'contains', value: '1.1.3', ecScope: 'any' },
        { field: 'kcat', operator: 'gt', value: 15 },
      ],
      sort: { field: 'kcat', direction: 'desc' },
      pageSize: 1,
    };
    const firstPage = await filter(request);
    const secondPage = await filter({ ...request, page: 2 });
    assert.equal(firstPage.response.status, 200);
    assert.equal(firstPage.body.totalPages, 2);
    assert.equal(firstPage.body.rows.length, 1);
    assert.equal(firstPage.body.rows[0].id, 'candB');
    assert.equal(secondPage.body.rows[0].id, 'candA');
    assert.deepEqual(firstPage.body.matchingIds, ['candB', 'candA']);
    assert.deepEqual(secondPage.body.matchingIds, ['candB', 'candA']);
  });

  // A blank numeric field is ignored rather than accidentally excluding every row.
  const blankNumericCondition = await filter({
    conditions: [{ field: 'kcat', operator: 'gte', value: '' }],
    sort: { field: 'id', direction: 'asc' },
  });
  assert.equal(blankNumericCondition.body.filteredCount, 4);

  // The selected filtered rows remain compatible with the complete CSV export path.
  const csvExport = await api(`/api/network/export-recommended-csv?taskId=${taskId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ids: ['candA'],
      predictedSubWeights: { kcat: 1, solubility: 0, tm: 0 },
      predictedTmTarget: 60,
    }),
  });
  assert.equal(csvExport.response.status, 200);
  const csvLines = csvExport.body.csv.split('\n');
  const csvHeaders = csvLines[0].split(',');
  const csvValues = csvLines[1].split(',');
  const csvRow = Object.fromEntries(csvHeaders.map((header, index) => [header, csvValues[index]]));
  assert.equal(csvRow.id, 'candA');
  assert.equal(csvRow.catalytic_efficiency, '10');
  assert.notEqual(csvRow.predicted_score, '');

  const emptyTaskId = 'manual-filter-empty-task';
  await fs.mkdir(path.join(tasksRoot, emptyTaskId), { recursive: true });
  const empty = await api(`/api/network/filter-predicted-candidates?taskId=${emptyTaskId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ includeAllIds: true }),
  });
  assert.equal(empty.response.status, 200);
  assert.equal(empty.body.totalPredicted, 0);
  assert.deepEqual(empty.body.rows, []);
  assert.deepEqual(empty.body.matchingIds, []);
});

test('network layout persistence validates nodes and reports ready, partial, and missing states', async () => {
  const taskId = 'layout-task';
  const taskDir = path.join(tasksRoot, taskId);
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(
    path.join(taskDir, 'nodes.csv'),
    [
      'id,cluster,cluster_size,representative,is_reference',
      'nodeA,Cluster_1,2,1,0',
      'nodeB,Cluster_1,2,0,0',
    ].join('\n'),
  );

  const missing = await api(`/api/network/layout?taskId=${taskId}`);
  assert.equal(missing.response.status, 200);
  assert.equal(missing.body.state, 'missing');
  assert.equal(missing.body.exists, false);
  assert.equal(missing.body.nodeCount, 2);

  const saved = await api(`/api/network/layout?taskId=${taskId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      renderer: 'd3',
      frozen: true,
      zoom: 1.25,
      pan: { x: 12, y: -7 },
      positions: {
        nodeA: { x: 10, y: 20 },
        nodeB: { x: 30, y: 40 },
        ghost: { x: 50, y: 60 },
        invalid: { x: 'not-a-number', y: 0 },
      },
    }),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.savedCount, 2);
  assert.deepEqual(Object.keys(saved.body.layout.positions).sort(), ['nodeA', 'nodeB']);

  const ready = await api(`/api/network/layout?taskId=${taskId}`);
  assert.equal(ready.response.status, 200);
  assert.equal(ready.body.state, 'ready');
  assert.equal(ready.body.exact, true);
  assert.equal(ready.body.matchingCount, 2);
  assert.equal(ready.body.layout.zoom, 1.25);
  assert.deepEqual(ready.body.layout.pan, { x: 12, y: -7 });

  await fs.appendFile(path.join(taskDir, 'nodes.csv'), '\nnodeC,Cluster_2,1,1,0');
  const partial = await api(`/api/network/layout?taskId=${taskId}`);
  assert.equal(partial.response.status, 200);
  assert.equal(partial.body.state, 'partial');
  assert.equal(partial.body.exact, false);
  assert.equal(partial.body.matchingCount, 2);
  assert.equal(partial.body.nodeCount, 3);

  const cleared = await api(`/api/network/layout?taskId=${taskId}`, { method: 'DELETE' });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.body.cleared, true);

  const missingAgain = await api(`/api/network/layout?taskId=${taskId}`);
  assert.equal(missingAgain.response.status, 200);
  assert.equal(missingAgain.body.state, 'missing');
  assert.equal(missingAgain.body.exists, false);
});

test('recommendation uses the same optional filtered candidate pool as manual filtering', async () => {
  const taskId = 'recommend-filter-task';
  const taskDir = path.join(tasksRoot, taskId);
  await fs.mkdir(taskDir, { recursive: true });
  await fs.writeFile(
    path.join(taskDir, 'candidates.fasta'),
    [
      '>candA', 'AAAAAAAAAA',
      '>candB', 'BBBBBBBBBB',
      '>candC', 'CCCCCCCCCC',
      '>candD', 'DDDDDDDDDD',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(taskDir, 'nodes.csv'),
    [
      'id,cluster,cluster_size,representative,is_reference,kingdom,phylum,class,order,family,genus,species',
      'ref1,Reference,1,1,1,Bacteria,ReferencePhylum,ReferenceClass,ReferenceOrder,ReferenceFamily,ReferenceGenus,Reference species',
      'candA,Cluster_1,2,1,0,Bacteria,Firmicutes,Bacilli,OrderA,FamilyA,GenusA,Species A',
      'candB,Cluster_1,2,0,0,Bacteria,Proteobacteria,Gammaproteobacteria,OrderB,FamilyB,GenusB,Species B',
      'candC,Cluster_2,2,1,0,Eukaryota,Chordata,Mammalia,OrderC,FamilyC,GenusC,Species C',
      'candD,Cluster_2,2,0,0,Archaea,Euryarchaeota,Methanobacteria,OrderD,FamilyD,GenusD,Species D',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(taskDir, 'edges_similarity.csv'),
    [
      'source,target,similarity,weight,cluster',
      'candA,candB,91,0.91,Cluster_1',
      'candC,candD,89,0.89,Cluster_2',
      'ref1,candA,88,0.88,Reference',
      'ref1,candB,86,0.86,Reference',
      'ref1,candC,84,0.84,Reference',
      'ref1,candD,82,0.82,Reference',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(taskDir, 'hits_filtered.csv'),
    [
      'target,hmm_score,evalue,uniprot_accession,uniprot_identifier,taxonomy_id,kingdom,phylum,class,species,description',
      'candA,200,1e-30,A0,A_ZERO,1,Bacteria,Firmicutes,Bacilli,Species A,Alpha oxidase',
      'candB,150,1e-20,B0,B_ZERO,2,Bacteria,Proteobacteria,Gammaproteobacteria,Species B,Beta oxidase',
      'candC,100,1e-10,C0,C_ZERO,3,Eukaryota,Chordata,Mammalia,Species C,Gamma enzyme',
      'candD,50,1e-5,D0,D_ZERO,4,Archaea,Euryarchaeota,Methanobacteria,Species D,Delta enzyme',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(taskDir, 'predicted_metrics.csv'),
    [
      'id,kcat,km,solubility,tm,ec_top1,ec_score1,ec_top2,ec_score2,ec_top3,ec_score3,cataPro_source,solubility_source,tm_source,ec_source',
      'candA,20,2,0.8,65,1.1.3.1,0.9,2.2.2.2,0.1,3.3.3.3,0.05,mock,mock,mock,mock',
      'candB,30,10,0.7,70,4.4.4.4,0.8,1.1.3.2,0.7,5.5.5.5,0.1,mock,mock,mock,mock',
      'candC,5,0.5,0.9,55,6.6.6.6,0.8,7.7.7.7,0.2,1.1.3.3,0.6,mock,mock,mock,mock',
      'candD,1,1,0.2,40,8.8.8.8,0.9,9.9.9.9,0.1,0.0.0.0,0.05,mock,mock,mock,mock',
    ].join('\n'),
  );

  const recommend = (filterConditions = []) => api(`/api/network/recommend-candidates?taskId=${taskId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      topN: 10,
      minClusterSize: 1,
      minSimilarity: 0,
      networkConnectivityThreshold: 80,
      diversityMode: 'round-robin',
      temperature: 0,
      filterConditions,
      filterLogic: 'and',
    }),
  });
  const filter = (conditions) => api(`/api/network/filter-predicted-candidates?taskId=${taskId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conditions, logic: 'and', includeAllIds: true, page: 1, pageSize: 50 }),
  });

  const unfiltered = await recommend();
  assert.equal(unfiltered.response.status, 200);
  assert.equal(unfiltered.body.totalCandidates, 4);
  assert.equal(unfiltered.body.candidatePoolCount, 4);
  assert.equal(unfiltered.body.recommendedCandidates, 4);

  const ecConditions = [{ field: 'ec', operator: 'contains', value: '1.1.3', ecScope: 'any' }];
  const [ecPreview, ecRecommendation] = await Promise.all([filter(ecConditions), recommend(ecConditions)]);
  assert.equal(ecPreview.response.status, 200);
  assert.equal(ecRecommendation.response.status, 200);
  assert.equal(ecRecommendation.body.candidatePoolCount, 3);
  assert.deepEqual(
    new Set(ecRecommendation.body.candidates.map((candidate) => candidate.id)),
    new Set(ecPreview.body.matchingIds),
  );

  const combinedConditions = [
    ...ecConditions,
    { field: 'kcat', operator: 'gt', value: 15 },
  ];
  const [combinedPreview, combinedRecommendation] = await Promise.all([
    filter(combinedConditions),
    recommend(combinedConditions),
  ]);
  assert.equal(combinedRecommendation.response.status, 200);
  assert.equal(combinedRecommendation.body.candidatePoolCount, 2);
  assert.deepEqual(
    new Set(combinedRecommendation.body.candidates.map((candidate) => candidate.id)),
    new Set(combinedPreview.body.matchingIds),
  );

  const noMatch = await recommend([{ field: 'ec', operator: 'contains', value: '42.42.42', ecScope: 'any' }]);
  assert.equal(noMatch.response.status, 200);
  assert.equal(noMatch.body.candidatePoolCount, 0);
  assert.equal(noMatch.body.recommendedCandidates, 0);
  assert.deepEqual(noMatch.body.candidates, []);
});

test('bundled V1.1 example loads precomputed artifacts without starting expensive calculations', async () => {
  const listed = await api('/api/examples');
  assert.equal(listed.response.status, 200);
  const example = listed.body.examples.find((item) => item.id === 'v1.1-small');
  assert.ok(example);
  assert.equal(example.requiresExternalServices, false);
  assert.equal(example.candidateCount, 12);

  const loaded = await api('/api/examples/load', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exampleId: 'v1.1-small' }),
  });
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.body.loadedFromCache, true);
  assert.equal(loaded.body.calculationsStarted, false);
  assert.equal(loaded.body.task.module, 'hmmer');
  const taskId = loaded.body.task.id;
  const taskDir = path.join(tasksRoot, taskId);

  await Promise.all([
    fs.access(path.join(taskDir, 'nodes.csv')),
    fs.access(path.join(taskDir, 'edges_similarity.csv')),
    fs.access(path.join(taskDir, 'predicted_metrics.csv')),
    fs.access(path.join(taskDir, 'network_layout.json')),
  ]);

  const similarityStatus = await api(`/api/network/similarity-status?taskId=${taskId}`);
  assert.equal(similarityStatus.response.status, 200);
  assert.equal(similarityStatus.body.state, 'ready');

  const predictionStatus = await api(`/api/network/prediction-status?taskId=${taskId}`);
  assert.equal(predictionStatus.response.status, 200);
  assert.equal(predictionStatus.body.state, 'ready');
  assert.equal(predictionStatus.body.candidateCount, 12);

  const graph = await api(`/api/network/browser-graph?taskId=${taskId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairwiseThresholdPct: 0, maxEdges: 1000 }),
  });
  assert.equal(graph.response.status, 200);
  assert.equal(graph.body.nodeCount, 14);
  assert.equal(graph.body.edgeCount, 53);

  const layout = await api(`/api/network/layout?taskId=${taskId}`);
  assert.equal(layout.response.status, 200);
  assert.equal(layout.body.state, 'ready');
  assert.equal(layout.body.layout.frozen, true);
  assert.equal(layout.body.matchingCount, 14);

  const recommendation = await api(`/api/network/recommend-candidates?taskId=${taskId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topN: 6, minClusterSize: 1, networkConnectivityThreshold: 75, temperature: 0 }),
  });
  assert.equal(recommendation.response.status, 200);
  assert.equal(recommendation.body.totalCandidates, 12);
  assert.equal(recommendation.body.candidatePoolCount, 12);
  assert.equal(recommendation.body.recommendedCandidates, 6);

  const runtime = await api(`/api/runtime/logs?taskId=${taskId}&limit=200`);
  assert.equal(runtime.response.status, 200);
  const logText = (runtime.body.lines || []).join('\n').toLowerCase();
  assert.equal(logText.includes('compute-similarity'), false);
  assert.equal(logText.includes('predict-metrics'), false);
});
