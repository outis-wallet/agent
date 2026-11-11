import {
  RpcError,
  STRK,
  TransactionRevertedError,
  balanceOf,
  formatAmount,
  parseAmount,
  selector,
  toHex,
  transferCall,
  type Call,
  type Token,
} from "@outis-wallet/agent/core";
import { MethodNotAllowedError, prepareSessionInvoke, sessionProofs, submitSessionInvoke } from "@outis-wallet/agent";
import { type Context, requireSession } from "../context.ts";
import { CliError, type Printer } from "../output.ts";
import { loadKey, type StoredSession } from "../store.ts";
import { remaining, resolveToken } from "./read.ts";

// Sending transactions in the session. Everything that can be checked before sending is: the method is
// allowed, the session has an hour left, the spending and fee budgets cover it, the account holds the
// STRK. What the contract refuses anyway comes back as the same error codes.

const HOUR = 3600n;

function felt(text: string): bigint[] {
  // u256:N splits a number into its two felts, as Cairo serializes a u256
  if (text.startsWith("u256:")) {
    const value = BigInt(text.slice(5));
    return [value & ((1n << 128n) - 1n), value >> 128n];
  }
  return [BigInt(text)];
}

export function parseCalldata(args: string[]): bigint[] {
  return args.flatMap(felt);
}

/** Maps a contract's refusal (from an estimate or a receipt) to the CLI's error codes. */
function explain(reason: string): CliError {
  if (reason.includes("session/spending-limit")) return new CliError("over_budget", "Over the session's spending limit", "Run `outis budget`, or ask the user for more");
  if (reason.includes("session/fee-limit")) return new CliError("over_budget", "Over the session's fee budget", "Run `outis budget`, or wait for it to reset");
  if (reason.includes("session/no-transactions")) return new CliError("method_not_allowed", "This session can't send transactions", "Ask the user for a session with a fee budget: `outis connect`");
  if (reason.includes("session/expiring") || reason.includes("session/expired")) return new CliError("session_expired", "The session expires within the hour", "Run `outis connect` for a new one");
  if (reason.includes("session/revoked")) return new CliError("session_expired", "The user revoked the session", "Run `outis connect` for a new one");
  if (reason.includes("session/invalid-call")) return new CliError("method_not_allowed", "The session doesn't allow that call", "Ask the user for a session that does: `outis connect`");
  if (/balance|exceed|insufficient/i.test(reason)) return new CliError("out_of_gas", "Not enough STRK for the fee", "Ask the user to top the account up");
  return new CliError("reverted", reason.slice(0, 500));
}

function reasonOf(error: unknown): string | undefined {
  if (error instanceof TransactionRevertedError) return error.receipt.revert_reason ?? "reverted";
  if (error instanceof RpcError) return `${error.message} ${JSON.stringify(error.data ?? "")}`;
  return undefined;
}

async function spendingLeft(ctx: Context, stored: StoredSession, token: bigint, now: bigint) {
  const limit = stored.session.spendingLimits.find((l) => l.token === token);
  if (!limit) return undefined;
  const [periodStart = 0n, low = 0n, high = 0n] = await ctx.rpc.call(stored.account, selector("get_session_spending"), [stored.hash, token]);
  return remaining(limit, { periodStart, spent: low + (high << 128n) }, now);
}

async function feesLeft(ctx: Context, stored: StoredSession, now: bigint) {
  const [periodStart = 0n, low = 0n, high = 0n] = await ctx.rpc.call(stored.account, selector("get_session_fees"), [stored.hash]);
  return remaining(stored.session.feeLimit, { periodStart, spent: low + (high << 128n) }, now);
}

const strkAmount = (amount: bigint) => formatAmount(amount, 18, 18);

/** Sends `calls` in the session after the checks above; `outgoing` is what they send out, per token. */
export async function act(
  ctx: Context,
  out: Printer,
  calls: Call[],
  outgoing: { token: Token; amount: bigint }[],
  summary: string,
): Promise<void> {
  const stored = await requireSession(ctx);
  const key = (await loadKey(ctx.network.name))!;
  const now = await ctx.now();
  if (stored.session.expiresAt < now + HOUR) throw explain("session/expiring");
  if (stored.session.feeLimit.amount === 0n) throw explain("session/no-transactions");
  try {
    sessionProofs(stored.session, calls);
  } catch (error) {
    if (error instanceof MethodNotAllowedError) throw explain("session/invalid-call");
    throw error;
  }
  for (const { token, amount } of outgoing) {
    const left = await spendingLeft(ctx, stored, token.address, now);
    if (left && amount > left.left) {
      throw new CliError("over_budget", "Over the session's spending limit", "Run `outis budget`, or ask the user for more", {
        token: toHex(token.address),
        symbol: token.symbol,
        left: formatAmount(left.left, token.decimals, token.decimals),
        leftRaw: left.left,
        resetsAt: left.resetsAt === undefined ? null : Number(left.resetsAt),
      });
    }
  }

  const chainId = await ctx.chainId();
  let prepared;
  try {
    prepared = await prepareSessionInvoke(ctx.rpc, { chainId, sender: stored.account, session: stored.session, signer: key.signer, calls });
  } catch (error) {
    const reason = reasonOf(error);
    if (reason) throw explain(reason);
    throw error;
  }
  const fees = await feesLeft(ctx, stored, now);
  if (prepared.fee.max > fees.left) {
    throw new CliError("over_budget", "Over the session's fee budget", "Run `outis budget`, or wait for it to reset", {
      feesLeft: strkAmount(fees.left),
      needed: strkAmount(prepared.fee.max),
      resetsAt: fees.resetsAt === undefined ? null : Number(fees.resetsAt),
    });
  }
  const strk = await balanceOf(ctx.rpc, STRK, stored.account);
  const sendingStrk = outgoing.find((o) => o.token.address === STRK.address)?.amount ?? 0n;
  if (strk < prepared.fee.max + sendingStrk) {
    throw new CliError("out_of_gas", "Not enough STRK for the fee", "Ask the user to top the account up", {
      account: toHex(stored.account), balance: strkAmount(strk), needed: strkAmount(prepared.fee.max + sendingStrk),
    });
  }

  let transactionHash: bigint;
  try {
    transactionHash = await submitSessionInvoke(ctx.rpc, prepared, key);
    const receipt = await ctx.rpc.waitForTransaction(transactionHash);
    const after = await ctx.now();
    const feesAfter = await feesLeft(ctx, stored, after);
    const fee = BigInt(receipt.actual_fee?.amount ?? 0);
    // amounts in whole STRK; what the fee budget was charged is the most the transaction could cost
    out.result(
      {
        transaction: toHex(transactionHash),
        account: toHex(stored.account),
        fee: strkAmount(fee),
        feeCharged: strkAmount(prepared.fee.max),
        feesLeft: strkAmount(feesAfter.left),
      },
      [`${summary}: ${toHex(transactionHash)}`, `fee ${formatAmount(fee, 18)} STRK, ${formatAmount(feesAfter.left, 18)} STRK left for fees`],
    );
  } catch (error) {
    const reason = reasonOf(error);
    if (reason) throw explain(reason);
    throw error;
  }
}

export async function send(ctx: Context, out: Printer, [amountText, tokenArg, to]: string[]): Promise<void> {
  if (!amountText || !tokenArg || !to) throw new CliError("usage", "outis send <amount> <token> <recipient>");
  const token = await resolveToken(ctx, tokenArg);
  const amount = parseAmount(amountText, token.decimals);
  if (amount === undefined || amount === 0n) throw new CliError("usage", `"${amountText}" isn't an amount of ${token.symbol}`);
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(to)) throw new CliError("usage", `"${to}" isn't an address`);
  const call = transferCall(token, BigInt(to), amount);
  await act(ctx, out, [call], [{ token, amount }], `sent ${amountText} ${token.symbol} to ${to}`);
}

export async function execute(ctx: Context, out: Printer, [contract, entrypoint, ...calldata]: string[]): Promise<void> {
  if (!contract || !entrypoint) throw new CliError("usage", "outis execute <contract> <entrypoint> [calldata...]");
  const call: Call = { to: BigInt(contract), selector: selector(entrypoint), calldata: parseCalldata(calldata) };
  // What the call sends out isn't known here: the contract's spending limits still apply
  await act(ctx, out, [call], [], `${entrypoint} on ${contract}`);
}

export async function call(ctx: Context, out: Printer, [contract, entrypoint, ...calldata]: string[]): Promise<void> {
  if (!contract || !entrypoint) throw new CliError("usage", "outis call <contract> <entrypoint> [calldata...]");
  const result = await ctx.rpc.call(BigInt(contract), selector(entrypoint), parseCalldata(calldata));
  out.result({ result: result.map(toHex) }, result.map(toHex));
}

export async function transaction(ctx: Context, out: Printer, [hash]: string[], wait: boolean): Promise<void> {
  if (!hash) throw new CliError("usage", "outis tx <hash> [--wait]");
  const receipt = wait ? await ctx.rpc.waitForTransaction(BigInt(hash)).catch((e) => (e instanceof TransactionRevertedError ? e.receipt : Promise.reject(e))) : await ctx.rpc.receipt(BigInt(hash));
  if (!receipt) {
    out.result({ transaction: hash, status: "unknown" }, [`${hash}: not found (yet)`]);
    return;
  }
  out.result(
    { transaction: hash, status: receipt.execution_status, finality: receipt.finality_status, revertReason: receipt.revert_reason ?? null },
    [`${hash}: ${receipt.execution_status} (${receipt.finality_status})${receipt.revert_reason ? `: ${receipt.revert_reason}` : ""}`],
  );
}
