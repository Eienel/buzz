# Security

BUZZ escrows user funds. This page is the honest state of that, not a badge.

## Current status

- **Devnet only.** The deployed program stakes valueless test SOL. No real value
  is at risk today.
- **Unaudited.** No independent firm has reviewed this code.
- **Bounded by design.** A single game can never take in more than the
  `MAX_GAME_DEPOSITS` constant in the program. Each game escrows into its own
  vault PDA, so the blast radius of any undiscovered bug is one game's deposits,
  not the whole protocol. Raising that ceiling requires a program upgrade that
  is visible on chain, not an admin transaction.

## Known open issues

We publish these rather than wait for someone to find them.

| Issue | Impact | Status |
|---|---|---|
| Slot-hash randomness | The leader of the committed slot retains some influence over the death roll and the jackpot roll. Player and cranker grinding are already closed. | Switchboard VRF in progress |
| Upgrade authority is a single key | The deployer could ship a program that changes payout rules. | Moving to a multisig before mainnet |
| Refund scoping | The refund rate is per comb, so a player who joined late is refunded at the same rate as a founder. | Deliberate today, under review before mainnet |
| Haircut compounding | Re-entering compounds the haircut, down to roughly 14% of the original stake after five eliminations. | Documented and deliberate, parameters re-reviewed before mainnet |

Fixed and covered by tests: dead-comb stake escape, post-settlement luck-pool
sniping, crank grinding of the death and jackpot rolls, victim selection by
account ordering, jackpot targeting at deposit time, stranded lobby deposits,
and unbounded payouts from a vault.

## Reporting a vulnerability

Open a GitHub security advisory on
[github.com/Eienel/buzz](https://github.com/Eienel/buzz/security/advisories/new),
or DM [@eienel_eth](https://x.com/eienel_eth). Please do not open a public issue
for anything exploitable.

Include: what breaks, how to reproduce it, and what an attacker gains. A failing
test against the program is the most useful thing you can send.

## On rewards

We are not going to insult anyone with a token bounty. A reward has to beat what
exploiting the bug pays, or it is not a reward. While the protocol is devnet-only
there is nothing to exploit, so what we can offer today is credit: named in this
file and in the release notes, and first call on the paid programme.

A funded programme starts when the protocol holds real value, paid from treasury
fees, sized against the deposit cap in force at the time. The cap goes up only as
review coverage does.

## Scope

In scope: `programs/last-circle/` (the on-chain program), `agents/`, `server/`.

Out of scope: the $BUZZ token contract (a standard Token-2022 mint with mint and
freeze authority revoked), third-party infrastructure, and anything requiring a
compromised private key.

## Self-fulfilling predictions, and why devnet is the exposed case

Moves are revealed before the death is selected, and `select_death` reads the
post-move member counts. Leaving a comb therefore makes it emptier, makes it
likelier to be chosen, and makes a prediction about it likelier to pay.

At the individual level this is the game working: you judged your comb was thin,
you left, and you called it. Everyone commits blind, so a crowd fleeing the same
comb can just as easily hand the death to a different one.

The sybil version is the real concern. Many wallets sitting in one comb, all
predicting it, all leaving, empties it on demand and scores every wallet.

On mainnet this is self-defeating: the rake is 2.5% of everything staked and the
whole leaderboard pool is 0.4688% of that same volume, so manufacturing points
costs more than the points can ever return. The rake is the anti-sybil tax.

On devnet it is not, because play is free, the relayer funds the stakes, and
registration is unlimited. Any prize attached to a devnet season is therefore
awarded on inspection rather than automatically. The mechanic is deliberately
left alone: the rules that would block it would also block legitimate play.

## Relayer exhaustion

The relayer pays PDA rent, an associated token account, the stake and the fees
for every seat it takes, so a worst-case join costs it about 0.0058 SOL. Free
play means the caller pays nothing, so nothing self-limits, and an unmetered
relayer is a few dozen requests from empty.

Mitigated by quota rather than by trust: a cap on live games per wallet, joins
per hour, actions per minute, total queued work, and a solvency floor that stops
accepting seats while the relayer still has enough to settle the games it
already took. Refusing a seat is recoverable; accepting a game that cannot be
settled is not.
