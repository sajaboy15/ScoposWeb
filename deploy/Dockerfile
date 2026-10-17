# Scopos server for a vendor: the Claude proxy, the knowledge store and the SDK files (/scopos.js + chunks).
# Build from the repository root:
#   docker compose -f deploy/docker-compose.yml up -d --build
# or
#   docker build -f deploy/Dockerfile -t scopos-server .

# ---- 1. build the SDK (loader + content-hashed chunks, minified with esbuild) ----
FROM node:20-alpine AS sdk
WORKDIR /src
COPY package.json package-lock.json* ./
# esbuild only; its platform binary comes as an optional package, no install scripts needed.
# (Without esbuild the build still works, the files are just not minified.)
RUN if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund; else npm install --ignore-scripts --no-audit --no-fund; fi
COPY sdk/ ./sdk/
COPY extension/core/ ./extension/core/
RUN node sdk/build.mjs

# ---- 2. the server: no SDK sources, no extension, no dev tools ----
FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=4173 \
    SCOPOS_USAGE_FILE=/data/usage.json
WORKDIR /app
COPY server/ ./server/
COPY extension/core/brain.js ./extension/core/brain.js
# build.mjs serves dist/ when the sources are absent (the server imports it).
COPY sdk/build.mjs ./sdk/build.mjs
COPY --from=sdk /src/dist/ ./dist/
COPY deploy/edge.mjs ./deploy/edge.mjs
# Optional: the Ledgerly / TMS demo at / and /demo/ (for a first try; leave it out in production).
# COPY demo/ ./demo/

# The server keeps its files next to the code; they live on the /data volume instead.
# The Claude key comes from ANTHROPIC_API_KEY (or a file at /data/key); /setup is never reachable from outside.
RUN mkdir -p /data && chown node:node /data \
 && ln -s /data/knowledge.json /app/.scopos-knowledge.local.json \
 && ln -s /data/answers.json /app/.scopos-answers.local.json \
 && ln -s /data/key /app/.scopos-key.local
VOLUME ["/data"]
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4173)+'/scopos.js').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "deploy/edge.mjs"]
