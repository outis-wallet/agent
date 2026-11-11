import {
  NAMED_TOKENS,
  SN_SEPOLIA,
  STRK,
  USDC,
  USDC_SEPOLIA,
  balanceOf,
  formatAmount,
  selector,
  toHex,
  tokenInfo,
  type Token,
} from "@outis-wallet/agent/core";
import type { Context } from "../context.ts";
import { requireSession } from "../context.ts";
import { CliError, type Printer } from "../output.ts";
import { loadKey, loadRequest, loadSessions } from "../store.ts";
import { fingerprint } from "./connect.ts";

// Commands that only read: what the agent has, and what it may still spend.

export async function status(ctx: Context, out: Printer): Promise<void> {
  const name = ctx.network.name;
  const key = await loadKey(name);
  const request = await loadRequest(name);
  const sessions = await loadSessions(name);
  const now = await ctx.now();
  const listed = sessions.map((s) => ({
    account: toHex(s.account),
    session: toHex(s.hash),
    expiresAt: Number(s.session.expiresAt),
    expired: s.session.expiresAt < now,
  }));
  out.result(
    {
      network: name,
      rpc: ctx.network.rpcUrl,
      key: key ? { guid: toHex(key.guid), fingerprint: fingerprint(key.guid) } : null,
      pendingRequest: request ? { fromBlock: request.fromBlock } : null,
      sessions: listed,
    },
    [
      `network  ${name} (${ctx.network.rpcUrl})`,
      `key      ${key ? fingerprint(key.guid) : "none yet: run `outis connect`"}`,
      ...(request && listed.length === 0 ? ["waiting  for the user to approve: `outis connect --wait`"] : []),
      ...listed.map((s) => `session  ${s.session} on ${s.account}, ${s.expired ? "expired" : `expires ${new Date(s.expiresAt * 1000).toISOString()}`}`),
    ],
  );
}

export async function tokensOf(ctx: Context, addresses: bigint[]): Promise<Token[]> {
  const unique = [...new Set(addresses)];
  return Promise.all(unique.map((address) => tokenInfo(ctx.rpc, address)));
}

export async function balance(ctx: Context, out: Printer, tokenArgs: string[]): Promise<void> {
  const { account, session } = await requireSession(ctx);
  const addresses = tokenArgs.length
    ? await Promise.all(tokenArgs.map((arg) => resolveToken(ctx, arg).then((t) => t.address)))
    : [STRK.address, ...session.spendingLimits.map((l) => l.token)];
  const tokens = await tokensOf(ctx, addresses);
  const balances = await Promise.all(tokens.map(async (token) => ({ token, amount: await balanceOf(ctx.rpc, token, account) })));
  out.result(
    {
      account: toHex(account),
      balances: balances.map(({ token, amount }) => ({
        token: toHex(token.address),
        symbol: token.symbol,
        amount: formatAmount(amount, token.decimals, token.decimals),
        amountRaw: amount,
      })),
    },
    balances.map(({ token, amount }) => `${formatAmount(amount, token.decimals)} ${token.symbol}`),
  );
}

/** A token by address, or by symbol among the well-known ones (USDC is Circle's on each network). */
export async function resolveToken(ctx: Context, arg: string): Promise<Token> {
  if (/^0x[0-9a-fA-F]+$/.test(arg)) return tokenInfo(ctx.rpc, BigInt(arg));
  const usdc = (await ctx.chainId()) === SN_SEPOLIA ? USDC_SEPOLIA : USDC;
  const known = [...NAMED_TOKENS.filter((t) => t.symbol !== "USDC"), usdc];
  const token = known.find((t) => t.symbol.toLowerCase() === arg.toLowerCase());
  if (!token) throw new CliError("usage", `Unknown token "${arg}"`, "Give the token's address instead");
  return token;
}

type Period = { periodStart: bigint; spent: bigint };

function decodeSpending(felts: bigint[]): Period {
  const [periodStart = 0n, low = 0n, high = 0n] = felts;
  return { periodStart, spent: low + (high << 128n) };
}

/** What is left of a limit now, and when the current period ends (undefined: for the life of the session). */
export function remaining(limit: { amount: bigint; period: bigint }, used: Period, now: bigint) {
  const over = limit.period !== 0n && used.periodStart !== 0n && now - used.periodStart >= limit.period;
  const spent = over ? 0n : used.spent;
  const left = limit.amount > spent ? limit.amount - spent : 0n;
  const resetsAt = limit.period !== 0n && !over && used.periodStart !== 0n ? used.periodStart + limit.period : undefined;
  return { spent, left, resetsAt };
}

export async function budget(ctx: Context, out: Printer): Promise<void> {
  const { account, hash, session } = await requireSession(ctx);
  const now = await ctx.now();
  const tokens = await tokensOf(ctx, session.spendingLimits.map((l) => l.token));
  const limits = await Promise.all(
    session.spendingLimits.map(async (limit) => {
      const token = tokens.find((t) => t.address === limit.token)!;
      const used = decodeSpending(await ctx.rpc.call(account, selector("get_session_spending"), [hash, limit.token]));
      return { token, limit, ...remaining(limit, used, now) };
    }),
  );
  const fees = remaining(session.feeLimit, decodeSpending(await ctx.rpc.call(account, selector("get_session_fees"), [hash])), now);
  const strk = (amount: bigint) => formatAmount(amount, 18, 18);
  out.result(
    {
      account: toHex(account),
      session: toHex(hash),
      expiresAt: Number(session.expiresAt),
      // a session's own transactions stop an hour before it expires
      transactionsUntil: Number(session.expiresAt - 3600n),
      spending: limits.map(({ token, limit, spent, left, resetsAt }) => ({
        token: toHex(token.address),
        symbol: token.symbol,
        limit: formatAmount(limit.amount, token.decimals, token.decimals),
        periodSeconds: Number(limit.period),
        spent: formatAmount(spent, token.decimals, token.decimals),
        left: formatAmount(left, token.decimals, token.decimals),
        resetsAt: resetsAt === undefined ? null : Number(resetsAt),
      })),
      fees: {
        limit: strk(session.feeLimit.amount),
        periodSeconds: Number(session.feeLimit.period),
        charged: strk(fees.spent),
        left: strk(fees.left),
        resetsAt: fees.resetsAt === undefined ? null : Number(fees.resetsAt),
      },
    },
    [
      ...limits.map(({ token, limit, left }) => `${formatAmount(left, token.decimals)} of ${formatAmount(limit.amount, token.decimals)} ${token.symbol} left${limit.period ? ` this period (${limit.period}s)` : ""}`),
      `${formatAmount(fees.left, 18)} of ${formatAmount(session.feeLimit.amount, 18)} STRK left for fees`,
      `expires ${new Date(Number(session.expiresAt) * 1000).toISOString()}`,
    ],
  );
}
