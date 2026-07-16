import { useMemo, useState } from 'react';

type AlignmentRow = {
  id: string;
  segment: string;
};

type AlignmentViewerProps = {
  rows: AlignmentRow[];
  start: number;
  alignmentLength: number;
  totalRecords: number;
  consensus?: string;
  conservation?: number[];
};

const residuePalette: Record<string, { background: string; color: string; label: string }> = {
  A: { background: '#bfdbfe', color: '#1e3a8a', label: 'Hydrophobic' },
  V: { background: '#bfdbfe', color: '#1e3a8a', label: 'Hydrophobic' },
  I: { background: '#bfdbfe', color: '#1e3a8a', label: 'Hydrophobic' },
  L: { background: '#bfdbfe', color: '#1e3a8a', label: 'Hydrophobic' },
  M: { background: '#bfdbfe', color: '#1e3a8a', label: 'Hydrophobic' },
  F: { background: '#c7d2fe', color: '#312e81', label: 'Aromatic' },
  W: { background: '#c7d2fe', color: '#312e81', label: 'Aromatic' },
  Y: { background: '#c7d2fe', color: '#312e81', label: 'Aromatic' },
  K: { background: '#fecdd3', color: '#881337', label: 'Positive' },
  R: { background: '#fecdd3', color: '#881337', label: 'Positive' },
  H: { background: '#fecdd3', color: '#881337', label: 'Positive' },
  D: { background: '#ddd6fe', color: '#4c1d95', label: 'Negative' },
  E: { background: '#ddd6fe', color: '#4c1d95', label: 'Negative' },
  S: { background: '#bbf7d0', color: '#14532d', label: 'Polar' },
  T: { background: '#bbf7d0', color: '#14532d', label: 'Polar' },
  N: { background: '#bbf7d0', color: '#14532d', label: 'Polar' },
  Q: { background: '#bbf7d0', color: '#14532d', label: 'Polar' },
  C: { background: '#fef08a', color: '#713f12', label: 'Cysteine' },
  G: { background: '#fed7aa', color: '#7c2d12', label: 'Glycine' },
  P: { background: '#fde68a', color: '#78350f', label: 'Proline' },
  '-': { background: '#e2e8f0', color: '#64748b', label: 'Gap' },
  '.': { background: '#e2e8f0', color: '#64748b', label: 'Gap' },
};

const legendItems = [
  ['Hydrophobic', '#bfdbfe'],
  ['Aromatic', '#c7d2fe'],
  ['Positive', '#fecdd3'],
  ['Negative', '#ddd6fe'],
  ['Polar', '#bbf7d0'],
  ['Special', '#fde68a'],
  ['Gap', '#e2e8f0'],
] as const;

function fallbackConsensus(rows: AlignmentRow[], width: number) {
  const consensus: string[] = [];
  const conservation: number[] = [];
  for (let column = 0; column < width; column += 1) {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const residue = String(row.segment[column] || '-').toUpperCase();
      if (residue === '-' || residue === '.') continue;
      counts.set(residue, (counts.get(residue) || 0) + 1);
    }
    let bestResidue = '-';
    let bestCount = 0;
    for (const [residue, count] of counts.entries()) {
      if (count > bestCount) {
        bestResidue = residue;
        bestCount = count;
      }
    }
    consensus.push(bestResidue);
    conservation.push(rows.length ? bestCount / rows.length : 0);
  }
  return { consensus: consensus.join(''), conservation };
}

export default function AlignmentViewer({
  rows,
  start,
  alignmentLength,
  totalRecords,
  consensus = '',
  conservation = [],
}: AlignmentViewerProps) {
  const [colorResidues, setColorResidues] = useState(true);
  const width = Math.max(
    consensus.length,
    rows.reduce((max, row) => Math.max(max, row.segment.length), 0),
  );
  const fallback = useMemo(() => fallbackConsensus(rows, width), [rows, width]);
  const visibleConsensus = consensus || fallback.consensus;
  const visibleConservation = conservation.length ? conservation : fallback.conservation;
  const end = width > 0 ? Math.min(alignmentLength || start + width - 1, start + width - 1) : start;
  const gridTemplateColumns = `minmax(12rem, 15rem) repeat(${Math.max(1, width)}, 1rem)`;

  if (!rows.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
        Generate an alignment or refresh the preview to display residue-level coloring here.
      </div>
    );
  }

  const renderResidue = (residueRaw: string, column: number, rowId: string) => {
    const residue = String(residueRaw || '-').toUpperCase();
    const palette = residuePalette[residue] || { background: '#f1f5f9', color: '#334155', label: 'Other' };
    return (
      <span
        key={`${rowId}-${column}`}
        className="flex h-5 w-4 items-center justify-center border-r border-white/40 font-mono text-[10px] font-semibold leading-none"
        style={colorResidues
          ? { backgroundColor: palette.background, color: palette.color }
          : { backgroundColor: '#ffffff', color: '#334155' }}
        title={`${rowId} · alignment position ${start + column} · ${residue} (${palette.label})`}
      >
        {residue}
      </span>
    );
  };

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div>
          <div className="text-sm font-semibold text-slate-800">Lightweight alignment viewer</div>
          <div className="text-xs text-slate-500">
            Columns {start}–{end} · {rows.length} visible / {totalRecords} sequences · drag the bottom scrollbar horizontally
          </div>
        </div>
        <button
          type="button"
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
          onClick={() => setColorResidues((value) => !value)}
        >
          {colorResidues ? 'Hide residue colors' : 'Show residue colors'}
        </button>
      </div>

      {colorResidues && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-b border-slate-100 px-3 py-2 text-[11px] text-slate-600">
          {legendItems.map(([label, color]) => (
            <span key={label} className="inline-flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm border border-slate-300" style={{ backgroundColor: color }} />
              {label}
            </span>
          ))}
        </div>
      )}

      <div className="max-h-[34rem] overflow-auto">
        <div className="min-w-max" style={{ display: 'grid', gridTemplateColumns }}>
          <div className="sticky left-0 top-0 z-30 flex h-7 items-center border-b border-r border-slate-200 bg-slate-100 px-2 text-[11px] font-semibold text-slate-700">
            Sequence / position
          </div>
          {Array.from({ length: width }, (_, column) => {
            const position = start + column;
            const showLabel = column === 0 || position % 10 === 0;
            return (
              <span
                key={`position-${position}`}
                className="sticky top-0 z-20 flex h-7 w-4 items-end justify-center border-b border-slate-200 bg-slate-100 pb-1 font-mono text-[9px] text-slate-500"
              >
                {showLabel && <span className="whitespace-nowrap">{position}</span>}
              </span>
            );
          })}

          <div className="sticky left-0 top-7 z-30 flex h-6 items-center border-b border-r border-indigo-200 bg-indigo-50 px-2 text-[11px] font-semibold text-indigo-800">
            Consensus
          </div>
          {Array.from({ length: width }, (_, column) => {
            const residue = String(visibleConsensus[column] || '-').toUpperCase();
            const conserved = Math.max(0, Math.min(1, Number(visibleConservation[column]) || 0));
            return (
              <span
                key={`consensus-${column}`}
                className="sticky top-7 z-10 flex h-6 w-4 items-center justify-center border-b border-r border-indigo-100 font-mono text-[10px] font-bold text-indigo-950 dark:text-indigo-100"
                style={{ backgroundColor: `rgba(129, 140, 248, ${0.12 + conserved * 0.62})` }}
                title={`Consensus at ${start + column}: ${residue}; conservation ${(conserved * 100).toFixed(1)}%`}
              >
                {residue}
              </span>
            );
          })}

          {rows.flatMap((row, rowIndex) => [
            <div
              key={`${row.id}-${rowIndex}-id`}
              className="sticky left-0 z-10 flex h-5 min-w-0 items-center border-b border-r border-slate-200 bg-white px-2 font-mono text-[10px] text-slate-700"
              title={row.id}
            >
              <span className="truncate">{row.id}</span>
            </div>,
            ...Array.from({ length: width }, (_, column) => renderResidue(row.segment[column] || '-', column, `${row.id}-${rowIndex}`)),
          ])}
        </div>
      </div>
    </div>
  );
}
