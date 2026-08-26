pub mod errors;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
pub use instructions::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod arena {
    use super::*;

    pub fn create_match(
        ctx: Context<CreateMatch>,
        entry_fee: u64,
        max_players: u8,
        rake_bps: u16,
        nonce: u64,
    ) -> Result<()> {
        instructions::create_match::handler(ctx, entry_fee, max_players, rake_bps, nonce)
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

    /// Refunds every staker and closes the match. Authority-only. Accepts an
    /// `Open` match at any time, and an `InProgress` one only after
    /// `MATCH_TIMEOUT_SECS` -- the recovery path for a filled match whose
    /// server died before settling, which is otherwise unrecoverable.
    /// Ported from the OpenFrontIO copy of this program during the engine pivot.
    pub fn cancel_match<'info>(
        ctx: Context<'_, '_, '_, 'info, CancelMatch<'info>>,
    ) -> Result<()> {
        instructions::cancel_match::handler(ctx)
    }
}
