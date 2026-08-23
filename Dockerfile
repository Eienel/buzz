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
# PORT is deliberately not pinned here. Platforms inject their own and route to
# it; hardcoding one in the image means a mismatch shows up as a 502 rather than
# as anything legible. server/index.mjs falls back to 3000 when nothing sets it.
ENV DATA_DIR=/data RPC=https://api.devnet.solana.com
EXPOSE 3000
CMD ["node", "server/index.mjs"]
