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
    ) -> Result<()> {
        require!(fee_bps <= 2_000, GameError::BadParam); // cap rake at 20%
        require!(house_cut_bps <= 10_000, GameError::BadParam);
        require!(min_stake > 0 && max_stake >= min_stake, GameError::BadParam);
        require!(instance_seconds > 0, GameError::BadParam);

        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.fee_bps = fee_bps;
        c.house_cut_bps = house_cut_bps;
        c.min_stake = min_stake;
        c.max_stake = max_stake;
        c.instance_seconds = instance_seconds;
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
        g.circle_count = 0;
        g.player_count = 0;
        g.alive_circles = 0;
        g.leftover_pot = 0;
        g.fees_collected = 0;
        g.total_deposited = 0;
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

    /// Close the lobby and start the instance loop.
    pub fn start_game(ctx: Context<StartGame>) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(g.status == GameStatus::Lobby, GameError::WrongPhase);
        require!(g.alive_circles >= 2, GameError::NotEnoughCircles);
        g.status = GameStatus::Running;
        g.instance = 0;
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

fn init_player(player: &mut Account<Player>, game: Pubkey, owner: Pubkey, stake: u64, circle_id: u8, bump: u8) {
    player.game = game;
    player.owner = owner;
    player.stake = stake;
    player.current_circle = circle_id;
    player.points = 0;
    player.status = PlayerStatus::Active;
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
    pub bump: u8,
}
impl GameConfig {
    pub const SPACE: usize = 8 + 32 + 2 + 2 + 8 + 8 + 4 + 1;
}

#[account]
pub struct Game {
    pub game_id: u64,
    pub authority: Pubkey,
    pub status: GameStatus,
    pub num_circles: u8,
    pub lock_instance: u16,
    pub instance: u16,
    pub circle_count: u8,
    pub alive_circles: u8,
    pub player_count: u32,
    pub leftover_pot: u64,
    pub fees_collected: u64,
    pub total_deposited: u64,
    pub vault_bump: u8,
    pub bump: u8,
}
impl Game {
    pub const SPACE: usize = 8 + 8 + 32 + 1 + 1 + 2 + 2 + 1 + 1 + 4 + 8 + 8 + 8 + 1 + 1;
}

#[account]
pub struct Circle {
    pub game: Pubkey,
    pub circle_id: u8,
    pub creator: Pubkey,
    pub member_count: u32,
    pub total_stake: u64,
    pub alive: bool,
    pub bump: u8,
}
impl Circle {
    pub const SPACE: usize = 8 + 32 + 1 + 32 + 4 + 8 + 1 + 1;
}

#[account]
pub struct Player {
    pub game: Pubkey,
    pub owner: Pubkey,
    pub stake: u64,
    pub current_circle: u8,
    pub points: u32,
    pub status: PlayerStatus,
    pub bump: u8,
}
impl Player {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1 + 4 + 1 + 1;
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
}
