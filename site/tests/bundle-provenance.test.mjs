import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(siteRoot, "..");
const QSCRIPTIONS_VERSION = "0.1.0-alpha.0";
const QSCRIPTIONS_TARBALL = `https://registry.npmjs.org/qscriptions/-/qscriptions-${QSCRIPTIONS_VERSION}.tgz`;
const QSCRIPTIONS_INTEGRITY = "sha512-sNJ6yanOhLZP30f2pVgrZkLVc3XY1EYNeq3Ko6PpIBCQuHK37X1galmPcqRl9sBeGI6efmc/SGfwLJBzouy8Sw==";

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  }));
  return nested.flat();
}

function trackedEnvelope(directory) {
  const script = [
    "import base64,json,pathlib,sys",
    `sys.path.insert(0, ${JSON.stringify(repositoryRoot)})`,
    "import qpet",
    `root=pathlib.Path(${JSON.stringify(repositoryRoot)})`,
    `sheet=(root/'assets/${directory}/spritesheet.webp').read_bytes()`,
    `pet=json.loads((root/'assets/${directory}/pet.json').read_text(encoding='utf-8'))`,
    "payload=qpet.encode_envelope(qpet.build_manifest(pet,sheet),sheet)",
    "print(base64.b64encode(payload).decode('ascii'))",
  ].join(";");
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return Buffer.from(result.stdout.trim(), "base64");
}

test("production output contains no runtime mascot or envelope fallback", async () => {
  const qbitSheet = await readFile(path.join(repositoryRoot, "assets/qbit/spritesheet.webp"));
  const minerSheet = await readFile(path.join(repositoryRoot, "assets/miner-one/spritesheet.webp"));
  const qbitEnvelope = trackedEnvelope("qbit");
  const minerEnvelope = trackedEnvelope("miner-one");
  const signatures = [["Qbit", qbitSheet, qbitEnvelope], ["Miner One", minerSheet, minerEnvelope]].flatMap(
    ([name, sheet, envelope]) => [
      [`${name} raw sheet`, sheet],
      [`${name} hex sheet`, Buffer.from(sheet.toString("hex"))],
      [`${name} uppercase hex sheet`, Buffer.from(sheet.toString("hex").toUpperCase())],
      [`${name} base64 sheet`, Buffer.from(sheet.toString("base64"))],
      [`${name} base64url sheet`, Buffer.from(sheet.toString("base64url"))],
      [`${name} raw envelope`, envelope],
      [`${name} hex envelope`, Buffer.from(envelope.toString("hex"))],
      [`${name} uppercase hex envelope`, Buffer.from(envelope.toString("hex").toUpperCase())],
      [`${name} base64 envelope`, Buffer.from(envelope.toString("base64"))],
      [`${name} base64url envelope`, Buffer.from(envelope.toString("base64url"))],
    ],
  );

  assert.equal(qbitSheet.byteLength, 8_616);
  assert.equal(qbitEnvelope.byteLength, 9_548);
  assert.equal(minerSheet.byteLength, 9_644);
  assert.equal(minerEnvelope.byteLength, 10_619);
  assert.equal(createHash("sha256").update(qbitSheet).digest("hex"), "8ea6a2514e745bc4393f9a46cb37d207c2448c716e331143cb80ba14b0654333");
  assert.equal(createHash("sha256").update(qbitEnvelope).digest("hex"), "e9a9ce232eeee3657e87053edf27b0b1f5493c9111d9a37c41fc5cdb85a24247");
  assert.equal(createHash("sha256").update(minerSheet).digest("hex"), "128f1ebbc42239286c21c622ad5892237d2d73842fdf3481989b70606046a7cc");
  assert.equal(createHash("sha256").update(minerEnvelope).digest("hex"), "ca2a0c0d16aeb3b370592521d6c02ee181684028683fe3602f214322b43d05e5");
  for (const file of await filesUnder(path.join(siteRoot, "dist"))) {
    const body = await readFile(file);
    for (const [label, signature] of signatures) {
      assert.equal(body.includes(signature), false, `${file} unexpectedly contains ${label}`);
    }
  }
});

test("runtime source has only a verified Blob media path", async () => {
  const runtimeFiles = [
    ...(await filesUnder(path.join(siteRoot, "app"))),
    ...(await filesUnder(path.join(siteRoot, "genesis"))),
    ...(await filesUnder(path.join(siteRoot, "worker"))),
  ];
  const runtime = (await Promise.all(runtimeFiles.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(runtime, /spritesheet\.webp|assets\/qbit|data:image\/webp/i);
  assert.doesNotMatch(runtime, /document\.execCommand/);
  assert.doesNotMatch(runtime, /tests[\\/]fixtures|genesis-mainnet-esplora/i);
  assert.match(runtime, /from "qscriptions"/);
  assert.match(runtime, /extractQpetEnvelope/);
  assert.match(runtime, /decodeQpetEnvelope/);
  assert.doesNotMatch(runtime, /readLittleEndian|readQpetPush|validateQpetManifest|parseEnvelope|sha256Hex/);
  assert.match(runtime, /URL\.createObjectURL/);
  assert.match(runtime, /new Blob/);
  assert.match(runtime, /assertGenesisEnvelopeIdentity\(qpet, definition\)/);
  assert.match(runtime, /assertGenesisBodyIdentity\(qpet, definition\)/);
});

test("the site pins the exact public qscriptions alpha from the package root", async () => {
  const packageManifest = JSON.parse(await readFile(path.join(siteRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(siteRoot, "package-lock.json"), "utf8"));
  const lockedQscriptions = packageLock.packages["node_modules/qscriptions"];

  assert.equal(packageManifest.dependencies.qscriptions, QSCRIPTIONS_VERSION);
  assert.equal(packageManifest.dependencies.qscriptions.includes("file:"), false);
  assert.equal(packageManifest.dependencies.qscriptions.includes("git"), false);
  assert.equal(packageManifest.dependencies.qscriptions.includes("workspace:"), false);
  assert.equal(packageLock.packages[""].dependencies.qscriptions, QSCRIPTIONS_VERSION);
  assert.equal(lockedQscriptions.version, QSCRIPTIONS_VERSION);
  assert.equal(lockedQscriptions.resolved, QSCRIPTIONS_TARBALL);
  assert.equal(lockedQscriptions.integrity, QSCRIPTIONS_INTEGRITY);
  assert.equal(lockedQscriptions.link, undefined);
});

test("the exact full Esplora fixture is repository-only and absent from production output", async () => {
  const fixturePath = path.join(siteRoot, "tests", "fixtures", "genesis-mainnet-esplora.json");
  const fixture = await readFile(fixturePath);
  const parsed = JSON.parse(fixture.toString("utf8"));
  assert.equal(fixture.byteLength, 47_226);
  assert.equal(createHash("sha256").update(fixture).digest("hex"), "48f39512954fdf8b6b25c156a2971ffdd413dfe0af80c66c23b187a60c2642d6");
  assert.equal(parsed.txid, "852748890119300166f0c3050da3fee5c55316d199bcff1425424c009d2e62b9");
  assert.equal(parsed.status.block_height, 53_026);
  assert.equal(parsed.status.block_hash, "0000000000000000893a81d2e44e1e16cbaf59cd58f901b6be29603ad2935460");
  assert.equal(parsed.vin.length, 1);
  assert.equal(parsed.vout.length, 2);

  const forbidden = [
    ["full Esplora fixture", fixture.subarray(0, fixture.byteLength - 1)],
    ["pinned OP_RETURN body", Buffer.from(parsed.vout[0].scriptpubkey)],
  ];
  for (const file of await filesUnder(path.join(siteRoot, "dist"))) {
    const body = await readFile(file);
    for (const [label, signature] of forbidden) {
      assert.equal(body.includes(signature), false, `${file} unexpectedly contains ${label}`);
    }
  }
});

test("the honorary mainnet Esplora fixture is repository-only and absent from production output", async () => {
  const fixturePath = path.join(siteRoot, "tests", "fixtures", "miner-one-mainnet-esplora.json");
  const fixture = await readFile(fixturePath);
  const parsed = JSON.parse(fixture.toString("utf8"));
  assert.equal(fixture.byteLength, 51_842);
  assert.equal(createHash("sha256").update(fixture).digest("hex"), "75f746073f7760924cad5aa7921a1a61136f7272b48789748f3ae424b59bdbfb");
  assert.equal(parsed.txid, "53dd2d8982bea1dd1676f6506a497a31c14a81aad21639d019e3658150f231af");
  assert.equal(parsed.status.block_height, 63_174);
  assert.equal(parsed.status.block_hash, "000000000000000027a132d416c0d5dfd8a8b6bca42c0b6548a6d3ec66b4a100");
  assert.equal(parsed.vin.length, 1);
  assert.equal(parsed.vout.length, 3);
  assert.deepEqual(parsed.vout[1], {
    scriptpubkey: "52203834d824f0ff7ccc4d4811a700f04185c43b5ac77e15dd78cd0e7aa21ac186ea",
    scriptpubkey_asm: "OP_PUSHNUM_2 OP_PUSHBYTES_32 3834d824f0ff7ccc4d4811a700f04185c43b5ac77e15dd78cd0e7aa21ac186ea",
    scriptpubkey_type: "v2_p2mr",
    scriptpubkey_address: "qb1z8q6dsf8sla7vcn2gzxnspuzpshzrkkk80c2a67xdpea2yxkpsm4qmzhake",
    value: 10_000,
  });

  const forbidden = [
    ["honorary Esplora fixture", fixture.subarray(0, fixture.byteLength - 1)],
    ["honorary OP_RETURN body", Buffer.from(parsed.vout[0].scriptpubkey)],
  ];
  for (const file of await filesUnder(path.join(siteRoot, "dist"))) {
    const body = await readFile(file);
    for (const [label, signature] of forbidden) {
      assert.equal(body.includes(signature), false, `${file} unexpectedly contains ${label}`);
    }
  }
});

test("the block-one RPC provenance fixture is repository-only and absent from production output", async () => {
  const fixturePath = path.join(siteRoot, "tests", "fixtures", "block-one-mainnet-provenance.json");
  const fixture = await readFile(fixturePath);
  const parsed = JSON.parse(fixture.toString("utf8"));
  assert.equal(fixture.byteLength, 812);
  assert.equal(createHash("sha256").update(fixture).digest("hex"), "6093b4cfbdef34d90b296eff198daf6bf8bfa327bd2546cece4931a1783461ad");
  assert.equal(parsed.height, 1);
  assert.equal(parsed.auxpow, null);
  assert.equal(parsed.transactions.length, 1);
  assert.equal(parsed.transactions[0].outputs[0].amountBits, 21_000_000_000);

  const forbidden = [
    ["full block-one provenance fixture", fixture.subarray(0, fixture.byteLength - 1)],
    ["block-one coinbase input script", Buffer.from(parsed.transactions[0].coinbaseScriptHex)],
  ];
  for (const file of await filesUnder(path.join(siteRoot, "dist"))) {
    const body = await readFile(file);
    for (const [label, signature] of forbidden) {
      assert.equal(body.includes(signature), false, `${file} unexpectedly contains ${label}`);
    }
  }
});

test("public files are the static branding allowlist only", async () => {
  assert.deepEqual((await readdir(path.join(siteRoot, "public"))).sort(), ["favicon.ico", "favicon.png", "og.png"]);
});

test("the social card is a 1200x630 PNG within the 300 KiB launch budget", async () => {
  const card = await readFile(path.join(siteRoot, "public", "og.png"));
  assert.equal(card.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(card.readUInt32BE(16), 1_200);
  assert.equal(card.readUInt32BE(20), 630);
  assert.ok(card.byteLength <= 300 * 1_024, `${card.byteLength} bytes exceeds the 300 KiB budget`);
});
