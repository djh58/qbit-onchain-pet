"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useGenesis } from "../hooks/use-genesis";
import { useReducedMotion } from "../hooks/use-reduced-motion";
import { decodeChoreography, encodeChoreography, observeChoreographyFragment } from "../model/choreography";
import { ARTIFACTS, artifactDefinition, SOURCE_REPOSITORY, type ArtifactId } from "../model/facts";
import { failureCopy, PROOF_STAGE_LABELS, PROOF_STAGES } from "../model/recovery";
import { buildGenesisShareUrl, createShareAttemptGuard, shareGenesis, type ShareOutcome } from "../model/share";
import { SpriteStage } from "./sprite-stage";
import styles from "../genesis.module.css";

const EMPTY_SEQUENCE: readonly string[] = Object.freeze([]);
const BITS_PER_QBT = 100_000_000;

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

function formatQbtBits(bits: number): string {
  const whole = Math.floor(bits / BITS_PER_QBT);
  const fraction = String(bits % BITS_PER_QBT).padStart(8, "0");
  return `${whole}.${fraction} QBT`;
}

export function GenesisExperience({ artifactId = "qbit" }: Readonly<{ artifactId?: ArtifactId }>) {
  const definition = artifactDefinition(artifactId);
  const facts = definition.facts;
  const presentation = definition.presentation;
  const networkLabel = facts.network === "main" ? "mainnet" : facts.network;
  const { state, retry } = useGenesis(definition);
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

  const manifestStates = state.artifact?.qpet.manifest.states;
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
    const sequence = recordedStates.length > 0 ? recordedStates : [state.artifact.qpet.manifest.states[0].id];
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
      }, { title: presentation.shareTitle, text: presentation.shareText });
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
        ? `No verified bytes. No ${definition.manifestIdentity.displayName}.`
        : `Now: ${PROOF_STAGE_LABELS[state.stage as keyof typeof PROOF_STAGE_LABELS]}`;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="https://qbit.org" target="_blank" rel="noreferrer" aria-label="Qbit homepage">
          <span className={styles.brandMark} aria-hidden="true">Q</span>
          <span>{presentation.brandLabel}</span>
        </a>
        <nav className={styles.artifactSwitch} aria-label="Choose an on-chain QPET">
          {Object.values(ARTIFACTS).map((candidate) => (
            <a
              key={candidate.artifactId}
              href={candidate.route}
              aria-current={candidate.artifactId === artifactId ? "page" : undefined}
            >
              {candidate.presentation.navLabel}
            </a>
          ))}
        </nav>
        <nav className={styles.headerLinks} aria-label="Page links">
          <a href={SOURCE_REPOSITORY} target="_blank" rel="noreferrer">Source ↗</a>
          <button type="button" disabled={!isReady} onClick={() => void handleShare()}>
            {outcomeLabel(shareOutcome)} <span aria-hidden="true">↗</span>
          </button>
        </nav>
      </header>

      <section className={styles.scene} aria-labelledby="qpet-title">
        <div className={styles.story}>
          <p className={styles.coordinate}>{presentation.coordinate}</p>
          <h1 id="qpet-title">{presentation.titleLines[0]}<br />{presentation.titleLines[1]}</h1>
          <p className={styles.lede}>{presentation.lede}</p>

          <div className={`${styles.status} ${isFailed ? styles.statusFailed : isReady && !chainConfirmed ? styles.statusWarning : ""}`} role="status" aria-live="polite">
            <strong>{isReady ? chainConfirmed ? `✓ ${presentation.recoveredLabel}` : "✓ Inscription bytes recovered" : proofLine}</strong>
            <span>
              {isReady ? `byte-perfect envelope + sheet · ${state.artifact?.chainEvidence.detail}` : isFailed ? failure.detail : "Every line reflects work the browser has actually reached."}
            </span>
          </div>

          <a
            className={styles.primaryAction}
            href={presentation.primaryAction.href}
            target={presentation.primaryAction.external ? "_blank" : undefined}
            rel={presentation.primaryAction.external ? "noreferrer" : undefined}
          >
            <span>
              <strong>{presentation.primaryAction.label}</strong>
              <small>{presentation.primaryAction.detail}</small>
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
            <p className={styles.choreographyNotice}>The choreography in this URL was invalid and was ignored. The QPET still recovered normally.</p>
          ) : null}
        </div>

        <div className={`${styles.stage} ${isReady ? styles.awakening : ""}`}>
          {isReady && state.artifact ? (
            <SpriteStage
              key={artifactId}
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
                <code>python3 qpet.py --chain {facts.network} view {facts.transactionId} --out /tmp/qbit-pet.html</code>
              </details>
            </div>
          ) : state.stage === "idle" || state.stage === "fetching" ? (
            <div className={styles.absence}>
              <div className={styles.emptyFrame} aria-hidden="true" />
              <p>No verified bytes. No {definition.manifestIdentity.displayName}.</p>
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
              <p>No verified bytes. No {definition.manifestIdentity.displayName}.</p>
            </div>
          )}
        </div>
      </section>

      <section className={styles.proofRail} aria-label={`${definition.manifestIdentity.displayName} proof summary`}>
        <div><span>Proof</span><strong className={isReady ? styles.good : ""}>{isReady ? "byte-perfect ✓" : isFailed ? "not verified" : "recovering"}</strong></div>
        <div><span>Transaction</span><a href={`${definition.explorerOrigin}/tx/${facts.transactionId}`} target="_blank" rel="noreferrer">{shortHash(facts.transactionId)} ↗</a></div>
        <div><span>Content</span><strong>{facts.envelopeLength.toLocaleString()} B envelope<br />{facts.sheetLength.toLocaleString()} B sheet</strong></div>
        <div><span>Inspect</span><button type="button" onClick={() => {
          if (!receiptRef.current) return;
          receiptRef.current.open = true;
          receiptRef.current.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
        }}>Open receipt ↓</button></div>
      </section>

      <details ref={receiptRef} className={styles.receipt} id="chain-receipt">
        <summary>Complete chain receipt</summary>
        <dl>
          <div><dt>Network</dt><dd>Qbit {networkLabel}</dd></div>
          <div><dt>Network genesis hash</dt><dd>{facts.networkGenesisHash}</dd></div>
          <div><dt>Transaction</dt><dd><a href={`${definition.explorerOrigin}/tx/${facts.transactionId}`} target="_blank" rel="noreferrer">{facts.transactionId} ↗</a></dd></div>
          <div><dt>Transaction identity</dt><dd>{state.artifact ? `${state.artifact.serializedTransactionLength.toLocaleString()} serialized bytes · ID recomputed` : "not yet verified"}</dd></div>
          <div><dt>Output</dt><dd>{facts.outputIndex}</dd></div>
          <div><dt>Block</dt><dd><a href={`${definition.explorerOrigin}/block/${facts.blockHash}`} target="_blank" rel="noreferrer">{facts.blockHeight.toLocaleString()} · {facts.blockHash} ↗</a></dd></div>
          <div><dt>Envelope</dt><dd>{state.artifact ? `${state.artifact.qpet.envelopeBytes.byteLength.toLocaleString()} bytes · QPET v1 decoded` : "not yet verified"}</dd></div>
          <div><dt>Manifest</dt><dd>{state.artifact ? `${state.artifact.qpet.manifest.format} · ${state.artifact.qpet.manifest.id} · ${state.artifact.qpet.manifest.states.length} states` : "not yet verified"}</dd></div>
          <div><dt>Image</dt><dd>{state.artifact ? `${state.artifact.qpet.manifest.sheet.contentType} · ${facts.sheetWidth}×${facts.sheetHeight} decoded` : "not yet verified"}</dd></div>
          <div><dt>Envelope SHA-256</dt><dd>{facts.envelopeSha256}</dd></div>
          <div><dt>Sheet SHA-256</dt><dd>{facts.sheetSha256}</dd></div>
          <div><dt>Chain evidence</dt><dd>{state.artifact?.chainEvidence.detail ?? "not yet available"}</dd></div>
          {facts.recipient ? (
            <>
              <div><dt>Recipient commitment</dt><dd>{state.artifact ? "exact output index + amount + script verified ✓" : "not yet verified"}</dd></div>
              <div><dt>Committed output</dt><dd>{facts.recipient.outputIndex} · {formatQbtBits(facts.recipient.amountBits)} · {facts.recipient.scriptPubKeyType}</dd></div>
              <div><dt>Explorer-decoded address</dt><dd><a href={`${definition.explorerOrigin}/address/${facts.recipient.address}`} target="_blank" rel="noreferrer">{facts.recipient.address} ↗</a></dd></div>
              <div><dt>Recipient script</dt><dd>{facts.recipient.scriptPubKey}</dd></div>
            </>
          ) : null}
          {definition.honor ? (
            <>
              <div><dt>Honors</dt><dd>the miner of Qbit mainnet block 1</dd></div>
              <div><dt>Block 1 hash</dt><dd><a href={`${ARTIFACTS.qbit.explorerOrigin}/block/${definition.honor.blockHash}`} target="_blank" rel="noreferrer">{definition.honor.blockHash} ↗</a></dd></div>
              <div><dt>Block 1 coinbase</dt><dd><a href={`${ARTIFACTS.qbit.explorerOrigin}/tx/${definition.honor.coinbaseTransactionId}`} target="_blank" rel="noreferrer">{definition.honor.coinbaseTransactionId} ↗</a></dd></div>
              <div><dt>Coinbase tags</dt><dd>{definition.honor.coinbaseTags.join(" · ")}</dd></div>
              <div><dt>Payout address</dt><dd>{definition.honor.payoutAddress}</dd></div>
              <div><dt>Block timestamp</dt><dd>{definition.honor.blockTimeIso}</dd></div>
            </>
          ) : null}
          <div><dt>Source code</dt><dd><a href={SOURCE_REPOSITORY} target="_blank" rel="noreferrer">github.com/djh58/qbit-onchain-pet ↗</a></dd></div>
        </dl>
      </details>

      <footer className={styles.footer}>
        <p>{presentation.footerLabel} · {isReady ? "recovered in your browser" : "verification happens in your browser"}</p>
        <div><a href={`${definition.explorerOrigin}/tx/${facts.transactionId}`} target="_blank" rel="noreferrer">Explorer ↗</a><a href={SOURCE_REPOSITORY} target="_blank" rel="noreferrer">Source ↗</a><a href={ARTIFACTS.qbit.presentation.primaryAction.href} target="_blank" rel="noreferrer">Get Qbit ↗</a></div>
      </footer>
    </main>
  );
}
