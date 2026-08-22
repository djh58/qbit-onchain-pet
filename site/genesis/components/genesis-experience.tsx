"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useGenesis } from "../hooks/use-genesis";
import { useReducedMotion } from "../hooks/use-reduced-motion";
import { decodeChoreography, encodeChoreography, observeChoreographyFragment } from "../model/choreography";
import { CODEX_PETS_URL, EXPLORER_ORIGIN, GENESIS, SOURCE_REPOSITORY } from "../model/facts";
import { failureCopy, PROOF_STAGE_LABELS, PROOF_STAGES } from "../model/recovery";
import { buildGenesisShareUrl, createShareAttemptGuard, shareGenesis, type ShareOutcome } from "../model/share";
import { SpriteStage } from "./sprite-stage";
import styles from "../genesis.module.css";

const EMPTY_SEQUENCE: readonly string[] = Object.freeze([]);

function shortHash(hash: string, edge = 8): string {
  return `${hash.slice(0, edge)}…${hash.slice(-edge)}`;
}

function outcomeLabel(outcome: ShareOutcome | null): string {
  switch (outcome) {
    case "shared": return "shared ✓";
    case "copied": return "link copied ✓";
    case "cancelled": return "share cancelled";
    case "manual": return "copy manually";
    case "failed": return "sharing unavailable";
    default: return "share";
  }
}

export function GenesisExperience() {
  const { state, retry } = useGenesis();
  const reducedMotion = useReducedMotion();
  const [recordedStates, setRecordedStates] = useState<readonly string[]>(EMPTY_SEQUENCE);
  const [shareOutcome, setShareOutcome] = useState<ShareOutcome | null>(null);
  const [manualUrl, setManualUrl] = useState("");
  const manualFieldRef = useRef<HTMLInputElement>(null);
  const receiptRef = useRef<HTMLDetailsElement>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const sharingRef = useRef(false);
  const shareGuardRef = useRef(createShareAttemptGuard());
  const [fragment, setFragment] = useState("");

  const manifestStates = state.artifact?.manifest.states;
  const stateIds = useMemo(() => manifestStates?.map((item) => item.id) ?? EMPTY_SEQUENCE, [manifestStates]);
  const decodedChoreography = useMemo(
    () => state.artifact ? decodeChoreography(fragment, stateIds) : null,
    [fragment, state.artifact, stateIds],
  );
  const choreography = decodedChoreography?.ok ? decodedChoreography.states : EMPTY_SEQUENCE;

  useEffect(() => {
    if (!manualUrl) return;
    manualFieldRef.current?.focus();
    manualFieldRef.current?.select();
  }, [manualUrl]);

  useEffect(() => {
    const guard = shareGuardRef.current;
    guard.mount();
    const stopObservingHash = observeChoreographyFragment(window, setFragment);
    return () => {
      stopObservingHash();
      guard.invalidate();
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  const handleShare = async () => {
    if (!state.artifact || sharingRef.current) return;
    const shareAttempt = shareGuardRef.current.begin();
    if (shareAttempt === null) return;
    sharingRef.current = true;
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    const sequence = recordedStates.length > 0 ? recordedStates : [state.artifact.manifest.states[0].id];
    const completeUrl = buildGenesisShareUrl(window.location, encodeChoreography(sequence, stateIds));
    let nativeShare: ((data: ShareData) => Promise<void>) | undefined;
    let clipboardWrite: ((value: string) => Promise<void>) | undefined;
    try {
      nativeShare = navigator.share?.bind(navigator);
      clipboardWrite = navigator.clipboard?.writeText.bind(navigator.clipboard);
    } catch {
      // Capability getters may be denied in embedded browsers.
    }
    let outcome: ShareOutcome;
    try {
      outcome = await shareGenesis(completeUrl, {
        share: nativeShare,
        clipboardWrite,
        secureContext: window.isSecureContext,
        manualAvailable: true,
      });
    } finally {
      if (shareGuardRef.current.isCurrent(shareAttempt)) sharingRef.current = false;
    }
    if (!shareGuardRef.current.isCurrent(shareAttempt)) return;
    setShareOutcome(outcome);
    setManualUrl(outcome === "manual" ? completeUrl : "");
    if (outcome !== "manual") {
      feedbackTimerRef.current = window.setTimeout(() => {
        if (shareGuardRef.current.isCurrent(shareAttempt)) setShareOutcome(null);
      }, 2_400);
    }
  };

  const currentProofIndex = PROOF_STAGES.indexOf(state.stage as (typeof PROOF_STAGES)[number]);
  const isReady = state.stage === "ready" && Boolean(state.artifact);
  const isFailed = state.stage === "failed";
  const chainConfirmed = state.artifact?.chainEvidence.status === "confirmed";
  const failure = failureCopy(state.failure);
  const proofLine = isReady
    ? state.artifact?.chainEvidence.detail
    : isFailed
      ? failure.title
      : state.stage === "idle"
        ? "No verified bytes. No Qbit."
        : `Now: ${PROOF_STAGE_LABELS[state.stage as keyof typeof PROOF_STAGE_LABELS]}`;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="https://qbit.org" target="_blank" rel="noreferrer" aria-label="Qbit homepage">
          <span className={styles.brandMark} aria-hidden="true">Q</span>
          <span>Qbit / Genesis 001</span>
        </a>
        <nav className={styles.headerLinks} aria-label="Page links">
          <a href={SOURCE_REPOSITORY} target="_blank" rel="noreferrer">Source ↗</a>
          <button type="button" disabled={!isReady} onClick={() => void handleShare()}>
            {outcomeLabel(shareOutcome)} <span aria-hidden="true">↗</span>
          </button>
        </nav>
      </header>

      <section className={styles.scene} aria-labelledby="genesis-title">
        <div className={styles.story}>
          <p className={styles.coordinate}>Qbit mainnet · block {GENESIS.blockHeight.toLocaleString()}</p>
          <h1 id="genesis-title">Bytes.<br />Then being.</h1>
          <p className={styles.lede}>Your browser recovers one mainnet transaction, recomputes its ID, verifies every inscription byte, and only then gives Qbit a body.</p>

          <div className={`${styles.status} ${isFailed ? styles.statusFailed : isReady && !chainConfirmed ? styles.statusWarning : ""}`} role="status" aria-live="polite">
            <strong>{isReady ? chainConfirmed ? "✓ Recovered from Qbit mainnet" : "✓ Inscription bytes recovered" : proofLine}</strong>
            <span>
              {isReady ? `byte-perfect envelope + sheet · ${state.artifact?.chainEvidence.detail}` : isFailed ? failure.detail : "Every line reflects work the browser has actually reached."}
            </span>
          </div>

          <a className={styles.primaryAction} href={CODEX_PETS_URL} target="_blank" rel="noreferrer">
            <span>
              <strong>Get Qbit for your coding agent</strong>
              <small>https://codex-pets.net/#/pets/qbit</small>
            </span>
            <span aria-hidden="true">↗</span>
          </a>

          {manualUrl ? (
            <div className={styles.manualShare}>
              <label htmlFor="manual-share-url">Copy this choreography URL manually</label>
              <input ref={manualFieldRef} id="manual-share-url" value={manualUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
            </div>
          ) : null}
          {decodedChoreography && !decodedChoreography.ok && decodedChoreography.reason !== "absent" ? (
            <p className={styles.choreographyNotice}>The choreography in this URL was invalid and was ignored. Qbit still recovered normally.</p>
          ) : null}
        </div>

        <div className={`${styles.stage} ${isReady ? styles.awakening : ""}`}>
          {isReady && state.artifact ? (
            <SpriteStage
              artifact={state.artifact}
              reducedMotion={reducedMotion}
              choreography={choreography}
              onManualState={(stateId) => setRecordedStates((current) => Object.freeze([...current.slice(-15), stateId]))}
            />
          ) : isFailed ? (
            <div className={styles.failureStage}>
              <div className={styles.emptyFrame} aria-hidden="true" />
              <h2>{failure.title}</h2>
              <p>{failure.detail}</p>
              <button type="button" onClick={retry}>Retry chain recovery</button>
              <details>
                <summary>Verify with your own node</summary>
                <code>python3 qpet.py view {GENESIS.transactionId} --out /tmp/qbit-pet.html</code>
              </details>
            </div>
          ) : state.stage === "idle" || state.stage === "fetching" ? (
            <div className={styles.absence}>
              <div className={styles.emptyFrame} aria-hidden="true" />
              <p>No verified bytes. No Qbit.</p>
            </div>
          ) : (
            <div className={styles.recoveryLedger} aria-label="Chain recovery steps">
              <ol>
                {PROOF_STAGES.map((step, index) => {
                  const done = Boolean(state.completedAt[step]);
                  const active = index === currentProofIndex;
                  return <li key={step} data-state={done ? "done" : active ? "active" : "pending"}>{done ? "✓" : active ? "→" : "·"} {PROOF_STAGE_LABELS[step]}</li>;
                })}
              </ol>
              <p>No verified bytes. No Qbit.</p>
            </div>
          )}
        </div>
      </section>

      <section className={styles.proofRail} aria-label="Genesis proof summary">
        <div><span>Proof</span><strong className={isReady ? styles.good : ""}>{isReady ? "byte-perfect ✓" : isFailed ? "not verified" : "recovering"}</strong></div>
        <div><span>Transaction</span><a href={`${EXPLORER_ORIGIN}/tx/${GENESIS.transactionId}`} target="_blank" rel="noreferrer">{shortHash(GENESIS.transactionId)} ↗</a></div>
        <div><span>Content</span><strong>{GENESIS.envelopeLength.toLocaleString()} B envelope<br />{GENESIS.sheetLength.toLocaleString()} B sheet</strong></div>
        <div><span>Inspect</span><button type="button" onClick={() => {
          if (!receiptRef.current) return;
          receiptRef.current.open = true;
          receiptRef.current.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
        }}>Open receipt ↓</button></div>
      </section>

      <details ref={receiptRef} className={styles.receipt} id="chain-receipt">
        <summary>Complete chain receipt</summary>
        <dl>
          <div><dt>Network</dt><dd>Qbit mainnet</dd></div>
          <div><dt>Genesis hash</dt><dd>{GENESIS.networkGenesisHash}</dd></div>
          <div><dt>Transaction</dt><dd><a href={`${EXPLORER_ORIGIN}/tx/${GENESIS.transactionId}`} target="_blank" rel="noreferrer">{GENESIS.transactionId} ↗</a></dd></div>
          <div><dt>Transaction identity</dt><dd>{state.artifact ? `${state.artifact.serializedTransactionLength.toLocaleString()} serialized bytes · ID recomputed` : "not yet verified"}</dd></div>
          <div><dt>Output</dt><dd>{GENESIS.outputIndex}</dd></div>
          <div><dt>Block</dt><dd><a href={`${EXPLORER_ORIGIN}/block/${GENESIS.blockHash}`} target="_blank" rel="noreferrer">{GENESIS.blockHeight.toLocaleString()} · {GENESIS.blockHash} ↗</a></dd></div>
          <div><dt>Envelope</dt><dd>{state.artifact ? `${state.artifact.envelope.byteLength.toLocaleString()} bytes · QPET v1 decoded` : "not yet verified"}</dd></div>
          <div><dt>Manifest</dt><dd>{state.artifact ? `${state.artifact.manifest.format} · ${state.artifact.manifest.id} · ${state.artifact.manifest.states.length} states` : "not yet verified"}</dd></div>
          <div><dt>Image</dt><dd>{state.artifact ? `${state.artifact.manifest.sheet.contentType} · ${GENESIS.sheetWidth}×${GENESIS.sheetHeight} decoded` : "not yet verified"}</dd></div>
          <div><dt>Envelope SHA-256</dt><dd>{GENESIS.envelopeSha256}</dd></div>
          <div><dt>Sheet SHA-256</dt><dd>{GENESIS.sheetSha256}</dd></div>
          <div><dt>Chain evidence</dt><dd>{state.artifact?.chainEvidence.detail ?? "not yet available"}</dd></div>
          <div><dt>Source code</dt><dd><a href={SOURCE_REPOSITORY} target="_blank" rel="noreferrer">github.com/djh58/qbit-onchain-pet ↗</a></dd></div>
        </dl>
      </details>

      <footer className={styles.footer}>
        <p>{isReady ? "Qbit Genesis 001 · recovered in your browser" : "Qbit Genesis 001 · verification happens in your browser"}</p>
        <div><a href={`${EXPLORER_ORIGIN}/tx/${GENESIS.transactionId}`} target="_blank" rel="noreferrer">Explorer ↗</a><a href={SOURCE_REPOSITORY} target="_blank" rel="noreferrer">Source ↗</a><a href={CODEX_PETS_URL} target="_blank" rel="noreferrer">Get Qbit ↗</a></div>
      </footer>
    </main>
  );
}
