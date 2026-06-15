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

# Data lives in PostgreSQL (see DATABASE_URL), so the container itself is stateless.
USER node
EXPOSE 4000

# Call node directly (not via npm) so the process receives SIGTERM for clean shutdowns.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
