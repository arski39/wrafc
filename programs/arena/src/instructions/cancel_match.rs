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
pub fn handler(ctx: Context<CancelMatch>) -> Result<()> {
    let m = &mut ctx.accounts.match_account;
    let count = m.player_count as usize;

    require!(
        ctx.remaining_accounts.len() >= count,
        ArenaError::FeeMismatch
    );

    let authority_key = m.authority;
    let nonce_bytes = m.nonce.to_le_bytes();
    let bump = m.bump;
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
            m.stakes[i],
        )?;
    }

    m.status = MatchStatus::Cancelled;
    Ok(())
}
