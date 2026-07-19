FROM node:22-alpine

WORKDIR /app

# Copy package files and install production dependencies deterministically
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application files
COPY server.js ./
COPY Index.html ./
COPY bot.js ./
COPY public/ ./public/

# Run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Expose the application port (matches default PORT=10000)
EXPOSE 10000

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-10000}/healthz || exit 1

CMD ["node", "server.js"]
