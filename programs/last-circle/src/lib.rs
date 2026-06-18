//! Last Circle Standing — on-chain program (Solana / Anchor).
//!
//! Build milestone 1: config + SOL escrow + lobby state machine.
//! (create_game / create_circle / join_circle / start_game)
//! Instance loop, commit-reveal, fog/fate death, prediction skill-pool, and
//! settlement land in subsequent milestones — see /SPEC.md and /ARCHITECTURE.md.
//!
//! Economic identity (asserted as invariants as logic is added):
//!   Σ deposits == Σ payouts + house_profit + Δ(jackpot_pool)   (exact to the lamport)

use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

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
    pub fn create_game(ctx: Context<CreateGame>, game_id: u64, num_circles: u8) -> Result<()> {
        require!(num_circles == 6 || num_circles == 12, GameError::BadParam);

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
        g.instance_seconds = ctx.accounts.config.instance_seconds;
        g.doomed_circle = 0;
        g.circle_count = 0;
        g.player_count = 0;
        g.alive_circles = 0;
        g.leftover_pot = 0;
        g.fees_collected = 0;
        g.total_deposited = 0;
        g.total_points = 0;
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

        let net = take_deposit(
            &ctx.accounts.config,
            stake,
            &ctx.accounts.owner,
            &ctx.accounts.vault,
            &ctx.accounts.system_program,
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

        init_player(&mut ctx.accounts.player, g.key(), ctx.accounts.owner.key(), net, circle_id, ctx.bumps.player);

        g.circle_count += 1;
        g.alive_circles += 1;
        g.player_count += 1;
        Ok(())
    }

    /// Join an existing circle in the lobby and stake into it.
    pub fn join_circle(ctx: Context<JoinCircle>, stake: u64) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(g.status == GameStatus::Lobby, GameError::WrongPhase);
        require!(ctx.accounts.circle.alive, GameError::CircleDead);

        let net = take_deposit(
            &ctx.accounts.config,
            stake,
            &ctx.accounts.owner,
            &ctx.accounts.vault,
            &ctx.accounts.system_program,
        )?;
        record_deposit(g, stake, net)?;

        let circle = &mut ctx.accounts.circle;
        circle.member_count += 1;
        circle.total_stake = circle.total_stake.checked_add(net).ok_or(GameError::MathOverflow)?;

        init_player(&mut ctx.accounts.player, g.key(), ctx.accounts.owner.key(), net, circle.circle_id, ctx.bumps.player);

        g.player_count += 1;
        Ok(())
    }

    /// Close the lobby and start the instance loop (instance 1, Commit phase).
    pub fn start_game(ctx: Context<StartGame>) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(g.status == GameStatus::Lobby, GameError::WrongPhase);
        require!(g.alive_circles >= 2, GameError::NotEnoughCircles);
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
        let now = Clock::get()?.unix_timestamp;
        require!(now >= g.phase_ends_at, GameError::PhaseNotOver);
        g.phase = InstancePhase::Reveal;
        g.phase_ends_at = now + g.reveal_window();
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
    /// NOTE: randomness here is a placeholder slot/clock hash — a later milestone
    /// swaps in a real VRF before mainnet.
    pub fn select_death<'info>(
        ctx: Context<'_, '_, 'info, 'info, SelectDeath<'info>>,
    ) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(g.status == GameStatus::Running, GameError::WrongPhase);
        require!(g.phase == InstancePhase::Reveal, GameError::WrongPhase);
        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= g.phase_ends_at, GameError::PhaseNotOver);

        // Collect all alive circles from the remaining accounts.
        let mut alive: Vec<(u8, u32, u64)> = Vec::with_capacity(g.alive_circles as usize);
        for acc in ctx.remaining_accounts.iter() {
            let c: Account<Circle> = Account::try_from(acc)?;
            require!(c.game == g.key(), GameError::BadParam);
            if c.alive {
                alive.push((c.circle_id, c.member_count, c.total_stake));
            }
        }
        // Caller must present EVERY alive circle, else the min could be gamed.
        require!(alive.len() as u8 == g.alive_circles, GameError::IncompleteCircleSet);
        require!(alive.len() >= 2, GameError::NotEnoughCircles);

        // Pseudo-random seed (PLACEHOLDER — replace with VRF).
        let seed = anchor_lang::solana_program::keccak::hashv(&[
            &clock.slot.to_le_bytes(),
            &clock.unix_timestamp.to_le_bytes(),
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
        let now = Clock::get()?.unix_timestamp;
        require!(now >= g.phase_ends_at, GameError::PhaseNotOver);
        if g.alive_circles == 1 {
            g.status = GameStatus::Settling;
        } else {
            g.instance += 1;
            g.phase = InstancePhase::Commit;
            g.phase_ends_at = now + g.commit_window();
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
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
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

        let (creator_cut, _, _) = pot_split(leftover, total_points);
        ctx.accounts.game.creator_cut_paid = true;
        transfer_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
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
        transfer_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
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
        transfer_from_vault(
            &ctx.accounts.vault,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program,
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
            &ctx.accounts.treasury_vault.to_account_info(),
            &ctx.accounts.system_program,
            gkey,
            gvbump,
            fees,
        )?;
        let t = &mut ctx.accounts.treasury;
        t.house_balance = t.house_balance.checked_add(house).ok_or(GameError::MathOverflow)?;
        t.jackpot_pool = t.jackpot_pool.checked_add(jackpot).ok_or(GameError::MathOverflow)?;
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
            &ctx.accounts.authority.to_account_info(),
            &ctx.accounts.system_program,
            vbump,
            amount,
        )
    }

    /// Post-lock crank: roll for an INSANE round. On a hit, the whole jackpot
    /// pool is injected into this game's leftover pot (and the pool resets).
    /// Revealed after the 50% lock so it can't be targeted at deposit time.
    ///
    /// NOTE: placeholder randomness (slot/clock hash) — swap in VRF before mainnet.
    pub fn roll_insane(ctx: Context<RollInsane>) -> Result<()> {
        let (status, instance, lock, rolled, gkey, gvbump) = {
            let g = &ctx.accounts.game;
            (g.status, g.instance, g.lock_instance, g.insane_rolled, g.key(), g.vault_bump)
        };
        require!(status == GameStatus::Running, GameError::WrongPhase);
        require!(instance >= lock, GameError::TooEarly);
        require!(!rolled, GameError::AlreadyClaimed);

        let clock = Clock::get()?;
        let seed = anchor_lang::solana_program::keccak::hashv(&[
            &clock.slot.to_le_bytes(),
            &clock.unix_timestamp.to_le_bytes(),
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
                    &ctx.accounts.vault.to_account_info(),
                    &ctx.accounts.system_program,
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
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Validate stake bounds, transfer lamports to the vault, and return the NET
/// stake (deposit minus rake) that actually goes into play.
fn take_deposit<'info>(
    config: &Account<'info, GameConfig>,
    stake: u64,
    owner: &Signer<'info>,
    vault: &SystemAccount<'info>,
    system_program: &Program<'info, System>,
) -> Result<u64> {
    require!(stake >= config.min_stake && stake <= config.max_stake, GameError::StakeOutOfRange);

    anchor_lang::system_program::transfer(
        CpiContext::new(
            system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: owner.to_account_info(),
                to: vault.to_account_info(),
            },
        ),
        stake,
    )?;

    let rake = ((stake as u128 * config.fee_bps as u128) / BPS) as u64;
    let net = stake.checked_sub(rake).ok_or(GameError::MathOverflow)?;
    Ok(net)
}

/// Record a deposit's accounting on the game account.
fn record_deposit(game: &mut Account<Game>, stake: u64, net: u64) -> Result<()> {
    let rake = stake.checked_sub(net).ok_or(GameError::MathOverflow)?;
    game.fees_collected = game.fees_collected.checked_add(rake).ok_or(GameError::MathOverflow)?;
    game.total_deposited = game.total_deposited.checked_add(stake).ok_or(GameError::MathOverflow)?;
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

/// Transfer `amount` lamports out of the treasury vault PDA (signed).
fn transfer_from_treasury<'info>(
    treasury_vault: &SystemAccount<'info>,
    to: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    vault_bump: u8,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[b"treasury_vault", &[vault_bump]];
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: treasury_vault.to_account_info(),
                to: to.clone(),
            },
            &[seeds],
        ),
        amount,
    )?;
    Ok(())
}

/// Transfer `amount` lamports out of the program-owned vault PDA (signed).
fn transfer_from_vault<'info>(
    vault: &SystemAccount<'info>,
    to: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    game_key: Pubkey,
    vault_bump: u8,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[b"vault", game_key.as_ref(), &[vault_bump]];
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: vault.to_account_info(),
                to: to.clone(),
            },
            &[seeds],
        ),
        amount,
    )?;
    Ok(())
}

fn init_player(player: &mut Account<Player>, game: Pubkey, owner: Pubkey, stake: u64, circle_id: u8, bump: u8) {
    player.game = game;
    player.owner = owner;
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
#[account]
pub struct Treasury {
    pub authority: Pubkey,
    pub house_balance: u64,
    pub jackpot_pool: u64,
    pub vault_bump: u8,
    pub bump: u8,
}
impl Treasury {
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 1 + 1;
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
        8 + 8 + 32 + 1 + 1 + 2 + 2 + 1 + 8 + 4 + 1 + 1 + 1 + 4 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 1;
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
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1 + 4 + 1 + 32 + 2 + 32 + 2 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum GameStatus {
    Lobby,
    Running,
    Settling,
    Closed,
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
    #[account(
        init,
        payer = authority,
        space = Game::SPACE,
        seeds = [b"game", game_id.to_le_bytes().as_ref()],
        bump
    )]
    pub game: Account<'info, Game>,
    /// SOL escrow PDA for this game. System-owned; holds all staked lamports.
    #[account(
        mut,
        seeds = [b"vault", game.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
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
    pub vault: SystemAccount<'info>,
    #[account(
        init,
        payer = owner,
        space = Circle::SPACE,
        seeds = [b"circle", game.key().as_ref(), &[circle_id]],
        bump
    )]
    pub circle: Account<'info, Circle>,
    #[account(
        init,
        payer = owner,
        space = Player::SPACE,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub player: Account<'info, Player>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinCircle<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [b"circle", game.key().as_ref(), &[circle.circle_id]],
        bump = circle.bump
    )]
    pub circle: Account<'info, Circle>,
    #[account(
        init,
        payer = owner,
        space = Player::SPACE,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub player: Account<'info, Player>,
    #[account(mut)]
    pub owner: Signer<'info>,
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
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    pub owner: Signer<'info>,
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
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    pub owner: Signer<'info>,
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
    pub owner: Signer<'info>,
}

/// All alive circles are passed via `remaining_accounts` (read-only).
#[derive(Accounts)]
pub struct SelectDeath<'info> {
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
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
    pub vault: SystemAccount<'info>,
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
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimCreatorCut<'info> {
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(
        seeds = [b"circle", game.key().as_ref(), &[winning_circle.circle_id]],
        bump = winning_circle.bump
    )]
    pub winning_circle: Account<'info, Circle>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    #[account(seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: SystemAccount<'info>,
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
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimSkill<'info> {
    #[account(seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [b"player", game.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
        has_one = owner @ GameError::Unauthorized,
        constraint = player.game == game.key() @ GameError::BadParam
    )]
    pub player: Account<'info, Player>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitTreasury<'info> {
    #[account(init, payer = authority, space = Treasury::SPACE, seeds = [b"treasury"], bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(seeds = [b"treasury_vault"], bump)]
    pub treasury_vault: SystemAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut, seeds = [b"treasury"], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [b"treasury_vault"], bump = treasury.vault_bump)]
    pub treasury_vault: SystemAccount<'info>,
    pub cranker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawHouse<'info> {
    #[account(mut, seeds = [b"treasury"], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [b"treasury_vault"], bump = treasury.vault_bump)]
    pub treasury_vault: SystemAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RollInsane<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, GameConfig>,
    #[account(mut, seeds = [b"game", game.game_id.to_le_bytes().as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(mut, seeds = [b"vault", game.key().as_ref()], bump = game.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut, seeds = [b"treasury"], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [b"treasury_vault"], bump = treasury.vault_bump)]
    pub treasury_vault: SystemAccount<'info>,
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
    pub owner: Signer<'info>,
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
    #[msg("Need at least 2 circles to start")]
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
}
