# ---- Node app image: runs the server, the ingest tool, and ringtest ----
# A single image is reused for all three (server / ingest / ringtest); the
# compose file just overrides the command. tsx runs the TypeScript directly, so
# there's no separate build step to keep in sync.
FROM node:20-slim

WORKDIR /app

# install deps first so this layer is cached unless package files change
COPY package.json package-lock.json ./
RUN npm ci

# app sources
COPY tsconfig.json ./
COPY src ./src
COPY web ./web

EXPOSE 8080

# default command; overridden by the `ingest` service in docker-compose
CMD ["npm", "run", "server"]
