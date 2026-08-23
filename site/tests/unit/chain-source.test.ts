import assert from "node:assert/strict";
import { test } from "vitest";
import type { QpetError } from "qscriptions";
import {
  compactSize,
  fetchBlockHashAttestation,
  recoveryFailureForQpet,
  recoverGenesis,
  serializeNonWitnessTransaction,
  validateExplorerTransaction,
} from "../../genesis/services/chain-source.ts";
import { GENESIS } from "../../genesis/model/facts.ts";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

test("CompactSize covers every encoding boundary", () => {
  assert.equal(hex(compactSize(0xfc)), "fc");
  assert.equal(hex(compactSize(0xfd)), "fdfd00");
  assert.equal(hex(compactSize(0xffff)), "fdffff");
  assert.equal(hex(compactSize(0x1_0000)), "fe00000100");
  assert.equal(hex(compactSize(0xffff_ffff)), "feffffffff");
  assert.equal(hex(compactSize(0x1_0000_0000)), "ff0000000001000000");
  assert.throws(() => compactSize(-1));
});

test("transaction serialization is canonical non-witness Bitcoin encoding", () => {
  const bytes = serializeNonWitnessTransaction({
    txid: "0".repeat(64),
    version: 1,
    locktime: 0,
    vin: [{ txid: "0".repeat(64), vout: 0, scriptsig: "", sequence: 0xffff_ffff, isCoinbase: false }],
    vout: [{ value: 1, scriptpubkey: "51", scriptpubkeyType: "unknown" }],
    status: { confirmed: false },
  });
  assert.equal(
    hex(bytes),
    `0100000001${"00".repeat(32)}0000000000ffffffff010100000000000000015100000000`,
  );
});

test("bounded qscriptions failures map to the site recovery boundary", () => {
  const failure = (code: QpetError["code"], stage: QpetError["stage"]): QpetError => ({
    code,
    stage,
    retryable: false,
  });
  assert.deepEqual(recoveryFailureForQpet(failure("NOT_OP_RETURN", "script")), {
    code: "unsupported-script",
    stage: "decoding-envelope",
    retryable: false,
    diagnostic: "qscriptions:NOT_OP_RETURN",
  });
  assert.deepEqual(recoveryFailureForQpet(failure("INVALID_QPET_MAGIC", "envelope")), {
    code: "invalid-envelope",
    stage: "decoding-envelope",
    retryable: false,
    diagnostic: "qscriptions:INVALID_QPET_MAGIC",
  });
  assert.deepEqual(recoveryFailureForQpet(failure("INVALID_MANIFEST_SCHEMA", "manifest")), {
    code: "invalid-envelope",
    stage: "validating-manifest",
    retryable: false,
    diagnostic: "qscriptions:INVALID_MANIFEST_SCHEMA",
  });
  assert.deepEqual(recoveryFailureForQpet(failure("SPRITESHEET_HASH_MISMATCH", "body")), {
    code: "hash-mismatch",
    stage: "hashing-sheet",
    retryable: false,
    diagnostic: "qscriptions:SPRITESHEET_HASH_MISMATCH",
  });
});

test("explorer normalization rejects malformed identity and numeric fields", () => {
  const valid = {
    txid: "0".repeat(64),
    version: 2,
    locktime: 0,
    vin: [{ txid: "1".repeat(64), vout: 1, scriptsig: "", sequence: 1, is_coinbase: false }],
    vout: [{ value: 0, scriptpubkey: "6a00", scriptpubkey_type: "op_return" }],
    status: { confirmed: false },
  };
  assert.equal(validateExplorerTransaction(valid).version, 2);
  assert.throws(() => validateExplorerTransaction({ ...valid, version: "2" }));
  assert.throws(() => validateExplorerTransaction({ ...valid, version: [2] }));
  assert.throws(() => validateExplorerTransaction({ ...valid, txid: "not-a-hash" }));
  assert.throws(() => validateExplorerTransaction({ ...valid, locktime: -1 }));
  assert.throws(() => validateExplorerTransaction({ ...valid, vout: [] }));
});

test("blocked and malformed transaction sources fail closed before media exists", async () => {
  let attempts = 0;
  const blocked = await recoverGenesis(new AbortController().signal, () => {}, async () => {
    attempts += 1;
    throw new TypeError("blocked");
  });
  assert.deepEqual(blocked, {
    ok: false,
    error: { code: "network", stage: "fetching", retryable: true },
  });
  assert.equal(attempts, 2);

  const malformed = await recoverGenesis(new AbortController().signal, () => {}, async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.error.code, "malformed-transaction");
    assert.equal(malformed.error.stage, "locating-output");
  }
});

test("a stalled optional block attestation degrades to unknown on its own deadline", async () => {
  let probeSignal: AbortSignal | undefined;
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    probeSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      probeSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  };
  const lifecycle = new AbortController();
  const result = await fetchBlockHashAttestation(fetcher, {
    confirmed: true,
    blockHeight: GENESIS.blockHeight,
    blockHash: GENESIS.blockHash,
    blockTime: 1,
  }, lifecycle.signal, 1);

  assert.equal(result, null);
  assert.equal(probeSignal?.aborted, true);
  assert.equal(lifecycle.signal.aborted, false);
});
