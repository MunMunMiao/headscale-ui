# Development workflow

Coding agents follow this order. Product behavior stays in the README; this file is only how to change the repository and when a change is done.

## Scope

This repository is a GUI. A change is done when the UI validates the action, sends the correct API request, and shows public API readback, feedback, and recovery.

SSH execution, network forwarding, server database layout, background reclamation, and upstream atomicity are not GUI acceptance criteria. `e2e/ai/` is a manual walkthrough. It does not replace `bun run e2e`.

## Before editing

1. Read the code you will change and its callers. Reuse the existing request, session, and page path.
2. Use the Bun version pinned in `packageManager`. Install with `bun install --frozen-lockfile`. Node.js, npm, npx, Yarn, and pnpm are not the execution chain.
3. Do not add a `check`, `fmt`, or `format` script. `check` and `fmt` shadow `bun check` and `bun fmt`. Format files with `bun fmt`. The done-gate uses `format:check`, which is `bun fmt --check` and does not write.
4. Do not edit `src/components/ui`. Add a registry component with `bunx shadcn add <component>` and leave the generated file unchanged. Put business styling in the consumer or in `src/components/app`.
5. Declare HTTP only in `src/api/requests.ts`. Shared schemas stay in `src/api/contracts.ts`.

## Formatting

`bun fmt` is the formatter. Run it on each file you change. Do not wrap it in another script.

This repository rejects an unformatted commit from `.githooks/pre-commit` (`bun fmt --check --staged` exits 1 and does not write). `.githooks/pre-push` keeps the global GPG check. Once per clone, run `git config core.hooksPath .githooks`. A global `core.hooksPath` would otherwise hide these hooks. Do not pass `--no-verify` unless the user asks. The hook does not replace the done-gate. `bun run format:check` must still exit 0 by itself.

## While editing

- New behavior gets a test in the existing Vitest or browser suite. Covered files require 100% statements, branches, functions, and lines. Do not exclude a directory to pass the gate. A new file needs a test, or one named exclusion in `vitest.config.ts`.
- User-visible copy goes through Lingui. After message changes, run `bun run i18n:extract`, give every locale a translation (`en-US` is the source; there are 11 locales), then `bun run i18n:compile`. `bun run i18n:check` fails if catalogs drift, a translation is missing, or compile rewrites files.
- A dependency change updates `bun.lock`. Stay on stable versions, except the pinned `effect` release.

## Test behavior

Read [testing-business-behavior](.agents/skills/testing-business-behavior/SKILL.md) when writing, reviewing, or cleaning up tests.

- Exercise production code. Mount components and drive their public inputs, user interactions, and events; test already-independent functions directly. Do not expose internals or extract production logic only to make it testable.
- Keep assertions on requests, validation, permissions, state changes, business values, feedback, and recovery. DOM presence, text, and existing classes can observe functional state; they are not automatically appearance checks. Preserve accessibility and privacy behavior, including screenshot redaction.
- Do not assert decorative styles, dimensions, layout, visual snapshots, static copy alone, or source/configuration structure. Reading source and checking strings, ASTs, hashes, or file inventories does not exercise behavior. Functional output from an executed build plugin or script is different.
- Keep the existing CI artifact-publication security policy checks in `scripts/deployment-config.test.ts`: upload allowlist, failure-only publication, pinned action, and short retention. This narrow declarative-policy exception does not permit source-shape checks or replace runtime screenshot-redaction tests.
- In mixed tests, remove only out-of-scope assertions. Delete a case only when it has no behavioral assertion left, and a file only when it has no valid cases. Remove unused helpers; do not leave empty tests or assertion-free calls just to retain coverage.
- Failure is not a deletion reason. Do not use skips, focused runs, wider exclusions, lower thresholds, disabled isolation, swallowed errors, or weaker assertions to make the final gate pass. A cleanup does not authorize product changes.
- Keep the existing `unit`, `browser`, and `toolchain` projects in `vitest.config.ts`, the coverage gate, Lingui checks, and the disposable Headscale E2E fixture. Browser behavior runs in real Chromium; do not move failing component tests to another runtime to hide failures.
- Tests for `src` run in the `browser` project, in real Chromium. Use the browser's own IndexedDB with `clearHeadscaleDatabase` from `src/test`, `vi.mock(path, { spy: true })` to spy on a module export, and `serveFixture` from `src/test/fixture-server.ts` for a local Headscale double. A test that a loaded page cannot run is named `*.node.test.ts`, runs in `unit`, and says why in its first line. `unit` and `toolchain` otherwise hold only `scripts/` tests.

## Before the change is done

Run these locally, in this order. Each command must exit 0 by itself. An earlier pass does not cover a later command.

```bash
bun run --parallel lint format:check typecheck
bun run i18n:check
bun run test
bun run build
bun run e2e
```

CI's `test` job runs the first four and stops. It does not run `bun run e2e`.

`e2e` needs Docker Compose. Install Playwright's pinned Chromium once:

```bash
bun run browser:install
```

`bun run e2e` runs `scripts/run-e2e.ts`, then `check-policy-lifecycle.ts`, `check-session.ts`, and `check-deployment.ts`, against a disposable Headscale container. Failure screenshots must come from that fixture, never from production credentials.

While iterating, run only the command that covers the edit. Before the change is done, run all five. Do not report a command as passed unless that command exited 0.

## Leave the tree

Do not commit, push, or open a pull request unless the user asked for that action. Do not revert unrelated work already in the tree.
