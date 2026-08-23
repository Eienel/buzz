FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY agents ./agents
COPY app ./app
# Mutable runtime state (the results history) lives here. Mount a Railway
# volume at this path or it resets on every redeploy.
RUN mkdir -p /data
ENV PORT=3000 DATA_DIR=/data RPC=https://api.devnet.solana.com
EXPOSE 3000
CMD ["node", "server/index.mjs"]
