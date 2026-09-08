use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount};
use crate::state::*;
use crate::errors::ArenaError;

/// Reclaim the rent from a finished match, and stop it being swept forever.
///
/// `settle_match` and `cancel_match` write a terminal status and nothing else:
/// with no close instruction, every match this authority ever created stayed on
/// chain for the life of the key. Two costs followed. The authority's rent --
/// an 806-byte `MatchAccount` plus a 165-byte vault ATA, about 0.0085 SOL a
/// match -- was never returned, and the recovery sweeper's `getProgramAccounts`
/// scan had to keep filtering an ever-growing terminal set server-side.
///
/// Anchor's `close` constraint is also the right way to do this: it zeroes the
/// data, reassigns the account to the system program and deallocates, which is
/// what stops a closed account being revived by refunding its rent in the same
/// transaction. Draining the lamports by hand would not.
#[derive(Accounts)]
pub struct CloseMatch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ArenaError::Unauthorized,
        close = authority,
    )]
    pub match_account: Account<'info, MatchAccount>,

    #[account(
        mut,
        address = match_account.vault @ ArenaError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CloseMatch>) -> Result<()> {
    // Only a match that can no longer move money. `Open` and `InProgress` both
    // still have a live path to a payout or a refund, and closing either would
    // destroy the record those paths depend on.
    match ctx.accounts.match_account.status {
        MatchStatus::Settled | MatchStatus::Cancelled => {}
        MatchStatus::Open | MatchStatus::InProgress => {
            return Err(ArenaError::MatchNotTerminal.into());
        }
    }

    // The SPL token program refuses to close a non-empty account anyway; this
    // just names the reason. It is reachable: `cancel_match` refunds `stakes`
    // rather than the whole balance, so a match somebody donated into is left
    // with a residue and cannot be closed. That is the donor griefing
    // themselves -- there is no non-arbitrary party to sweep it to.
    require!(
        ctx.accounts.vault.amount == 0,
        ArenaError::VaultNotEmpty
    );

    let authority_key = ctx.accounts.match_account.authority;
    let nonce_bytes = ctx.accounts.match_account.nonce.to_le_bytes();
    let bump = ctx.accounts.match_account.bump;
    let seeds: &[&[u8]] = &[b"match", authority_key.as_ref(), &nonce_bytes, &[bump]];
    let signer = &[seeds];

    // Anchor applies `close` after the handler returns, so the match PDA is
    // still live here and can sign for its own vault.
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.authority.to_account_info(),
            authority: ctx.accounts.match_account.to_account_info(),
        },
        signer,
    ))?;

    Ok(())
}
