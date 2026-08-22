# Last Circle Standing, Solana Architecture (v0.1)

Single-chain Solana first. Base/bridge deferred (see §9). Anchor framework.

---

## 1. Why the commit-reveal + fog is the hard part
The whole game's integrity rests on: (a) nobody sees others' moves before they're
locked, (b) nobody sees exact live headcounts, (c) the death pick can't be
manipulated. Solana is a public ledger, naive on-chain moves are visible in the
mempool/state, which would destroy the fog. So the design is **commit-reveal with
hashed moves**, and the "fog" is enforced by *only revealing aggregates*.

---

## 2. Accounts (PDAs)
```
GameConfig            (singleton)  fee bps, min/max stake, instance length, N bounds
Game        PDA[game_id]           state machine, vrf account, pot totals, instance #
Circle      PDA[game_id, circle_id] creator (initiator), member_count, total_stake
Player      PDA[game_id, wallet]   stake, current_circle, committed_hash, joinT,
                                    refunds, status{active,satout,dead}
Vault       PDA[game_id]           the escrow token account (all SOL/USDC held here)
LeftoverPot PDA[game_id]           accumulated haircuts
```
Key point: **all funds live in one program-owned `Vault`**. Players never hold
game funds; the program is the sole signer for payouts. No per-circle token
accounts (cheaper, fewer attack surfaces).

---

## 3. Game state machine
```
Lobby  --(lobby_timer ends)-->  Running  --(1 circle left)-->  Settling  -->  Closed
```

### Phase: Lobby (open join window, e.g. 30-60s)
- `create_circle(stake)` → opens a Circle, caller = initiator, deposits stake to Vault.
- `join_circle(circle_id, stake)` → deposits to Vault, Player PDA created.
- Stake validated against `[min_stake, max_stake]` (the cap, see cap sim).
- At timer end, anyone can crank `start_game` → freezes participant set.

### Phase: Running (loop of instances)
Each instance has two sub-windows enforced by slots/clock:
1. **Commit window:** `commit_move(hash)` where
   `hash = keccak(circle_target || nonce || wallet)`. Only the hash is stored -
   **moves are invisible**, preserving fog. Players who don't commit = "hold".
2. **Reveal window:** `reveal_move(circle_target, nonce)` → program checks
   `keccak(...) == committed_hash`, then applies the move to Circle counters.
   Un-revealed commits are discarded (treated as hold), no penalty needed.
3. **Resolve:** `resolve_instance` (permissionless crank):
   - reads the per-instance **VRF** result (for tie-breaks only),
   - finds min(member_count); ties → min(total_stake) → VRF index,
   - kills that Circle, computes `r(t)`, moves haircut → LeftoverPot,
   - marks dead members `pending_refund` (they act next).
4. **Death follow-up:** each dead member calls `land(circle_id)` or `sit_out()`
   within a short window; default if no action = auto-land into largest circle.

### Phase: Settling
- One circle remains. `settle` distributes: initiator κ-cut of LeftoverPot,
  join-weighted pool to members, stake-back to all survivors. Sat-out players
  already withdrew. Vault drains to zero (assert!).

---

## 4. The fog, what's on-chain vs shown
- **On-chain (public):** total stake per circle, game phase, instance number,
  pot size. NOT exact member_count during the commit window.
- **Trick:** `member_count` is only *finalized* at resolve. During commit, the
  client shows a **coarse band** ("thin / healthy / crowded") derived from the
  *previous* instance's finalized count, never the live one. Since current-instance
  moves are hashed and unrevealed, the true live count is *unknowable on-chain too*
  until reveal. Fog is therefore cryptographic, not just UI.
- This is the crux: even a validator reading raw state cannot see who's moving
  where until the reveal window, exactly the poker-table uncertainty we modeled.

---

## 5. Randomness (VRF)
- Use **Switchboard On-Demand** or **ORAO** VRF, one request per instance,
  consumed only for tie-breaks and any cosmetic shuffles.
- VRF result must be requested at instance start and *settled before resolve* -
  resolve reverts if VRF not ready (liveness handled by the crank retrying).
- Because RNG only breaks ties, a VRF stall can't change a non-tie outcome.

---

## 6. The crank / liveness
- Instances advance via **permissionless cranks** (`resolve_instance`), incentivized
  by a tiny fixed fee from the house cut. If no one cranks, the game just waits -
  funds are safe in Vault (no funds move without a valid crank + VRF).
- A keeper bot run by the team cranks by default; anyone can step in.

---

## 7. Economic invariants (assert in-program)
```
Vault.balance == Σ active stakes + LeftoverPot + unclaimed refunds   (always)
at Settle: total paid out + house_taken == total deposited           (to the lamport)
```
These are the on-chain version of the sim's "$0 solvency" check. The program
should `require!` them so a bug can never mint or burn funds.

---

## 8. Client / indexer
- Anchor program + a lightweight indexer (Helius webhooks or Geyser) feeding the
  frontend the *coarse* circle states and the clock. Frontend handles the
  commit/reveal UX (stores nonce locally, auto-reveals).
- Wallet: standard Solana wallet adapter; gasless reveal via a relayer optional.

---

## 9. Base + bridge (DEFERRED, do not build in v1)
- Ship Solana-only. Prove the loop, the economics, the legal posture.
- Later: a **deposit bridge**, not a cross-chain live game. Base users bridge
  USDC → Solana via a canonical bridge (Wormhole/CCTP), play on Solana, bridge
  winnings back. The game logic stays 100% on one chain, never split live state
  across chains (that's the part that gets exploited). This keeps the attack
  surface to "a bridge for deposits," a solved problem, vs "a cross-chain
  consensus game," an unsolved one.

---

## 10. Build order
1. Core Anchor program: Lobby → escrow → single instance → settle (no fog yet).
2. Add commit-reveal + fog.
3. Add VRF tie-break + permissionless crank + keeper.
4. Invariant asserts + fuzz/property tests (mirror the Python sims).
5. Audit. Then mainnet with low max-stake cap.
6. (Much later) Base deposit bridge.
