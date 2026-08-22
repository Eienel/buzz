# BUZZ, Last Circle Standing

A provably-fair, soft-landing pot game on Solana with a real skill edge.
You never walk away with nothing.

> Money sets your ceiling. Skill (reading the board) sets your take. Luck decides any single game. Nobody hits zero.

See **[SPEC.md](SPEC.md)** for the full game design (v1.0, simulation-validated)
and **[ARCHITECTURE.md](ARCHITECTURE.md)** for the on-chain design.

## Status, feature-complete, hardening next
- [x] Game design locked & simulation-validated (`/sim*.py`, `/engine`)
- [x] Milestone 1: config + SOL escrow + lobby state machine
- [x] Milestone 2: instance loop + commit-reveal moves
- [x] Milestone 3: fog/fate death resolution + refunds + cash-out/land
- [x] Milestone 4: prediction skill-pool
- [x] Milestone 5: settlement (creator cut + luck pool + skill pool)
- [x] Milestone 6: treasury (house revenue) + insane-round jackpot
- [x] Hardening: open-join window to the 50% lock; anti-grind entropy
      (pre-committed slot hash); dead-circle escape + post-settlement land fixes
- [x] Rent recovery: close_player / close_circle / close_game (vault drains to 0)
- [ ] Hardening: real VRF (Switchboard) behind the `slothash_at` seam;
      in-program conservation asserts; lobby-abort refund
- [ ] Pre-mainnet review: refund scoping (rate is per-circle, so late joiners get
      the founder's rate) and haircut compounding across re-entries (~13.7% left
      after landing through 5 deaths). Both deliberate today, both re-examined
      with the simulations before real value is staked.
- [ ] Audit → mainnet

All integration tests green on CI (real validator). The slot-hash entropy in
`select_death` / `roll_insane` MUST be replaced with a VRF before mainnet.
Hackathon plan: see [HACKATHON.md](HACKATHON.md).

## Layout
```
programs/last-circle/   Anchor program (Rust)
tests/                  TypeScript integration tests (run on a local validator)
sim_*.py                Reference simulations (economic validation)
SPEC.md                 Canonical game spec v1.0
ARCHITECTURE.md         On-chain architecture
.github/workflows/      CI: builds + tests the program on every push
```

## Develop
The heavy toolchain (Rust + Solana + Anchor) runs in **GitHub Actions CI** on push.
Locally you can iterate on game logic via the reference simulations:
```
python sim_final.py        # season-level economic check
```

## Toolchain (CI-pinned)
- Solana 1.18.26 · Anchor 0.30.1 · Rust 1.79
