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
