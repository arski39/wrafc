use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::ArenaError;

#[derive(Accounts)]
pub struct JoinMatch<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        mut,
        constraint = match_account.status == MatchStatus::Open @ ArenaError::NotOpen,
        constraint = (match_account.player_count as usize) < match_account.max_players as usize @ ArenaError::MatchFull,
    )]
    pub match_account: Account<'info, MatchAccount>,

    #[account(
        mut,
        address = match_account.vault @ ArenaError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = player_token.owner == player.key(),
        constraint = player_token.mint == match_account.mint,
    )]
    pub player_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<JoinMatch>) -> Result<()> {
    let m = &mut ctx.accounts.match_account;
    let idx = m.player_count as usize;
    let player_key = ctx.accounts.player.key();

    for i in 0..idx {
        require!(m.players[i] != player_key, ArenaError::AlreadyJoined);
    }
    require!(ctx.accounts.player_token.amount >= m.entry_fee, ArenaError::FeeMismatch);

    let cpi = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.player_token.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.player.to_account_info(),
        },
    );
    token::transfer(cpi, m.entry_fee)?;

    m.players[idx] = player_key;
    m.stakes[idx] = m.entry_fee;
    m.player_count += 1;

    if m.player_count == m.max_players {
        m.status = MatchStatus::InProgress;
    }
    Ok(())
}
