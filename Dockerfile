# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

FROM dependencies AS build
COPY server server
COPY web web
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS server
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /var/lib/audit-forwarder && chown 10001:10001 /var/lib/audit-forwarder
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/server/dist ./server/dist
USER node
EXPOSE 3000
CMD ["node", "server/dist/index.js"]

FROM server AS tools

FROM nginx:1.28-alpine AS web
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
