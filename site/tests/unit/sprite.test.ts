import assert from "node:assert/strict";
import { test } from "vitest";
import { advanceFrame, frameSelection } from "../../genesis/model/sprite.ts";
import type { PetState } from "../../genesis/model/types.ts";

const frame = Object.freeze({ width: 192, height: 208 });
const states: readonly PetState[] = Object.freeze([
  { id: "idle", row: 0, frames: 6, fps: 6, loop: true },
  { id: "running-right", row: 1, frames: 8, fps: 12, loop: true },
  { id: "running-left", row: 2, frames: 8, fps: 12, loop: true },
  { id: "waving", row: 3, frames: 4, fps: 5, loop: false },
  { id: "jumping", row: 4, frames: 5, fps: 14, loop: false },
  { id: "failed", row: 5, frames: 8, fps: 6, loop: false },
  { id: "waiting", row: 6, frames: 6, fps: 4, loop: true },
  { id: "running", row: 7, frames: 6, fps: 12, loop: true },
  { id: "review", row: 8, frames: 6, fps: 6, loop: true },
]);

test("every state maps first and last frames to exact source rectangles", () => {
  for (const state of states) {
    const first = frameSelection(state, 0, frame);
    const last = frameSelection(state, state.frames - 1, frame);
    assert.deepEqual(first.sourceRect, { x: 0, y: state.row * 208, width: 192, height: 208 });
    assert.deepEqual(last.sourceRect, { x: (state.frames - 1) * 192, y: state.row * 208, width: 192, height: 208 });
    assert.equal(first.stateId, state.id);
    assert.equal(first.frameCount, state.frames);
    assert.equal(first.fps, state.fps);
  }
});

test("loop wrap and one-shot reset share the player boundary contract", () => {
  const idle = states[0];
  const advanced = advanceFrame(states[1], 0, frame, idle);
  assert.equal(advanced.selection.column, 1);
  assert.equal(advanced.resetToDefault, false);
  const looped = advanceFrame(states[1], states[1].frames - 1, frame, idle);
  assert.equal(looped.selection.stateId, "running-right");
  assert.equal(looped.selection.column, 0);
  assert.equal(looped.resetToDefault, false);

  const reset = advanceFrame(states[3], states[3].frames - 1, frame, idle);
  assert.equal(reset.selection.stateId, "idle");
  assert.equal(reset.selection.column, 0);
  assert.equal(reset.resetToDefault, true);
});

test("out-of-range columns are clamped before DOM consumers see them", () => {
  assert.equal(frameSelection(states[0], -12, frame).column, 0);
  assert.equal(frameSelection(states[0], 99, frame).column, states[0].frames - 1);
});
