# Engine tests

Unit tests (`*.test.ts`) and smoke scripts (`smoke-*.ts`) live here, mirroring their original `src/` subdirectories. Production modules and bundled resources remain in `src/`; tests import them using relative `.js` specifiers, which TypeScript NodeNext and `tsx` resolve to the source `.ts` files.

Run from `engine/`:

```sh
npm test
npm run typecheck
npm run build
```

`npm test` discovers unit tests recursively and runs `tsx --test` with explicit file paths (including on Windows). Extra Node test-runner options can be passed with `npm test -- --test-concurrency=1`. Smoke scripts are not included automatically. `npm run typecheck` checks both production and tests; `npm run typecheck:tests` checks the test project alone, without emitting files. Production `tsconfig.json` retains `rootDir: src`, so the build still emits production modules directly under `dist/` and excludes tests.

Existing `npm run smoke:*` commands point into this directory. Other smoke scripts can be run explicitly, for example:

```sh
npx tsx tests/agents/smoke-agent-lifecycle.ts
npx tsx tests/web/smoke-task-session-entrypoints.ts
```

Choose smoke scripts for the available environment. In particular, `npm run smoke:openai` makes real model API requests and requires credentials; do not include it in offline or no-cost validation. HTTP smoke fixtures use local servers, and terminal smoke fixtures require working local shell/PTY support. Keep the working directory at `engine/` for smoke scripts that inspect production source files by cwd-relative paths.
