# Last Circle Standing, Spec v1.0 (canonical, build target)

A provably-fair, soft-landing pot game with insane jackpots **and a genuine
skill edge**. NOT a pure casino: you never walk away with nothing.

Validated by simulation (see /sim*.py, /engine): books balance to the cent,
soft landing holds (worst case keep ~50%), house nets a guaranteed 2% of volume,
and high-skill players earn a real long-run ROI edge (+15pp at 50% skill-pool).

---

## 0. One-line identity
> Money decides how much you **can** win. Skill (reading the board) decides how
> much you **actually** win. Luck decides any single game. Nobody hits zero.

---

## 1. Lifecycle
```
Lobby → Running (instances) → Settling → Closed
```
- **Lobby:** anyone creates a circle (becomes its **initiator**) or joins one.
  Each player deposits ONCE. A 4% rake is taken at deposit.
- **Open-join window:** new outside wallets may keep joining until the **50% mark**
  of the game; after that the participant set is **frozen** (anti-manipulation).
  Existing players keep playing fully (move / re-enter) the whole game.
- **Running:** 30s instances; each kills exactly one circle.
- **Settling:** one circle remains → distribute pot. Vault drains to zero.

## 2. Board size & pace
- Each game randomly spawns **6 or 12 circles** (≈50/50, VRF).
- 30s per instance → 6-circle ≈ 2.5min, 12-circle ≈ 5.5min.

## 3. Fixed stake, free movement
- You hold ONE stake (your deposit minus rake). You never add more.
- Each instance you may **move your whole stake** to another circle, FREE.
- Money cannot buy survival; a big stake is a bigger refund-haircut liability.

## 4. Each instance = TWO commit-reveals
1. **Move commit/reveal:** secretly commit stay/move (hashed), then reveal.
2. **Prediction commit/reveal:** secretly predict WHICH circle dies this instance.
   Correct prediction = +1 **skill point** (this is the skill engine, see §7).
Both hidden until reveal → unpredictability comes from opponents, not dice.

## 5. Death rule (fog + fate)
- Players see only a **coarse band** (thin / healthy / crowded) from the PREVIOUS
  instance, never live exact counts. Reading it is intuition.
- Resolve:
  ```
  if VRF_roll < ε (=0.15):  dead = uniform_random(alive)      # FATE STRIKE
  else:                     dead = circle with FEWEST players  # fog/skill
  tie → fewest money → VRF
  ```
- Fate strike means no circle is ever immortal (kills the "stack a circle" Sybil).

## 6. Refund & soft landing
- Deterministic, rises with survival time:
  ```
  r(t) = 0.55 + (0.80 − 0.55) · min(1, t / T_MAX)        # 55% → 80%
  ```
- Dead circle: each member's stake → `stake · r(t)` (carried forward), the haircut
  `stake · (1 − r(t))` → **leftover pot L**.
- Eliminated player then chooses: **LAND** in a surviving circle, or **CASH OUT**
  (bank the refund, leave). You never lose more than the haircut floor.

## 7. Endgame payout, luck pool + SKILL pool
Let `L` = leftover pot (+ any insane-round injection, §9). Split:
```
creator_cut = κ · L                         # κ = 0.15, to winning circle's creator
luck_pool   = (1 − κ) · L · (1 − σ)         # σ = 0.50 skill-pool fraction
skill_pool  = (1 − κ) · L · σ
```
- **Luck pool** → split STAKE-WEIGHTED among final-circle survivors (degens chase size).
- **Skill pool** → split by **skill points / total points** across ALL players who
  played (even those who died) → reading the board well pays, survival or not.
- Plus every survivor gets their (refund-adjusted) **stake back**.
- Result: high-skill ROI **+43%** vs low-skill **+28%** at σ=0.5, a real edge -
  while soft landing & jackpots are untouched. (corr(skill,ROI)≈+0.11: luck still
  rules any single game; skill pays over a season. Poker-like, honest framing.)

## 8. Anti-manipulation (all validated)
- **Stake-weighted reward** → cheap Sybil wallets earn cheap slices (no farm).
- **Skill pool by points** → many wallets just split one pool (no Sybil edge).
- **Fate strike ε** → no circle is unkillable by stacking headcount.
- **50% join-freeze** → no late-wallet flooding of the endgame.
- **Fixed creator = lobby address** → no late-join initiator-bonus capture.

## 9. Insane round + house
- Rake 4% on each deposit, split: **2% house profit (kept forever)** + **2% jackpot
  pool** (a visible growing ticker).
- After the 50% lock, an independent **~2% VRF roll** (revealed post-lock so it can't
  be targeted) may flip the game **INSANE**: the entire jackpot pool injects into `L`.
  Self-funded, un-farmable, sustainable. House profit is never touched.

## 10. Randomness
ONE VRF draw per instance (board size at start, fate strike, ties, insane roll).
Everything else is a published deterministic function, replay-verifiable.

## 11. Invariant (asserted in-program & in the reference engine)
```
Σ deposits  ==  Σ payouts  +  house_profit  +  Δ(jackpot_pool)
```
Exact to the lamport. No funds are ever minted or burned.

---

## Parameters
| Sym | Meaning | Value |
|---|---|---|
| RAKE | deposit fee | 4% |
| HOUSE_CUT | rake kept as profit | 50% (→2% of volume) |
| R_LO / R_HI | refund floor/ceiling | 0.55 / 0.80 |
| κ | creator cut of pot | 0.15 |
| σ | skill-pool fraction | 0.50 |
| ε | fate-strike prob | 0.15 |
| insane_prob | per-game jackpot roll | 0.02 |
| instance | tick length | 30s |
| circles | per game | 6 or 12 |
| min / max stake | deposit bounds | $10 / $2000 |
