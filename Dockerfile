FROM node:24-bookworm-slim
# yt-dlp fetches SoundCloud audio; FFmpeg encodes it to Opus.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
    && python3 -m venv /opt/music \
    && /opt/music/bin/pip install --no-cache-dir 'yt-dlp[default]==2026.8.19' \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/music/bin:${PATH}"
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
