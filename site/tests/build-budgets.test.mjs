import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  }));
  return nested.flat();
}

async function gzipBytes(files) {
  const bodies = await Promise.all(files.map((file) => readFile(file)));
  return bodies.reduce((total, body) => total + gzipSync(body, { level: 9 }).byteLength, 0);
}

test("the production client stays inside the first-tranche launch budgets", async () => {
  const chunks = (await filesUnder(path.join(siteRoot, "dist", "client", "_next", "static", "chunks")))
    .filter((file) => file.endsWith(".js"));
  const styles = (await filesUnder(path.join(siteRoot, "dist", "client", "_next", "static", "css")))
    .filter((file) => file.endsWith(".css"));
  const genesisChunks = chunks.filter((file) => path.basename(file).startsWith("genesis-experience-"));

  assert.ok(chunks.length > 0, "production build emitted no client JavaScript");
  assert.equal(genesisChunks.length, 1, "expected one Genesis application chunk");
  assert.ok(await gzipBytes(chunks) <= 175 * 1_024, "client JavaScript exceeds 175 KiB gzip");
  assert.ok(await gzipBytes(genesisChunks) <= 40 * 1_024, "Genesis application chunk exceeds 40 KiB gzip");
  assert.ok(await gzipBytes(styles) <= 30 * 1_024, "client CSS exceeds 30 KiB gzip");
});
