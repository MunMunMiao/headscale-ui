# Headscale UI

A Bun-powered Headscale administration interface for operating a private
tailnet without making users think in raw API endpoints or policy JSON.

Headscale UI is built around the daily admin workflow: save multiple server
profiles, connect to a Headscale instance, review machines and users, create
auth keys, approve routes, and design access policy through guided controls.

> This project is an independent UI for Headscale. It is not an official
> Headscale, Tailscale, or WireGuard product.

## Features

- Multi-profile login: save, switch, and delete multiple Headscale server
  profiles from the browser.
- Compact product shell: logo, tab menu, and profile menu stay in a single
  focused header.
- Machines table: search, status filtering, IP tags, route tags, owner details,
  and row-level actions.
- Users table: user filters, device lists, auth source display, and user
  management actions.
- Auth key flow: reusable and ephemeral keys, ACL tags, expiration picker with
  date and time, and generated `tailscale up` commands.
- Route review: subnet and exit-route approval and revocation with clear risk signals.
- Access control designer: rules, groups, and tag ownership are edited through
  menus and form controls instead of raw JSON.
- Internationalization with LinguiJS: `en-US`, `zh-Hans`, `zh-Hant-TW`,
  `zh-Hant-HK`, `ja-JP`, `ko-KR`, `fr-FR`, `ru-RU`, `es-ES`, `it-IT`, and
  Arabic (`ar`) with RTL document direction.
- Theme support: light, dark, and system modes.
- Direct connections to Headscale API servers in development and production.

## Quick Start

Use Bun 1.4.3 for dependency installation and every JavaScript command.
The application uses React, official shadcn Base UI components, Tailwind CSS,
TanStack Router, LinguiJS, Defjs, and Effect. Vite builds the browser application;
Vitest and Playwright run its tests. Install the locked dependencies:

```bash
bun install --frozen-lockfile
```

Start the local dev server:

```bash
bun run dev
```

Open the printed local URL, add a server profile, and enter the server's
absolute HTTP(S) URL, an API key created by Headscale, and a password for this
server profile. Each profile has its own password. A running Headscale server
is required to unlock it; new profiles start with empty fields. The browser calls
the Headscale API directly, so the server must be same-origin with the UI or answer
CORS preflights; see [Connecting to Headscale (CORS)](#connecting-to-headscale-cors).

Profiles with valid connection details can be saved when the server is
unavailable, but opening the console requires a successful connection.

### Browser storage and upgrades

Saved credentials use IndexedDB database version 3. New records encrypt each
API key with AES-256-GCM. PBKDF2-SHA-256 derives the encryption key from that
profile's password and a fresh 32-byte salt (600,000 iterations). Each write uses
a fresh 12-byte IV and binds the ciphertext to the profile ID, canonical server
URL, and credential version. Neither the password nor its derived key is saved.
Forgetting this password requires entering a replacement API key or deleting the
profile; there is no password recovery or password-free storage option.

Legacy device-encrypted, globally password-encrypted, and plaintext records are
preserved until explicitly migrated one profile at a time. Migration requires a
new profile password; old password-encrypted records also require the original
password. A failed migration leaves the original record intact. Old key material
is retained while any legacy or unknown record might still need it. Profile
changes and password changes report success only after their transaction commits;
a conflicting write requires an explicit retry. Changing one profile's password
does not re-encrypt other profiles. Changing the active profile's credentials
locks the shared session.

Close or refresh every old UI tab before upgrading. An old database connection
can block the upgrade; do not delete the database to unblock it. Version 3 fences
old version 2 database writers, but cannot remove a key already held by old
JavaScript or revoke a request already sent. A rollback build must support version
3; restore an independently preserved pre-upgrade browser profile, or ship a
forward-compatible fix. Do not downgrade the database version or clear it as a
rollback procedure.

### Shared session and logout

A named SharedWorker owns the decrypted connection key and performs authenticated
HTTP requests. Pages exchange commands and public session metadata with it. Pages
do not store the decrypted connection key in React state, localStorage, or
sessionStorage. Same-origin pages in the same browser storage partition share
one active server: a successful switch in one tab changes the current server for
all its peers. A failed unlock leaves an existing valid session unchanged.
Ordinary unsaved drafts stay attached to their previous session and cannot be
submitted to the new server; explicitly discard them before continuing. Generated
credentials from the old server are cleared when the session changes or locks.

The session expires after 30 minutes without accepted user activity across the
application. Trusted input, key presses, pointer presses, and wheel input in a
visible page renew it. Network polling, synthetic events, mouse movement, and
merely focusing or reopening a page do not renew it. Expiry is checked at request
admission, immediately before network transmission, and after responses; timers
are only an additional way to lock promptly. Returning from a hidden or frozen
page checks the current session before applying a delayed response. A backward
wall-clock change locks the session.

A refreshed tab joins a live peer's session. With no surviving Worker session,
a refresh or browser restart requires the profile password. Browser lifecycle
management determines when an unused Worker is destroyed; closing the last page
does not guarantee immediate erasure of its heap. Explicit logout locks all
connected pages. Logout and timeout do not revoke the Headscale API key or roll
back writes already received by the server. A lost write response may represent
a committed operation; the client does not automatically repeat it.

The remember option controls saved-profile visibility. Temporary encrypted rows
remain associated with their sessionStorage owner ID across reload and browser
session restoration. Independently opened tabs hide these saved rows, while an
opener can copy the owner's sessionStorage. Peers may use the single already
unlocked server even if its saved row is not in their list. Closing a tab does not
physically delete an encrypted row; explicit deletion or clearing local data
does. The owner ID is a visibility convention, not an authentication credential.

This encryption protects stored credentials when the password is absent. It does
not protect an unlocked application against malicious same-origin JavaScript,
compromised browser extensions, or a compromised device. Use a secure browser
context (HTTPS or loopback development) with SharedWorker and Web Crypto support.
An unavailable or incompatible Worker requires recovery before administration
continues; there is no per-tab fallback that silently creates independent sessions.

## Policy compatibility

The designer edits ACL sources, destinations, ports, groups, and tag owners.
It accepts JSON and HuJSON comments and trailing commas. Invalid documents or
structures that cannot be represented safely are read-only: Access saves,
membership changes, tag ownership changes, and policy cleanup are blocked.
The original policy text is retained, and refreshing after correcting it in
Headscale restores editing. Deleting a member without policy cleanup remains
available only when that cleanup option is explicitly turned off.

Unmodeled top-level and individual ACL fields, including `proto`, survive edits
and saves. A destination split across designer rows retains the same restrictions
on every row. Aggregate device-label service controls are read-only when any
contributing ACL has extra fields; explicit access removal remains available.
Save output is normalized JSON: comments and formatting are not retained.

Renaming or deleting a group or tag updates its supported references throughout
the policy, including SSH rules, grants, route approvers, and policy tests.
Unknown reference-bearing structures block that operation and leave the draft
intact. Renaming a policy tag does not retag Headscale devices. A successful save
accepts the server's returned document as the saved baseline while preserving
edits made during the request.

Explicit empty ACLs stay empty. Grants-only documents retain their grants
without an added allow-all ACL, but grants have no dedicated editing controls.
This is not a complete policy-language validator; Headscale validates semantics.
Policy saves replace the entire document without a concurrent-update check.
Headscale requires `policy.mode: database` for API writes; file mode rejects them.
With `policy.mode: file` and no `policy.path`, Headscale has no policy to read: the
Access page is read-only with an explanation, and the Members policy controls are
disabled with the same explanation. With a `policy.path`, the policy loads but
saves are rejected by Headscale and the UI shows an explanation; the draft is kept.
Access can also dry-run the current draft through Headscale's policy check without
saving it.
Members policy actions (assigning groups and tags, removing references, and updating
references when a user is deleted or renamed) write only their own change and are
disabled while the Access page has unsaved edits; save or discard those edits first.
Headscale itself has additional [policy limitations](https://headscale.net/stable/ref/policy/#limitations),
including unsupported device postures and IP sets.

## Scripts

```bash
bun run dev            # Start the Vite development server
bun run typecheck      # Bun 1.4.3 native type checker, application and tooling
bun run build          # Type-check and build production assets
bun run lint           # Run Biome lint, format and import checks (add --write to fix)
bun run browser:install # Install pinned Playwright Chromium and system dependencies
bun run test           # Vitest unit and Chromium component tests with the Istanbul gate:
                       # per-file 100% statements, branches, functions and lines
                       # For a subset (`--project unit`, a file filter) add
                       # `--coverage.enabled=false`, since a partial run cannot meet the gate
bun run i18n:check     # Validate all catalogs, stable extraction, and strict compilation
bun run e2e            # All Docker suites below, in order (needs Docker Compose)
bun run verify         # Static checks, translations, tests, build, and e2e
```

`e2e` runs four independent harnesses against disposable Docker services.
To run one of them, call its script directly:

```bash
bun scripts/run-e2e.ts [vitest filter]  # Full Chromium and REST tests against Docker Headscale
bun scripts/check-policy-lifecycle.ts   # Policy edits, reloads, login, deletion, and restart
bun scripts/check-session.ts            # Shared session, freeze/BFCache and storage in the production build
bun scripts/check-deployment.ts         # Production image and subpath deployment in Chromium
```

`scripts/` keeps the entry points at the top level. `scripts/harness/` holds the shared Docker,
browser and network helpers (`docker.ts` owns container cleanup, signal handling and Headscale
startup, `deployment-stack.ts` the production-image stack shared by `check-session.ts` and
`check-deployment.ts`), `scripts/deployment/` holds the nginx checks, and `e2e/session/` holds the
shared-session and storage checks that `check-session.ts` runs.

`bunfig.toml` sets `[run] bun = true`, so package executables launched by
`bun run` use Bun even when their shebang names `node`. Node.js, npm, npx,
Yarn, and pnpm are not part of the execution chain. npm ecosystem packages and
Bun's `node:*` compatibility APIs are supported. Native compiler binaries,
Chromium, Docker, Git, shell utilities, and Nginx remain separate native tools.

Bun 1.4.3's native checker validates both TS and TSX. `bun check` follows the
project references in `tsconfig.json`, so one call covers the application and
tooling projects. Do not add a `check` script to `package.json`: it would shadow
the native `bun check`. Static checks run with Bun's parallel script runner. Test orchestration uses `Bun.serve`, `Bun.file`, `Bun.spawn`,
`Bun.sleep`, and `bun:sqlite`; Vite, Vitest, and Playwright retain their own roles.

Direct dependencies are exact versions and use current stable releases, except
the explicitly selected `@defjs/core@0.4.0-beta.1`. Effect is pinned to `4.0.2`. Commit `bun.lock` with dependency changes and use
frozen installs in CI. Add official Base UI components through
`bunx shadcn add <component>` and adapt their existing appearance as needed.

HTTP requests are declared once in `src/api/requests.ts` with Defjs
`defineRequest`. Shared response schemas and model types live in
`src/api/contracts.ts`. The explicit 30-operation command registry in
`src/api/commands.ts` (all 29 Headscale 0.29.4 RPCs plus `GET /version`, pinned in
`e2e/headscale-upstream.ts` and checked by `bun run test` and the contract suite in `bun run e2e`)
crosses the Worker boundary; `src/api/commands.ts` also exports
these typed page commands. Worker dispatch uses the Defjs middleware,
error-first tuples, response validation, and native fetch. Errors retain their
safe code, status, and server details without exposing connection credentials.
Effect manages Worker request lifetimes and cancellation; the closure in
`src/session/auth-session.ts` alone owns the current credentials and expiry.

React uses the session gateway with its captured Worker/session identity. Page
mutations retain the existing pending state, feedback, refresh, and policy-save
protection. `@defjs/react` is no longer needed because authenticated HTTP runs in
the Worker. A previous session's response cannot update the new UI. Switching
sessions does not undo a write already received by the server.

`node.get` and `node.debugCreate` are covered at the API-contract level only and
have no UI: node dialogs refresh the shared snapshot (`node.list` returns the same
node), and `debugCreate` is an upstream debug RPC used only as an E2E fixture.
`GET /version` is optional metadata: when it fails or reports an unsupported
series and the rest of the load succeeds, the UI only shows a notice and keeps
loading.

Add device can register a pending device sign-in request, and approve
or reject an SSH check request, by request ID or link. Headscale has no RPC to
list pending requests, so a pasted ID cannot be classified as device sign-in or
SSH check: choose the request type in the select; a link of the other kind is
rejected before sending. The request ID is redacted from Worker operation logs.

For behavior changes, first run a failing test, then implement and rerun it.
Unit and component tests use session hosts, MessagePorts, and Defjs with
controlled native HTTP responses. Docker browser tests put a test-only reverse
proxy in front of Headscale to observe and delay Worker HTTP requests;
Playwright page/context routing does not intercept SharedWorker fetch. Native
storage failures are injected into the Worker realm through the browser debugger,
with explicit hit counts and database readback. Production builds contain no
fault-injection protocol or alternate clock endpoint.

As of 2026-10-10, `bun audit` reports one high-severity advisory for the development
dependency `braces@3.0.3`, pulled in by Lingui CLI and shadcn CLI. Deeply nested
patterns can exhaust the call stack. It is not a browser runtime dependency;
no fixed version is published, and `bun audit fix --dry-run` cannot resolve it.
See [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

With all locked packages for the current platform already cached, use
`bun install --offline --frozen-lockfile` to rebuild dependencies without network
access. This was verified in a disconnected Linux ARM64 container; browser and
system package downloads need their own available sources.

After editing translated messages, run `bun run i18n:extract`, update all 11
PO catalogs, and run `bun run i18n:check`. Deleting messages needs
`bun run i18n:extract --clean`. Missing translations, obsolete entries,
or extraction that changes committed catalogs fail the check.

## Deployment

Production is published to GitHub Pages at https://headscale.lyz.cloud when a
non-prerelease GitHub Release is published. Pull requests and ordinary pushes
to `main` do not update that site.

The Docker image defaults to `/` and supports a configurable subpath. The
GitHub Pages site serves from `/`; its deep links fall back through `404.html`
(a copy of `index.html`).

The UI is also published to GitHub Container Registry as a multi-arch image
(`linux/amd64` and `linux/arm64`) when a GitHub Release is published:

```bash
docker run --rm -p 8080:80 ghcr.io/munmunmiao/headscale-ui:latest
```

Open http://localhost:8080. Tags follow the release version (`0.1.0`, `0.1`)
plus `latest` for non-prerelease releases. After the first push, set the GHCR
package visibility to public in the repository Packages settings.

Build a local image from this repository with:

```bash
docker build -t headscale-ui:local .
docker run --rm -p 8080:80 headscale-ui:local
```

### Docker subpath deployment

Use the same image with `BASE_PATH` to serve the UI under `/admin/`:

```bash
docker run --rm -p 8080:80 -e BASE_PATH=/admin/ ghcr.io/munmunmiao/headscale-ui:latest
```

Open http://localhost:8080/admin/. The equivalent Compose service is:

```yaml
services:
  headscale-ui:
    image: ghcr.io/munmunmiao/headscale-ui:latest
    environment:
      BASE_PATH: /admin/
    ports:
      - "8080:80"
```

An unset or empty `BASE_PATH` uses `/`. A missing trailing slash is added, so
`/admin` and `/admin/` are equivalent. Nested paths such as `/tools/headscale/`
are supported. Paths must start with `/`; segments may contain ASCII letters,
digits, `.`, `_`, `~`, and `-`. Empty segments, `.` or `..` segments, encoded
characters, full URLs, whitespace, query strings, fragments, and the reserved
`__HEADSCALE_UI_BASE__` marker are rejected with an `Invalid BASE_PATH` startup
error.

The container generates its assets and Nginx configuration before serving
requests. Recreate the container after changing `BASE_PATH`; rebuilding the
image is unnecessary. Deployments under a subpath return 404 outside their prefix.

When using a reverse proxy, **preserve the prefix**. For an Nginx proxy on the
same Docker network, use:

```nginx
location = /admin {
    return 308 /admin/$is_args$args;
}

location /admin/ {
    proxy_pass http://headscale-ui:80;
}
```

The `proxy_pass` URL has no trailing slash: adding one would strip `/admin/`
and conflict with the container configuration. Keep the Headscale server URL
in connection settings pointed at its API; `BASE_PATH` configures only the UI.

### Static hosting without Docker

For a static build, set the existing build-time `PAGES_BASE` instead:

```bash
PAGES_BASE=/admin/ bun run build
```

Serve the contents of `dist/` at `/admin/`, with page requests falling back to
`/admin/index.html` and missing assets returning 404. `PAGES_BASE` is compiled
into this build; setting an environment variable on a static server afterward
does not change it. Docker handles runtime configuration through `BASE_PATH`.

### Connecting to Headscale (CORS)

The SharedWorker calls the Headscale API from the UI's origin with `GET`, `POST`,
`PUT` and `DELETE` and the `Authorization` and `Content-Type` headers, so the
browser always sends a preflight `OPTIONS` request first. Stock Headscale 0.29.4
sends no CORS headers and answers that credential-less `OPTIONS` with `401`, so the
browser blocks every call when the UI and Headscale have different origins.

Option 1 (recommended): put both behind one reverse proxy on a single origin. For
example, serve the UI at `/admin/` and Headscale at `/api/`:

```nginx
server {
    listen 443 ssl;
    server_name headscale.example.com;

    location = /admin {
        return 308 /admin/$is_args$args;
    }

    location /admin/ {
        proxy_pass http://headscale-ui:80;
    }

    location /api/ {
        proxy_pass http://headscale:8080;
    }
}
```

Headscale's other control endpoints (`/ts2021`, `/key`, and so on) must still
reach Headscale on that host; add a catch-all `location /` that proxies to it, or
serve them from a name that does.

Run the UI with `BASE_PATH=/admin/` and enter `https://headscale.example.com` as the
server URL. No CORS configuration is needed.

Option 2: keep separate origins and add a proxy in front of Headscale that answers
`OPTIONS` itself and allows the exact UI origin:

```nginx
server {
    listen 80;
    add_header Access-Control-Allow-Origin "https://ui.example.com" always;
    add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
    add_header Vary "Origin" always;
    location / {
        if ($request_method = OPTIONS) { return 204; }
        proxy_pass http://headscale:8080;
    }
}
```

`scripts/check-deployment.ts` (`startHeadscale`) tests this shape against
Headscale; it uses `Access-Control-Allow-Origin: *` only because its UI origin is
ephemeral. In production, set the exact origin and keep `Vary: Origin`.

An HTTPS UI cannot call a plain-HTTP Headscale server (mixed content). The browser
blocks the request before it is sent, and the UI shows the generic
request-unreachable error.

### Security headers

Every response from the image carries:

- `Content-Security-Policy`: `default-src 'self'`, `script-src 'self'`,
  `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:`, `worker-src 'self'`,
  `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
  `frame-ancestors 'none'`, and `connect-src 'self'`.
- `X-Frame-Options: DENY`, so the UI cannot be embedded in a frame.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: no-referrer`.

The SharedWorker script response is the exception for `connect-src`: it carries
`http: https:`, because the Worker's own response CSP governs its requests and users
enter the Headscale URL. `style-src` keeps `'unsafe-inline'` for the UI's inline
styles. GitHub Pages and other static hosts cannot send these headers; on your own
server copy the `add_header` lines from `docker/nginx.conf` and apply the Worker rule above.

### Releases

CI gates publication: the GHCR image and the GitHub Pages site are published only after
the CI workflow succeeds for the release. Base images are `oven/bun:1.4.3-alpine` and
`nginx:1.30.5-alpine`.
Actions, registry and OIDC runs are not exercised by local tests.

## Verification

Before shipping a change, run:

```bash
bun run verify
```

CI runs two parallel jobs: the static checks, `bun run test` and `bun run build`,
and `bun run e2e`.

This covers Biome, the business-source coverage gate, the TypeScript production
build, browser E2E against a disposable Docker Headscale service, policy lifecycle
tests against the production UI, TCP access checks between Tailscale clients,
and production-image deployment tests covering root/subpath routing and local-data reset.
Docker Compose must be available for the browser suites. Run
`bun run browser:install` once to install Playwright's pinned Chromium. Business
flows and deployment tests connect to disposable Docker Headscale servers.
Most unit tests run independently of Docker. On macOS, two CI archive-contract
tests use the pinned Bun Linux image to exercise the official GNU tar behavior;
Linux runs those tests natively. Narrow request-contract tests and fault or timing
injection cover failures and races without an in-memory Headscale implementation.
Coverage includes unimported business files, hooks,
route guards, TSX logic, and the date/time controls. Page-level `policyError` and
pending guards duplicate controls that are already disabled, so they are held only
by the aggregate statement and branch floors; branches are not gated per file.
The separate TSX interaction scanner checks the existing control, REST, recovery, journey, and locale mappings.

GitHub workflows use verified Bun binaries, Git checkout commands, and native
Docker CLI/Buildx. Artifact, Pages, and provenance operations run pinned official
action bundles in the local Bun Docker action; upstream commits, checksums, and
licenses are recorded alongside it. GitHub artifact, OIDC, cache, Pages,
and registry operations still require validation in their authorized remote
environment; local tests do not prove a deployment succeeded.
