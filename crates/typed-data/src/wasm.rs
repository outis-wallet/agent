//! The crate as a WebAssembly module (wasm-bindgen; `--features wasm`, built by
//! packages/typed-data/scripts/build-wasm.sh into `@outis-wallet/typed-data`). JSON text crosses the
//! boundary: a refusal is a thrown error, never a panic. The same functions, by the same code, are
//! what Outis's wallet core exports from its own module.

use serde_json::Value;
use wasm_bindgen::prelude::*;

use crate::felt::parse_felt;
use crate::typed_data::{self, message_hash, Revision};
use crate::Felt;

fn felt(hex: &str) -> Result<Felt, JsError> {
    parse_felt(&Value::String(hex.to_owned())).map_err(|error| JsError::new(&error.0))
}

fn json(text: &str) -> Result<Value, JsError> {
    serde_json::from_str(text).map_err(|error| JsError::new(&error.to_string()))
}

fn revision(text: &str) -> Result<Revision, JsError> {
    Revision::parse(text).map_err(|error| JsError::new(&error.0))
}

fn hex(felt: Felt) -> String {
    format!("{felt:#x}")
}

fn refused(error: typed_data::TypedDataError) -> JsError {
    JsError::new(&error.0)
}

/// The hash `account` (hex) signs for the typed data `json`, in hex; an error for what isn't typed
/// data starknet.js would hash, or what Outis refuses (a name with a separator in it).
#[wasm_bindgen]
pub fn typed_data_hash(json: &str, account: &str) -> Result<String, JsError> {
    let hash = message_hash(&self::json(json)?, felt(account)?).map_err(refused)?;
    Ok(hex(hash))
}

/// The revision the typed data `json` is hashed under, "0" or "1", as starknet.js decides it; an
/// error for a message starknet.js wouldn't hash at all.
#[wasm_bindgen]
pub fn typed_data_revision(json: &str) -> Result<String, JsError> {
    Ok(typed_data::revision(&self::json(json)?).map_err(refused)?.as_str().to_owned())
}

/// The felt the value `json` is hashed as where a scalar `kind` goes (felt, shortstring, u128,
/// ContractAddress, selector and the like) under `revision` ("0" or "1"): what a message's field is
/// shown as. An error where starknet.js wouldn't hash it, or the kind isn't a scalar.
#[wasm_bindgen]
pub fn scalar(json: &str, kind: &str, revision: &str) -> Result<String, JsError> {
    Ok(hex(typed_data::scalar(&self::json(json)?, kind, self::revision(revision)?).map_err(refused)?))
}

/// starknet.js's `getStructHash`: `data` (JSON) hashed as the struct `name` among `types` (JSON)
/// under `revision`, in hex. The types are read as a message's are: a name with a separator in it is
/// refused, as a message of those types would be.
#[wasm_bindgen]
pub fn struct_hash(types: &str, name: &str, data: &str, revision: &str) -> Result<String, JsError> {
    Ok(hex(typed_data::struct_hash(&json(types)?, name, &json(data)?, self::revision(revision)?).map_err(refused)?))
}

/// starknet.js's `getTypeHash`: the hash of the type `name`'s encoding among `types` (JSON) under
/// `revision`, in hex; the types read as `struct_hash` reads them.
#[wasm_bindgen]
pub fn type_hash(types: &str, name: &str, revision: &str) -> Result<String, JsError> {
    Ok(hex(typed_data::type_hash(&json(types)?, name, self::revision(revision)?).map_err(refused)?))
}

/// starknet.js's `encodeData`'s values: the type hash of `name`, then each of its fields of `data`
/// encoded, as a JSON list of hex.
#[wasm_bindgen]
pub fn struct_values(types: &str, name: &str, data: &str, revision: &str) -> Result<String, JsError> {
    let values = typed_data::struct_values(&json(types)?, name, &json(data)?, self::revision(revision)?).map_err(refused)?;
    Ok(Value::Array(values.into_iter().map(|felt| Value::String(hex(felt))).collect()).to_string())
}

/// starknet.js's `encodeValue` outside any struct: the value `json` encoded as `kind` among `types`
/// (a struct of theirs, a list, a string, a scalar) under `revision`, in hex.
#[wasm_bindgen]
pub fn encode_value(types: &str, kind: &str, json: &str, revision: &str) -> Result<String, JsError> {
    Ok(hex(typed_data::encode_value(&self::json(types)?, kind, &self::json(json)?, self::revision(revision)?).map_err(refused)?))
}
