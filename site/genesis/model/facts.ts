import rawGenesis from "../genesis.json";
import rawMinerOne from "../miner-one.json";

const HEX_64 = /^[0-9a-f]{64}$/;

export type ArtifactId = "qbit" | "miner-one";

export type RecipientCommitment = Readonly<{
  outputIndex: number;
  address: string;
  amountBits: number;
  scriptPubKey: string;
  scriptPubKeyType: string;
}>;

export type QpetFacts = Readonly<{
  schemaVersion: number;
  network: "main";
  networkGenesisHash: string;
  sourceId: string;
  transactionId: string;
  outputIndex: number;
  blockHeight: number;
  blockHash: string;
  blockTime?: number;
  transactionSize?: number;
  transactionVsize?: number;
  feeBits?: number;
  envelopeLength: number;
  envelopeSha256: string;
  sheetLength: number;
  sheetSha256: string;
  sheetWidth: number;
  sheetHeight: number;
  frameWidth: number;
  frameHeight: number;
  recipient?: RecipientCommitment;
}>;

export type QpetDefinition = Readonly<{
  artifactId: ArtifactId;
  route: "/" | "/honorary";
  explorerOrigin: string;
  facts: QpetFacts;
  manifestIdentity: Readonly<{
    id: string;
    displayName: string;
    kind: string;
    author: string;
  }>;
  presentation: Readonly<{
    navLabel: string;
    brandLabel: string;
    coordinate: string;
    titleLines: readonly [string, string];
    lede: string;
    recoveredLabel: string;
    footerLabel: string;
    shareTitle: string;
    shareText: string;
    primaryAction: Readonly<{
      label: string;
      detail: string;
      href: string;
      external: boolean;
    }>;
  }>;
  honor?: Readonly<{
    blockHash: string;
    coinbaseTransactionId: string;
    payoutAddress: string;
    blockTimeIso: string;
    coinbaseTags: readonly [string, string];
  }>;
}>;

function assertFact(condition: unknown, label: string, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid ${label} facts: ${message}`);
}

function validateFacts(raw: Record<string, unknown>, label: string, network: QpetFacts["network"]): QpetFacts {
  assertFact(raw.schemaVersion === 1, label, "unsupported schema version");
  assertFact(raw.network === network, label, `network must be ${network}`);
  for (const field of ["networkGenesisHash", "transactionId", "blockHash", "envelopeSha256", "sheetSha256"] as const) {
    assertFact(typeof raw[field] === "string" && HEX_64.test(raw[field]), label, field);
  }
  assertFact(typeof raw.sourceId === "string" && raw.sourceId.length > 0, label, "source id");
  assertFact(Number.isSafeInteger(raw.outputIndex) && Number(raw.outputIndex) >= 0, label, "output index");
  assertFact(Number.isSafeInteger(raw.blockHeight) && Number(raw.blockHeight) >= 0, label, "block height");
  for (const field of ["envelopeLength", "sheetLength", "sheetWidth", "sheetHeight", "frameWidth", "frameHeight"] as const) {
    assertFact(Number.isSafeInteger(raw[field]) && Number(raw[field]) > 0, label, field);
  }
  assertFact(raw.sheetWidth === Number(raw.frameWidth) * 8, label, "sheet width");
  assertFact(raw.sheetHeight === Number(raw.frameHeight) * 9, label, "sheet height");
  let recipient: RecipientCommitment | undefined;
  if (raw.recipient !== undefined) {
    assertFact(
      raw.recipient !== null && typeof raw.recipient === "object" && !Array.isArray(raw.recipient),
      label,
      "recipient commitment",
    );
    const candidate = raw.recipient as Record<string, unknown>;
    assertFact(
      Number.isSafeInteger(candidate.outputIndex)
      && Number(candidate.outputIndex) >= 0
      && candidate.outputIndex !== raw.outputIndex,
      label,
      "recipient output index",
    );
    assertFact(
      typeof candidate.address === "string"
      && candidate.address === candidate.address.trim()
      && candidate.address.length > 0
      && candidate.address.length <= 128,
      label,
      "recipient address",
    );
    assertFact(
      Number.isSafeInteger(candidate.amountBits) && Number(candidate.amountBits) > 0,
      label,
      "recipient amount",
    );
    assertFact(
      typeof candidate.scriptPubKey === "string"
      && candidate.scriptPubKey.length > 0
      && candidate.scriptPubKey.length % 2 === 0
      && /^[0-9a-f]+$/.test(candidate.scriptPubKey),
      label,
      "recipient script",
    );
    assertFact(
      candidate.scriptPubKeyType === "v2_p2mr",
      label,
      "recipient script type",
    );
    recipient = Object.freeze({
      outputIndex: Number(candidate.outputIndex),
      address: candidate.address,
      amountBits: Number(candidate.amountBits),
      scriptPubKey: candidate.scriptPubKey,
      scriptPubKeyType: candidate.scriptPubKeyType,
    });
  }
  return Object.freeze({ ...raw, recipient } as unknown as QpetFacts);
}

const genesisFacts = validateFacts(rawGenesis, "Genesis", "main");
const minerOneFacts = validateFacts(rawMinerOne, "Miner One", "main");

export const SOURCE_REPOSITORY = "https://github.com/djh58/qbit-onchain-pet";
export const CODEX_PETS_URL = "https://codex-pets.net/#/pets/qbit";

export const ARTIFACTS: Readonly<Record<ArtifactId, QpetDefinition>> = Object.freeze({
  qbit: Object.freeze({
    artifactId: "qbit",
    route: "/",
    explorerOrigin: "https://mempool.qbit.org",
    facts: genesisFacts,
    manifestIdentity: Object.freeze({ id: "qbit", displayName: "Qbit", kind: "object", author: "dan" }),
    presentation: Object.freeze({
      navLabel: "OG · Mainnet",
      brandLabel: "Qbit / Genesis 001",
      coordinate: `Qbit mainnet · block ${genesisFacts.blockHeight.toLocaleString("en-US")}`,
      titleLines: Object.freeze(["Bytes.", "Then being."]) as readonly [string, string],
      lede: "Your browser recovers one mainnet transaction, recomputes its ID, verifies every inscription byte, and only then gives Qbit a body.",
      recoveredLabel: "Recovered from Qbit mainnet",
      footerLabel: "Qbit Genesis 001",
      shareTitle: "Qbit Genesis — Bytes. Then being.",
      shareText: "Watch one Qbit mainnet transaction become the verified Qbit mascot.",
      primaryAction: Object.freeze({
        label: "Get Qbit for your coding agent",
        detail: CODEX_PETS_URL,
        href: CODEX_PETS_URL,
        external: true,
      }),
    }),
  }),
  "miner-one": Object.freeze({
    artifactId: "miner-one",
    route: "/honorary",
    explorerOrigin: "https://mempool.qbit.org",
    facts: minerOneFacts,
    manifestIdentity: Object.freeze({ id: "miner-one", displayName: "Miner One", kind: "object", author: "dan" }),
    presentation: Object.freeze({
      navLabel: "Miner #1 · Mainnet",
      brandLabel: "Qbit / Honorary 001",
      coordinate: "Honors Qbit mainnet · block 1",
      titleLines: Object.freeze(["Block one.", "Miner one."]) as readonly [string, string],
      lede: "A gold #1 hardhat and a trusty pickaxe honor the miner who extended Qbit mainnet with block 1. The honorary QPET is inscribed on mainnet, with output 1 bound to the block-one payout address.",
      recoveredLabel: "Recovered from Qbit mainnet",
      footerLabel: "Miner One · Honorary 001",
      shareTitle: "Miner One — Qbit Block 1 Honorary QPET",
      shareText: "Meet the on-chain QPET honoring the miner of Qbit mainnet block 1.",
      primaryAction: Object.freeze({
        label: "Meet the original Qbit",
        detail: "Mainnet Genesis 001",
        href: "/",
        external: false,
      }),
    }),
    honor: Object.freeze({
      blockHash: "00000000000000000be903a612b1aaaeea4a7d35be4862327957896d215e3c0f",
      coinbaseTransactionId: "c8d070f65bc110765e01984a0d4b2d2d33188eef98077e2196980530ab9bdaca",
      payoutAddress: "qb1z8q6dsf8sla7vcn2gzxnspuzpshzrkkk80c2a67xdpea2yxkpsm4qmzhake",
      blockTimeIso: "2026-07-15T18:24:58Z",
      coinbaseTags: Object.freeze(["ckpool", "/qbit-mining-bootstrap/"]) as readonly [string, string],
    }),
  }),
});

export function artifactDefinition(id: ArtifactId): QpetDefinition {
  return ARTIFACTS[id];
}

// Stable aliases preserve the public Genesis integration and its tests.
export const GENESIS_ARTIFACT = ARTIFACTS.qbit;
export const GENESIS = GENESIS_ARTIFACT.facts;
export const EXPLORER_ORIGIN = GENESIS_ARTIFACT.explorerOrigin;
