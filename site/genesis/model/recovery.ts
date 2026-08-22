import type { ReadyGenesis } from "./types";

export const PROOF_STAGES = [
  "fetching",
  "locating-output",
  "decoding-envelope",
  "validating-manifest",
  "hashing-envelope",
  "hashing-sheet",
  "attesting-block",
  "decoding-image",
] as const;

export type ProofStage = (typeof PROOF_STAGES)[number];
export type RecoveryStage = "idle" | ProofStage | "ready" | "failed";

export type FailureCode =
  | "timeout"
  | "network"
  | "http"
  | "oversize"
  | "malformed-transaction"
  | "txid-mismatch"
  | "unsupported-script"
  | "invalid-envelope"
  | "hash-mismatch"
  | "media-invalid"
  | "internal";

export type RecoveryFailure = Readonly<{
  code: FailureCode;
  stage: ProofStage;
  retryable: boolean;
  diagnostic?: string;
}>;

export type RecoveryState = Readonly<{
  attemptId: number;
  stage: RecoveryStage;
  startedAt?: number;
  enteredAt: Partial<Record<ProofStage, number>>;
  completedAt: Partial<Record<ProofStage, number>>;
  artifact?: ReadyGenesis;
  failure?: RecoveryFailure;
}>;

export type RecoveryEvent =
  | Readonly<{ type: "start"; attemptId: number; at: number }>
  | Readonly<{ type: "advance"; attemptId: number; stage: ProofStage; at: number }>
  | Readonly<{ type: "ready"; attemptId: number; artifact: ReadyGenesis; at: number }>
  | Readonly<{ type: "fail"; attemptId: number; failure: RecoveryFailure; at: number }>;

export const INITIAL_RECOVERY_STATE: RecoveryState = Object.freeze({
  attemptId: 0,
  stage: "idle",
  enteredAt: {},
  completedAt: {},
});

function stageIndex(stage: ProofStage): number {
  return PROOF_STAGES.indexOf(stage);
}

function completeCurrent(
  completedAt: Partial<Record<ProofStage, number>>,
  stage: ProofStage,
  at: number,
): Partial<Record<ProofStage, number>> {
  return { ...completedAt, [stage]: at };
}

// Every completion is scoped to one attempt. A superseded request cannot make
// bytes renderable, even if its network or image work finishes later.
export function recoveryReducer(state: RecoveryState, event: RecoveryEvent): RecoveryState {
  if (event.type === "start") {
    if (event.attemptId <= state.attemptId) return state;
    return {
      attemptId: event.attemptId,
      stage: "fetching",
      startedAt: event.at,
      enteredAt: { fetching: event.at },
      completedAt: {},
    };
  }

  if (
    event.attemptId !== state.attemptId ||
    state.stage === "idle" ||
    state.stage === "ready" ||
    state.stage === "failed"
  ) return state;

  if (event.type === "advance") {
    const expectedIndex = stageIndex(state.stage) + 1;
    if (PROOF_STAGES.indexOf(event.stage) !== expectedIndex) return state;
    return {
      ...state,
      stage: event.stage,
      enteredAt: { ...state.enteredAt, [event.stage]: event.at },
      completedAt: completeCurrent(state.completedAt, state.stage, event.at),
      artifact: undefined,
      failure: undefined,
    };
  }

  if (event.type === "ready") {
    if (state.stage !== "decoding-image") return state;
    return {
      ...state,
      stage: "ready",
      completedAt: completeCurrent(state.completedAt, state.stage, event.at),
      artifact: event.artifact,
      failure: undefined,
    };
  }

  return {
    ...state,
    stage: "failed",
    completedAt: completeCurrent(state.completedAt, state.stage, event.at),
    artifact: undefined,
    failure: event.failure,
  };
}

export const PROOF_STAGE_LABELS: Readonly<Record<ProofStage, string>> = {
  fetching: "fetch transaction",
  "locating-output": "locate QPET output",
  "attesting-block": "cross-check explorer block",
  "decoding-envelope": "decode envelope",
  "validating-manifest": "validate manifest",
  "hashing-envelope": "hash envelope bytes",
  "hashing-sheet": "hash sheet bytes",
  "decoding-image": "decode verified image",
};

export function failureCopy(failure?: RecoveryFailure): Readonly<{ title: string; detail: string }> {
  if (failure?.code === "timeout" && failure.stage === "decoding-image") {
    return {
      title: "The verified image decode timed out.",
      detail: "The inscription hashes passed, but the browser did not finish decoding the WebP. The temporary Blob was revoked; retry to decode it again.",
    };
  }
  switch (failure?.code) {
    case "timeout":
      return { title: "The public source timed out.", detail: "No response bytes were accepted. Retry or verify the transaction with your own Qbit node." };
    case "network":
    case "http":
      return { title: "The public source is unavailable.", detail: "No bytes, no Qbit. Retry when the explorer is reachable or use the local verification command below." };
    case "oversize":
    case "malformed-transaction":
      return { title: "The source response was refused.", detail: "The transaction response failed its size or structure boundary before inscription bytes were trusted." };
    case "txid-mismatch":
      return { title: "Transaction identity did not match.", detail: "The response could not be reconstructed into the requested transaction ID, so the stage stays empty." };
    case "unsupported-script":
      return { title: "The Genesis output was not found.", detail: "Output zero did not contain the expected single QPET data push." };
    case "invalid-envelope":
      return { title: "The QPET envelope was invalid.", detail: "The recovered bytes did not satisfy the frozen QPET v1 structure and manifest rules." };
    case "hash-mismatch":
      return { title: "The inscription bytes did not match.", detail: "Pinned envelope or sheet identity failed. No Blob URL was created and no mascot can render." };
    case "media-invalid":
      return { title: "The verified bytes could not become an image.", detail: "The browser rejected the WebP or its decoded dimensions. There is no local fallback." };
    default:
      return { title: "Recovery stopped safely.", detail: "An unexpected browser failure left the stage empty. Retry or use the local node verification path." };
  }
}
