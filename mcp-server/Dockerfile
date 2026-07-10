# syntax=docker/dockerfile:1
# Memory Crystal — mcp image
# Two-stage build targeting ≤80 MB compressed.
# Built by CI: .github/workflows/publish-selfhosted-images.yml
# ─────────────────────────────────────────────────────────────
# Stage 1: builder — compile TypeScript
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY mcp-server/package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci

# Copy mcp-server source and compile
COPY mcp-server/ ./

RUN npm run build

# ─────────────────────────────────────────────────────────────
# Stage 2: runner — minimal production image
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    CRYSTAL_MCP_MODE=http \
    CRYSTAL_MCP_HOST=0.0.0.0 \
    CRYSTAL_MCP_PORT=8788

# Use the built-in non-root node user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 mcpuser

COPY mcp-server/package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev

COPY --from=builder --chown=mcpuser:nodejs /app/dist ./dist

USER mcpuser

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8788/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "dist/index.js"]
