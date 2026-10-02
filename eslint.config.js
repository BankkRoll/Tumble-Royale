import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/test-results/**', '**/playwright-report/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // The simulation must stay headless and deterministic: no DOM, no wall clock.
    files: ['packages/sim/**/*.ts', 'packages/shared/**/*.ts', 'packages/netcode/**/*.ts', 'packages/content/**/*.ts'],
    languageOptions: { globals: { ...globals.es2023 } },
    rules: {
      'no-restricted-globals': ['error', 'window', 'document', 'performance', 'requestAnimationFrame'],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Use matchTime / tick inside the simulation.' },
        { object: 'Math', property: 'random', message: 'Use the seeded Rng from @tumble/shared.' },
      ],
      'no-restricted-imports': ['error', { patterns: ['three', 'three/*', 'react', 'react-dom'] }],
    },
  },
);
