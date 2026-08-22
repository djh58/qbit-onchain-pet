import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../genesis/genesis.json");
  vi.resetModules();
});

test("canonical facts load and a malformed fact fails module initialization", async () => {
  const canonical = await import("../../genesis/model/facts.ts");
  assert.equal(canonical.GENESIS.blockHeight, 53_026);

  vi.resetModules();
  vi.doMock("../../genesis/genesis.json", async () => {
    const actual = await vi.importActual<typeof import("../../genesis/genesis.json")>("../../genesis/genesis.json");
    return { default: { ...actual, schemaVersion: 2 } };
  });
  await assert.rejects(import("../../genesis/model/facts.ts"), /unsupported schema version/);
});
