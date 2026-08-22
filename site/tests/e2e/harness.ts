import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base, type Page, type Route } from "@playwright/test";

export const TRANSACTION_ID = "852748890119300166f0c3050da3fee5c55316d199bcff1425424c009d2e62b9";
export const BLOCK_HEIGHT = 53_026;
export const BLOCK_HASH = "0000000000000000893a81d2e44e1e16cbaf59cd58f901b6be29603ad2935460";
export const EXPLORER_ORIGIN = "https://mempool.qbit.org";
export const TRANSACTION_URL = `${EXPLORER_ORIGIN}/api/tx/${TRANSACTION_ID}`;
export const BLOCK_URL = `${EXPLORER_ORIGIN}/api/block-height/${BLOCK_HEIGHT}`;
export const STATE_IDS = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
] as const;

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/genesis-mainnet-esplora.json",
);

export const transactionFixtureText = readFileSync(fixturePath, "utf8");
export const transactionFixture = JSON.parse(transactionFixtureText) as Record<string, unknown>;

const fixtureDigest = createHash("sha256").update(transactionFixtureText).digest("hex");
if (fixtureDigest !== "48f39512954fdf8b6b25c156a2971ffdd413dfe0af80c66c23b187a60c2642d6") {
  throw new Error(`The exact pinned Esplora fixture changed (${fixtureDigest}).`);
}

type PageHealth = Readonly<{
  consoleErrors: string[];
  pageErrors: string[];
  failedLocalRequests: string[];
  allowConsoleError: (pattern: RegExp) => void;
}>;

export const test = base.extend<{ pageHealth: PageHealth }>({
  pageHealth: [async ({ page }, use) => {
    const health: PageHealth = {
      consoleErrors: [],
      pageErrors: [],
      failedLocalRequests: [],
      allowConsoleError(pattern) {
        allowedConsoleErrors.push(pattern);
      },
    };
    const allowedConsoleErrors: RegExp[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") health.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => health.pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      if (!request.url().startsWith(EXPLORER_ORIGIN)) {
        health.failedLocalRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`);
      }
    });
    await use(health);
    const unexpectedConsoleErrors = health.consoleErrors.filter(
      (message) => !allowedConsoleErrors.some((pattern) => pattern.test(message)),
    );
    expect(unexpectedConsoleErrors, "unexpected browser console errors").toEqual([]);
    expect(health.pageErrors, "uncaught page errors").toEqual([]);
    expect(health.failedLocalRequests, "failed same-origin requests").toEqual([]);
  }, { auto: true }],
});

export { expect };

export type ChainRouteStats = {
  transactionRequests: number;
  blockRequests: number;
  unexpectedExplorerRequests: string[];
};

type ChainRouteOptions = Readonly<{
  transaction?: (route: Route, requestNumber: number) => Promise<void>;
  block?: (route: Route, requestNumber: number) => Promise<void>;
}>;

const corsHeaders = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
};

export async function fulfillTransaction(route: Route, body = transactionFixtureText): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    headers: corsHeaders,
    body,
  });
}

export async function fulfillBlockHash(route: Route, body = BLOCK_HASH): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "text/plain; charset=utf-8",
    headers: corsHeaders,
    body,
  });
}

export async function installChainRoutes(
  page: Page,
  options: ChainRouteOptions = {},
): Promise<ChainRouteStats> {
  const stats: ChainRouteStats = {
    transactionRequests: 0,
    blockRequests: 0,
    unexpectedExplorerRequests: [],
  };
  await page.route(`${EXPLORER_ORIGIN}/**`, async (route) => {
    const url = route.request().url();
    if (url === TRANSACTION_URL) {
      stats.transactionRequests += 1;
      if (options.transaction) await options.transaction(route, stats.transactionRequests);
      else await fulfillTransaction(route);
      return;
    }
    if (url === BLOCK_URL) {
      stats.blockRequests += 1;
      if (options.block) await options.block(route, stats.blockRequests);
      else await fulfillBlockHash(route);
      return;
    }
    stats.unexpectedExplorerRequests.push(url);
    await route.fulfill({ status: 404, contentType: "text/plain", headers: corsHeaders, body: "not mocked" });
  });
  return stats;
}

export async function installBlobProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = globalThis as typeof globalThis & {
      __qbitBlobProbe?: { created: string[]; revoked: string[] };
    };
    const originalCreate = URL.createObjectURL.bind(URL);
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    target.__qbitBlobProbe = { created: [], revoked: [] };
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = originalCreate(object);
      target.__qbitBlobProbe?.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      target.__qbitBlobProbe?.revoked.push(url);
      originalRevoke(url);
    };
  });
}

export function mascotSurface(page: Page) {
  return page.locator('[data-media-origin="verified-blob"]');
}

export function spriteInteraction(page: Page) {
  return page.getByRole("button", { name: "Qbit animation. Arrow keys run, Up jumps, and Enter waves." });
}

export function xrayControl(page: Page) {
  return page.getByRole("button", { name: "Inspect the exact verified spritesheet cell" });
}

export function frameDescription(page: Page) {
  return spriteInteraction(page).locator("xpath=following-sibling::p[1]");
}

export async function expectReady(page: Page, confirmation: "confirmed" | "degraded" = "confirmed"): Promise<void> {
  await expect(mascotSurface(page)).toHaveCount(1);
  await expect(page.locator('[data-media-origin="verified-blob"] img')).toHaveCount(1);
  await expect(page.getByRole("status")).toContainText(
    confirmation === "confirmed" ? "Recovered from Qbit mainnet" : "Inscription bytes recovered",
  );
}

export function choreographyFragment(states: readonly string[]): string {
  return `#play=${Buffer.from(JSON.stringify(states), "utf8").toString("base64url")}`;
}

export function cloneTransactionFixture(): Record<string, unknown> {
  return structuredClone(transactionFixture);
}
