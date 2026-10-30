FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi \
    && npm cache clean --force

COPY --chown=node:node . .

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

ENV PORT=3000 \
    DATA_DIR=/app/data

EXPOSE 3000

CMD ["node", "server.js"]