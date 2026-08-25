use anchor_lang::prelude::*;

pub const MAX_PLAYERS: usize = 16;

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
