import { parseArgs } from "node:util";
import { loadTypedDataFromFile } from "@outis-wallet/typed-data/node";
import { call, execute, send, transaction } from "./commands/act.ts";
import { connect, syncCommand } from "./commands/connect.ts";
import { balance, budget, status } from "./commands/read.ts";
import { sign } from "./commands/sign.ts";
import { context } from "./context.ts";
import { CliError, printer } from "./output.ts";

const HELP = `outis: an Outis agent account, driven by a session the user approved.

Usage: outis <command> [options]

  connect [--name N] [--ask send,swap,sign] [--method <contract>:<entrypoint>[:<why>]]...
          [--message <typed-data.json>]... [--wait]
                         ask the user for a session: prints a link to approve.
                         --ask names actions the keychain knows; --method asks for any other
                         contract method, --message for a kind of message (from an example)
  sync                   look for sessions the user approved
  status                 network, key, sessions
  balance [token...]     what the account holds
  budget                 what the session may still spend, and pay in fees
  send <amount> <token> <recipient>
                         send tokens (token: STRK, ETH, USDC... or an address)
  execute <contract> <entrypoint> [calldata...]
                         any call the session allows (calldata: felts, u256:N)
  call <contract> <entrypoint> [calldata...]
                         read a contract
  sign <typed-data.json | -> [--min-life seconds]
                         sign a SNIP-12 message the session allows
  tx <hash> [--wait]     a transaction's status

Options:
  --json                 one JSON object on stdout: {ok, ...} or {ok: false, error: {code, message, next}}
  --network <name>       sepolia (default) or devnet; or OUTIS_NETWORK
  OUTIS_RPC_URL, OUTIS_KEYCHAIN_URL, OUTIS_AGENT_HOME override the defaults.
`;

/** Where the built bundle finds the typed-data module, relative to itself: defined by `pnpm build` (esbuild's --define), undefined from the sources. */
declare const OUTIS_TYPED_DATA: string | undefined;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      network: { type: "string" },
      name: { type: "string", default: "" },
      ask: { type: "string", default: "" },
      method: { type: "string", multiple: true, default: [] },
      message: { type: "string", multiple: true, default: [] },
      wait: { type: "boolean", default: false },
      timeout: { type: "string", default: "600" },
      "min-life": { type: "string", default: "86400" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const out = printer(values.json);
  const [command, ...args] = positionals;
  if (!command || values.help || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    // The typed-data module (wasm), which the agent library hashes with: the copy beside the built
    // bundle (`pnpm build` defines OUTIS_TYPED_DATA and copies it there), or, run from the sources
    // (tsx), the package's own build.
    await loadTypedDataFromFile(typeof OUTIS_TYPED_DATA === "string" ? new URL(OUTIS_TYPED_DATA, import.meta.url) : undefined);
    const ctx = context(values.network);
    switch (command) {
      case "connect":
        await connect(ctx, out, {
          name: values.name,
          asks: values.ask ? values.ask.split(",").map((a) => a.trim()).filter(Boolean) : [],
          methods: values.method,
          messages: values.message,
          wait: values.wait,
          timeoutSeconds: Number(values.timeout),
        });
        break;
      case "sync":
        await syncCommand(ctx, out);
        break;
      case "status":
        await status(ctx, out);
        break;
      case "balance":
        await balance(ctx, out, args);
        break;
      case "budget":
        await budget(ctx, out);
        break;
      case "send":
        await send(ctx, out, args);
        break;
      case "execute":
        await execute(ctx, out, args);
        break;
      case "call":
        await call(ctx, out, args);
        break;
      case "sign":
        await sign(ctx, out, args, Number(values["min-life"]));
        break;
      case "tx":
        await transaction(ctx, out, args, values.wait);
        break;
      default:
        throw new CliError("usage", `Unknown command "${command}"`, "Run `outis help`");
    }
    return 0;
  } catch (error) {
    out.error(error);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
