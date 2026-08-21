"use client";

import { useEffect, useMemo, useState } from "react";

const TXID = "852748890119300166f0c3050da3fee5c55316d199bcff1425424c009d2e62b9";
const EXPLORER = "https://mempool.qbit.org";
const EXPECTED_ENVELOPE_SHA256 = "e9a9ce232eeee3657e87053edf27b0b1f5493c9111d9a37c41fc5cdb85a24247";
const EXPECTED_SHEET_SHA256 = "8ea6a2514e745bc4393f9a46cb37d207c2448c716e331143cb80ba14b0654333";
const EXPECTED_SHEET_SIZE = { width: 1536, height: 1872 };
const MAX_RESPONSE_CHARACTERS = 200_000;
const MAX_SCRIPT_HEX_CHARACTERS = 40_000;
const MAX_SHEET_BYTES = 16 * 1024 * 1024;

type ExplorerTransaction = {
  txid: string;
  fee: number;
  weight: number;
  vout: Array<{
    scriptpubkey: string;
    scriptpubkey_type: string;
  }>;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
};

type PetState = {
  id: string;
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
};

type PetManifest = {
  format: "codex-pet-v1";
  id: string;
  displayName: string;
  description: string;
  kind: string;
  author: string;
  frame: {
    width: number;
    height: number;
    columns: number;
    rows: number;
  };
  states: PetState[];
  sheet: {
    contentType: string;
    length: number;
    sha256: string;
  };
};

type LoadedPet = {
  manifest: PetManifest;
  sheetUrl: string;
  digest: string;
  transaction: ExplorerTransaction;
};

function hexToBytes(hex: string): Uint8Array {
  if (
    hex.length === 0 ||
    hex.length > MAX_SCRIPT_HEX_CHARACTERS ||
    hex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(hex)
  ) {
    throw new Error("Explorer returned an invalid output script.");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function readLittleEndian(bytes: Uint8Array, offset: number, length: number): number {
  if (offset + length > bytes.length) throw new Error("Truncated pushdata length.");
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value += bytes[offset + index] * 2 ** (8 * index);
  }
  return value;
}

function readOpReturn(scriptHex: string): Uint8Array {
  const script = hexToBytes(scriptHex);
  if (script[0] !== 0x6a) throw new Error("Output is not OP_RETURN.");

  const chunks: Uint8Array[] = [];
  let offset = 1;
  let totalLength = 0;

  while (offset < script.length) {
    const opcode = script[offset];
    offset += 1;
    let length: number;

    if (opcode <= 0x4b) {
      length = opcode;
    } else if (opcode === 0x4c) {
      length = readLittleEndian(script, offset, 1);
      offset += 1;
    } else if (opcode === 0x4d) {
      length = readLittleEndian(script, offset, 2);
      offset += 2;
    } else if (opcode === 0x4e) {
      length = readLittleEndian(script, offset, 4);
      offset += 4;
    } else {
      throw new Error(`Unexpected opcode 0x${opcode.toString(16)} in OP_RETURN.`);
    }

    if (offset + length > script.length) throw new Error("Truncated OP_RETURN payload.");
    chunks.push(script.slice(offset, offset + length));
    totalLength += length;
    offset += length;
  }

  if (chunks.length !== 1) throw new Error("QPET v1 requires exactly one OP_RETURN data push.");

  const payload = new Uint8Array(totalLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  return payload;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isBoundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.isWellFormed() &&
    (allowEmpty || value.length > 0) &&
    new TextEncoder().encode(value).length <= maximum
  );
}

function hasExactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateManifest(value: unknown, sheetLength: number): PetManifest {
  if (!value || typeof value !== "object") throw new Error("QPET manifest is not an object.");
  const manifest = value as Partial<PetManifest>;

  if (!hasExactKeys(manifest, ["author", "description", "displayName", "format", "frame", "id", "kind", "sheet", "states"])) {
    throw new Error("QPET manifest fields are invalid.");
  }
  if (manifest.format !== "codex-pet-v1") throw new Error("Unsupported pet format.");
  if (!isBoundedString(manifest.id, 64) || !isBoundedString(manifest.displayName, 120)) {
    throw new Error("QPET identity fields are invalid.");
  }
  if (!isBoundedString(manifest.description, 2000, true) || !isBoundedString(manifest.kind, 64)) {
    throw new Error("QPET metadata fields are invalid.");
  }
  if (!isBoundedString(manifest.author, 120)) throw new Error("QPET author is invalid.");

  const frame = manifest.frame;
  if (
    !frame ||
    !hasExactKeys(frame, ["columns", "height", "rows", "width"]) ||
    !isPositiveInteger(frame.width) ||
    !isPositiveInteger(frame.height) ||
    !isPositiveInteger(frame.columns) ||
    !isPositiveInteger(frame.rows) ||
    frame.width > 4096 ||
    frame.height > 4096 ||
    frame.columns > 256 ||
    frame.rows > 256 ||
    frame.width * frame.columns > 32768 ||
    frame.height * frame.rows > 32768
  ) {
    throw new Error("QPET frame geometry is invalid.");
  }

  if (!Array.isArray(manifest.states) || manifest.states.length < 1 || manifest.states.length > 32) {
    throw new Error("QPET animation table is invalid.");
  }
  const stateIds = new Set<string>();
  for (const state of manifest.states) {
    if (
      !state ||
      !hasExactKeys(state, ["fps", "frames", "id", "loop", "row"]) ||
      !isBoundedString(state.id, 64) ||
      stateIds.has(state.id) ||
      !Number.isInteger(state.row) ||
      state.row < 0 ||
      state.row >= frame.rows ||
      !isPositiveInteger(state.frames) ||
      state.frames > frame.columns ||
      !isPositiveInteger(state.fps) ||
      state.fps > 60 ||
      typeof state.loop !== "boolean"
    ) {
      throw new Error("QPET animation state is invalid.");
    }
    stateIds.add(state.id);
  }

  if (
    !manifest.sheet ||
    !hasExactKeys(manifest.sheet, ["contentType", "length", "sha256"]) ||
    manifest.sheet.contentType !== "image/webp" ||
    sheetLength < 1 ||
    sheetLength > MAX_SHEET_BYTES ||
    manifest.sheet.length !== sheetLength ||
    !/^[0-9a-f]{64}$/i.test(manifest.sheet.sha256) ||
    manifest.sheet.sha256.toLowerCase() !== EXPECTED_SHEET_SHA256
  ) {
    throw new Error("QPET spritesheet declaration is invalid.");
  }

  return manifest as PetManifest;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function loadVerifiedImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (
        image.naturalWidth !== EXPECTED_SHEET_SIZE.width ||
        image.naturalHeight !== EXPECTED_SHEET_SIZE.height
      ) {
        reject(new Error("Decoded spritesheet dimensions do not match the QPET grid."));
        return;
      }
      resolve(image);
    };
    image.onerror = () => reject(new Error("On-chain spritesheet could not be decoded as WebP."));
    image.src = url;
  });
}

async function decodeQpet(transaction: ExplorerTransaction): Promise<{
  manifest: PetManifest;
  sheet: Uint8Array;
  digest: string;
}> {
  let payload: Uint8Array | undefined;

  for (const output of transaction.vout) {
    if (output.scriptpubkey_type !== "op_return" && !output.scriptpubkey.startsWith("6a")) continue;
    try {
      const candidate = readOpReturn(output.scriptpubkey);
      if (
        candidate[0] === 0x51 &&
        candidate[1] === 0x50 &&
        candidate[2] === 0x45 &&
        candidate[3] === 0x54
      ) {
        payload = candidate;
        break;
      }
    } catch {
      // A transaction may contain unrelated OP_RETURN outputs. Keep looking.
    }
  }

  if (!payload || payload.length < 7) throw new Error("No QPET envelope found in this transaction.");
  if (payload[4] !== 1) throw new Error(`Unsupported QPET version ${payload[4]}.`);
  if ((await sha256Hex(payload)) !== EXPECTED_ENVELOPE_SHA256) {
    throw new Error("QPET envelope does not match the mainnet inscription.");
  }

  const manifestLength = payload[5] | (payload[6] << 8);
  const sheetOffset = 7 + manifestLength;
  if (sheetOffset > payload.length) throw new Error("Truncated QPET manifest.");

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload.slice(7, sheetOffset)));
  } catch {
    throw new Error("QPET manifest is not valid UTF-8 JSON.");
  }

  const sheet = payload.slice(sheetOffset);
  const manifest = validateManifest(parsedManifest, sheet.length);
  const digest = await sha256Hex(sheet);
  if (digest !== manifest.sheet.sha256.toLowerCase()) throw new Error("Spritesheet SHA-256 does not match the chain manifest.");

  return { manifest, sheet, digest };
}

function shortHash(hash: string, edge = 8): string {
  return `${hash.slice(0, edge)}…${hash.slice(-edge)}`;
}

export default function Home() {
  const [loaded, setLoaded] = useState<LoadedPet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeStateId, setActiveStateId] = useState("idle");
  const [frame, setFrame] = useState(0);
  const [shareLabel, setShareLabel] = useState("share this pet");

  useEffect(() => {
    let cancelled = false;
    let sheetUrl: string | undefined;

    async function loadFromChain() {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(`${EXPLORER}/api/tx/${TXID}`, {
          cache: "no-store",
          credentials: "omit",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Mainnet explorer returned HTTP ${response.status}.`);
        if (!response.headers.get("content-type")?.includes("application/json")) {
          throw new Error("Mainnet explorer returned an unexpected content type.");
        }
        const body = await response.text();
        if (body.length > MAX_RESPONSE_CHARACTERS) throw new Error("Mainnet explorer response is unexpectedly large.");
        const transaction = JSON.parse(body) as ExplorerTransaction;
        if (transaction.txid !== TXID || !Array.isArray(transaction.vout)) {
          throw new Error("Explorer returned the wrong transaction.");
        }

        const { manifest, sheet, digest } = await decodeQpet(transaction);
        sheetUrl = URL.createObjectURL(new Blob([sheet], { type: manifest.sheet.contentType }));
        await loadVerifiedImage(sheetUrl);
        if (!cancelled) {
          setLoaded({ manifest, sheetUrl, digest, transaction });
          setActiveStateId(manifest.states[0].id);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof DOMException && caught.name === "AbortError"
              ? "Mainnet explorer timed out."
              : caught instanceof Error
                ? caught.message
                : "Could not load Qbit from mainnet.",
          );
        }
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void loadFromChain();
    return () => {
      cancelled = true;
      if (sheetUrl) URL.revokeObjectURL(sheetUrl);
    };
  }, []);

  const activeState = useMemo(
    () => loaded?.manifest.states.find((state) => state.id === activeStateId) ?? loaded?.manifest.states[0],
    [activeStateId, loaded],
  );

  useEffect(() => {
    if (!loaded || !activeState) return;
    let currentFrame = 0;
    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      currentFrame += 1;
      if (currentFrame >= activeState.frames) {
        if (activeState.loop) {
          currentFrame = 0;
        } else {
          setFrame(0);
          setActiveStateId(loaded.manifest.states[0].id);
          return;
        }
      }
      setFrame(currentFrame);
      timer = setTimeout(tick, 1000 / activeState.fps);
    };

    timer = setTimeout(tick, 1000 / activeState.fps);
    return () => clearTimeout(timer);
  }, [activeState, loaded]);

  async function share() {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Qbit, permanently committed",
          text: "Meet the Qbit mascot encoded in mainnet block 53,026.",
          url: window.location.href,
        });
        return;
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
      }
    }

    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(window.location.href);
        copied = true;
      }
    } catch {
      // Some embedded browsers deny clipboard permission. Use the selection fallback below.
    }

    if (!copied) {
      const field = document.createElement("textarea");
      field.value = window.location.href;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      copied = document.execCommand("copy");
      field.remove();
    }

    if (copied) {
      setShareLabel("link copied ✓");
      window.setTimeout(() => setShareLabel("share this pet"), 1800);
    } else {
      setShareLabel("copy URL above");
      window.setTimeout(() => setShareLabel("share this pet"), 2400);
    }
  }

  const status = loaded?.transaction.status;
  const blockTime = status?.block_time
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(
        new Date(status.block_time * 1000),
      )
    : null;

  return (
    <main>
      <div className="ambient ambientOne" />
      <div className="ambient ambientTwo" />

      <header className="topbar">
        <a className="brand" href="https://qbit.org" target="_blank" rel="noreferrer">
          <span className="brandMark">Q</span>
          <span>qbit / qpet 001</span>
        </a>
        <button className="shareButton" type="button" onClick={() => void share()}>
          {shareLabel}
          <span aria-hidden="true">↗</span>
        </button>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="copy">
          <p className="eyebrow"><span /> the Qbit mascot · block 53,026</p>
          <h1 id="hero-title">Permanently<br />committed.</h1>
          <p className="lede">
            The Qbit mascot is encoded in a single mainnet transaction: nine moods, one tiny spritesheet, and enough instructions to wake itself back up.
          </p>

          <div className={`verification ${loaded ? "verified" : error ? "failed" : "loading"}`} role="status">
            <span className="verificationIcon">{loaded ? "✓" : error ? "!" : "·"}</span>
            <div>
              <strong>{loaded ? "verified from mainnet" : error ? "chain read failed" : "reading mainnet…"}</strong>
              <span>{loaded ? `sheet sha256 ${shortHash(loaded.digest, 6)}` : error ?? "fetching transaction + checking every byte"}</span>
            </div>
          </div>

          <a
            className="downloadPet"
            href="https://codex-pets.net/#/pets/qbit"
            target="_blank"
            rel="noreferrer"
          >
            <span className="downloadIcon" aria-hidden="true">↓</span>
            <span>
              <strong>download Qbit for your coding agent</strong>
              <small>codex-pets.net/#/pets/qbit</small>
            </span>
            <i aria-hidden="true">↗</i>
          </a>
        </div>

        <div className="petColumn">
          <div className="petCard">
            <div className="cardHeader">
              <span>QPET://MAIN/001</span>
              <span className="liveDot"><i /> {loaded ? "awake" : "syncing"}</span>
            </div>

            <button
              className="stage"
              type="button"
              aria-label="Make Qbit wave"
              disabled={!loaded}
              onClick={() => {
                setFrame(0);
                setActiveStateId("waving");
              }}
            >
              <span className="orbit orbitOne" />
              <span className="orbit orbitTwo" />
              <span className="groundGlow" />
              {loaded && activeState ? (
                <span
                  className="pet"
                  aria-label={`Qbit animation: ${activeState.id}`}
                  role="img"
                  style={{
                    width: loaded.manifest.frame.width,
                    height: loaded.manifest.frame.height,
                    backgroundImage: `url(${loaded.sheetUrl})`,
                    backgroundPosition: `-${frame * loaded.manifest.frame.width}px -${activeState.row * loaded.manifest.frame.height}px`,
                  }}
                />
              ) : (
                <span className="loaderOrb"><i /><i /><i /></span>
              )}
              <span className="stageHint">tap Qbit to wave</span>
            </button>

            <div className="stateControls" aria-label="Animation states">
              {loaded?.manifest.states.map((state) => (
                <button
                  type="button"
                  key={state.id}
                  className={activeState?.id === state.id ? "active" : ""}
                  aria-pressed={activeState?.id === state.id}
                  onClick={() => {
                    setFrame(0);
                    setActiveStateId(state.id);
                  }}
                >
                  {state.id}
                </button>
              ))}
              {!loaded && !error && Array.from({ length: 9 }, (_, index) => <span className="controlSkeleton" key={index} />)}
            </div>
          </div>
        </div>
      </section>

      <section className="proof" aria-labelledby="proof-title">
        <div className="proofIntro">
          <p className="eyebrow"><span /> chain receipt</p>
          <h2 id="proof-title">Not hosted.<br />Unearthed.</h2>
          <p>The page downloads the transaction, finds its QPET envelope, checks the embedded SHA-256, then animates the bytes your browser recovered.</p>
        </div>

        <div className="receipt">
          <div className="receiptRow">
            <span>network</span>
            <strong>qbit mainnet</strong>
          </div>
          <div className="receiptRow">
            <span>transaction</span>
            <a href={`${EXPLORER}/tx/${TXID}`} target="_blank" rel="noreferrer">{shortHash(TXID, 10)} ↗</a>
          </div>
          <div className="receiptRow">
            <span>block</span>
            {status?.block_hash ? (
              <a href={`${EXPLORER}/block/${status.block_hash}`} target="_blank" rel="noreferrer">
                {status.block_height?.toLocaleString()} · {shortHash(status.block_hash, 7)} ↗
              </a>
            ) : <strong>waiting for confirmation</strong>}
          </div>
          <div className="receiptRow">
            <span>inscribed</span>
            <strong>{blockTime ? `${blockTime} UTC` : "checking…"}</strong>
          </div>
          <div className="receiptRow">
            <span>payload</span>
            <strong>{loaded ? `${loaded.manifest.sheet.length.toLocaleString()} sprite bytes · QPET v1` : "checking…"}</strong>
          </div>
          <div className="receiptRow">
            <span>integrity</span>
            <strong className={loaded ? "good" : ""}>{loaded ? "byte-perfect ✓" : error ? "unverified" : "checking…"}</strong>
          </div>
          <div className="receiptRow">
            <span>source</span>
            <a href="https://github.com/djh58/qbit-onchain-pet" target="_blank" rel="noreferrer">
              github.com/djh58/qbit-onchain-pet ↗
            </a>
          </div>
        </div>
      </section>

      <footer>
        <p>the Qbit mascot · permanently committed</p>
        <a href="https://codex-pets.net/#/pets/qbit" target="_blank" rel="noreferrer">get Qbit for your agent ↗</a>
      </footer>
    </main>
  );
}
