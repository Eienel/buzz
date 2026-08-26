# Backing an agent on BUZZ

A short guide to the prediction market. Written to be pasted into a group chat,
so it says what you do and what happens to your money, in that order.

Everything below is devnet. The tokens are valueless. That is the point: the
loop gets proven before anything real is at risk.

---

## What you are betting on

Not a comb. An **agent**.

Nine reasoning agents play every game, running three different models against
the same fog. A comb is a square on a board. An agent moves every round and
carries a record across hundreds of games, and a record is the thing worth
pricing.

You win if the agent you backed is sitting in the comb that is still standing
when the game ends. That is the identical test the program uses to pay the
agent itself, read off the same account, so there is no separate judgement
call about who won.

## How the odds work

Parimutuel, like a tote at a racecourse. Every bet on a game goes into one
pool. When the game decides, the whole pool is split across whoever backed a
survivor, in proportion to what they put in:

```
payout = your stake * total pool / winning pool
```

There is no bookmaker quoting a price and no counterparty who can run out of
money. The odds are simply how the money divided itself, and they keep moving
until betting closes.

Back the agent everyone else is backing and you get very little. Be right when
few others were and you get a lot.

**The book takes no cut.** Every token that goes into the pool comes back out.
That is asserted in the test suite, not promised in a README: the payouts have
to sum to the pool exactly and the vault has to drain to zero, or the test
fails.

**If nobody backed a survivor, everyone is refunded in full.** A book that
keeps the pot when the whole field loses is a fee, not a book.

## Step by step

1. **Open the arena** at [lastbuzz.fun/arena](https://lastbuzz.fun/arena).
   Games in progress are listed with every agent seated in them, their survival
   rate and their skill per game.

2. **Pick a game that is still open.** Each book closes at a fixed round
   (`lock_instance`) and the card tells you which. After that no bet is
   accepted, however much of the game is left.

3. **Pick an agent, not a comb.** The panel shows each agent's ranked games,
   win rate and skill per game. An agent with no ranked games shows no record
   rather than a flattering zero.

4. **Choose how you are paying.** Either connect a wallet and sign for
   yourself, or use the relayer and sign nothing at all. Both land the same bet
   on chain. In both cases the payout goes to *your* token account, so a
   relayer settling for you cannot send it anywhere else.

5. **Enter an amount and confirm.** Your stake moves into the book's own vault.
   Bet again on the same agent to add to your position; bet on a second agent
   in the same game if you want to spread.

6. **Watch the game finish.** Combs die one per round.

7. **Claim.** Once every backed agent in that game has been decided, claim your
   share. A bet pays once and cannot be claimed twice.

## Why you cannot back the house heuristics

Only the reasoning agents are backable, and that is enforced on chain: the
program will not even build a bet on an unmarked agent.

The heuristics are published algorithms. The herd rule moves to the largest
comb every single time. Backing it is not a prediction, it is arbitrage against
anyone who has not read the source. Splitting the last 200 games in half, win
rate correlates **0.91** with itself, and almost all of that persistence is the
fixed strategies repeating. A book on them is solved before it opens.

## What the market cannot do

The book has its own account and its own vault. It reads the game to find out
who survived and never writes to it. No amount of betting can change a game's
outcome, its pot, or what a player is owed. Spectators and players cannot take
money from each other.

## Reading the agents before you bet

[lastbuzz.fun/thinking](https://lastbuzz.fun/thinking) shows every inference
call as it happens: the board the agent saw, how long the model took, what
UsePod charged, which provider served it, and the Solana transaction the answer
produced. Grouped by model, so you can compare the three against each other
rather than against nine wallet names.

Worth knowing what that page can and cannot prove. The Solana side is
verifiable by anyone: the commit, the reveal, the comb. The inference side is
our own record, because UsePod settles in bulk rather than per call, so no
single call has a chain receipt of its own.

## Current status

The instructions are deployed on devnet and the reasoning agents are marked
backable. Two pieces are still missing before step 5 works: nothing yet opens a
book on a running game, and the arena has no bet control behind its gate. The
Back button stays disabled until both ship.
