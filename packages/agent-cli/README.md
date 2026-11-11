# @outis-wallet/agent-cli

The Outis CLI for AI agents: a bot (Claude Code, OpenClaw, Hermes, Codex, anything that runs commands)
gets a Starknet account of its own, funded from the user's Outis wallet, and spends from it within
limits the user sets and the account enforces on-chain.

**The bot never holds a private key to an account.** The owner key stays in the user's Outis wallet.
The bot holds only a session key, made on its own machine. The agent account's contract checks every
transaction signed with that key, on-chain, and runs it only if it fits the session the user approved:

- it calls only the contract entrypoints the user allowed;
- it spends no more than each token's limit per period, plus its own fee limit;
- the session hasn't expired or been revoked.

A leaked session key can spend no more than its session allows, and it can never reach the user's own
accounts. [How it works](https://github.com/outis-wallet/agent#the-agent-never-holds-a-private-key-to-an-account).

```bash
npm i -g @outis-wallet/agent-cli
outis connect --name "Trader" --ask send,swap --json
```

`connect` prints a link and a 16-digit code. The user opens the link in the Outis wallet (the Chrome
extension), checks the code, chooses what the bot may do and its limits, and approves. Then:

```bash
outis connect --wait --json   # picks the session up once it is registered
outis budget --json           # what is left to spend
outis send 1 STRK 0x… --json  # a transfer within the budget
```

`outis --help` lists every command. [SKILL.md](SKILL.md) teaches an agent to use it.

Sepolia only for now. Agent accounts are new and unaudited: keep what you put in them small.

Requires Node.js 22 or later.
