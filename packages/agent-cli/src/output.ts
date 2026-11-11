// What the CLI prints. Agents read `--json`: one JSON object on stdout. Amounts are strings in whole
// tokens ("1.5"); a field ending in `Raw` is the same amount in base units. Addresses and hashes are 0x
// hex. Errors carry a code and, when there is one, the next step to take.

export type ErrorCode =
  | "usage"
  | "no_session"
  | "session_expired"
  | "method_not_allowed"
  | "over_budget"
  | "out_of_gas"
  | "rpc"
  | "reverted"
  | "unknown";

export class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly next?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export type Printer = {
  json: boolean;
  /** The command's result: a JSON object, or lines for a person. */
  result(value: Record<string, unknown>, lines: string[]): void;
  error(error: unknown): void;
};

function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export function printer(json: boolean): Printer {
  return {
    json,
    result(value, lines) {
      if (json) process.stdout.write(`${JSON.stringify(jsonSafe({ ok: true, ...value }))}\n`);
      else process.stdout.write(`${lines.join("\n")}\n`);
    },
    error(error) {
      const known = error instanceof CliError ? error : new CliError("unknown", error instanceof Error ? error.message : String(error));
      if (json) {
        const body = { ok: false, error: { code: known.code, message: known.message, next: known.next, ...known.details } };
        process.stdout.write(`${JSON.stringify(jsonSafe(body))}\n`);
      } else {
        process.stderr.write(`error (${known.code}): ${known.message}\n`);
        if (known.next) process.stderr.write(`next: ${known.next}\n`);
      }
    },
  };
}
