import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';

const REPORT_SCHEMA_VERSION = '1.0';

// Tsinghua University visual identity primary purple: RGB 102/8/116 (#660874).
const TSINGHUA_PURPLE = '#660874';
const DEFAULT_SCORING_RULES = [
  { pos: 13, allowed: ['G'], score: 5, label: 'FAD_13_G' },
  { pos: 15, allowed: ['G'], score: 5, label: 'FAD_15_G' },
  { pos: 18, allowed: ['G'], score: 5, label: 'FAD_18_G' },
  { pos: 660, allowed: ['Uni'], score: -0.1, label: 'PTS_660' },
];
const TEMPLATE_FILES = {
  en: 'task-report.en.md',
  zh: 'task-report.zh.md',
};

const ARTIFACT_DEFINITIONS = [
  ['ref.csv', 'Reference metadata'],
  ['ref.fasta', 'Reference FASTA'],
  ['ref.hmm', 'HMM profile'],
  ['ref_cdhit90.fasta', 'Deduplicated reference FASTA'],
  ['blast_ref_dedup.fasta', 'Deduplicated BLAST reference FASTA'],
  ['hits_all.csv', 'All HMMER hits'],
  ['hits_filtered.csv', 'Filtered HMMER hits'],
  ['hits_filtered.fasta', 'Filtered HMMER FASTA'],
  ['blast_hits_all.csv', 'All BLAST hits'],
  ['blast_hits_filtered.csv', 'Filtered BLAST hits'],
  ['blast_hits_filtered.fasta', 'Filtered BLAST FASTA'],
  ['scoring_input_auto.fasta', 'Scoring input FASTA'],
  ['scoring_input_auto.mafft.fasta', 'Multiple sequence alignment'],
  ['scored_results.csv', 'Active-site scores'],
  ['scored_passed.fasta', 'Active-site passed FASTA'],
  ['candidates.fasta', 'Candidate FASTA'],
  ['candidates_cdhit85.fasta', 'Clustered candidate FASTA'],
  ['merged_sequences.fasta', 'Compared/merged sequence FASTA'],
  ['nodes.csv', 'Similarity network nodes'],
  ['edges_similarity.csv', 'Similarity network edges'],
  ['predicted_metrics.csv', 'Property predictions'],
  ['predicted_metrics.meta.json', 'Property prediction cache metadata'],
  ['network_layout.json', 'Saved similarity network layout'],
];

const I18N = {
  en: {
    yes: 'Yes', no: 'No', available: 'Available', missing: 'Missing', notRun: 'Not run', notAvailable: 'Not available',
    completed: 'Completed', skipped: 'Skipped', running: 'Running', failed: 'Failed', idle: 'Not started', partial: 'Partial',
    taskName: 'Task name', taskId: 'Task ID', workflow: 'Workflow', created: 'Created', updated: 'Last updated', generated: 'Report generated',
    softwareVersion: 'EnzyMiner Pro version', license: 'License', reportStatus: 'Report status', schema: 'Report schema',
    metric: 'Metric', count: 'Count', step: 'Step', status: 'Status', input: 'Input', output: 'Output',
    references: 'Reference sequences', rawHits: 'Raw search hits', filteredHits: 'Search-filtered candidates', alignment: 'Alignment sequences',
    scoringPassed: 'Active-site passed candidates', clustered: 'Clustered/network input candidates', networkCandidates: 'Network candidates',
    predicted: 'Candidates with property predictions', manualFiltered: 'Candidates matching applied filters', recommendationPool: 'Recommendation candidate pool',
    recommended: 'Recommended candidates', noWarnings: 'No data-integrity warnings were detected from the available task artifacts.',
    noData: 'No corresponding artifact is currently available for this task.',
    file: 'File', type: 'Description', records: 'Records', size: 'Size', modified: 'Modified',
    source: 'Source', mode: 'Mode', value: 'Value', parameter: 'Parameter',
  },
  zh: {
    yes: '是', no: '否', available: '存在', missing: '缺失', notRun: '未运行', notAvailable: '不可用',
    completed: '已完成', skipped: '已跳过', running: '运行中', failed: '失败', idle: '未开始', partial: '部分完成',
    taskName: '任务名称', taskId: '任务 ID', workflow: '工作流', created: '创建时间', updated: '最后更新时间', generated: '报告生成时间',
    softwareVersion: 'EnzyMiner Pro 版本', license: '许可证', reportStatus: '报告状态', schema: '报告模板结构版本',
    metric: '指标', count: '数量', step: '步骤', status: '状态', input: '输入', output: '输出',
    references: '参考序列', rawHits: '原始搜索结果', filteredHits: '搜索筛选后候选序列', alignment: '进入比对的序列',
    scoringPassed: '通过活性位点打分的序列', clustered: '聚类/网络输入候选序列', networkCandidates: '网络候选节点',
    predicted: '具有性质预测的候选序列', manualFiltered: '满足人工筛选条件的序列', recommendationPool: '推荐候选池',
    recommended: '最终推荐序列', noWarnings: '根据当前任务中可用的产物，未发现数据完整性警告。',
    noData: '当前任务中没有对应的结果文件。',
    file: '文件', type: '说明', records: '记录数', size: '大小', modified: '修改时间',
    source: '来源', mode: '模式', value: '值', parameter: '参数',
  },
};

function normalizeLanguage(value) {
  return String(value || '').toLowerCase() === 'zh' ? 'zh' : 'en';
}

function safeCell(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim() || '—';
}

function markdownTable(headers, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  return [
    `| ${headers.map(safeCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(safeCell).join(' | ')} |`),
  ].join('\n');
}

function bulletList(items) {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '';
}

function reportScoringRules(rawRules) {
  const source = Array.isArray(rawRules) && rawRules.length ? rawRules : DEFAULT_SCORING_RULES;
  return source.flatMap((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return [];
    const pos = Number(rule.pos);
    const score = Number(rule.score);
    const allowed = Array.isArray(rule.allowed)
      ? rule.allowed.map((value) => String(value ?? '').trim()).filter(Boolean)
      : [];
    const label = String(rule.label ?? '').trim();
    if (!Number.isInteger(pos) || pos <= 0 || !Number.isFinite(score) || !allowed.length || !label) return [];
    return [{ pos, allowed, score, label }];
  });
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('en-US').format(number) : '—';
}

function formatDecimal(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number !== 0 && (Math.abs(number) >= 100000 || Math.abs(number) < 0.001)) return number.toExponential(3);
  return number.toFixed(digits).replace(/\.?0+$/, '');
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(value, language = 'en') {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

async function readJsonSafe(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function statSafe(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function firstExisting(workDir, names) {
  for (const name of names) {
    if (!name) continue;
    const candidate = path.join(workDir, path.basename(String(name)));
    if (await statSafe(candidate)) return candidate;
  }
  return null;
}

async function scanFasta(filePath) {
  if (!filePath || !(await statSafe(filePath))) return null;
  let count = 0;
  let currentLength = 0;
  let totalLength = 0;
  let minLength = Infinity;
  let maxLength = 0;
  const sample = [];
  const finishRecord = () => {
    if (count <= 0) return;
    totalLength += currentLength;
    minLength = Math.min(minLength, currentLength);
    maxLength = Math.max(maxLength, currentLength);
  };
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.startsWith('>')) {
      finishRecord();
      count += 1;
      currentLength = 0;
      if (sample.length < 20) sample.push(line.slice(1).trim().split(/\s+/)[0] || `record_${count}`);
    } else if (count > 0) {
      currentLength += line.replace(/\s+/g, '').length;
    }
  }
  finishRecord();
  return {
    count,
    totalLength,
    minLength: count ? minLength : 0,
    maxLength,
    meanLength: count ? totalLength / count : 0,
    sample,
  };
}

async function scanCsv(filePath, { sampleLimit = 10, onRow } = {}) {
  if (!filePath || !(await statSafe(filePath))) return null;
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let headers = null;
  let count = 0;
  const sample = [];
  for await (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (headers === null) {
      if (!line.trim()) continue;
      headers = parseCsvLine(line).map((value) => value.trim());
      continue;
    }
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => { row[header] = values[index] ?? ''; });
    count += 1;
    if (sample.length < sampleLimit) sample.push(row);
    if (onRow) onRow(row, count);
  }
  return { headers: headers || [], count, sample };
}

function finiteValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function summarizeNumeric(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const sum = clean.reduce((total, value) => total + value, 0);
  const middle = Math.floor(clean.length / 2);
  const median = clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
  return { count: clean.length, mean: sum / clean.length, median, min: clean[0], max: clean[clean.length - 1] };
}

function statusLabel(status, t) {
  const normalized = String(status || 'idle').toLowerCase();
  return t[normalized] || safeCell(status);
}

function stepRowsFor(module, state, counts, t) {
  const statuses = state?.stepState || {};
  const rows = module === 'blast'
    ? [
      ['1. Reference Input', 'reference', null, counts.references],
      ['2. BLAST DB Setup', 'blast-db', counts.references, null],
      ['3. BLAST Search', 'blast-search', counts.rawHits, counts.filteredHits],
      ['4. Alignment', 'alignment', counts.filteredHits, counts.alignment],
      ['5. Active Site Scoring', 'scoring', counts.alignment, counts.scoringPassed],
      ['6. Clustering', 'clustering', counts.scoringPassed, counts.clustered],
      ['7. Similarity', 'similarity', counts.clustered, counts.networkCandidates],
      ['Property Prediction', 'prediction', counts.networkCandidates, counts.predicted],
      ['Recommendation', 'recommendation', counts.recommendationPool, counts.recommended],
    ]
    : module === 'compare'
      ? [
        ['Network Comparison', 'compare', state?.compareResult ? '2 tasks' : null, counts.networkCandidates],
        ['Similarity', 'similarity', counts.networkCandidates, counts.networkCandidates],
        ['Property Prediction', 'prediction', counts.networkCandidates, counts.predicted],
        ['Recommendation', 'recommendation', counts.recommendationPool, counts.recommended],
      ]
      : [
        ['1. Reference Input', 'reference', null, counts.references],
        ['2. HMM Build', 'hmm', counts.references, null],
        ['3. Search & Filter', 'search', counts.rawHits, counts.filteredHits],
        ['4. Alignment', 'alignment', counts.filteredHits, counts.alignment],
        ['5. Active Site Scoring', 'scoring', counts.alignment, counts.scoringPassed],
        ['6. Clustering', 'clustering', counts.scoringPassed, counts.clustered],
        ['7. Similarity', 'similarity', counts.clustered, counts.networkCandidates],
        ['Property Prediction', 'prediction', counts.networkCandidates, counts.predicted],
        ['Recommendation', 'recommendation', counts.recommendationPool, counts.recommended],
      ];

  return rows.map(([label, key, input, output]) => {
    let status = statuses[key];
    if (!status) {
      if (key === 'compare') status = state?.compareResult ? 'success' : 'idle';
      else if (key === 'prediction') status = Number(counts.predicted) > 0 ? 'success' : 'idle';
      else if (key === 'recommendation') status = Number(counts.recommended) > 0 ? 'success' : 'idle';
      else status = Number(output) > 0 ? 'success' : 'idle';
    }
    return [label, statusLabel(status, t), input === null ? '—' : formatNumber(input), output === null ? '—' : formatNumber(output)];
  });
}

function conditionDescription(condition, language) {
  const labels = language === 'zh'
    ? { contains: '包含', equals: '等于', gte: '≥', lte: '≤', gt: '>', lt: '<', between: '介于' }
    : { contains: 'contains', equals: 'equals', gte: '≥', lte: '≤', gt: '>', lt: '<', between: 'between' };
  const op = labels[condition?.operator] || condition?.operator || '—';
  const value = condition?.operator === 'between' ? `${safeCell(condition?.value)} – ${safeCell(condition?.value2)}` : safeCell(condition?.value);
  const scope = condition?.ecScope ? ` (${condition.ecScope})` : '';
  return `${safeCell(condition?.field)} ${op} ${value}${scope}`;
}

function recommendationRows(results, limit = 30) {
  return (Array.isArray(results) ? results : []).slice(0, limit).map((row, index) => [
    index + 1,
    row.id,
    formatDecimal(row.score ?? row.recommendation_score),
    formatDecimal(row.avgRefSimilarity ?? row.avg_ref_similarity),
    formatDecimal(row.maxRefSimilarity ?? row.max_ref_similarity),
    row.cluster || row.networkComponent || row.network_component || '—',
    formatDecimal(row.predictedScore ?? row.predicted_score),
    row.species || '—',
  ]);
}

function renderTemplate(template, values) {
  const unresolved = new Set();
  const rendered = template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      unresolved.add(key);
      return match;
    }
    return String(values[key] ?? '');
  });
  return { rendered: rendered.replace(/\n{4,}/g, '\n\n\n').trim() + '\n', unresolved: Array.from(unresolved) };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function markdownToHtml(markdown, language, title) {
  const lines = String(markdown || '').split(/\r?\n/);
  const output = [];
  let paragraph = [];
  let listType = null;
  let table = null;
  let quote = [];
  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };
  const flushTable = () => {
    if (!table) return;
    const [header, , ...rows] = table;
    const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    output.push('<table><thead><tr>' + cells(header).map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('') + '</tr></thead><tbody>');
    for (const row of rows) output.push('<tr>' + cells(row).map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('') + '</tr>');
    output.push('</tbody></table>');
    table = null;
  };
  const flushQuote = () => {
    if (quote.length) output.push(`<blockquote>${inlineMarkdown(quote.join(' '))}</blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushParagraph(); flushList(); flushTable(); flushQuote(); };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1] || '';
    if (/^\|.*\|\s*$/.test(line) && /^\|?\s*:?-+/.test(next)) {
      flushParagraph(); flushList(); flushQuote();
      table = [line, next];
      index += 1;
      while (index + 1 < lines.length && /^\|.*\|\s*$/.test(lines[index + 1])) table.push(lines[++index]);
      flushTable();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushAll(); output.push('<hr>'); continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushParagraph(); flushTable(); flushQuote();
      const desired = ordered ? 'ol' : 'ul';
      if (listType !== desired) { flushList(); output.push(`<${desired}>`); listType = desired; }
      output.push(`<li>${inlineMarkdown((bullet || ordered)[1])}</li>`);
      continue;
    }
    const quoted = line.match(/^>\s?(.*)$/);
    if (quoted) {
      flushParagraph(); flushList(); flushTable(); quote.push(quoted[1]); continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    paragraph.push(line.trim());
  }
  flushAll();

  const lang = language === 'zh' ? 'zh-CN' : 'en';
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
@page{size:A4;margin:16mm 14mm 18mm}*{box-sizing:border-box}body{font-family:Arial,"Microsoft YaHei","PingFang SC",sans-serif;color:#241a29;line-height:1.55;font-size:10.5pt;max-width:1000px;margin:0 auto;padding:24px}h1{font-size:24pt;color:${TSINGHUA_PURPLE};border-bottom:3px solid ${TSINGHUA_PURPLE};padding-bottom:10px}h2{font-size:16pt;color:${TSINGHUA_PURPLE};border-bottom:1px solid #d8b9dc;padding-bottom:5px;break-after:avoid}h3{font-size:12.5pt;color:#4a0555;break-after:avoid}p,li{orphans:3;widows:3}table{width:100%;border-collapse:collapse;margin:10px 0 18px;font-size:9pt;break-inside:auto}thead{display:table-header-group}tr{break-inside:avoid}th,td{border:1px solid #d8c5dc;padding:5px 7px;vertical-align:top;text-align:left;word-break:break-word}th{background:#f3eaf5;color:#4a0555}blockquote{margin:12px 0;padding:10px 14px;border-left:4px solid ${TSINGHUA_PURPLE};background:#f8f1f9;color:#514056}code{background:#f3edf4;padding:1px 4px;border-radius:3px;font-family:Consolas,monospace}hr{border:0;border-top:1px solid #d8c5dc;margin:24px 0}@media print{body{padding:0;max-width:none}h1,h2,h3{page-break-after:avoid}a{color:inherit;text-decoration:none}}
</style></head><body>${output.join('\n')}<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script></body></html>`;
}

function artifactDescription(name, description, language) {
  if (language === 'en') return description;
  const translated = {
    'Reference metadata': '参考序列元数据', 'Reference FASTA': '参考序列 FASTA', 'HMM profile': 'HMM 模型',
    'Deduplicated reference FASTA': '去重参考序列 FASTA', 'Deduplicated BLAST reference FASTA': '去重 BLAST 参考序列 FASTA',
    'All HMMER hits': '全部 HMMER 搜索结果', 'Filtered HMMER hits': '筛选后 HMMER 结果', 'Filtered HMMER FASTA': '筛选后 HMMER FASTA',
    'All BLAST hits': '全部 BLAST 搜索结果', 'Filtered BLAST hits': '筛选后 BLAST 结果', 'Filtered BLAST FASTA': '筛选后 BLAST FASTA',
    'Scoring input FASTA': '活性位点打分输入 FASTA', 'Multiple sequence alignment': '多序列比对文件', 'Active-site scores': '活性位点打分结果',
    'Active-site passed FASTA': '通过活性位点打分的 FASTA', 'Candidate FASTA': '候选序列 FASTA', 'Clustered candidate FASTA': '聚类后候选序列 FASTA',
    'Compared/merged sequence FASTA': '比较/合并后的序列 FASTA', 'Similarity network nodes': '相似性网络节点', 'Similarity network edges': '相似性网络边',
    'Property predictions': '性质预测结果', 'Property prediction cache metadata': '性质预测缓存元数据', 'Saved similarity network layout': '保存的网络布局',
  };
  return translated[description] || description || name;
}

export async function buildTaskReport({ taskId, workDir, projectRoot, appVersion, language: rawLanguage }) {
  const language = normalizeLanguage(rawLanguage);
  const t = I18N[language];
  const generatedAt = new Date();
  const warnings = [];
  const taskMeta = await readJsonSafe(path.join(workDir, 'task.json'), {});
  let module = String(taskMeta?.module || '').toLowerCase();
  if (!['hmmer', 'blast', 'compare'].includes(module)) {
    if (await statSafe(path.join(workDir, 'compare_state.json'))) module = 'compare';
    else if (await statSafe(path.join(workDir, 'blast_state.json'))) module = 'blast';
    else module = 'hmmer';
  }
  const state = await readJsonSafe(path.join(workDir, `${module}_state.json`),
    await readJsonSafe(path.join(workDir, 'pipeline_state.json'), {})) || {};
  const taskStat = await statSafe(workDir);

  const referenceFastaPath = await firstExisting(workDir, ['ref.fasta', 'ref_cdhit90.fasta', 'blast_ref_dedup.fasta']);
  const referenceCsvPath = await firstExisting(workDir, ['ref.csv']);
  const rawHitsPath = await firstExisting(workDir, module === 'blast' ? ['blast_hits_all.csv', 'hits_all.csv'] : ['hits_all.csv', 'blast_hits_all.csv']);
  const filteredHitsPath = await firstExisting(workDir, module === 'blast' ? ['blast_hits_filtered.csv', 'hits_filtered.csv'] : ['hits_filtered.csv', 'blast_hits_filtered.csv']);
  const alignmentPath = await firstExisting(workDir, ['scoring_input_auto.mafft.fasta', state?.alignmentPath]);
  const scoredPath = await firstExisting(workDir, ['scored_results.csv']);
  const scoredPassedPath = await firstExisting(workDir, ['scored_passed.fasta']);
  const clusteredPath = await firstExisting(workDir, [state?.clusteringRunInfo?.outputFasta, state?.candidateFasta, 'candidates_cdhit85.fasta', 'candidates.fasta', 'scored_passed.fasta', 'merged_sequences.fasta']);
  const nodesPath = await firstExisting(workDir, ['nodes.csv']);
  const edgesPath = await firstExisting(workDir, ['edges_similarity.csv']);
  const predictionsPath = await firstExisting(workDir, ['predicted_metrics.csv']);

  const [referenceFasta, referenceCsv, rawHits, filteredHits, alignment, scoredPassed, clustered] = await Promise.all([
    scanFasta(referenceFastaPath), scanCsv(referenceCsvPath, { sampleLimit: 20 }), scanCsv(rawHitsPath), scanCsv(filteredHitsPath),
    scanFasta(alignmentPath), scanFasta(scoredPassedPath), scanFasta(clusteredPath),
  ]);

  const references = referenceCsv?.count || referenceFasta?.count || 0;
  const scoredScores = [];
  const topScored = [];
  let scoringPassedCount = 0;
  const scoredCsv = await scanCsv(scoredPath, {
    sampleLimit: 0,
    onRow(row) {
      const score = finiteValue(row.seq_score ?? row.score);
      if (score !== null) scoredScores.push(score);
      const passed = ['1', 'true', 'yes', 'pass', 'passed'].includes(String(row.pass_rule ?? row.passed ?? '').toLowerCase());
      if (passed) scoringPassedCount += 1;
      if (score !== null) {
        topScored.push({ id: row.id || row.target || '', score, passed, length: row.length || '' });
        topScored.sort((a, b) => b.score - a.score);
        if (topScored.length > 10) topScored.pop();
      }
    },
  });
  if (!scoringPassedCount) scoringPassedCount = scoredPassed?.count || 0;

  const referenceIds = new Set();
  const clusterSizes = new Map();
  let networkCandidates = 0;
  let networkReferences = 0;
  const nodeCsv = await scanCsv(nodesPath, {
    sampleLimit: 10,
    onRow(row) {
      const id = String(row.id || '').trim();
      if (String(row.is_reference || '') === '1') {
        networkReferences += 1;
        if (id) referenceIds.add(id);
      } else {
        networkCandidates += 1;
      }
      const cluster = String(row.cluster || '').trim();
      if (cluster && String(row.is_reference || '') !== '1') clusterSizes.set(cluster, (clusterSizes.get(cluster) || 0) + 1);
    },
  });

  let edgeTotal = 0;
  let referenceEdges = 0;
  let pairwiseEdges = 0;
  let similaritySum = 0;
  let similarityCount = 0;
  await scanCsv(edgesPath, {
    sampleLimit: 0,
    onRow(row) {
      edgeTotal += 1;
      if (referenceIds.has(String(row.source || '')) || referenceIds.has(String(row.target || ''))) referenceEdges += 1;
      else pairwiseEdges += 1;
      const similarity = finiteValue(row.similarity);
      if (similarity !== null) { similaritySum += similarity; similarityCount += 1; }
    },
  });

  const predictionValues = { kcat: [], km: [], efficiency: [], solubility: [], tm: [] };
  const predictionSources = { cataPro: new Map(), solubility: new Map(), tm: new Map(), ec: new Map() };
  const topPredictions = [];
  const predictionCsv = await scanCsv(predictionsPath, {
    sampleLimit: 0,
    onRow(row) {
      const kcat = finiteValue(row.kcat);
      const km = finiteValue(row.km);
      const solubility = finiteValue(row.solubility);
      const tm = finiteValue(row.tm);
      if (kcat !== null) predictionValues.kcat.push(kcat);
      if (km !== null) predictionValues.km.push(km);
      if (kcat !== null && km !== null && km !== 0) predictionValues.efficiency.push(kcat / km);
      if (solubility !== null) predictionValues.solubility.push(solubility);
      if (tm !== null) predictionValues.tm.push(tm);
      for (const [key, column] of [['cataPro', 'cataPro_source'], ['solubility', 'solubility_source'], ['tm', 'tm_source'], ['ec', 'ec_source']]) {
        const source = String(row[column] || 'unknown').trim() || 'unknown';
        predictionSources[key].set(source, (predictionSources[key].get(source) || 0) + 1);
      }
      const score = kcat !== null && km !== null && km !== 0 ? kcat / km : -Infinity;
      topPredictions.push({ id: row.id || '', ec: [row.ec_top1, row.ec_top2, row.ec_top3].filter(Boolean).join(', '), kcat, km, efficiency: score, solubility, tm });
      topPredictions.sort((a, b) => b.efficiency - a.efficiency);
      if (topPredictions.length > 10) topPredictions.pop();
    },
  });

  const recommendFilter = state?.recommendFilter || {};
  const recommendMeta = state?.recommendMeta || {};
  const recommendResults = Array.isArray(state?.recommendResults) ? state.recommendResults : [];
  const conditions = Array.isArray(recommendFilter?.conditions) ? recommendFilter.conditions : [];
  const counts = {
    references,
    rawHits: rawHits?.count || 0,
    filteredHits: filteredHits?.count || 0,
    alignment: alignment?.count || 0,
    scoringPassed: scoringPassedCount,
    clustered: clustered?.count || 0,
    networkCandidates,
    predicted: predictionCsv?.count || 0,
    manualFiltered: conditions.length ? Number(recommendFilter?.filteredCount || 0) : 0,
    recommendationPool: Number(recommendMeta?.candidatePoolCount || (conditions.length ? recommendFilter?.filteredCount : networkCandidates) || 0),
    recommended: Number(recommendMeta?.recommendedCandidates || recommendResults.length || 0),
  };

  if (counts.filteredHits && counts.alignment && ![counts.filteredHits, counts.filteredHits + 1].includes(counts.alignment) && module !== 'compare') {
    warnings.push(language === 'zh'
      ? `搜索筛选结果包含 ${formatNumber(counts.filteredHits)} 条记录，但比对文件包含 ${formatNumber(counts.alignment)} 条序列。`
      : `The filtered search result contains ${formatNumber(counts.filteredHits)} records, while the alignment contains ${formatNumber(counts.alignment)} sequences.`);
  }
  if (counts.clustered && networkCandidates && counts.clustered !== networkCandidates) {
    warnings.push(language === 'zh'
      ? `聚类/网络输入包含 ${formatNumber(counts.clustered)} 条序列，但 nodes.csv 中包含 ${formatNumber(networkCandidates)} 个候选节点。`
      : `The clustering/network input contains ${formatNumber(counts.clustered)} sequences, while nodes.csv contains ${formatNumber(networkCandidates)} candidate nodes.`);
  }
  if (counts.predicted && networkCandidates && counts.predicted !== networkCandidates) {
    warnings.push(language === 'zh'
      ? `性质预测记录数为 ${formatNumber(counts.predicted)}，网络候选节点数为 ${formatNumber(networkCandidates)}。`
      : `Property predictions are available for ${formatNumber(counts.predicted)} records, while the network contains ${formatNumber(networkCandidates)} candidate nodes.`);
  }
  const predictionSourceNames = Object.values(predictionSources).flatMap((sources) => Array.from(sources.keys()));
  if (predictionSourceNames.includes('mock')) {
    warnings.push(language === 'zh' ? '性质预测结果中包含 Mock 模拟数据。' : 'The property prediction results include Mock data.');
  }
  if (!nodesPath && (counts.clustered || counts.predicted)) {
    warnings.push(language === 'zh' ? '未找到 nodes.csv，无法完成网络候选序列一致性检查。' : 'nodes.csv is missing, so network candidate consistency could not be verified.');
  }
  if (conditions.length && !recommendMeta?.candidatePoolCount) {
    warnings.push(language === 'zh' ? '存在已应用的人工筛选条件，但尚未保存推荐候选池统计。' : 'Applied manual filter conditions exist, but recommendation pool statistics have not been saved yet.');
  }

  const stepRows = stepRowsFor(module, state, counts, t);
  const completedSteps = stepRows.filter((row) => row[1] === t.completed).length;
  const failedSteps = stepRows.filter((row) => row[1] === t.failed).length;
  const reportStatus = failedSteps ? t.partial : completedSteps === stepRows.length ? t.completed : t.partial;

  const reportMetadataTable = markdownTable([t.parameter, t.value], [
    [t.taskName, taskMeta?.name || taskId], [t.taskId, taskId], [t.workflow, module.toUpperCase()],
    [t.created, formatDate(taskMeta?.createdAt || taskStat?.birthtimeMs, language)], [t.updated, formatDate(taskStat?.mtimeMs, language)],
    [t.generated, formatDate(generatedAt, language)], [t.softwareVersion, appVersion], [t.license, 'Apache-2.0'],
    [t.reportStatus, reportStatus], [t.schema, REPORT_SCHEMA_VERSION],
  ]);

  const summaryItems = language === 'zh'
    ? [
      `当前任务类型为 **${module.toUpperCase()}**，共检测到 ${formatNumber(references)} 条参考序列。`,
      `搜索得到 ${formatNumber(counts.rawHits)} 条原始记录，筛选后保留 ${formatNumber(counts.filteredHits)} 条。`,
      `活性位点打分后保留 ${formatNumber(counts.scoringPassed)} 条，最终网络包含 ${formatNumber(networkCandidates)} 个候选节点和 ${formatNumber(edgeTotal)} 条边。`,
      `性质预测覆盖 ${formatNumber(counts.predicted)} 条候选序列；人工筛选匹配 ${formatNumber(counts.manualFiltered)} 条。`,
      `推荐候选池为 ${formatNumber(counts.recommendationPool)} 条，最终保存的推荐结果为 ${formatNumber(counts.recommended)} 条。`,
    ]
    : [
      `This is a **${module.toUpperCase()}** task with ${formatNumber(references)} detected reference sequence(s).`,
      `The search produced ${formatNumber(counts.rawHits)} raw record(s), of which ${formatNumber(counts.filteredHits)} were retained after search-stage filtering.`,
      `${formatNumber(counts.scoringPassed)} sequence(s) passed active-site scoring; the final network contains ${formatNumber(networkCandidates)} candidate node(s) and ${formatNumber(edgeTotal)} edge(s).`,
      `Property predictions cover ${formatNumber(counts.predicted)} candidate(s), and ${formatNumber(counts.manualFiltered)} candidate(s) match the applied manual filters.`,
      `The saved recommendation pool contains ${formatNumber(counts.recommendationPool)} candidate(s), with ${formatNumber(counts.recommended)} final recommendation(s).`,
    ];

  const funnelRows = [
    [t.references, counts.references], [t.rawHits, counts.rawHits], [t.filteredHits, counts.filteredHits], [t.alignment, counts.alignment],
    [t.scoringPassed, counts.scoringPassed], [t.clustered, counts.clustered], [t.networkCandidates, counts.networkCandidates],
    [t.predicted, counts.predicted], [t.manualFiltered, counts.manualFiltered], [t.recommendationPool, counts.recommendationPool], [t.recommended, counts.recommended],
  ].filter(([, count], index) => index === 0 || Number(count) > 0);

  const referenceRows = (referenceCsv?.sample || []).slice(0, 20).map((row, index) => [
    index + 1, row.accession || row.id || row.input || referenceFasta?.sample?.[index] || '—', row.length || '—', row.species || '—', row.description || '—',
  ]);
  const referenceSection = referenceRows.length
    ? `${markdownTable(['#', language === 'zh' ? '参考序列 ID' : 'Reference ID', language === 'zh' ? '长度' : 'Length', language === 'zh' ? '物种' : 'Species', language === 'zh' ? '描述' : 'Description'], referenceRows)}\n\n${language === 'zh' ? '参考序列长度统计' : 'Reference length summary'}: ${referenceFasta ? `${formatNumber(referenceFasta.minLength)}–${formatNumber(referenceFasta.maxLength)} aa, ${language === 'zh' ? '平均' : 'mean'} ${formatDecimal(referenceFasta.meanLength, 1)} aa` : t.notAvailable}.`
    : t.noData;

  const searchParameters = module === 'blast'
    ? [
      ['Database source', state?.blastDbSource], ['NCBI database', state?.blastNcbiDb], ['E-value', state?.blastEvalue],
      ['Identity minimum (%)', state?.blastIdentityMin], ['Query coverage minimum (%)', state?.blastQueryCovMin],
      ['Subject length', state?.blastSubjectLenMin !== undefined ? `${state.blastSubjectLenMin}–${safeCell(state?.blastSubjectLenMax)}` : null],
      ['Merge strategy', state?.blastMergeStrategy],
    ]
    : module === 'compare'
      ? [['Source task A', state?.taskAId], ['Source task B', state?.taskBId], ['Operation', state?.compareResult?.operation], ['Keep references', state?.keepReferences ? t.yes : t.no]]
      : [
        ['Search mode', state?.searchMode], ['EBI database', state?.ebiDatabase], ['HMM score minimum', state?.scoreMin],
        ['Sequence length', state?.lenMin !== undefined ? `${state.lenMin}–${safeCell(state?.lenMax)}` : null], ['Identity lower bound (%)', state?.identityLowerBound],
      ];
  const validSearchParameters = searchParameters.filter(([, value]) => value !== null && value !== undefined && value !== '');
  const searchTopRows = (filteredHits?.sample || rawHits?.sample || []).slice(0, 10).map((row, index) => [
    index + 1, row.target || row.sseqid || row.id || '—', row.hmm_score || row.bitscore || '—', row.evalue || '—', row.length || row.slen || '—', row.species || '—',
  ]);
  const searchSection = [
    markdownTable([t.metric, t.count], [[t.rawHits, counts.rawHits], [t.filteredHits, counts.filteredHits]]),
    validSearchParameters.length ? `### ${language === 'zh' ? '保存的搜索参数' : 'Saved search parameters'}\n\n${markdownTable([t.parameter, t.value], validSearchParameters)}` : '',
    searchTopRows.length ? `### ${language === 'zh' ? '代表性结果（前 10 条）' : 'Representative results (first 10)'}\n\n${markdownTable(['#', 'ID', language === 'zh' ? '分数' : 'Score', 'E-value', language === 'zh' ? '长度' : 'Length', language === 'zh' ? '物种' : 'Species'], searchTopRows)}` : '',
  ].filter(Boolean).join('\n\n');

  const alignmentSection = alignment
    ? markdownTable([t.metric, t.value], [
      [language === 'zh' ? '比对文件' : 'Alignment file', path.basename(alignmentPath)],
      [language === 'zh' ? '序列数' : 'Sequences', formatNumber(alignment.count)],
      [language === 'zh' ? '比对长度' : 'Alignment length', `${formatNumber(alignment.maxLength)} columns`],
      [language === 'zh' ? '参考序列 ID' : 'Reference ID', state?.refId || '—'],
      [language === 'zh' ? '参考序列空位默认折叠' : 'Reference-gap columns collapsed by default', t.yes],
    ])
    : t.noData;

  const scoringSummary = summarizeNumeric(scoredScores);
  const scoringRules = reportScoringRules(state?.scoringRules);
  const scoringRulesTable = markdownTable(
    ['Pos', 'Allowed (comma separated)', 'Score', 'Label'],
    scoringRules.map((rule) => [rule.pos, rule.allowed.join(', '), formatDecimal(rule.score), rule.label]),
  );
  const scoringSection = scoredCsv
    ? [
      markdownTable([t.metric, t.value], [
        [language === 'zh' ? '参与打分的序列' : 'Evaluated sequences', formatNumber(scoredCsv.count)],
        [language === 'zh' ? '通过数量' : 'Passed', formatNumber(scoringPassedCount)],
        [language === 'zh' ? '打分阈值' : 'Score threshold', state?.threshold ?? '—'],
        [language === 'zh' ? '打分规则数' : 'Scoring rules', formatNumber(scoringRules.length)],
        [language === 'zh' ? '平均分' : 'Mean score', scoringSummary ? formatDecimal(scoringSummary.mean) : '—'],
        [language === 'zh' ? '中位数' : 'Median score', scoringSummary ? formatDecimal(scoringSummary.median) : '—'],
      ]),
      scoringRulesTable
        ? `### ${language === 'zh' ? '详细打分规则' : 'Detailed scoring rules'}\n\n${scoringRulesTable}`
        : '',
      topScored.length ? `### ${language === 'zh' ? '最高分序列' : 'Top-scoring sequences'}\n\n${markdownTable(['#', 'ID', language === 'zh' ? '分数' : 'Score', language === 'zh' ? '通过' : 'Passed', language === 'zh' ? '长度' : 'Length'], topScored.map((row, index) => [index + 1, row.id, formatDecimal(row.score), row.passed ? t.yes : t.no, row.length]))}` : '',
    ].filter(Boolean).join('\n\n')
    : t.noData;

  const clusterSizeValues = Array.from(clusterSizes.values());
  const clusteringSection = clustered
    ? markdownTable([t.metric, t.value], [
      [language === 'zh' ? '输入/输出文件' : 'Candidate file', path.basename(clusteredPath)],
      [language === 'zh' ? '候选序列数' : 'Candidate sequences', formatNumber(clustered.count)],
      [language === 'zh' ? '聚类 identity' : 'Cluster identity', state?.clusterIdentity ?? '—'],
      [language === 'zh' ? '网络连通分量/聚类数' : 'Network components/clusters', clusterSizes.size || '—'],
      [language === 'zh' ? '最大聚类' : 'Largest cluster', clusterSizeValues.length ? Math.max(...clusterSizeValues) : '—'],
      [language === 'zh' ? '单序列聚类' : 'Singleton clusters', clusterSizeValues.filter((value) => value === 1).length || '—'],
    ])
    : t.noData;

  const similaritySection = nodeCsv
    ? markdownTable([t.metric, t.value], [
      [language === 'zh' ? '候选节点' : 'Candidate nodes', formatNumber(networkCandidates)],
      [language === 'zh' ? '参考节点' : 'Reference nodes', formatNumber(networkReferences)],
      [language === 'zh' ? '总节点数' : 'Total nodes', formatNumber(nodeCsv.count)],
      [language === 'zh' ? '候选-候选边' : 'Candidate–candidate edges', formatNumber(pairwiseEdges)],
      [language === 'zh' ? '参考-候选边' : 'Reference–candidate edges', formatNumber(referenceEdges)],
      [language === 'zh' ? '总边数' : 'Total edges', formatNumber(edgeTotal)],
      [language === 'zh' ? '平均相似度' : 'Mean similarity', similarityCount ? `${formatDecimal(similaritySum / similarityCount, 2)}%` : '—'],
      [language === 'zh' ? '相似性方法' : 'Similarity method', state?.networkSimilarityMethod || '—'],
      [language === 'zh' ? '网络阈值' : 'Network threshold', state?.networkPairwiseThresholdPct !== undefined ? `${state.networkPairwiseThresholdPct}%` : '—'],
      [language === 'zh' ? '保存的网络布局' : 'Saved network layout', (await statSafe(path.join(workDir, 'network_layout.json'))) ? t.yes : t.no],
    ])
    : t.noData;

  const predictionMetricRows = [
    ['kcat', summarizeNumeric(predictionValues.kcat)], ['Km', summarizeNumeric(predictionValues.km)],
    ['kcat/Km', summarizeNumeric(predictionValues.efficiency)], [language === 'zh' ? '可溶性' : 'Solubility', summarizeNumeric(predictionValues.solubility)],
    ['Tm', summarizeNumeric(predictionValues.tm)],
  ].filter(([, summary]) => summary).map(([name, summary]) => [name, summary.count, formatDecimal(summary.mean), formatDecimal(summary.median), `${formatDecimal(summary.min)} – ${formatDecimal(summary.max)}`]);
  const sourceRows = Object.entries(predictionSources).flatMap(([predictor, sources]) => Array.from(sources.entries()).map(([source, count]) => [predictor, source, count]));
  const topPredictionRows = topPredictions.filter((row) => Number.isFinite(row.efficiency)).map((row, index) => [
    index + 1, row.id, row.ec || '—', formatDecimal(row.kcat), formatDecimal(row.km), formatDecimal(row.efficiency), formatDecimal(row.solubility), formatDecimal(row.tm),
  ]);
  const predictionSection = predictionCsv
    ? [
      markdownTable([t.metric, t.count, language === 'zh' ? '平均值' : 'Mean', language === 'zh' ? '中位数' : 'Median', language === 'zh' ? '范围' : 'Range'], predictionMetricRows),
      sourceRows.length ? `### ${language === 'zh' ? '预测来源' : 'Prediction sources'}\n\n${markdownTable([language === 'zh' ? '预测器' : 'Predictor', t.source, t.count], sourceRows)}` : '',
      topPredictionRows.length ? `### ${language === 'zh' ? '按 kcat/Km 排序的代表性结果' : 'Representative results ranked by kcat/Km'}\n\n${markdownTable(['#', 'ID', 'EC', 'kcat', 'Km', 'kcat/Km', language === 'zh' ? '可溶性' : 'Solubility', 'Tm'], topPredictionRows)}` : '',
    ].filter(Boolean).join('\n\n')
    : t.noData;

  const manualFilterSection = conditions.length
    ? [
      `${language === 'zh' ? '条件组合逻辑' : 'Condition logic'}: **AND**`,
      markdownTable(['#', language === 'zh' ? '已应用条件' : 'Applied condition'], conditions.map((condition, index) => [index + 1, conditionDescription(condition, language)])),
      markdownTable([t.metric, t.count], [
        [t.predicted, counts.predicted], [t.manualFiltered, counts.manualFiltered],
        [language === 'zh' ? '当前网络中候选序列' : 'Candidates in the current network', counts.networkCandidates],
      ]),
      language === 'zh'
        ? '> Recommendation 使用最近一次成功应用的筛选条件构建候选池；筛选表格中的复选框只用于人工导出。'
        : '> Recommendation builds its pool from the most recently applied filter conditions. Table checkbox selections are used only for manual export.',
    ].join('\n\n')
    : (language === 'zh'
      ? `没有有效的人工筛选条件。Recommendation 默认从全部网络候选序列构建候选池。\n\n${markdownTable([t.metric, t.count], [[t.predicted, counts.predicted], [t.networkCandidates, counts.networkCandidates]])}`
      : `No active manual filter conditions were saved. Recommendation therefore uses all network candidates as its initial pool.\n\n${markdownTable([t.metric, t.count], [[t.predicted, counts.predicted], [t.networkCandidates, counts.networkCandidates]])}`);

  const recommendationParameters = [
    ['Top N', state?.recommendTopN], ['Minimum cluster size', state?.recommendMinClusterSize], ['Minimum similarity', state?.recommendMinSimilarity],
    ['Connectivity threshold', state?.recommendNetworkConnectivityThreshold], ['Diversity mode', state?.recommendDiversityMode], ['Temperature', state?.recommendTemperature],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  const weightRows = Object.entries(state?.recommendWeights || {}).map(([key, value]) => [key, formatDecimal(value)]);
  const recommendationSection = counts.recommended || recommendMeta || recommendResults.length
    ? [
      markdownTable([t.metric, t.count], [
        [t.networkCandidates, counts.networkCandidates], [t.manualFiltered, counts.manualFiltered], [t.recommendationPool, counts.recommendationPool],
        [language === 'zh' ? '被最小聚类大小排除' : 'Excluded by minimum cluster size', Number(recommendMeta?.filteredByClusterSize || 0)],
        [language === 'zh' ? '被相似度阈值排除' : 'Excluded by similarity threshold', Number(recommendMeta?.filteredBySimilarity || 0)],
        [t.recommended, counts.recommended],
      ]),
      recommendationParameters.length ? `### ${language === 'zh' ? '推荐参数' : 'Recommendation parameters'}\n\n${markdownTable([t.parameter, t.value], recommendationParameters)}` : '',
      weightRows.length ? `### ${language === 'zh' ? '推荐权重' : 'Recommendation weights'}\n\n${markdownTable([language === 'zh' ? '评分项' : 'Score component', language === 'zh' ? '权重' : 'Weight'], weightRows)}` : '',
      recommendResults.length ? `### ${language === 'zh' ? '推荐序列（最多显示 30 条）' : 'Recommended candidates (up to 30)'}\n\n${markdownTable(['#', 'ID', language === 'zh' ? '总分' : 'Score', language === 'zh' ? '平均参考相似度' : 'Avg ref sim.', language === 'zh' ? '最大参考相似度' : 'Max ref sim.', language === 'zh' ? '聚类' : 'Cluster', language === 'zh' ? '性质预测分' : 'Predicted score', language === 'zh' ? '物种' : 'Species'], recommendationRows(recommendResults))}` : '',
    ].filter(Boolean).join('\n\n')
    : t.noData;

  const knownRecordCounts = new Map();
  const rememberCount = (filePath, scan) => {
    if (filePath && scan && Number.isFinite(Number(scan.count))) {
      knownRecordCounts.set(path.resolve(filePath), Number(scan.count));
    }
  };
  rememberCount(referenceFastaPath, referenceFasta);
  rememberCount(referenceCsvPath, referenceCsv);
  rememberCount(rawHitsPath, rawHits);
  rememberCount(filteredHitsPath, filteredHits);
  rememberCount(alignmentPath, alignment);
  rememberCount(scoredPath, scoredCsv);
  rememberCount(scoredPassedPath, scoredPassed);
  rememberCount(clusteredPath, clustered);
  rememberCount(nodesPath, nodeCsv);
  rememberCount(predictionsPath, predictionCsv);
  if (edgesPath) knownRecordCounts.set(path.resolve(edgesPath), edgeTotal);

  const artifactRows = [];
  for (const [name, description] of ARTIFACT_DEFINITIONS) {
    const filePath = path.join(workDir, name);
    const stat = await statSafe(filePath);
    if (!stat?.isFile()) continue;
    let records = '—';
    const knownCount = knownRecordCounts.get(path.resolve(filePath));
    if (knownCount !== undefined) records = formatNumber(knownCount);
    else if (name.endsWith('.csv')) records = formatNumber((await scanCsv(filePath, { sampleLimit: 0 }))?.count || 0);
    else if (name.endsWith('.fasta')) records = formatNumber((await scanFasta(filePath))?.count || 0);
    artifactRows.push([name, artifactDescription(name, description, language), records, formatBytes(stat.size), formatDate(stat.mtimeMs, language)]);
  }
  const artifactsSection = artifactRows.length ? markdownTable([t.file, t.type, t.records, t.size, t.modified], artifactRows) : t.noData;

  const reproducibilitySection = markdownTable([t.parameter, t.value], [
    [t.taskId, taskId], [t.workflow, module.toUpperCase()], [t.softwareVersion, appVersion], [t.schema, REPORT_SCHEMA_VERSION],
    [language === 'zh' ? '报告语言' : 'Report language', language === 'zh' ? '中文' : 'English'],
    [language === 'zh' ? '报告模板' : 'Report template', TEMPLATE_FILES[language]],
    [language === 'zh' ? '性质预测模式' : 'Property prediction mode', predictionSourceNames.length ? Array.from(new Set(predictionSourceNames)).join(', ') : t.notRun],
    [language === 'zh' ? '缓存元数据' : 'Prediction cache metadata', (await statSafe(path.join(workDir, 'predicted_metrics.meta.json'))) ? t.available : t.missing],
    [t.license, 'Apache-2.0'],
  ]);

  const templatePath = path.join(projectRoot, 'report-templates', TEMPLATE_FILES[language]);
  const template = await fs.readFile(templatePath, 'utf8');
  const values = {
    report_metadata_table: reportMetadataTable,
    executive_summary: bulletList(summaryItems),
    workflow_funnel_table: markdownTable([t.metric, t.count], funnelRows.map(([metric, count]) => [metric, formatNumber(count)])),
    workflow_status_table: markdownTable([t.step, t.status, t.input, t.output], stepRows),
    reference_section: referenceSection,
    search_section: searchSection || t.noData,
    alignment_section: alignmentSection,
    scoring_section: scoringSection,
    clustering_section: clusteringSection,
    similarity_section: similaritySection,
    prediction_section: predictionSection,
    manual_filter_section: manualFilterSection,
    recommendation_section: recommendationSection,
    warnings_section: warnings.length ? warnings.map((warning, index) => `${index + 1}. ${warning}`).join('\n') : t.noWarnings,
    artifacts_section: artifactsSection,
    reproducibility_section: reproducibilitySection,
    software_version: appVersion,
  };
  const { rendered, unresolved } = renderTemplate(template, values);
  if (unresolved.length) {
    warnings.push(language === 'zh'
      ? `报告模板包含未知占位符：${unresolved.join(', ')}`
      : `The report template contains unknown placeholders: ${unresolved.join(', ')}`);
  }

  return {
    language,
    module,
    taskId,
    generatedAt: generatedAt.toISOString(),
    schemaVersion: REPORT_SCHEMA_VERSION,
    templatePath,
    markdown: rendered,
    html: markdownToHtml(rendered, language, language === 'zh' ? 'EnzyMiner Pro 任务报告' : 'EnzyMiner Pro Task Report'),
    warnings,
    counts,
  };
}

export function reportFileName(taskId, language, extension) {
  const safeTaskId = String(taskId || 'task').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'task';
  return `${safeTaskId}_task-report_${normalizeLanguage(language)}.${extension}`;
}

export async function saveGeneratedReport(workDir, fileName, content, encoding = null) {
  const target = path.join(workDir, path.basename(fileName));
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  if (encoding) await fs.writeFile(temp, content, encoding);
  else await fs.writeFile(temp, content);
  await fs.rename(temp, target);
  return target;
}

export { markdownToHtml, normalizeLanguage, REPORT_SCHEMA_VERSION };
