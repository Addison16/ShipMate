# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
RUN pnpm --filter @shipmate/server --prod deploy --legacy /out/server

FROM base AS runtime
# git for the Shipyard, python3/pipx for uvx-based MCP servers, docker CLI (no daemon) for sandboxes,
# and Postgres for installs that don't point DATABASE_URL elsewhere (docker/entrypoint.sh).
# The bundled Postgres major is pinned: a new major can't open an older one's files.
ENV PG_MAJOR=17
RUN mkdir -p /etc/postgresql-common/createcluster.d \
    && echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.d/shipmate.conf \
    && apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg python3 pipx \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /etc/apt/keyrings/postgresql.asc \
    && echo "deb [signed-by=/etc/apt/keyrings/postgresql.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli postgresql-$PG_MAJOR \
    && pipx install uv && rm -rf /var/lib/apt/lists/*
ENV PATH=/root/.local/bin:$PATH
# Official Claude Code CLI, unmodified, for the subscription route (users sign in themselves).
RUN npm install -g @anthropic-ai/claude-code
COPY --from=build /out/server /app
COPY --from=build /app/apps/web/dist /app/web
# The shipmate CLI (backup, restore, doctor) reuses the server's node_modules.
COPY --from=build /app/packages/cli/dist /app/cli
# Inside a running container (docker exec) it finds the bundled database by its socket.
RUN printf '#!/bin/sh\nif [ -z "$DATABASE_URL" ] && [ -S /run/postgresql/.s.PGSQL.5432 ]; then\n  export DATABASE_URL="postgres://shipmate@%%2Frun%%2Fpostgresql/shipmate"\nfi\nexec node /app/cli/index.js "$@"\n' > /usr/local/bin/shipmate && chmod +x /usr/local/bin/shipmate
COPY templates /app/templates
ENV NODE_ENV=production PORT=3000 SHIPMATE_DATA_DIR=/data WEB_DIST=/app/web TEMPLATES_DIR=/app/templates CLAUDE_CONFIG_DIR=/data/claude
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://localhost:3000/healthz || exit 1
COPY docker/entrypoint.sh /usr/local/bin/shipmate-entrypoint
ENTRYPOINT ["shipmate-entrypoint"]
CMD ["node", "dist/main.js"]
