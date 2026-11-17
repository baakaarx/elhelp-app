FROM node:24-bookworm-slim AS build
WORKDIR /app
ARG EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=
ARG EXPO_PUBLIC_APPLE_WEB_CLIENT_ID=
ENV EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=$EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID \
    EXPO_PUBLIC_APPLE_WEB_CLIENT_ID=$EXPO_PUBLIC_APPLE_WEB_CLIENT_ID
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY dashboard/package.json dashboard/package.json
COPY mobile/package.json mobile/package.json
RUN npm ci --workspace=server --workspace=dashboard --workspace=mobile --include-workspace-root
COPY dashboard dashboard
COPY mobile mobile
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
COPY --from=build /app/mobile/dist mobile/dist
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server/dist/index.js"]
