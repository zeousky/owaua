FROM node:24.22.1-bookworm-slim
# yt-dlp fetches SoundCloud audio; FFmpeg encodes voice playback and MP3 files.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core python3 python3-venv ca-certificates \
    && python3 -m venv /opt/music \
    && /opt/music/bin/pip install --no-cache-dir 'yt-dlp[default]==2026.8.19' \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/music/bin:${PATH}"
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev \
    && groupadd --gid 10001 owaua \
    && useradd --uid 10001 --gid owaua --home-dir /app owaua \
    && mkdir /app/data && chown owaua:owaua /app/data
COPY --chown=owaua:owaua src ./src
USER owaua
ENV NODE_ENV=production DATA_DIR=/app/data
CMD ["node", "src/bot.js"]
