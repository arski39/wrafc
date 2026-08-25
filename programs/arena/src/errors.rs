use anchor_lang::prelude::*;

#[error_code]
pub enum ArenaError {
    #[msg("Match is full")]
    MatchFull,
    #[msg("Match is not open for joining")]
    NotOpen,
    #[msg("Entry fee mismatch")]
    FeeMismatch,
    #[msg("Player already joined")]
    AlreadyJoined,
    #[msg("Invalid server signature over match results")]
    InvalidResultSignature,
    #[msg("Winner not in match")]
    WinnerNotInMatch,
    #[msg("Match already settled")]
    AlreadySettled,
    #[msg("Invalid rake basis points (max 1000 = 10%)")]
    RakeTooHigh,
    #[msg("Vault account does not match match record")]
    InvalidVault,
}
