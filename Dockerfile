FROM node:22-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy application files
COPY server.js ./
COPY Index.html ./
COPY bot.js ./

# Expose the application port
EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "server.js"]
