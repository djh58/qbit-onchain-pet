import assert from "node:assert/strict";
import { test } from "vitest";
import {
  INITIAL_RECOVERY_STATE,
  PROOF_STAGES,
  failureCopy,
  recoveryReducer,
  type RecoveryState,
} from "../../genesis/model/recovery.ts";
import type { ReadyGenesis } from "../../genesis/model/types.ts";

const artifact = Object.freeze({ sheetUrl: "blob:https://example.test/verified" }) as unknown as ReadyGenesis;

test("recovery reaches ready only through every truthful stage", () => {
  let state: RecoveryState = INITIAL_RECOVERY_STATE;
  state = recoveryReducer(state, { type: "start", attemptId: 1, at: 1 });
  assert.equal(state.stage, "fetching");
  for (const [index, stage] of PROOF_STAGES.slice(1).entries()) {
    state = recoveryReducer(state, { type: "advance", attemptId: 1, stage, at: index + 2 });
    assert.equal(state.stage, stage);
  }
  state = recoveryReducer(state, { type: "ready", attemptId: 1, artifact, at: 20 });
  assert.equal(state.stage, "ready");
  assert.equal(state.artifact, artifact);
  for (const stage of PROOF_STAGES) {
    assert.equal(typeof state.enteredAt[stage], "number");
    assert.equal(typeof state.completedAt[stage], "number");
  }
});

test("recovery refuses skipped stages and stale completions", () => {
  const state = recoveryReducer(INITIAL_RECOVERY_STATE, { type: "start", attemptId: 3, at: 1 });
  const skipped = recoveryReducer(state, { type: "advance", attemptId: 3, stage: "hashing-sheet", at: 2 });
  assert.equal(skipped, state);
  const stale = recoveryReducer(state, { type: "advance", attemptId: 2, stage: "locating-output", at: 2 });
  assert.equal(stale, state);
  const prematureReady = recoveryReducer(state, { type: "ready", attemptId: 3, artifact, at: 3 });
  assert.equal(prematureReady, state);
});

test("a newer attempt supersedes failure and old events cannot install bytes", () => {
  let state = recoveryReducer(INITIAL_RECOVERY_STATE, { type: "start", attemptId: 1, at: 1 });
  state = recoveryReducer(state, {
    type: "fail",
    attemptId: 1,
    at: 2,
    failure: { code: "network", stage: "fetching", retryable: true },
  });
  assert.equal(state.stage, "failed");
  state = recoveryReducer(state, { type: "start", attemptId: 2, at: 3 });
  assert.equal(state.stage, "fetching");
  assert.equal(state.failure, undefined);
  const stale = recoveryReducer(state, { type: "ready", attemptId: 1, artifact, at: 4 });
  assert.equal(stale.stage, "fetching");
  assert.equal(stale.artifact, undefined);
});

test("media timeout copy never claims that transaction bytes were unaccepted", () => {
  assert.deepEqual(
    failureCopy({ code: "timeout", stage: "decoding-image", retryable: true }),
    {
      title: "The verified image decode timed out.",
      detail: "The inscription hashes passed, but the browser did not finish decoding the WebP. The temporary Blob was revoked; retry to decode it again.",
    },
  );
});

test("idle, ready, and failed states reject impossible or terminal events", () => {
  const fromIdle = recoveryReducer(INITIAL_RECOVERY_STATE, {
    type: "advance",
    attemptId: 0,
    stage: "fetching",
    at: 1,
  });
  assert.equal(fromIdle, INITIAL_RECOVERY_STATE);

  let ready: RecoveryState = recoveryReducer(INITIAL_RECOVERY_STATE, { type: "start", attemptId: 1, at: 1 });
  for (const [index, stage] of PROOF_STAGES.slice(1).entries()) {
    ready = recoveryReducer(ready, { type: "advance", attemptId: 1, stage, at: index + 2 });
  }
  ready = recoveryReducer(ready, { type: "ready", attemptId: 1, artifact, at: 20 });
  assert.equal(recoveryReducer(ready, {
    type: "fail",
    attemptId: 1,
    at: 21,
    failure: { code: "internal", stage: "decoding-image", retryable: false },
  }), ready);
  assert.equal(recoveryReducer(ready, { type: "advance", attemptId: 1, stage: "fetching", at: 22 }), ready);

  let failed = recoveryReducer(INITIAL_RECOVERY_STATE, { type: "start", attemptId: 2, at: 1 });
  failed = recoveryReducer(failed, {
    type: "fail",
    attemptId: 2,
    at: 2,
    failure: { code: "network", stage: "fetching", retryable: true },
  });
  assert.equal(recoveryReducer(failed, { type: "ready", attemptId: 2, artifact, at: 3 }), failed);
  assert.equal(recoveryReducer(failed, { type: "start", attemptId: 2, at: 4 }), failed);
});

test("failure copy is exhaustive across every public failure family", () => {
  const cases = [
    ["timeout", "The public source timed out."],
    ["network", "The public source is unavailable."],
    ["http", "The public source is unavailable."],
    ["oversize", "The source response was refused."],
    ["malformed-transaction", "The source response was refused."],
    ["txid-mismatch", "Transaction identity did not match."],
    ["unsupported-script", "The Genesis output was not found."],
    ["invalid-envelope", "The QPET envelope was invalid."],
    ["hash-mismatch", "The inscription bytes did not match."],
    ["media-invalid", "The verified bytes could not become an image."],
    ["internal", "Recovery stopped safely."],
  ] as const;
  for (const [code, title] of cases) {
    assert.equal(failureCopy({ code, stage: "fetching", retryable: false }).title, title);
  }
  assert.equal(failureCopy().title, "Recovery stopped safely.");
});
