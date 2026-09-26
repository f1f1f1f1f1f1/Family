import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify('test'),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    css: false,
    // Root-level tests cover the add-on server's modules (chores-sync.cjs);
    // scripts/ tests cover the release helpers.
    include: ['src/**/*.{test,spec}.{ts,tsx}', '*.test.ts', 'scripts/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/main.tsx',
        'src/test/**',
        'src/styles/themes/*.ts',
      ],
    },
  },
});
