import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  { ignores: ['dist/**', 'node_modules/**', 'site/**', 'backend/**'] },

  // The React dashboard.
  {
    files: ['src/**/*.{js,jsx}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },

  // Build scripts run in Node.
  {
    files: ['scripts/**/*.mjs'],
    ...js.configs.recommended,
    languageOptions: { ecmaVersion: 'latest', globals: globals.node, sourceType: 'module' },
  },

  // The screenshot driver is genuinely bilingual: it runs in Node, but the
  // callbacks passed to page.evaluate() are serialised and executed inside the
  // browser, where `window` and `document` are real.
  {
    files: ['scripts/screenshots.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.node, ...globals.browser },
      sourceType: 'module',
    },
  },

  // The service worker has its own global scope.
  {
    files: ['public/sw.js'],
    ...js.configs.recommended,
    languageOptions: { ecmaVersion: 'latest', globals: globals.serviceworker, sourceType: 'script' },
  },
]
