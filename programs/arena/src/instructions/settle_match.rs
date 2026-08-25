use anchor_lang::prelude::*;
use anchor_lang::solana_program::{ed25519_program, hash::hashv, sysvar::instructions as ix_sysvar};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::ArenaError;

#[derive(Accounts)]
pub struct SettleMatch<'info> {
    #[account(
        mut,
        constraint = match_account.status == MatchStatus::InProgress @ ArenaError::AlreadySettled,
    )]
    pub match_account: Account<'info, MatchAccount>,

    #[account(
        mut,
        address = match_account.vault @ ArenaError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub winner_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub treasury_token: Account<'info, TokenAccount>,

    /// CHECK: Solana instructions sysvar
    #[account(address = sysvar::instructions::ID)]
    pub sysvar_instructions: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<SettleMatch>, winner: Pubkey, scores: Vec<u64>) -> Result<()> {
    let m = &mut ctx.accounts.match_account;

    let mut found = false;
    for i in 0..m.player_count as usize {
        if m.players[i] == winner {
            found = true;
            break;
        }
    }
    require!(found, ArenaError::WinnerNotInMatch);

    // Verify Ed25519 prelude instruction (must be at index 0 in this tx)
    let sibling = ix_sysvar::load_instruction_at_checked(0, &ctx.accounts.sysvar_instructions)
        .map_err(|_| error!(ArenaError::InvalidResultSignature))?;
    require!(sibling.program_id == ed25519_program::ID, ArenaError::InvalidResultSignature);

    let d = &sibling.data;
    require!(d.len() >= 14, ArenaError::InvalidResultSignature);

    let pubkey_off = u16::from_le_bytes([d[6], d[7]]) as usize;
    let msg_off    = u16::from_le_bytes([d[10], d[11]]) as usize;
    let msg_len    = u16::from_le_bytes([d[12], d[13]]) as usize;

    require!(
        pubkey_off + 32 <= d.len() && msg_off + msg_len <= d.len(),
        ArenaError::InvalidResultSignature
    );

    let ix_pubkey = Pubkey::try_from(&d[pubkey_off..pubkey_off + 32])
        .map_err(|_| error!(ArenaError::InvalidResultSignature))?;
    require!(ix_pubkey == m.authority, ArenaError::InvalidResultSignature);

    let mut scores_bytes: Vec<u8> = Vec::with_capacity(scores.len() * 8);
    for s in &scores {
        scores_bytes.extend_from_slice(&s.to_le_bytes());
    }
    let expected = hashv(&[
        ctx.accounts.match_account.key().as_ref(),
        winner.as_ref(),
        &scores_bytes,
    ]);
    require!(
        msg_len == 32 && d[msg_off..msg_off + 32] == expected.to_bytes(),
        ArenaError::InvalidResultSignature
    );

    let pot = ctx.accounts.vault.amount;
    let rake = pot * m.rake_bps as u64 / 10_000;
    let payout = pot - rake;

    let authority_key = m.authority;
    let nonce_bytes = m.nonce.to_le_bytes();
    let bump = m.bump;
    let seeds: &[&[u8]] = &[b"match", authority_key.as_ref(), &nonce_bytes, &[bump]];
    let signer = &[seeds];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.winner_token.to_account_info(),
                authority: ctx.accounts.match_account.to_account_info(),
            },
            signer,
        ),
        payout,
    )?;

    if rake > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.treasury_token.to_account_info(),
                    authority: ctx.accounts.match_account.to_account_info(),
                },
                signer,
            ),
            rake,
        )?;
    }

    m.status = MatchStatus::Settled;
    Ok(())
}
