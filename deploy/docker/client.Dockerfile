# syntax=docker/dockerfile:1.7
# Web client: the static game build served by Caddy on port 8080. Build from
# the repository root:
#   docker build -f deploy/docker/client.Dockerfile -t tumble/client .
# One image serves any domain: the build talks to /api, /mm and /gs/ws on its
# own origin, and an optional /config.json (mounted at /srv/runtime) overrides that.

ARG NODE_IMAGE=node:22-slim
ARG CADDY_IMAGE=caddy:2-alpine

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# COMPAT: the corepack bundled with older Node 22 images cannot verify current
# npm signing keys; a current corepack can.
RUN npm install --global corepack@latest && corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# PERF: fetching from the lockfile alone keeps the download layer cached until dependencies change.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "@tumble/client..."
RUN pnpm --filter @tumble/client build

FROM ${CADDY_IMAGE} AS runtime
RUN addgroup -S tumble && adduser -S -G tumble -H tumble \
    && mkdir -p /srv/runtime /tmp/caddy && chown tumble:tumble /tmp/caddy
COPY deploy/docker/client.Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/client/dist /srv/www
# Caddy keeps its autosave and data under XDG dirs; point them somewhere the unprivileged user owns.
ENV XDG_CONFIG_HOME=/tmp/caddy \
    XDG_DATA_HOME=/tmp/caddy
USER tumble
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/health"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
