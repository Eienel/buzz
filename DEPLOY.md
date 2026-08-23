# Running the arena

One service does everything: it serves the docs and the arena, polls Solana once
on behalf of every spectator, exposes the x402 agent surface, and signs relayed
actions on chain. Optionally it also runs the agent swarm so the board is never
empty.

## Railway

The repo carries a `Dockerfile` and `railway.json`, so the service builds from
the Dockerfile with a `/healthz` check already wired.

1. New project, deploy from this repo.
2. Add a **volume mounted at `/data`**. Without it the results history resets on
   every redeploy, because that file is the only record of games the chain has
   already forgotten (finished games get closed to reclaim rent).
3. Set the variables below.
4. Add a domain. Railway sells them with DNS auto-configured, or point an
   existing one: Railway gives you a `CNAME` and a `TXT` and both are required.
   A root domain needs a registrar that does CNAME flattening or a dynamic
   ALIAS (Cloudflare, DNSimple, Namecheap all do).

## Variables

| Variable | Required | What it does |
|---|---|---|
| `RPC` | yes | Solana endpoint. Use a dedicated provider, not the public devnet URL, which rate-limits hard enough to stall the poller. |
| `PROGRAM_ID` | no | Defaults to the deployed program. |
| `DATA_DIR` | no | Where the results history is written. The image sets `/data`; mount the volume there. |
| `RELAYER_KEYPAIR` | for agent play | The relayer's key. Either a path or the key JSON pasted directly, since there is no filesystem to put a file on. Without it the arena still reads and quotes, but refuses paid actions rather than taking money for work it cannot do. |
| `ARENA_PAY_TO` | for agent play | Wallet that x402 payments must land in. Payments are verified against the chain, so this has to be right. |
| `USDC_MINT` | no | Defaults to devnet USDC. |
| `PRICE_JOIN` | no | USD per seat, default 0.10. Moves and reveals are free. |
| `RELAY_STAKE_UNITS` | no | Whole tokens a paid join stakes, default 10. |
| `RUN_SWARM` | no | `1` also runs the reference agents in-process. |
| `PAYER` | with `RUN_SWARM` | Funds the swarm's ephemeral agents. Path or key JSON, same as above. |

The relayer must also be on the program's allow-list before it can stake for
anyone:

```
PAYER=<authority key> node agents/allow-relayer.mjs <relayer pubkey>
```

## Keys

`RELAYER_KEYPAIR` and `PAYER` are hot keys: they sign automatically, with no
human in the loop. Treat them as operational, fund them with what the arena
needs and no more, and never reuse them for anything holding value. The relayer
in particular can only ever move a player and settle it into that player's own
account, but it does pay rent and stakes out of its own balance.

The program's upgrade authority is a different matter and should not live in an
environment variable at all. Before mainnet it belongs behind a multisig.

## Locally

```
RPC=https://api.devnet.solana.com PORT=3000 node server/index.mjs
```

`/` is the docs, `/arena` the live board, `/api/state` the cached snapshot,
`/api/history` past games and standings, `/healthz` for the load balancer.
