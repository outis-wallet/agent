//! Felts given as JSON hex strings, read strictly: what a hash is computed over is the number the
//! text says, never one reduced or guessed.

use starknet_crypto::Felt;

/// What reading a value given as JSON refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseError(pub String);

/// A felt given as a hex string ("0x…"), below the field's prime.
pub fn parse_felt(value: &serde_json::Value) -> Result<Felt, ParseError> {
    let text = value.as_str().ok_or_else(|| ParseError(format!("{value} is not a hex string")))?;
    let digits = text.strip_prefix("0x").filter(|digits| !digits.is_empty() && digits.len() <= 64 && digits.chars().all(|c| c.is_ascii_hexdigit()));
    let digits = digits.ok_or_else(|| ParseError(format!("{text} is not a hex string")))?;
    let mut bytes = [0u8; 32];
    let padded = format!("{digits:0>64}");
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&padded[index * 2..index * 2 + 2], 16).expect("hex digits");
    }
    // At or above the prime, from_bytes_be would reduce it: refused instead.
    let felt = Felt::from_bytes_be(&bytes);
    if felt.to_bytes_be() != bytes {
        return Err(ParseError(format!("{text} is not a felt")));
    }
    Ok(felt)
}
