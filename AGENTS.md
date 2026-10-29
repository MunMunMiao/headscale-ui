# Development workflow

Coding agents follow this order. Product behavior stays in the README; this file is only how to change the repository and when a change is done.

## Scope

This repository is a GUI. A change is done when the UI validates the action, sends the correct API request, and shows public API readback, feedback, and recovery.

SSH execution, network forwarding, server database layout, background reclamation, and upstream atomicity are not GUI acceptance criteria. `e2e/ai/` is a manual walkthrough. It does not replace `bun run e2e`.

## Before editing

1. Read the code you will change and its callers. Reuse the existing request, session, and page path.
2. Use Bun 1.4.4 (`packageManager`). Install with `bun install --frozen-lockfile`. Node.js, npm, npx, Yarn, and pnpm are not the execution chain.
3. Do not add a `check` or `fmt` script. Those names shadow `bun check` and `bun fmt`.
4. Do not edit `src/components/ui`. Add a registry component with `bunx shadcn add <component>` and leave the generated file unchanged. Put business styling in the consumer or in `src/components/app`.
5. Declare HTTP only in `src/api/requests.ts`. Shared schemas stay in `src/api/contracts.ts`.

## While editing

- New behavior gets a test in the existing Vitest or browser suite. Covered files require 100% statements, branches, functions, and lines. Do not exclude a directory to pass the gate. A new file needs a test, or one named exclusion in `vitest.config.ts`.
- User-visible copy goes through Lingui. After message changes, run `bun run i18n:extract`, give every locale a translation (`en-US` is the source; there are 11 locales), then `bun run i18n:compile`. `bun run i18n:check` fails if catalogs drift, a translation is missing, or compile rewrites files.
- A dependency change updates `bun.lock`. Stay on stable versions, except the already pinned `@defjs/core` beta and the Effect pin.

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
