use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::ArenaError;

/// Refund all stakers (authority-only).
///
/// Accepts `Open` at any time, and `InProgress` only once `MATCH_TIMEOUT_SECS`
/// has elapsed since `created_at` -- the escape hatch for a filled match whose
/// server died before it could settle. Without it such a pot is unrecoverable:
/// `settle_match` takes only `InProgress` and needs a winner nobody can supply.
///
/// This does not widen who is trusted. The authority already signs the result
/// digest that decides the payout, so it could always deny a winner; all this
/// adds is a 24h-delayed refund path that returns the money to the players.
#[derive(Accounts)]
pub struct CancelMatch<'info> {
    pub authority: Signer<'info>,

    // The status gate lives in the handler, not here: `InProgress` is allowed
    // only conditionally on the clock, which an account constraint cannot
    // express. Anything that touches this struct must leave that check in
    // place -- dropping the constraint without the handler's `require!` would
    // let the authority cancel a live match mid-play.
    #[account(
        mut,
        has_one = authority @ ArenaError::Unauthorized,
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
    // Status gate, moved off the Accounts struct (see the comment there).
    // Matching on the enum by place moves nothing -- every variant is a unit.
    match ctx.accounts.match_account.status {
        MatchStatus::Open => {}
        MatchStatus::InProgress => {
            let now = Clock::get()?.unix_timestamp;
            // saturating_sub: a clock that somehow reads before created_at
            // must not wrap into a huge positive and authorise the cancel.
            require!(
                now.saturating_sub(ctx.accounts.match_account.created_at)
                    >= MATCH_TIMEOUT_SECS,
                ArenaError::MatchNotTimedOut
            );
        }
        MatchStatus::Settled | MatchStatus::Cancelled => {
            return Err(ArenaError::NotOpen.into());
        }
    }

    // Copy the values needed before the CPI loop. Holding a `&mut` to
    // match_account across the transfers would conflict with the immutable
    // borrow `to_account_info()` needs, so the mutation is deferred to the end.
    let count = ctx.accounts.match_account.player_count as usize;
    let authority_key = ctx.accounts.match_account.authority;
    let nonce_bytes = ctx.accounts.match_account.nonce.to_le_bytes();
    let bump = ctx.accounts.match_account.bump;
    let stakes = ctx.accounts.match_account.stakes;
    let players = ctx.accounts.match_account.players;
    let mint = ctx.accounts.match_account.mint;

    require!(
        ctx.remaining_accounts.len() >= count,
        ArenaError::InvalidRefundAccount
    );

    let seeds: &[&[u8]] = &[b"match", authority_key.as_ref(), &nonce_bytes, &[bump]];
    let signer = &[seeds];

    for i in 0..count {
        let refund_account = &ctx.remaining_accounts[i];

        // `remaining_accounts` bypasses `#[derive(Accounts)]` entirely, so
        // nothing has validated this beyond the caller's word. Without the
        // checks below the authority could name any token account of the right
        // mint -- its own included -- and take every stake, which is precisely
        // the custody CLAUDE.md's Hard Rules say the server never has.
        //
        // Done by hand rather than with `Account::try_from` because that would
        // force the context's `'c` lifetime to `'info`. The owner check is the
        // load-bearing one: `TokenAccount::try_deserialize` only unpacks, so
        // without it any 165-byte account decodes into a plausible token
        // account. The borrow is scoped so it is released before the CPI below,
        // which needs the account mutably.
        {
            require!(
                refund_account.owner == &token::ID,
                ArenaError::InvalidRefundAccount
            );
            let data = refund_account.try_borrow_data()?;
            let refund_token = TokenAccount::try_deserialize(&mut &data[..])
                .map_err(|_| error!(ArenaError::InvalidRefundAccount))?;
            require!(
                refund_token.owner == players[i],
                ArenaError::InvalidRefundAccount
            );
            require!(refund_token.mint == mint, ArenaError::InvalidRefundAccount);
        }

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
