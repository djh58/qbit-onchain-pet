import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, vi } from "vitest";
import { extractQpetEnvelope, type QpetArtifact, type QpetManifest } from "qscriptions";
import { GENESIS } from "../../genesis/model/facts.ts";
import type { ExplorerStatus } from "../../genesis/model/types.ts";
import {
  assertGenesisBodyIdentity,
  assertGenesisEnvelopeIdentity,
  compactSize,
  fetchBlockHashAttestation,
  hexToBytes,
  recoverGenesis,
  serializeNonWitnessTransaction,
  transactionId,
  validateExplorerTransaction,
  type ValidatedExplorerTransaction,
} from "../../genesis/services/chain-source.ts";

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixtureText = readFileSync(path.resolve(directory, "../fixtures/genesis-mainnet-esplora.json"), "utf8");
const fixture = JSON.parse(fixtureText) as Record<string, unknown> & {
  vout: Array<Record<string, unknown>>;
  status: Record<string, unknown>;
};
const extractedFixture = extractQpetEnvelope(hexToBytes(String(fixture.vout[0].scriptpubkey)));
assert.ok(extractedFixture.ok);
const originalEnvelope = extractedFixture.value;
const manifestLength = originalEnvelope[5] | (originalEnvelope[6] << 8);
const originalManifest = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(originalEnvelope.slice(7, 7 + manifestLength)),
) as QpetManifest;

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const textHeaders = { "content-type": "text/plain; charset=utf-8" };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function invalidTransaction(value: unknown): void {
  assert.throws(() => validateExplorerTransaction(value));
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

function encodedEnvelope(manifest: QpetManifest, body = originalEnvelope.slice(7 + manifestLength)): Uint8Array {
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const result = new Uint8Array(7 + manifestBytes.byteLength + body.byteLength);
  result.set(new TextEncoder().encode("QPET"), 0);
  result[4] = 1;
  new DataView(result.buffer).setUint16(5, manifestBytes.byteLength, true);
  result.set(manifestBytes, 7);
  result.set(body, 7 + manifestBytes.byteLength);
  return result;
}

function artifactWith(qpet: QpetArtifact, overrides: Record<string, unknown>): QpetArtifact {
  const envelopeBytes = overrides.envelopeBytes instanceof Uint8Array
    ? overrides.envelopeBytes
    : qpet.envelopeBytes;
  const bodyBytes = overrides.bodyBytes instanceof Uint8Array
    ? overrides.bodyBytes
    : qpet.bodyBytes;
  return {
    ...qpet,
    ...overrides,
    get envelopeBytes() {
      return envelopeBytes.slice();
    },
    get bodyBytes() {
      return bodyBytes.slice();
    },
  } as unknown as QpetArtifact;
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
): Promise<T> {
  const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let call = 0;
  const spy = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    call += 1;
    if (call === 1) return new Uint8Array(32).buffer;
    if (call === 2) return Uint8Array.from(Buffer.from(GENESIS.transactionId, "hex")).reverse().buffer;
    return realDigest(algorithm, data);
  });
  try {
    return await operation();
  } finally {
    spy.mockRestore();
  }
}

describe.sequential("chain source exhaustive coverage", () => {
  test("covers primitive encodings and transaction serialization failures", async () => {
    assert.equal(hex(compactSize(0)), "00");
    assert.equal(compactSize(Number.MAX_SAFE_INTEGER).byteLength, 9);
    assert.throws(() => compactSize(Number.NaN), RangeError);
    assert.throws(() => compactSize(Number.MAX_SAFE_INTEGER + 1), RangeError);
    assert.throws(() => hexToBytes("0"), TypeError);
    assert.throws(() => hexToBytes("zz"), TypeError);
    assert.deepEqual(hexToBytes("Aa00"), new Uint8Array([0xaa, 0]));
    assert.deepEqual(hexToBytes(""), new Uint8Array());

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

  test("recovers the exact fixture and independently labels explorer evidence", async () => {
    const stages: string[] = [];
    const result = await recoverGenesis(
      new AbortController().signal,
      (stage) => stages.push(stage),
      exactFetcher(),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.qpet.hashes.envelopeSha256, GENESIS.envelopeSha256);
      assert.equal(result.value.qpet.bodySha256, GENESIS.sheetSha256);
      assert.equal(result.value.chainEvidence.status, "confirmed");
      assert.equal(result.value.qpet.envelopeBytes.byteLength, GENESIS.envelopeLength);
      assert.equal(result.value.qpet.bodyBytes.byteLength, GENESIS.sheetLength);
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

  test("reports transaction, output, package decode, Genesis identity, and platform failures", async () => {
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

    const unsupportedPush = clone(fixture);
    unsupportedPush.vout[0].scriptpubkey = "6a4f";
    const unsupportedPushResult = await withPinnedTransactionId(() => recoverFromTransaction(unsupportedPush));
    assert.equal(!unsupportedPushResult.ok && unsupportedPushResult.error.code, "unsupported-script");

    const truncatedResult = await withPinnedTransactionId(
      () => recoverFromTransaction(transactionWithEnvelope(new TextEncoder().encode("QPET"))),
    );
    assert.equal(!truncatedResult.ok && truncatedResult.error.code, "invalid-envelope");
    assert.equal(!truncatedResult.ok && truncatedResult.error.stage, "decoding-envelope");

    const invalidManifest = { ...clone(originalManifest), format: "other" } as unknown as QpetManifest;
    const invalidManifestResult = await withPinnedTransactionId(
      () => recoverFromTransaction(transactionWithEnvelope(encodedEnvelope(invalidManifest))),
    );
    assert.equal(!invalidManifestResult.ok && invalidManifestResult.error.code, "invalid-envelope");
    assert.equal(!invalidManifestResult.ok && invalidManifestResult.error.stage, "validating-manifest");

    const mutatedSheet = originalEnvelope.slice();
    mutatedSheet[mutatedSheet.length - 1] ^= 1;
    const sheetHashFailure = await withPinnedTransactionId(
      () => recoverFromTransaction(transactionWithEnvelope(mutatedSheet)),
    );
    assert.equal(!sheetHashFailure.ok && sheetHashFailure.error.code, "hash-mismatch");
    assert.equal(!sheetHashFailure.ok && sheetHashFailure.error.stage, "hashing-sheet");

    const otherValidEnvelope = encodedEnvelope({
      ...clone(originalManifest),
      description: "A different but internally valid QPET.",
    });
    const envelopeHashFailure = await withPinnedTransactionId(
      () => recoverFromTransaction(transactionWithEnvelope(otherValidEnvelope)),
    );
    assert.equal(!envelopeHashFailure.ok && envelopeHashFailure.error.code, "hash-mismatch");
    assert.equal(!envelopeHashFailure.ok && envelopeHashFailure.error.stage, "hashing-envelope");

    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let digestCall = 0;
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      digestCall += 1;
      if (digestCall === 3) throw new Error("platform digest unavailable");
      return realDigest(algorithm, data);
    });
    const platformFailure = await recoverFromTransaction(fixture);
    digestSpy.mockRestore();
    assert.equal(!platformFailure.ok && platformFailure.error.code, "internal");
    assert.equal(!platformFailure.ok && platformFailure.error.stage, "validating-manifest");

    const internal = await recoverGenesis(new AbortController().signal, () => { throw new Error("reporter failed"); }, exactFetcher());
    assert.equal(!internal.ok && internal.error.code, "internal");
  });

  test("pins every Genesis artifact identity field before media handoff", async () => {
    const recovered = await recoverGenesis(new AbortController().signal, () => {}, exactFetcher());
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    const { qpet } = recovered.value;

    assert.doesNotThrow(() => assertGenesisEnvelopeIdentity(qpet));
    assert.doesNotThrow(() => assertGenesisBodyIdentity(qpet));

    for (const overrides of [
      { wireFormat: "OTHER" },
      { wireVersion: 2 },
      { profile: "other/qpet" },
      { contentId: `qscr:sha256:${"0".repeat(64)}` },
      { hashes: { ...qpet.hashes, envelopeSha256: "0".repeat(64) } },
      { envelopeBytes: new Uint8Array(GENESIS.envelopeLength - 1) },
    ]) {
      assert.throws(() => assertGenesisEnvelopeIdentity(artifactWith(qpet, overrides)), /hash-mismatch/);
    }

    const manifestCases: Record<string, unknown>[] = [
      { bodyLength: GENESIS.sheetLength - 1 },
      { bodySha256: "0".repeat(64) },
      { hashes: { ...qpet.hashes, sheetSha256: "0".repeat(64) } },
      { bodyBytes: new Uint8Array(GENESIS.sheetLength - 1) },
      { manifest: { ...qpet.manifest, format: "other" } },
      { manifest: { ...qpet.manifest, id: "other" } },
      { manifest: { ...qpet.manifest, displayName: "Other" } },
      { manifest: { ...qpet.manifest, kind: "creature" } },
      { manifest: { ...qpet.manifest, author: "other" } },
      { manifest: { ...qpet.manifest, frame: { ...qpet.manifest.frame, width: GENESIS.frameWidth - 1 } } },
      { manifest: { ...qpet.manifest, frame: { ...qpet.manifest.frame, height: GENESIS.frameHeight - 1 } } },
      { manifest: { ...qpet.manifest, frame: { ...qpet.manifest.frame, columns: 7 } } },
      { manifest: { ...qpet.manifest, frame: { ...qpet.manifest.frame, rows: 8 } } },
      { manifest: { ...qpet.manifest, sheet: { ...qpet.manifest.sheet, contentType: "image/png" } } },
      { manifest: { ...qpet.manifest, sheet: { ...qpet.manifest.sheet, length: GENESIS.sheetLength - 1 } } },
      { manifest: { ...qpet.manifest, sheet: { ...qpet.manifest.sheet, sha256: "0".repeat(64) } } },
      { manifest: { ...qpet.manifest, states: qpet.manifest.states.slice(0, -1) } },
    ];
    for (const [field, value] of [
      ["id", "other"],
      ["row", 1],
      ["frames", 5],
      ["fps", 5],
      ["loop", false],
    ] as const) {
      const states = qpet.manifest.states.map((state, index) => index === 0
        ? { ...state, [field]: value }
        : state);
      manifestCases.push({ manifest: { ...qpet.manifest, states } });
    }
    for (const overrides of manifestCases) {
      assert.throws(() => assertGenesisBodyIdentity(artifactWith(qpet, overrides)), /hash-mismatch/);
    }
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
