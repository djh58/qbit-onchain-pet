"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { GENESIS } from "../model/facts";
import { createAbortScope } from "../model/abort-scope";
import {
  INITIAL_RECOVERY_STATE,
  recoveryReducer,
  type ProofStage,
  type RecoveryFailure,
} from "../model/recovery";
import type { ReadyGenesis } from "../model/types";
import { recoverGenesis } from "../services/chain-source";

const RECOVERY_TIMEOUT_MS = 10_000;
const MEDIA_DECODE_TIMEOUT_MS = 10_000;

function decodeVerifiedImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const abort = () => {
      image.src = "";
      reject(new DOMException("Aborted", "AbortError"));
    };
    image.onload = () => {
      signal.removeEventListener("abort", abort);
      if (image.naturalWidth !== GENESIS.sheetWidth || image.naturalHeight !== GENESIS.sheetHeight) {
        reject(new Error("dimension mismatch"));
        return;
      }
      resolve(image);
    };
    image.onerror = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("decode failed"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    image.src = url;
  });
}

export function useGenesis() {
  const [state, dispatch] = useReducer(recoveryReducer, INITIAL_RECOVERY_STATE);
  const attemptRef = useRef(0);
  // This controller represents retry/unmount only. Phase deadlines abort
  // child scopes, so one expired phase cannot poison a later phase.
  const controllerRef = useRef<AbortController | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const clearAttempt = useCallback((revokeBlob: boolean) => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (revokeBlob && imageRef.current) {
      imageRef.current.remove();
      imageRef.current.src = "";
      imageRef.current = null;
    }
    if (revokeBlob && blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    if (revokeBlob) blobUrlRef.current = null;
  }, []);

  const start = useCallback(() => {
    clearAttempt(true);
    const attemptId = attemptRef.current + 1;
    attemptRef.current = attemptId;
    const lifecycleController = new AbortController();
    controllerRef.current = lifecycleController;
    dispatch({ type: "start", attemptId, at: Date.now() });

    const reportStage = (stage: ProofStage) => {
      dispatch({ type: "advance", attemptId, stage, at: Date.now() });
    };

    void (async () => {
      const recoveryScope = createAbortScope(lifecycleController.signal);
      const recoveryTimeout = window.setTimeout(recoveryScope.abortForDeadline, RECOVERY_TIMEOUT_MS);
      const result = await recoverGenesis(
        recoveryScope.signal,
        reportStage,
        undefined,
        lifecycleController.signal,
      );
      window.clearTimeout(recoveryTimeout);
      recoveryScope.dispose();
      if (attemptId !== attemptRef.current) return;
      if (!result.ok) {
        dispatch({ type: "fail", attemptId, failure: result.error, at: Date.now() });
        clearAttempt(true);
        return;
      }

      dispatch({ type: "advance", attemptId, stage: "decoding-image", at: Date.now() });
      let sheetUrl: string | undefined;
      let sheetImage: HTMLImageElement | undefined;
      let mediaScope: ReturnType<typeof createAbortScope> | undefined;
      let mediaTimeout: number | undefined;
      let decodeAttempted = false;
      let mediaDecoded = false;
      try {
        const sheetBuffer = new Uint8Array(result.value.sheet).buffer;
        sheetUrl = URL.createObjectURL(new Blob([sheetBuffer], { type: result.value.manifest.sheet.contentType }));
        blobUrlRef.current = sheetUrl;
        mediaScope = createAbortScope(lifecycleController.signal);
        mediaTimeout = window.setTimeout(mediaScope.abortForDeadline, MEDIA_DECODE_TIMEOUT_MS);
        decodeAttempted = true;
        sheetImage = await decodeVerifiedImage(sheetUrl, mediaScope.signal);
        mediaDecoded = true;

        if (attemptId !== attemptRef.current) {
          sheetImage.src = "";
          URL.revokeObjectURL(sheetUrl);
          return;
        }
        sheetImage.alt = "";
        sheetImage.setAttribute("aria-hidden", "true");
        imageRef.current = sheetImage;
        controllerRef.current = null;
        const artifact: ReadyGenesis = Object.freeze({ ...result.value, sheetUrl, sheetImage });
        dispatch({ type: "ready", attemptId, artifact, at: Date.now() });
      } catch {
        if (attemptId !== attemptRef.current) return;
        const failure: RecoveryFailure = !decodeAttempted || mediaDecoded
          ? { code: "internal", stage: "decoding-image", retryable: false }
          : mediaScope?.signal.aborted
            ? { code: "timeout", stage: "decoding-image", retryable: true }
            : { code: "media-invalid", stage: "decoding-image", retryable: true };
        dispatch({ type: "fail", attemptId, failure, at: Date.now() });
        clearAttempt(true);
      } finally {
        if (mediaTimeout !== undefined) window.clearTimeout(mediaTimeout);
        mediaScope?.dispose();
      }
    })();
  }, [clearAttempt]);

  useEffect(() => {
    start();
    return () => {
      attemptRef.current += 1;
      clearAttempt(true);
    };
  }, [clearAttempt, start]);

  return { state, retry: start };
}
