# syntax=docker/dockerfile:1

# --- deps: só dependências de produção (better-sqlite3 usa binário pré-compilado) ---
FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- runtime ---
FROM node:26-bookworm-slim
ENV NODE_ENV=production \
    PORT=3001 \
    DATABASE_PATH=/data/pratosalvo.sqlite
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public ./public

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node como PID 1 recebe SIGTERM diretamente (shutdown gracioso em server.js).
CMD ["node", "server.js"]
