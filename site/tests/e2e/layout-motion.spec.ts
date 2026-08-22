import {
  choreographyFragment,
  expect,
  expectReady,
  frameDescription,
  installChainRoutes,
  mascotSurface,
  spriteInteraction,
  test,
  xrayControl,
} from "./harness";

async function centeredGeometry(page: import("@playwright/test").Page) {
  return spriteInteraction(page).evaluate((interaction) => {
    const surface = interaction.querySelector('[data-media-origin="verified-blob"]');
    if (!(surface instanceof HTMLElement)) throw new Error("Mascot surface is absent.");
    const interactionRect = interaction.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    const transform = getComputedStyle(surface).transform;
    const matrix = new DOMMatrixReadOnly(transform);
    return {
      horizontalDelta: (surfaceRect.left + surfaceRect.width / 2) - (interactionRect.left + interactionRect.width / 2),
      verticalDelta: (surfaceRect.top + surfaceRect.height / 2) - (interactionRect.top + interactionRect.height / 2),
      surface: { x: surfaceRect.x, y: surfaceRect.y, width: surfaceRect.width, height: surfaceRect.height },
      interaction: { x: interactionRect.x, y: interactionRect.y, width: interactionRect.width, height: interactionRect.height },
      transform: { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d },
    };
  });
}

test("keeps the mascot centered and untilted on locked desktop and mobile layouts", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stats = await installChainRoutes(page);

  for (const viewport of [{ width: 1_440, height: 1_000 }, { width: 375, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expectReady(page);
    const before = await centeredGeometry(page);
    await page.waitForTimeout(250);
    const after = await centeredGeometry(page);

    expect(Math.abs(after.horizontalDelta)).toBeLessThan(1);
    expect(Math.abs(after.verticalDelta)).toBeLessThan(1);
    expect(Math.abs(after.transform.b)).toBeLessThan(0.001);
    expect(Math.abs(after.transform.c)).toBeLessThan(0.001);
    expect(after.transform.a).toBeCloseTo(after.transform.d, 4);
    expect(after.surface).toEqual(before.surface);
  }

  expect(stats).toEqual({ transactionRequests: 2, blockRequests: 2, unexpectedExplorerRequests: [] });
});

test("fits mobile X-ray, its same-Blob active-cell inset, and all controls without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stats = await installChainRoutes(page);
  await page.goto("/");
  await expectReady(page);
  await page.getByRole("button", { name: "Play review" }).click();
  const imageSource = await mascotSurface(page).locator("img").getAttribute("src");

  await page.keyboard.down("x");
  await expect(xrayControl(page)).toHaveAttribute("aria-pressed", "true");
  const inset = mascotSurface(page).locator('span[style*="background-image"]');
  await expect(inset).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  const geometry = await page.evaluate(() => {
    const interaction = document.querySelector('button[aria-label^="Qbit animation"]');
    const surface = document.querySelector('[data-media-origin="verified-blob"]');
    const insetNode = surface?.querySelector('span[style*="background-image"]');
    const frame = interaction?.nextElementSibling;
    const controls = document.querySelector('[role="group"][aria-label="Nine manifest-defined Qbit states"]');
    if (!(interaction instanceof HTMLElement) || !(surface instanceof HTMLElement) || !(insetNode instanceof HTMLElement) || !(frame instanceof HTMLElement) || !(controls instanceof HTMLElement)) {
      throw new Error("Mobile geometry targets are absent.");
    }
    const rect = (node: Element) => {
      const value = node.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    return {
      viewportWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      interaction: rect(interaction),
      surface: rect(surface),
      inset: rect(insetNode),
      frame: rect(frame),
      controls: rect(controls),
      controlsClientWidth: controls.clientWidth,
      controlsScrollWidth: controls.scrollWidth,
      buttons: Array.from(controls.querySelectorAll("button"), rect),
      insetBackgroundImage: getComputedStyle(insetNode).backgroundImage,
      insetBackgroundPosition: getComputedStyle(insetNode).backgroundPosition,
      insetBackgroundSize: getComputedStyle(insetNode).backgroundSize,
    };
  });

  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.surface.left).toBeGreaterThanOrEqual(geometry.interaction.left - 1);
  expect(geometry.surface.right).toBeLessThanOrEqual(geometry.interaction.right + 1);
  expect(geometry.surface.bottom).toBeLessThanOrEqual(geometry.interaction.bottom + 1);
  expect(geometry.interaction.bottom).toBeLessThanOrEqual(geometry.frame.top + 1);
  expect(geometry.inset.left).toBeGreaterThanOrEqual(geometry.surface.left);
  expect(geometry.inset.right).toBeLessThanOrEqual(geometry.surface.right);
  expect(geometry.inset.bottom).toBeLessThanOrEqual(geometry.surface.bottom);
  expect(geometry.inset.width).toBeCloseTo(153.6, 1);
  expect(geometry.inset.height).toBeCloseTo(166.4, 1);
  expect(geometry.insetBackgroundImage).toContain(imageSource ?? "missing-blob-url");
  const backgroundPosition = geometry.insetBackgroundPosition.split(" ").map(Number.parseFloat);
  const backgroundSize = geometry.insetBackgroundSize.split(" ").map(Number.parseFloat);
  expect(backgroundPosition[0]).toBeCloseTo(0, 2);
  expect(backgroundPosition[1]).toBeCloseTo(-1_331.2, 1);
  expect(backgroundSize[0]).toBeCloseTo(1_228.8, 1);
  expect(backgroundSize[1]).toBeCloseTo(1_497.6, 1);
  expect(geometry.buttons).toHaveLength(9);
  for (const button of geometry.buttons) {
    expect(button.width).toBeGreaterThanOrEqual(44);
    expect(button.height).toBeGreaterThanOrEqual(44);
  }
  expect(geometry.controlsScrollWidth).toBeGreaterThan(geometry.controlsClientWidth);
  expect(geometry.controls.left).toBeGreaterThanOrEqual(0);
  expect(geometry.controls.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(Math.abs((geometry.controls.left + geometry.controls.right) / 2 - geometry.viewportWidth / 2)).toBeLessThan(1);
  const lastState = page.getByRole("button", { name: "Play review" });
  await lastState.scrollIntoViewIfNeeded();
  const [lastBox, controlsBox] = await Promise.all([lastState.boundingBox(), page.getByRole("group", { name: "Nine manifest-defined Qbit states" }).boundingBox()]);
  expect(lastBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  expect(lastBox ? lastBox.x + lastBox.width : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    controlsBox ? controlsBox.x + controlsBox.width + 1 : 0,
  );

  await page.keyboard.up("x");
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});

test("honors reduced motion on first render and after a live preference change", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stats = await installChainRoutes(page);
  await page.goto(`/${choreographyFragment(["waving", "review"])}`);
  await expectReady(page);
  await expect(frameDescription(page)).toContainText("idle · row 0 · frame 1/6");

  await page.getByRole("button", { name: "Play waving" }).click();
  await expect(frameDescription(page)).toContainText("waving · row 3 · frame 1/4");
  await page.waitForTimeout(500);
  await expect(frameDescription(page)).toContainText("waving · row 3 · frame 1/4");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(frameDescription(page)).toContainText(/waving · row 3 · frame [2-4]\/4/);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(frameDescription(page)).toContainText("waving · row 3 · frame 1/4");
  await page.waitForTimeout(500);
  await expect(frameDescription(page)).toContainText("waving · row 3 · frame 1/4");
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});
