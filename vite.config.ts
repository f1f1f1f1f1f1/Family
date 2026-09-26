import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

// Read the authoritative add-on version from config.yaml at the repo root
// (kept in sync with beacon/config.yaml by the semantic-release pipeline —
// see .releaserc.json's @semantic-release/exec prepareCmd). package.json's
// "version" field is NOT the source of truth for this add-on; don't read it.
function getAppVersion(): string {
  try {
    const configPath = fileURLToPath(new URL('./config.yaml', import.meta.url));
    const configYaml = readFileSync(configPath, 'utf-8');
    const match = configYaml.match(/^version:\s*["']?([^"'\n]+)["']?\s*$/m);
    if (match) return match[1].trim();
  } catch {
    // fall through to default below
  }
  return '0.0.0';
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
  },
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(getAppVersion()),
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // React is the biggest part of the startup download and changes far
        // less often than the app, so it gets its own file: its content hash
        // (and the browser's immutable cached copy) survives app updates.
        // Only React goes here; other packages stay with the code that uses
        // them so on-demand screens keep their libraries out of startup.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
        },
      },
    },
  },
});
