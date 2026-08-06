import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// athar has three JS/TS surfaces, each backed differently:
//
//   backend/internal/tracker/athar.ts   real TypeScript, its own
//                                        tsconfig.json (strict).
//   backend/internal/webui/static/*.js  plain JS served via go:embed,
//                                        typechecked in place against
//                                        JSDoc via its own tsconfig.json
//                                        (allowJs + checkJs).
//   scripts/**/*.mjs                    Node build/test/tooling scripts,
//                                        no tsconfig backs them — they are
//                                        never typechecked today, so they
//                                        get plain (untyped) recommended
//                                        JS linting rather than a fabricated
//                                        type-aware setup.
//
// backend/internal/tracker/athar.js and athar.min.js are generated build
// output (see scripts/build-tracker.mjs) — committed so a Go-only toolchain
// can build the binary, but not hand-written, so they're excluded the same
// way dist/ is. site/assets/vendor/* is third-party, also excluded.
export default defineConfig([
  globalIgnores([
    'node_modules',
    'site/assets/vendor',
    'backend/internal/tracker/athar.js',
    'backend/internal/tracker/athar.min.js',
    'backend/cmd/athar/dist',
    'backend/cmd/athar/site',
    '.site-check',
  ]),

  // The tracker: real TypeScript, type-aware. projectService walks up from
  // each file to find its nearest tsconfig.json — for this file that's
  // backend/internal/tracker/tsconfig.json, the same program `npm run
  // typecheck` already builds against, so no-floating-promises and friends
  // run against real type information, not a name-only preset.
  {
    files: ['backend/internal/tracker/athar.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // hookHistory's one finding: `window.history[method]` is captured
      // into `original` and later invoked as `original.apply(this, ...)` in
      // the returned wrapper — a deliberate "torn off, rebind at call time"
      // idiom, not a forgotten-bind bug. The rule flags any method
      // reference that isn't immediately invoked as a member expression and
      // has no way to see that .apply(this, ...) restores the right `this`
      // a few lines down. Single hit in this file (confirmed via `npx
      // eslint . | grep unbound-method`); downgraded to warn here rather
      // than disabled inline, per fleet convention for a single measured
      // false positive.
      '@typescript-eslint/unbound-method': 'warn',
    },
  },

  // The dashboard's plain-JS-with-JSDoc static files. Same mechanism as
  // above — projectService finds backend/internal/webui/static/tsconfig.json
  // (allowJs + checkJs) as the nearest ancestor tsconfig for these files, so
  // the type-aware TS rules run against the same JSDoc types `npm run
  // typecheck:webui` already checks.
  {
    files: ['backend/internal/webui/static/*.js'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Node tooling scripts: build/screenshot/site-check scripts and the
  // node:test suites. Untyped — no tsconfig covers this tree today, so
  // there is no type information to resolve honestly. Several of these
  // (demo-capture, screenshots, site-check, site-screenshots) drive
  // Playwright and pass `page.evaluate(() => document...)` callbacks —
  // real code that runs in-page, in the same file as the Node driver code
  // around it — so both global sets genuinely apply here, not just Node's.
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
])
