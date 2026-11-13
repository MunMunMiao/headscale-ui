---
name: testing-business-behavior
description: Use when writing, reviewing, or cleaning React/TypeScript tests, or deciding whether DOM, copy, CSS, generated output, or source-file assertions protect behavior.
---

# Business behavior tests

Run real production code and protect public interfaces plus behavior a user can observe. Ask first: **which incorrect behavior would make this assertion fail?** Judge by that answer, not by the file name, whether the component is mounted, or the matcher name.

## Boundary

| Keep                                                                                                                                                  | Remove                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Input validation, data conversion, request parameters, response handling, permissions, state changes, races, component events, feedback, and recovery | Color, fixed dimensions, layout, icons, decorative classes, visual snapshots                                                    |
| A button absent without permission, invalid input blocking submit, an error message, business text after conversion                                   | Comparing only a translation catalog, a static copy constant, or fixed explanatory text                                         |
| Selected, disabled, expanded, theme selection and restore, focus, and keyboard operation                                                              | A style snapshot standing in for interaction; running only a render helper and calling that business coverage                   |
| Privacy masks, secret values not leaking, screenshot redaction, and restoring them                                                                    | Full-page pixels, styles, and dimensions unrelated to privacy or function                                                       |
| Functional output, file side effects, and exit codes after executing a real function, build plugin, or script                                         | Reading existing source or config, then checking strings, an AST, compile shape, a file inventory, a hash, or a binary snapshot |

DOM presence, visibility, and text are not automatically forbidden. A class may locate a control or observe an existing functional state. Theme switching and privacy masks are not decorative checks. `toContain` can check an execution result or source; trace where the data came from. Reading source and then eval, compile, or extract a function does not replace running the production module.

Named exception for publication policy: keep the existing CI artifact-upload security gate in `scripts/deployment-config.test.ts`. It constrains the upload allowlist, failure-only publication, the pinned action, and short retention. Those declarations are themselves an external publication boundary. They do not permit source keywords, ordinary config-structure snapshots, or new exceptions, and they are not proof of runtime screenshot redaction. Git ignore and Docker build-context exclusion are checks of a real tool's execution result.

## Writing and cleanup

1. Read the test, the real code under test, and its callers. Name the input, the action, and the observable result. Drive a component through props, user actions, or public events. Test an already-independent pure function directly. Do not export a private member, expose an internal function, or split production logic only to make it testable.
2. Judge each assertion. In a mixed case, delete only the out-of-bounds assertion and keep the driving steps and business assertions. Delete a case only when it has no valid assertion left, and a file only when it has no valid case left. Then remove unused imports, fixtures, and helpers.
3. Keep a valid failing test and report it as it is. Cleaning tests does not authorize a product change. If a fixture or wait is wrong, fix that without weakening the original business contract.
4. When a deletion opens a coverage gap, check whether a real consumer lacks a valid behavior case. Do not keep a purely visual assertion, an empty test, an assertion-free call, or a branch triggered only for coverage. Do not lower a threshold, widen an exclude, or change production code to get green. If both cannot be satisfied, report the unfinished gate as it is.
5. Put mocks at the dependency boundary and keep the business under test. When a cycle makes async `importOriginal()` hang, find the cycle first, then use the smallest synchronous mock. Do not hide the problem by raising a timeout, turning off isolation, swallowing an error, or mechanically using `spy: true`.

## This repository

- Use the Bun version pinned in `packageManager`. A targeted run also uses `bun run --bun vitest run <test file>`, so the executable's Node shebang does not change the runtime. Keep the `unit`, real-Chromium `browser`, and `toolchain` projects in `vitest.config.ts`. Do not copy another repository's pnpm, Google Chrome channel, or Node exception list.
- A browser component does not use the Node filesystem API, and it is not moved to a simulated DOM to avoid a failure. Script and build tests run in their real environment. Do not replace them with a source check.
- Keep the four per-file 100% coverage gates, the Lingui integrity check, and the separate `bun run e2e`. Removing a purely static copy assertion does not remove tests for language switching, interpolation, plurals, and error feedback.
- E2E keeps using an isolated, disposable Headscale. Verify GUI validation, the request, public API readback, feedback, and recovery. Do not expand acceptance to SSH, the network data plane, or server-side atomicity. Failure screenshots come only from the test fixture, and privacy protection stays.
- Do not add skip, only, or an environment exception to hide a failure. Keep an existing platform-conditional test at its real runtime scope, and report the actual skip count and condition. A targeted run is iteration feedback. It does not replace full acceptance.

## Behavior example

The [CopyButton test](../../../src/components/app/copy-button.browser.test.tsx) mounts the real component, replaces only the browser clipboard boundary, and checks the written value and the success feedback. The snippet below uses that file's existing `stubClipboard` and `mount`:

```tsx
const writes: string[] = [];
stubClipboard(async (value) => {
  writes.push(value);
});
await mount(
  <CopyButton value="secret" data-testid="copy">
    Copy
  </CopyButton>,
);
await page.getByTestId("copy").click();
expect(writes).toEqual(["secret"]);
await expect.element(page.getByTestId("copy")).toHaveTextContent("Copied");
```

`Copied` here is feedback after the action succeeds, not a translation constant locked on its own. If the same case also checks the button width, remove only the width assertion. Do not delete the clipboard write or the feedback check.

## Acceptance and delivery

Run the [five gates in AGENTS.md](../../../AGENTS.md#before-the-change-is-done) in order. A command passes only when it exits 0 by itself. Watch mode, a partial test run, and a green CI job do not replace the required local full check.

The delivery note states the cleanup scope, the business and security boundaries that were kept, the actual commands and exit codes, coverage, skip conditions, remaining failures, and what was not verified. Fewer cases does not mean a business defect is fixed. This skill does not authorize commit, push, release, or edits to unrelated files.
