pub mod errors;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
pub use instructions::*;

// The address this program is deployed at, which must equal the pubkey of
// target/deploy/arena-keypair.json -- the runtime rejects any transaction
// with DeclaredProgramIdMismatch otherwise. It was Anchor's placeholder
// (Fg6PaFpo...) until the first real deploy needed it to be true.
declare_id!("4CGRLB5WJ4LK4nqwhzN5uhU78cakuHzG5wfrUZrQ2G64");

#[program]
pub mod arena {
    use super::*;

    /// `treasury` is the token account the rake will be paid into, fixed here so
    /// `settle_match` cannot be handed a different one. Pass `Pubkey::default()`
    /// when `rake_bps` is 0; anything else is refused.
    pub fn create_match(
        ctx: Context<CreateMatch>,
        entry_fee: u64,
        max_players: u8,
        rake_bps: u16,
        nonce: u64,
        treasury: Pubkey,
    ) -> Result<()> {
        instructions::create_match::handler(ctx, entry_fee, max_players, rake_bps, nonce, treasury)
    }

    pub fn join_match(ctx: Context<JoinMatch>) -> Result<()> {
        instructions::join_match::handler(ctx)
    }

    pub fn settle_match(
        ctx: Context<SettleMatch>,
        winner: Pubkey,
        scores: Vec<u64>,
    ) -> Result<()> {
        instructions::settle_match::handler(ctx, winner, scores)
    }

    /// Refunds every staker and marks the match `Cancelled`. Authority-only.
    /// Accepts an `Open` match at any time, and an `InProgress` one only after
    /// `MATCH_TIMEOUT_SECS` -- the recovery path for a filled match whose
    /// server died before settling, which is otherwise unrecoverable.
    /// Ported from the OpenFrontIO copy of this program during the engine pivot.
    ///
    /// It does not close anything; `close_match` reclaims the rent afterwards.
    pub fn cancel_match<'info>(
        ctx: Context<'_, '_, '_, 'info, CancelMatch<'info>>,
    ) -> Result<()> {
        instructions::cancel_match::handler(ctx)
    }

    /// Closes a `Settled` or `Cancelled` match and its (empty) vault, returning
    /// both rents to the authority. Authority-only. Without this every match
    /// ever created stays on chain for the life of the key, holding its rent
    /// and growing the recovery sweeper's scan.
    pub fn close_match(ctx: Context<CloseMatch>) -> Result<()> {
        instructions::close_match::handler(ctx)
    }
}
