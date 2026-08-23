import {
  decodeQpetEnvelope,
  extractQpetEnvelope,
  type QpetArtifact,
  type QpetError,
  type QpetState,
} from "qscriptions";
import { EXPLORER_ORIGIN, GENESIS } from "../model/facts";
import type { ProofStage, RecoveryFailure } from "../model/recovery";
import type { ChainEvidence, ExplorerStatus, RecoveredGenesis } from "../model/types";

// Private Genesis integration adapter, not a second public QPET API. The
// package proves QPET byte consistency; this module owns source, transaction,
// exact Genesis identity, chain attestation, and media handoff.

const MAX_RESPONSE_BYTES = 400 * 1024;
const MAX_SCRIPT_HEX_CHARACTERS = 40_000;
const MAX_INPUTS = 1_024;
const MAX_OUTPUTS = 1_024;
const ATTESTATION_TIMEOUT_MS = 2_000;
const HEX_64 = /^[0-9a-f]{64}$/;
const GENESIS_CONTENT_ID = `qscr:sha256:${GENESIS.envelopeSha256}` as const;
const GENESIS_STATES: readonly QpetState[] = Object.freeze([
  Object.freeze({ id: "idle", row: 0, frames: 6, fps: 6, loop: true }),
  Object.freeze({ id: "running-right", row: 1, frames: 8, fps: 12, loop: true }),
  Object.freeze({ id: "running-left", row: 2, frames: 8, fps: 12, loop: true }),
  Object.freeze({ id: "waving", row: 3, frames: 4, fps: 5, loop: false }),
  Object.freeze({ id: "jumping", row: 4, frames: 5, fps: 14, loop: false }),
  Object.freeze({ id: "failed", row: 5, frames: 8, fps: 6, loop: false }),
  Object.freeze({ id: "waiting", row: 6, frames: 6, fps: 4, loop: true }),
  Object.freeze({ id: "running", row: 7, frames: 6, fps: 12, loop: true }),
  Object.freeze({ id: "review", row: 8, frames: 6, fps: 6, loop: true }),
]);

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type EsploraInput = Readonly<{
  txid: string;
  vout: number;
  scriptsig: string;
  sequence: number;
  isCoinbase: boolean;
}>;

type EsploraOutput = Readonly<{
  value: number;
  scriptpubkey: string;
  scriptpubkeyType: string;
}>;

export type ValidatedExplorerTransaction = Readonly<{
  txid: string;
  version: number;
  locktime: number;
  vin: readonly EsploraInput[];
  vout: readonly EsploraOutput[];
  status: ExplorerStatus;
}>;

export type RecoveryResult =
  | Readonly<{ ok: true; value: RecoveredGenesis }>
  | Readonly<{ ok: false; error: RecoveryFailure }>;

type StageReporter = (stage: ProofStage) => void;

class ExpectedFailure extends Error {
  readonly failure: RecoveryFailure;

  constructor(failure: RecoveryFailure) {
    super(failure.code);
    this.failure = failure;
  }
}

function fail(code: RecoveryFailure["code"], stage: ProofStage, retryable: boolean, diagnostic?: string): never {
  throw new ExpectedFailure(diagnostic === undefined
    ? { code, stage, retryable }
    : { code, stage, retryable, diagnostic });
}

function expectObject(value: unknown, stage: ProofStage): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("malformed-transaction", stage, false);
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, stage: ProofStage, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) fail("malformed-transaction", stage, false);
  return value;
}

function expectUnsignedInteger(value: unknown, stage: ProofStage, maximum = 0xffff_ffff): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    fail("malformed-transaction", stage, false);
  }
  return Number(value);
}

function expectHex(value: unknown, stage: ProofStage, maximumCharacters = MAX_SCRIPT_HEX_CHARACTERS): string {
  if (
    typeof value !== "string" ||
    value.length > maximumCharacters ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]*$/i.test(value)
  ) {
    fail("malformed-transaction", stage, false);
  }
  return value.toLowerCase();
}

function expectHash(value: unknown, stage: ProofStage): string {
  if (typeof value !== "string" || !HEX_64.test(value)) fail("malformed-transaction", stage, false);
  return value;
}

export function validateExplorerTransaction(value: unknown): ValidatedExplorerTransaction {
  const stage: ProofStage = "locating-output";
  const transaction = expectObject(value, stage);
  const version = transaction.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < -0x8000_0000 || version > 0x7fff_ffff) {
    fail("malformed-transaction", stage, false);
  }
  const locktime = expectUnsignedInteger(transaction.locktime, stage);
  const txid = expectHash(transaction.txid, stage);
  const vin = expectArray(transaction.vin, stage, MAX_INPUTS).map((candidate) => {
    const input = expectObject(candidate, stage);
    if (typeof input.is_coinbase !== "boolean") fail("malformed-transaction", stage, false);
    return Object.freeze({
      txid: expectHash(input.txid, stage),
      vout: expectUnsignedInteger(input.vout, stage),
      scriptsig: expectHex(input.scriptsig, stage),
      sequence: expectUnsignedInteger(input.sequence, stage),
      isCoinbase: input.is_coinbase,
    });
  });
  const vout = expectArray(transaction.vout, stage, MAX_OUTPUTS).map((candidate) => {
    const output = expectObject(candidate, stage);
    if (typeof output.scriptpubkey_type !== "string" || output.scriptpubkey_type.length > 64) {
      fail("malformed-transaction", stage, false);
    }
    return Object.freeze({
      value: expectUnsignedInteger(output.value, stage, Number.MAX_SAFE_INTEGER),
      scriptpubkey: expectHex(output.scriptpubkey, stage),
      scriptpubkeyType: output.scriptpubkey_type,
    });
  });
  const rawStatus = expectObject(transaction.status, stage);
  if (typeof rawStatus.confirmed !== "boolean") fail("malformed-transaction", stage, false);
  const status: ExplorerStatus = rawStatus.confirmed
    ? Object.freeze({
        confirmed: true,
        blockHeight: expectUnsignedInteger(rawStatus.block_height, stage, 0x7fff_ffff),
        blockHash: expectHash(rawStatus.block_hash, stage),
        blockTime: expectUnsignedInteger(rawStatus.block_time, stage, Number.MAX_SAFE_INTEGER),
      })
    : Object.freeze({ confirmed: false });

  return Object.freeze({ txid, version, locktime, vin, vout, status });
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function uint32LittleEndian(value: number, signed = false): Uint8Array {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  if (signed) view.setInt32(0, value, true);
  else view.setUint32(0, value, true);
  return bytes;
}

function uint64LittleEndian(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

export function compactSize(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("CompactSize value is invalid.");
  if (value < 0xfd) return new Uint8Array([value]);
  if (value <= 0xffff) {
    const bytes = new Uint8Array(3);
    bytes[0] = 0xfd;
    new DataView(bytes.buffer).setUint16(1, value, true);
    return bytes;
  }
  if (value <= 0xffff_ffff) return concatBytes([new Uint8Array([0xfe]), uint32LittleEndian(value)]);
  const bytes = new Uint8Array(9);
  bytes[0] = 0xff;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(value), true);
  return bytes;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new TypeError("Hex string is invalid.");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function serializeNonWitnessTransaction(transaction: ValidatedExplorerTransaction): Uint8Array {
  const chunks: Uint8Array[] = [uint32LittleEndian(transaction.version, true), compactSize(transaction.vin.length)];
  for (const input of transaction.vin) {
    const previousTxid = hexToBytes(input.txid).reverse();
    const script = hexToBytes(input.scriptsig);
    chunks.push(previousTxid, uint32LittleEndian(input.vout), compactSize(script.byteLength), script, uint32LittleEndian(input.sequence));
  }
  chunks.push(compactSize(transaction.vout.length));
  for (const output of transaction.vout) {
    const script = hexToBytes(output.scriptpubkey);
    chunks.push(uint64LittleEndian(output.value), compactSize(script.byteLength), script);
  }
  chunks.push(uint32LittleEndian(transaction.locktime));
  return concatBytes(chunks);
}

async function transactionSha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return new Uint8Array(digest);
}

export async function transactionId(transaction: ValidatedExplorerTransaction): Promise<Readonly<{ id: string; bytes: Uint8Array }>> {
  const bytes = serializeNonWitnessTransaction(transaction);
  const digest = await transactionSha256(await transactionSha256(bytes));
  return Object.freeze({
    id: Array.from(digest.reverse(), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    bytes,
  });
}

export function recoveryFailureForQpet(error: QpetError): RecoveryFailure {
  if (error.code === "SPRITESHEET_HASH_MISMATCH") {
    return Object.freeze({
      code: "hash-mismatch",
      stage: "hashing-sheet",
      retryable: false,
      diagnostic: `qscriptions:${error.code}`,
    });
  }
  if (error.stage === "input" || error.stage === "script") {
    return Object.freeze({
      code: "unsupported-script",
      stage: "decoding-envelope",
      retryable: false,
      diagnostic: `qscriptions:${error.code}`,
    });
  }
  return Object.freeze({
    code: "invalid-envelope",
    stage: error.stage === "envelope" ? "decoding-envelope" : "validating-manifest",
    retryable: false,
    diagnostic: `qscriptions:${error.code}`,
  });
}

function failQpet(error: QpetError): never {
  throw new ExpectedFailure(recoveryFailureForQpet(error));
}

function stateMatches(candidate: QpetState, expected: QpetState): boolean {
  return candidate.id === expected.id &&
    candidate.row === expected.row &&
    candidate.frames === expected.frames &&
    candidate.fps === expected.fps &&
    candidate.loop === expected.loop;
}

export function assertGenesisEnvelopeIdentity(qpet: QpetArtifact): void {
  if (
    qpet.wireFormat !== "QPET" ||
    qpet.wireVersion !== 1 ||
    qpet.profile !== "legacy/qpet-v1" ||
    qpet.contentId !== GENESIS_CONTENT_ID ||
    qpet.hashes.envelopeSha256 !== GENESIS.envelopeSha256 ||
    qpet.envelopeBytes.byteLength !== GENESIS.envelopeLength
  ) {
    fail("hash-mismatch", "hashing-envelope", false);
  }
}

export function assertGenesisBodyIdentity(qpet: QpetArtifact): void {
  const { frame, sheet, states } = qpet.manifest;
  if (
    qpet.bodyLength !== GENESIS.sheetLength ||
    qpet.bodySha256 !== GENESIS.sheetSha256 ||
    qpet.hashes.sheetSha256 !== GENESIS.sheetSha256 ||
    qpet.bodyBytes.byteLength !== GENESIS.sheetLength ||
    qpet.manifest.format !== "codex-pet-v1" ||
    qpet.manifest.id !== "qbit" ||
    qpet.manifest.displayName !== "Qbit" ||
    qpet.manifest.kind !== "object" ||
    qpet.manifest.author !== "dan" ||
    frame.width !== GENESIS.frameWidth ||
    frame.height !== GENESIS.frameHeight ||
    frame.columns !== GENESIS.sheetWidth / GENESIS.frameWidth ||
    frame.rows !== GENESIS.sheetHeight / GENESIS.frameHeight ||
    sheet.contentType !== "image/webp" ||
    sheet.length !== GENESIS.sheetLength ||
    sheet.sha256 !== GENESIS.sheetSha256 ||
    states.length !== GENESIS_STATES.length ||
    !states.every((state, index) => stateMatches(state, GENESIS_STATES[index]!))
  ) {
    fail("hash-mismatch", "hashing-sheet", false);
  }
}

async function readBoundedText(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    fail("oversize", "fetching", false);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) fail("oversize", "fetching", false);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail("oversize", "fetching", false);
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(concatBytes(chunks));
  } catch {
    fail("malformed-transaction", "fetching", false);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is being rejected; body cancellation is best-effort cleanup.
  }
}

async function fetchTransaction(fetcher: FetchLike, signal: AbortSignal): Promise<unknown> {
  const url = `${EXPLORER_ORIGIN}/api/tx/${GENESIS.transactionId}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetcher(url, {
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal,
      });
      const retryableStatus = response.status === 429 || response.status >= 500;
      if (!response.ok) {
        await cancelResponseBody(response);
        if (retryableStatus && attempt === 0) continue;
        fail("http", "fetching", retryableStatus, `HTTP ${response.status}`);
      }
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        await cancelResponseBody(response);
        fail("malformed-transaction", "fetching", false);
      }
      const text = await readBoundedText(response, signal);
      try {
        return JSON.parse(text);
      } catch {
        fail("malformed-transaction", "fetching", false);
      }
    } catch (error) {
      if (error instanceof ExpectedFailure) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (attempt === 0) continue;
      fail("network", "fetching", true);
    }
  }
}

/** @internal Application-source probe; not part of the QPET byte decoder. */
export async function fetchBlockHashAttestation(
  fetcher: FetchLike,
  status: ExplorerStatus,
  lifecycleSignal?: AbortSignal,
  timeoutMs = ATTESTATION_TIMEOUT_MS,
): Promise<string | null> {
  if (
    !status.confirmed ||
    status.blockHeight !== GENESIS.blockHeight ||
    status.blockHash !== GENESIS.blockHash
  ) {
    return null;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = globalThis.setTimeout(abort, timeoutMs);
  if (lifecycleSignal?.aborted) abort();
  else lifecycleSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetcher(`${EXPLORER_ORIGIN}/api/block-height/${GENESIS.blockHeight}`, {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "text/plain" },
      redirect: "error",
      signal: controller.signal,
    });
    const declared = Number(response.headers.get("content-length"));
    if (!response.ok || (Number.isFinite(declared) && declared > 128)) {
      await cancelResponseBody(response);
      return null;
    }
    let text: string;
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 128) return null;
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } else {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 128) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      text = new TextDecoder("utf-8", { fatal: true }).decode(concatBytes(chunks));
    }
    const hash = text.trim();
    return HEX_64.test(hash) ? hash : null;
  } catch {
    // Byte identity can still be proven when the optional locator check fails.
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
    lifecycleSignal?.removeEventListener("abort", abort);
  }
}

function evidenceFor(status: ExplorerStatus, attestedBlockHash: string | null): ChainEvidence {
  const exactLocator =
    status.confirmed &&
    status.blockHeight === GENESIS.blockHeight &&
    status.blockHash === GENESIS.blockHash &&
    attestedBlockHash === GENESIS.blockHash;
  return exactLocator
    ? Object.freeze({
        status: "confirmed" as const,
        sourceId: GENESIS.sourceId,
        detail: `confirmed, reported by ${GENESIS.sourceId}`,
      })
    : Object.freeze({
        status: "unknown" as const,
        sourceId: GENESIS.sourceId,
        detail: "bytes verified; current block status unavailable",
      });
}

export async function recoverGenesis(
  signal: AbortSignal,
  reportStage: StageReporter,
  fetcher: FetchLike = globalThis.fetch,
  lifecycleSignal?: AbortSignal,
): Promise<RecoveryResult> {
  let stage: ProofStage = "fetching";
  try {
    const raw = await fetchTransaction(fetcher, signal);
    stage = "locating-output";
    reportStage(stage);
    const transaction = validateExplorerTransaction(raw);
    if (transaction.txid !== GENESIS.transactionId) fail("txid-mismatch", stage, false);
    const identity = await transactionId(transaction);
    if (identity.id !== GENESIS.transactionId) fail("txid-mismatch", stage, false);
    // validateExplorerTransaction requires at least one output, and the
    // build-time Genesis facts require outputIndex === 0.
    const output = transaction.vout[GENESIS.outputIndex]!;
    if (output.value !== 0 || output.scriptpubkeyType !== "op_return") {
      fail("unsupported-script", stage, false);
    }

    stage = "decoding-envelope";
    reportStage(stage);
    const extracted = extractQpetEnvelope(hexToBytes(output.scriptpubkey));
    if (!extracted.ok) failQpet(extracted.error);

    stage = "validating-manifest";
    reportStage(stage);
    const decoded = await decodeQpetEnvelope(extracted.value);
    if (!decoded.ok) failQpet(decoded.error);
    const qpet = decoded.value;

    stage = "hashing-envelope";
    reportStage(stage);
    assertGenesisEnvelopeIdentity(qpet);

    stage = "hashing-sheet";
    reportStage(stage);
    assertGenesisBodyIdentity(qpet);

    // This locator cross-check is optional evidence, not part of byte
    // validity. It owns a short timeout and listens only to attempt teardown;
    // the required fetch deadline cannot poison verified media decode.
    stage = "attesting-block";
    reportStage(stage);
    const attestedBlockHash = await fetchBlockHashAttestation(fetcher, transaction.status, lifecycleSignal);
    return {
      ok: true,
      value: Object.freeze({
        qpet,
        serializedTransactionLength: identity.bytes.byteLength,
        status: transaction.status,
        chainEvidence: evidenceFor(transaction.status, attestedBlockHash),
      }),
    };
  } catch (error) {
    if (error instanceof ExpectedFailure) return { ok: false, error: error.failure };
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, error: { code: "timeout", stage, retryable: true } };
    }
    return { ok: false, error: { code: "internal", stage, retryable: false } };
  }
}
