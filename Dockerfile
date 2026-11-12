# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm ci --registry=${NPM_REGISTRY} --replace-registry-host=always
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    BIND=0.0.0.0 \
    COLLAB_DATA_DIR=/data/rooms
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server.js /app/server-state.cjs /app/collaboration.cjs ./
COPY --from=build /app/static ./static
COPY --from=build /app/mock-data.md ./mock-data.md
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:3001/healthz || exit 1
CMD ["node", "server.js"]
