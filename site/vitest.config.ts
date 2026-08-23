import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: [
        "genesis/model/abort-scope.ts",
        "genesis/model/choreography.ts",
        "genesis/model/facts.ts",
        "genesis/model/recovery.ts",
        "genesis/model/share.ts",
        "genesis/model/sprite.ts",
        "genesis/services/chain-source.ts",
      ],
      reporter: ["text", "json-summary"],
      reportsDirectory: ".next/coverage",
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
