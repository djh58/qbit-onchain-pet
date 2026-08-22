import rawFacts from "../genesis.json";

const HEX_64 = /^[0-9a-f]{64}$/;

function assertFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid Genesis facts: ${message}`);
}

assertFact(rawFacts.schemaVersion === 1, "unsupported schema version");
assertFact(rawFacts.network === "main", "network must be main");
assertFact(HEX_64.test(rawFacts.networkGenesisHash), "network genesis hash");
assertFact(HEX_64.test(rawFacts.transactionId), "transaction id");
assertFact(HEX_64.test(rawFacts.blockHash), "block hash");
assertFact(HEX_64.test(rawFacts.envelopeSha256), "envelope digest");
assertFact(HEX_64.test(rawFacts.sheetSha256), "sheet digest");
assertFact(rawFacts.outputIndex === 0, "output index");
assertFact(rawFacts.blockHeight === 53_026, "block height");
assertFact(rawFacts.envelopeLength === 9_548, "envelope length");
assertFact(rawFacts.sheetLength === 8_616, "sheet length");
assertFact(rawFacts.sheetWidth === rawFacts.frameWidth * 8, "sheet width");
assertFact(rawFacts.sheetHeight === rawFacts.frameHeight * 9, "sheet height");

export const GENESIS = Object.freeze(rawFacts);
export const EXPLORER_ORIGIN = "https://mempool.qbit.org";
export const SOURCE_REPOSITORY = "https://github.com/djh58/qbit-onchain-pet";
export const CODEX_PETS_URL = "https://codex-pets.net/#/pets/qbit";
