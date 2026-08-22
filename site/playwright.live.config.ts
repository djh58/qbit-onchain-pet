import { defineConfig, devices } from "@playwright/test";

const canonicalBaseURL = "https://qbit-onchain-pet.thedanhepworth.chatgpt.site";
const configuredBaseURL = process.env.LIVE_BASE_URL?.trim() || canonicalBaseURL;
const parsedBaseURL = new URL(configuredBaseURL);

if (!/^https?:$/.test(parsedBaseURL.protocol)) {
  throw new TypeError("LIVE_BASE_URL must use HTTP or HTTPS.");
}
if (
  parsedBaseURL.username ||
  parsedBaseURL.password ||
  parsedBaseURL.pathname !== "/" ||
  parsedBaseURL.search ||
  parsedBaseURL.hash
) {
  throw new TypeError("LIVE_BASE_URL must be an origin or root URL without credentials, a query, or a fragment.");
}

const baseURL = parsedBaseURL.toString().replace(/\/$/, "");

export default defineConfig({
  testDir: "./tests/live",
  testMatch: "**/*.spec.ts",
  outputDir: ".next/playwright-live-results",
  fullyParallel: false,
  forbidOnly: true,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: "line",
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-first-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        colorScheme: "dark",
        locale: "en-US",
      },
    },
  ],
});
