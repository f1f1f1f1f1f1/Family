import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist', 'android', 'ios', 'docs-site']),
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactRefresh.configs.vite],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    linterOptions: {
      // A disable comment that no longer suppresses anything is itself an error,
      // so the reasoned exhaustive-deps exceptions can't silently go stale.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Only the two classic hooks rules. The plugin's React Compiler rules
      // (set-state-in-effect, refs, purity, ...) target code compiled by the
      // React Compiler, which this app doesn't use.
      'react-hooks/rules-of-hooks': 'error',
      // Missing effect/memo dependencies have caused real stale-data bugs here.
      // When one is intentionally left out, disable the rule on that line with
      // a `-- reason`.
      'react-hooks/exhaustive-deps': 'error',
      // Same conventions as tsconfig's noUnusedLocals/noUnusedParameters:
      // `_`-prefixed names and `{ omitted, ...rest }` destructuring are fine.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
]);
