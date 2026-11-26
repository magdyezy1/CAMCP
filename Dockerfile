FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS build
# Both stages pin this digest of node 24.22.3-bookworm-slim, read from the registry index on 2026-11-26 (what production runs). Move the pin deliberately when Node is upgraded (OPS-08).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
# Railway supplies this triggering revision only when declared in the build stage.
ARG RAILWAY_GIT_COMMIT_SHA
RUN AMCP_REQUIRE_FFMPEG=true AMCP_TEST_CONCURRENCY=2 npm run check
RUN npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
RUN apt-get update && apt-get install -y --no-install-recommends gosu ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production MIRROR_DB=/data/mirror.sqlite MIRROR_HOST=0.0.0.0 MIRROR_PORT=4317
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/generated ./generated
COPY --from=build /app/.mirror/VENDOR ./.mirror/VENDOR
COPY --from=build /app/web ./web
COPY --from=build /app/Skills/amcp-campaign-builder ./Skills/amcp-campaign-builder
COPY --from=build /app/docs/REPORTING-OVERVIEW.md ./docs/REPORTING-OVERVIEW.md
# The lockfile is part of the packaged identity (/versionz, identity v2); copy the committed bytes the build hashed.
COPY package.json package-lock.json ./
COPY deploy/entrypoint.sh /usr/local/bin/amcp-entrypoint
RUN chmod 755 /usr/local/bin/amcp-entrypoint
RUN mkdir /data && chown node:node /data
EXPOSE 4317
# Attach /data using Railway's service volume configuration.
ENTRYPOINT ["amcp-entrypoint"]
CMD ["node", "dist/server/http.js"]
