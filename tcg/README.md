# Sourcing agent

An agent that pays for its own market data and looks for mispriced trading
cards, built for the ClawPump hackathon.

## Why this shape

The thread that started this asked whether an agent can source TCG inventory
better than a human "while keeping enough turnover to fund the loop". That is
the hard question, and it can be answered before any inventory is bought: an
agent that publishes timestamped picks builds a track record that is either
good or it isn't. The vault, the raffles and the pack-rips all come after, and
they are the parts that need capital.

So v1 is a sourcing engine with a public record, not a trading desk.

## What works today

`client.mjs` talks to tcgapi.dev, which answers 402 with an x402 challenge
rather than demanding a key. It offers a Solana branch paid in mainnet USDC at
$0.005 a call, and lists its own facilitator as feePayer, so the agent needs a
USDC balance and no SOL. An agent can buy data with the same asset it trades in
and never hold gas.

The payment payload comes from the official `@x402` client. The exact-scheme
encoding moves, and a wrong header is an unpaid call rather than an error you
notice in review.

Two ways in, cheapest first:

    TCG_API_KEY        free tier at tcgapi.dev, 100 requests a day, no crypto
    TCG_WALLET_SECRET  a mainnet USDC payer, base58 or a JSON byte array

With neither, `call()` reports the gap instead of throwing. A scanner that
dies because one lookup could not be paid for is worse than one that records
which lookups it missed.

## What is not built

The scanner. tcgapi.dev gives reference prices, market/low/foil, 24h/7d/30d
change and a listings count. It does not give live listings, and neither
traded.gg nor Collector Crypt publishes a documented API: api.collectorcrypt.com
is a real NestJS service but 404s on /docs, /swagger.json and /openapi.json, and
traded.gg 307-redirects every path. So the first signal has to be built out of
reference data alone: spread between low and market, momentum, and listing
depth as a liquidity proxy.

That is a weaker signal than seeing real listings, and saying so up front is
better than pretending the loop is closed.

## Run it

    node -e 'import("./client.mjs").then(async m => console.log(await m.quote()))'

prints what the server is willing to sell and on which chains. It is free: the
402 challenge itself costs nothing.
