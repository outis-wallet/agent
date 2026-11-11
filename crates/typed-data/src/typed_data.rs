//! SNIP-12 typed data (revisions 0 and 1): the hash an account signs for a message, as
//! starknet.js's `getMessageHash` computes it.
//!
//! It follows starknet.js step by step rather than the SNIP-12 text, as starknet.js is what wallets
//! hash with and what sites test against: a string that reads as a number is that number
//! (`"1"` is 1, not the short string "1"), a hex `selector` is taken as it is, a merkle tree of one
//! leaf has that leaf as its root, an enum variant without fields hashes as `[index, 0]`.
//! starknet-rs (`starknet-core` 0.16) differs on the last two that matter here, hex selectors (every
//! outside execution has them) and one-leaf trees (a session allowing one method, which the account
//! verifies as starknet.js hashes it), so it isn't used.
//!
//! Anything starknet.js would read some other way, or fail on, is refused: every reader built on
//! this crate gives the same hash as starknet.js or none, never another. tests/vectors.json holds
//! starknet.js's hashes.

use std::collections::{HashMap, HashSet};

use num_bigint::BigInt;
use num_traits::{One, Signed, Zero};
use serde_json::{Map, Value};
use sha3::{Digest, Keccak256};
use starknet_crypto::{pedersen_hash, poseidon_hash, poseidon_hash_many, Felt};

use crate::short_string;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TypedDataError(pub String);

fn refuse<T>(why: impl Into<String>) -> Result<T, TypedDataError> {
    Err(TypedDataError(why.into()))
}

/// Revision 0 hashes with Pedersen, 1 with Poseidon and knows more types.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Revision {
    Legacy,
    Active,
}

impl Revision {
    /// A revision as starknet.js names it, "0" or "1".
    pub fn parse(text: &str) -> Result<Revision, TypedDataError> {
        match text {
            "0" => Ok(Revision::Legacy),
            "1" => Ok(Revision::Active),
            _ => refuse(format!("{text:?} is not a revision")),
        }
    }

    /// As starknet.js names it: "0" or "1".
    pub fn as_str(self) -> &'static str {
        match self {
            Revision::Legacy => "0",
            Revision::Active => "1",
        }
    }

    /// The domain's type: `StarknetDomain` in revision 1, `StarkNetDomain` in revision 0.
    pub fn domain_type(self) -> &'static str {
        match self {
            Revision::Active => "StarknetDomain",
            Revision::Legacy => "StarkNetDomain",
        }
    }

    fn hash(self, elements: &[Felt]) -> Felt {
        match self {
            Revision::Active => poseidon_hash_many(elements),
            Revision::Legacy => {
                let chained = elements.iter().fold(Felt::ZERO, |hash, element| pedersen_hash(&hash, element));
                pedersen_hash(&chained, &Felt::from(elements.len() as u64))
            }
        }
    }

    /// A merkle tree's pair, the smaller first.
    fn hash_pair(self, a: Felt, b: Felt) -> Felt {
        let (low, high) = if a.to_bytes_be() <= b.to_bytes_be() { (a, b) } else { (b, a) };
        match self {
            Revision::Active => poseidon_hash(low, high),
            Revision::Legacy => pedersen_hash(&low, &high),
        }
    }

    fn escape(self, text: &str) -> String {
        match self {
            Revision::Active => format!("\"{text}\""),
            Revision::Legacy => text.to_owned(),
        }
    }
}

#[derive(Clone, Debug)]
struct Field {
    name: String,
    kind: String,
    contains: Option<String>,
}

type Types = HashMap<String, Vec<Field>>;

/// Which types a value is encoded against: the message's, or revision 1's presets inside a preset.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    Message,
    Presets,
}

/// Deeper than any message a site sends: refused rather than risk the stack.
const MAX_DEPTH: usize = 32;

/// The field's prime: values at or above it can't be hashed.
fn prime() -> BigInt {
    (BigInt::one() << 251) + BigInt::from(17) * (BigInt::one() << 192) + BigInt::one()
}

fn felt_of(value: &BigInt) -> Result<Felt, TypedDataError> {
    if value.is_negative() || *value >= prime() {
        return refuse(format!("{value} is not a felt"));
    }
    Ok(Felt::from_bytes_be_slice(&value.to_bytes_be().1))
}

/// What JavaScript's `BigInt(value)` makes of a JSON value.
enum JsInt<'a> {
    Int(BigInt),
    /// A string `BigInt` refuses, which starknet.js then reads as a short string where it can.
    NotNumeric(&'a str),
    /// What this core doesn't read the way JavaScript would, or JavaScript refuses outright.
    Invalid,
}

const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

fn js_int(value: &Value) -> JsInt<'_> {
    match value {
        Value::Bool(flag) => JsInt::Int(BigInt::from(*flag as u8)),
        Value::Number(number) => {
            // Beyond 2^53 a JSON number isn't read exactly by JavaScript.
            if let Some(int) = number.as_i64() {
                if int.abs() <= MAX_SAFE_INTEGER {
                    return JsInt::Int(BigInt::from(int));
                }
            } else if let Some(float) = number.as_f64() {
                if float.fract() == 0.0 && float.abs() <= MAX_SAFE_INTEGER as f64 {
                    return JsInt::Int(BigInt::from(float as i64));
                }
            }
            JsInt::Invalid
        }
        Value::String(text) => js_int_of_string(text),
        // A list: JavaScript's BigInt takes it as its string, the items joined by commas, each as
        // JavaScript writes it (nothing for null, a nested list's items), so `["0x5"]` is 5 and `[]`
        // is 0 (starknet.js hashes a name written as a list as the name). One that doesn't read as a
        // number isn't text either, which starknet.js refuses: refused.
        Value::Array(items) => match js_string_of_list(items) {
            Some(text) => match js_int_of_string(&text) {
                JsInt::Int(int) => JsInt::Int(int),
                _ => JsInt::Invalid,
            },
            None => JsInt::Invalid,
        },
        _ => JsInt::Invalid,
    }
}

/// `String(list)` as JavaScript writes it, where every item is text, a whole number, null or such a
/// list; None for an item JavaScript would write some other way (a boolean, a fraction, an object),
/// which `BigInt` refuses in any case.
fn js_string_of_list(items: &[Value]) -> Option<String> {
    let mut parts = Vec::with_capacity(items.len());
    for item in items {
        parts.push(match item {
            Value::Null => String::new(),
            Value::String(text) => text.clone(),
            Value::Number(number) => match number.as_i64() {
                Some(int) if int.abs() <= MAX_SAFE_INTEGER => int.to_string(),
                _ => return None,
            },
            Value::Array(inner) => js_string_of_list(inner)?,
            _ => return None,
        });
    }
    Some(parts.join(","))
}

/// What JavaScript's `BigInt(string)` trims off both ends (StrWhiteSpaceChar): its white space (the
/// Unicode space separators, tab, vertical tab, form feed, the byte order mark) and line terminators
/// (line feed, carriage return, the line and paragraph separators). Not the next line character
/// (U+0085), which Rust counts as white space and JavaScript doesn't.
fn js_trims(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// JavaScript's `BigInt(string)`: decimal with an optional sign, or 0x, 0o, 0b without one, with
/// white space around it trimmed as JavaScript trims it, and "" is 0.
fn js_int_of_string(text: &str) -> JsInt<'_> {
    let untrimmed = text;
    let text = text.trim_matches(js_trims);
    if text.is_empty() {
        return JsInt::Int(BigInt::zero());
    }
    let radix = |prefix: &[&str], radix: u32| {
        prefix
            .iter()
            .find_map(|p| text.strip_prefix(p))
            .map(|digits| (!digits.is_empty() && digits.chars().all(|c| c.is_digit(radix))).then(|| BigInt::parse_bytes(digits.as_bytes(), radix)).flatten())
    };
    for (prefix, base) in [(&["0x", "0X"][..], 16), (&["0o", "0O"][..], 8), (&["0b", "0B"][..], 2)] {
        if let Some(parsed) = radix(prefix, base) {
            return parsed.map_or(JsInt::NotNumeric(untrimmed), JsInt::Int);
        }
    }
    let (negative, digits) = match text.as_bytes()[0] {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return JsInt::NotNumeric(untrimmed);
    }
    let magnitude = BigInt::parse_bytes(digits.as_bytes(), 10).expect("decimal digits");
    JsInt::Int(if negative { -magnitude } else { magnitude })
}

/// A Cairo short string: ASCII, 31 characters at most, as starknet.js's `encodeShortString` writes
/// it: each character's code in hex, unpadded (a control character below 0x10 is one digit, so the
/// felt isn't the bytes' felt), and its `.` leaves a line feed or carriage return unencoded, so that
/// the result isn't hex and the value is refused: refused here too.
fn encode_short_string(text: &str) -> Result<Felt, TypedDataError> {
    if !text.is_ascii() || text.len() > 31 || text.contains(['\n', '\r']) {
        return refuse(format!("{text:?} is not a short string"));
    }
    let hex: String = text.chars().map(|c| format!("{:x}", c as u32)).collect();
    if hex.is_empty() {
        return Ok(Felt::ZERO);
    }
    Felt::from_hex(&format!("0x{hex}")).map_err(|_| TypedDataError(format!("{text:?} is not a short string")))
}

/// starknet.js's `getHex`: a number as itself, any other string as a short string.
fn get_hex(value: &Value) -> Result<Felt, TypedDataError> {
    match js_int(value) {
        JsInt::Int(int) => felt_of(&int),
        JsInt::NotNumeric(text) => encode_short_string(text),
        JsInt::Invalid => refuse(format!("{value} is not a value")),
    }
}

/// A number within `[low, high]`, as starknet.js's range checks read it.
fn int_in(value: &Value, low: &BigInt, high: &BigInt, kind: &str) -> Result<BigInt, TypedDataError> {
    match js_int(value) {
        JsInt::Int(int) if &int >= low && &int <= high => Ok(int),
        _ => refuse(format!("{value} is not a {kind}")),
    }
}

/// The Starknet keccak: keccak-256, its top 6 bits dropped.
fn starknet_keccak(bytes: &[u8]) -> Felt {
    let mut hash: [u8; 32] = Keccak256::digest(bytes).into();
    hash[0] &= 0x03;
    Felt::from_bytes_be(&hash)
}

fn is_tuple(kind: &str) -> bool {
    kind.len() >= 2 && kind.starts_with('(') && kind.ends_with(')')
}

fn presets() -> Types {
    let field = |name: &str, kind: &str| Field { name: name.into(), kind: kind.into(), contains: None };
    HashMap::from([
        ("u256".into(), vec![field("low", "u128"), field("high", "u128")]),
        ("TokenAmount".into(), vec![field("token_address", "ContractAddress"), field("amount", "u256")]),
        ("NftId".into(), vec![field("collection_address", "ContractAddress"), field("token_id", "u256")]),
    ])
}

fn parse_types(value: &Value) -> Result<Types, TypedDataError> {
    let Value::Object(types) = value else { return refuse("types is not an object") };
    let text = |value: &Value| match value {
        Value::String(text) if !text.chars().any(char::is_control) => Ok(text.clone()),
        _ => refuse(format!("{value} is not a type's name")),
    };
    // A type's or a field's name holding the separators of an encoded type (`"`, `(`, `)`, `,`,
    // `:`) can be read two ways: starknet.js doesn't escape them, so a field named for the rest of
    // a type hashes as that type would, with other values under other names (Bramble's finding;
    // Outis's own message reading refuses the same). No real message
    // needs one. A field's type keeps them: `Call*`, `(felt,felt)`.
    let two_ways = |name: &str| name.chars().any(|c| matches!(c, '"' | '(' | ')' | ',' | ':'));
    let plain = |value: &Value| {
        let name = text(value)?;
        if two_ways(&name) {
            return refuse(format!("{name:?} has a separator in it"));
        }
        Ok(name)
    };
    types
        .iter()
        .map(|(name, fields)| {
            let Value::Array(fields) = fields else { return refuse(format!("{name} is not a list of fields")) };
            let fields = fields
                .iter()
                .map(|field| {
                    let contains = match field.get("contains") {
                        None | Some(Value::Null) => None,
                        Some(contains) => Some(text(contains)?),
                    };
                    Ok(Field { name: plain(field.get("name").unwrap_or(&Value::Null))?, kind: text(field.get("type").unwrap_or(&Value::Null))?, contains })
                })
                .collect::<Result<Vec<_>, _>>()?;
            if name.chars().any(char::is_control) {
                return refuse("a type's name has a control character");
            }
            if two_ways(name) {
                return refuse(format!("the type {name:?} has a separator in its name"));
            }
            Ok((name.clone(), fields))
        })
        .collect()
}

struct Encoder {
    types: Types,
    presets: Types,
    revision: Revision,
}

impl Encoder {
    fn scope(&self, scope: Scope) -> &Types {
        match scope {
            Scope::Message => &self.types,
            Scope::Presets => &self.presets,
        }
    }

    /// The types a field refers to, as starknet.js's `getDependencies` finds them.
    fn referenced(&self, field: &Field) -> Vec<String> {
        let kind = &field.kind;
        if let Some(element) = kind.strip_suffix('*') {
            return vec![element.to_owned()];
        }
        if self.revision == Revision::Active {
            if kind == "enum" {
                return field.contains.iter().cloned().collect();
            }
            if is_tuple(kind) {
                return kind[1..kind.len() - 1].split(',').map(|part| part.strip_suffix('*').unwrap_or(part).to_owned()).collect();
            }
        }
        vec![kind.clone()]
    }

    /// starknet.js's `encodeType`: the type, then every type it reaches, sorted. A type that reaches
    /// itself sends starknet.js into endless recursion, so it is refused here.
    fn encode_type(&self, scope: Scope, name: &str) -> Result<String, TypedDataError> {
        let mut all = self.scope(scope).clone();
        if self.revision == Revision::Active {
            all.extend(self.presets.clone());
        }
        if !all.contains_key(name) {
            return Ok(String::new());
        }
        let mut reached = Vec::new();
        let mut done = HashSet::new();
        self.reach(&all, name, &mut vec![name.to_owned()], &mut done, &mut reached)?;
        // JavaScript's default sort: by UTF-16 code units.
        reached.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let esc = |text: &str| self.revision.escape(text);
        let mut encoded = String::new();
        for name in std::iter::once(name.to_owned()).chain(reached) {
            let fields = all[&name]
                .iter()
                .map(|field| {
                    let target = if field.kind == "enum" && self.revision == Revision::Active {
                        field.contains.clone().ok_or_else(|| TypedDataError(format!("{} has no enum type", field.name)))?
                    } else {
                        field.kind.clone()
                    };
                    let kind = if is_tuple(&target) {
                        let parts: Vec<String> = target[1..target.len() - 1].split(',').map(|part| if part.is_empty() { String::new() } else { esc(part) }).collect();
                        format!("({})", parts.join(","))
                    } else {
                        esc(&target)
                    };
                    Ok(format!("{}:{}", esc(&field.name), kind))
                })
                .collect::<Result<Vec<_>, TypedDataError>>()?;
            encoded.push_str(&format!("{}({})", esc(&name), fields.join(",")));
        }
        Ok(encoded)
    }

    fn reach(&self, all: &Types, name: &str, path: &mut Vec<String>, done: &mut HashSet<String>, reached: &mut Vec<String>) -> Result<(), TypedDataError> {
        for field in &all[name] {
            for referenced in self.referenced(field) {
                if !all.contains_key(&referenced) {
                    continue;
                }
                if path.contains(&referenced) {
                    return refuse(format!("{referenced} refers to itself"));
                }
                if !done.insert(referenced.clone()) {
                    continue;
                }
                reached.push(referenced.clone());
                path.push(referenced.clone());
                self.reach(all, &referenced, path, done, reached)?;
                path.pop();
            }
        }
        Ok(())
    }

    fn type_hash(&self, scope: Scope, name: &str) -> Result<Felt, TypedDataError> {
        Ok(starknet_keccak(self.encode_type(scope, name)?.as_bytes()))
    }

    /// starknet.js's `encodeData`'s values: the type hash of `name`, then each of its fields' encoding of `data`.
    fn struct_values(&self, scope: Scope, name: &str, data: &Value, depth: usize) -> Result<Vec<Felt>, TypedDataError> {
        let fields = match self.scope(scope).get(name) {
            Some(fields) => fields,
            None if self.revision == Revision::Active => self.presets.get(name).ok_or_else(|| TypedDataError(format!("no type {name}")))?,
            None => return refuse(format!("no type {name}")),
        };
        let Value::Object(data) = data else { return refuse(format!("{name} is not an object")) };
        let mut values = vec![self.type_hash(scope, name)?];
        for field in fields {
            match data.get(&field.name) {
                None | Some(Value::Null) => return refuse(format!("{name} has no {}", field.name)),
                Some(value) => values.push(self.encode_value(scope, &field.kind, value, Some((name, &field.name)), depth + 1)?),
            }
        }
        Ok(values)
    }

    fn struct_hash(&self, scope: Scope, name: &str, data: &Value, depth: usize) -> Result<Felt, TypedDataError> {
        Ok(self.revision.hash(&self.struct_values(scope, name, data, depth)?))
    }

    fn encode_value(&self, scope: Scope, kind: &str, value: &Value, context: Option<(&str, &str)>, depth: usize) -> Result<Felt, TypedDataError> {
        if depth > MAX_DEPTH {
            return refuse("nested too deep");
        }
        let active = self.revision == Revision::Active;
        if self.scope(scope).contains_key(kind) {
            return self.struct_hash(scope, kind, value, depth);
        }
        if active && self.presets.contains_key(kind) {
            return self.struct_hash(Scope::Presets, kind, value, depth);
        }
        if let Some(element) = kind.strip_suffix('*') {
            let Value::Array(elements) = value else { return refuse(format!("{kind} is not a list")) };
            let hashes = elements.iter().map(|each| self.encode_value(scope, element, each, None, depth + 1)).collect::<Result<Vec<_>, _>>()?;
            return Ok(self.revision.hash(&hashes));
        }
        match kind {
            "enum" if active => self.encode_enum(scope, value, context, depth),
            "merkletree" => self.encode_merkle_tree(scope, value, context, depth),
            "selector" => {
                let Value::String(text) = value else { return refuse("a selector is not a string") };
                match text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
                    Some(digits) if digits.chars().all(|c| c.is_ascii_hexdigit()) => {
                        if digits.is_empty() {
                            return refuse("an empty selector");
                        }
                        felt_of(&BigInt::parse_bytes(digits.as_bytes(), 16).expect("hex digits"))
                    }
                    _ => Ok(starknet_keccak(text.as_bytes())),
                }
            }
            "string" if active => {
                let Value::String(text) = value else { return refuse("a string is not a string") };
                if !text.is_ascii() {
                    return refuse("a string that isn't ASCII");
                }
                let mut words: Vec<Felt> = text.as_bytes().chunks(31).map(Felt::from_bytes_be_slice).collect();
                let pending_len = text.len() % 31;
                let pending = if pending_len == 0 { Felt::ZERO } else { words.pop().expect("a pending word") };
                let mut elements = vec![Felt::from(words.len() as u64)];
                elements.extend(words);
                elements.extend([pending, Felt::from(pending_len as u64)]);
                Ok(self.revision.hash(&elements))
            }
            "i128" if active => {
                let half = BigInt::one() << 127u32;
                let int = int_in(value, &-half.clone(), &(half - 1), kind)?;
                felt_of(&if int.is_negative() { prime() + int } else { int })
            }
            "u128" | "timestamp" if active => felt_of(&int_in(value, &BigInt::zero(), &((BigInt::one() << 128) - 1), kind)?),
            "ContractAddress" | "ClassHash" if active => felt_of(&int_in(value, &BigInt::zero(), &(prime() - 1), kind)?),
            "bool" if active => match value {
                Value::Bool(flag) => Ok(Felt::from(*flag as u8)),
                _ => refuse("a bool is not a boolean"),
            },
            "felt" | "shortstring" => get_hex(value),
            _ if active => refuse(format!("unknown type {kind}")),
            // Revision 0 reads every other value as starknet.js's getHex does.
            _ => get_hex(value),
        }
    }

    fn encode_enum(&self, scope: Scope, value: &Value, context: Option<(&str, &str)>, depth: usize) -> Result<Felt, TypedDataError> {
        let field = self.context_field(scope, context)?;
        let enum_name = field.contains.as_ref().ok_or_else(|| TypedDataError("an enum without its type".into()))?;
        let variants = self.scope(scope).get(enum_name).ok_or_else(|| TypedDataError(format!("no enum {enum_name}")))?;
        // One variant, by name. JavaScript orders an object's keys its own way; one key leaves no doubt.
        let Value::Object(chosen) = value else { return refuse("an enum is not an object") };
        let (Some((variant_name, data)), 1) = (chosen.iter().next(), chosen.len()) else { return refuse("an enum names one variant") };
        let index = variants.iter().position(|variant| &variant.name == variant_name).ok_or_else(|| TypedDataError(format!("no variant {variant_name}")))?;
        let kind = &variants[index].kind;
        if !is_tuple(kind) {
            return refuse(format!("variant {variant_name} is not a tuple"));
        }
        let mut elements = vec![Felt::from(index as u64)];
        for (position, part) in kind[1..kind.len() - 1].split(',').enumerate() {
            // An empty part (a variant without fields) is hashed as 0, as starknet.js does.
            if part.is_empty() {
                elements.push(Felt::ZERO);
                continue;
            }
            let Some(element) = data.as_array().and_then(|data| data.get(position)) else { return refuse(format!("variant {variant_name} lacks a value")) };
            elements.push(self.encode_value(scope, part, element, None, depth + 1)?);
        }
        Ok(self.revision.hash(&elements))
    }

    fn encode_merkle_tree(&self, scope: Scope, value: &Value, context: Option<(&str, &str)>, depth: usize) -> Result<Felt, TypedDataError> {
        // Outside a struct (in a list, say), starknet.js takes the leaves as "raw".
        let leaf = match context {
            None => "raw".to_owned(),
            Some(_) => {
                let field = self.context_field(scope, context)?;
                match &field.contains {
                    Some(contains) if field.kind == "merkletree" && !contains.ends_with('*') => contains.clone(),
                    _ => return refuse("a merkle tree without its leaves' type"),
                }
            }
        };
        let Value::Array(leaves) = value else { return refuse("a merkle tree is not a list") };
        // starknet.js never finishes an empty tree.
        if leaves.is_empty() {
            return refuse("an empty merkle tree");
        }
        let mut layer = leaves.iter().map(|each| self.encode_value(scope, &leaf, each, None, depth + 1)).collect::<Result<Vec<_>, _>>()?;
        while layer.len() > 1 {
            layer = layer.chunks(2).map(|pair| self.revision.hash_pair(pair[0], pair.get(1).copied().unwrap_or(Felt::ZERO))).collect();
        }
        Ok(layer[0])
    }

    fn context_field(&self, scope: Scope, context: Option<(&str, &str)>) -> Result<&Field, TypedDataError> {
        let (parent, key) = context.ok_or_else(|| TypedDataError("a value that needs its field".into()))?;
        self.scope(scope)
            .get(parent)
            .and_then(|fields| fields.iter().find(|field| field.name == key))
            .ok_or_else(|| TypedDataError(format!("no field {key} in {parent}")))
    }
}

/// The revision starknet.js reads: 1 where the domain type is `StarknetDomain` and its revision is
/// "1" or 1, 0 where it is `StarkNetDomain` and the revision is "0" or missing.
fn revision_of(types: &Map<String, Value>, domain: &Map<String, Value>) -> Result<Revision, TypedDataError> {
    let revision = domain.get("revision").filter(|value| !value.is_null());
    let reads = |text: &str| match revision {
        Some(Value::String(value)) => value == text,
        Some(Value::Number(value)) => value.to_string() == text,
        _ => false,
    };
    if types.contains_key("StarknetDomain") && reads("1") {
        return Ok(Revision::Active);
    }
    if types.contains_key("StarkNetDomain") && (revision.is_none() || matches!(revision, Some(Value::String(value)) if value == "0")) {
        return Ok(Revision::Legacy);
    }
    refuse("not a revision 0 or 1 message")
}

/// Whether JavaScript's `BigInt` reads `value` as a number (a hex, decimal, octal or binary string,
/// a number, a list of one): what starknet.js then hashes as that number, where other text would be
/// hashed as a short string.
pub fn reads_as_number(value: &Value) -> bool {
    matches!(js_int(value), JsInt::Int(_))
}

/// The hash `account` signs for typed data.
pub fn message_hash(data: &Value, account: Felt) -> Result<Felt, TypedDataError> {
    let (Some(types_value @ Value::Object(types)), Some(Value::Object(domain)), Some(message @ Value::Object(_)), Some(Value::String(primary))) =
        (data.get("types"), data.get("domain"), data.get("message"), data.get("primaryType"))
    else {
        return refuse("not typed data");
    };
    if primary.is_empty() {
        return refuse("no primary type");
    }
    let revision = revision_of(types, domain)?;
    let encoder = encoder(types_value, revision)?;
    Ok(revision.hash(&[
        short_string("StarkNet Message"),
        encoder.struct_hash(Scope::Message, revision.domain_type(), &Value::Object(domain.clone()), 0)?,
        account,
        encoder.struct_hash(Scope::Message, primary, message, 0)?,
    ]))
}

/// The encoder of a message's `types` under `revision`, as message_hash builds it: the types parsed
/// (a name with a separator in it refused), and in revision 1 a type named as one of SNIP-12's
/// presets refused. Every hash the core gives of a part of a message (a domain, a struct, a value)
/// comes through here, so that a part is never hashed where the whole would be refused.
fn encoder(types: &Value, revision: Revision) -> Result<Encoder, TypedDataError> {
    let Value::Object(map) = types else { return refuse("types is not an object") };
    let presets = presets();
    if revision == Revision::Active && map.keys().any(|name| presets.contains_key(name)) {
        return refuse("a type named as a preset");
    }
    Ok(Encoder { types: parse_types(types)?, presets, revision })
}

/// starknet.js's `getStructHash`: `data` hashed as the struct `name` among `types`, under `revision`
/// (a session's allowed method or message leaf, the domain hash a session's message signature
/// carries, what a requested kind of message claims).
pub fn struct_hash(types: &Value, name: &str, data: &Value, revision: Revision) -> Result<Felt, TypedDataError> {
    encoder(types, revision)?.struct_hash(Scope::Message, name, data, 0)
}

/// starknet.js's `getTypeHash`: the hash of the type `name`'s encoding among `types`. A type `types`
/// doesn't have encodes as nothing, as starknet.js has it.
pub fn type_hash(types: &Value, name: &str, revision: Revision) -> Result<Felt, TypedDataError> {
    encoder(types, revision)?.type_hash(Scope::Message, name)
}

/// starknet.js's `encodeData`'s values: the type hash of `name`, then each of its fields of `data`
/// encoded, under `revision` (what a session's message signature carries, field by field).
pub fn struct_values(types: &Value, name: &str, data: &Value, revision: Revision) -> Result<Vec<Felt>, TypedDataError> {
    encoder(types, revision)?.struct_values(Scope::Message, name, data, 0)
}

/// starknet.js's `encodeValue` outside any struct: `value` encoded as `kind` among `types` (a struct
/// of theirs, a list, a string, a scalar). An enum or a merkle tree is read by its field, which it
/// has none of here: refused.
pub fn encode_value(types: &Value, kind: &str, value: &Value, revision: Revision) -> Result<Felt, TypedDataError> {
    encoder(types, revision)?.encode_value(Scope::Message, kind, value, None, 0)
}

/// As `message_hash`, from the JSON a site sends.
pub fn message_hash_json(json: &str, account: Felt) -> Result<Felt, TypedDataError> {
    let data: Value = serde_json::from_str(json).map_err(|error| TypedDataError(error.to_string()))?;
    message_hash(&data, account)
}

/// The revision a message is in, as message_hash reads it.
pub fn revision(data: &Value) -> Result<Revision, TypedDataError> {
    let (Some(Value::Object(types)), Some(Value::Object(domain))) = (data.get("types"), data.get("domain")) else {
        return refuse("not typed data");
    };
    revision_of(types, domain)
}

/// One value of a message as message_hash encodes it, for a scalar `kind` (felt, ContractAddress,
/// selector, u128 and the like): what the decoding of an outside execution reads its calls with, so
/// that what a wallet shows is what it signs.
pub fn scalar(value: &Value, kind: &str, revision: Revision) -> Result<Felt, TypedDataError> {
    if kind.ends_with('*') || matches!(kind, "enum" | "merkletree" | "string") {
        return refuse(format!("{kind} is not a scalar"));
    }
    let encoder = Encoder { types: Types::new(), presets: Types::new(), revision };
    encoder.encode_value(Scope::Message, kind, value, None, 0)
}
