import assert from "node:assert/strict";
import { test } from "vitest";
import { buildGenesisShareUrl, createShareAttemptGuard, shareGenesis } from "../../genesis/model/share.ts";

const url = "https://qbit.example/#play=WyJpZGxlIl0";

test("share URLs stay on the current origin even for a protocol-relative-looking path", () => {
  assert.equal(
    buildGenesisShareUrl(
      { origin: "https://qbit.example", pathname: "//evil.example/pretend-host" },
      "#play=WyJpZGxlIl0",
    ),
    "https://qbit.example//evil.example/pretend-host#play=WyJpZGxlIl0",
  );
  assert.throws(() => buildGenesisShareUrl({ origin: "javascript:alert(1)", pathname: "/" }, "#play=x"));
});

test("share reports success only after Web Share resolves", async () => {
  let resolved = false;
  const outcome = await shareGenesis(url, {
    share: async () => { resolved = true; },
    secureContext: true,
    manualAvailable: true,
  });
  assert.equal(resolved, true);
  assert.equal(outcome, "shared");
});

test("share treats cancellation neutrally and does not copy", async () => {
  let copied = false;
  const outcome = await shareGenesis(url, {
    share: async () => { throw new DOMException("cancel", "AbortError"); },
    clipboardWrite: async () => { copied = true; },
    secureContext: true,
    manualAvailable: true,
  });
  assert.equal(outcome, "cancelled");
  assert.equal(copied, false);
});

test("share uses clipboard only in a secure context", async () => {
  let value = "";
  const copied = await shareGenesis(url, {
    clipboardWrite: async (next) => { value = next; },
    secureContext: true,
    manualAvailable: true,
  });
  assert.equal(copied, "copied");
  assert.equal(value, url);

  value = "";
  const manual = await shareGenesis(url, {
    clipboardWrite: async (next) => { value = next; },
    secureContext: false,
    manualAvailable: true,
  });
  assert.equal(manual, "manual");
  assert.equal(value, "");
});

test("denied clipboard exposes manual copy and impossible fallback fails", async () => {
  assert.equal(await shareGenesis(url, {
    clipboardWrite: async () => { throw new Error("denied"); },
    secureContext: true,
    manualAvailable: true,
  }), "manual");
  assert.equal(await shareGenesis(url, { secureContext: true, manualAvailable: false }), "failed");
  assert.equal(await shareGenesis("javascript:alert(1)", { secureContext: true, manualAvailable: true }), "failed");
});

test("a delayed share completion cannot publish feedback after unmount", async () => {
  const guard = createShareAttemptGuard();
  assert.equal(guard.begin(), null);
  guard.mount();
  const attempt = guard.begin();
  assert.notEqual(attempt, null);
  assert.equal(guard.isCurrent((attempt ?? 0) + 1), false);

  let resolveShare: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => { resolveShare = resolve; });
  const feedback: string[] = [];
  const completion = shareGenesis(url, {
    share: async () => delayed,
    secureContext: true,
    manualAvailable: true,
  }).then((outcome) => {
    if (attempt !== null && guard.isCurrent(attempt)) feedback.push(outcome);
  });

  guard.invalidate();
  resolveShare?.();
  await completion;
  assert.deepEqual(feedback, []);
});

test("a non-cancellation Web Share error continues to clipboard", async () => {
  let copied = "";
  const outcome = await shareGenesis(url, {
    share: async () => { throw new Error("share failed"); },
    clipboardWrite: async (value) => { copied = value; },
    secureContext: true,
    manualAvailable: true,
  });
  assert.equal(outcome, "copied");
  assert.equal(copied, url);
});
