# AI-driven E2E walkthrough

Reusable, agent-operated GUI checks of Headscale UI against a disposable Docker fixture.
Complements the automated suites (`bun run e2e`): verify rendered controls, visual layout, copy,
multi-tab sessions, API requests, public API readback, and failure recovery.

## Acceptance boundary

A case must name a supported GUI requirement and its existing API contract. Success means the UI
validates the action, sends the correct request at most once, and presents the response/readback
accurately. Preserve cancellation, stale-session, secret-handling and uncertain-write checks.

Do not use SSH command execution, TCP/HTTP forwarding, server database internals, background
reclamation or global server-side atomicity as GUI acceptance criteria. Do not require metadata that
the supported API does not expose. Real clients may establish a documented fixture prerequisite;
their later operating-system or data-plane behavior is not the GUI result.

If a prerequisite or capture tool fails, stop that case and record it as blocked, not as passed or
as a product defect. A required check remains unverified; do not hide it with a successful exit.
An intentionally injected API error is part of its declared recovery case, not a missing prerequisite.
Correct the test setup or expectation before changing the product, and do not expand a GUI run into
an upstream or network investigation. Historical research artifacts are not repeatable GUI gates.

- `cases.md` — the case catalogue with prerequisites, steps, and acceptance criteria, without outcomes.
- `check-dev-recording.ts` — a Chromium check that writing a temporary run record does not reload the
  test page; its probe is created outside this directory and removed afterwards.
- `env/` — the playground: Headscale 0.29.6, an nginx CORS proxy on `127.0.0.1:18080`, four
  Tailscale devices, a Vite config that also proxies `/api/` and `/version` on the UI origin, and
  `seed.sh`.

## Source files and run artifacts

`e2e/ai/` contains reusable documentation, checks, and environment definitions only. Do not add
results, execution dates, pass/fail columns, reports, screenshots, logs, credentials, backups, or
temporary files here, including inside the case catalogue.

Store each run's artifacts under `.claude/ai-e2e/runs/<run-id>/`, which is gitignored. Use a new run ID
and restrict access to that directory. Record the tested revision, browser, locale, theme, viewport,
case IDs, actual outcomes, evidence, environment limitations, and cleanup status there. A prior run's
outcome does not establish the status of a later checkout. Never put secret values in evidence.

Each case starts from the seeded baseline plus its stated prerequisites. Restore only changes owned
by the run. If a destructive operation prevents restoration, reset the disposable playground before
continuing; do not rely on state left by a previous case or run.

## Set up

Start with a fresh `headscale-ui-ai-e2e` Compose project. The seed script assumes an empty database;
for an existing playground, use the explicit reset instructions below first.

```bash
sh e2e/ai/env/seed.sh
```

```bash
bun run dev --config e2e/ai/env/vite.config.ts --port 5173 --strictPort
```

`seed.sh` writes `.claude/ai-e2e/api-key.txt` (Headscale API key, 90 days) and
`.claude/ai-e2e/profile-password.txt` (UI profile password). `.claude/` is gitignored. The seeded
state is: users `alice` (ID 1) and `bob` (ID 2); devices `dev-laptop`, `dev-desktop` (alice),
`dev-server`, `dev-router` (bob); `dev-router` advertises `10.42.0.0/16`, `0.0.0.0/0`, `::/0`, all
pending; no policy (Headscale allows all).

Only one playground can bind `127.0.0.1:18080` at a time.

The AI Vite configuration excludes `.claude/` runtime files from its watcher so writing evidence
does not trigger a full page reload and end a single-tab unlocked session. Application source hot
updates remain enabled. With the dev server running, check the isolation using:

```bash
bun e2e/ai/check-dev-recording.ts
```

The check creates a unique temporary directory under `.claude/ai-e2e/runs/`, writes a probe record,
and removes its own directory on exit. It does not modify the case catalogue or read credentials.
If the UI uses a different origin, pass it as the script's first argument.

## Connect the UI

Open `http://127.0.0.1:5173`, add a server profile, and use:

| Field      | Value                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------- |
| Server URL | `http://127.0.0.1:5173` (same-origin proxy; requires SharedWorker and Web Crypto support) |
| API key    | contents of `.claude/ai-e2e/api-key.txt`                                                  |
| Password   | contents of `.claude/ai-e2e/profile-password.txt`                                         |

`http://127.0.0.1:18080` exposes the CORS proxy for direct checks. If a browser blocks cross-origin
SharedWorker fetches, use the same-origin URL above and record that environment limitation separately
from application failures.

To keep secrets out of agent transcripts, fill credential fields from the page instead of typing
them. The dev server serves files under the project root, so in the page context:

```js
const read = async (p) =>
  (await (await fetch(p, { cache: "no-store" })).text()).trim();
const set = (el, v) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
    el,
    v,
  );
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
set(
  document.getElementById("connect-api-key"),
  await read("/.claude/ai-e2e/api-key.txt"),
);
```

This exposes the files to anything that can reach the loopback dev server; use it only on a
throwaway playground.

## Conventions for agents

- Navigate inside the app with its links. A full page load requires the profile password if no
  unlocked SharedWorker session survives. With a live peer tab, the reloaded page joins that session;
  the browser controls when an unused Worker is destroyed.
- Synthetic `blur` events do not trigger React `onBlur`; commit text fields with a real Tab key.
- Prefer reading the DOM over screenshots; for menus and dialogs, wait for the open animation.
- Do not download exports: intercept `HTMLAnchorElement.prototype.click` and
  `URL.createObjectURL` to read the generated CSV.
- Verify each write against Headscale, not only the UI:
  `curl -H "Authorization: Bearer $(cat .claude/ai-e2e/api-key.txt)" http://127.0.0.1:18080/api/v1/...`
  and `docker compose -f e2e/ai/env/compose.yml logs headscale` (request paths and statuses).
- Record each finding in the run directory with the case ID, severity, observed vs expected, and
  evidence. Do not append outcomes to `cases.md` or add a report under `e2e/ai/`.
- For a new failure, first reproduce it and distinguish application behavior from browser/tool or
  dev-server effects. Add a runnable failing regression before changing implementation, then repeat
  the same regression and UI steps after the smallest fix. An unrelated timeout is not a valid RED.
- Operate rendered controls, not application stores or direct API writes, for the action under test.
  Direct API reads are independent verification; writes outside the UI are limited to documented
  disposable fixture setup and restoration.
- Back up the local baseline in the run directory, identify temporary entities explicitly, and
  restore only owned test changes. Keep secrets out of screenshots, transcripts and committed files.

## One-time auth-key results

For DEV-17, USER-10 and KEY-05, compare the displayed/copied value with the full key from **this**
successful creation response, privately in memory. A list prefix, mask or older card is not the
expected value. Wait for this submission to finish; do not interpret an old result as a new key.

- On the Auth keys page, scope to the unique visible `[data-testid="created-invite"]` result group.
  In the wizard, scope to `[data-testid="add-device-dialog"] [data-testid="setup-generate-step"]`
  and its visible `[data-testid="created-invite"]` fieldset.
- The first `code` in that result is the standalone key; a later one is the installation command.
  Never search the whole page for a key regex, take a list mask, or hard-code key length across
  versions. An absent, ambiguous or stale result is a capture/setup failure until the GUI is checked.
- Verify the response options, displayed owner/tags/expiry and copy result. A command must contain
  the selected login-server and response key with correct escaping; executing it is not this check.
- A slow inventory read is unverified, not failed. A real read error keeps its warning during retry;
  a successful read clears it. The same key remains available and no second create is dispatched.
- Keep keys, request links and key-bearing commands out of logs, screenshots, recordings and full
  DOM/network dumps. If clipboard access is unavailable, record that check as blocked rather than
  substituting a list mask or exposing the secret.

DEV-18 checks refreshed rendering of a device prepared by the owned fixture. Do not consume the
newly displayed key or require a fresh client join merely to prove list refresh or copy behavior.

## SSH decisions and route approval

Prepare a valid pending SSH request through the owned fixture before testing approval or rejection.
If that prerequisite is unavailable, stop the case. In the GUI, verify request-type validation,
required confirmations, the correct Auth ID/endpoint, at-most-once dispatch, and accurate success,
error or uncertain-outcome feedback. A rejected type or cancelled confirmation must send no write.
The supported API does not expose a trusted source/target/login-user summary; verify the limitation
notice instead of inventing those fields as an acceptance requirement. Do not execute a remote
command, inspect OS capabilities or rebuild an SSH environment to grade the GUI.

For ROUTE-01 through ROUTE-04, compare advertised and approved routes through the public API,
verify the selected node and complete route payload (including the paired IPv4/IPv6 exit routes),
and check cancellation, errors and refreshed UI state. Approval is a control-plane result, not a
promise of Internet, subnet or ClusterIP reachability. TCP/HTTP/ping probes and router packet
counters are outside this walkthrough; do not expand a route-dialog check into data-plane research.

## Reset

The following command deletes the containers and all data volumes of **this disposable
`headscale-ui-ai-e2e` project**, including registered devices, policies, users and keys. Do not use it
for a tailnet whose state you want to preserve. Then run the seed command from Set up again.

```bash
docker compose -f e2e/ai/env/compose.yml down -v
```

If a test deleted or converted a device while it was connected, first inspect its `tailscale status`
and logs. Preserve anything needed for diagnosis in the run directory before resetting that
disposable device's volume.
