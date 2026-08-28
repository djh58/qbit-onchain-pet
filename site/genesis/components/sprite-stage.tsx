"use client";

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useSpritePlayer } from "../hooks/use-sprite";
import type { FrameSelection, ReadyGenesis } from "../model/types";
import styles from "../genesis.module.css";

const STATE_LABELS: Readonly<Record<string, string>> = {
  idle: "Idle",
  "running-right": "Right",
  "running-left": "Left",
  waving: "Wave",
  jumping: "Jump",
  failed: "Fail",
  waiting: "Wait",
  running: "Run",
  review: "Review",
};

type SpriteStageProps = Readonly<{
  artifact: ReadyGenesis;
  reducedMotion: boolean;
  choreography: readonly string[];
  onManualState: (stateId: string) => void;
}>;

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

export function SpriteStage({ artifact, reducedMotion, choreography, onManualState }: SpriteStageProps) {
  const petName = artifact.qpet.manifest.displayName;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const sheetImageRef = useRef(artifact.sheetImage);
  const highlightRef = useRef<HTMLSpanElement>(null);
  const mobileCellInsetRef = useRef<HTMLSpanElement>(null);
  const selectionTextRef = useRef<HTMLSpanElement>(null);
  const choreographyTimersRef = useRef<number[]>([]);
  const choreographyActiveRef = useRef(!reducedMotion && choreography.length > 0);
  const inactivityTimerRef = useRef<number | null>(null);
  const [xrayOpen, setXrayOpen] = useState(false);
  const player = useSpritePlayer(artifact.qpet.manifest.states, artifact.qpet.manifest.frame, reducedMotion);
  const { activeStateId, selectState, subscribe } = player;

  const clearChoreographyTimers = useCallback(() => {
    for (const timer of choreographyTimersRef.current) window.clearTimeout(timer);
    choreographyTimersRef.current = [];
    choreographyActiveRef.current = false;
  }, []);

  const cancelChoreography = useCallback(() => {
    clearChoreographyTimers();
  }, [clearChoreographyTimers]);

  const clearInactivity = useCallback(() => {
    if (inactivityTimerRef.current !== null) window.clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = null;
  }, []);

  const scheduleWaiting = useCallback(() => {
    clearInactivity();
    if (reducedMotion) return;
    inactivityTimerRef.current = window.setTimeout(() => {
      selectState("waiting");
      inactivityTimerRef.current = null;
    }, 4_200);
  }, [clearInactivity, reducedMotion, selectState]);

  const issueManualCommand = useCallback((stateId: string) => {
    cancelChoreography();
    clearInactivity();
    if (!selectState(stateId)) return;
    onManualState(stateId);
    scheduleWaiting();
  }, [cancelChoreography, clearInactivity, onManualState, scheduleWaiting, selectState]);

  useEffect(() => subscribe((selection: FrameSelection) => {
    const surface = surfaceRef.current;
    if (surface) {
      surface.style.setProperty("--source-x", `${selection.sourceRect.x}px`);
      surface.style.setProperty("--source-y", `${selection.sourceRect.y}px`);
    }
    const highlight = highlightRef.current;
    if (highlight) {
      highlight.style.setProperty("--cell-left", `${(selection.sourceRect.x / artifact.qpet.manifest.frame.width / artifact.qpet.manifest.frame.columns) * 100}%`);
      highlight.style.setProperty("--cell-top", `${(selection.sourceRect.y / artifact.qpet.manifest.frame.height / artifact.qpet.manifest.frame.rows) * 100}%`);
      highlight.style.setProperty("--cell-width", `${100 / artifact.qpet.manifest.frame.columns}%`);
      highlight.style.setProperty("--cell-height", `${100 / artifact.qpet.manifest.frame.rows}%`);
    }
    const mobileInset = mobileCellInsetRef.current;
    if (mobileInset) {
      const insetScale = 0.8;
      mobileInset.style.backgroundPosition = `${-selection.sourceRect.x * insetScale}px ${-selection.sourceRect.y * insetScale}px`;
      mobileInset.style.backgroundSize = `${artifact.qpet.manifest.frame.width * artifact.qpet.manifest.frame.columns * insetScale}px ${artifact.qpet.manifest.frame.height * artifact.qpet.manifest.frame.rows * insetScale}px`;
    }
    if (selectionTextRef.current) {
      selectionTextRef.current.textContent = `${selection.stateId} · row ${selection.row} · frame ${selection.column + 1}/${selection.frameCount} · ${selection.fps} FPS · ${selection.sourceRect.x},${selection.sourceRect.y} ${selection.sourceRect.width}×${selection.sourceRect.height}`;
    }
  }), [artifact.qpet.manifest.frame, subscribe]);

  useEffect(() => {
    const host = surfaceRef.current;
    const image = sheetImageRef.current;
    if (!host) return;
    image.className = styles.sheetImage;
    host.prepend(image);
    return () => {
      if (image.parentElement === host) host.removeChild(image);
    };
  }, []);

  // Run before paint on a live preference change so a queued choreography
  // callback can never observe an active autoplay policy under reduced motion.
  useLayoutEffect(() => {
    if (!reducedMotion) return;
    clearChoreographyTimers();
    clearInactivity();
  }, [clearChoreographyTimers, clearInactivity, reducedMotion]);

  useEffect(() => {
    clearChoreographyTimers();
    clearInactivity();
    if (reducedMotion || choreography.length === 0) return;
    choreographyActiveRef.current = true;
    let delay = 0;
    for (const stateId of choreography) {
      const state = artifact.qpet.manifest.states.find((candidate) => candidate.id === stateId);
      if (!state) continue;
      const timer = window.setTimeout(() => selectState(stateId), delay);
      choreographyTimersRef.current.push(timer);
      delay += Math.max(240, (state.frames / state.fps) * 1_000);
    }
    choreographyTimersRef.current.push(window.setTimeout(() => {
      selectState(artifact.qpet.manifest.states[0].id);
      choreographyActiveRef.current = false;
      choreographyTimersRef.current = [];
    }, delay));
    return clearChoreographyTimers;
  }, [artifact.qpet.manifest.states, choreography, clearChoreographyTimers, clearInactivity, reducedMotion, selectState]);

  useEffect(() => {
    const close = () => setXrayOpen(false);
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key.toLowerCase() === "x" && !event.repeat && !isTypingTarget(event.target)) setXrayOpen(true);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "x") close();
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", close);
    };
  }, []);

  useEffect(() => () => {
    clearChoreographyTimers();
    clearInactivity();
  }, [clearChoreographyTimers, clearInactivity]);

  const xrayPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "touch") {
      setXrayOpen((open) => !open);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setXrayOpen(true);
  };

  const xrayKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " " || event.key.toLowerCase() === "x") {
      event.preventDefault();
      setXrayOpen(true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      setXrayOpen((open) => !open);
    } else if (event.key === "Escape") {
      setXrayOpen(false);
    }
  };

  const surfaceStyle = {
    "--sheet-width": `${artifact.qpet.manifest.frame.width * artifact.qpet.manifest.frame.columns}px`,
    "--sheet-height": `${artifact.qpet.manifest.frame.height * artifact.qpet.manifest.frame.rows}px`,
  } as CSSProperties;

  return (
    <div className={styles.stageReady} data-xray={xrayOpen ? "open" : "closed"}>
      <button
        type="button"
        className={styles.spriteInteraction}
        aria-label={`${petName} animation. Arrow keys run, Up jumps, and Enter waves.`}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") issueManualCommand("running-left");
          else if (event.key === "ArrowRight") issueManualCommand("running-right");
          else if (event.key === "ArrowUp") issueManualCommand("jumping");
          else return;
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (event.pointerType === "touch" || choreographyActiveRef.current || xrayOpen) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const next = event.clientX < bounds.left + bounds.width / 2 ? "running-left" : "running-right";
          if (next !== activeStateId) issueManualCommand(next);
        }}
        onPointerLeave={scheduleWaiting}
        onClick={() => issueManualCommand("waving")}
        onFocus={() => {
          if (!choreographyActiveRef.current) issueManualCommand("review");
        }}
        onBlur={scheduleWaiting}
      >
        <div
          ref={surfaceRef}
          className={`${styles.spriteSurface} ${xrayOpen ? styles.spriteXray : styles.spriteCrop}`}
          style={surfaceStyle}
          role="img"
          aria-label={xrayOpen ? `The verified ${petName} spritesheet with the current animation cell highlighted` : `${petName} performing ${activeStateId}`}
          data-media-origin="verified-blob"
        >
          <span ref={highlightRef} className={styles.xrayHighlight} aria-hidden="true" />
          <span
            ref={mobileCellInsetRef}
            className={styles.mobileCellInset}
            style={{ backgroundImage: `url("${artifact.sheetUrl}")` }}
            aria-hidden="true"
          >
            <span>active cell</span>
          </span>
        </div>
      </button>

      <p className={styles.frameDescription} aria-live="off">
        <span ref={selectionTextRef}>idle · row 0 · frame 1</span>
      </p>

      <div className={styles.stateControls} role="group" aria-label={`Nine manifest-defined ${petName} states`}>
        {artifact.qpet.manifest.states.map((state) => (
          <button
            type="button"
            key={state.id}
            aria-label={`Play ${state.id}`}
            aria-pressed={activeStateId === state.id}
            title={state.id}
            onClick={() => issueManualCommand(state.id)}
          >
            {STATE_LABELS[state.id] ?? state.id}
          </button>
        ))}
      </div>

      <button
        className={styles.xrayControl}
        type="button"
        aria-pressed={xrayOpen}
        aria-label="Inspect the exact verified spritesheet cell"
        onPointerDown={xrayPointerDown}
        onPointerUp={(event) => {
          if (event.pointerType !== "touch") setXrayOpen(false);
        }}
        onPointerCancel={() => setXrayOpen(false)}
        onKeyDown={xrayKeyDown}
        onKeyUp={(event) => {
          if (event.key === " " || event.key.toLowerCase() === "x") setXrayOpen(false);
        }}
        onBlur={() => setXrayOpen(false)}
      >
        {xrayOpen ? "Release to return" : "Hold X-ray"}
        <span aria-hidden="true"> X</span>
      </button>

      <p className={styles.stageFootnote}>
        {xrayOpen
          ? `${artifact.qpet.manifest.sheet.length.toLocaleString()} verified bytes · sha256 ${artifact.qpet.bodySha256}`
          : reducedMotion
            ? "Reduced motion · first frame of each selected state"
            : "Verified Blob frame · hold X-ray to see its source cell"}
      </p>
    </div>
  );
}
