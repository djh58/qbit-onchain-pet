import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`https://qpet.example${pathname}`, {
      headers: { accept: "text/html", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Genesis absence state with reviewed security headers", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.equal(csp, "default-src 'none'; connect-src 'self' https://mempool.qbit.org; img-src 'self' blob:; font-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; manifest-src 'self'");
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");

  const html = await response.text();
  assert.match(html, /<title>Qbit Genesis — Bytes\. Then being\.<\/title>/i);
  assert.match(html, /Bytes\./);
  assert.match(html, /Then being\./);
  assert.match(html, /No verified bytes\. No Qbit\./);
  assert.match(html, /block (?:<!-- -->)?53,026/);
  assert.match(html, /Get Qbit for your coding agent/i);
  assert.match(html, /https:\/\/codex-pets\.net\/#\/pets\/qbit/);
  assert.match(html, /https:\/\/github\.com\/djh58\/qbit-onchain-pet/);
  assert.match(html, /https:\/\/qbit-onchain-pet\.thedanhepworth\.chatgpt\.site\/og\.png/);
  assert.doesNotMatch(html, /attacker\.example/);
  assert.match(html, /<link(?=[^>]*\brel="shortcut icon")(?=[^>]*\bhref="\/favicon\.ico\?v=2")[^>]*>/i);
  assert.match(html, /<link(?=[^>]*\brel="preconnect")(?=[^>]*\bhref="https:\/\/mempool\.qbit\.org")[^>]*>/i);
  assert.equal((html.match(/rel="preconnect"/g) ?? []).length, 1);
  assert.match(html, /<script[^>]*>|<script>/i, "Vinext currently emits inline hydration state");
  assert.match(html, /<style[^>]*>/i, "Vinext currently emits inline font CSS");
  assert.doesNotMatch(html, /data-media-origin="verified-blob"/);
  assert.doesNotMatch(html, /blob:https?:|data:image\/webp|spritesheet\.webp/i);
});

test("server-renders the honorary route without embedding its inscription bytes", async () => {
  const response = await render("/honorary");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Miner One — Qbit Block 1 Honorary QPET<\/title>/i);
  assert.match(html, /Block one\./);
  assert.match(html, /Miner one\./);
  assert.match(html, /No verified bytes\. No Miner One\./);
  assert.match(html, /Miner #1 · Mainnet/);
  assert.match(html, /honor the miner who extended Qbit mainnet with block 1/i);
  assert.match(html, /53dd2d8982bea1dd1676f6506a497a31c14a81aad21639d019e3658150f231af/);
  assert.match(html, /0\.00010000 QBT/);
  assert.match(html, /v2_p2mr/);
  assert.doesNotMatch(html, /blob:https?:|data:image\/webp|spritesheet\.webp/i);
});
