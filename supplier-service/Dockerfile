# Built from the repository root, because the seed file lives in ../data:
#   docker build -f supplier-service/Dockerfile .
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY supplier-service/package.json supplier-service/package-lock.json ./
RUN npm ci --omit=dev

# Node runs the TypeScript directly, so there is nothing to compile.
COPY supplier-service/src ./src
COPY data/csv ./data/csv

# A default that can be overridden, so the same image runs anywhere.
ENV SUPPLIER_SEED_CSV_PATH=/app/data/csv/supplier-seed-data.csv

USER node
EXPOSE 3002
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.SUPPLIER_SERVICE_PORT || 3002) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/server.ts"]
