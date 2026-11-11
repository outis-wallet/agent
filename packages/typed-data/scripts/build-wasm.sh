#!/usr/bin/env bash
# Builds the outis-typed-data crate (crates/typed-data) for the browser and Node (wasm-bindgen,
# `--target web`, with its `wasm` feature) into pkg/, which this package loads. Needs the
# wasm32-unknown-unknown target (`rustup target add wasm32-unknown-unknown`) and wasm-pack
# (`cargo install wasm-pack`).
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(pwd)/pkg"
# One codegen unit keeps the module small without the slowdown of opt-level s/z.
CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 wasm-pack build ../../crates/typed-data --target web --release --no-pack \
  --out-dir "$out" --out-name typed_data -- --features wasm
rm -f "$out/.gitignore"
ls -l "$out/typed_data_bg.wasm" | awk '{ print $5 " bytes: " $9 }'
