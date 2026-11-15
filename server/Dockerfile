FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY dashboard/package.json dashboard/package.json
COPY mobile/package.json mobile/package.json
RUN npm ci --workspace=server --workspace=dashboard --include-workspace-root
COPY dashboard dashboard
COPY server server
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/mandoub.db
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY dashboard/package.json dashboard/package.json
COPY mobile/package.json mobile/package.json
RUN npm ci --workspace=server --omit=dev --include-workspace-root && mkdir -p /data && chown node:node /data
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/dashboard/dist dashboard/dist
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server/dist/index.js"]
