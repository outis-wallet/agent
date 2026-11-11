//! SNIP-12 typed data as starknet.js hashes it (`typed_data`), and the felts it is given in hex
//! (`felt`). Outis's wallet core and the agent's library both hash with this crate, so that what a
//! session or a message hashes to is read one way everywhere. `wasm` is the browser and Node build
//! (`--features wasm`, packages/typed-data in this repository).

pub mod felt;
pub mod typed_data;
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
mod wasm;

pub use starknet_crypto::Felt;

/// A Cairo short string (up to 31 ASCII characters) as a felt.
pub(crate) fn short_string(text: &str) -> Felt {
    debug_assert!(text.len() <= 31 && text.is_ascii());
    Felt::from_bytes_be_slice(text.as_bytes())
}
