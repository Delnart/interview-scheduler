# syntax=docker/dockerfile:1

# --- deps: install production dependencies only ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime ---
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src

# SQLite database lives on a mounted volume so it survives container restarts.
# The directory is created and owned by the unprivileged "node" user; a fresh
# named volume inherits this ownership on first run.
ENV DB_PATH=/data/data.sqlite
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 4000

# node:sqlite is built into the Node binary; --experimental-sqlite is still
# required on the Node 22 line. Calling node directly (not via npm) lets the
# process receive SIGTERM for clean shutdowns.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "src/index.js"]
