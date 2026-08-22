import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test, vi } from "vitest";
import { GENESIS } from "../../genesis/model/facts.ts";
import {
  compactSize,
  hexToBytes,
  readQpetPush,
  recoverGenesis,
  sha256Hex,
  transactionId,
  validateExplorerTransaction,
  validateQpetManifest,
} from "../../genesis/services/chain-source.ts";

type JsonObject = Record<string, unknown>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const fixtureText = readFileSync(new URL("../fixtures/genesis-mainnet-esplora.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureText) as JsonObject;
const fixtureOutput = (fixture.vout as JsonObject[])[0];
const exactEnvelope = readQpetPush(fixtureOutput.scriptpubkey as string);
const manifestLength = exactEnvelope[5] | (exactEnvelope[6] << 8);
const manifestFixture = JSON.parse(new TextDecoder().decode(exactEnvelope.slice(7, 7 + manifestLength))) as JsonObject;

function jsonResponse(body = fixtureText, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(body, { ...init, headers });
}

function textResponse(body = GENESIS.blockHash, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/plain");
  return new Response(body, { ...init, headers });
}

const exactFetcher: FetchLike = async (input) => String(input).includes("block-height")
  ? textResponse()
  : jsonResponse();

function cloneFixture(): JsonObject {
  return structuredClone(fixture);
}

function cloneManifest(): JsonObject {
  return structuredClone(manifestFixture);
}

function expectInvalidTransaction(mutate: (candidate: JsonObject) => void): void {
  const candidate = cloneFixture();
  mutate(candidate);
  assert.throws(() => validateExplorerTransaction(candidate));
}

function expectInvalidManifest(mutate: (candidate: JsonObject) => void, sheetLength = GENESIS.sheetLength): void {
  const candidate = cloneManifest();
  mutate(candidate);
  assert.throws(() => validateQpetManifest(candidate, sheetLength));
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("the full pinned explorer fixture recovers exact bytes, identity, hashes, manifest, and evidence", async () => {
  const stages: string[] = [];
  const result = await recoverGenesis(new AbortController().signal, (stage) => stages.push(stage), exactFetcher);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.serializedTransactionLength, 9_657);
  assert.equal(result.value.envelope.byteLength, GENESIS.envelopeLength);
  assert.equal(result.value.sheet.byteLength, GENESIS.sheetLength);
  assert.equal(result.value.envelopeDigest, GENESIS.envelopeSha256);
  assert.equal(result.value.sheetDigest, GENESIS.sheetSha256);
  assert.equal(result.value.manifest.states.length, 9);
  assert.equal(result.value.chainEvidence.status, "confirmed");
  assert.deepEqual(stages, [
    "locating-output",
    "decoding-envelope",
    "validating-manifest",
    "hashing-envelope",
    "hashing-sheet",
    "attesting-block",
  ]);

  assert.equal(await sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const identity = await transactionId(validateExplorerTransaction(fixture));
  assert.equal(identity.id, GENESIS.transactionId);
  assert.equal(identity.bytes.byteLength, 9_657);
  assert.equal(validateQpetManifest(manifestFixture, GENESIS.sheetLength).states.length, 9);
});

test("explorer validation rejects every hostile object, collection, numeric, hash, and hex boundary", () => {
  for (const value of [null, "transaction", []]) {
    assert.throws(() => validateExplorerTransaction(value));
  }

  expectInvalidTransaction((value) => { value.version = "2"; });
  expectInvalidTransaction((value) => { value.version = 2.5; });
  expectInvalidTransaction((value) => { value.version = -0x8000_0001; });
  expectInvalidTransaction((value) => { value.version = 0x8000_0000; });
  expectInvalidTransaction((value) => { value.locktime = "0"; });
  expectInvalidTransaction((value) => { value.locktime = -1; });
  expectInvalidTransaction((value) => { value.locktime = 0x1_0000_0000; });
  expectInvalidTransaction((value) => { value.txid = 4; });
  expectInvalidTransaction((value) => { value.txid = "f".repeat(63); });
  expectInvalidTransaction((value) => { value.vin = null; });
  expectInvalidTransaction((value) => { value.vin = []; });
  expectInvalidTransaction((value) => { value.vin = Array.from({ length: 1_025 }, () => (fixture.vin as JsonObject[])[0]); });
  expectInvalidTransaction((value) => { value.vin = [null]; });
  expectInvalidTransaction((value) => { value.vin = [[]]; });
  expectInvalidTransaction((value) => { (value.vin as JsonObject[])[0].is_coinbase = "false"; });
  expectInvalidTransaction((value) => { (value.vin as JsonObject[])[0].txid = "bad"; });
  expectInvalidTransaction((value) => { (value.vin as JsonObject[])[0].vout = -1; });
  expectInvalidTransaction((value) => { (value.vin as JsonObject[])[0].scriptsig = 1; });
  expectInvalidTransaction((value) => { (value.vin as JsonObject[])[0].scriptsig = "00".repeat(20_001); });
  expectInvalidTransaction((value) => { (value.vin as JsonObject[])[0].scriptsig = "0"; });
  expectInvalidTransaction((value) => { (value.vin as JsonObject[])[0].scriptsig = "zz"; });
  expectInvalidTransaction((value) => { (value.vin as JsonObject[])[0].sequence = Number.NaN; });
  expectInvalidTransaction((value) => { value.vout = null; });
  expectInvalidTransaction((value) => { value.vout = []; });
  expectInvalidTransaction((value) => { value.vout = Array.from({ length: 1_025 }, () => (fixture.vout as JsonObject[])[1]); });
  expectInvalidTransaction((value) => { value.vout = [null]; });
  expectInvalidTransaction((value) => { value.vout = [[]]; });
  expectInvalidTransaction((value) => { (value.vout as JsonObject[])[0].scriptpubkey_type = 2; });
  expectInvalidTransaction((value) => { (value.vout as JsonObject[])[0].scriptpubkey_type = "x".repeat(65); });
  expectInvalidTransaction((value) => { (value.vout as JsonObject[])[0].value = -1; });
  expectInvalidTransaction((value) => { (value.vout as JsonObject[])[0].scriptpubkey = "z0"; });
  expectInvalidTransaction((value) => { value.status = null; });
  expectInvalidTransaction((value) => { value.status = { confirmed: "true" }; });

  const confirmed = cloneFixture();
  confirmed.status = {
    confirmed: true,
    block_height: GENESIS.blockHeight,
    block_hash: GENESIS.blockHash,
    block_time: 1,
  };
  assert.equal(validateExplorerTransaction(confirmed).status.confirmed, true);
  expectInvalidTransaction((value) => { value.status = { confirmed: true, block_height: -1, block_hash: GENESIS.blockHash, block_time: 1 }; });
  expectInvalidTransaction((value) => { value.status = { confirmed: true, block_height: 1, block_hash: "bad", block_time: 1 }; });
  expectInvalidTransaction((value) => { value.status = { confirmed: true, block_height: 1, block_hash: GENESIS.blockHash, block_time: -1 }; });

  assert.throws(() => compactSize(Number.NaN));
  assert.throws(() => hexToBytes("0"));
  assert.throws(() => hexToBytes("zz"));
  assert.deepEqual(hexToBytes("00ff"), new Uint8Array([0, 255]));
});

test("manifest validation covers exact keys, bounded strings, geometry, states, and sheet identity", () => {
  assert.equal(validateQpetManifest(manifestFixture, GENESIS.sheetLength).id, "qbit");
  const emptyDescription = cloneManifest();
  emptyDescription.description = "";
  assert.equal(validateQpetManifest(emptyDescription, GENESIS.sheetLength).description, "");

  for (const value of [null, "manifest", []]) assert.throws(() => validateQpetManifest(value, GENESIS.sheetLength));
  expectInvalidManifest((value) => { delete value.author; });
  expectInvalidManifest((value) => { delete value.author; value.extra = "x"; });
  expectInvalidManifest((value) => { value.format = "other"; });
  expectInvalidManifest((value) => { value.id = 1; });
  expectInvalidManifest((value) => { value.id = ""; });
  expectInvalidManifest((value) => { value.id = "\ud800"; });
  expectInvalidManifest((value) => { value.id = "é".repeat(33); });
  expectInvalidManifest((value) => { value.displayName = ""; });
  expectInvalidManifest((value) => { value.description = "x".repeat(2_001); });
  expectInvalidManifest((value) => { value.kind = ""; });
  expectInvalidManifest((value) => { value.author = ""; });

  expectInvalidManifest((value) => { value.frame = null; });
  expectInvalidManifest((value) => { (value.frame as JsonObject).extra = 1; });
  expectInvalidManifest((value) => { (value.frame as JsonObject).width = 1.5; });
  expectInvalidManifest((value) => { (value.frame as JsonObject).width = 0; });
  expectInvalidManifest((value) => { (value.frame as JsonObject).width = 4_097; });
  expectInvalidManifest((value) => { (value.frame as JsonObject).height = 0; });
  expectInvalidManifest((value) => { (value.frame as JsonObject).height = 4_097; });
  expectInvalidManifest((value) => { (value.frame as JsonObject).columns = 0; });
  expectInvalidManifest((value) => { (value.frame as JsonObject).columns = 257; });
  expectInvalidManifest((value) => { (value.frame as JsonObject).rows = 0; });
  expectInvalidManifest((value) => { (value.frame as JsonObject).rows = 257; });
  expectInvalidManifest((value) => { (value.frame as JsonObject).width = 191; });
  expectInvalidManifest((value) => { (value.frame as JsonObject).height = 207; });

  expectInvalidManifest((value) => { value.states = null; });
  expectInvalidManifest((value) => { value.states = []; });
  expectInvalidManifest((value) => { value.states = Array.from({ length: 9 }, () => null); });
  expectInvalidManifest((value) => { (value.states as unknown[])[0] = "state"; });
  expectInvalidManifest((value) => { (value.states as unknown[])[0] = []; });
  expectInvalidManifest((value) => { (value.states as JsonObject[])[0].extra = true; });
  expectInvalidManifest((value) => { (value.states as JsonObject[])[0].id = ""; });
  expectInvalidManifest((value) => { (value.states as JsonObject[])[1].id = (value.states as JsonObject[])[0].id; });
  expectInvalidManifest((value) => { (value.states as JsonObject[])[0].row = 0.5; });
  expectInvalidManifest((value) => { (value.states as JsonObject[])[0].row = -1; });
  expectInvalidManifest((value) => { (value.states as JsonObject[])[0].row = 9; });
  expectInvalidManifest((value) => { (value.states as JsonObject[])[0].frames = 0; });
  expectInvalidManifest((value) => { (value.states as JsonObject[])[0].frames = 9; });
  expectInvalidManifest((value) => { (value.states as JsonObject[])[0].fps = 0; });
  expectInvalidManifest((value) => { (value.states as JsonObject[])[0].fps = 61; });
  expectInvalidManifest((value) => { (value.states as JsonObject[])[0].loop = "true"; });

  expectInvalidManifest((value) => { value.sheet = null; });
  expectInvalidManifest((value) => { (value.sheet as JsonObject).extra = 1; });
  expectInvalidManifest((value) => { (value.sheet as JsonObject).contentType = "image/png"; });
  expectInvalidManifest((value) => { (value.sheet as JsonObject).length = GENESIS.sheetLength - 1; });
  expectInvalidManifest(() => {}, GENESIS.sheetLength - 1);
  expectInvalidManifest((value) => { (value.sheet as JsonObject).sha256 = "0".repeat(64); });
});
