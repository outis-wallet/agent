# Outis agent

AI agents with a Starknet account of their own. A bot that runs commands (Claude Code, OpenClaw,
Hermes, Codex) gets an account the user funds from their [Outis](https://outis.xyz) wallet. It spends
from that account through a session the user approves, within limits the account enforces on-chain.
The bot never holds a key that can do more than its session allows, and never reaches the user's own
accounts.

| Directory | Package | What it is |
| --- | --- | --- |
| [`packages/agent-cli`](packages/agent-cli) | [`@outis-wallet/agent-cli`](https://www.npmjs.com/package/@outis-wallet/agent-cli) | The `outis` command the bot runs, and [SKILL.md](packages/agent-cli/SKILL.md), which teaches it how |
| [`packages/agent`](packages/agent) | `@outis-wallet/agent` | The library: the agent account's address, sessions and their hashes, the link that asks for one, the transactions a session signs |
| [`packages/typed-data`](packages/typed-data) | `@outis-wallet/typed-data` | SNIP-12 hashing by the crate below, in WebAssembly |
| [`crates/typed-data`](crates/typed-data) | `outis-typed-data` (Rust) | SNIP-12 typed data hashed exactly as starknet.js hashes it, refusing what it would read two ways |

Sepolia only for now. Agent accounts are new and unaudited: keep what you put in them small.

## How an agent gets a session

1. The bot runs `outis connect`. The CLI makes a session key, kept on the bot's machine, and prints a
   link (`https://outis.xyz/agent#agent=…`) with what the bot asks for: which actions (send, swap,
   sign), which contract methods, which kinds of message. It also prints a 16-digit code made from the
   key.
2. The user opens the link in the Outis wallet (the Chrome extension) and checks that the code is the
   one the bot shows. The wallet doesn't trust anything in the link: it hashes everything it shows
   again. The user chooses the limits (what the session may spend per token and per period, what it
   may pay in fees, when it ends) and approves.
3. The wallet registers the session on the agent's own account, an Outis account whose owner key the
   wallet derives from the user's recovery phrase. Nothing on-chain links that account to the user's
   others.
4. The CLI finds the registration on-chain by its key (`outis connect --wait`, or `outis sync`). From
   then on the bot signs its own transactions with the session key, and the account checks each
   against the session's limits before it runs.

The user can stop an agent at any time, which revokes its sessions, and sweep what its account holds
back to their own.

## One reading of what is signed

A session is SNIP-12 typed data. The wallet shows the user what a session allows, the agent signs
with it, and the account verifies it. All three must read the same bytes the same way, or the user
approves one thing and the account allows another. So every SNIP-12 hash here comes from one place,
the `outis-typed-data` crate. The Outis wallet hashes with the same crate, and its tests check it
against starknet.js's hashes ([`crates/typed-data/tests/vectors.json`](crates/typed-data/tests/vectors.json)).
`packages/agent/src/core` is a copy of the parts of the wallet's own core that the agent needs,
declaration for declaration.

## Building

Needs Node.js 22, pnpm, Rust with the `wasm32-unknown-unknown` target, and wasm-pack.

```bash
pnpm install
pnpm build:wasm    # crates/typed-data → packages/typed-data/pkg
pnpm test          # the crate's tests, then every package's
pnpm --filter @outis-wallet/agent-cli build
```

## Reporting a security issue

Report it privately through GitHub (Security → Report a vulnerability) rather than in an issue.

## License

[MIT](LICENSE)
