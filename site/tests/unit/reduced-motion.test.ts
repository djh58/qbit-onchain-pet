import assert from "node:assert/strict";
import { test } from "vitest";
import { observeReducedMotion } from "../../genesis/hooks/use-reduced-motion.ts";

test("reduced-motion observation reports initial and live values, then tears down", () => {
  let listener: (() => void) | null = null;
  let matches = true;
  let removed = false;
  const values: boolean[] = [];
  const media = {
    get matches() { return matches; },
    addEventListener(type: string, next: () => void) {
      assert.equal(type, "change");
      listener = next;
    },
    removeEventListener(type: string, next: () => void) {
      assert.equal(type, "change");
      assert.equal(next, listener);
      removed = true;
    },
  } as unknown as MediaQueryList;

  const unsubscribe = observeReducedMotion((query) => {
    assert.equal(query, "(prefers-reduced-motion: reduce)");
    return media;
  }, (value) => values.push(value));
  assert.deepEqual(values, [true]);
  matches = false;
  assert.ok(listener);
  (listener as () => void)();
  assert.deepEqual(values, [true, false]);
  unsubscribe();
  assert.equal(removed, true);
});
