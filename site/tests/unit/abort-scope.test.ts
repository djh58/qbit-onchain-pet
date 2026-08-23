import assert from "node:assert/strict";
import { test } from "vitest";
import { createAbortScope } from "../../genesis/model/abort-scope.ts";

test("an expired required phase cannot poison a later media phase", () => {
  const lifecycle = new AbortController();
  const required = createAbortScope(lifecycle.signal);
  required.abortForDeadline();
  assert.equal(required.signal.aborted, true);
  assert.equal(lifecycle.signal.aborted, false);
  required.dispose();

  const media = createAbortScope(lifecycle.signal);
  assert.equal(media.signal.aborted, false);
  lifecycle.abort();
  assert.equal(media.signal.aborted, true);
  media.dispose();
});

test("a scope created after lifecycle abort starts aborted", () => {
  const lifecycle = new AbortController();
  lifecycle.abort();
  const scope = createAbortScope(lifecycle.signal);
  assert.equal(scope.signal.aborted, true);
  scope.dispose();
});
