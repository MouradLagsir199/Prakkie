# EAN-verrijkingsjob — gebouwd via `az acr build` (scripts/deploy.ps1),
# gedraaid als geplande Container Apps Job (infra/modules/enrichment-job.bicep).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# node:22-slim ships without a populated CA bundle; DuckDB's httpfs extension
# (used to read the OFF parquet straight off the blob SAS URL) does its own
# TLS validation via libcurl and fails with "Problem with the SSL CA cert"
# without this — Node's own fetch is unaffected since it bundles its own store.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund
COPY src ./src
USER node
CMD ["node", "src/run.mjs"]
