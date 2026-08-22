export type PetState = Readonly<{
  id: string;
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
}>;

export type PetManifest = Readonly<{
  format: "codex-pet-v1";
  id: string;
  displayName: string;
  description: string;
  kind: string;
  author: string;
  frame: Readonly<{
    width: number;
    height: number;
    columns: number;
    rows: number;
  }>;
  states: readonly PetState[];
  sheet: Readonly<{
    contentType: "image/webp";
    length: number;
    sha256: string;
  }>;
}>;

export type ExplorerStatus = Readonly<{
  confirmed: boolean;
  blockHeight?: number;
  blockHash?: string;
  blockTime?: number;
}>;

export type ChainEvidence = Readonly<{
  status: "confirmed" | "unknown";
  sourceId: string;
  detail: string;
}>;

export type RecoveredGenesis = Readonly<{
  manifest: PetManifest;
  envelope: Uint8Array;
  sheet: Uint8Array;
  envelopeDigest: string;
  sheetDigest: string;
  serializedTransactionLength: number;
  status: ExplorerStatus;
  chainEvidence: ChainEvidence;
}>;

export type ReadyGenesis = RecoveredGenesis &
  Readonly<{
    sheetUrl: string;
    sheetImage: HTMLImageElement;
  }>;

export type FrameSelection = Readonly<{
  stateId: string;
  row: number;
  column: number;
  frameCount: number;
  fps: number;
  loop: boolean;
  sourceRect: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}>;
