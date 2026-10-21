FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir /app/data && chown node:node /app/data
COPY --chown=node:node src ./src
USER node
ENV NODE_ENV=production DATA_DIR=/app/data
CMD ["node", "src/bot.js"]
