# BUZZ (Last Circle Standing) × AnsemHack Clawrena

How this repo becomes an AnsemHack submission: an **arena where AI agents (and
humans) play a fog-of-war survival game for real stakes**, and the agents that
read the board best actually earn more.

> AnsemHack (clawpump.tech/ansemhack) is an agentic-finance hackathon on
> **Solana** ($ANSEM is the prize token, not a chain). Entry requires: team
> registration + an X announcement + a **token launched on ClawPump**, all by
> **Sept 19**. Judging Sept 20-30, winners Oct 1.

---

## 1. Why this game is an *agent* project

The game (see SPEC.md) is a commit-reveal survival pot: every 30s one circle
dies (usually the least-crowded one), moves and death-predictions are hidden
until reveal, eliminated players keep 55-80% of their stake, and a **skill
pool** pays whoever predicted deaths correctly, survivor or not.

That makes it a *measurable reasoning benchmark with money on the line*:

- **Agents as players.** Each ClawPump agent has its own non-custodial Solana
  wallet and signs its own transactions, mapping 1:1 onto our `Player` PDA and
  the commit/reveal flow. An agent reads on-chain state, models where opponents
  will herd, commits a move and a prediction, and reveals. Skill points are an
  on-chain, sybil-resistant score of *which agent reasons best under
  uncertainty*.
- **An agent as infrastructure.** The game advances via permissionless cranks
  (`advance_to_reveal`, `select_death`, `execute_death`, `advance_instance`).
  The keeper is itself a ClawPump agent that earns from the house cut.
- **Humans welcome.** Nothing distinguishes a human wallet from an agent
  wallet on-chain. Human-vs-agent lobbies are the spectacle.

## 2. The token → delivery loop (how ClawPump fits)

1. **Launch the token on ClawPump** (entry ticket; gasless via pump.fun for the
   first launches, ClawPump auto-registered as fee recipient). The token is the
   *arena's* token, launched by the arena's keeper agent.
2. **Fees fund the arena.** Agents keep 65% of trading fees on tokens they
   launch. The keeper agent's fee revenue seeds devnet demo pots and, later,
   the jackpot/treasury on mainnet, mirroring the in-game 2%/2% rake split.
3. **The demo people can use:**
   - Program live on devnet (id `4TNbztSMd3zxG57M25y8WhpcKrQMJQVYEK6EnnkQy1Hw`).
   - A hosted **keeper agent** that opens a fresh lobby every N minutes and
     cranks games forward.
   - 2-3 **reference player agents** with different strategies (herd-follower,
     contrarian, band-reader) playing continuously.
   - A thin web client (read-only at first): live circles, coarse bands, pot,
     skill leaderboard. Wallet connect for humans second.

## 2a. Staking-token model (decided)

Games are staked in an SPL token, **one token per game** (a pot can't mix
tokens). The platform supports **both**:
- **Your token (primary/default):** most games are denominated in the arena's
  own ClawPump-launched token, real utility (play-to-use) that drives token
  volume and therefore ClawPump trading fees.
- **$ANSEM games:** games can also be denominated in $ANSEM, for hackathon
  alignment and because the event rewards $ANSEM volume (ClawPump buys back
  $ANSEM from fees). Note: $ANSEM is a mainnet token, devnet uses SOL or a mock
  mint; real $ANSEM only at mainnet.

Sequencing (decided): **ship the native-SOL version now** (loop live + swarm on
devnet), then add SPL multi-token staking as a **program upgrade**, the program
is deployed with the upgradeable loader (same id), so no redeploy/rotation. The
`Game` account will carry a `stake_mint` field; the vault becomes a PDA-owned
token account; deposit/refund/payout paths switch from lamport transfers to
`anchor_spl` token transfers. Regulatory note: real-value stakes (esp. $ANSEM)
carry gambling weight, the soft-landing framing matters most there.

## 3. Build plan to Sept 19

| Week | Deliverable |
|---|---|
| Aug 22-29 | Devnet deploy (new program id), keeper bot (TS, from the test harness), register + X post |
| Aug 30-Sep 5 | Player-agent SDK (`join / commit / reveal / predict / land / cash_out` as one TS class), 3 reference agents; **SPL multi-token staking upgrade** (`stake_mint` + token vault) |
| Sep 6-12 | ClawPump token launch (becomes the primary stake mint), $ANSEM game support, spectator web UI, continuous devnet games |
| Sep 13-19 | Polish, demo video, leaderboard, submission |

## 4. Security posture

Fixed (hardening pass + pre-deploy audit):
- Members of a dead circle can no longer `reveal_move` their **full** stake out
  (which dodged the refund haircut and double-counted the leftover pot).
- `land` now requires the game Running **and >1 circle alive**, no landing into
  the winner during the final scoring window to snipe the luck pool.
- **Crank-grinding closed:** death and insane rolls seed from a slot hash the
  game *committed to in advance* (before the hash existed); the commitment lands
  past the reveal deadline, and the guard is strict (`slot > entropy_slot`).
- **`select_death` de-gamed:** the victim is now chosen from the circles sorted
  by id with duplicates rejected, so a cranker can't pick the victim by
  reordering `remaining_accounts` or omit a circle with a `[A,A,B]` set.
- **Jackpot un-targetable:** joins freeze strictly *before* the lock instance,
  leaving no window where the insane-roll outcome is computable while deposits
  are still open.

Still open (known, documented):
- The slot-hash seam is leader-biasable in the committed slot; mainnet needs a
  real VRF (Switchboard On-Demand), the seam is isolated in `slothash_at`.
- No lobby-abort refund path if a game never starts; no `close_game`/dust sweep.
- Rounding/no-point skill-pool remainders strand in the vault until `close_game`.

None of these block a devnet demo; all are on the pre-mainnet list in README.

## 5. Deploying (new program id, old keypair rotated out)

The heavy toolchain runs in CI. To deploy:

```bash
# 1) Actions → devnet-build → Run workflow; download the artifact
#    (last_circle.so + IDL), built with the committed declare_id.
# 2) locally, with the NEW program keypair (never commit it):
solana config set --url devnet
solana airdrop 2                      # deploy fee payer
solana program deploy last_circle.so \
  --program-id ~/.config/solana/last_circle-keypair.json
# 3) initialize config + treasury once (see tests/last-circle.ts for the calls)
```

## 6. Repo visibility

Keep it **public**. The game's security never depends on code secrecy (the
bytecode and all state are on-chain anyway; the fog is cryptographic), judges
and integrators need to read it, and open-source is table stakes for trust in
a game that holds user funds.
