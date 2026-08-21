import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://qpet.example/", { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the finished QPET page with security headers", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self' https:\/\/mempool\.qbit\.org/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  const html = await response.text();
  assert.match(html, /<title>Qbit, permanently committed<\/title>/i);
  assert.match(html, /Permanently/);
  assert.match(html, /committed\./);
  assert.match(html, /block 53,026/);
  assert.match(html, /download Qbit for your coding agent/i);
  assert.match(html, /https:\/\/codex-pets\.net\/#\/pets\/qbit/);
  assert.match(html, /https:\/\/github\.com\/djh58\/qbit-onchain-pet/);
  assert.match(html, /<link(?=[^>]*\brel="shortcut icon")(?=[^>]*\bhref="\/favicon\.ico\?v=2")[^>]*>/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("ships a decoder and small share assets, but no local animation sheet", async () => {
  const [page, packageJson, publicFiles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readdir(new URL("../public/", import.meta.url)),
  ]);

  assert.match(page, /852748890119300166f0c3050da3fee5c55316d199bcff1425424c009d2e62b9/);
  assert.match(page, /https:\/\/mempool\.qbit\.org/);
  assert.match(page, /EXPECTED_ENVELOPE_SHA256/);
  assert.match(page, /EXPECTED_SHEET_SHA256/);
  assert.match(page, /readOpReturn/);
  assert.match(page, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(page, /URL\.createObjectURL/);
  assert.doesNotMatch(page, /spritesheet\.webp|data:image\/webp/i);
  assert.deepEqual(publicFiles.sort(), ["favicon.ico", "favicon.png", "og.png"]);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
