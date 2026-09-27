# syntax=docker/dockerfile:1
# ASTRA dashboard: static build served by unprivileged nginx, which also proxies /api to the core.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@astra/dashboard..." \
 && pnpm --filter @astra/dashboard build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
