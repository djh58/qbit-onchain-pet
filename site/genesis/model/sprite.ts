import type { FrameSelection, PetState } from "./types";

export type FrameGeometry = Readonly<{ width: number; height: number }>;

export function frameSelection(state: PetState, column: number, frame: FrameGeometry): FrameSelection {
  const safeColumn = Math.max(0, Math.min(column, state.frames - 1));
  return Object.freeze({
    stateId: state.id,
    row: state.row,
    column: safeColumn,
    frameCount: state.frames,
    fps: state.fps,
    loop: state.loop,
    sourceRect: Object.freeze({
      x: safeColumn * frame.width,
      y: state.row * frame.height,
      width: frame.width,
      height: frame.height,
    }),
  });
}

export type FrameAdvance = Readonly<{
  selection: FrameSelection;
  resetToDefault: boolean;
}>;

export function advanceFrame(
  state: PetState,
  column: number,
  frame: FrameGeometry,
  defaultState: PetState,
): FrameAdvance {
  const nextColumn = column + 1;
  if (nextColumn < state.frames) {
    return { selection: frameSelection(state, nextColumn, frame), resetToDefault: false };
  }
  if (state.loop) {
    return { selection: frameSelection(state, 0, frame), resetToDefault: false };
  }
  return { selection: frameSelection(defaultState, 0, frame), resetToDefault: true };
}
