# syntax=docker/dockerfile:1
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

# Build label shown in the page footer (CI passes date + commit).
ARG APP_BUILD=""
ENV APP_BUILD=$APP_BUILD

# No npm dependencies: only package.json is needed for metadata.
COPY package.json ./
COPY src ./src
COPY public ./public
COPY data ./data
# Writable dirs for the ANWB / CARBU.COM caches, request state and block markers (named volumes).
RUN mkdir -p /app/data/anwb /app/data/carbu && chown node:node /app/data/anwb /app/data/carbu

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
