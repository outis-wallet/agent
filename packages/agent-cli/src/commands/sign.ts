import { readFile } from "node:fs/promises";
import { toHex } from "@outis-wallet/agent/core";
import { MessageNotAllowedError, sessionMessageSignature } from "@outis-wallet/agent";
import type { TypedData } from "starknet";
import { type Context, requireSession } from "../context.ts";
import { CliError, type Printer } from "../output.ts";
import { loadKey } from "../store.ts";

// Signing SNIP-12 (revision 1) messages in the session, for anything that checks the account's
// `is_valid_signature`. A signature is only good while its session is: an app that checks it later
// (Surround checks a game's terms when it settles, up to a day later) must not be handed one that
// outlives the session, so the CLI refuses to sign when less than `minLife` seconds are left.

export async function sign(ctx: Context, out: Printer, [file]: string[], minLifeSeconds: number): Promise<void> {
  if (!file) throw new CliError("usage", "outis sign <typed-data.json | ->");
  const text = file === "-" ? await readStdin() : await readFile(file, "utf8");
  let message: TypedData;
  try {
    message = JSON.parse(text) as TypedData;
  } catch {
    throw new CliError("usage", "The typed data isn't valid JSON");
  }
  const stored = await requireSession(ctx);
  const now = await ctx.now();
  if (stored.session.expiresAt - now < BigInt(minLifeSeconds)) {
    throw new CliError("session_expired", `The session ends in less than ${minLifeSeconds} seconds, and the signature may be checked later`, "Run `outis connect` for a new session, or pass --min-life 0 for a message checked right away");
  }
  const key = (await loadKey(ctx.network.name))!;
  let signature: bigint[];
  try {
    signature = sessionMessageSignature({ session: stored.session, chainId: await ctx.chainId(), account: stored.account, message, key });
  } catch (error) {
    if (error instanceof MessageNotAllowedError) {
      throw new CliError("method_not_allowed", "The session doesn't allow signing this kind of message", "Ask the user for a session that does: `outis connect --ask sign`");
    }
    throw error;
  }
  out.result(
    { account: toHex(stored.account), signature: signature.map(toHex), validUntil: Number(stored.session.expiresAt) },
    [`account   ${toHex(stored.account)}`, `signature ${JSON.stringify(signature.map(toHex))}`],
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
