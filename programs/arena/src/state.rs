use anchor_lang::prelude::*;

pub const MAX_PLAYERS: usize = 16;

/// How long after `created_at` an `InProgress` match may be force-cancelled.
///
/// Exists because `settle_match` accepts only `InProgress` and `cancel_match`
/// accepted only `Open`, which left a filled match whose server died with no
/// on-chain path out at all -- the pot was locked forever. Hosting means
/// restarts, so that is an operational certainty rather than an edge case.
///
/// 24h is deliberately far longer than any real match (an OpenFront game runs
/// well under an hour), so this can only fire on a genuine orphan and never
/// races a slow-but-live settlement.
#[constant]
pub const MATCH_TIMEOUT_SECS: i64 = 24 * 60 * 60;

#[account]
pub struct MatchAccount {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub entry_fee: u64,
    pub rake_bps: u16,
    pub max_players: u8,
    pub player_count: u8,
    pub status: MatchStatus,
    pub players: [Pubkey; MAX_PLAYERS],
    pub stakes: [u64; MAX_PLAYERS],
    pub created_at: i64,
    pub nonce: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum MatchStatus {
    Open,
    InProgress,
    Settled,
    Cancelled,
}

impl MatchAccount {
    pub const SPACE: usize = 8   // discriminator
        + 32  // authority
        + 32  // mint
        + 32  // vault
        + 8   // entry_fee
        + 2   // rake_bps
        + 1   // max_players
        + 1   // player_count
        + 1   // status (enum)
        + 32 * MAX_PLAYERS
        + 8 * MAX_PLAYERS
        + 8   // created_at
        + 8   // nonce
        + 1;  // bump
}
