pub mod cancel_match;
pub mod create_match;
pub mod join_match;
pub mod settle_match;

// Glob re-exports (rather than naming the Accounts structs individually) so the
// `__client_accounts_*` modules that #[derive(Accounts)] generates also reach the
// crate root, where #[program] expects to find them.
pub use cancel_match::*;
pub use create_match::*;
pub use join_match::*;
pub use settle_match::*;
