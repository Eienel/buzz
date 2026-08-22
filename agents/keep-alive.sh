#!/bin/sh
# Supervisor: the swarm dies on unhandled RPC errors (public devnet 429s under
# load). Restart it so the public arena never goes dark.
cd "$(dirname "$0")/.."
while true; do
  echo "[keep-alive] starting swarm $(date -u +%H:%M:%S)"
  node agents/swarm.mjs
  echo "[keep-alive] swarm exited ($?), restarting in 20s"
  sleep 20
done
