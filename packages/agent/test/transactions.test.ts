import { Rpc, STRK, invokeTransactionHash, selector, toHex, transferCall, type RawFeeEstimate } from "../src/core/index.ts";
import { describe, expect, it, vi } from "vitest";
import { SessionKey, prepareSessionInvoke, serializeSession, submitSessionInvoke, type Session } from "../src/index.ts";

const key = SessionKey.fromPrivateKey("0x12345");
const session: Session = {
  expiresAt: 1900000000n,
  allowedMethods: [{ contract: STRK.address, selector: selector("transfer") }],
  allowedMessages: [],
  spendingLimits: [],
  feeLimit: { amount: 1000000n, period: 0n },
  metadata: "transaction test",
  sessionKey: key.guid,
};
const args = {
  chainId: 0x534e5f5345504f4c4941n, sender: 0x123n, session, signer: key.signer, calls: [transferCall(STRK, 0x456n, 1n)],
};
const estimate: RawFeeEstimate = {
  l1_gas_consumed: "100", l1_gas_price: "10",
  l2_gas_consumed: "2", l2_gas_price: "3",
  l1_data_gas_consumed: "20", l1_data_gas_price: "7",
  overall_fee: "1146", unit: "FRI",
};

function fixture() {
  const rpc = new Rpc("http://unused.invalid");
  vi.spyOn(rpc, "nonce").mockResolvedValue(7n);
  const estimation = vi.spyOn(rpc, "estimateFee").mockResolvedValue(estimate);
  return { rpc, estimation };
}

describe("session invokes", () => {
  it("estimates with a placeholder token and includes the nonzero validation fee write before adding 15%", async () => {
    const { rpc, estimation } = fixture();
    estimation.mockResolvedValueOnce(estimate).mockResolvedValueOnce({ ...estimate, l1_data_gas_consumed: "24", overall_fee: "1174" });
    const prepared = await prepareSessionInvoke(rpc, args);
    expect(prepared.bounds).toEqual({
      l1Gas: { maxAmount: 115n, maxPricePerUnit: 12n },
      l2Gas: { maxAmount: 3n, maxPricePerUnit: 4n },
      l1DataGas: { maxAmount: 28n, maxPricePerUnit: 9n },
    });
    expect(prepared.fee).toEqual({ estimated: 1174n, max: 1644n });
    expect(prepared.hash).toBe(invokeTransactionHash(prepared));
    expect(estimation).toHaveBeenCalledTimes(2);
    const [first] = estimation.mock.calls[0]!;
    expect(first).toMatchObject({ type: "INVOKE", version: "0x100000000000000000000000000000003", nonce: "0x7", sender_address: "0x123" });
    // The serialized session is followed directly by the placeholder [0, pubkey, 1, 1].
    expect((first.signature as string[]).slice(1 + serializeSession(session).length, -2).map(BigInt)).toEqual([
      0n, key.signer.pubkey, 1n, 1n,
    ]);
    expect(estimation.mock.calls[1]![0].resource_bounds).toEqual({
      l1_gas: { max_amount: "0x73", max_price_per_unit: "0xc" },
      l2_gas: { max_amount: "0x3", max_price_per_unit: "0x4" },
      l1_data_gas: { max_amount: "0x17", max_price_per_unit: "0x9" },
    });
  });

  it("uses explicit bounds without estimation and submits the normal V3 fields", async () => {
    const { rpc, estimation } = fixture();
    const bounds = {
      l1Gas: { maxAmount: 100n, maxPricePerUnit: 10n },
      l2Gas: { maxAmount: 2n, maxPricePerUnit: 3n },
      l1DataGas: { maxAmount: 20n, maxPricePerUnit: 7n },
    };
    const prepared = await prepareSessionInvoke(rpc, { ...args, bounds });
    expect(estimation).not.toHaveBeenCalled();
    expect(prepared.fee).toEqual({ max: 1146n });
    const submit = vi.spyOn(rpc, "addInvokeTransaction").mockResolvedValue(prepared.hash);
    expect(await submitSessionInvoke(rpc, prepared, key)).toBe(prepared.hash);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      type: "INVOKE", version: "0x3", sender_address: toHex(args.sender), nonce: "0x7",
      account_deployment_data: [], tip: "0x0", paymaster_data: [],
      nonce_data_availability_mode: "L1", fee_data_availability_mode: "L1",
    }));
  });

  it("rejects a wrong key or forbidden call before requesting an estimate", async () => {
    const { rpc, estimation } = fixture();
    await expect(prepareSessionInvoke(rpc, { ...args, signer: SessionKey.fromPrivateKey("0x54321").signer })).rejects.toThrow("doesn't match");
    await expect(prepareSessionInvoke(rpc, { ...args, calls: [{ to: 1n, selector: 2n, calldata: [] }] })).rejects.toThrow("doesn't allow");
    expect(estimation).not.toHaveBeenCalled();
  });
});
