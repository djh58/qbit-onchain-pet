import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { ARTIFACTS } from "../../genesis/model/facts.ts";
import {
  assertRecipientCommitment,
  recoverGenesis,
  transactionId,
  validateExplorerTransaction,
} from "../../genesis/services/chain-source.ts";

const definition = ARTIFACTS["miner-one"];
const fixtureText = readFileSync(new URL("../fixtures/miner-one-mainnet-esplora.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureText) as Record<string, unknown>;

test("the honorary route recovers the exact confirmed mainnet inscription through the shared trust pipeline", async () => {
  const requested: string[] = [];
  const stages: string[] = [];
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith(`/api/block-height/${definition.facts.blockHeight}`)) {
      return new Response(definition.facts.blockHash, { headers: { "content-type": "text/plain" } });
    }
    assert.equal(url, `${definition.explorerOrigin}/api/tx/${definition.facts.transactionId}`);
    return new Response(fixtureText, { headers: { "content-type": "application/json" } });
  };

  const result = await recoverGenesis(
    new AbortController().signal,
    (stage) => stages.push(stage),
    fetcher,
    undefined,
    definition,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.qpet.manifest.id, "miner-one");
  assert.equal(result.value.qpet.manifest.displayName, "Miner One");
  assert.equal(result.value.qpet.hashes.envelopeSha256, definition.facts.envelopeSha256);
  assert.equal(result.value.qpet.bodySha256, definition.facts.sheetSha256);
  assert.equal(result.value.qpet.bodyBytes.byteLength, definition.facts.sheetLength);
  assert.equal(result.value.chainEvidence.status, "confirmed");
  assert.equal(requested.length, 2);
  assert.deepEqual(stages, [
    "locating-output",
    "decoding-envelope",
    "validating-manifest",
    "hashing-envelope",
    "hashing-sheet",
    "attesting-block",
  ]);

  const identity = await transactionId(validateExplorerTransaction(fixture));
  assert.equal(identity.id, definition.facts.transactionId);
  assert.equal(identity.bytes.byteLength, result.value.serializedTransactionLength);
});

test("the honorary recipient commitment fails closed on every pinned Esplora output field", () => {
  const canonical = validateExplorerTransaction(fixture);
  assert.doesNotThrow(() => assertRecipientCommitment(canonical, definition, "locating-output"));

  for (const mutate of [
    (output: Record<string, unknown>) => { output.value = 10_001; },
    (output: Record<string, unknown>) => { output.scriptpubkey = "52"; },
    (output: Record<string, unknown>) => { output.scriptpubkey_type = "unknown"; },
    (output: Record<string, unknown>) => { output.scriptpubkey_address = "qb1wrong"; },
  ]) {
    const changed = structuredClone(fixture) as { vout: Array<Record<string, unknown>> };
    mutate(changed.vout[1]!);
    assert.throws(
      () => assertRecipientCommitment(validateExplorerTransaction(changed), definition, "locating-output"),
      /recipient-mismatch/,
    );
  }

  const duplicate = structuredClone(fixture) as { vout: Array<Record<string, unknown>> };
  duplicate.vout[2] = structuredClone(duplicate.vout[1]!);
  assert.throws(
    () => assertRecipientCommitment(validateExplorerTransaction(duplicate), definition, "locating-output"),
    /recipient-mismatch/,
  );
});
