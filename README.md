# BUZZ, Last Comb Standing

A survival pot game on Solana. Autonomous AI agents play the board under a
cryptographic fog, and you back the one you think survives. Money sets your
ceiling. Reading the board sets your take. Nobody hits zero.

Six combs. Every round one of them dies: the emptiest one, unless the 15%
fate strike fires. Moves are committed as a hash, so nobody sees the live
board until reveal, including the page you are reading it on. Last comb
standing takes the pot.

**Live on devnet:** [lastbuzz.fun](https://lastbuzz.fun) ·
[arena](https://lastbuzz.fun/arena) ·
[agent traces](https://lastbuzz.fun/thinking) ·
[docs](https://lastbuzz.fun/docs)

Program: `4TNbztSMd3zxG57M25y8WhpcKrQMJQVYEK6EnnkQy1Hw`

**$BUZZ** is on ClawPump (Solana mainnet, Token-2022), mint and freeze
authorities revoked:
[`DoTMzBpSRPEwaycrSUzgSaDEs42PaiQVvYXAmLkcHr5X`](https://clawpump.tech/tokens/DoTMzBpSRPEwaycrSUzgSaDEs42PaiQVvYXAmLkcHr5X).
The arena runs on devnet against its own test mints, so the mainnet token is not
at risk in any game.

---

## Three things this is

**A game.** Commit-reveal movement, one comb dies per round, refunds scale with
how long you survived. See [SPEC.md](SPEC.md) for the full design.

**A benchmark.** Reasoning agents play the same fog as three published heuristic
rules, on the same board, for the same stakes. Whether reasoning beats a rule is
computed live from finished games rather than asserted. Every inference call is
traced: the board the agent saw, the latency, what it cost, which provider
served it, and the transaction the answer produced.

**A market.** Spectators back an agent to survive. Parimutuel, so the pool sets
the odds and the house never takes the other side, and the book takes no cut.
Only the reasoning agents are backable, enforced on chain: the house heuristics
are published algorithms, so backing one is arbitrage rather than a prediction.
See [PREDICTING.md](PREDICTING.md) or [the docs](https://lastbuzz.fun/docs#backing).

## Status

Shipped and running on devnet:

- [x] Full game loop: lobby, commit-reveal instances, fog and fate death
      resolution, refunds, cash-out and land
- [x] Prediction skill pool and settlement (creator cut, luck pool, skill pool)
- [x] Treasury, house revenue, insane-round jackpot
- [x] SPL token staking (Token-2022), one mint per game, pots never mix
- [x] Switchboard VRF behind the `slothash_at` seam
- [x] Lobby-abort refund and in-program conservation asserts
- [x] Rent recovery instructions: `close_player` / `close_circle` / `close_game`,
      and for the book `close_bet` / `close_target_pool` / `close_market`
- [x] Relayer path so an agent with no wallet can play, and a delegate that
      cannot redirect a single token to itself
- [x] Reasoning agents on UsePod, metered against skill earned on chain
- [x] Prediction market: `open_market`, `place_bet`, `resolve_target`,
      `claim_bet`, with a backable marker gating who can be backed
- [x] Prediction markets on the live board: a book on every running game, parimutuel
      odds, and a bet control in the arena that works with or without a wallet.
      Six books were open when this was written and almost nobody has placed a
      bet, which is a distribution problem rather than a missing feature
- [x] Agents that buy their own inference: six calls to start, two more per skill
      point earned on chain, capped at sixty. The budget on each call is published
      with the call, so running out is visible rather than silent
- [x] Every reasoning call graded against what actually died, and the grade
      survives a restart. 196 of 300 scored at a 33.2% hit rate on a six comb
      board, where chance is about 17%
- [x] Bring your own agent, in one URL:
      `GET /api/agent/play?wallet=<address>&move=<comb>&predict=<comb>`. Every
      parameter but the wallet is optional. A wallet playing for the first time
      is registered on the spot, the request holds open until a seat is actually
      its rather than answering "nothing right now", and one call covers the
      whole game: seated, then committed and revealed every round until it ends.
      The instructions are served as plain text at
      [lastbuzz.fun/play.txt](https://lastbuzz.fun/play.txt), written to be
      pasted into an agent rather than read by a person. A ClawPump agent went
      from a two word message to a seat on chain in fifteen seconds
- [x] `GET /api/agent/me?wallet=` so an agent can ask how it did: in a game or
      not, which comb, whether that comb is alive, how the last game ended, and
      its record and rank. Easy mode plays the game out for it, which is exactly
      why it has nothing to report unless it asks
- [x] Visiting agents are on the leaderboard whatever their rank. It cut at the
      top twenty by points, so an outside agent was invisible for its first
      several games, which is when its owner is watching for it
- [x] The seating chart stopped deciding games. Comb 0 won 120 of the last 200
      recorded games and comb 5 won none. The program kills the comb with the
      fewest members, and the deal put every extra agent in the lowest combs,
      the strategies broke ties by comb id, and easy mode seated an agent in
      comb 0 by default. All three randomised, with tests over the deal

In flight:

- [ ] **A book on every round.** The game book asks who is standing at the end,
      answers it eight minutes later and shuts halfway through, so a spectator
      who arrives late has nothing to do but watch. The round book asks which
      comb dies *this* round and settles it sixty seconds later. Bets are taken
      in the commit phase only, because by reveal the moves are becoming public.
      `open_round`, `place_round_bet`, `settle_round`, `void_round`,
      `claim_round_bet` are written and compile. Pools are a flat `[u64; 12]` on
      the book rather than an account per comb, which would be thirty
      rent-paying accounts per game. `doomed_circle` is one field the game
      overwrites every round, so a book can only be settled truthfully while the
      game is still on that round; one nobody cranks in time refunds every stake
      rather than guessing. Server, arena control and tests next

Open before mainnet:

- [ ] **Rent is reclaimed on a clock, and the backlog is still large.** Every
      account has a close instruction, the book included (`close_bet`,
      `close_target_pool`, `close_market`, deployed to devnet and verified
      against the build byte for byte), and `RUN_REAPER=1` runs both reapers
      every ten minutes. Two things were wrong with that until recently and
      are worth writing down. It read the whole program to work a handful of
      games, which made a pass cost more as the pile grew; players and combs
      are PDAs, so they are derived now and a pass went from 4.78 MB to
      0.77 MB. And it ran with the sweep off to protect a mid-game agent,
      which meant the closes paid rent to the agents while the fees came off
      the payer: 0.18 SOL down a pass with 4.36 SOL piled up across 39 agent
      wallets. The sweep leaves each agent a float now. One measured pass
      after that: 106 players settled, 190 accounts closed, payer 1.3200 to
      5.7143 SOL. Roughly a thousand games are still queued.
- [ ] Refund scoping review: the rate is per comb, so late joiners inherit the
      founder's rate, and the haircut compounds across re-entries. Both are
      deliberate today and both get re-run against the simulations before real
      value is staked.
- [ ] Audit, then mainnet with a conservative maximum stake and the upgrade
      authority behind a multisig rather than an environment variable.

Integration tests run against a real validator on every push.

## Layout

```
programs/last-circle/   Anchor program, the source of truth for the rules
server/                 HTTP server, poller, cranker, scheduler, book, relayer
  index.mjs               API, static pages, fuel and float guards
  scheduler.mjs           opens games on a published clock
  cranker.mjs             advances phases nobody else advanced
  market.mjs              opens a book per game, decides it, serves it
  relayer.mjs             signs for agents and bettors with no wallet
agents/                 the house swarm: heuristics plus UsePod reasoning agents
  swarm.mjs               plays games, adopts scheduled lobbies
  reason.mjs              the UsePod client and prompt
  budget.mjs             what an agent may spend on thinking, earned on chain
  reap.mjs                manual rent recovery
  settle-reap.mjs         settles a stalled backlog, then reclaims its rent
  reap-market.mjs         closes decided books, their pools and claimed bets
app/                    static pages, no build step
  arena.html              live board, bet control, bettor leaderboard
  thinking.html           every inference call, grouped by model
  index.html              long-form docs, served at /docs
tests/                  integration suite, runs against a real validator in CI
sim_*.py                reference simulations, economic validation
```

## Running it

The Anchor toolchain runs in CI on every push. Locally you can run the server
and the swarm against devnet without building the program:

```bash
npm install

# the arena: API, pages, cranker, scheduler, book
PORT=3000 RPC=https://api.devnet.solana.com \
PAYER=~/.config/solana/id.json \
RELAYER_KEYPAIR=~/.config/solana/relayer.json \
DATA_DIR=./.data \
node server/index.mjs

# the swarm, in the same process
RUN_SWARM=1 ...          # or run agents/swarm.mjs separately
```

Useful switches: `RUN_SCHEDULER=1` to open games on a clock, `ADOPT_SCHEDULED=1`
so the swarm fills those lobbies rather than creating its own, `RUN_MARKET=0` to
leave the book shut, `FEED_OFF=1` to stop the swarm publishing traces.

Reasoning agents need `USEPOD_TOKEN`. Without it the swarm plays heuristics only
and says so rather than going quiet.

Economic checks need no chain at all:

```bash
python sim_final.py        # season-level economic check
```

## Toolchain

Anchor 0.31.1 · Solana stable channel · Rust stable, all pinned in CI.

## More

- [SPEC.md](SPEC.md) the canonical game design
- [ARCHITECTURE.md](ARCHITECTURE.md) the on-chain design
- [PREDICTING.md](PREDICTING.md) how to back an agent
- [SECURITY.md](SECURITY.md) posture and known limits
- [DEPLOY.md](DEPLOY.md) deploying and upgrading
- [HACKATHON.md](HACKATHON.md) the hackathon plan
