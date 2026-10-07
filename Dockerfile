# Flux AM: one image for the API (which also serves the web app) and the worker.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/working-days/package.json packages/working-days/
COPY packages/validators/package.json packages/validators/
COPY packages/process-schema/package.json packages/process-schema/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @flux/web build

FROM node:22-bookworm-slim AS runtime
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NODE_ENV=production
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/working-days/package.json packages/working-days/
COPY packages/validators/package.json packages/validators/
COPY packages/process-schema/package.json packages/process-schema/
RUN pnpm install --frozen-lockfile --prod --filter @flux/api... && pnpm store prune
COPY db db
COPY processes processes
COPY packages packages
COPY apps/api apps/api
COPY --from=build /app/apps/web/dist apps/web/dist
RUN useradd --system --uid 10001 flux && mkdir -p /data/storage && chown -R flux /data
USER flux
ENV STORAGE_DIR=/data/storage WEB_DIST=/app/apps/web/dist PORT=3000 SOFFICE_PATH=
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/main.ts"]
