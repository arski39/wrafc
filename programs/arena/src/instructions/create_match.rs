use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use crate::state::*;
use crate::errors::ArenaError;

#[derive(Accounts)]
#[instruction(entry_fee: u64, max_players: u8, rake_bps: u16, nonce: u64)]
pub struct CreateMatch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = MatchAccount::SPACE,
        seeds = [b"match", authority.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub match_account: Account<'info, MatchAccount>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = match_account,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<CreateMatch>,
    entry_fee: u64,
    max_players: u8,
    rake_bps: u16,
    nonce: u64,
) -> Result<()> {
    require!(rake_bps <= 1000, ArenaError::RakeTooHigh);
    require!(
        max_players >= 2 && (max_players as usize) <= MAX_PLAYERS,
        ArenaError::MatchFull
    );

    let m = &mut ctx.accounts.match_account;
    m.authority = ctx.accounts.authority.key();
    m.mint = ctx.accounts.mint.key();
    m.vault = ctx.accounts.vault.key();
    m.entry_fee = entry_fee;
    m.rake_bps = rake_bps;
    m.max_players = max_players;
    m.player_count = 0;
    m.status = MatchStatus::Open;
    m.created_at = Clock::get()?.unix_timestamp;
    m.nonce = nonce;
    m.bump = ctx.bumps.match_account;
    Ok(())
}
