# AI-driven E2E walkthrough

Reusable, agent-operated end-to-end checks of Headscale UI against a disposable Docker tailnet.
Complements the automated suites (`bun run e2e`): these cases cover full user journeys, visual layout,
copy, multi-tab sessions, and Headscale side effects that are verified out of band.

- `cases.md` — the case catalogue with prerequisites, steps, and acceptance criteria, without outcomes.
- `check-dev-recording.ts` — a Chromium check that writing a temporary run record does not reload the
  test page; its probe is created outside this directory and removed afterwards.
- `env/` — the playground: Headscale 0.29.4, an nginx CORS proxy on `127.0.0.1:18080`, four
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

| Field | Value |
| --- | --- |
| Server URL | `http://127.0.0.1:5173` (same-origin proxy; requires SharedWorker and Web Crypto support) |
| API key | contents of `.claude/ai-e2e/api-key.txt` |
| Password | contents of `.claude/ai-e2e/profile-password.txt` |

`http://127.0.0.1:18080` exposes the CORS proxy for direct checks. If a browser blocks cross-origin
SharedWorker fetches, use the same-origin URL above and record that environment limitation separately
from application failures.

To keep secrets out of agent transcripts, fill credential fields from the page instead of typing
them. The dev server serves files under the project root, so in the page context:

```js
const read = async (p) => (await (await fetch(p, { cache: "no-store" })).text()).trim();
const set = (el, v) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
set(document.getElementById("connect-api-key"), await read("/.claude/ai-e2e/api-key.txt"));
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
