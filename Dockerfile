# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /source
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/connector-plugins/package.json packages/connector-plugins/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/host/package.json packages/host/package.json
COPY packages/index/package.json packages/index/package.json
COPY packages/plugin-runtime/package.json packages/plugin-runtime/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile

COPY . .
ARG DOCO_VERSION=local
ENV DOCO_VERSION=$DOCO_VERSION
RUN pnpm run build:packages && pnpm --filter @doco/web build
RUN pnpm --filter @doco/web deploy --prod --legacy /opt/doco

FROM node:22-bookworm-slim AS runtime

ARG DOCO_VERSION=local
ENV DOCO_VERSION=$DOCO_VERSION
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /opt/doco ./
COPY --from=build --chown=node:node /source/runtime ./runtime

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=10s --start-period=30s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["npm", "start"]
