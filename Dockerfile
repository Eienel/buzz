FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY agents ./agents
COPY app ./app
ENV PORT=3000 RPC=https://api.devnet.solana.com
EXPOSE 3000
CMD ["node", "server/index.mjs"]
