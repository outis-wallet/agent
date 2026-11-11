# @outis-wallet/agent-cli

The Outis CLI for AI agents: a bot (Claude Code, OpenClaw, Hermes, Codex, anything that runs commands)
gets a Starknet account of its own, funded from the user's Outis wallet, and spends from it within
limits the user sets and the account enforces on-chain. The bot never holds a key that can do more
than its session allows.

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
