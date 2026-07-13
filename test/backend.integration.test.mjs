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
