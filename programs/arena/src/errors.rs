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
    #[msg("Unauthorized")]
    Unauthorized,
    // Append only. Anchor numbers these positionally from 6000, so inserting a
    // variant above silently renumbers every error after it -- including ones
    // the TypeScript side matches on.
    #[msg("Match has not been in progress long enough to be force-cancelled")]
    MatchNotTimedOut,
    #[msg("Winner token account is not owned by the winner")]
    WinnerTokenOwnerMismatch,
    #[msg("Refund account does not belong to the staker it is paired with")]
    InvalidRefundAccount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Vault still holds tokens")]
    VaultNotEmpty,
    #[msg("Match is not in a terminal state")]
    MatchNotTerminal,
}
