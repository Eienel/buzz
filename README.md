# Last Circle Standing

A provably-fair, soft-landing pot game on Solana **with a genuine skill edge** —
not a casino. You never walk away with nothing.

> Money decides how much you **can** win. Skill (reading the board) decides how
> much you **actually** win. Luck decides any single game. Nobody hits zero.

See **[SPEC.md](SPEC.md)** for the full game design (v1.0, simulation-validated)
and **[ARCHITECTURE.md](ARCHITECTURE.md)** for the on-chain design.

## Status — build in progress
- [x] Game design locked & simulation-validated (`/sim*.py`, `/engine`)
- [x] Milestone 1: config + SOL escrow + lobby state machine
- [ ] Milestone 2: instance loop + commit-reveal moves
- [ ] Milestone 3: fog/fate death resolution + VRF
- [ ] Milestone 4: prediction skill-pool
- [ ] Milestone 5: settlement + invariant asserts
- [ ] Milestone 6: insane round + jackpot pool
- [ ] Audit → mainnet

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
