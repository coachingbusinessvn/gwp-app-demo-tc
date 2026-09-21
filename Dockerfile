# syntax=docker/dockerfile:1
# GWP app image (task 0.6, spec §9): multi-stage on node:24-bookworm-slim
# (active LTS — pin the resolved digest per release in
# docs/operations/foundation.md). Builder compiles dist/ + public-build/;
# runtime is a non-root production image with only what's needed to run.

# ---------------------------------------------------------------------------
# Builder: full toolchain + devDependencies for `npm run build`.
# python3/make/g++ exist ONLY here — argon2 ships linux-x64 prebuilds, but the
# toolchain keeps the build working if a prebuild ever misses.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Lockfile is required — npm ci reproduces the exact pinned tree.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Only what the build needs (public-build allowlist sources + TS inputs).
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY assets ./assets
COPY canvas-online ./canvas-online
COPY index.html dashboard.html employee.html canvas.html admin.html activate.html ./

# build = tsx scripts/build-public.ts (allowlisted public assets) && tsc -p
# tsconfig.build.json (server + scripts → dist/). Then drop devDependencies.
RUN npm run build \
 && npm prune --omit=dev

# ---------------------------------------------------------------------------
# Runtime: non-root, NODE_ENV=production, production node_modules only.
# postgresql-client provides pg_dump/pg_restore for ops scripts run inside
# the container (spec §9 backup path).
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public-build ./public-build
# Hand-maintained OpenAPI contract — read at startup by server/src/openapi.
COPY --from=builder /app/server/openapi.yaml ./server/openapi.yaml
# Versioned AI prompt assets — read at runtime by the AI module (resolved
# from cwd=/app, integrity-checked against each prompt's manifest sha256).
COPY --from=builder /app/server/prompts ./server/prompts

# node:24 images ship an unprivileged `node` user (uid 1000).
USER node
EXPOSE 8080

# Liveness only — never the DB — so a down database doesn't restart-loop the
# container; readiness is the orchestrator's concern (spec §9).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/src/index.js"]
