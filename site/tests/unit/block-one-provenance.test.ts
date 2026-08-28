import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { ARTIFACTS } from "../../genesis/model/facts.ts";

type BlockOneFixture = {
  schemaVersion: number;
  height: number;
  hash: string;
  time: number;
  auxpow: null;
  transactions: Array<{
    txid: string;
    coinbaseScriptHex: string;
    outputs: Array<{
      index: number;
      amountBits: number;
      address: string;
      scriptPubKey: string;
      scriptPubKeyType: string;
    }>;
  }>;
};

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/block-one-mainnet-provenance.json", import.meta.url), "utf8"),
) as BlockOneFixture;

test("Miner One honor and recipient pins agree with the repository-only block-one RPC provenance", () => {
  const honorary = ARTIFACTS["miner-one"];
  const honor = honorary.honor;
  const recipient = honorary.facts.recipient;
  const coinbase = fixture.transactions[0];
  const payout = coinbase?.outputs[0];

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.height, 1);
  assert.equal(fixture.hash, "00000000000000000be903a612b1aaaeea4a7d35be4862327957896d215e3c0f");
  assert.equal(fixture.time, 1_784_139_898);
  assert.equal(fixture.auxpow, null);
  assert.equal(fixture.transactions.length, 1);
  assert.equal(coinbase?.txid, "c8d070f65bc110765e01984a0d4b2d2d33188eef98077e2196980530ab9bdaca");
  assert.equal(
    coinbase?.coinbaseScriptHex,
    "5100047ad0576a04059326340c80be576ac7e7543eb00000010a636b706f6f6c172f716269742d6d696e696e672d626f6f7473747261702f",
  );
  const coinbaseText = Buffer.from(coinbase?.coinbaseScriptHex ?? "", "hex").toString("latin1");
  assert.match(coinbaseText, /ckpool/);
  assert.match(coinbaseText, /\/qbit-mining-bootstrap\//);

  assert.equal(payout?.index, 0);
  assert.equal(payout?.amountBits, 21_000_000_000);
  assert.equal(payout?.scriptPubKeyType, "witness_v2_p2mr");
  assert.equal(honor?.blockHash, fixture.hash);
  assert.equal(honor?.coinbaseTransactionId, coinbase?.txid);
  assert.equal(
    honor?.blockTimeIso,
    new Date(fixture.time * 1_000).toISOString().replace(".000Z", "Z"),
  );
  assert.deepEqual(honor?.coinbaseTags, ["ckpool", "/qbit-mining-bootstrap/"]);
  assert.equal(honor?.payoutAddress, payout?.address);
  assert.equal(recipient?.address, honor?.payoutAddress);
  assert.equal(recipient?.scriptPubKey, payout?.scriptPubKey);
});
