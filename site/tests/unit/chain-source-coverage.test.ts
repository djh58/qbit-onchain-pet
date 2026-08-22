import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, vi } from "vitest";
import { GENESIS } from "../../genesis/model/facts.ts";
import type { ExplorerStatus, PetManifest } from "../../genesis/model/types.ts";
import {
  compactSize,
  fetchBlockHashAttestation,
  hexToBytes,
  readQpetPush,
  recoverGenesis,
  serializeNonWitnessTransaction,
  sha256Hex,
  transactionId,
  validateExplorerTransaction,
  validateQpetManifest,
  type ValidatedExplorerTransaction,
} from "../../genesis/services/chain-source.ts";

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixtureText = readFileSync(path.resolve(directory, "../fixtures/genesis-mainnet-esplora.json"), "utf8");
const fixture = JSON.parse(fixtureText) as Record<string, unknown> & {
  vout: Array<Record<string, unknown>>;
  status: Record<string, unknown>;
};
const originalEnvelope = readQpetPush(String(fixture.vout[0].scriptpubkey));
const manifestLength = originalEnvelope[5] | (originalEnvelope[6] << 8);
const originalManifest = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(originalEnvelope.slice(7, 7 + manifestLength)),
) as PetManifest;

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const textHeaders = { "content-type": "text/plain; charset=utf-8" };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function bytesFromHex(value: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(value, "hex")).buffer;
}

function invalidTransaction(value: unknown): void {
  assert.throws(() => validateExplorerTransaction(value));
}

function invalidManifest(value: unknown, sheetLength = GENESIS.sheetLength): void {
  assert.throws(() => validateQpetManifest(value, sheetLength));
}

function minimalTransaction(confirmed = false): Record<string, unknown> {
  return {
    txid: "0".repeat(64),
    version: 2,
    locktime: 0,
    vin: [{ txid: "1".repeat(64), vout: 1, scriptsig: "", sequence: 1, is_coinbase: false }],
    vout: [{ value: 0, scriptpubkey: "6a00", scriptpubkey_type: "op_return" }],
    status: confirmed
      ? { confirmed: true, block_height: 1, block_hash: "2".repeat(64), block_time: 1 }
      : { confirmed: false },
  };
}

function opReturnFor(envelope: Uint8Array): string {
  assert.ok(envelope.byteLength <= 0xffff);
  const length = new Uint8Array(2);
  new DataView(length.buffer).setUint16(0, envelope.byteLength, true);
  return `6a4d${hex(length)}${hex(envelope)}`;
}

function transactionWithEnvelope(envelope: Uint8Array): typeof fixture {
  const value = clone(fixture);
  value.vout[0].scriptpubkey = opReturnFor(envelope);
  return value;
}

function responseWithoutBody(bytes: Uint8Array, headers = jsonHeaders, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: null,
    arrayBuffer: async () => bytes.slice().buffer,
  } as unknown as Response;
}

function streamingResponse(
  chunks: readonly Uint8Array[],
  headers = jsonHeaders,
  onCancel?: () => void,
): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  }), { status: 200, headers });
}

function exactFetcher(
  transactionFactory: () => Response = () => new Response(fixtureText, { status: 200, headers: jsonHeaders }),
  blockFactory: () => Response = () => new Response(GENESIS.blockHash, { status: 200, headers: textHeaders }),
) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    return String(input).includes("/api/block-height/") ? blockFactory() : transactionFactory();
  };
}

async function recoverFromTransaction(
  value: unknown,
  blockFactory?: () => Response,
  signal = new AbortController().signal,
) {
  return recoverGenesis(
    signal,
    () => {},
    exactFetcher(
      () => new Response(JSON.stringify(value), { status: 200, headers: jsonHeaders }),
      blockFactory,
    ),
  );
}

async function withPinnedTransactionId<T>(
  operation: () => Promise<T>,
  options: Readonly<{ pinEnvelopeDigest?: boolean; pinSheetDigest?: boolean }> = {},
): Promise<T> {
  const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let call = 0;
  const spy = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    call += 1;
    if (call === 1) return new Uint8Array(32).buffer;
    if (call === 2) return Uint8Array.from(Buffer.from(GENESIS.transactionId, "hex")).reverse().buffer;
    if (call === 3 && options.pinEnvelopeDigest) return bytesFromHex(GENESIS.envelopeSha256);
    if (call === 4 && options.pinSheetDigest) return bytesFromHex(GENESIS.sheetSha256);
    return realDigest(algorithm, data);
  });
  try {
    return await operation();
  } finally {
    spy.mockRestore();
  }
}

describe.sequential("chain source exhaustive coverage", () => {
  test("covers primitive encodings, digests, and transaction serialization failures", async () => {
    assert.equal(hex(compactSize(0)), "00");
    assert.equal(compactSize(Number.MAX_SAFE_INTEGER).byteLength, 9);
    assert.throws(() => compactSize(Number.NaN), RangeError);
    assert.throws(() => compactSize(Number.MAX_SAFE_INTEGER + 1), RangeError);
    assert.throws(() => hexToBytes("0"), TypeError);
    assert.throws(() => hexToBytes("zz"), TypeError);
    assert.deepEqual(hexToBytes("Aa00"), new Uint8Array([0xaa, 0]));
    assert.deepEqual(hexToBytes(""), new Uint8Array());

    assert.equal(await sha256Hex(new TextEncoder().encode("qbit")), "c70d61b2695dc3c4d0fa58ffea95a8572efe3ffe5a9da40936933a284f7e4b35");
    const transaction = validateExplorerTransaction(minimalTransaction()) as ValidatedExplorerTransaction;
    const serialized = serializeNonWitnessTransaction(transaction);
    assert.ok(serialized.byteLength > 0);
    assert.equal((await transactionId(transaction)).bytes.byteLength, serialized.byteLength);
    assert.throws(() => serializeNonWitnessTransaction({
      ...transaction,
      vin: [{ ...transaction.vin[0], txid: "gg" }],
    }));
    assert.throws(() => serializeNonWitnessTransaction({
      ...transaction,
      vout: [{ ...transaction.vout[0], scriptpubkey: "0" }],
    }));
  });

  test("rejects every strict Esplora shape and scalar boundary independently", () => {
    const base = minimalTransaction();
    assert.equal(validateExplorerTransaction(base).status.confirmed, false);
    assert.equal(validateExplorerTransaction(minimalTransaction(true)).status.confirmed, true);

    for (const value of [null, 1, []]) invalidTransaction(value);
    for (const version of ["2", 1.5, -0x8000_0001, 0x8000_0000]) invalidTransaction({ ...base, version });
    for (const locktime of [Number.NaN, -1, 0x1_0000_0000]) invalidTransaction({ ...base, locktime });
    for (const txid of [1, "f".repeat(63), "F".repeat(64)]) invalidTransaction({ ...base, txid });
    for (const vin of [null, [], Array.from({ length: 1_025 }, () => (base.vin as unknown[])[0])]) {
      invalidTransaction({ ...base, vin });
    }
    for (const vout of [null, [], Array.from({ length: 1_025 }, () => (base.vout as unknown[])[0])]) {
      invalidTransaction({ ...base, vout });
    }

    const input = (base.vin as Array<Record<string, unknown>>)[0];
    for (const candidate of [null, 1, []]) invalidTransaction({ ...base, vin: [candidate] });
    invalidTransaction({ ...base, vin: [{ ...input, is_coinbase: 0 }] });
    invalidTransaction({ ...base, vin: [{ ...input, txid: null }] });
    invalidTransaction({ ...base, vin: [{ ...input, txid: "z".repeat(64) }] });
    invalidTransaction({ ...base, vin: [{ ...input, vout: -1 }] });
    invalidTransaction({ ...base, vin: [{ ...input, scriptsig: null }] });
    invalidTransaction({ ...base, vin: [{ ...input, scriptsig: "a".repeat(40_002) }] });
    invalidTransaction({ ...base, vin: [{ ...input, scriptsig: "a" }] });
    invalidTransaction({ ...base, vin: [{ ...input, scriptsig: "zz" }] });
    invalidTransaction({ ...base, vin: [{ ...input, sequence: 0x1_0000_0000 }] });
    const upperInput = validateExplorerTransaction({
      ...base,
      vin: [{ ...input, scriptsig: "AA" }],
    }).vin[0];
    assert.equal(upperInput.txid, "1".repeat(64));
    assert.equal(upperInput.scriptsig, "aa");

    const output = (base.vout as Array<Record<string, unknown>>)[0];
    for (const candidate of [null, 1, []]) invalidTransaction({ ...base, vout: [candidate] });
    invalidTransaction({ ...base, vout: [{ ...output, scriptpubkey_type: null }] });
    invalidTransaction({ ...base, vout: [{ ...output, scriptpubkey_type: "x".repeat(65) }] });
    invalidTransaction({ ...base, vout: [{ ...output, value: -1 }] });
    invalidTransaction({ ...base, vout: [{ ...output, value: Number.MAX_SAFE_INTEGER + 1 }] });
    invalidTransaction({ ...base, vout: [{ ...output, scriptpubkey: "x" }] });

    for (const status of [null, 1, []]) invalidTransaction({ ...base, status });
    invalidTransaction({ ...base, status: { confirmed: "yes" } });
    const confirmed = (minimalTransaction(true).status as Record<string, unknown>);
    invalidTransaction({ ...base, status: { ...confirmed, block_height: -1 } });
    invalidTransaction({ ...base, status: { ...confirmed, block_hash: "x".repeat(64) } });
    invalidTransaction({ ...base, status: { ...confirmed, block_time: -1 } });
  });

  test("covers every accepted and rejected historical OP_RETURN push path", () => {
    const bytes75 = new Uint8Array(75).fill(0xab);
    assert.deepEqual(readQpetPush(`6a4b${hex(bytes75)}`), bytes75);
    assert.deepEqual(readQpetPush("6a4c01aa"), new Uint8Array([0xaa]));
    assert.deepEqual(readQpetPush("6a4d0100aa"), new Uint8Array([0xaa]));
    assert.deepEqual(readQpetPush("6a4e01000000aa"), new Uint8Array([0xaa]));
    for (const script of ["zz", "0", "", "6a", "0000", "6a4c", "6a4d00", "6a4e000000", "6a4f", "6a00", "6a01", "6a01aabb"]) {
      assert.throws(() => readQpetPush(script));
    }
  });

  test("validates every manifest field, exact keyset, geometry, state, and sheet bound", () => {
    assert.equal(validateQpetManifest(clone(originalManifest), GENESIS.sheetLength).states.length, 9);
    for (const value of [null, 1, []]) invalidManifest(value);
    invalidManifest({ ...clone(originalManifest), extra: true });
    const wrongKeys = clone(originalManifest) as unknown as Record<string, unknown>;
    delete wrongKeys.author;
    wrongKeys.creator = "dan";
    invalidManifest(wrongKeys);

    for (const [field, value] of [
      ["format", "other"],
      ["id", null],
      ["id", "\ud800"],
      ["id", ""],
      ["id", "x".repeat(65)],
      ["displayName", ""],
      ["description", "x".repeat(2_001)],
      ["kind", ""],
      ["author", ""],
    ] as const) invalidManifest({ ...clone(originalManifest), [field]: value });
    assert.equal(validateQpetManifest({ ...clone(originalManifest), description: "" }, GENESIS.sheetLength).description, "");

    invalidManifest({ ...clone(originalManifest), frame: null });
    invalidManifest({ ...clone(originalManifest), frame: { ...originalManifest.frame, extra: true } });
    for (const [field, value] of [
      ["width", 0], ["width", 4_097], ["height", 0], ["columns", 0], ["rows", 0],
    ] as const) {
      invalidManifest({ ...clone(originalManifest), frame: { ...originalManifest.frame, [field]: value } });
    }
    invalidManifest({ ...clone(originalManifest), frame: { ...originalManifest.frame, width: 191 } });
    invalidManifest({ ...clone(originalManifest), frame: { ...originalManifest.frame, height: 207 } });

    invalidManifest({ ...clone(originalManifest), states: null });
    invalidManifest({ ...clone(originalManifest), states: originalManifest.states.slice(0, 8) });
    for (const candidate of [null, 1, [], { ...originalManifest.states[0], extra: true }]) {
      const states = clone(originalManifest.states) as unknown[];
      states[0] = candidate;
      invalidManifest({ ...clone(originalManifest), states });
    }
    const stateMutations: Array<Readonly<[string, unknown]>> = [
      ["id", ""], ["id", "\ud800"], ["row", 0.5], ["row", -1], ["row", 9],
      ["frames", 0], ["frames", 9], ["fps", 0], ["fps", 61], ["loop", "yes"],
    ];
    for (const [field, value] of stateMutations) {
      const states = clone(originalManifest.states) as unknown as Array<Record<string, unknown>>;
      states[0] = { ...states[0], [field]: value };
      invalidManifest({ ...clone(originalManifest), states });
    }
    const duplicateStates = clone(originalManifest.states) as unknown as Array<Record<string, unknown>>;
    duplicateStates[1] = { ...duplicateStates[1], id: duplicateStates[0].id };
    invalidManifest({ ...clone(originalManifest), states: duplicateStates });

    invalidManifest({ ...clone(originalManifest), sheet: null });
    invalidManifest({ ...clone(originalManifest), sheet: { ...originalManifest.sheet, extra: true } });
    invalidManifest({ ...clone(originalManifest), sheet: { ...originalManifest.sheet, contentType: "image/png" } });
    invalidManifest({ ...clone(originalManifest), sheet: { ...originalManifest.sheet, length: 1 } });
    invalidManifest(clone(originalManifest), GENESIS.sheetLength - 1);
    invalidManifest({ ...clone(originalManifest), sheet: { ...originalManifest.sheet, sha256: "0".repeat(64) } });
  });

  test("recovers the exact fixture and independently labels explorer evidence", async () => {
    const stages: string[] = [];
    const result = await recoverGenesis(
      new AbortController().signal,
      (stage) => stages.push(stage),
      exactFetcher(),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.envelopeDigest, GENESIS.envelopeSha256);
      assert.equal(result.value.sheetDigest, GENESIS.sheetSha256);
      assert.equal(result.value.chainEvidence.status, "confirmed");
      assert.equal(result.value.envelope.byteLength, GENESIS.envelopeLength);
      assert.equal(result.value.sheet.byteLength, GENESIS.sheetLength);
    }
    assert.deepEqual(stages, [
      "locating-output", "decoding-envelope", "validating-manifest", "hashing-envelope", "hashing-sheet", "attesting-block",
    ]);

    const unconfirmed = clone(fixture);
    unconfirmed.status = { confirmed: false };
    const degraded = await recoverFromTransaction(unconfirmed);
    assert.equal(degraded.ok && degraded.value.chainEvidence.status, "unknown");

    const globalFetch = vi.fn(exactFetcher());
    vi.stubGlobal("fetch", globalFetch);
    try {
      assert.equal((await recoverGenesis(new AbortController().signal, () => {})).ok, true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("handles retries, HTTP/content failures, bounded bodies, cancellation, and aborts", async () => {
    let attempts = 0;
    const retried = await recoverGenesis(new AbortController().signal, () => {}, async (input) => {
      if (String(input).includes("block-height")) return new Response(GENESIS.blockHash, { headers: textHeaders });
      attempts += 1;
      return attempts === 1
        ? new Response("busy", { status: 429 })
        : new Response(fixtureText, { status: 200, headers: jsonHeaders });
    });
    assert.equal(retried.ok, true);
    assert.equal(attempts, 2);

    for (const status of [404, 503]) {
      const result = await recoverGenesis(new AbortController().signal, () => {}, async () => new Response("no", { status }));
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "http");
        assert.equal(result.error.retryable, status >= 500);
        assert.equal(result.error.diagnostic, `HTTP ${status}`);
      }
    }

    for (const factory of [
      () => new Response(fixtureText, { status: 200, headers: textHeaders }),
      () => new Response("not json", { status: 200, headers: jsonHeaders }),
      () => new Response(new Uint8Array([0xff]), { status: 200, headers: jsonHeaders }),
    ]) {
      const result = await recoverGenesis(new AbortController().signal, () => {}, async () => factory());
      assert.equal(result.ok, false);
    }

    let declaredCancelled = false;
    const declaredBody = new ReadableStream<Uint8Array>({ cancel() { declaredCancelled = true; } });
    const declaredOversize = await recoverGenesis(new AbortController().signal, () => {}, async () => new Response(declaredBody, {
      status: 200,
      headers: { ...jsonHeaders, "content-length": String(400 * 1_024 + 1) },
    }));
    assert.equal(!declaredOversize.ok && declaredOversize.error.code, "oversize");
    assert.equal(declaredCancelled, true);

    let streamedCancelled = false;
    const huge = new Uint8Array(400 * 1_024 + 1);
    const hugeStream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(huge); },
      cancel() { streamedCancelled = true; },
    });
    const streamedOversize = await recoverGenesis(
      new AbortController().signal,
      () => {},
      async () => new Response(hugeStream, { headers: jsonHeaders }),
    );
    assert.equal(!streamedOversize.ok && streamedOversize.error.code, "oversize");
    assert.equal(streamedCancelled, true);

    const bodylessSuccess = await recoverGenesis(
      new AbortController().signal,
      () => {},
      exactFetcher(() => responseWithoutBody(new TextEncoder().encode(fixtureText))),
    );
    assert.equal(bodylessSuccess.ok, true);
    const bodylessOversize = await recoverGenesis(
      new AbortController().signal,
      () => {},
      async () => responseWithoutBody(new Uint8Array(400 * 1_024 + 1)),
    );
    assert.equal(!bodylessOversize.ok && bodylessOversize.error.code, "oversize");

    const aborted = new AbortController();
    aborted.abort();
    const abortedResult = await recoverGenesis(
      aborted.signal,
      () => {},
      async () => streamingResponse([new TextEncoder().encode(fixtureText)]),
    );
    assert.equal(!abortedResult.ok && abortedResult.error.code, "timeout");

    const cancelThrows = {
      ok: false,
      status: 404,
      headers: new Headers(),
      body: { cancel: async () => { throw new Error("cancel refused"); } },
    } as unknown as Response;
    const cancelFailure = await recoverGenesis(new AbortController().signal, () => {}, async () => cancelThrows);
    assert.equal(!cancelFailure.ok && cancelFailure.error.code, "http");

    const abortFailure = await recoverGenesis(new AbortController().signal, () => {}, async () => {
      throw new DOMException("aborted", "AbortError");
    });
    assert.equal(!abortFailure.ok && abortFailure.error.code, "timeout");
  });

  test("reports every pinned transaction, output, envelope, manifest, and hash failure stage", async () => {
    const reportedMismatch = clone(fixture);
    reportedMismatch.txid = "0".repeat(64);
    const reportedResult = await recoverFromTransaction(reportedMismatch);
    assert.equal(!reportedResult.ok && reportedResult.error.code, "txid-mismatch");

    const computedMismatch = clone(fixture);
    computedMismatch.version = 1;
    const computedResult = await recoverFromTransaction(computedMismatch);
    assert.equal(!computedResult.ok && computedResult.error.code, "txid-mismatch");

    for (const mutation of [
      (value: typeof fixture) => { value.vout[0].value = 1; },
      (value: typeof fixture) => { value.vout[0].scriptpubkey_type = "unknown"; },
    ]) {
      const value = clone(fixture);
      mutation(value);
      const result = await withPinnedTransactionId(() => recoverFromTransaction(value));
      assert.equal(!result.ok && result.error.code, "unsupported-script");
    }

    const invalidEnvelopes: Uint8Array[] = [];
    invalidEnvelopes.push(originalEnvelope.slice(0, -1));
    for (let index = 0; index < 5; index += 1) {
      const bytes = originalEnvelope.slice();
      bytes[index] ^= 0xff;
      invalidEnvelopes.push(bytes);
    }
    const tinyManifest = originalEnvelope.slice();
    tinyManifest[5] = 1;
    tinyManifest[6] = 0;
    invalidEnvelopes.push(tinyManifest);
    const noSheet = originalEnvelope.slice();
    new DataView(noSheet.buffer, noSheet.byteOffset, noSheet.byteLength).setUint16(5, noSheet.byteLength - 7, true);
    invalidEnvelopes.push(noSheet);
    const invalidJson = originalEnvelope.slice();
    invalidJson[7] = 0xff;
    invalidEnvelopes.push(invalidJson);
    for (const envelope of invalidEnvelopes) {
      const result = await withPinnedTransactionId(() => recoverFromTransaction(transactionWithEnvelope(envelope)));
      assert.equal(!result.ok && result.error.code, "invalid-envelope");
    }

    const invalidManifestEnvelope = originalEnvelope.slice();
    const formatOffset = Buffer.from(invalidManifestEnvelope).indexOf(Buffer.from("codex-pet-v1"));
    assert.ok(formatOffset > 0);
    invalidManifestEnvelope[formatOffset] = "x".charCodeAt(0);
    const invalidManifestResult = await withPinnedTransactionId(
      () => recoverFromTransaction(transactionWithEnvelope(invalidManifestEnvelope)),
    );
    assert.equal(!invalidManifestResult.ok && invalidManifestResult.error.code, "invalid-envelope");

    const mutatedSheet = originalEnvelope.slice();
    mutatedSheet[mutatedSheet.length - 1] ^= 1;
    const envelopeHashFailure = await withPinnedTransactionId(
      () => recoverFromTransaction(transactionWithEnvelope(mutatedSheet)),
    );
    assert.equal(!envelopeHashFailure.ok && envelopeHashFailure.error.code, "hash-mismatch");
    assert.equal(!envelopeHashFailure.ok && envelopeHashFailure.error.stage, "hashing-envelope");

    const sheetHashFailure = await withPinnedTransactionId(
      () => recoverFromTransaction(transactionWithEnvelope(mutatedSheet)),
      { pinEnvelopeDigest: true },
    );
    assert.equal(!sheetHashFailure.ok && sheetHashFailure.error.code, "hash-mismatch");
    assert.equal(!sheetHashFailure.ok && sheetHashFailure.error.stage, "hashing-sheet");

    const internal = await recoverGenesis(new AbortController().signal, () => { throw new Error("reporter failed"); }, exactFetcher());
    assert.equal(!internal.ok && internal.error.code, "internal");
  });

  test("covers block attestation early exits, bodies, bounds, failures, and lifecycle cancellation", async () => {
    const confirmed: ExplorerStatus = {
      confirmed: true,
      blockHeight: GENESIS.blockHeight,
      blockHash: GENESIS.blockHash,
      blockTime: 1,
    };
    const never = async (): Promise<Response> => { throw new Error("should not fetch"); };
    assert.equal(await fetchBlockHashAttestation(never, { confirmed: false }), null);
    assert.equal(await fetchBlockHashAttestation(never, { ...confirmed, blockHeight: 1 }), null);
    assert.equal(await fetchBlockHashAttestation(never, { ...confirmed, blockHash: "0".repeat(64) }), null);

    assert.equal(await fetchBlockHashAttestation(async () => new Response(GENESIS.blockHash, { headers: textHeaders }), confirmed), GENESIS.blockHash);
    assert.equal(await fetchBlockHashAttestation(async () => responseWithoutBody(new TextEncoder().encode(` ${GENESIS.blockHash}\n`), textHeaders), confirmed), GENESIS.blockHash);
    assert.equal(await fetchBlockHashAttestation(async () => responseWithoutBody(new Uint8Array(129), textHeaders), confirmed), null);
    assert.equal(await fetchBlockHashAttestation(async () => new Response("no", { status: 503 }), confirmed), null);
    assert.equal(await fetchBlockHashAttestation(async () => new Response("x", {
      status: 200,
      headers: { ...textHeaders, "content-length": "129" },
    }), confirmed), null);

    let cancelled = false;
    const oversizedAttestation = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(129)); },
      cancel() { cancelled = true; },
    });
    assert.equal(await fetchBlockHashAttestation(
      async () => new Response(oversizedAttestation, { headers: textHeaders }),
      confirmed,
    ), null);
    assert.equal(cancelled, true);
    assert.equal(await fetchBlockHashAttestation(async () => new Response("not-a-hash", { headers: textHeaders }), confirmed), null);
    assert.equal(await fetchBlockHashAttestation(async () => new Response(new Uint8Array([0xff]), { headers: textHeaders }), confirmed), null);
    assert.equal(await fetchBlockHashAttestation(async () => { throw new TypeError("offline"); }, confirmed), null);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    let observedAborted = false;
    assert.equal(await fetchBlockHashAttestation(async (_input, init) => {
      observedAborted = Boolean(init?.signal?.aborted);
      throw new DOMException("aborted", "AbortError");
    }, confirmed, alreadyAborted.signal), null);
    assert.equal(observedAborted, true);

    const lifecycle = new AbortController();
    const pending = fetchBlockHashAttestation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }), confirmed, lifecycle.signal, 1_000);
    lifecycle.abort();
    assert.equal(await pending, null);
  });
});
