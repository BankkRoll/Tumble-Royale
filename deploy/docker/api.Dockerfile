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
# Production dependencies only, as real files rather than links into the workspace.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @tumble/api deploy --prod --legacy --offline /out \
    && rm -rf /out/src /out/test /out/dist \
    && cp -r apps/api/dist /out/dist \
    && mkdir -p /out/scripts && cp scripts/admin.mjs /out/scripts/admin.mjs

FROM ${NODE_IMAGE} AS runtime
# ADMIN_API_URL: `docker compose exec api node scripts/admin.mjs …` talks to this instance.
ENV NODE_ENV=production \
    PORT=7360 \
    ADMIN_API_URL=http://127.0.0.1:7360
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 7360
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
