# ============================================================
# Solana Yield Agent — Docker Build
# ============================================================

# ── Stage 1: Builder ────────────────────────────────────────
FROM node:20-alpine AS builder

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    gcc \
    musl-dev

WORKDIR /app

COPY package.json package-lock.json* ./
COPY scripts ./scripts
COPY idl-patches ./idl-patches
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN npm prune --production

# ── Stage 2: Production ─────────────────────────────────────
FROM node:20-alpine AS production

RUN apk add --no-cache tini

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json
COPY agent_config.yaml ./
COPY migrations ./migrations
COPY data/docs ./data/docs

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

USER nodejs

EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "dist/agent.js"]
