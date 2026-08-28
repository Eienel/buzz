//! BUZZ (Last Comb Standing), on-chain program (Solana / Anchor).
//!
//! Build milestone 1: config + SOL escrow + lobby state machine.
//! (create_game / create_circle / join_circle / start_game)
//! Instance loop, commit-reveal, fog/fate death, prediction skill-pool, and
//! settlement land in subsequent milestones. See /SPEC.md and /ARCHITECTURE.md.
//!
//! Economic identity (asserted as invariants as logic is added):
//!   Σ deposits == Σ payouts + house_profit + Δ(jackpot_pool)   (exact to the lamport)

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use switchboard_on_demand::accounts::RandomnessAccountData;

declare_id!("4TNbztSMd3zxG57M25y8WhpcKrQMJQVYEK6EnnkQy1Hw");

/// Basis-points denominator.
const BPS: u128 = 10_000;
/// Fate-strike probability ε = 15% (a uniformly random circle dies).
const FATE_STRIKE_BPS: u64 = 1_500;
/// Refund floor/ceiling in bps (55% → 80%, rising with survival time).
const REFUND_LO_BPS: u64 = 5_500;
const REFUND_HI_BPS: u64 = 8_000;
/// Endgame split: creator cut κ = 15% of the leftover pot.
const KAPPA_BPS: u128 = 1_500;
/// Of the remaining pot, σ = 50% forms the skill pool, the rest the luck pool.
const SIGMA_BPS: u128 = 5_000;
/// A lobby that never starts becomes abortable after this long, so deposits can
/// never be stranded by an authority that walks away.
const LOBBY_TIMEOUT_SECONDS: i64 = 3_600;
/// Combs that must be open before a game may start. Two combs is a coin flip
/// and three is barely a choice; the fog only means anything when hiding in a
/// crowd is a real option. This is the floor at START, not during play: combs
/// die down to one winner as normal.
const MIN_CIRCLES: u8 = 4;
/// Bounds on how long an instance may run. A game picks its own tempo at
/// creation, so a fast lobby and a slow one can be live at the same time.
/// 10s is deliberately low: it is a guard against nonsense values, not a
/// statement about how fast a real game should run. The integration suite plays
/// at this tempo so CI stays quick.
const MIN_INSTANCE_SECONDS: u32 = 10;
/// How the house cut divides. Leaderboard rewards, a burn, and the rest
/// converted to SOL to fund the arena.
const LEADERBOARD_BPS: u64 = 2_500;
const BURN_BPS: u64 = 2_500;
const MAX_INSTANCE_SECONDS: u32 = 3_600;
/// Hard ceiling on what a single game may ever take in. Each game escrows into
/// its own vault PDA, so this bounds the blast radius of any bug we have not
/// found to one game's deposits. Deliberately a compile-time constant rather
/// than a config field: raising it takes a program upgrade anyone can see on
/// chain, not an admin transaction. Raise only as audit coverage grows.
const MAX_GAME_DEPOSITS: u64 = 2_000_000_000; // 2 SOL

#[program]
pub mod last_circle {
    use super::*;

    /// One-time global config (fee schedule, stake bounds, tick length).
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        fee_bps: u16,
        house_cut_bps: u16,
        min_stake: u64,
        max_stake: u64,
        instance_seconds: u32,
        insane_prob_bps: u16,
    ) -> Result<()> {
        require!(fee_bps <= 2_000, GameError::BadParam); // cap rake at 20%
        require!(house_cut_bps <= 10_000, GameError::BadParam);
        require!(insane_prob_bps <= 10_000, GameError::BadParam);
        require!(min_stake > 0 && max_stake >= min_stake, GameError::BadParam);
        require!(instance_seconds > 0, GameError::BadParam);

        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.fee_bps = fee_bps;
        c.house_cut_bps = house_cut_bps;
        c.min_stake = min_stake;
        c.max_stake = max_stake;
        c.instance_seconds = instance_seconds;
        c.insane_prob_bps = insane_prob_bps;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Open a new game arena in the Lobby phase. `num_circles` is 6 or 12.
    pub fn create_game(
        ctx: Context<CreateGame>,
        game_id: u64,
        num_circles: u8,
        instance_seconds: u32,
        require_vrf: bool,
    ) -> Result<()> {
        require!(num_circles == 6 || num_circles == 12, GameError::BadParam);
        require!(
            (MIN_INSTANCE_SECONDS..=MAX_INSTANCE_SECONDS).contains(&instance_seconds),
            GameError::BadParam
        );

        let g = &mut ctx.accounts.game;
        g.game_id = game_id;
        g.authority = ctx.accounts.authority.key();
        g.status = GameStatus::Lobby;
        g.num_circles = num_circles;
        // join-freeze at the 50% mark: half of the (num_circles - 1) instances.
        g.lock_instance = (((num_circles as u16) - 1) / 2).max(1);
        g.instance = 0;
        g.phase = InstancePhase::Commit;
        g.phase_ends_at = 0;
        g.instance_seconds = instance_seconds;
        g.doomed_circle = 0;
        g.circle_count = 0;
        g.player_count = 0;
        g.alive_circles = 0;
        g.leftover_pot = 0;
        g.fees_collected = 0;
        g.total_deposited = 0;
        g.total_points = 0;
        g.entropy_slot = 0;
        g.insane_entropy_slot = 0;
        g.created_at = Clock::get()?.unix_timestamp;
        g.stake_mint = ctx.accounts.stake_mint.key();
        g.fee_bps = ctx.accounts.config.fee_bps;
        g.require_vrf = require_vrf;
        g.creator_cut_paid = false;
        g.insane_rolled = false;
        g.insane = false;
        g.vault_bump = ctx.bumps.vault;
        g.bump = ctx.bumps.game;
        Ok(())
    }

    /// Create a circle in the lobby (caller becomes its fixed initiator) and stake into it.
    pub fn create_circle(ctx: Context<CreateCircle>, circle_id: u8, stake: u64) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(g.status == GameStatus::Lobby, GameError::WrongPhase);
        require!(circle_id < g.num_circles, GameError::BadParam);
        let delegate = resolve_delegate(&ctx.accounts.owner, &ctx.accounts.payer, &ctx.accounts.relayer)?;

        let net = take_deposit(
            &ctx.accounts.config,
            g.fee_bps,
            stake,
            &ctx.accounts.payer_token,
            &ctx.accounts.vault,
            &ctx.accounts.stake_mint,
            &ctx.accounts.payer,
            &ctx.accounts.token_program,
        )?;
        record_deposit(g, stake, net)?;

        let circle = &mut ctx.accounts.circle;
        circle.game = g.key();
        circle.circle_id = circle_id;
        circle.creator = ctx.accounts.owner.key(); // FIXED initiator (anti-capture, SPEC §8)
        circle.member_count = 1;
        circle.total_stake = net;
        circle.alive = true;
        circle.refund_bps = 0;
        circle.bump = ctx.bumps.circle;

        init_player(&mut ctx.accounts.player, g.key(), ctx.accounts.owner.key(), delegate, net, circle_id, ctx.bumps.player);

        g.circle_count += 1;
        g.alive_circles += 1;
        g.player_count += 1;
        Ok(())
    }

    /// Join an existing circle and stake into it. Allowed during the Lobby, and
    /// for newcomers during the Commit phase of running instances STRICTLY before
    /// the 50% lock (`instance < lock_instance`); frozen from the lock instance
    /// onward. The strict bound leaves no instance where joins are open at the
    /// same time the post-lock insane roll (armed at `instance >= lock_instance`)
    /// is computable, so the jackpot outcome can never be targeted at deposit.
    pub fn join_circle(ctx: Context<JoinCircle>, stake: u64) -> Result<()> {
        let g = &mut ctx.accounts.game;
        let open = g.status == GameStatus::Lobby
            || (g.status == GameStatus::Running
                && g.phase == InstancePhase::Commit
                && g.instance < g.lock_instance
                && Clock::get()?.unix_timestamp < g.phase_ends_at);
        require!(open, GameError::JoinWindowClosed);
        require!(ctx.accounts.circle.alive, GameError::CircleDead);
        let delegate = resolve_delegate(&ctx.accounts.owner, &ctx.accounts.payer, &ctx.accounts.relayer)?;

        let net = take_deposit(
            &ctx.accounts.config,
            g.fee_bps,
            stake,
            &ctx.accounts.payer_token,
            &ctx.accounts.vault,
            &ctx.accounts.stake_mint,
            &ctx.accounts.payer,
            &ctx.accounts.token_program,
        )?;
        record_deposit(g, stake, net)?;

        let circle = &mut ctx.accounts.circle;
        circle.member_count += 1;
        circle.total_stake = circle.total_stake.checked_add(net).ok_or(GameError::MathOverflow)?;

        init_player(&mut ctx.accounts.player, g.key(), ctx.accounts.owner.key(), delegate, net, circle.circle_id, ctx.bumps.player);

        g.player_count += 1;
        Ok(())
    }

    /// Close the lobby and start the instance loop (instance 1, Commit phase).
    pub fn start_game(ctx: Context<StartGame>) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(g.status == GameStatus::Lobby, GameError::WrongPhase);
        require!(g.alive_circles >= MIN_CIRCLES, GameError::NotEnoughCircles);
        let now = Clock::get()?.unix_timestamp;
        g.status = GameStatus::Running;
        g.instance = 1;
        g.phase = InstancePhase::Commit;
        g.phase_ends_at = now + g.commit_window();
        Ok(())
    }

    /// Commit a hashed move for the current instance (hides stay/move under fog).
    /// hash = keccak(target_circle ‖ nonce_le ‖ owner ‖ game ‖ instance_le).
    pub fn commit_move(ctx: Context<CommitMove>, hash: [u8; 32]) -> Result<()> {
        let g = &ctx.accounts.game;
        require!(g.status == GameStatus::Running, GameError::WrongPhase);
        require!(g.phase == InstancePhase::Commit, GameError::WrongPhase);
        require!(Clock::get()?.unix_timestamp < g.phase_ends_at, GameError::PhaseEnded);
        let p = &mut ctx.accounts.player;
        require!(p.status == PlayerStatus::Active, GameError::PlayerInactive);
        p.committed_hash = hash;
        p.commit_instance = g.instance;
        Ok(())
    }

    /// Permissionless crank: end the commit window, open the reveal window.
    pub fn advance_to_reveal(ctx: Context<Crank>) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(g.status == GameStatus::Running, GameError::WrongPhase);
        require!(g.phase == InstancePhase::Commit, GameError::WrongPhase);
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        require!(now >= g.phase_ends_at, GameError::PhaseNotOver);
        g.phase = InstancePhase::Reveal;
        g.phase_ends_at = now + g.reveal_window();
        // Commit NOW to the future slot whose hash will seed this instance's
        // death roll. It must land PAST the reveal deadline so the seed can't be
        // computed while players can still choose to reveal/withhold: at up to
        // ~2.5 slots/sec, reveal_window*3 slots always exceeds reveal_window
        // seconds. Fixing the slot before its hash exists makes select_death
        // submission-time grinding useless.
        g.entropy_slot = clock.slot + (g.reveal_window() as u64) * 3 + 4;
        Ok(())
    }

    /// Reveal a committed MOVE (target must differ from current circle) and apply
    /// it: move the player's whole stake from `from_circle` to `to_circle`.
    pub fn reveal_move(ctx: Context<RevealMove>, target_circle: u8, nonce: u64) -> Result<()> {
        let g = &ctx.accounts.game;
        require!(g.status == GameStatus::Running, GameError::WrongPhase);
        require!(g.phase == InstancePhase::Reveal, GameError::WrongPhase);
        require!(Clock::get()?.unix_timestamp < g.phase_ends_at, GameError::PhaseEnded);

        let p = &mut ctx.accounts.player;
        require!(p.commit_instance == g.instance, GameError::NothingCommitted);
        require!(target_circle != p.current_circle, GameError::NotAMove);

        // Recompute the commitment and check it matches.
        let expected = anchor_lang::solana_program::keccak::hashv(&[
            &[target_circle],
            &nonce.to_le_bytes(),
            p.owner.as_ref(),
            g.key().as_ref(),
            &g.instance.to_le_bytes(),
        ]);
        require!(expected.0 == p.committed_hash, GameError::BadReveal);

        let from = &mut ctx.accounts.from_circle;
        let to = &mut ctx.accounts.to_circle;
        require!(from.circle_id == p.current_circle, GameError::BadParam);
        // A member of a dead circle must exit via land/cash_out (which applies
        // the refund haircut), moving out with the full stake would double-count
        // the haircut already swept into the leftover pot.
        require!(from.alive, GameError::CircleDead);
        require!(to.circle_id == target_circle, GameError::BadParam);
        require!(to.alive, GameError::CircleDead);

        from.member_count -= 1;
        from.total_stake = from.total_stake.checked_sub(p.stake).ok_or(GameError::MathOverflow)?;
        to.member_count += 1;
        to.total_stake = to.total_stake.checked_add(p.stake).ok_or(GameError::MathOverflow)?;

        p.current_circle = target_circle;
        p.commit_instance = 0; // consumed; prevents double-reveal
        Ok(())
    }

    /// Permissionless crank: end the reveal window and SELECT the dying circle.
    /// Pass every alive Circle as a remaining_account. With prob ε a uniformly
    /// random circle dies (FATE STRIKE); otherwise the FEWEST-players circle
    /// dies (tie → least stake → pseudo-random). Stores the doomed id; the
    /// mutation happens in execute_death.
    ///
    /// Randomness comes from a settled Switchboard value when one is supplied, and
    /// otherwise from the slot hash the game committed to in advance. `require_vrf`
    /// swaps in a real VRF before mainnet.
    pub fn select_death<'info>(
        ctx: Context<'_, '_, 'info, 'info, SelectDeath<'info>>,
    ) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(g.status == GameStatus::Running, GameError::WrongPhase);
        require!(g.phase == InstancePhase::Reveal, GameError::WrongPhase);
        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= g.phase_ends_at, GameError::PhaseNotOver);
        // The pre-committed entropy slot must have passed, so its hash is fixed
        // on-chain and the cranker cannot pick a favorable submission slot.
        // strict >: at slot == entropy_slot the SlotHashes sysvar's newest entry
        // is still entropy_slot-1, so we must wait until entropy_slot itself is
        // recorded, otherwise the seed varies by one slot of submission timing.
        require!(g.entropy_slot > 0 && clock.slot > g.entropy_slot, GameError::PhaseNotOver);

        // Collect all alive circles from the remaining accounts.
        let mut alive: Vec<(u8, u32, u64)> = Vec::with_capacity(g.alive_circles as usize);
        for acc in ctx.remaining_accounts.iter() {
            let c: Account<Circle> = Account::try_from(acc)?;
            require!(c.game == g.key(), GameError::BadParam);
            if c.alive {
                alive.push((c.circle_id, c.member_count, c.total_stake));
            }
        }
        // Canonicalize by circle_id: the selection must NOT depend on the order
        // the cranker passed the accounts in (with fixed entropy that would let
        // them deterministically choose the victim). Sorting + a strict
        // no-duplicates check also guarantees the set is exactly the alive
        // circles, a dup like [A,A,B] can no longer pass the count check while
        // silently excluding C.
        alive.sort_by_key(|x| x.0);
        for w in alive.windows(2) {
            require!(w[0].0 != w[1].0, GameError::BadParam);
        }
        // Caller must present EVERY alive circle, else the min could be gamed.
        require!(alive.len() as u8 == g.alive_circles, GameError::IncompleteCircleSet);
        require!(alive.len() >= 2, GameError::NotEnoughCircles);

        // Entropy = the SlotHashes entry at (or nearest before) the slot we
        // committed to in advance_to_reveal, mixed with game/instance for
        // domain separation. Deliberately no clock.slot in the seed: it must
        // not vary with WHEN the crank lands.
        let entropy = randomness_seed(
            ctx.accounts.randomness.as_ref().map(|a| a.as_ref()),
            &ctx.accounts.recent_slot_hashes,
            g.entropy_slot,
            &clock,
            g.require_vrf,
        )?;
        let seed = anchor_lang::solana_program::keccak::hashv(&[
            &entropy,
            &g.entropy_slot.to_le_bytes(),
            &g.instance.to_le_bytes(),
            g.key().as_ref(),
        ])
        .0;
        let r1 = u64::from_le_bytes(seed[0..8].try_into().unwrap());
        let r2 = u64::from_le_bytes(seed[8..16].try_into().unwrap());

        let doomed = if (r1 % 10_000) < FATE_STRIKE_BPS {
            // FATE STRIKE: uniformly random alive circle.
            alive[(r2 as usize) % alive.len()].0
        } else {
            // Skill/fog: fewest players, tie → least stake, tie → pseudo-random.
            let min_members = alive.iter().map(|x| x.1).min().unwrap();
            let mut cand: Vec<&(u8, u32, u64)> = alive.iter().filter(|x| x.1 == min_members).collect();
            if cand.len() > 1 {
                let min_stake = cand.iter().map(|x| x.2).min().unwrap();
                cand.retain(|x| x.2 == min_stake);
            }
            cand[(r2 as usize) % cand.len()].0
        };

        g.doomed_circle = doomed;
        g.phase = InstancePhase::Resolving;
        Ok(())
    }

    /// Permissionless crank: kill the doomed circle, lock its refund rate, sweep
    /// the haircut into the leftover pot, and either advance to the next instance
    /// or move to Settling if only one circle remains.
    pub fn execute_death(ctx: Context<ExecuteDeath>, circle_id: u8) -> Result<()> {
        let g = &mut ctx.accounts.game;
        let c = &mut ctx.accounts.circle;
        require!(g.status == GameStatus::Running, GameError::WrongPhase);
        require!(g.phase == InstancePhase::Resolving, GameError::WrongPhase);
        require!(circle_id == g.doomed_circle, GameError::BadParam);
        require!(c.circle_id == circle_id && c.alive, GameError::BadParam);

        let r_bps = refund_bps(g.instance, g.num_circles);
        c.alive = false;
        c.refund_bps = r_bps;
        g.alive_circles -= 1;

        // Haircut (the un-refunded slice) feeds the leftover pot.
        let haircut = (c.total_stake as u128 * (BPS - r_bps as u128) / BPS) as u64;
        g.leftover_pot = g.leftover_pot.checked_add(haircut).ok_or(GameError::MathOverflow)?;

        // Open the scoring window: players reveal predictions against this death.
        let now = Clock::get()?.unix_timestamp;
        g.phase = InstancePhase::Scoring;
        g.phase_ends_at = now + g.reveal_window();
        Ok(())
    }

    /// Commit a hashed prediction of WHICH circle dies this instance.
    /// hash = keccak(predicted_circle ‖ nonce_le ‖ owner ‖ game ‖ instance_le).
    pub fn commit_prediction(ctx: Context<CommitMove>, hash: [u8; 32]) -> Result<()> {
        let g = &ctx.accounts.game;
        require!(g.status == GameStatus::Running, GameError::WrongPhase);
        require!(g.phase == InstancePhase::Commit, GameError::WrongPhase);
        require!(Clock::get()?.unix_timestamp < g.phase_ends_at, GameError::PhaseEnded);
        let p = &mut ctx.accounts.player;
        require!(p.status == PlayerStatus::Active, GameError::PlayerInactive);
        p.prediction_hash = hash;
        p.prediction_instance = g.instance;
        Ok(())
    }

    /// Reveal a prediction during the Scoring window; a correct call (matching the
    /// circle that died this instance) earns +1 skill point.
    pub fn reveal_prediction(ctx: Context<RevealPrediction>, predicted_circle: u8, nonce: u64) -> Result<()> {
        // snapshot the game fields we need so we can mutate game + player after.
        let (status, phase, ends, instance, doomed, gkey) = {
            let g = &ctx.accounts.game;
            (g.status, g.phase, g.phase_ends_at, g.instance, g.doomed_circle, g.key())
        };
        require!(status == GameStatus::Running, GameError::WrongPhase);
        require!(phase == InstancePhase::Scoring, GameError::WrongPhase);
        require!(Clock::get()?.unix_timestamp < ends, GameError::PhaseEnded);

        let p = &mut ctx.accounts.player;
        require!(p.prediction_instance == instance, GameError::NothingCommitted);
        let expected = anchor_lang::solana_program::keccak::hashv(&[
            &[predicted_circle],
            &nonce.to_le_bytes(),
            p.owner.as_ref(),
            gkey.as_ref(),
            &instance.to_le_bytes(),
        ]);
        require!(expected.0 == p.prediction_hash, GameError::BadReveal);

        let correct = predicted_circle == doomed;
        if correct {
            p.points += 1;
        }
        p.prediction_instance = 0; // consumed
        if correct {
            ctx.accounts.game.total_points += 1;
        }
        Ok(())
    }

    /// Permissionless crank: end the scoring window and either advance to the
    /// next instance's commit phase, or move to Settling if one circle remains.
    pub fn advance_instance(ctx: Context<Crank>) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(g.status == GameStatus::Running, GameError::WrongPhase);
        require!(g.phase == InstancePhase::Scoring, GameError::WrongPhase);
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        require!(now >= g.phase_ends_at, GameError::PhaseNotOver);
        if g.alive_circles == 1 {
            g.status = GameStatus::Settling;
        } else {
            g.instance += 1;
            g.phase = InstancePhase::Commit;
            g.phase_ends_at = now + g.commit_window();
            // Crossing the 50% lock arms the insane roll: commit to a future
            // slot so roll_insane's cranker cannot grind submission timing.
            if g.instance >= g.lock_instance && g.insane_entropy_slot == 0 {
                g.insane_entropy_slot = clock.slot + 5;
            }
        }
        Ok(())
    }

    /// An eliminated player banks their refund (stake × refund_bps) from the
    /// vault and leaves the game. Their circle must be dead.
    pub fn cash_out(ctx: Context<CashOut>) -> Result<()> {
        let g = &ctx.accounts.game;
        let c = &ctx.accounts.circle;
        let p = &mut ctx.accounts.player;
        require!(!c.alive, GameError::CircleAlive);
        require!(c.circle_id == p.current_circle, GameError::BadParam);
        require!(p.status == PlayerStatus::Active, GameError::PlayerInactive);

        let refund = (p.stake as u128 * c.refund_bps as u128 / BPS) as u64;
        transfer_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.owner_token,
            &ctx.accounts.stake_mint,
            &ctx.accounts.token_program,
            g.key(),
            g.vault_bump,
            refund,
        )?;
        p.status = PlayerStatus::CashedOut;
        p.stake = 0;
        Ok(())
    }

    /// An eliminated player carries their refund forward into a surviving circle.
    pub fn land(ctx: Context<Land>, target_circle: u8) -> Result<()> {
        // Landing is only a live-game action AND only while the outcome is still
        // undecided (>1 circle alive). After the final death the game is still
        // Running through the Scoring window with exactly one circle left; a
        // casualty landing into that known winner would snipe the luck pool
        // risk-free. Once decided, eliminated players may only cash_out.
        require!(ctx.accounts.game.status == GameStatus::Running, GameError::WrongPhase);
        require!(ctx.accounts.game.alive_circles > 1, GameError::WrongPhase);
        let p = &mut ctx.accounts.player;
        let from = &ctx.accounts.from_circle;
        let to = &mut ctx.accounts.to_circle;
        require!(!from.alive, GameError::CircleAlive);
        require!(from.circle_id == p.current_circle, GameError::BadParam);
        require!(to.alive, GameError::CircleDead);
        require!(to.circle_id == target_circle, GameError::BadParam);
        require!(p.status == PlayerStatus::Active, GameError::PlayerInactive);

        let new_stake = (p.stake as u128 * from.refund_bps as u128 / BPS) as u64;
        p.stake = new_stake;
        p.current_circle = target_circle;
        to.member_count += 1;
        to.total_stake = to.total_stake.checked_add(new_stake).ok_or(GameError::MathOverflow)?;
        Ok(())
    }

    // ----- Settlement (status == Settling, one circle left) -----------------

    /// The winning circle's creator claims their κ cut of the leftover pot.
    pub fn claim_creator_cut(ctx: Context<ClaimCreatorCut>) -> Result<()> {
        let (status, leftover, total_points, vbump, gkey, paid) = {
            let g = &ctx.accounts.game;
            (g.status, g.leftover_pot, g.total_points, g.vault_bump, g.key(), g.creator_cut_paid)
        };
        require!(status == GameStatus::Settling, GameError::WrongPhase);
        require!(!paid, GameError::AlreadyClaimed);
        let c = &ctx.accounts.winning_circle;
        require!(c.alive, GameError::BadParam);
        require!(c.creator == ctx.accounts.owner.key(), GameError::Unauthorized);
        if ctx.accounts.actor.key() != ctx.accounts.owner.key() {
            let p = ctx.accounts.player.as_ref().ok_or(GameError::Unauthorized)?;
            require!(p.delegate == ctx.accounts.actor.key(), GameError::Unauthorized);
        }

        let (creator_cut, _, _) = pot_split(leftover, total_points);
        ctx.accounts.game.creator_cut_paid = true;
        transfer_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.owner_token,
            &ctx.accounts.stake_mint,
            &ctx.accounts.token_program,
            gkey,
            vbump,
            creator_cut,
        )
    }

    /// A surviving player (in the winning circle) claims stake-back + their
    /// stake-weighted share of the luck pool.
    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let (status, leftover, total_points, vbump, gkey) = {
            let g = &ctx.accounts.game;
            (g.status, g.leftover_pot, g.total_points, g.vault_bump, g.key())
        };
        require!(status == GameStatus::Settling, GameError::WrongPhase);
        let (c_alive, c_id, c_total) = {
            let c = &ctx.accounts.winning_circle;
            (c.alive, c.circle_id, c.total_stake)
        };
        require!(c_alive, GameError::BadParam);

        let payout = {
            let p = &mut ctx.accounts.player;
            require!(p.current_circle == c_id, GameError::NotInWinningCircle);
            require!(p.status == PlayerStatus::Active, GameError::AlreadyClaimed);
            let (_, luck_pool, _) = pot_split(leftover, total_points);
            let luck_share = if c_total > 0 {
                (luck_pool as u128 * p.stake as u128 / c_total as u128) as u64
            } else {
                0
            };
            let pay = p.stake + luck_share;
            p.status = PlayerStatus::Settled;
            p.stake = 0;
            pay
        };
        // A win is recorded here; points stay claim_skill's job, so an agent
        // that both wins and scores is credited once for each and not twice
        // for either. This is the player's first claim for the game unless
        // claim_skill already ran, which `skill_claimed` records.
        let first_claim = !ctx.accounts.player.skill_claimed;
        credit_stats(&mut ctx.accounts.stats, &mut ctx.accounts.treasury,
                     ctx.accounts.owner.key(), ctx.bumps.stats, 0, true, first_claim)?;
        transfer_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.owner_token,
            &ctx.accounts.stake_mint,
            &ctx.accounts.token_program,
            gkey,
            vbump,
            payout,
        )
    }

    /// Any player who scored skill points claims their points-weighted share of
    /// the skill pool (survivors and eliminated alike).
    pub fn claim_skill(ctx: Context<ClaimSkill>) -> Result<()> {
        let (status, leftover, total_points, vbump, gkey) = {
            let g = &ctx.accounts.game;
            (g.status, g.leftover_pot, g.total_points, g.vault_bump, g.key())
        };
        require!(status == GameStatus::Settling, GameError::WrongPhase);

        let share = {
            let p = &mut ctx.accounts.player;
            require!(!p.skill_claimed, GameError::AlreadyClaimed);
            require!(p.points > 0, GameError::NothingToClaim);
            let (_, _, skill_pool) = pot_split(leftover, total_points);
            let s = (skill_pool as u128 * p.points as u128 / total_points as u128) as u64;
            p.skill_claimed = true;
            s
        };
        let pts = ctx.accounts.player.points;
        // Settled means claim_winnings already counted this game; anything else
        // (Active winner claiming points first, or an eliminated scorer) is the
        // player's first claim.
        let first_claim = ctx.accounts.player.status != PlayerStatus::Settled;
        credit_stats(&mut ctx.accounts.stats, &mut ctx.accounts.treasury,
                     ctx.accounts.owner.key(), ctx.bumps.stats, pts, false, first_claim)?;
        transfer_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.owner_token,
            &ctx.accounts.stake_mint,
            &ctx.accounts.token_program,
            gkey,
            vbump,
            share,
        )
    }

    // ----- Treasury: house revenue + insane-round jackpot -------------------

    /// One-time: create the cross-game treasury.
    pub fn init_treasury(ctx: Context<InitTreasury>) -> Result<()> {
        let t = &mut ctx.accounts.treasury;
        t.authority = ctx.accounts.authority.key();
        t.house_balance = 0;
        t.jackpot_pool = 0;
        t.vault_bump = ctx.bumps.treasury_vault;
        t.bump = ctx.bumps.treasury;
        t.to_sol_balance = 0;
        t.burn_balance = 0;
        t.lb_accruing = 0;
        t.lb_claimable = 0;
        t.pts_accruing = 0;
        t.pts_claimable = 0;
        t.season = 0;
        Ok(())
    }

    /// Sweep a finished game's collected rake into the treasury, split into
    /// house profit (house_cut) and the jackpot pool (the rest).
    pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
        let (status, fees, gkey, gvbump) = {
            let g = &ctx.accounts.game;
            (g.status, g.fees_collected, g.key(), g.vault_bump)
        };
        require!(status == GameStatus::Settling, GameError::WrongPhase);
        require!(fees > 0, GameError::NothingToClaim);

        let house = (fees as u128 * ctx.accounts.config.house_cut_bps as u128 / BPS) as u64;
        let jackpot = fees - house;

        transfer_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.stake_mint,
            &ctx.accounts.token_program,
            gkey,
            gvbump,
            fees,
        )?;
        // House cut splits three ways. Fixed in code rather than config: this is
        // a published policy, so moving it should require an upgrade anyone can
        // see on chain, not a quiet admin transaction.
        let to_lb = (house as u128 * LEADERBOARD_BPS as u128 / BPS) as u64;
        let to_burn = (house as u128 * BURN_BPS as u128 / BPS) as u64;
        let to_sol = house - to_lb - to_burn;      // remainder, so nothing rounds away

        let t = &mut ctx.accounts.treasury;
        t.jackpot_pool = t.jackpot_pool.checked_add(jackpot).ok_or(GameError::MathOverflow)?;
        t.to_sol_balance = t.to_sol_balance.checked_add(to_sol).ok_or(GameError::MathOverflow)?;
        t.burn_balance = t.burn_balance.checked_add(to_burn).ok_or(GameError::MathOverflow)?;
        t.lb_accruing = t.lb_accruing.checked_add(to_lb).ok_or(GameError::MathOverflow)?;
        ctx.accounts.game.fees_collected = 0;
        Ok(())
    }

    /// Treasury authority withdraws accumulated house profit.
    pub fn withdraw_house(ctx: Context<WithdrawHouse>, amount: u64) -> Result<()> {
        let vbump = {
            let t = &ctx.accounts.treasury;
            require!(t.authority == ctx.accounts.authority.key(), GameError::Unauthorized);
            require!(amount <= t.house_balance, GameError::NothingToClaim);
            t.vault_bump
        };
        ctx.accounts.treasury.house_balance -= amount;
        transfer_from_treasury(
            &ctx.accounts.treasury_vault,
            &ctx.accounts.authority_token,
            &ctx.accounts.stake_mint,
            &ctx.accounts.token_program,
            vbump,
            amount,
        )
    }

    /// Post-lock crank: roll for an INSANE round. On a hit, the whole jackpot
    /// pool is injected into this game's leftover pot (and the pool resets).
    /// Revealed after the 50% lock so it can't be targeted at deposit time.
    ///
    /// Same randomness seam as the death roll: a settled Switchboard value when supplied,
    /// the pre-committed slot hash otherwise, and `require_vrf` forbids the fallback.
    pub fn roll_insane(ctx: Context<RollInsane>) -> Result<()> {
        let (status, instance, lock, rolled, entropy_slot, require_vrf, gkey, gvbump) = {
            let g = &ctx.accounts.game;
            (g.status, g.instance, g.lock_instance, g.insane_rolled, g.insane_entropy_slot,
             g.require_vrf, g.key(), g.vault_bump)
        };
        require!(status == GameStatus::Running, GameError::WrongPhase);
        require!(instance >= lock, GameError::TooEarly);
        require!(!rolled, GameError::AlreadyClaimed);

        let clock = Clock::get()?;
        // Roll only once the pre-committed slot has passed; seed from that
        // fixed slot's hash (no clock.slot) so the outcome cannot be ground
        // by choosing when to submit the crank.
        require!(entropy_slot > 0 && clock.slot > entropy_slot, GameError::TooEarly);
        let entropy = randomness_seed(
            ctx.accounts.randomness.as_ref().map(|a| a.as_ref()),
            &ctx.accounts.recent_slot_hashes,
            entropy_slot,
            &clock,
            require_vrf,
        )?;
        let seed = anchor_lang::solana_program::keccak::hashv(&[
            &entropy,
            &entropy_slot.to_le_bytes(),
            gkey.as_ref(),
            b"insane",
        ])
        .0;
        let roll = (u64::from_le_bytes(seed[0..8].try_into().unwrap()) % 10_000) as u16;
        let hit = roll < ctx.accounts.config.insane_prob_bps;

        ctx.accounts.game.insane_rolled = true;
        if hit {
            let jackpot = ctx.accounts.treasury.jackpot_pool;
            if jackpot > 0 {
                transfer_from_treasury(
                    &ctx.accounts.treasury_vault,
                    &ctx.accounts.vault,
                    &ctx.accounts.stake_mint,
                    &ctx.accounts.token_program,
                    ctx.accounts.treasury.vault_bump,
                    jackpot,
                )?;
                ctx.accounts.treasury.jackpot_pool = 0;
                let g = &mut ctx.accounts.game;
                g.leftover_pot = g.leftover_pot.checked_add(jackpot).ok_or(GameError::MathOverflow)?;
            }
            ctx.accounts.game.insane = true;
        }
        let _ = gvbump;
        Ok(())
    }

    /// Authority-only: draw down one of the policy buckets. Separate from the
    /// leaderboard pool on purpose: that one is owed to players and is only
    /// payable through claim_season_reward, so no authority call can reach it.
    /// 0 = to_sol, 1 = burn.
    pub fn withdraw_bucket(ctx: Context<WithdrawHouse>, bucket: u8, amount: u64) -> Result<()> {
        let vbump = {
            let t = &ctx.accounts.treasury;
            require!(t.authority == ctx.accounts.authority.key(), GameError::Unauthorized);
            let available = match bucket {
                0 => t.to_sol_balance,
                1 => t.burn_balance,
                _ => return err!(GameError::BadParam),
            };
            require!(amount <= available, GameError::NothingToClaim);
            t.vault_bump
        };
        {
            let t = &mut ctx.accounts.treasury;
            match bucket {
                0 => t.to_sol_balance -= amount,
                1 => t.burn_balance -= amount,
                _ => unreachable!(),
            }
        }
        transfer_from_treasury(
            &ctx.accounts.treasury_vault,
            &ctx.accounts.authority_token,
            &ctx.accounts.stake_mint,
            &ctx.accounts.token_program,
            vbump,
            amount,
        )
    }

    /// Authority-only: grow an existing treasury to the current layout. The
    /// treasury is permanent and holds real balances, so unlike a game account
    /// it cannot be drained and rebuilt: the address is fixed by its seeds.
    /// Reallocating in place preserves every existing balance and zeroes only
    /// the appended region.
    pub fn migrate_treasury(ctx: Context<MigrateTreasury>) -> Result<()> {
        let info = ctx.accounts.treasury.to_account_info();
        {
            let data = info.try_borrow_data()?;
            // Cannot be an Account<Treasury>: Anchor deserializes during account
            // validation, which happens BEFORE any realloc, and the old layout
            // cannot be parsed as the new one. So the checks Anchor would have
            // done are done here by hand, against raw bytes.
            require!(data.len() >= Treasury::LEGACY_SPACE, GameError::BadParam);
            require!(data[..8] == Treasury::DISCRIMINATOR[..], GameError::BadParam);
            // authority sits immediately after the discriminator in both layouts
            let authority = Pubkey::try_from(&data[8..40]).map_err(|_| GameError::BadParam)?;
            require!(authority == ctx.accounts.authority.key(), GameError::Unauthorized);
            // Already migrated: refuse rather than re-zero live season state.
            require!(data.len() < Treasury::SPACE, GameError::AlreadyClaimed);
        }

        // Top up to the rent-exempt minimum for the larger account first: a
        // realloc that leaves it under-funded would fail the runtime's check.
        let rent = Rent::get()?.minimum_balance(Treasury::SPACE);
        let owed = rent.saturating_sub(info.lamports());
        if owed > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: info.clone(),
                    },
                ),
                owed,
            )?;
        }
        // zero_init true: the appended region must start at zero, which is
        // exactly the correct initial value for every field added.
        info.realloc(Treasury::SPACE, true)?;
        Ok(())
    }

    /// Authority-only: start ranking this mint. Only a mint with an open season
    /// gives leaderboard credit, which is how ranked play stays BUZZ-only
    /// without special-casing any mint in the code.
    pub fn open_season(ctx: Context<SeasonAdmin>) -> Result<()> {
        let t = &mut ctx.accounts.treasury;
        require!(t.authority == ctx.accounts.authority.key(), GameError::Unauthorized);
        require!(t.season == 0, GameError::AlreadyClaimed);
        t.season = 1;
        Ok(())
    }

    /// Authority-only: end the open season and start the next. Whatever nobody
    /// claimed from the previous one rolls back into the new pool rather than
    /// being stranded in the vault.
    pub fn close_season(ctx: Context<SeasonAdmin>) -> Result<()> {
        let t = &mut ctx.accounts.treasury;
        require!(t.authority == ctx.accounts.authority.key(), GameError::Unauthorized);
        require!(t.season > 0, GameError::WrongPhase);
        let unclaimed = t.lb_claimable;
        t.lb_claimable = t.lb_accruing.checked_add(unclaimed).ok_or(GameError::MathOverflow)?;
        t.pts_claimable = t.pts_accruing;
        t.lb_accruing = 0;
        t.pts_accruing = 0;
        t.season = t.season.checked_add(1).ok_or(GameError::MathOverflow)?;
        Ok(())
    }

    /// Claim a share of the last closed season, pro rata by the skill points
    /// earned in it. Pro rata rather than a top-N cliff: every correct call
    /// earns, and there is no ranking to compute or publish.
    pub fn claim_season_reward(ctx: Context<ClaimSeasonReward>) -> Result<()> {
        let (season, pool, total, vbump) = {
            let t = &ctx.accounts.treasury;
            (t.season, t.lb_claimable, t.pts_claimable, t.vault_bump)
        };
        require!(season > 1, GameError::WrongPhase);        // nothing closed yet
        require!(total > 0, GameError::NothingToClaim);

        let share = {
            let a = &mut ctx.accounts.stats;
            // Points belong to exactly one season, and only the closed one pays.
            require!(a.season == season - 1, GameError::NothingToClaim);
            require!(a.season_points > 0, GameError::NothingToClaim);
            let share = (pool as u128 * a.season_points as u128 / total as u128) as u64;
            a.season_points = 0;
            a.season = season;                              // cannot claim twice
            share
        };
        let t = &mut ctx.accounts.treasury;
        t.lb_claimable = t.lb_claimable.saturating_sub(share);
        transfer_from_treasury(
            &ctx.accounts.treasury_vault,
            &ctx.accounts.owner_token,
            &ctx.accounts.stake_mint,
            &ctx.accounts.token_program,
            vbump,
            share,
        )
    }

    /// Authority-only: retune the config. Only games created afterwards see the
    /// new numbers, because every game snapshots its own rake at creation, so
    /// this can never change the terms of a game already being played.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        fee_bps: u16,
        house_cut_bps: u16,
        min_stake: u64,
        max_stake: u64,
        instance_seconds: u32,
        insane_prob_bps: u16,
    ) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(c.authority == ctx.accounts.authority.key(), GameError::Unauthorized);
        require!(fee_bps <= 2_000, GameError::BadParam);        // same 20% cap as init
        require!(house_cut_bps <= 10_000, GameError::BadParam);
        require!(min_stake > 0 && max_stake >= min_stake, GameError::BadParam);
        require!(instance_seconds >= 10, GameError::BadParam);
        require!(insane_prob_bps <= 10_000, GameError::BadParam);
        c.fee_bps = fee_bps;
        c.house_cut_bps = house_cut_bps;
        c.min_stake = min_stake;
        c.max_stake = max_stake;
        c.instance_seconds = instance_seconds;
        c.insane_prob_bps = insane_prob_bps;
        Ok(())
    }

    /// Authority-only: mark an SPL mint playable. Combs can only ever be opened
    /// in a mint that has one of these, so $BUZZ and $ANSEM are enabled
    /// deliberately and anything else is refused.
    pub fn allow_mint(ctx: Context<AllowMint>, enabled: bool) -> Result<()> {
        require!(
            ctx.accounts.config.authority == ctx.accounts.authority.key(),
            GameError::Unauthorized
        );
        let a = &mut ctx.accounts.allowed;
        a.mint = ctx.accounts.mint.key();
        a.enabled = enabled;
        a.bump = ctx.bumps.allowed;
        Ok(())
    }

    /// Authority-only: mark a key allowed to stake on another's behalf. This is
    /// how the x402 relayer gets to open combs for ClawPump agents, which cannot
    /// sign Solana instructions themselves. The relayer funds the stake and pays
    /// the rent; the agent is still the on-chain `Player.owner`, so points and
    /// every payout stay with the agent.
    pub fn allow_relayer(ctx: Context<AllowRelayer>, enabled: bool) -> Result<()> {
        require!(
            ctx.accounts.config.authority == ctx.accounts.authority.key(),
            GameError::Unauthorized
        );
        let a = &mut ctx.accounts.allowed;
        a.relayer = ctx.accounts.relayer.key();
        a.enabled = enabled;
        a.bump = ctx.bumps.allowed;
        Ok(())
    }

    /// Owner-only: hand acting rights to another key, or take them back by
    /// passing the owner's own key. Independent of the relayer allow-list, an
    /// agent that later gets its own signer can always cut the relayer out.
    pub fn set_delegate(ctx: Context<SetDelegate>, delegate: Pubkey) -> Result<()> {
        ctx.accounts.player.delegate = delegate;
        Ok(())
    }

    /// Permissionless: a lobby that never started becomes abortable an hour
    /// after it opened. No authority can strand deposits by walking away.
    pub fn abort_lobby(ctx: Context<AbortLobby>) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(g.status == GameStatus::Lobby, GameError::WrongPhase);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= g.created_at + LOBBY_TIMEOUT_SECONDS, GameError::TooEarly);
        g.status = GameStatus::Aborted;
        Ok(())
    }

    /// Reclaim a deposit from an aborted lobby, INCLUDING the rake: the game
    /// never ran, so the house takes nothing. The gross deposit is recomputed
    /// from the net stake and the fee rate rather than stored, so this needs no
    /// extra Player field.
    pub fn claim_abort_refund(ctx: Context<ClaimAbortRefund>) -> Result<()> {
        let (status, gkey, vbump) = {
            let g = &ctx.accounts.game;
            (g.status, g.key(), g.vault_bump)
        };
        require!(status == GameStatus::Aborted, GameError::WrongPhase);

        let fee_bps = ctx.accounts.game.fee_bps as u128;
        let gross = {
            let p = &mut ctx.accounts.player;
            require!(p.status == PlayerStatus::Active, GameError::PlayerInactive);
            // gross = net * BPS / (BPS - fee_bps); the rake is handed back too.
            let gross = ((p.stake as u128) * BPS / (BPS - fee_bps)) as u64;
            let rake = gross.saturating_sub(p.stake);
            let g = &mut ctx.accounts.game;
            g.fees_collected = g.fees_collected.saturating_sub(rake);
            p.status = PlayerStatus::CashedOut;
            p.stake = 0;
            gross
        };
        // never pay out more than the vault holds (rounding safety)
        let cap = ctx.accounts.vault.amount;
        transfer_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.owner_token,
            &ctx.accounts.stake_mint,
            &ctx.accounts.token_program,
            gkey,
            vbump,
            gross.min(cap),
        )
    }

    // ----- Rent recovery: close settled per-game accounts --------------------
    //
    // Ordering is enforced by counters: players close first (player_count -> 0),
    // then circles (circle_count -> 0), then the game itself (vault dust swept
    // to the treasury jackpot). Guards make it impossible to close away an
    // unclaimed entitlement unless its owner signs (an explicit forfeit).

    /// Close a Player account; its rent returns to the player's wallet.
    /// Permissionless once the player has nothing left to claim. If they still
    /// have an unclaimed win (status Active) or an unclaimed skill share, only
    /// the owner may close, their signature is an explicit forfeit.
    pub fn close_player(ctx: Context<ClosePlayer>) -> Result<()> {
        let g = &mut ctx.accounts.game;
        // Aborted counts as over. A lobby that timed out never ran, so its
        // accounts are as finished as a settled game's, and refusing to close
        // them stranded their rent with no instruction that could ever reach
        // it. The guard below is what protects an entitlement, not the status.
        require!(
            g.status == GameStatus::Settling || g.status == GameStatus::Aborted,
            GameError::WrongPhase
        );
        let p = &ctx.accounts.player;
        let fully_settled = p.status != PlayerStatus::Active && (p.skill_claimed || p.points == 0);
        if !fully_settled {
            require!(ctx.accounts.owner.is_signer, GameError::Unauthorized);
        }
        g.player_count = g.player_count.saturating_sub(1);
        Ok(())
    }

    /// Close a Circle account once every player is closed; rent returns to the
    /// circle's creator. Closing the WINNING circle before its creator claimed
    /// κ requires the creator's signature (an explicit forfeit of the cut).
    pub fn close_circle(ctx: Context<CloseCircle>) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(
            g.status == GameStatus::Settling || g.status == GameStatus::Aborted,
            GameError::WrongPhase
        );
        require!(g.player_count == 0, GameError::PlayersRemain);
        let c = &ctx.accounts.circle;
        // On an aborted lobby there is no kappa to forfeit: the game never ran,
        // so no creator cut was ever earned. Asking the creator to sign away
        // nothing would just lock the account.
        if g.status == GameStatus::Settling && c.alive && !g.creator_cut_paid {
            require!(ctx.accounts.creator.is_signer, GameError::Unauthorized);
        }
        g.circle_count = g.circle_count.saturating_sub(1);
        Ok(())
    }

    /// Close the Game account last: sweep any vault dust (rounding remainders,
    /// forfeited claims) into the treasury jackpot pool, then return the game
    /// account's rent to the game authority. Vault drains to exactly zero.
    pub fn close_game(ctx: Context<CloseGame>) -> Result<()> {
        {
            let g = &ctx.accounts.game;
            require!(
                g.status == GameStatus::Settling || g.status == GameStatus::Aborted,
                GameError::WrongPhase
            );
            require!(g.player_count == 0, GameError::PlayersRemain);
            require!(g.circle_count == 0, GameError::CirclesRemain);
        }
        // CONSERVATION: nothing may be minted or burned. Every lamport that ever
        // entered this game left as a payout, as rake swept to the treasury, or
        // is the dust we are about to sweep now.
        {
            let g = &ctx.accounts.game;
            let vault = ctx.accounts.vault.amount;
            // outstanding obligations must all be settled by now
            require!(g.player_count == 0, GameError::PlayersRemain);
            require!(g.circle_count == 0, GameError::CirclesRemain);
            // uncollected rake must already have gone to the treasury
            require!(g.fees_collected == 0, GameError::ConservationViolated);
            // the vault cannot hold more than the pot it was still owed
            require!(vault <= g.total_deposited, GameError::ConservationViolated);
        }
        let dust = ctx.accounts.vault.amount;
        if dust > 0 {
            transfer_from_vault(
                &ctx.accounts.vault,
                &ctx.accounts.treasury_vault,
                &ctx.accounts.stake_mint,
                &ctx.accounts.token_program,
                ctx.accounts.game.key(),
                ctx.accounts.game.vault_bump,
                dust,
            )?;
            let t = &mut ctx.accounts.treasury;
            t.jackpot_pool = t.jackpot_pool.checked_add(dust).ok_or(GameError::MathOverflow)?;
        }
        Ok(())
    }
    // ---- prediction market ------------------------------------------------
    //
    // Parimutuel, so the pool sets the odds and the house never takes the other
    // side of a bet. Spectators back an AGENT, not a comb: an agent moves every
    // round and carries a record across games, which is the thing worth pricing.
    //
    // Nothing here can touch a game's own vault. The market has its own vault,
    // its own mint, and settles by reading the game rather than changing it.

    /// Open the book on a running game. Permissionless: anyone may open it, and
    /// there is exactly one per game.
    pub fn open_market(ctx: Context<OpenMarket>, lock_instance: u16) -> Result<()> {
        let g = &ctx.accounts.game;
        require!(g.status == GameStatus::Running, GameError::WrongPhase);
        require!(lock_instance >= g.instance, GameError::BadParam);
        let m = &mut ctx.accounts.market;
        m.game = g.key();
        m.stake_mint = ctx.accounts.stake_mint.key();
        m.lock_instance = lock_instance;
        m.total_pool = 0;
        m.winning_pool = 0;
        m.targets = 0;
        m.resolved = 0;
        m.settled = false;
        m.bump = ctx.bumps.market;
        m.vault_bump = ctx.bumps.market_vault;
        Ok(())
    }

    /// Allow bets on one agent. Authority only, idempotent.
    ///
    /// The house heuristics are published algorithms: herd always moves to the
    /// largest comb, so backing one is not a prediction, it is arbitrage against
    /// whoever has not read the source. Splitting the last 200 games in half,
    /// win rate correlates 0.91 with itself, and almost all of that persistence
    /// is the fixed strategies repeating. A book on them is solved before it
    /// opens.
    ///
    /// So the market takes bets only on agents marked here. This is the
    /// mechanism, not the policy: what gets marked is a decision made off
    /// chain, and today that is the reasoning agents.
    pub fn set_backable(_ctx: Context<SetBackable>, _agent: Pubkey) -> Result<()> {
        let b = &mut _ctx.accounts.backable;
        b.agent = _agent;
        b.bump = _ctx.bumps.backable;
        Ok(())
    }

    /// Withdraw an agent from the book. Refuses while a market still needs it
    /// decided, since resolve_target counts against targets already taken.
    pub fn clear_backable(_ctx: Context<ClearBackable>, _agent: Pubkey) -> Result<()> {
        Ok(())
    }

    /// Back an agent. Bets close at `lock_instance` so nobody can buy in once
    /// the board has already thinned to a near-certainty.
    pub fn place_bet(ctx: Context<PlaceBet>, amount: u64) -> Result<()> {
        require!(amount > 0, GameError::BadParam);
        {
            let g = &ctx.accounts.game;
            let m = &ctx.accounts.market;
            require!(g.status == GameStatus::Running, GameError::WrongPhase);
            require!(!m.settled, GameError::WrongPhase);
            require!(g.instance <= m.lock_instance, GameError::BettingClosed);
        }
        // The target must actually be playing this game. Without this you could
        // back a wallet that never sat down and it could never lose.
        require!(ctx.accounts.target_player.game == ctx.accounts.game.key(), GameError::BadParam);
        // Either the bettor signs for themselves, which is the wallet path, or
        // an allow-listed relayer signs for them, which is the path for anyone
        // who has no key at all. Same rule the game itself already uses to let
        // people play without a wallet, so betting does not invent a second one.
        resolve_delegate(&ctx.accounts.bettor, &ctx.accounts.payer, &ctx.accounts.relayer)?;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.payer_token.to_account_info(),
                    mint: ctx.accounts.stake_mint.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.stake_mint.decimals,
        )?;

        let pool = &mut ctx.accounts.target_pool;
        if pool.market == Pubkey::default() {
            pool.market = ctx.accounts.market.key();
            pool.target = ctx.accounts.target_player.owner;
            pool.bump = ctx.bumps.target_pool;
            let m = &mut ctx.accounts.market;
            m.targets = m.targets.checked_add(1).ok_or(GameError::MathOverflow)?;
        }
        pool.total = pool.total.checked_add(amount).ok_or(GameError::MathOverflow)?;

        let bet = &mut ctx.accounts.bet;
        if bet.market == Pubkey::default() {
            bet.market = ctx.accounts.market.key();
            bet.bettor = ctx.accounts.bettor.key();
            bet.target = ctx.accounts.target_player.owner;
            bet.bump = ctx.bumps.bet;
        }
        bet.amount = bet.amount.checked_add(amount).ok_or(GameError::MathOverflow)?;

        let m = &mut ctx.accounts.market;
        m.total_pool = m.total_pool.checked_add(amount).ok_or(GameError::MathOverflow)?;
        Ok(())
    }

    /// Decide one backed agent, once the game itself has decided. Winning is
    /// read the same way claim_winnings reads it: the agent sits in a comb that
    /// is still alive. Permissionless and idempotent.
    pub fn resolve_target(ctx: Context<ResolveTarget>) -> Result<()> {
        {
            let g = &ctx.accounts.game;
            require!(g.status == GameStatus::Settling || g.status == GameStatus::Closed,
                     GameError::WrongPhase);
        }
        let pool = &mut ctx.accounts.target_pool;
        require!(!pool.resolved, GameError::AlreadyClaimed);
        require!(ctx.accounts.target_player.owner == pool.target, GameError::BadParam);

        let c = &ctx.accounts.winning_circle;
        require!(c.alive, GameError::BadParam);
        let survived = ctx.accounts.target_player.current_circle == c.circle_id;

        pool.resolved = true;
        pool.won = survived;
        let m = &mut ctx.accounts.market;
        m.resolved = m.resolved.checked_add(1).ok_or(GameError::MathOverflow)?;
        if survived {
            m.winning_pool = m.winning_pool.checked_add(pool.total).ok_or(GameError::MathOverflow)?;
        }
        // Every backed agent decided means the winning pool is final and the
        // book can pay. Claiming before that would over-pay whoever was first.
        if m.resolved == m.targets {
            m.settled = true;
        }
        Ok(())
    }

    /// Collect. Pays only once every backed agent has been decided, so the
    /// denominator is final.
    pub fn claim_bet(ctx: Context<ClaimBet>) -> Result<()> {
        let (total_pool, winning_pool, settled, mkey, vbump) = {
            let m = &ctx.accounts.market;
            (m.total_pool, m.winning_pool, m.settled, m.key(), m.vault_bump)
        };
        require!(settled, GameError::WrongPhase);

        resolve_delegate(&ctx.accounts.bettor, &ctx.accounts.payer, &ctx.accounts.relayer)?;
        let bet = &mut ctx.accounts.bet;
        require!(!bet.claimed, GameError::AlreadyClaimed);
        require!(ctx.accounts.target_pool.resolved, GameError::WrongPhase);
        bet.claimed = true;

        // Nobody backed a survivor: the book refunds rather than keeping it.
        // A market that swallows the pot when everyone loses is not a market.
        let payout = if winning_pool == 0 {
            bet.amount
        } else if ctx.accounts.target_pool.won {
            (bet.amount as u128)
                .checked_mul(total_pool as u128).ok_or(GameError::MathOverflow)?
                .checked_div(winning_pool as u128).ok_or(GameError::MathOverflow)? as u64
        } else {
            0
        };
        if payout == 0 { return Ok(()); }
        require!(payout <= ctx.accounts.market_vault.amount, GameError::ConservationViolated);

        let seeds: &[&[u8]] = &[b"mvault", mkey.as_ref(), &[vbump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.market_vault.to_account_info(),
                    mint: ctx.accounts.stake_mint.to_account_info(),
                    to: ctx.accounts.bettor_token.to_account_info(),
                    authority: ctx.accounts.market_vault.to_account_info(),
                },
                &[seeds],
            ),
            payout,
            ctx.accounts.stake_mint.decimals,
        )?;
        Ok(())
    }

    // ----- Rent recovery for the book ---------------------------------------
    //
    // The book had no close path at all, so every game left a Market and its
    // vault behind for good: about 0.0036 SOL a game that nothing could ever
    // reclaim. The game's own accounts at least had close_player and friends.
    //
    // A Bet's seeds name the MARKET, not the pool it sits in, so closing a pool
    // cannot orphan a bet and the two are independent. Only the market has to
    // go last, and the guard for that is an empty vault: every token that
    // entered the book has left as a payout or a refund, so no bet is owed
    // anything, whether or not its account has been closed yet.
    //
    // A bettor who never closes their own bet loses that account's rent, which
    // was theirs. Nobody else's money is reachable from here.
    //
    // Deliberately no new fields on any of these accounts. Ten TargetPools are
    // already on chain and a program upgrade never rewrites account data, so a
    // field appended here would make every one of them fail to deserialize and
    // strand the bets they hold.

    /// Close a settled bet; its rent returns to the bettor.
    ///
    /// Permissionless once the bet is claimed, because a claimed bet is owed
    /// nothing. A bet that has not claimed can only be closed by its own
    /// bettor, whose signature is an explicit forfeit of whatever it was due.
    pub fn close_bet(ctx: Context<CloseBet>) -> Result<()> {
        if !ctx.accounts.bet.claimed {
            require!(ctx.accounts.bettor.is_signer, GameError::Unauthorized);
        }
        Ok(())
    }

    /// Close a decided pool once every bet on it is gone; rent to the cranker,
    /// which is whoever paid to open the book in the first place.
    pub fn close_target_pool(ctx: Context<CloseTargetPool>) -> Result<()> {
        require!(ctx.accounts.target_pool.resolved, GameError::WrongPhase);
        let m = &mut ctx.accounts.market;
        m.targets = m.targets.saturating_sub(1);
        m.resolved = m.resolved.saturating_sub(1);
        Ok(())
    }

    /// Close the book last, once no pool is left and the vault is empty.
    ///
    /// CONSERVATION: an empty vault is the whole guard. Every token that
    /// entered the book left as a payout or a refund, so there is nothing here
    /// to sweep and nobody left to pay.
    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        require!(ctx.accounts.market.targets == 0, GameError::CirclesRemain);
        require!(ctx.accounts.market_vault.amount == 0, GameError::ConservationViolated);
        let mkey = ctx.accounts.market.key();
        let seeds: &[&[u8]] = &[b"mvault", mkey.as_ref(), &[ctx.accounts.market.vault_bump]];
        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token_interface::CloseAccount {
                account: ctx.accounts.market_vault.to_account_info(),
                destination: ctx.accounts.cranker.to_account_info(),
                authority: ctx.accounts.market_vault.to_account_info(),
            },
            &[seeds],
        ))
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Validate stake bounds, transfer lamports to the vault, and return the NET
/// stake (deposit minus rake) that actually goes into play.
fn take_deposit<'info>(
    config: &Account<'info, GameConfig>,
    fee_bps: u16,
    stake: u64,
    from: &InterfaceAccount<'info, TokenAccount>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    owner: &Signer<'info>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<u64> {
    require!(stake >= config.min_stake && stake <= config.max_stake, GameError::StakeOutOfRange);

    token_interface::transfer_checked(
        CpiContext::new(
            token_program.to_account_info(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: vault.to_account_info(),
                authority: owner.to_account_info(),
            },
        ),
        stake,
        mint.decimals,
    )?;

    let rake = ((stake as u128 * fee_bps as u128) / BPS) as u64;
    let net = stake.checked_sub(rake).ok_or(GameError::MathOverflow)?;
    Ok(net)
}

/// Record a deposit's accounting on the game account.
fn record_deposit(game: &mut Account<Game>, stake: u64, net: u64) -> Result<()> {
    let rake = stake.checked_sub(net).ok_or(GameError::MathOverflow)?;
    game.fees_collected = game.fees_collected.checked_add(rake).ok_or(GameError::MathOverflow)?;
    game.total_deposited = game.total_deposited.checked_add(stake).ok_or(GameError::MathOverflow)?;
    // BOUNDED RISK: refuse deposits past the per-game ceiling.
    require!(game.total_deposited <= MAX_GAME_DEPOSITS, GameError::GameCapReached);
    Ok(())
}

/// Deterministic survival-weighted refund rate (bps), 55% → 80% as t → T_MAX.
/// T_MAX = num_circles (by the final death t ≈ num_circles − 1).
fn refund_bps(instance: u16, num_circles: u8) -> u16 {
    let t = instance as u64;
    let tmax = (num_circles as u64).max(1);
    let span = REFUND_HI_BPS - REFUND_LO_BPS;
    (REFUND_LO_BPS + (t.min(tmax) * span) / tmax) as u16
}

/// Randomness seam.
///
/// Preferred source is Switchboard On-Demand: the crank commits a randomness
/// account to a future slot, an oracle reveals it, and we read the settled
/// value here. That value is unpredictable to players, to the cranker, and to
/// the slot leader, which is the property the slot hash alone cannot give.
///
/// If no randomness account is supplied, we fall back to the pre-committed slot
/// hash. That still defeats player and cranker grinding (the slot is fixed
/// before its hash exists) but leaves the slot's leader some influence, so the
/// fallback is for devnet and is refused once `require_vrf` is set on the game.
fn randomness_seed(
    randomness: Option<&AccountInfo>,
    slot_hashes: &AccountInfo,
    target_slot: u64,
    clock: &Clock,
    require_vrf: bool,
) -> Result<[u8; 32]> {
    if let Some(acc) = randomness {
        let data = acc.try_borrow_data().map_err(|_| GameError::BadParam)?;
        let parsed = RandomnessAccountData::parse(data).map_err(|_| GameError::BadRandomness)?;
        // get_value only returns once the oracle has revealed for that slot
        let value = parsed
            .get_value(clock.slot)
            .map_err(|_| GameError::RandomnessNotReady)?;
        return Ok(value);
    }
    require!(!require_vrf, GameError::RandomnessNotReady);
    slothash_at(slot_hashes, target_slot)
}

/// Fallback entropy: the SlotHashes entry for the newest slot at or before
/// `target_slot`, a slot the game committed to before its hash existed.
fn slothash_at(slot_hashes_ai: &AccountInfo, target_slot: u64) -> Result<[u8; 32]> {
    require!(
        *slot_hashes_ai.key == anchor_lang::solana_program::sysvar::slot_hashes::id(),
        GameError::BadParam
    );
    let data = slot_hashes_ai.try_borrow_data().map_err(|_| GameError::BadParam)?;
    require!(data.len() >= 48, GameError::BadParam);
    let n = u64::from_le_bytes(data[0..8].try_into().unwrap()) as usize;
    let mut chosen = 8 + (n.saturating_sub(1)) * 40;
    for i in 0..n {
        let off = 8 + i * 40;
        if off + 40 > data.len() {
            break;
        }
        let slot = u64::from_le_bytes(data[off..off + 8].try_into().unwrap());
        if slot <= target_slot {
            chosen = off;
            break;
        }
    }
    require!(chosen + 40 <= data.len(), GameError::BadParam);
    let mut h = [0u8; 32];
    h.copy_from_slice(&data[chosen + 8..chosen + 40]);
    Ok(h)
}

/// Split the leftover pot into (creator_cut, luck_pool, skill_pool).
/// If no points were ever scored, the skill pool folds into the luck pool.
fn pot_split(leftover: u64, total_points: u64) -> (u64, u64, u64) {
    let l = leftover as u128;
    let creator_cut = (l * KAPPA_BPS / BPS) as u64;
    let distributable = l - creator_cut as u128;
    let skill_pool = if total_points > 0 {
        (distributable * SIGMA_BPS / BPS) as u64
    } else {
        0
    };
    let luck_pool = (distributable as u64) - skill_pool;
    (creator_cut, luck_pool, skill_pool)
}

/// Move `amount` out of the per-mint treasury vault (it signs for itself).
fn transfer_from_treasury<'info>(
    treasury_vault: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
    vault_bump: u8,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require!(amount <= treasury_vault.amount, GameError::ConservationViolated);
    let mint_key = mint.key();
    let seeds: &[&[u8]] = &[b"tvault", mint_key.as_ref(), &[vault_bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: treasury_vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: treasury_vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

/// Move `amount` of the stake mint out of a game's vault (the vault PDA signs
/// for itself). Conservation: never more than the vault actually holds.
fn transfer_from_vault<'info>(
    vault: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    token_program: &Interface<'info, TokenInterface>,
    game_key: Pubkey,
    vault_bump: u8,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require!(amount <= vault.amount, GameError::ConservationViolated);
    let seeds: &[&[u8]] = &[b"vault", game_key.as_ref(), &[vault_bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

/// Who may act for a freshly created player. Self-play (payer == owner) needs
/// nothing extra; staking for someone else requires an enabled relayer record,
/// and that relayer becomes the delegate.
fn resolve_delegate(
    owner: &UncheckedAccount,
    payer: &Signer,
    relayer: &Option<Account<AllowedRelayer>>,
) -> Result<Pubkey> {
    if payer.key() == owner.key() {
        return Ok(owner.key());
    }
    let r = relayer.as_ref().ok_or(GameError::Unauthorized)?;
    require!(r.enabled && r.relayer == payer.key(), GameError::Unauthorized);
    Ok(payer.key())
}

/// Credit a wallet's cross-game record. A mint with no open season gives no
/// credit, which is how ranked play stays BUZZ-only without naming BUZZ in the
/// code. Points always belong to exactly one season, so a stale balance is
/// reset rather than carried forward into a pool it did not help fill.
fn credit_stats(stats: &mut Account<AgentStats>, treasury: &mut Account<Treasury>,
                owner: Pubkey, bump: u8, points: u32, won: bool,
                first_claim: bool) -> Result<()> {
    if stats.owner == Pubkey::default() {
        stats.owner = owner;
        stats.bump = bump;
    }
    // `games` counts games, not claims, and not wins either. A player who both
    // survives and scores calls claim_winnings AND claim_skill; gating on `won`
    // made games a second copy of wins, so every agent read as 100%. The caller
    // decides which of the two claims is this player's first for the game, and
    // only that one advances the counter.
    if first_claim {
        stats.games = stats.games.saturating_add(1);
    }
    if won {
        stats.wins = stats.wins.saturating_add(1);
    }
    stats.total_points = stats.total_points.saturating_add(points as u64);
    if treasury.season == 0 { return Ok(()); }              // unranked mint
    if stats.season != treasury.season {
        stats.season = treasury.season;
        stats.season_points = 0;
    }
    stats.season_points = stats.season_points.saturating_add(points as u64);
    treasury.pts_accruing = treasury.pts_accruing.saturating_add(points as u64);
    Ok(())
}

fn init_player(
    player: &mut Account<Player>,
    game: Pubkey,
    owner: Pubkey,
    delegate: Pubkey,
    stake: u64,
    circle_id: u8,
    bump: u8,
) {
    player.game = game;
    player.owner = owner;
    player.delegate = delegate;
    player.stake = stake;
    player.current_circle = circle_id;
    player.points = 0;
    player.status = PlayerStatus::Active;
    player.committed_hash = [0u8; 32];
    player.commit_instance = 0;
    player.prediction_hash = [0u8; 32];
    player.prediction_instance = 0;
    player.skill_claimed = false;
    player.bump = bump;
}

// ---------------------------------------------------------------------------
// accounts (state)
// ---------------------------------------------------------------------------

#[account]
pub struct GameConfig {
    pub authority: Pubkey,
    pub fee_bps: u16,
    pub house_cut_bps: u16,
    pub min_stake: u64,
    pub max_stake: u64,
    pub instance_seconds: u32,
    /// probability (bps) that a game flips INSANE at the post-lock roll.
    pub insane_prob_bps: u16,
    pub bump: u8,
}
impl GameConfig {
    pub const SPACE: usize = 8 + 32 + 2 + 2 + 8 + 8 + 4 + 2 + 1;
}

/// Cross-game treasury: accumulates house profit (withdrawable) and the jackpot
/// pool that feeds insane rounds. Lamports live in a separate treasury vault PDA.
/// Presence of this account (with enabled = true) is what makes a mint playable.
#[account]
pub struct AllowedMint {
    pub mint: Pubkey,
    pub enabled: bool,
    pub bump: u8,
}
impl AllowedMint {
    pub const SPACE: usize = 8 + 32 + 1 + 1;
}

/// Presence of this account (with enabled = true) is what lets one key open or
/// join a comb *on behalf of* another. Without it, staking for someone else is
/// refused outright, so nobody can squat an agent's player PDA.
#[account]
pub struct AllowedRelayer {
    pub relayer: Pubkey,
    pub enabled: bool,
    pub bump: u8,
}
impl AllowedRelayer {
    pub const SPACE: usize = 8 + 32 + 1 + 1;
}

#[account]
pub struct Treasury {
    pub authority: Pubkey,
    /// Retired. Every collect_fees now books the house cut straight into the
    /// three buckets below. Kept at its original offset so existing treasuries
    /// can be reallocated in place rather than rebuilt, and still withdrawable
    /// through withdraw_house for whatever it holds.
    pub house_balance: u64,
    pub jackpot_pool: u64,
    pub vault_bump: u8,
    pub bump: u8,
    // --- appended by the leaderboard upgrade; zeroed by migrate_treasury ---
    /// 50% of the house cut. Converted to SOL off chain: no DEX lives in this
    /// program, and putting one next to player funds would be a poor trade.
    pub to_sol_balance: u64,
    /// 25% of the house cut, withdrawn to buy and burn BUZZ off chain.
    pub burn_balance: u64,
    /// 25% of the house cut, accruing to the season currently open.
    pub lb_accruing: u64,
    /// The pool the last closed season pays out of.
    pub lb_claimable: u64,
    /// Skill points earned across all games in the open season.
    pub pts_accruing: u64,
    /// Skill points that `lb_claimable` is divided between.
    pub pts_claimable: u64,
    /// 0 means this mint is not ranked and earns no leaderboard credit. Ranked
    /// play is BUZZ only for now; opening a season on another mint is one call,
    /// because every mint already has its own treasury.
    pub season: u16,
}
impl Treasury {
    /// The pre-leaderboard layout. Treasuries created before the upgrade are
    /// this size and must be migrated before they can be used again.
    pub const LEGACY_SPACE: usize = 8 + 32 + 8 + 8 + 1 + 1;
    pub const SPACE: usize = Self::LEGACY_SPACE + 8 + 8 + 8 + 8 + 8 + 8 + 2;
}

/// Per-wallet, cross-game record. Skill points are the leaderboard's metric on
/// purpose: they are a flat +1 per correct call regardless of stake, so the
/// board measures reading the board rather than the size of the wallet reading
/// it. PnL is displayed off chain and deliberately never paid on.
#[account]
pub struct AgentStats {
    pub owner: Pubkey,
    /// Season that `season_points` belongs to; a stale one resets on credit.
    pub season: u16,
    pub season_points: u64,
    pub total_points: u64,
    pub games: u32,
    pub wins: u32,
    pub bump: u8,
}
impl AgentStats {
    pub const SPACE: usize = 8 + 32 + 2 + 8 + 8 + 4 + 4 + 1;
}

#[account]
pub struct Game {
    pub game_id: u64,
    pub authority: Pubkey,
    pub status: GameStatus,
    pub num_circles: u8,
    pub lock_instance: u16,
    pub instance: u16,
    pub phase: InstancePhase,
    pub phase_ends_at: i64,
    pub instance_seconds: u32,
    /// circle id selected to die this instance (valid only during Resolving).
    pub doomed_circle: u8,
    pub circle_count: u8,
    pub alive_circles: u8,
    pub player_count: u32,
    pub leftover_pot: u64,
    pub fees_collected: u64,
    pub total_deposited: u64,
    /// running sum of all skill points awarded (skill-pool denominator).
    pub total_points: u64,
    /// slot whose SlotHashes entry seeds this instance's death roll. Committed
    /// in advance (at advance_to_reveal, pointing PAST the reveal window) so a
    /// cranker cannot grind submission timing for a favorable hash.
    pub entropy_slot: u64,
    /// same idea for the one-shot insane roll: armed when the 50% lock is
    /// crossed, pointing a few slots into the future.
    pub insane_entropy_slot: u64,
    /// unix time the lobby opened; after LOBBY_TIMEOUT_SECONDS without a start,
    /// anyone may abort the game and every player reclaims their full deposit.
    pub created_at: i64,
    /// the SPL mint every stake in this game is denominated in. One mint per
    /// game: a pot is never mixed. Wrapped SOL is just another allowed mint.
    pub stake_mint: Pubkey,
    /// the rake this game was opened under, snapshotted from config so changing
    /// the fee never alters a game already in flight. The abort path rebuilds
    /// each gross deposit from this, so reading the live config instead would
    /// refund players at a rate they never paid.
    pub fee_bps: u16,
    /// when set, the death and jackpot rolls REFUSE to fall back to the slot
    /// hash and require a settled Switchboard value. Real-value games set this.
    pub require_vrf: bool,
    /// set once the winning circle's creator has claimed κ.
    pub creator_cut_paid: bool,
    /// whether the post-lock insane roll has happened, and its outcome.
    pub insane_rolled: bool,
    pub insane: bool,
    pub vault_bump: u8,
    pub bump: u8,
}
impl Game {
    pub const SPACE: usize =
        8 + 8 + 32 + 1 + 1 + 2 + 2 + 1 + 8 + 4 + 1 + 1 + 1 + 4 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 32 + 2 + 1 + 1 + 1 + 1 + 1 + 1;
    /// Commit window = 60% of the instance, reveal = 40% (min 1s each).
    pub fn commit_window(&self) -> i64 {
        ((self.instance_seconds as i64) * 3 / 5).max(1)
    }
    pub fn reveal_window(&self) -> i64 {
        ((self.instance_seconds as i64) * 2 / 5).max(1)
    }
}

#[account]
pub struct Circle {
    pub game: Pubkey,
    pub circle_id: u8,
    pub creator: Pubkey,
    pub member_count: u32,
    pub total_stake: u64,
    pub alive: bool,
    /// refund rate (bps) locked in when this circle died; 0 while alive.
    pub refund_bps: u16,
    pub bump: u8,
}
impl Circle {
    pub const SPACE: usize = 8 + 32 + 1 + 32 + 4 + 8 + 1 + 2 + 1;
}

#[account]
pub struct Player {
    pub game: Pubkey,
    pub owner: Pubkey,
    /// May act for this player without holding its key: commit, reveal, predict
    /// and settle. Equals `owner` for self-play; for relayed play it is the
    /// allowed relayer that opened the comb. It can never redirect funds, every
    /// payout account is bound to `owner`.
    pub delegate: Pubkey,
    pub stake: u64,
    pub current_circle: u8,
    pub points: u32,
    pub status: PlayerStatus,
    /// keccak commitment for the current instance's move (zeroed when consumed).
    pub committed_hash: [u8; 32],
    /// instance the move commitment is for; 0 = no live commitment.
    pub commit_instance: u16,
    /// keccak commitment for the current instance's death PREDICTION.
    pub prediction_hash: [u8; 32],
    /// instance the prediction is for; 0 = none live.
    pub prediction_instance: u16,
    /// set once this player has claimed their skill-pool share.
    pub skill_claimed: bool,
    pub bump: u8,
}
impl Player {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 1 + 4 + 1 + 32 + 2 + 32 + 2 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum GameStatus {
    Lobby,
    Running,
    Settling,
    Closed,
    /// Lobby timed out without starting; deposits are reclaimable in full.
    Aborted,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PlayerStatus {
    Active,
    CashedOut,
    Eliminated,
    /// claimed endgame winnings (stake-back + luck share).
    Settled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum InstancePhase {
    Commit,
    Reveal,
    /// death selected, awaiting execute_death.
    Resolving,
    /// death executed; players reveal predictions for skill points.
    Scoring,
}

// ---------------------------------------------------------------------------
// instruction contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = GameConfig::SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, GameConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct CreateGame<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,
    /// the mint every stake in this game is denominated in
    pub stake_mint: InterfaceAccount<'info, Mint>,
    /// gate: only mints the authority has allowed can open combs
    #[account(
        seeds = [b"allowed", stake_mint.key().as_ref()],
        bump = allowed.bump,
        constraint = allowed.enabled @ GameError::MintNotAllowed
    )]
    pub allowed: Account<'info, AllowedMint>,
    #[account(
        init,
        payer = authority,
        space = Game::SPACE,
        seeds = [b"game", game_id.to_le_bytes().as_ref()],
        bump
    )]
    pub game: Account<'info, Game>,
    /// token escrow for this game; the PDA is its own authority
    #[account(
        init,
        payer = authority,
        seeds = [b"vault", game.key().as_ref()],
        bump,
        token::mint = stake_mint,
        token::authority = vault,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(circle_id: u8)]
pub struct CreateCircle<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        space = Circle::SPACE,
        seeds = [b"circle", game.key().as_ref(), &[circle_id]],
        bump
    )]
    pub circle: Account<'info, Circle>,
    #[account(
        init,
        payer = payer,
        space = Player::SPACE,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub player: Account<'info, Player>,
    /// CHECK: becomes `Player.owner`; the seat this stake buys.
    pub owner: UncheckedAccount<'info>,
    /// Funds the stake and the rent. Equals `owner` for self-play; for relayed
    /// play it is a relayer from the allow-list below.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Required only when `payer != owner`: proof the payer is an allowed
    /// relayer, so nobody can squat another key's player PDA.
    #[account(seeds = [b"relayer", payer.key().as_ref()], bump = relayer.bump)]
    pub relayer: Option<Account<'info, AllowedRelayer>>,
    /// stake mint for this game
    #[account(address = game.stake_mint @ GameError::BadParam)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    /// the payer's token account for that mint; the stake comes out of here
    #[account(mut, token::mint = stake_mint, token::authority = payer)]
    pub payer_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinCircle<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"circle", game.key().as_ref(), &[circle.circle_id]],
        bump = circle.bump
    )]
    pub circle: Account<'info, Circle>,
    #[account(
        init,
        payer = payer,
        space = Player::SPACE,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub player: Account<'info, Player>,
    /// CHECK: becomes `Player.owner`; the seat this stake buys.
    pub owner: UncheckedAccount<'info>,
    /// Funds the stake and the rent. Equals `owner` for self-play; for relayed
    /// play it is a relayer from the allow-list below.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Required only when `payer != owner`: proof the payer is an allowed
    /// relayer, so nobody can squat another key's player PDA.
    #[account(seeds = [b"relayer", payer.key().as_ref()], bump = relayer.bump)]
    pub relayer: Option<Account<'info, AllowedRelayer>>,
    /// stake mint for this game
    #[account(address = game.stake_mint @ GameError::BadParam)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    /// the payer's token account for that mint; the stake comes out of here
    #[account(mut, token::mint = stake_mint, token::authority = payer)]
    pub payer_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartGame<'info> {
    #[account(
        mut,
        seeds = [b"game", game.game_id.to_le_bytes().as_ref()],
        bump = game.bump,
        has_one = authority @ GameError::Unauthorized
    )]
    pub game: Account<'info, Game>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CommitMove<'info> {
    #[account(seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
        has_one = owner @ GameError::Unauthorized,
        constraint = actor.key() == player.owner || actor.key() == player.delegate @ GameError::Unauthorized,
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    /// CHECK: seed and payout binding only; `actor` carries the authority.
    pub owner: UncheckedAccount<'info>,
    /// The key actually signing: the owner itself, or its delegate.
    #[account(mut)]
    pub actor: Signer<'info>,
}

/// Permissionless phase crank (anyone may call once the window has elapsed).
#[derive(Accounts)]
pub struct Crank<'info> {
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct RevealPrediction<'info> {
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
        has_one = owner @ GameError::Unauthorized,
        constraint = actor.key() == player.owner || actor.key() == player.delegate @ GameError::Unauthorized,
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    /// CHECK: seed and payout binding only; `actor` carries the authority.
    pub owner: UncheckedAccount<'info>,
    /// The key actually signing: the owner itself, or its delegate.
    #[account(mut)]
    pub actor: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(target_circle: u8)]
pub struct RevealMove<'info> {
    #[account(seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
        has_one = owner @ GameError::Unauthorized,
        constraint = actor.key() == player.owner || actor.key() == player.delegate @ GameError::Unauthorized,
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    #[account(
        mut,
        seeds = [b"circle", game.key().as_ref(), &[from_circle.circle_id]],
        bump = from_circle.bump
    )]
    pub from_circle: Account<'info, Circle>,
    #[account(
        mut,
        seeds = [b"circle", game.key().as_ref(), &[target_circle]],
        bump = to_circle.bump
    )]
    pub to_circle: Account<'info, Circle>,
    /// CHECK: seed and payout binding only; `actor` carries the authority.
    pub owner: UncheckedAccount<'info>,
    /// The key actually signing: the owner itself, or its delegate.
    #[account(mut)]
    pub actor: Signer<'info>,
}

/// All alive circles are passed via `remaining_accounts` (read-only).
#[derive(Accounts)]
pub struct SelectDeath<'info> {
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    /// CHECK: validated against the SlotHashes sysvar id in slothash_at.
    pub recent_slot_hashes: UncheckedAccount<'info>,
    /// CHECK: parsed as a Switchboard randomness account; absent falls back to
    /// the committed slot hash unless the game requires VRF.
    pub randomness: Option<UncheckedAccount<'info>>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(circle_id: u8)]
pub struct ExecuteDeath<'info> {
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"circle", game.key().as_ref(), &[circle_id]],
        bump = circle.bump
    )]
    pub circle: Account<'info, Circle>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct CashOut<'info> {
    #[account(seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        seeds = [b"circle", game.key().as_ref(), &[circle.circle_id]],
        bump = circle.bump
    )]
    pub circle: Account<'info, Circle>,
    #[account(
        mut,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
        has_one = owner @ GameError::Unauthorized,
        constraint = actor.key() == player.owner || actor.key() == player.delegate @ GameError::Unauthorized,
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    /// CHECK: seed and payout binding only; `actor` carries the authority.
    pub owner: UncheckedAccount<'info>,
    /// The key actually signing: the owner itself, or its delegate.
    #[account(mut)]
    pub actor: Signer<'info>,
    /// stake mint for this game
    #[account(address = game.stake_mint @ GameError::BadParam)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    /// the caller's token account for that mint
    #[account(mut, token::mint = stake_mint, token::authority = owner)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimCreatorCut<'info> {
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        seeds = [b"circle", game.key().as_ref(), &[winning_circle.circle_id]],
        bump = winning_circle.bump
    )]
    pub winning_circle: Account<'info, Circle>,
    /// The creator's own player record, the source of the delegate right. Only
    /// needed when a delegate is claiming; omitting it keeps the owner path
    /// working even after the player account has been closed for rent.
    #[account(
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
        has_one = owner @ GameError::Unauthorized,
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Option<Account<'info, Player>>,
    /// CHECK: seed and payout binding only; `actor` carries the authority.
    pub owner: UncheckedAccount<'info>,
    /// The key actually signing: the owner itself, or its delegate.
    #[account(mut)]
    pub actor: Signer<'info>,
    /// stake mint for this game
    #[account(address = game.stake_mint @ GameError::BadParam)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    /// the caller's token account for that mint
    #[account(mut, token::mint = stake_mint, token::authority = owner)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    #[account(
        init_if_needed,
        payer = actor,
        space = AgentStats::SPACE,
        seeds = [b"agent", owner.key().as_ref()],
        bump
    )]
    pub stats: Account<'info, AgentStats>,
    #[account(mut, seeds = [b"treasury", game.stake_mint.as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        seeds = [b"circle", game.key().as_ref(), &[winning_circle.circle_id]],
        bump = winning_circle.bump
    )]
    pub winning_circle: Account<'info, Circle>,
    #[account(
        mut,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
        has_one = owner @ GameError::Unauthorized,
        constraint = actor.key() == player.owner || actor.key() == player.delegate @ GameError::Unauthorized,
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    /// CHECK: seed and payout binding only; `actor` carries the authority.
    pub owner: UncheckedAccount<'info>,
    /// The key actually signing: the owner itself, or its delegate.
    #[account(mut)]
    pub actor: Signer<'info>,
    /// stake mint for this game
    #[account(address = game.stake_mint @ GameError::BadParam)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    /// the caller's token account for that mint
    #[account(mut, token::mint = stake_mint, token::authority = owner)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimSkill<'info> {
    /// Cross-game record for this wallet, created on first claim.
    #[account(
        init_if_needed,
        payer = actor,
        space = AgentStats::SPACE,
        seeds = [b"agent", owner.key().as_ref()],
        bump
    )]
    pub stats: Account<'info, AgentStats>,
    /// This game's mint decides whether the claim earns ranked credit.
    #[account(mut, seeds = [b"treasury", game.stake_mint.as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
        has_one = owner @ GameError::Unauthorized,
        constraint = actor.key() == player.owner || actor.key() == player.delegate @ GameError::Unauthorized,
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    /// CHECK: seed and payout binding only; `actor` carries the authority.
    pub owner: UncheckedAccount<'info>,
    /// The key actually signing: the owner itself, or its delegate.
    #[account(mut)]
    pub actor: Signer<'info>,
    /// stake mint for this game
    #[account(address = game.stake_mint @ GameError::BadParam)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    /// the caller's token account for that mint
    #[account(mut, token::mint = stake_mint, token::authority = owner)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitTreasury<'info> {
    pub stake_mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = authority, space = Treasury::SPACE,
        seeds = [b"treasury", stake_mint.key().as_ref()], bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(init, payer = authority,
        seeds = [b"tvault", stake_mint.key().as_ref()], bump,
        token::mint = stake_mint, token::authority = treasury_vault,
        token::token_program = token_program)]
    pub treasury_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"treasury", stake_mint.key().as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [b"tvault", stake_mint.key().as_ref()], bump = treasury.vault_bump)]
    pub treasury_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(address = game.stake_mint @ GameError::BadParam)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub cranker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawHouse<'info> {
    #[account(mut, seeds = [b"treasury", stake_mint.key().as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [b"tvault", stake_mint.key().as_ref()], bump = treasury.vault_bump)]
    pub treasury_vault: InterfaceAccount<'info, TokenAccount>,
    pub stake_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = stake_mint, token::authority = authority)]
    pub authority_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RollInsane<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"treasury", stake_mint.key().as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [b"tvault", stake_mint.key().as_ref()], bump = treasury.vault_bump)]
    pub treasury_vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: validated against the SlotHashes sysvar id in slothash_at.
    pub recent_slot_hashes: UncheckedAccount<'info>,
    /// CHECK: parsed as a Switchboard randomness account; absent falls back to
    /// the committed slot hash unless the game requires VRF.
    pub randomness: Option<UncheckedAccount<'info>>,
    #[account(address = game.stake_mint @ GameError::BadParam)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub cranker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(target_circle: u8)]
pub struct Land<'info> {
    #[account(seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
        has_one = owner @ GameError::Unauthorized,
        constraint = actor.key() == player.owner || actor.key() == player.delegate @ GameError::Unauthorized,
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    #[account(
        mut,
        seeds = [b"circle", game.key().as_ref(), &[from_circle.circle_id]],
        bump = from_circle.bump
    )]
    pub from_circle: Account<'info, Circle>,
    #[account(
        mut,
        seeds = [b"circle", game.key().as_ref(), &[target_circle]],
        bump = to_circle.bump
    )]
    pub to_circle: Account<'info, Circle>,
    /// CHECK: seed and payout binding only; `actor` carries the authority.
    pub owner: UncheckedAccount<'info>,
    /// The key actually signing: the owner itself, or its delegate.
    #[account(mut)]
    pub actor: Signer<'info>,
}

#[derive(Accounts)]
pub struct MigrateTreasury<'info> {
    /// CHECK: cannot be typed as Account<Treasury>, since Anchor would try to
    /// deserialize the OLD layout as the new one during validation and fail
    /// before the handler runs. Seeds still pin the address; the discriminator
    /// and authority are checked in the handler.
    #[account(mut, seeds = [b"treasury", stake_mint.key().as_ref()], bump)]
    pub treasury: UncheckedAccount<'info>,
    pub stake_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SeasonAdmin<'info> {
    #[account(mut, seeds = [b"treasury", stake_mint.key().as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimSeasonReward<'info> {
    #[account(mut, seeds = [b"treasury", stake_mint.key().as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [b"tvault", stake_mint.key().as_ref()], bump = treasury.vault_bump)]
    pub treasury_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"agent", owner.key().as_ref()],
        bump = stats.bump,
        has_one = owner @ GameError::Unauthorized
    )]
    pub stats: Account<'info, AgentStats>,
    /// CHECK: seed and payout binding only; `actor` carries the authority.
    pub owner: UncheckedAccount<'info>,
    /// The owner itself, or anyone willing to pay the fee to settle it for them.
    /// Safe either way: the reward can only land in the owner's own account.
    #[account(mut)]
    pub actor: Signer<'info>,
    pub stake_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = stake_mint, token::authority = owner)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AllowMint<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init_if_needed,
        payer = authority,
        space = AllowedMint::SPACE,
        seeds = [b"allowed", mint.key().as_ref()],
        bump
    )]
    pub allowed: Account<'info, AllowedMint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AllowRelayer<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,
    /// CHECK: recorded as the allowed relayer; only its address is used.
    pub relayer: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = AllowedRelayer::SPACE,
        seeds = [b"relayer", relayer.key().as_ref()],
        bump
    )]
    pub allowed: Account<'info, AllowedRelayer>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetDelegate<'info> {
    #[account(seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
        has_one = owner @ GameError::Unauthorized,
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct AbortLobby<'info> {
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimAbortRefund<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
        has_one = owner @ GameError::Unauthorized,
        constraint = actor.key() == player.owner || actor.key() == player.delegate @ GameError::Unauthorized,
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    /// CHECK: seed and payout binding only; `actor` carries the authority.
    pub owner: UncheckedAccount<'info>,
    /// The key actually signing: the owner itself, or its delegate.
    #[account(mut)]
    pub actor: Signer<'info>,
    /// stake mint for this game
    #[account(address = game.stake_mint @ GameError::BadParam)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    /// the caller's token account for that mint
    #[account(mut, token::mint = stake_mint, token::authority = owner)]
    pub owner_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePlayer<'info> {
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        close = owner,
        seeds = [b"player", game.key().as_ref(), player.owner.as_ref()],
        bump = player.bump,
        has_one = owner @ GameError::Unauthorized,
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    /// CHECK: rent recipient; has_one enforces it equals player.owner. Its
    /// signature is only required for the forfeit path (checked in handler).
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseCircle<'info> {
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        close = creator,
        seeds = [b"circle", game.key().as_ref(), &[circle.circle_id]],
        bump = circle.bump,
        has_one = creator @ GameError::Unauthorized,
        constraint = circle.game == game.key() @ GameError::BadParam
    )]
    pub circle: Account<'info, Circle>,
    /// CHECK: rent recipient; has_one enforces it equals circle.creator. Its
    /// signature is only required to close an unclaimed winning circle.
    #[account(mut)]
    pub creator: UncheckedAccount<'info>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseGame<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [b"game", game.game_id.to_le_bytes().as_ref()],
        bump = game.bump,
        has_one = authority @ GameError::Unauthorized
    )]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"treasury", stake_mint.key().as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [b"tvault", stake_mint.key().as_ref()], bump = treasury.vault_bump)]
    pub treasury_vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: rent recipient; has_one enforces it equals game.authority.
    #[account(mut)]
    pub authority: UncheckedAccount<'info>,
    #[account(address = game.stake_mint @ GameError::BadParam)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub cranker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum GameError {
    #[msg("Invalid parameter")]
    BadParam,
    #[msg("Action not allowed in the current game phase")]
    WrongPhase,
    #[msg("Stake outside the configured min/max bounds")]
    StakeOutOfRange,
    #[msg("Circle is no longer alive")]
    CircleDead,
    #[msg("Not enough combs open to start")]
    NotEnoughCircles,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Player is not active")]
    PlayerInactive,
    #[msg("This phase's window has ended")]
    PhaseEnded,
    #[msg("This phase's window is not over yet")]
    PhaseNotOver,
    #[msg("Reveal does not match commitment")]
    BadReveal,
    #[msg("No live commitment for this instance")]
    NothingCommitted,
    #[msg("Reveal target must differ from current circle")]
    NotAMove,
    #[msg("Must pass every alive circle to select death")]
    IncompleteCircleSet,
    #[msg("Circle is still alive")]
    CircleAlive,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Player is not in the winning circle")]
    NotInWinningCircle,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Too early: action only allowed after the 50% lock")]
    TooEarly,
    #[msg("The join window is closed (past the 50% lock or wrong phase)")]
    JoinWindowClosed,
    #[msg("All players must be closed first")]
    PlayersRemain,
    #[msg("All circles must be closed first")]
    CirclesRemain,
    #[msg("Conservation violated: the books do not balance")]
    ConservationViolated,
    #[msg("This game has reached its deposit cap")]
    GameCapReached,
    #[msg("That mint is not allowed to open combs")]
    MintNotAllowed,
    #[msg("Randomness account could not be parsed")]
    BadRandomness,
    #[msg("Randomness is not settled yet, or this game requires VRF")]
    RandomnessNotReady,
    #[msg("Betting on this game has closed")]
    BettingClosed,
}

// ---------------------------------------------------------------------------
// Prediction market: state and accounts
// ---------------------------------------------------------------------------

/// The book on one game. Its vault is its own; a bug here cannot reach the
/// game's pot, which is the point of keeping them separate.
/// An agent the market may take bets on.
///
/// A marker and nothing else: its existence is the allowlist. place_bet asks
/// for one seeded on its target, so a bet on an unmarked agent cannot be
/// constructed at all rather than being refused by a check that a client could
/// be written around.
#[account]
pub struct Backable {
    pub agent: Pubkey,
    pub bump: u8,
}
impl Backable { pub const SPACE: usize = 8 + 32 + 1; }

#[account]
pub struct Market {
    pub game: Pubkey,
    pub stake_mint: Pubkey,
    pub total_pool: u64,
    /// Sum of the pools on agents that survived. Final only once `resolved`
    /// reaches `targets`, which is what `settled` records.
    pub winning_pool: u64,
    /// Distinct agents backed, and how many have been decided.
    pub targets: u32,
    pub resolved: u32,
    pub settled: bool,
    /// Last instance on which a bet may be placed.
    pub lock_instance: u16,
    pub bump: u8,
    pub vault_bump: u8,
}
impl Market {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 8 + 4 + 4 + 1 + 2 + 1 + 1;
}

/// Everything staked on one agent in one market.
#[account]
pub struct TargetPool {
    pub market: Pubkey,
    pub target: Pubkey,
    pub total: u64,
    pub resolved: bool,
    pub won: bool,
    pub bump: u8,
}
impl TargetPool {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1 + 1 + 1;
}

/// One bettor's position on one agent.
#[account]
pub struct Bet {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub target: Pubkey,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}
impl Bet {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 1 + 1;
}

#[derive(Accounts)]
pub struct CloseBet<'info> {
    #[account(seeds = [b"market", market.game.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        close = bettor,
        seeds = [b"bet", market.key().as_ref(), bettor.key().as_ref(), bet.target.as_ref()],
        bump = bet.bump,
        constraint = bet.bettor == bettor.key() @ GameError::Unauthorized
    )]
    pub bet: Account<'info, Bet>,
    /// CHECK: the rent goes here and nowhere else, and the seeds bind it to
    /// this bet. Its signature is only required to close a bet that has not
    /// claimed, which is an explicit forfeit.
    #[account(mut)]
    pub bettor: UncheckedAccount<'info>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseTargetPool<'info> {
    #[account(mut, seeds = [b"market", market.game.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        close = cranker,
        seeds = [b"tpool", market.key().as_ref(), target_pool.target.as_ref()],
        bump = target_pool.bump,
        constraint = target_pool.market == market.key() @ GameError::BadParam
    )]
    pub target_pool: Account<'info, TargetPool>,
    #[account(mut)]
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseMarket<'info> {
    #[account(mut, close = cranker, seeds = [b"market", market.game.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// Drained to nothing before the book may close. Closed by CPI rather than
    /// by Anchor's `close`, which only works on accounts this program owns: a
    /// token account belongs to the token program and has to be told to close
    /// itself, signed by the authority, which here is the vault PDA.
    #[account(mut, seeds = [b"mvault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub cranker: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(agent: Pubkey)]
pub struct SetBackable<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, GameConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed, payer = authority, space = Backable::SPACE,
        seeds = [b"backable", agent.as_ref()], bump
    )]
    pub backable: Account<'info, Backable>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent: Pubkey)]
pub struct ClearBackable<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, GameConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut, close = authority,
        seeds = [b"backable", agent.as_ref()], bump = backable.bump
    )]
    pub backable: Account<'info, Backable>,
}

#[derive(Accounts)]
pub struct OpenMarket<'info> {
    #[account(seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(
        init, payer = payer, space = Market::SPACE,
        seeds = [b"market", game.key().as_ref()], bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init, payer = payer,
        token::mint = stake_mint, token::authority = market_vault,
        seeds = [b"mvault", market.key().as_ref()], bump
    )]
    pub market_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(constraint = stake_mint.key() == game.stake_mint @ GameError::BadParam)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"market", game.key().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"mvault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: InterfaceAccount<'info, TokenAccount>,
    /// The agent being backed, proven to be in this game by its own PDA.
    #[account(
        seeds = [b"player", game.key().as_ref(), target_player.owner.as_ref()],
        bump
    )]
    pub target_player: Account<'info, Player>,
    /// Proof the agent is on the book. Unmarked agents have no such account, so
    /// the instruction cannot be built for them.
    #[account(seeds = [b"backable", target_player.owner.as_ref()], bump = backable.bump)]
    pub backable: Account<'info, Backable>,
    #[account(
        init_if_needed, payer = payer, space = TargetPool::SPACE,
        seeds = [b"tpool", market.key().as_ref(), target_player.owner.as_ref()], bump
    )]
    pub target_pool: Account<'info, TargetPool>,
    #[account(
        init_if_needed, payer = payer, space = Bet::SPACE,
        seeds = [b"bet", market.key().as_ref(), bettor.key().as_ref(),
                 target_player.owner.as_ref()], bump
    )]
    pub bet: Account<'info, Bet>,
    #[account(mut, constraint = payer_token.mint == market.stake_mint @ GameError::BadParam,
              constraint = payer_token.owner == payer.key() @ GameError::Unauthorized)]
    pub payer_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the identity the bet belongs to, and the only key that can claim
    /// it. Not a signer, so a relayer can place one for somebody who has no key.
    pub bettor: UncheckedAccount<'info>,
    /// Whoever signs and funds it: the bettor with a wallet, or a relayer.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Required only when payer is not the bettor: proof it is allow-listed, so
    /// nobody can open a bet under a stranger's identity.
    #[account(seeds = [b"relayer", payer.key().as_ref()], bump = relayer.bump)]
    pub relayer: Option<Account<'info, AllowedRelayer>>,
    #[account(constraint = stake_mint.key() == market.stake_mint @ GameError::BadParam)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveTarget<'info> {
    #[account(seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"market", game.key().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"tpool", market.key().as_ref(), target_pool.target.as_ref()],
              bump = target_pool.bump)]
    pub target_pool: Account<'info, TargetPool>,
    #[account(
        seeds = [b"player", game.key().as_ref(), target_player.owner.as_ref()],
        bump
    )]
    pub target_player: Account<'info, Player>,
    /// The comb still standing, the same account claim_winnings is handed.
    #[account(seeds = [b"circle", game.key().as_ref(), &[winning_circle.circle_id]],
              bump = winning_circle.bump)]
    pub winning_circle: Account<'info, Circle>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimBet<'info> {
    #[account(seeds = [b"market", market.game.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"mvault", market.key().as_ref()], bump = market.vault_bump)]
    pub market_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(seeds = [b"tpool", market.key().as_ref(), bet.target.as_ref()],
              bump = target_pool.bump)]
    pub target_pool: Account<'info, TargetPool>,
    #[account(
        mut,
        seeds = [b"bet", market.key().as_ref(), bettor.key().as_ref(), bet.target.as_ref()],
        bump = bet.bump,
        constraint = bet.bettor == bettor.key() @ GameError::Unauthorized
    )]
    pub bet: Account<'info, Bet>,
    #[account(mut, constraint = bettor_token.owner == bettor.key() @ GameError::Unauthorized)]
    pub bettor_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: whose bet this is. The payout always goes to their own token
    /// account, so a relayer claiming for them cannot redirect it.
    pub bettor: UncheckedAccount<'info>,
    /// The bettor with a wallet, or an allow-listed relayer acting for them. A
    /// bet placed by the relayer would be unclaimable without this, since the
    /// identity it belongs to has no key to sign with.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [b"relayer", payer.key().as_ref()], bump = relayer.bump)]
    pub relayer: Option<Account<'info, AllowedRelayer>>,
    #[account(constraint = stake_mint.key() == market.stake_mint @ GameError::BadParam)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}
