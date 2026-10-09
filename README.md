# Headscale UI

![Headscale UI monochrome product preview](docs/assets/headscale-ui-intro.png)

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
- Route review: subnet and exit-route approval with clear risk signals.
- Access control designer: rules, groups, and tag ownership are edited through
  menus and form controls instead of raw JSON.
- Internationalization with `vue-i18n`: `en-US`, `zh-Hans`, `zh-Hant-TW`,
  `zh-Hant-HK`, `ja-JP`, `ko-KR`, `fr-FR`, `ru-RU`, `es-ES`, `it-IT`, and
  Arabic (`ar`) with RTL document direction.
- Theme support: light, dark, and system modes.
- Direct connections to Headscale API servers in development and production.

## Quick Start

Install dependencies with Bun:

```bash
bun install
```

Start the local dev server:

```bash
bun run dev
```

Open the printed local URL, add a server profile, and enter the server's
absolute HTTP(S) URL and an API key created by Headscale. A running Headscale
server is required; new profiles start with empty fields.

Profiles with valid connection details can be saved when the server is
unavailable, but opening the console requires a successful connection.

### Upgrading from a version with mock mode

On startup, the UI removes saved profiles that previously used the built-in
mock server: profiles marked `mock` whose URL, after trimming whitespace and
removing one trailing slash, is exactly `http://127.0.0.1:8080`. Their active
session references are removed too. Any names or credentials entered in these
demo profiles are discarded; no data is deleted from a Headscale server.

Existing real connections are preserved, including local servers explicitly
saved in real mode and legacy mock-labelled profiles whose URLs already caused
them to use a real server. Their encryption, master password, and UI preferences
are preserved. If the migration fails, startup reports the error instead of
attempting to connect using a demo profile.

## Scripts

```bash
bun run dev       # Start Vite dev server
bun run build     # Type-check and build production assets
bun run lint      # Run Biome checks
bun run test           # Run Bun unit tests
bun run test:coverage  # Require 100% function and line coverage for business modules
bun run test:e2e       # Run browser E2E against a Docker Headscale service
bun run test:policy-lifecycle # Test policy edits, reloads, login, deletion, and restart in Docker
bun run test:policy-traffic # Verify ACL enforcement with real Docker Tailscale clients
bun run test:deployment # Test the production image and subpath deployment in Chrome
bun run check          # Lint, covered unit tests, build, and all Docker test suites
```

The project intentionally avoids Node.js scripts. Use Bun for installation,
development, tests, builds, and deployment commands.

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
image is unnecessary. Non-root deployments return 404 outside their prefix.

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

## Verification

Before shipping a change, run:

```bash
bun run check
```

This covers Biome, the business-unit coverage gate, the TypeScript production
build, browser E2E against a disposable Docker Headscale service, policy lifecycle
tests against the production UI, TCP access checks between real Tailscale clients,
and production-image deployment tests covering root/subpath routing and local-data reset.
Docker Compose and Chrome must be available for the browser suites. Business
flows and deployment tests connect to disposable Docker Headscale servers.
Unit tests run independently of Docker; narrow request-contract tests and
fault or timing injection cover failures and races without an in-memory
Headscale implementation.

Known upstream limitation in Headscale v0.28.0: deleting a user with no nodes
also deletes all pre-authentication keys, including keys belonging to other users.
This was reproduced against the Docker image and is present in the upstream
[`DestroyUser` implementation](https://github.com/juanfont/headscale/blob/v0.28.0/hscontrol/db/users.go#L43-L71).
