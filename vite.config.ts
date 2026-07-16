import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

const packageMetadata = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as { version?: string };

function resolveBuildCommit(env: Record<string, string>): string {
  if (env.BUILD_COMMIT) return env.BUILD_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    // SECURITY: Do NOT inject secrets into the frontend bundle.
    // If Gemini API calls are needed, proxy them through backend endpoints.
    define: {
      __APP_VERSION__: JSON.stringify(packageMetadata.version || '0.0.0'),
      __BUILD_COMMIT__: JSON.stringify(resolveBuildCommit(env)),
      __BUILD_DATE__: JSON.stringify(env.BUILD_DATE || '2026-07-16'),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react-vendor';
            if (id.includes('/lucide-react/')) return 'icons-vendor';
            return undefined;
          },
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: {
        '/api': {
          target: env.VITE_API_TARGET || 'http://127.0.0.1:8787',
          changeOrigin: true,
        },
      },
    },
  };
});
