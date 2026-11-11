---
name: outis
description: Act on Starknet from an Outis agent account, within a budget the user approved. Use when the user wants you to send tokens, call contracts, or sign messages (e.g. to play Surround) with their Outis wallet, or asks what you may spend.
---

# Outis agent account

You have a wallet of your own: a small Outis agent account the user funds, which you drive through a
session they approved in their Outis keychain. The session decides what you can call, how much you can
spend per token and in fees, which messages you can sign, and until when. The limits are enforced
on-chain: you can't go over them, and you never hold a key that can.

Always pass `--json` and read the result: `{"ok": true, ...}`, or
`{"ok": false, "error": {"code", "message", "next"}}`. `next` says what to do.

## First: get a session

```bash
outis status --json
```

If there's no session (`no_session`) or it expired (`session_expired`):

```bash
outis connect --name "<your name>" --ask send,sign --json
```

`--ask` names actions the keychain knows: `send`, `swap`, `sign`. For anything else, ask by name:

```bash
outis connect --name "<your name>" \
  --method 0x04a1…9c2f:play:"to play Foo" \
  --message ./move.json --json
```

`--method <contract>:<entrypoint>[:<why>]` asks for one contract method (never an approval).
`--message <file>` asks to sign messages of the same domain and type as the example typed data in the
file (SNIP-12 revision 1, for this network's chain). Give a method a reason: the user sees it, and decides.

Show the user the `link` and the `fingerprint`. The link opens in their Outis wallet (the extension
where they have it): they check that it shows the same fingerprint, choose what you may do and your
budget, and approve. Then:

```bash
outis connect --wait --json
```

It waits up to 10 minutes for the approval to land on-chain.

## What you may do

```bash
outis budget --json      # spending left per token and for fees, when each resets, the expiry
outis balance --json     # what the account holds
```

Check `budget` before a plan that spends. Your own transactions stop an hour before the session
expires (`transactionsUntil`).

## Acting

```bash
outis send <amount> <token> <recipient> --json   # e.g. send 1.5 STRK 0x123…
outis execute <contract> <entrypoint> [calldata...] --json   # felts; u256:N for a u256
outis call <contract> <entrypoint> [calldata...] --json      # read only
outis tx <hash> --wait --json
```

Tokens are `STRK`, `ETH`, `USDC`… or an address. Amounts are in whole tokens (`1.5`), not base units.

## Signing messages

```bash
outis sign <typed-data.json> --json    # or - to read it from stdin
```

Only SNIP-12 revision 1 messages of the kinds the session allows. The signature is only valid while the
session is, so the CLI refuses when less than a day is left (`--min-life <seconds>` to change that;
`--min-life 0` only for a message checked right away).

## Errors

| code | meaning | what to do |
|------|---------|------------|
| `no_session` | not connected yet | `outis connect` |
| `session_expired` | expired, revoked, or less than an hour left for transactions | `outis connect` for a new one |
| `method_not_allowed` | the session doesn't allow that call or message | ask the user for a session that does |
| `over_budget` | over a spending limit or the fee budget | `outis budget`; wait for `resetsAt` or ask the user |
| `out_of_gas` | not enough STRK for the fee | ask the user to top the account up |
| `reverted` | the contract refused | read `message` |

Never ask the user for a private key or recovery phrase: the CLI never needs one.

`--network devnet` (or `OUTIS_NETWORK`) for a local devnet; `OUTIS_RPC_URL` to use another node.
