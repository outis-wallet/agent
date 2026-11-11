# outis-typed-data

SNIP-12 typed data (revisions 0 and 1) hashed exactly as starknet.js's `getMessageHash` hashes it,
and refused wherever starknet.js would read it some other way or fail. It also refuses messages that
starknet.js would hash but that can be read two ways: a type or field name with an encoded type's
separators in it. It follows starknet.js step by step rather than the SNIP-12 text, since starknet.js
is what wallets hash with and what sites test against. `tests/vectors.json` holds starknet.js's
answers.

The Outis wallet's core and `@outis-wallet/agent` both hash with this crate, so what an agent signs
and what the wallet shows the user are read the same way. With `--features wasm` it builds the
WebAssembly module that `@outis-wallet/typed-data` loads.

```toml
[dependencies]
outis-typed-data = { git = "https://github.com/outis-wallet/agent", rev = "<commit>" }
```
