import { EXPLORER_ORIGIN, GENESIS } from "../model/facts";
import type { ProofStage, RecoveryFailure } from "../model/recovery";
import type { ChainEvidence, ExplorerStatus, PetManifest, PetState, RecoveredGenesis } from "../model/types";

// Private Genesis integration adapter, not a second public QPET API. Its byte
// decoding boundary is intentionally isolated here until the exact-pinned
// qscriptions prerelease can replace it; application components consume only
// recoverGenesis and normalized ready/failure states.

const MAX_RESPONSE_BYTES = 400 * 1024;
const MAX_SCRIPT_HEX_CHARACTERS = 40_000;
const MAX_INPUTS = 1_024;
const MAX_OUTPUTS = 1_024;
const ATTESTATION_TIMEOUT_MS = 2_000;
const HEX_64 = /^[0-9a-f]{64}$/;

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

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return new Uint8Array(digest);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(await sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function transactionId(transaction: ValidatedExplorerTransaction): Promise<Readonly<{ id: string; bytes: Uint8Array }>> {
  const bytes = serializeNonWitnessTransaction(transaction);
  const digest = await sha256(await sha256(bytes));
  return Object.freeze({
    id: Array.from(digest.reverse(), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    bytes,
  });
}

function readLittleEndian(bytes: Uint8Array, offset: number, length: number): number {
  if (offset + length > bytes.length) fail("unsupported-script", "decoding-envelope", false);
  let value = 0;
  for (let index = 0; index < length; index += 1) value += bytes[offset + index] * 2 ** (8 * index);
  return value;
}

export function readQpetPush(scriptHex: string): Uint8Array {
  let script: Uint8Array;
  try {
    script = hexToBytes(scriptHex);
  } catch {
    fail("unsupported-script", "decoding-envelope", false);
  }
  if (script.byteLength < 2 || script[0] !== 0x6a) fail("unsupported-script", "decoding-envelope", false);
  let offset = 1;
  const opcode = script[offset++];
  let length: number;
  if (opcode <= 0x4b) length = opcode;
  else if (opcode === 0x4c) {
    length = readLittleEndian(script, offset, 1);
    offset += 1;
  } else if (opcode === 0x4d) {
    length = readLittleEndian(script, offset, 2);
    offset += 2;
  } else if (opcode === 0x4e) {
    length = readLittleEndian(script, offset, 4);
    offset += 4;
  } else {
    fail("unsupported-script", "decoding-envelope", false);
  }
  if (length < 1 || offset + length !== script.byteLength) fail("unsupported-script", "decoding-envelope", false);
  return script.slice(offset);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function boundedString(value: unknown, maximumBytes: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.isWellFormed() && (allowEmpty || value.length > 0) && new TextEncoder().encode(value).byteLength <= maximumBytes;
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= maximum;
}

export function validateQpetManifest(value: unknown, sheetLength: number): PetManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-envelope", "validating-manifest", false);
  const manifest = value as Partial<PetManifest>;
  if (!exactKeys(manifest, ["author", "description", "displayName", "format", "frame", "id", "kind", "sheet", "states"])) {
    fail("invalid-envelope", "validating-manifest", false);
  }
  if (
    manifest.format !== "codex-pet-v1" ||
    !boundedString(manifest.id, 64) ||
    !boundedString(manifest.displayName, 120) ||
    !boundedString(manifest.description, 2_000, true) ||
    !boundedString(manifest.kind, 64) ||
    !boundedString(manifest.author, 120)
  ) {
    fail("invalid-envelope", "validating-manifest", false);
  }
  const frame = manifest.frame;
  if (
    !frame ||
    !exactKeys(frame, ["width", "height", "columns", "rows"]) ||
    !positiveInteger(frame.width, 4_096) ||
    !positiveInteger(frame.height, 4_096) ||
    !positiveInteger(frame.columns, 256) ||
    !positiveInteger(frame.rows, 256) ||
    frame.width * frame.columns !== GENESIS.sheetWidth ||
    frame.height * frame.rows !== GENESIS.sheetHeight
  ) {
    fail("invalid-envelope", "validating-manifest", false);
  }
  if (!Array.isArray(manifest.states) || manifest.states.length !== 9) fail("invalid-envelope", "validating-manifest", false);
  const ids = new Set<string>();
  const states = manifest.states.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !exactKeys(candidate, ["id", "row", "frames", "fps", "loop"])) {
      fail("invalid-envelope", "validating-manifest", false);
    }
    const state = candidate as Partial<PetState>;
    if (
      !boundedString(state.id, 64) ||
      ids.has(state.id) ||
      !Number.isInteger(state.row) ||
      Number(state.row) < 0 ||
      Number(state.row) >= frame.rows ||
      !positiveInteger(state.frames, frame.columns) ||
      !positiveInteger(state.fps, 60) ||
      typeof state.loop !== "boolean"
    ) {
      fail("invalid-envelope", "validating-manifest", false);
    }
    ids.add(state.id);
    return Object.freeze(state as PetState);
  });
  const sheet = manifest.sheet;
  if (
    !sheet ||
    !exactKeys(sheet, ["contentType", "length", "sha256"]) ||
    sheet.contentType !== "image/webp" ||
    sheet.length !== sheetLength ||
    sheet.length !== GENESIS.sheetLength ||
    sheet.sha256 !== GENESIS.sheetSha256
  ) {
    fail("invalid-envelope", "validating-manifest", false);
  }
  return Object.freeze({ ...manifest, states }) as PetManifest;
}

function parseEnvelope(envelope: Uint8Array): Readonly<{ manifestValue: unknown; sheet: Uint8Array }> {
  if (
    envelope.byteLength !== GENESIS.envelopeLength ||
    envelope[0] !== 0x51 ||
    envelope[1] !== 0x50 ||
    envelope[2] !== 0x45 ||
    envelope[3] !== 0x54 ||
    envelope[4] !== 1
  ) {
    fail("invalid-envelope", "decoding-envelope", false);
  }
  const manifestLength = envelope[5] | (envelope[6] << 8);
  const sheetOffset = 7 + manifestLength;
  if (manifestLength < 2 || sheetOffset >= envelope.byteLength) fail("invalid-envelope", "decoding-envelope", false);
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.slice(7, sheetOffset)));
  } catch {
    fail("invalid-envelope", "decoding-envelope", false);
  }
  return Object.freeze({ manifestValue, sheet: envelope.slice(sheetOffset) });
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
    const envelope = readQpetPush(output.scriptpubkey);
    const { manifestValue, sheet } = parseEnvelope(envelope);

    stage = "validating-manifest";
    reportStage(stage);
    const manifest = validateQpetManifest(manifestValue, sheet.byteLength);

    stage = "hashing-envelope";
    reportStage(stage);
    const envelopeDigest = await sha256Hex(envelope);
    if (envelopeDigest !== GENESIS.envelopeSha256) fail("hash-mismatch", stage, false);

    stage = "hashing-sheet";
    reportStage(stage);
    const sheetDigest = await sha256Hex(sheet);
    if (sheetDigest !== GENESIS.sheetSha256) {
      fail("hash-mismatch", stage, false);
    }

    // This locator cross-check is optional evidence, not part of byte
    // validity. It owns a short timeout and listens only to attempt teardown;
    // the required fetch deadline cannot poison verified media decode.
    stage = "attesting-block";
    reportStage(stage);
    const attestedBlockHash = await fetchBlockHashAttestation(fetcher, transaction.status, lifecycleSignal);
    return {
      ok: true,
      value: Object.freeze({
        manifest,
        envelope,
        sheet,
        envelopeDigest,
        sheetDigest,
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
