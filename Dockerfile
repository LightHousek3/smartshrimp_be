FROM node:22-bookworm-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS dependencies

COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
# The runtime uses the generated client and Firebase Messaging, without optional cloud SDKs.
RUN PRISMA_SKIP_POSTINSTALL_GENERATE=1 npm ci \
    && ./node_modules/.bin/prisma generate \
    && npm prune --omit=dev --omit=optional

FROM base AS runtime

ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
