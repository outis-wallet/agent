//! Checks the crate against starknet.js (tests/vectors.json: starknet.js's hashes, revisions and
//! encoded fields for each message, written by Outis's wallet tests from starknet.js itself). A
//! `refused` vector is one starknet.js hashes and Outis refuses, as a message read two ways.

use outis_typed_data::Felt;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors.json")).unwrap()
}

fn felt(value: &Value) -> Felt {
    Felt::from_hex(value.as_str().unwrap()).unwrap()
}

fn felts(value: &Value) -> Vec<Felt> {
    value.as_array().unwrap().iter().map(felt).collect()
}

#[test]
fn typed_data_hashes() {
    let mut differ = Vec::new();
    for vector in vectors()["typed_data"].as_array().unwrap() {
        let name = vector["name"].as_str().unwrap();
        let json = serde_json::to_string(&vector["data"]).unwrap();
        // A null hash: starknet.js refuses it, and so must the core. `refused`: starknet.js hashes it
        // and Outis refuses it, in the wallet and here alike (a layout read two ways, a separator in
        // a name).
        let expected = (!vector["hash"].is_null() && vector["refused"] != true).then(|| felt(&vector["hash"]));
        match (outis_typed_data::typed_data::message_hash_json(&json, felt(&vector["account"])), expected) {
            (Ok(hash), Some(expected)) if hash == expected => {}
            (Err(_), None) => {}
            (Ok(hash), expected) => differ.push(format!("{name}: {hash:#x}, starknet.js {expected:?}")),
            (Err(error), _) => differ.push(format!("{name}: refused ({})", error.0)),
        }
    }
    assert!(differ.is_empty(), "{differ:#?}");
}

/// The parts of a message read on their own (the agent library's leaves and session
/// signatures, a requested kind's hashes, the card's revision), as starknet.js reads them: the
/// revision, the domain's struct hash, the primary type's hash, and encodeData's values. Where Outis
/// refuses the whole message (`refused`), it refuses every part.
#[test]
fn typed_data_parts() {
    use outis_typed_data::typed_data::{revision, struct_hash, struct_values, type_hash, Revision};
    let mut differ = Vec::new();
    for vector in vectors()["typed_data"].as_array().unwrap() {
        let name = vector["name"].as_str().unwrap();
        // No revision: starknet.js doesn't hash it (typed_data_hashes checks the core refuses it too).
        let Some(expected_revision) = vector["revision"].as_str() else { continue };
        let refused = vector["refused"] == true;
        let data = &vector["data"];
        let primary = data["primaryType"].as_str().unwrap();
        let parts = revision(data).and_then(|revision| {
            let domain = struct_hash(&data["types"], revision.domain_type(), &data["domain"], revision)?;
            let kind = type_hash(&data["types"], primary, revision)?;
            let fields = struct_values(&data["types"], primary, &data["message"], revision)?;
            Ok((revision, domain, kind, fields))
        });
        match (parts, refused) {
            (Ok((revision, domain, kind, fields)), false) => {
                if revision != Revision::parse(expected_revision).unwrap() {
                    differ.push(format!("{name}: revision {}, starknet.js {expected_revision}", revision.as_str()));
                }
                if domain != felt(&vector["domain_hash"]) {
                    differ.push(format!("{name}: domain hash {domain:#x}, starknet.js {}", vector["domain_hash"]));
                }
                if kind != felt(&vector["type_hash"]) {
                    differ.push(format!("{name}: type hash {kind:#x}, starknet.js {}", vector["type_hash"]));
                }
                if fields != felts(&vector["fields"]) {
                    differ.push(format!("{name}: fields {fields:#x?}, starknet.js {}", vector["fields"]));
                }
            }
            (Err(_), true) => {}
            (Ok(_), true) => differ.push(format!("{name}: read, though Outis refuses the message")),
            (Err(error), false) => differ.push(format!("{name}: refused ({})", error.0)),
        }
    }
    assert!(differ.is_empty(), "{differ:#?}");
}
