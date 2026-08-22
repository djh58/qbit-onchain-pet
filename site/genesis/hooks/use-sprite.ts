"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { advanceFrame, frameSelection, type FrameGeometry } from "../model/sprite";
import type { FrameSelection, PetState } from "../model/types";

type SelectionListener = (selection: FrameSelection) => void;

export function useSpritePlayer(
  states: readonly PetState[],
  frame: FrameGeometry,
  reducedMotion: boolean,
) {
  const defaultState = states[0];
  const [activeStateId, setActiveStateId] = useState(defaultState.id);
  const stateIdRef = useRef(defaultState.id);
  const selectionRef = useRef<FrameSelection>(frameSelection(defaultState, 0, frame));
  const listenersRef = useRef(new Set<SelectionListener>());
  const commandVersionRef = useRef(0);

  const publish = useCallback((selection: FrameSelection) => {
    selectionRef.current = selection;
    for (const listener of listenersRef.current) listener(selection);
  }, []);

  const selectState = useCallback((stateId: string) => {
    const nextState = states.find((state) => state.id === stateId);
    if (!nextState) return false;
    stateIdRef.current = nextState.id;
    commandVersionRef.current += 1;
    publish(frameSelection(nextState, 0, frame));
    setActiveStateId(nextState.id);
    return true;
  }, [frame, publish, states]);

  const subscribe = useCallback((listener: SelectionListener) => {
    listenersRef.current.add(listener);
    listener(selectionRef.current);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!states.some((state) => state.id === stateIdRef.current)) selectState(defaultState.id);
  }, [defaultState.id, selectState, states]);

  // One clock owns the immutable frame selection. Per-frame work updates
  // subscribed DOM targets directly; React commits only when the state changes.
  useEffect(() => {
    let animationFrame = 0;
    let lastTimestamp: number | null = null;
    let elapsed = 0;
    let seenCommandVersion = commandVersionRef.current;

    const stop = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };

    const tick = (timestamp: number) => {
      if (document.hidden || reducedMotion) {
        stop();
        return;
      }
      if (seenCommandVersion !== commandVersionRef.current) {
        seenCommandVersion = commandVersionRef.current;
        lastTimestamp = timestamp;
        elapsed = 0;
      }
      if (lastTimestamp === null) lastTimestamp = timestamp;
      elapsed += Math.min(timestamp - lastTimestamp, 250);
      lastTimestamp = timestamp;

      const state = states.find((candidate) => candidate.id === stateIdRef.current) ?? defaultState;
      const frameDuration = 1_000 / state.fps;
      while (elapsed >= frameDuration) {
        elapsed -= frameDuration;
        const advanced = advanceFrame(state, selectionRef.current.column, frame, defaultState);
        publish(advanced.selection);
        if (advanced.resetToDefault) {
          stateIdRef.current = defaultState.id;
          commandVersionRef.current += 1;
          setActiveStateId(defaultState.id);
          elapsed = 0;
          break;
        }
      }
      animationFrame = requestAnimationFrame(tick);
    };

    const start = () => {
      stop();
      lastTimestamp = null;
      if (reducedMotion) {
        const state = states.find((candidate) => candidate.id === stateIdRef.current) ?? defaultState;
        publish(frameSelection(state, 0, frame));
        return;
      }
      if (!document.hidden) animationFrame = requestAnimationFrame(tick);
    };

    const visibilityChanged = () => start();
    document.addEventListener("visibilitychange", visibilityChanged);
    start();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [defaultState, frame, publish, reducedMotion, states]);

  return {
    activeStateId,
    selectState,
    subscribe,
  };
}
