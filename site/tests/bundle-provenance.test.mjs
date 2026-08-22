import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(siteRoot, "..");

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  }));
  return nested.flat();
}

function genesisEnvelope() {
  const script = [
    "import base64,json,pathlib,sys",
    `sys.path.insert(0, ${JSON.stringify(repositoryRoot)})`,
    "import qpet",
    `root=pathlib.Path(${JSON.stringify(repositoryRoot)})`,
    "sheet=(root/'assets/qbit/spritesheet.webp').read_bytes()",
    "pet=json.loads((root/'assets/qbit/pet.json').read_text(encoding='utf-8'))",
    "payload=qpet.encode_envelope(qpet.build_manifest(pet,sheet),sheet)",
    "print(base64.b64encode(payload).decode('ascii'))",
  ].join(";");
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return Buffer.from(result.stdout.trim(), "base64");
}

test("production output contains no runtime mascot or envelope fallback", async () => {
  const sheet = await readFile(path.join(repositoryRoot, "assets/qbit/spritesheet.webp"));
  const envelope = genesisEnvelope();
  const signatures = [
    ["raw sheet", sheet],
    ["hex sheet", Buffer.from(sheet.toString("hex"))],
    ["uppercase hex sheet", Buffer.from(sheet.toString("hex").toUpperCase())],
    ["base64 sheet", Buffer.from(sheet.toString("base64"))],
    ["base64url sheet", Buffer.from(sheet.toString("base64url"))],
    ["raw envelope", envelope],
    ["hex envelope", Buffer.from(envelope.toString("hex"))],
    ["uppercase hex envelope", Buffer.from(envelope.toString("hex").toUpperCase())],
    ["base64 envelope", Buffer.from(envelope.toString("base64"))],
    ["base64url envelope", Buffer.from(envelope.toString("base64url"))],
  ];

  assert.equal(sheet.byteLength, 8_616);
  assert.equal(envelope.byteLength, 9_548);
  assert.equal(createHash("sha256").update(sheet).digest("hex"), "8ea6a2514e745bc4393f9a46cb37d207c2448c716e331143cb80ba14b0654333");
  assert.equal(createHash("sha256").update(envelope).digest("hex"), "e9a9ce232eeee3657e87053edf27b0b1f5493c9111d9a37c41fc5cdb85a24247");
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
  assert.match(runtime, /URL\.createObjectURL/);
  assert.match(runtime, /new Blob/);
  assert.match(runtime, /sheetDigest !== GENESIS\.sheetSha256/);
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
