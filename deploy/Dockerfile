FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node server ./server
COPY --chown=node:node agent ./agent
COPY --chown=node:node assets ./assets
COPY --chown=node:node pendaftaran ./pendaftaran
COPY --chown=node:node panduan-instalasi ./panduan-instalasi
COPY --chown=node:node kebijakan-privasi ./kebijakan-privasi
COPY --chown=node:node daftar ./daftar
COPY --chown=node:node masuk ./masuk
COPY --chown=node:node index.html 404.html portal-config.json ./
USER node
EXPOSE 8080
CMD ["node","server/main.mjs"]
