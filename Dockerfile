FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev \
    && groupadd --gid 10001 kirmy \
    && useradd --uid 10001 --gid kirmy --home-dir /app kirmy \
    && mkdir /app/data && chown kirmy:kirmy /app/data
COPY --chown=kirmy:kirmy src ./src
USER kirmy
ENV NODE_ENV=production DATA_DIR=/app/data
CMD ["node", "src/bot.js"]
