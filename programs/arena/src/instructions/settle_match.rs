use anchor_lang::prelude::*;
use anchor_lang::solana_program::{ed25519_program, hash::hashv, sysvar::instructions as ix_sysvar};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::ArenaError;

/// Byte layout of the Ed25519 precompile's instruction data.
///
/// `[num_signatures: u8][padding: u8]` then one 14-byte `Ed25519SignatureOffsets`
/// record per signature:
///
/// ```text
///  offset  field
///   0      num_signatures
///   1      padding
///   2..4   signature_offset
///   4..6   signature_instruction_index
///   6..8   public_key_offset
///   8..10  public_key_instruction_index
///  10..12  message_data_offset
///  12..14  message_data_size
///  14..16  message_instruction_index
/// ```
///
/// A single-signature instruction therefore carries at least 16 bytes of header.
const ED25519_HEADER_LEN: usize = 16;

/// The value an `*_instruction_index` must carry for the precompile to read
/// from the ed25519 instruction's own data. Any other value makes it read from
/// a *different* instruction in the same transaction -- see the handler.
const ED25519_THIS_INSTRUCTION: u16 = u16::MAX;

#[derive(Accounts)]
pub struct SettleMatch<'info> {
    /// The match authority.
    ///
    /// Declared as a signer even though the ed25519 prelude already attests the
    /// result, and both are load-bearing for different reasons: the signature
    /// proves *what was attested* and is verifiable by anyone holding the
    /// authority's pubkey, while this proves *who submitted it*. Without the
    /// signer, anyone who saw a settle transaction could rebuild it with the
    /// same prelude and their own `winner_token` and win the race -- the digest
    /// names the winner but not the destination account.
    ///
    /// It costs nothing: the server already signs this transaction as fee payer.
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ ArenaError::Unauthorized,
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

    /// Rake destination, pinned to the treasury recorded at `create_match`.
    ///
    /// It used to be unconstrained, and that was the last thing the authority
    /// could still choose freely at settlement time. There is now an on-chain
    /// record to pin it against, so it is pinned -- in the handler rather than
    /// here, because the rule is conditional on `rake_bps` and an account
    /// constraint cannot express that. See the handler; a mutation test covers
    /// the removal.
    ///
    /// The mint check *is* an account constraint, because it holds
    /// unconditionally: a treasury holding some other token fails the rake
    /// transfer, which fails the whole settlement and strands the pot until the
    /// 24h timeout. That was previously only caught at server boot.
    #[account(
        mut,
        constraint = treasury_token.mint == match_account.mint @ ArenaError::TreasuryMintMismatch,
    )]
    pub treasury_token: Account<'info, TokenAccount>,

    /// CHECK: Solana instructions sysvar
    #[account(address = ix_sysvar::ID)]
    pub sysvar_instructions: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<SettleMatch>, winner: Pubkey, scores: Vec<u64>) -> Result<()> {
    // Copy out every value needed up front. Holding a `&mut` to match_account
    // across the CPI calls below would conflict with the immutable borrows they
    // need (`to_account_info()`), so the mutable borrow is deferred to the end.
    let match_key = ctx.accounts.match_account.key();
    let authority_key = ctx.accounts.match_account.authority;
    let rake_bps = ctx.accounts.match_account.rake_bps;
    let treasury = ctx.accounts.match_account.treasury;
    let nonce_bytes = ctx.accounts.match_account.nonce.to_le_bytes();
    let bump = ctx.accounts.match_account.bump;
    let player_count = ctx.accounts.match_account.player_count as usize;

    let mut found = false;
    for i in 0..player_count {
        if ctx.accounts.match_account.players[i] == winner {
            found = true;
            break;
        }
    }
    require!(found, ArenaError::WinnerNotInMatch);

    // The digest names the winner, not the account the tokens land in, so
    // without this the payout destination is unbound. Checked here rather than
    // as an account constraint because `winner` is an instruction argument.
    require!(
        ctx.accounts.winner_token.owner == winner,
        ArenaError::WinnerTokenOwnerMismatch
    );

    // The rake destination is fixed at creation and cannot be re-chosen here.
    //
    // Until this existed, the authority picked it at settlement: the digest
    // does not cover `treasury_token` and nothing pinned it, so the one thing
    // still left to the authority's discretion at payout time was where the
    // house cut went. Deciding it once, when the match is made, is what closes
    // that -- and it is checkable by anyone reading the match account, which a
    // per-settlement choice never could be.
    //
    // Conditional on rake, so it lives here and not on the Accounts struct: at
    // `rake_bps == 0` nothing is transferred to this account at all, and the
    // server passes the winner's own token account rather than requiring every
    // free-of-rake deployment to configure a treasury it will never use. Same
    // reason H3's status gate moved off its Accounts struct. ANYTHING EDITING
    // THIS FUNCTION MUST LEAVE THIS require! IN PLACE.
    require!(
        rake_bps == 0 || ctx.accounts.treasury_token.key() == treasury,
        ArenaError::InvalidTreasury
    );

    // Verify Ed25519 prelude instruction (must be at index 0 in this tx)
    let sibling = ix_sysvar::load_instruction_at_checked(0, &ctx.accounts.sysvar_instructions)
        .map_err(|_| error!(ArenaError::InvalidResultSignature))?;
    require!(sibling.program_id == ed25519_program::ID, ArenaError::InvalidResultSignature);

    let d = &sibling.data;
    require!(d.len() >= ED25519_HEADER_LEN, ArenaError::InvalidResultSignature);

    // Exactly one signature. With more, the record parsed below is only the
    // first of several and says nothing about the rest.
    require!(d[0] == 1, ArenaError::InvalidResultSignature);

    let sig_ix_index = u16::from_le_bytes([d[4], d[5]]);
    let pubkey_off = u16::from_le_bytes([d[6], d[7]]) as usize;
    let pubkey_ix_index = u16::from_le_bytes([d[8], d[9]]);
    let msg_off = u16::from_le_bytes([d[10], d[11]]) as usize;
    let msg_len = u16::from_le_bytes([d[12], d[13]]) as usize;
    let msg_ix_index = u16::from_le_bytes([d[14], d[15]]);

    // THE CHECK THIS WHOLE INSTRUCTION RESTS ON. These three fields tell the
    // precompile *which instruction in the transaction* to read the signature,
    // pubkey and message from; only u16::MAX means "this one" (see Agave's
    // ed25519 `get_data_slice`). Without pinning them, an attacker points the
    // precompile at a second instruction carrying their own key and message --
    // which verifies perfectly well -- while laying out this instruction's own
    // bytes so that the same offsets hold the authority's pubkey and the
    // expected digest. The precompile checks the attacker's signature, the code
    // below reads the authority's key, and the pot pays out to whoever asked.
    // Pinning all three to u16::MAX makes the bytes the precompile verified the
    // exact bytes read here, so there is nothing left to substitute.
    require!(
        sig_ix_index == ED25519_THIS_INSTRUCTION
            && pubkey_ix_index == ED25519_THIS_INSTRUCTION
            && msg_ix_index == ED25519_THIS_INSTRUCTION,
        ArenaError::InvalidResultSignature
    );

    require!(
        pubkey_off + 32 <= d.len() && msg_off + msg_len <= d.len(),
        ArenaError::InvalidResultSignature
    );

    let ix_pubkey = Pubkey::try_from(&d[pubkey_off..pubkey_off + 32])
        .map_err(|_| error!(ArenaError::InvalidResultSignature))?;
    require!(ix_pubkey == authority_key, ArenaError::InvalidResultSignature);

    let mut scores_bytes: Vec<u8> = Vec::with_capacity(scores.len() * 8);
    for s in &scores {
        scores_bytes.extend_from_slice(&s.to_le_bytes());
    }
    let expected = hashv(&[
        match_key.as_ref(),
        winner.as_ref(),
        &scores_bytes,
    ]);
    require!(
        msg_len == 32 && d[msg_off..msg_off + 32] == expected.to_bytes(),
        ArenaError::InvalidResultSignature
    );

    // The pot is the vault's balance, not the sum of `stakes`, and that is
    // deliberate. The usual warning against deriving value from a raw balance
    // targets share maths, where a donation dilutes other claimants; this is
    // winner-take-all with a single claimant, so a donor can only hand their own
    // tokens to the winner. Reading the balance also keeps the vault
    // self-emptying, which is what lets `close_match` reclaim the rent --
    // `sum(stakes)` would strand donations *and* block the close.
    let pot = ctx.accounts.vault.amount;
    let rake = pot
        .checked_mul(rake_bps as u64)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(ArenaError::MathOverflow)?;
    let payout = pot.checked_sub(rake).ok_or(ArenaError::MathOverflow)?;

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

    ctx.accounts.match_account.status = MatchStatus::Settled;
    Ok(())
}
