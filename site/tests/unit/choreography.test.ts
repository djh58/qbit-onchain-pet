import assert from "node:assert/strict";
import { test } from "vitest";
import {
  decodeChoreography,
  encodeChoreography,
  observeChoreographyFragment,
} from "../../genesis/model/choreography.ts";

const allowed = ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"];

test("choreography has a canonical unpadded base64url round trip", () => {
  const states = ["idle", "waving", "waving", "review"];
  const encoded = encodeChoreography(states, allowed);
  assert.match(encoded, /^#play=[A-Za-z0-9_-]+$/);
  assert.equal(encoded.slice(6).includes("="), false);
  assert.deepEqual(decodeChoreography(encoded, allowed), { ok: true, states });
});

test("choreography encoder enforces known IDs and 1–16 items", () => {
  assert.throws(() => encodeChoreography([], allowed));
  assert.throws(() => encodeChoreography(Array.from({ length: 17 }, () => "idle"), allowed));
  assert.throws(() => encodeChoreography(["unknown"], allowed));
  const longState = "x".repeat(64);
  assert.throws(() => encodeChoreography(Array.from({ length: 16 }, () => longState), [longState]));
});

test("base64url encoder covers one-, two-, and three-byte tails", () => {
  const variants = ["a", "aa", "aaa", "aaaa", "aaaaa"];
  for (const state of variants) {
    const fragment = encodeChoreography([state], [state]);
    assert.deepEqual(decodeChoreography(fragment, [state]), { ok: true, states: [state] });
  }
});

test("choreography decoder rejects every untrusted representation class", () => {
  assert.deepEqual(decodeChoreography("", allowed), { ok: false, reason: "absent" });
  assert.deepEqual(decodeChoreography("#play=WyJpZGxlIl0=", allowed), { ok: false, reason: "alphabet" });
  assert.deepEqual(decodeChoreography("#play=%%%", allowed), { ok: false, reason: "alphabet" });
  assert.deepEqual(decodeChoreography(`#play=${"A".repeat(507)}`, allowed), { ok: false, reason: "oversize" });
  assert.deepEqual(decodeChoreography("#play=A", allowed), { ok: false, reason: "encoding" });
  assert.deepEqual(decodeChoreography("#play=e25vdC1qc29ufQ", allowed), { ok: false, reason: "json" });
  assert.deepEqual(decodeChoreography("#play=Im5vdC1hbi1hcnJheSI", allowed), { ok: false, reason: "shape" });
  assert.deepEqual(decodeChoreography("#play=WyJ1bmtub3duIl0", allowed), { ok: false, reason: "unknown-state" });
  assert.deepEqual(decodeChoreography("#play=WyJpZGxlIl1", allowed), { ok: false, reason: "non-canonical" });
  assert.deepEqual(decodeChoreography("#play=WyJpZGxlIl0A", allowed), { ok: false, reason: "json" });
});

test("hash navigation replaces choreography and teardown stops updates", () => {
  let listener: (() => void) | null = null;
  const location = { hash: "#play=first" };
  const fragments: string[] = [];
  const source = {
    location,
    addEventListener(type: "hashchange", next: () => void) {
      assert.equal(type, "hashchange");
      listener = next;
    },
    removeEventListener(type: "hashchange", next: () => void) {
      assert.equal(type, "hashchange");
      assert.equal(next, listener);
      listener = null;
    },
  };

  const unsubscribe = observeChoreographyFragment(source, (fragment) => fragments.push(fragment));
  assert.deepEqual(fragments, ["#play=first"]);
  location.hash = "#play=replacement";
  assert.ok(listener);
  (listener as () => void)();
  assert.deepEqual(fragments, ["#play=first", "#play=replacement"]);
  unsubscribe();
  location.hash = "#play=ignored";
  assert.equal(listener, null);
  assert.deepEqual(fragments, ["#play=first", "#play=replacement"]);
});
