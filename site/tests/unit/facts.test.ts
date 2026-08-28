import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../genesis/genesis.json");
  vi.doUnmock("../../genesis/miner-one.json");
  vi.resetModules();
});

test("canonical facts load and a malformed fact fails module initialization", async () => {
  const canonical = await import("../../genesis/model/facts.ts");
  assert.equal(canonical.GENESIS.blockHeight, 53_026);
  assert.equal(canonical.ARTIFACTS["miner-one"].facts.network, "main");
  assert.equal(canonical.ARTIFACTS["miner-one"].facts.outputIndex, 0);
  assert.equal(canonical.artifactDefinition("miner-one"), canonical.ARTIFACTS["miner-one"]);
  assert.equal(canonical.ARTIFACTS["miner-one"].explorerOrigin, "https://mempool.qbit.org");
  assert.deepEqual(canonical.ARTIFACTS["miner-one"].facts.recipient, {
    outputIndex: 1,
    address: "qb1z8q6dsf8sla7vcn2gzxnspuzpshzrkkk80c2a67xdpea2yxkpsm4qmzhake",
    amountBits: 10_000,
    scriptPubKey: "52203834d824f0ff7ccc4d4811a700f04185c43b5ac77e15dd78cd0e7aa21ac186ea",
    scriptPubKeyType: "v2_p2mr",
  });
  assert.equal(canonical.ARTIFACTS["miner-one"].honor?.blockHash, "00000000000000000be903a612b1aaaeea4a7d35be4862327957896d215e3c0f");

  vi.resetModules();
  vi.doMock("../../genesis/genesis.json", async () => {
    const actual = await vi.importActual<typeof import("../../genesis/genesis.json")>("../../genesis/genesis.json");
    return { default: { ...actual, schemaVersion: 2 } };
  });
  await assert.rejects(import("../../genesis/model/facts.ts"), /unsupported schema version/);
});

test("recipient commitments are all-or-none and pin the supported script type", async () => {
  vi.doMock("../../genesis/miner-one.json", async () => {
    const actual = await vi.importActual<typeof import("../../genesis/miner-one.json")>("../../genesis/miner-one.json");
    return { default: { ...actual, recipient: { outputIndex: 1 } } };
  });
  await assert.rejects(import("../../genesis/model/facts.ts"), /recipient address/);

  vi.resetModules();
  vi.doUnmock("../../genesis/miner-one.json");
  vi.doMock("../../genesis/miner-one.json", async () => {
    const actual = await vi.importActual<typeof import("../../genesis/miner-one.json")>("../../genesis/miner-one.json");
    return { default: { ...actual, recipient: { ...actual.recipient, scriptPubKeyType: "witness_v2_p2mr" } } };
  });
  await assert.rejects(import("../../genesis/model/facts.ts"), /recipient script type/);
});
