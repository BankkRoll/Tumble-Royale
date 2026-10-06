# syntax=docker/dockerfile:1.7
# Account API. Build from the repository root:
#   docker build -f deploy/docker/api.Dockerfile -t tumble/api .
# The image also runs migrations: `node dist/migrate.js` (the compose `migrate` service).

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
    pnpm install --frozen-lockfile --offline --filter "@tumble/api..." --filter tumble-royale
RUN pnpm --filter @tumble/api build
# Production dependencies only, pinned by the lockfile, in a tree that holds
# nothing but the workspace manifests. Workspace packages are bundled into dist/.
# NOTE: not `pnpm deploy`: without inject-workspace-packages it falls back to the
# legacy mode, which re-resolves every version from the registry.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    mkdir /out \
    && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /out/ \
    && find apps packages tools -mindepth 2 -maxdepth 2 -name package.json -exec cp --parents {} /out \; \
    && cd /out \
    && pnpm install --prod --frozen-lockfile --offline --filter @tumble/api \
    && rm -rf apps/api/node_modules/@tumble \
    && cp -r /repo/apps/api/dist /repo/apps/api/drizzle apps/api/ \
    && mkdir apps/api/scripts && cp /repo/scripts/admin.mjs apps/api/scripts/admin.mjs

FROM ${NODE_IMAGE} AS runtime
# ADMIN_API_URL: `docker compose exec api node scripts/admin.mjs …` talks to this instance.
ENV NODE_ENV=production \
    PORT=7360 \
    ADMIN_API_URL=http://127.0.0.1:7360
# The app's node_modules links into the virtual store two levels up.
WORKDIR /app/apps/api
COPY --from=build /out/node_modules /app/node_modules
COPY --from=build /out/apps/api ./
USER node
EXPOSE 7360
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
