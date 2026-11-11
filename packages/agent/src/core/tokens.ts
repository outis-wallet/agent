// A copy of what the agent needs from Outis's wallet core (its `@outis/core`, not published): the same
// declarations word for word, so that what is hashed and sent reads one way in the wallet and in the
// agent. Change it only as the wallet's changes.

import { selector, type Call } from "./account.ts";
import { toHex, u256ToFelts } from "./bytes.ts";
import { SN_MAIN } from "./keys.ts";
import { contractNotFound, noSuchFunction, type Rpc } from "./rpc.ts";

export type Token = { symbol: string; address: bigint; decimals: number };

/** The fee token. Same address on mainnet, Sepolia and devnet. */
export const STRK: Token = {
  symbol: "STRK",
  address: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938dn,
  decimals: 18,
};

/** Ether, bridged. Same address on mainnet and Sepolia; devnet predeploys it there too. */
export const ETH: Token = {
  symbol: "ETH",
  address: 0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7n,
  decimals: 18,
};

/** USDC on mainnet: Circle's own (developers.circle.com/stablecoins/usdc-contract-addresses). */
export const USDC: Token = {
  symbol: "USDC",
  address: 0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fbn,
  decimals: 6,
};

/** USDC on Sepolia: Circle's own there (same page). */
export const USDC_SEPOLIA: Token = {
  symbol: "USDC",
  address: 0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343n,
  decimals: 6,
};

/**
 * The USDC bridged from Ethereum, which mainnet had before Circle's. Its contract calls itself USDC
 * too: the wallet calls it USDC.e, "USDC (Bridged)", so that the two aren't taken for one another.
 */
export const USDC_BRIDGED: Token = {
  symbol: "USDC.e",
  address: 0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8n,
  decimals: 6,
};

// Mainnet's, as Ekubo's token list has them (prod-api.ekubo.org/tokens), with the symbol and
// decimals their contracts answer with. USDT and WBTC are the ones bridged from Ethereum.
export const USDT: Token = { symbol: "USDT", address: 0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8n, decimals: 6 };
export const WBTC: Token = { symbol: "WBTC", address: 0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7acn, decimals: 8 };
export const ZEC: Token = { symbol: "ZEC", address: 0x05ce53b9b68fb8e9ecab9283a96d97948914733fd6ed8d9a53a276a419497841n, decimals: 8 };
export const SOL: Token = { symbol: "SOL", address: 0x01e70aedffd376afe33cebdf51ed5365131dccb2a5b2cb36d02b785442912b9bn, decimals: 9 };
/** Endur's transferable liquid staking token on Mainnet; a wallet token, not a second DeFi position. */
export const XSTRK: Token = { symbol: "xSTRK", address: 0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0an, decimals: 18 };
/** Ekubo's token on Mainnet: also what its oracle prices every token against (see the indexer's prices.rs). */
export const EKUBO: Token = { symbol: "EKUBO", address: 0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87n, decimals: 18 };
/** Realms' token on Mainnet. */
export const LORDS: Token = { symbol: "LORDS", address: 0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49n, decimals: 18 };
/** Daydreams' token on Mainnet. Its contract calls it "dreams". */
export const DREAMS: Token = { symbol: "DREAMS", address: 0x04fcaf2a7b4a072fe57c59beee807322d34ed65000d78611c909a46fead07fb1n, decimals: 6 };
/** Opus's dollar on Mainnet: its Shrine contract (docs.opus.money's deployed contracts), which calls it "Cash". */
export const CASH: Token = { symbol: "CASH", address: 0x0498edfaf50ca5855666a700c25dd629d577eb9afccdf3b5977aec79aee55adan, decimals: 18 };
// Mainnet's others the indexer prices (its prices.rs), with the symbols and decimals their contracts answer with.
export const DAI: Token = { symbol: "DAI", address: 0x05574eb6b8789a91466f902c380d978e472db68170ff82a5b650b95a58ddf4adn, decimals: 18 };
export const WSTETH: Token = { symbol: "wstETH", address: 0x0057912720381af14b0e5c87aa4718ed5e527eab60b3801ebf702ab09139e38bn, decimals: 18 };
export const TBTC: Token = { symbol: "tBTC", address: 0x04daa17763b286d1e59b97c283c0b8c949994c361e426a28f743c67bdfe9a32fn, decimals: 18 };
export const SOLVBTC: Token = { symbol: "SolvBTC", address: 0x0593e034dda23eea82d2ba9a30960ed42cf4a01502cc2351dc9b9881f9931a68n, decimals: 18 };
export const STRKBTC: Token = { symbol: "strkBTC", address: 0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135n, decimals: 8 };

/**
 * The tokens the wallet knows by their address, on whichever network they are: what they are
 * called and how many decimals they have are as written here, not as their contracts say (which
 * can say anything: the bridged USDC says USDC, and SOL a symbol that isn't text). Not the tokens
 * it lists by itself: those are `listedTokens`.
 */
export const NAMED_TOKENS: Token[] = [STRK, ETH, USDC, USDC_SEPOLIA, USDC_BRIDGED, USDT, WBTC, ZEC, SOL, XSTRK, EKUBO, LORDS, DREAMS, CASH, DAI, WSTETH, TBTC, SOLVBTC, STRKBTC];

/** Decodes a token's `symbol()`: a short string in one felt, or a ByteArray (word count, 31-byte words, last word, its length). */
function decodeSymbol(felts: bigint[]): string | undefined {
  const text = (value: bigint, length?: number) => {
    const hex = value.toString(16);
    const bytes = (hex.length % 2 ? `0${hex}` : hex).match(/../g) ?? [];
    const chars = bytes.map((byte) => String.fromCharCode(parseInt(byte, 16)));
    return (length === undefined ? chars : chars.slice(-length)).join("");
  };
  if (felts.length === 1) return text(felts[0]!);
  const [count, ...rest] = felts;
  if (count === undefined || rest.length !== Number(count) + 2) return undefined;
  const words = rest.slice(0, Number(count)).map((word) => text(word).padStart(31, "\0"));
  return words.join("") + text(rest[Number(count)]!, Number(rest[Number(count) + 1]));
}

/**
 * A token's symbol and decimals, read from the token contract. One the wallet knows by its address
 * (`NAMED_TOKENS`) is known without asking. Its decimals are the scale of every amount of it shown,
 * typed or signed, so they are only ever the contract's own: where they can't be read, or what the
 * contract answers isn't a token's decimals (one value, 36 at most), the token is refused (a failed
 * read is no answer, and was once taken as 0 decimals); and where `listed`, another reading of the
 * token (the indexer's directory, say), says other decimals, it is refused too: one of the two is
 * wrong, and an amount shown by one would be signed by the other.
 */
export async function tokenInfo(rpc: Pick<Rpc, "call">, address: bigint, listed?: Token): Promise<Token> {
  const known = NAMED_TOKENS.find((token) => token.address === address);
  if (known) return known;
  const { token } = await readToken(rpc, address);
  if (listed && listed.decimals !== token.decimals) throw new TokenDecimalsError(token, listed.decimals);
  return token;
}

/**
 * A token as its contract says it is (see `tokenInfo`), and whether its symbol was read: a node that
 * failed to answer `symbol()` leaves it "unknown token" for now, which isn't the contract's word for
 * it. A contract with no `symbol` says it has none.
 */
export async function readToken(rpc: Pick<Rpc, "call">, address: bigint): Promise<{ token: Token; symbolRead: boolean }> {
  const known = NAMED_TOKENS.find((token) => token.address === address);
  if (known) return { token: known, symbolRead: true };
  const [symbol, decimals] = await Promise.all([
    rpc.call(address, selector("symbol")).then(
      (felts) => ({ text: decodeSymbol(felts), read: true }),
      (error: unknown) => ({ text: undefined, read: noSuchFunction(error, address, selector("symbol")) }),
    ),
    rpc.call(address, selector("decimals")).catch((error: unknown) => {
      // Nothing of a token there: no contract, or one the node says has no `decimals` of its own.
      if (contractNotFound(error) || noSuchFunction(error, address, selector("decimals"))) throw new NotATokenError(error instanceof Error ? error.message : String(error));
      throw error;
    }),
  ]);
  const token = describedToken(address, symbol.text, decimals[0]);
  // One value, from 0 to 36, as it was answered: not as describedToken would make anything else.
  if (decimals.length !== 1 || decimals[0]! < 0n || decimals[0]! > MOST_DECIMALS) {
    throw new UncheckedTokenError(`${token.symbol === UNKNOWN_SYMBOL ? "This token" : token.symbol}'s contract answers decimals no token has`);
  }
  return { token, symbolRead: symbol.read };
}

/** What readToken found at an address: no contract, or one the node says has no `decimals` of its own. */
export class NotATokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotATokenError";
  }
}

/** A token whose amounts the wallet can't scale: its decimals couldn't be checked, as the message says (see `tokenInfo`). */
export class UncheckedTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UncheckedTokenError";
  }
}

/** A token whose contract says other decimals than another reading of it, or than an amount of it was to be shown or typed in (see `tokenInfo`). */
export class TokenDecimalsError extends UncheckedTokenError {
  constructor(
    readonly token: Token,
    readonly other: number,
    message = `${token.symbol}'s contract says it has ${token.decimals} decimals, not ${other}`,
  ) {
    super(message);
    this.name = "TokenDecimalsError";
  }
}

/** The most decimals a token's can be, as the wallet takes them (the indexer's MAX_DECIMALS). */
const MOST_DECIMALS = 36n;

/** What a token that says nothing a wallet could show is called. */
export const UNKNOWN_SYMBOL = "unknown token";

/**
 * A token as its contract says it is: its symbol where it is text that can be shown, and its
 * decimals where they are what a token's can be. Otherwise "unknown token", of whole units.
 */
export function describedToken(address: bigint, symbol: string | undefined, decimals: bigint | undefined): Token {
  // Spaces only at its ends or doubled ("USDC ") would read as another token's symbol: kept as one between words.
  const tidied = symbol?.replace(/^ +| +$/g, "").replace(/ +/g, " ");
  const printable = tidied && /^[\x20-\x7e]{1,16}$/.test(tidied) ? tidied : undefined;
  return { symbol: printable ?? UNKNOWN_SYMBOL, address, decimals: decimals !== undefined && decimals >= 0n && decimals <= MOST_DECIMALS ? Number(decimals) : 0 };
}

export async function balanceOf(rpc: Rpc, token: Token, account: bigint, block?: "pre_confirmed" | "latest"): Promise<bigint> {
  const [low = 0n, high = 0n] = await rpc.call(token.address, selector("balance_of"), [account], block);
  return low + (high << 128n);
}

export function transferCall(token: Token, recipient: bigint, amount: bigint): Call {
  return { to: token.address, selector: selector("transfer"), calldata: [recipient, ...u256ToFelts(amount)] };
}

/** "1.5" → 1500000000000000000 for 18 decimals. Returns undefined for anything that isn't a plain decimal number. */
export function parseAmount(text: string, decimals: number): bigint | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return undefined;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return undefined;
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** 1500000000000000000 → "1.5" for 18 decimals, keeping at most `maxFractionDigits` digits after the point. */
export function formatAmount(amount: bigint, decimals: number, maxFractionDigits = 6): string {
  const unit = 10n ** BigInt(decimals);
  const whole = amount / unit;
  const fraction = (amount % unit).toString().padStart(decimals, "0").slice(0, maxFractionDigits).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
