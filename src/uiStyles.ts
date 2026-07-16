export function outlinedActionButtonClass(disabled = false) {
  return `rounded-lg border px-3 py-1.5 text-xs font-medium ${disabled
    ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400'
    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`;
}

export function downloadButtonClass(disabled = false, compact = false) {
  return `rounded-lg bg-emerald-600 ${compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'} font-medium text-white ${disabled
    ? 'cursor-not-allowed opacity-50'
    : 'hover:bg-emerald-700'}`;
}

export const downloadSelectClass = 'border-l border-emerald-700 bg-emerald-50 px-2 py-2 text-sm font-medium text-emerald-900 outline-none disabled:opacity-50';
