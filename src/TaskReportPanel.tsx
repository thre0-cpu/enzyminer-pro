import { useState } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';

import {
  downloadTaskReport,
  type TaskReportFormat,
  type TaskReportLanguage,
} from './api';
import { downloadButtonClass, downloadSelectClass } from './uiStyles';

function triggerBlobDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

export default function TaskReportPanel({ taskId, compact = false }: { taskId: string; compact?: boolean }) {
  const [language, setLanguage] = useState<TaskReportLanguage>('zh');
  const [format, setFormat] = useState<TaskReportFormat>('markdown');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const saveReport = async () => {
    if (saving) return;

    // Open the print window during the user gesture so browser popup blockers do
    // not reject it while the backend is preparing the print-friendly report.
    const printWindow = format === 'pdf' ? window.open('', '_blank') : null;
    if (format === 'pdf' && !printWindow) {
      setError('The PDF print window was blocked. Allow pop-ups for this site and try again.');
      setMessage('');
      return;
    }
    if (printWindow) {
      printWindow.document.write('<!doctype html><title>Preparing task report…</title><p style="font:16px sans-serif;padding:24px">Preparing task report…</p>');
      printWindow.document.close();
    }

    setSaving(true);
    setError('');
    setMessage('');
    try {
      const result = await downloadTaskReport(language, format);
      if (format === 'pdf') {
        const url = URL.createObjectURL(result.blob);
        if (printWindow) printWindow.location.replace(url);
        window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
        setMessage('The browser print dialog is opening. Choose “Save as PDF” as the destination.');
      } else {
        triggerBlobDownload(result.blob, result.fileName);
        setMessage(`${result.fileName} was saved.`);
      }
    } catch (err) {
      if (printWindow && !printWindow.closed) printWindow.close();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`rounded-xl border border-slate-200 bg-white ${compact ? 'p-4' : 'p-5'} shadow-sm`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-indigo-600" />
            <h1 className={compact ? 'text-lg font-semibold text-slate-900' : 'text-2xl font-semibold text-slate-900'}>
              Task Report
            </h1>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-slate-500">
            Export a bilingual summary from the selected task&apos;s existing files. Report generation does not rerun any search, alignment, similarity calculation, property prediction, filtering, or recommendation.
          </p>
          <div className="mt-3 text-xs text-slate-500">
            Current task: <span className="font-mono font-medium text-slate-700">{taskId || 'default'}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs font-medium text-slate-600">
            Language
            <select
              className="min-w-32 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:opacity-50"
              value={language}
              disabled={saving}
              onChange={(event) => setLanguage(event.target.value as TaskReportLanguage)}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>

          <div className="grid gap-1">
            <span className="text-xs font-medium text-slate-600">Save as</span>
            <div className="inline-flex overflow-hidden rounded-lg shadow-sm">
              <button
                type="button"
                className={`${downloadButtonClass(saving)} inline-flex items-center gap-2 rounded-r-none`}
                disabled={saving}
                onClick={saveReport}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {saving ? 'Preparing…' : 'Save Report'}
              </button>
              <select
                aria-label="Task report file format"
                className={downloadSelectClass}
                value={format}
                disabled={saving}
                onChange={(event) => setFormat(event.target.value as TaskReportFormat)}
              >
                <option value="markdown">Markdown</option>
                <option value="pdf">PDF</option>
                <option value="docx">Word (.docx)</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {message && (
        <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {message}
        </div>
      )}
      {error && (
        <div className="mt-4 whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
    </section>
  );
}
