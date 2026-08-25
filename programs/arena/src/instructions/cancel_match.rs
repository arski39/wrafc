use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::ArenaError;

/// Refund all stakers when a match never started (authority-only, Open status only).
#[derive(Accounts)]
pub struct CancelMatch<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ArenaError::Unauthorized,
        constraint = match_account.status == MatchStatus::Open @ ArenaError::NotOpen,
    )]
    pub match_account: Account<'info, MatchAccount>,

    #[account(
        mut,
        address = match_account.vault @ ArenaError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Remaining accounts must be the token accounts of each staker in join order.
///
/// The explicit `'info` binding is required because this handler feeds
/// `remaining_accounts` into a CPI alongside `ctx.accounts`; without it the two
/// lifetimes are unrelated and `Account<'info, T>` is invariant over `'info`.
pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, CancelMatch<'info>>,
) -> Result<()> {
    // Copy the values needed before the CPI loop. Holding a `&mut` to
    // match_account across the transfers would conflict with the immutable
    // borrow `to_account_info()` needs, so the mutation is deferred to the end.
    let count = ctx.accounts.match_account.player_count as usize;
    let authority_key = ctx.accounts.match_account.authority;
    let nonce_bytes = ctx.accounts.match_account.nonce.to_le_bytes();
    let bump = ctx.accounts.match_account.bump;
    let stakes = ctx.accounts.match_account.stakes;

    require!(
        ctx.remaining_accounts.len() >= count,
        ArenaError::FeeMismatch
    );

    let seeds: &[&[u8]] = &[b"match", authority_key.as_ref(), &nonce_bytes, &[bump]];
    let signer = &[seeds];

    for i in 0..count {
        let refund_account = &ctx.remaining_accounts[i];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: refund_account.to_account_info(),
                    authority: ctx.accounts.match_account.to_account_info(),
                },
                signer,
            ),
            stakes[i],
        )?;
    }

    ctx.accounts.match_account.status = MatchStatus::Cancelled;
    Ok(())
}
