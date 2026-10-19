FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY config ./config
RUN npm run build && mkdir -p dist/src/db/migrations && cp src/db/migrations/*.sql dist/src/db/migrations/ && cp config/persona.md dist/config/persona.md
RUN npm prune --omit=dev
FROM node:24-bookworm-slim AS app
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node tsconfig*.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node config ./config
COPY --chown=node:node qa ./qa
RUN mkdir -p /var/lib/botsky-observer/spool && chown -R node:node /var/lib/botsky-observer && chmod 700 /var/lib/botsky-observer/spool
USER node
CMD ["node", "dist/src/main.js"]

# Heavy binaries and voice assets exist exclusively in the worker image.
FROM node:24-bookworm-slim AS media-deps
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pil python3-pypdf python3-defusedxml python3-qrcode \
    ffmpeg libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu-core \
    tesseract-ocr tesseract-ocr-spa tesseract-ocr-eng poppler-utils zbar-tools libseccomp2 curl \
    && python3 -m venv /opt/piper && /opt/piper/bin/pip install --no-cache-dir piper-tts==1.8.0 "yt-dlp[default,curl-cffi]==2026.8.19" \
    && ln -sf /opt/piper/bin/yt-dlp /usr/local/bin/yt-dlp \
    && mkdir -p /opt/voices && /opt/piper/bin/python -m piper.download_voices --data-dir /opt/voices es_MX-ald-medium \
    && rm -rf /var/lib/apt/lists/*
FROM media-deps AS worker
RUN apt-get update && apt-get install -y --no-install-recommends rclone && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node tsconfig*.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node config ./config
COPY --chown=node:node scripts/media /app/scripts/media
COPY --chown=node:node qa ./qa
RUN mkdir -p /var/lib/botsky-observer/spool && chown -R node:node /var/lib/botsky-observer && chmod 700 /var/lib/botsky-observer/spool
USER node
CMD ["node", "dist/src/worker.js"]
