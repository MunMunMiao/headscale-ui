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
- Mock mode for local development and real mode for a Headscale API server.

## Quick Start

Install dependencies with Bun:

```bash
bun install
```

Start the local dev server:

```bash
bun run dev
```

Open the printed local URL, then use the default mock profile to explore the
UI without a live Headscale server.

To connect to a real server, create or select a profile, choose `Real`, enter
the server URL and an API key created by Headscale, then connect.

## Scripts

```bash
bun run dev       # Start Vite dev server
bun run build     # Type-check and build production assets
bun run lint      # Run Biome checks
bun run test           # Run Bun unit tests
bun run test:coverage  # Require 100% function and line coverage for business modules
bun run test:e2e       # Run browser E2E against a Docker Headscale service
bun run check          # Lint, covered unit tests, build, and Docker E2E
```

The project intentionally avoids Node.js scripts. Use Bun for installation,
development, tests, builds, and deployment commands.

## Deployment

Production is published to GitHub Pages at https://headscale.lyz.cloud when a
non-prerelease GitHub Release is published. Pull requests and ordinary pushes
to `main` do not update that site.

The Docker image and GitHub Pages site both serve the SPA from `/`. Deep links
on GitHub Pages fall back through `404.html` (a copy of `index.html`).

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

## Verification

Before shipping a change, run:

```bash
bun run check
```

This covers Biome, the business-unit coverage gate, the TypeScript production
build, and browser E2E against a disposable Docker Headscale service. Docker
Compose must be available for the E2E suite.
