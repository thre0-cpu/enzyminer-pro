import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Box,
  CheckCircle2,
  Cpu,
  Database,
  FlaskConical,
  Github,
  Layers3,
  Moon,
  Network,
  PlayCircle,
  Scale,
  Sun,
} from 'lucide-react';

const workflow = [
  ['Reference & Search', 'Import reference sequences, construct/search HMM profiles, or use the BLAST workflow.'],
  ['Alignment & Scoring', 'Preview bounded alignment windows, download the generated MAFFT FASTA, and score active-site positions.'],
  ['Clustering & Similarity', 'Cluster the scored candidates, then explicitly compute or reuse verified similarity CSV artifacts.'],
  ['Property Prediction', 'Run or reuse kcat/Km, solubility, Tm, and EC predictions. Cached values are not recomputed unless requested.'],
  ['Recommendation', 'Optionally filter the predicted candidate pool, rank it automatically, select results, export them, or highlight them in the network.'],
];

const cacheStates = [
  ['Ready', 'The saved artifact fingerprint matches the current inputs and settings; loading is read-only.'],
  ['Stale', 'Inputs or settings changed. The old artifact remains visible for recovery but must be recomputed before use.'],
  ['Legacy', 'CSV files exist, but older versions did not save a verifiable fingerprint. They can be reused explicitly without starting computation.'],
  ['Missing', 'No completed artifact is available. A compute or prediction action is required.'],
];

type HelpAboutProps = {
  darkMode: boolean;
  setDarkMode: (value: boolean | ((previous: boolean) => boolean)) => void;
  onBack: () => void;
  onLoadExample: () => Promise<void>;
  exampleLoading: boolean;
  exampleMessage: string;
  exampleError: string;
};

export default function HelpAbout({
  darkMode,
  setDarkMode,
  onBack,
  onLoadExample,
  exampleLoading,
  exampleMessage,
  exampleError,
}: HelpAboutProps) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-6 md:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onBack}
              className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors shrink-0"
              title="Back to home"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <BookOpen className="w-6 h-6 text-indigo-600 shrink-0" />
            <div className="min-w-0">
              <div className="font-semibold text-slate-900 truncate">Help & About</div>
              <div className="text-xs text-slate-500 truncate">EnzyMiner Pro V{__APP_VERSION__}</div>
            </div>
          </div>
          <button
            type="button"
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors shrink-0"
            onClick={() => setDarkMode((value) => !value)}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 md:px-8 py-10 space-y-8">
        <section className="bg-white border border-slate-200 rounded-2xl p-6 md:p-8 shadow-sm">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 text-xs font-semibold mb-4">
                <FlaskConical className="w-3.5 h-3.5" /> Enzyme mining workflow
              </div>
              <h1 className="text-3xl font-bold text-slate-900 mb-3">EnzyMiner Pro V{__APP_VERSION__}</h1>
              <p className="text-slate-600 leading-relaxed">
                A local-first workflow for enzyme sequence discovery, similarity-network exploration,
                property prediction, optional candidate filtering, and automatic recommendation.
                V1.1 adds interactive network selection/export, persistent layouts, a unified
                prediction-to-recommendation workflow, and this offline example case.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 text-sm min-w-[260px]">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><b>Version:</b> {__APP_VERSION__}</div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><b>Commit:</b> <code>{__BUILD_COMMIT__}</code></div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><b>Build date:</b> {__BUILD_DATE__}</div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><b>License:</b> Apache-2.0</div>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-5">
              <Layers3 className="w-5 h-5 text-indigo-600" />
              <h2 className="text-lg font-semibold text-slate-900">Workflow overview</h2>
            </div>
            <div className="space-y-3">
              {workflow.map(([title, description], index) => (
                <div key={title} className="flex gap-3 rounded-xl border border-slate-200 p-4">
                  <div className="w-7 h-7 rounded-full bg-indigo-50 text-indigo-700 flex items-center justify-center text-xs font-bold shrink-0">
                    {index + 1}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{title}</div>
                    <div className="text-sm text-slate-500 mt-1 leading-relaxed">{description}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm self-start">
            <div className="flex items-center gap-2 mb-3">
              <PlayCircle className="w-5 h-5 text-emerald-600" />
              <h2 className="text-lg font-semibold text-slate-900">Offline example</h2>
            </div>
            <p className="text-sm text-slate-500 leading-relaxed mb-4">
              Load 12 synthetic candidates, 2 references, mock prediction values, a precomputed
              similarity network, and a saved layout. No prediction service or similarity calculation is started.
            </p>
            <button
              type="button"
              onClick={() => void onLoadExample()}
              disabled={exampleLoading}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {exampleLoading ? <Cpu className="w-4 h-4 animate-pulse" /> : <Box className="w-4 h-4" />}
              {exampleLoading ? 'Loading example…' : 'Load Example Case'}
            </button>
            {exampleMessage && (
              <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 flex gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" /> {exampleMessage}
              </div>
            )}
            {exampleError && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 flex gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" /> {exampleError}
              </div>
            )}
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-5">
            <Database className="w-5 h-5 text-indigo-600" />
            <h2 className="text-lg font-semibold text-slate-900">Artifact and cache states</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {cacheStates.map(([title, description]) => (
              <div key={title} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="font-semibold text-sm text-slate-800">{title}</div>
                <div className="text-sm text-slate-500 mt-1 leading-relaxed">{description}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 flex gap-3">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            <div>
              Opening a page, loading a preview, or choosing <b>Use Existing Results</b> never starts an expensive calculation.
              Use <b>Compute</b>, <b>Run Prediction</b>, or an explicit recompute action when a cache is missing or stale.
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-4"><Network className="w-5 h-5 text-indigo-600" /><h2 className="font-semibold text-slate-900">Network tips</h2></div>
            <ul className="space-y-2 text-sm text-slate-600 list-disc pl-5 leading-relaxed">
              <li>Use Navigate mode for pan/zoom and Select Nodes mode to toggle export selections.</li>
              <li>Freeze & Save Layout persists node positions and viewport for the current task.</li>
              <li>The load threshold limits the edge set sent to the browser; the in-graph slider only filters that loaded set.</li>
              <li>For very large graphs, reduce loaded edges before switching renderers or exporting an image.</li>
            </ul>
          </div>
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-4"><Cpu className="w-5 h-5 text-indigo-600" /><h2 className="font-semibold text-slate-900">Deployment and services</h2></div>
            <ul className="space-y-2 text-sm text-slate-600 list-disc pl-5 leading-relaxed">
              <li>Designed for local machines or trusted internal networks in a single-user environment.</li>
              <li>Prediction services may be offline; cached rows remain usable when their input fingerprints match.</li>
              <li>GPU services should normally use one worker per GPU to avoid model duplication and memory contention.</li>
              <li>External tools and databases remain subject to their own licenses and usage terms.</li>
            </ul>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-3"><Scale className="w-5 h-5 text-indigo-600" /><h2 className="font-semibold text-slate-900">License and third-party software</h2></div>
          <p className="text-sm text-slate-600 leading-relaxed">
            EnzyMiner Pro application code is licensed under Apache-2.0. Third-party tools, models,
            model weights, databases, and hosted services are not relicensed by this project. See
            <code className="mx-1">LICENSE</code> and <code>THIRD_PARTY_NOTICES.md</code> in the repository before redistribution.
          </p>
          <div className="mt-4 inline-flex items-center gap-2 text-xs text-slate-500">
            <Github className="w-4 h-4" /> Source-controlled build · commit {__BUILD_COMMIT__}
          </div>
        </section>
      </main>
    </div>
  );
}
