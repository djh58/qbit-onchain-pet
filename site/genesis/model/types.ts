import type { QpetArtifact, QpetManifest, QpetState } from "qscriptions";

export type PetManifest = QpetManifest;
export type PetState = QpetState;

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
  qpet: QpetArtifact;
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
