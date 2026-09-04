use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};
use crate::state::*;
use crate::errors::ArenaError;

#[derive(Accounts)]
#[instruction(entry_fee: u64, max_players: u8, rake_bps: u16, nonce: u64, treasury: Pubkey)]
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

/// `treasury` is the token account the rake will be paid into, taken as a plain
/// `Pubkey` rather than an `Account<TokenAccount>`.
///
/// It is an argument and not an account because it is optional in practice: at
/// `rake_bps == 0` -- the default, and what every deployment runs until rake is
/// turned on -- there is no treasury to name, and an optional account would put
/// that awkwardness into the IDL and into the hand-rolled TypeScript builder for
/// no gain. What matters is that the value is *pinned* at creation so
/// `settle_match` cannot be handed a different one later; validating that the
/// account exists and holds the right mint is done at settlement (where it is a
/// real account and can be checked properly) and at server boot, where a
/// misconfigured `TREASURY_TOKEN_ACCOUNT` is refused before any lobby is made.
pub fn handler(
    ctx: Context<CreateMatch>,
    entry_fee: u64,
    max_players: u8,
    rake_bps: u16,
    nonce: u64,
    treasury: Pubkey,
) -> Result<()> {
    require!(rake_bps <= 1000, ArenaError::RakeTooHigh);
    require!(
        max_players >= 2 && (max_players as usize) <= MAX_PLAYERS,
        ArenaError::MatchFull
    );
    // Taking a cut with nowhere to send it is a misconfiguration, and the point
    // at which to say so is before anyone stakes. Without this the match would
    // be created happily and then fail at settlement -- with the pot already in
    // the vault, and the settler correctly refusing to guess a destination.
    // The server checks the same thing at boot; this is the on-chain half, and
    // it holds for any client, not just ours.
    require!(
        rake_bps == 0 || treasury != Pubkey::default(),
        ArenaError::TreasuryRequired
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
    m.treasury = treasury;
    Ok(())
}
