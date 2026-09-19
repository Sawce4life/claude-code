# One image that builds the web app and serves it alongside the API.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build --workspace web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

# Only the server's dependencies are needed to run; the web app is static.
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev --workspace server --include-workspace-root --no-audit --no-fund && npm cache clean --force

COPY server ./server
COPY shared ./shared
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
