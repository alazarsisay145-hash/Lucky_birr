FROM node:20-alpine

WORKDIR /app

# Copy package manifests and install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application files
COPY server.js ./
COPY public/ ./public/

# Expose the application port
EXPOSE 10000

ENV NODE_ENV=production
ENV PORT=10000

CMD ["node", "server.js"]
