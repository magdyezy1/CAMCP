FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run check
RUN npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production MIRROR_DB=/data/mirror.sqlite MIRROR_HOST=0.0.0.0 MIRROR_PORT=4317
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/generated ./generated
COPY --from=build /app/web ./web
COPY --from=build /app/Skills/amcp-campaign-builder ./Skills/amcp-campaign-builder
COPY package.json ./
COPY deploy/entrypoint.sh /usr/local/bin/amcp-entrypoint
RUN chmod 755 /usr/local/bin/amcp-entrypoint
RUN mkdir /data && chown node:node /data
EXPOSE 4317
# Attach /data using Railway's service volume configuration.
ENTRYPOINT ["amcp-entrypoint"]
CMD ["node", "dist/server/http.js"]
