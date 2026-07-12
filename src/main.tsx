import { Component, type ReactNode } from 'react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

/**
 * Global error boundary: catches render-time errors anywhere in the app tree
 * (e.g. a saved task payload missing a field that newer code expects) and shows
 * a friendly message + reload button instead of a blank white screen.
 */
class GlobalErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; message: string }> {
  state = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: String(error?.message || error) };
  }

  componentDidCatch(error: Error, info: unknown) {
    // eslint-disable-next-line no-console
    console.error('[GlobalErrorBoundary] render error:', error, info);
  }

  handleReload = () => {
    this.setState({ hasError: false, message: '' });
    // Hard reload to reset all in-memory state
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-900 font-sans p-6">
          <div className="max-w-lg w-full bg-white border border-slate-200 rounded-2xl p-8 shadow-lg space-y-4 text-center">
            <div className="text-5xl">⚠️</div>
            <h1 className="text-xl font-semibold text-slate-900">Something went wrong</h1>
            <p className="text-sm text-slate-600">
              The page hit a render error. This is often caused by outdated cached data for a task.
              Reloading usually fixes it. If it keeps happening, try switching tasks or clearing the
              browser cache for this site.
            </p>
            {this.state.message && (
              <pre className="text-xs text-left text-red-600 bg-red-50 border border-red-200 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all">
                {this.state.message}
              </pre>
            )}
            <button
              onClick={this.handleReload}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-lg text-sm font-medium"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GlobalErrorBoundary>
      <App />
    </GlobalErrorBoundary>
  </StrictMode>,
);