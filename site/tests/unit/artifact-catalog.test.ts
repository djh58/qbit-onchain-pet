import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeQpetEnvelope } from "qscriptions";
import { test } from "vitest";
import { ARTIFACTS, type ArtifactId } from "../../genesis/model/facts.ts";
import { assertGenesisBodyIdentity, assertGenesisEnvelopeIdentity } from "../../genesis/services/chain-source.ts";

const STATES = [
  { id: "idle", row: 0, frames: 6, fps: 6, loop: true },
  { id: "running-right", row: 1, frames: 8, fps: 12, loop: true },
  { id: "running-left", row: 2, frames: 8, fps: 12, loop: true },
  { id: "waving", row: 3, frames: 4, fps: 5, loop: false },
  { id: "jumping", row: 4, frames: 5, fps: 14, loop: false },
  { id: "failed", row: 5, frames: 8, fps: 6, loop: false },
  { id: "waiting", row: 6, frames: 6, fps: 4, loop: true },
  { id: "running", row: 7, frames: 6, fps: 12, loop: true },
  { id: "review", row: 8, frames: 6, fps: 6, loop: true },
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function artifactFromSource(id: ArtifactId) {
  const directory = id === "qbit" ? "qbit" : "miner-one";
  const root = new URL(`../../../assets/${directory}/`, import.meta.url);
  const pet = JSON.parse(readFileSync(new URL("pet.json", root), "utf8")) as Record<string, unknown>;
  const sheet = new Uint8Array(readFileSync(new URL("spritesheet.webp", root)));
  const manifest = {
    format: "codex-pet-v1",
    id: pet.id,
    displayName: pet.displayName ?? pet.id,
    description: pet.description ?? "",
    kind: pet.kind ?? "object",
    author: pet.author ?? "dan",
    frame: pet.frame,
    states: STATES,
    sheet: { contentType: "image/webp", length: sheet.byteLength, sha256: sha256(sheet) },
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const envelope = new Uint8Array(7 + manifestBytes.byteLength + sheet.byteLength);
  envelope.set(new TextEncoder().encode("QPET"));
  envelope[4] = 1;
  new DataView(envelope.buffer).setUint16(5, manifestBytes.byteLength, true);
  envelope.set(manifestBytes, 7);
  envelope.set(sheet, 7 + manifestBytes.byteLength);
  const decoded = await decodeQpetEnvelope(envelope);
  if (!decoded.ok) throw new Error(decoded.error.code);
  return decoded.value;
}

test("both tracked assets reproduce their pinned envelopes and cannot be cross-substituted", async () => {
  const qbit = await artifactFromSource("qbit");
  const minerOne = await artifactFromSource("miner-one");

  assert.doesNotThrow(() => assertGenesisEnvelopeIdentity(qbit, ARTIFACTS.qbit));
  assert.doesNotThrow(() => assertGenesisBodyIdentity(qbit, ARTIFACTS.qbit));
  assert.doesNotThrow(() => assertGenesisEnvelopeIdentity(minerOne, ARTIFACTS["miner-one"]));
  assert.doesNotThrow(() => assertGenesisBodyIdentity(minerOne, ARTIFACTS["miner-one"]));
  assert.throws(() => assertGenesisEnvelopeIdentity(qbit, ARTIFACTS["miner-one"]), /hash-mismatch/);
  assert.throws(() => assertGenesisBodyIdentity(minerOne, ARTIFACTS.qbit), /hash-mismatch/);
});
