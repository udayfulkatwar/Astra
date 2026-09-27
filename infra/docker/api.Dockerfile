# syntax=docker/dockerfile:1
# ASTRA Core API. Build context: repository root.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@astra/api..." \
 && pnpm --filter @astra/api build

# Runtime: the bundle is self-contained (no node_modules needed).
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    ASTRA_CONFIG_DIR=/app/config \
    ASTRA_MIGRATIONS_DIR=/app/migrations \
    ASTRA_HTTP_HOST=0.0.0.0 \
    ASTRA_HTTP_PORT=8080
WORKDIR /app
RUN addgroup -S astra && adduser -S -G astra astra
COPY --from=build --chown=astra:astra /repo/apps/api/dist ./dist
COPY --from=build --chown=astra:astra /repo/packages/db/migrations ./migrations
# Default (template) configuration; mount your own at /app/config in deployments.
COPY --from=build --chown=astra:astra /repo/config ./config
USER astra
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
