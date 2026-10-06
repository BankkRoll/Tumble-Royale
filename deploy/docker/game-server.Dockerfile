# syntax=docker/dockerfile:1.7
# Game server. Build from the repository root:
#   docker build -f deploy/docker/game-server.Dockerfile -t tumble/game-server .
# Mount a volume at /data/results-outbox so results not yet delivered to the
# API survive a restart.

ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# COMPAT: the corepack bundled with older Node 22 images cannot verify current
# npm signing keys; a current corepack can.
RUN npm install --global corepack@latest && corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# PERF: fetching from the lockfile alone keeps the download layer cached until dependencies change.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "@tumble/game-server..." --filter tumble-royale
RUN pnpm --filter @tumble/game-server build
# Production dependencies only, pinned by the lockfile, in a tree that holds
# nothing but the workspace manifests. Workspace packages are bundled into dist/.
# NOTE: not `pnpm deploy`: without inject-workspace-packages it falls back to the
# legacy mode, which re-resolves every version from the registry.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    mkdir /out \
    && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /out/ \
    && find apps packages tools -mindepth 2 -maxdepth 2 -name package.json -exec cp --parents {} /out \; \
    && cd /out \
    && pnpm install --prod --frozen-lockfile --offline --filter @tumble/game-server \
    && rm -rf apps/game-server/node_modules/@tumble \
    && cp -r /repo/apps/game-server/dist apps/game-server/dist

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=7350 \
    RESULTS_OUTBOX_DIR=/data/results-outbox
# The app's node_modules links into the virtual store two levels up.
WORKDIR /app/apps/game-server
COPY --from=build /out/node_modules /app/node_modules
COPY --from=build /out/apps/game-server ./
# A named volume mounted here starts with this directory's owner, so the
# unprivileged user can write the outbox.
RUN mkdir -p /data/results-outbox && chown -R node:node /data
USER node
VOLUME /data/results-outbox
EXPOSE 7350
# SIGTERM starts the drain (deregister, let shows finish, flush the outbox);
# give the container at least DRAIN_SETTLE_MS + DRAIN_TIMEOUT_MS + OUTBOX_FLUSH_MS to stop.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
