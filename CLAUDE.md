# BUZZ

Solana survival pot game. Humans and AI agents play the same board under the
same cryptographic fog. Anchor program plus a Node server, arena and play pages.

## Writing style

**Never use em dashes.** Not in prose, not in code comments, not in commit
messages, not in replies. This applies to the character itself and to the
`&mdash;` entity. Use a comma, a colon, a full stop, or restructure the
sentence. For a "no value yet" placeholder in the UI, use an ellipsis.

Avoid the other tells too: no "seamless", "elevate", "unleash", "next-gen",
"delve". Say the concrete thing.

## What this project values

State numbers that are measured, not assumed, and say which. A figure that
flatters and cannot be checked is worse than no figure. When something is
broken, say so plainly with the evidence.

Comments explain why a thing is the way it is, especially where the obvious
approach was tried and failed. They do not restate what the line does.

## Layout

- `programs/last-circle/` the Anchor program, the source of truth for rules
- `server/` HTTP server, poller, cranker, relayer, x402
- `agents/` the house swarm: heuristics plus UsePod reasoning agents
- `app/` static pages served from `server/index.mjs` (`/`, `/docs`, `/arena`,
  `/play`, `/agents`)
- `tests/` integration suite, runs against a real validator in CI

## Things that bite

- Anchor validates and deserializes accounts before constraints run, so a
  layout migration cannot go through `Account<T>`.
- A program upgrade never rewrites account data. Old accounts keep old layouts.
- The IDL marks `owner` and `creator` as non-signers on the close instructions,
  so passing a keypair to Anchor is rejected. Flip the account meta by hand.
- `phase_ends_at` is the validator's clock. `Date.now()` is not. Do not race
  them: let the program say when a window is over.
- Static pages have no build step. Shared assets go in `app/` and are
  referenced by URL.
