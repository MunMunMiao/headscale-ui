FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine AS build
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY . .
RUN PAGES_BASE=/__HEADSCALE_UI_BASE__/ bun run build

FROM nginx:1.30.6-alpine
COPY docker/nginx.conf /opt/headscale-ui/nginx.conf.template
COPY --chmod=755 docker/40-configure-base.sh /docker-entrypoint.d/40-configure-base.sh
COPY --from=build /app/dist /opt/headscale-ui/dist
EXPOSE 80
