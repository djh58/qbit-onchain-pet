import { performance } from "node:perf_hooks";
import type { Route } from "@playwright/test";
import {
  STATE_IDS,
  expect,
  expectReady,
  frameDescription,
  fulfillTransaction,
  installBlobProbe,
  installChainRoutes,
  mascotSurface,
  spriteInteraction,
  test,
} from "./harness";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installBlobProbe(page);
});

test("keeps Qbit absent until the exact transaction response has been verified", async ({ page }) => {
  let releaseResponse = () => {};
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const stats = await installChainRoutes(page, {
    transaction: async (route: Route) => {
      await responseGate;
      await fulfillTransaction(route);
    },
  });

  await page.goto("/");
  await expect(page.getByText("No verified bytes. No Qbit.").first()).toBeVisible();
  await expect(mascotSurface(page)).toHaveCount(0);
  await expect(page.locator("img")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^share/i })).toBeDisabled();
  expect(await page.evaluate(() => {
    const target = globalThis as typeof globalThis & { __qbitBlobProbe?: { created: string[] } };
    return target.__qbitBlobProbe?.created.length;
  })).toBe(0);

  releaseResponse();
  await expectReady(page);
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});

test("meets the cold 150 ms RTT and 1.5 Mbit/s awakening budget", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "The launch timing budget is pinned to Chromium.");
  const responseBytes = 47_225;
  const profileDelayMs = 150 + Math.ceil((responseBytes * 8 * 1_000) / 1_500_000);
  let responseSentAt = 0;
  const stats = await installChainRoutes(page, {
    transaction: async (route: Route) => {
      await new Promise((resolve) => setTimeout(resolve, profileDelayMs));
      await fulfillTransaction(route);
      responseSentAt = performance.now();
    },
  });

  const navigationStartedAt = performance.now();
  await page.goto("/");
  await expectReady(page);
  const readyAt = performance.now();

  expect(responseSentAt).toBeGreaterThan(navigationStartedAt);
  expect(readyAt - navigationStartedAt).toBeLessThanOrEqual(4_000);
  expect(readyAt - responseSentAt).toBeLessThanOrEqual(500);
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});

test("renders exactly one 1536×1872 image from one verified Blob URL", async ({ page }) => {
  const stats = await installChainRoutes(page);
  await page.goto("/");
  await expectReady(page);

  const image = mascotSurface(page).locator("img");
  const imageFacts = await image.evaluate((node) => {
    const imageNode = node as HTMLImageElement;
    return {
      src: imageNode.src,
      naturalWidth: imageNode.naturalWidth,
      naturalHeight: imageNode.naturalHeight,
      complete: imageNode.complete,
      ariaHidden: imageNode.getAttribute("aria-hidden"),
    };
  });
  expect(imageFacts).toMatchObject({
    naturalWidth: 1_536,
    naturalHeight: 1_872,
    complete: true,
    ariaHidden: "true",
  });
  expect(imageFacts.src).toMatch(/^blob:/);
  expect(await page.evaluate(() => {
    const target = globalThis as typeof globalThis & { __qbitBlobProbe?: { created: string[] } };
    return target.__qbitBlobProbe?.created;
  })).toEqual([imageFacts.src]);
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});

test("X-ray reuses the same image and maps the selected frame to the same sheet geometry", async ({ page }) => {
  const stats = await installChainRoutes(page);
  await page.goto("/");
  await expectReady(page);

  await page.getByRole("button", { name: "Play review" }).click();
  await expect(frameDescription(page)).toContainText("review · row 8 · frame 1/6 · 6 FPS · 0,1664 192×208");

  const original = await mascotSurface(page).locator("img").evaluate((node) => {
    const imageNode = node as HTMLImageElement;
    const target = globalThis as typeof globalThis & { __qbitImageNode?: HTMLImageElement };
    target.__qbitImageNode = imageNode;
    return imageNode.src;
  });
  await page.keyboard.down("x");
  await expect(mascotSurface(page).locator("xpath=../..")).toHaveAttribute("data-xray", "open");

  const geometry = await mascotSurface(page).evaluate((surface) => {
    const target = globalThis as typeof globalThis & { __qbitImageNode?: HTMLImageElement };
    const image = surface.querySelector("img");
    const highlight = surface.querySelector("span");
    const sheet = surface.getBoundingClientRect();
    const cell = highlight?.getBoundingClientRect();
    return {
      sameNode: image === target.__qbitImageNode,
      src: image?.getAttribute("src"),
      imageCount: document.querySelectorAll('[data-media-origin="verified-blob"] img').length,
      ratio: sheet.width / sheet.height,
      cellWidth: cell?.width,
      cellHeight: cell?.height,
      cellLeft: cell ? cell.left - sheet.left : null,
      cellTop: cell ? cell.top - sheet.top : null,
      sheetWidth: sheet.width,
      sheetHeight: sheet.height,
      sourceX: getComputedStyle(surface).getPropertyValue("--source-x").trim(),
      sourceY: getComputedStyle(surface).getPropertyValue("--source-y").trim(),
    };
  });
  expect(geometry.sameNode).toBe(true);
  expect(geometry.src).toBe(original);
  expect(geometry.imageCount).toBe(1);
  expect(geometry.ratio).toBeCloseTo(1_536 / 1_872, 3);
  expect(geometry.cellWidth).toBeCloseTo(geometry.sheetWidth / 8, 1);
  expect(geometry.cellHeight).toBeCloseTo(geometry.sheetHeight / 9, 1);
  expect(geometry.cellLeft).toBeCloseTo(0, 1);
  expect(geometry.cellTop).toBeCloseTo((geometry.sheetHeight * 8) / 9, 1);
  expect(geometry.sourceX).toBe("0px");
  expect(geometry.sourceY).toBe("1664px");

  await page.keyboard.up("x");
  await expect(mascotSurface(page).locator("xpath=../..")).toHaveAttribute("data-xray", "closed");
  expect(await mascotSurface(page).locator("img").evaluate((node) => {
    const target = globalThis as typeof globalThis & { __qbitImageNode?: HTMLImageElement };
    return node === target.__qbitImageNode;
  })).toBe(true);
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});

test("exposes and selects all nine manifest-defined states", async ({ page }) => {
  const stats = await installChainRoutes(page);
  await page.goto("/");
  await expectReady(page);

  const controls = page.getByRole("group", { name: "Nine manifest-defined Qbit states" });
  const buttons = controls.getByRole("button");
  await expect(buttons).toHaveCount(9);
  for (const [row, stateId] of STATE_IDS.entries()) {
    const button = page.getByRole("button", { name: `Play ${stateId}`, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(frameDescription(page)).toContainText(`${stateId} · row ${row} · frame 1/`);
  }

  await expect(spriteInteraction(page)).toHaveAttribute("aria-label", /Arrow keys run/);
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});
