import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { GENESIS } from "../../genesis/model/facts.ts";
import { recoverGenesis, transactionId, validateExplorerTransaction } from "../../genesis/services/chain-source.ts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const fixtureText = readFileSync(new URL("../fixtures/genesis-mainnet-esplora.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureText) as Record<string, unknown>;

function jsonResponse(): Response {
  return new Response(fixtureText, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function textResponse(): Response {
  return new Response(GENESIS.blockHash, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

const exactFetcher: FetchLike = async (input) => String(input).includes("block-height")
  ? textResponse()
  : jsonResponse();

test("the full explorer fixture normalizes to the exact package artifact and independent chain evidence", async () => {
  const stages: string[] = [];
  const result = await recoverGenesis(
    new AbortController().signal,
    (stage) => stages.push(stage),
    exactFetcher,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const { qpet } = result.value;
  assert.equal(result.value.serializedTransactionLength, 9_657);
  assert.equal(qpet.wireFormat, "QPET");
  assert.equal(qpet.wireVersion, 1);
  assert.equal(qpet.profile, "legacy/qpet-v1");
  assert.equal(qpet.contentId, `qscr:sha256:${GENESIS.envelopeSha256}`);
  assert.equal(qpet.hashes.envelopeSha256, GENESIS.envelopeSha256);
  assert.equal(qpet.bodySha256, GENESIS.sheetSha256);
  assert.equal(qpet.envelopeBytes.byteLength, GENESIS.envelopeLength);
  assert.equal(qpet.bodyBytes.byteLength, GENESIS.sheetLength);
  assert.equal(qpet.manifest.states.length, 9);
  assert.deepEqual(qpet.manifest.frame, {
    width: GENESIS.frameWidth,
    height: GENESIS.frameHeight,
    columns: 8,
    rows: 9,
  });
  assert.equal(result.value.chainEvidence.status, "confirmed");
  assert.deepEqual(stages, [
    "locating-output",
    "decoding-envelope",
    "validating-manifest",
    "hashing-envelope",
    "hashing-sheet",
    "attesting-block",
  ]);

  const firstEnvelope = qpet.envelopeBytes;
  const firstBody = qpet.bodyBytes;
  firstEnvelope.fill(0);
  firstBody.fill(0);
  assert.notStrictEqual(qpet.envelopeBytes, firstEnvelope);
  assert.notStrictEqual(qpet.bodyBytes, firstBody);
  assert.equal(qpet.envelopeBytes.byteLength, GENESIS.envelopeLength);
  assert.equal(qpet.bodyBytes.byteLength, GENESIS.sheetLength);
});

test("the site still independently reconstructs and verifies the requested transaction ID", async () => {
  const identity = await transactionId(validateExplorerTransaction(fixture));
  assert.equal(identity.id, GENESIS.transactionId);
  assert.equal(identity.bytes.byteLength, 9_657);
});
