import AxeBuilder from "@axe-core/playwright";
import type { Route } from "@playwright/test";
import {
  BLOCK_HASH,
  EXPLORER_ORIGIN,
  choreographyFragment,
  cloneTransactionFixture,
  expect,
  expectReady,
  frameDescription,
  fulfillTransaction,
  installBlobProbe,
  installChainRoutes,
  mascotSurface,
  spriteInteraction,
  test,
  transactionFixtureText,
  xrayControl,
} from "./harness";

const failureCors = { "access-control-allow-origin": "*" };

test("replaces choreography from live hash navigation and ignores invalid fragments without refetching", async ({ page }) => {
  const stats = await installChainRoutes(page);
  await page.goto(`/${choreographyFragment(["review"])}`);
  await expectReady(page);
  await expect(frameDescription(page)).toContainText("review · row 8");

  const replacement = choreographyFragment(["waving"]);
  await page.evaluate((hash) => { window.location.hash = hash; }, replacement);
  await expect(frameDescription(page)).toContainText("waving · row 3");
  expect(stats.transactionRequests).toBe(1);
  expect(stats.blockRequests).toBe(1);

  await page.evaluate(() => { window.location.hash = "#play=%%%"; });
  await expect(page.getByText("The choreography in this URL was invalid and was ignored. The QPET still recovered normally.")).toBeVisible();
  await expect(mascotSurface(page)).toHaveCount(1);
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});

test("a shared choreography cancels a pending manual inactivity command", async ({ page }) => {
  const stats = await installChainRoutes(page);
  await page.goto("/");
  await expectReady(page);

  await page.getByRole("button", { name: "Play waving" }).click();
  const replacement = choreographyFragment(Array.from({ length: 8 }, () => "review"));
  await page.evaluate((hash) => { window.location.hash = hash; }, replacement);
  await expect(frameDescription(page)).toContainText("review · row 8");

  await page.waitForTimeout(4_500);
  await expect(frameDescription(page)).toContainText("review · row 8");
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});

test("fails closed on representative source and identity errors", async ({ page }) => {
  await installBlobProbe(page);
  const tampered = cloneTransactionFixture();
  tampered.txid = "0".repeat(64);
  const cases: Array<Readonly<{ body: string; contentType: string; title: string }>> = [
    { body: "not-json", contentType: "application/json", title: "The source response was refused." },
    { body: JSON.stringify(tampered), contentType: "application/json", title: "Transaction identity did not match." },
    { body: transactionFixtureText, contentType: "text/plain", title: "The source response was refused." },
  ];

  let caseIndex = 0;
  const stats = await installChainRoutes(page, {
    transaction: async (route: Route) => {
      const entry = cases[caseIndex];
      await route.fulfill({
        status: 200,
        contentType: entry.contentType,
        headers: failureCors,
        body: entry.body,
      });
    },
  });

  for (const [index, entry] of cases.entries()) {
    caseIndex = index;
    await page.goto("/");
    await expect(page.getByRole("heading", { name: entry.title })).toBeVisible();
    await expect(mascotSurface(page)).toHaveCount(0);
    await expect(page.locator("img")).toHaveCount(0);
    await page.waitForLoadState("networkidle");
  }
  expect(await page.evaluate(() => {
    const target = globalThis as typeof globalThis & { __qbitBlobProbe?: { created: string[] } };
    return target.__qbitBlobProbe?.created;
  })).toEqual([]);
  expect(stats.transactionRequests).toBe(3);
  expect(stats.blockRequests).toBe(0);
  expect(stats.unexpectedExplorerRequests).toEqual([]);
});

test("fails safely without an unhandled rejection when Blob URL creation is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    URL.createObjectURL = () => { throw new Error("Blob URLs unavailable"); };
  });
  const stats = await installChainRoutes(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Recovery stopped safely." })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("unexpected browser failure");
  await expect(mascotSurface(page)).toHaveCount(0);
  await expect(page.locator("img")).toHaveCount(0);
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});

test("survives rapid retry attempts and installs only the newest verified Blob", async ({ page, pageHealth }) => {
  pageHealth.allowConsoleError(/Failed to load resource: the server responded with a status of 503/);
  await installBlobProbe(page);
  let fail = true;
  const stats = await installChainRoutes(page, {
    transaction: async (route: Route) => {
      if (fail) {
        await route.fulfill({ status: 503, contentType: "text/plain", headers: failureCors, body: "unavailable" });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 40));
        try {
          await fulfillTransaction(route);
        } catch {
          // A superseded browser request may already be aborted; that is the race under test.
        }
      }
    },
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The public source is unavailable." })).toBeVisible();
  await expect(mascotSurface(page)).toHaveCount(0);

  fail = false;
  await page.getByRole("button", { name: "Retry chain recovery" }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expectReady(page);
  await page.waitForTimeout(100);
  await expect(mascotSurface(page).locator("img")).toHaveCount(1);
  const probe = await page.evaluate(() => {
    const target = globalThis as typeof globalThis & { __qbitBlobProbe?: { created: string[]; revoked: string[] } };
    return target.__qbitBlobProbe;
  });
  expect(probe?.created.length).toBeGreaterThanOrEqual(1);
  expect((probe?.created.length ?? 0) - (probe?.revoked.length ?? 0)).toBe(1);
  expect(stats.transactionRequests).toBeGreaterThanOrEqual(3);
  expect(stats.blockRequests).toBe(1);
  expect(stats.unexpectedExplorerRequests).toEqual([]);
});

test("degrades only the block-status claim when optional attestation fails", async ({ page }) => {
  const stats = await installChainRoutes(page, {
    block: async (route: Route) => {
      await route.fulfill({ status: 200, contentType: "text/plain", headers: failureCors, body: "not-a-block-hash" });
    },
  });
  await page.goto("/");
  await expectReady(page, "degraded");
  await expect(page.getByRole("status")).toContainText("bytes verified; current block status unavailable");
  await expect(page.getByText("byte-perfect ✓")).toBeVisible();
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});

test("manual share is focused, selected, canonical, and strips query parameters", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  });
  const stats = await installChainRoutes(page);
  await page.goto("/?utm_source=private&token=do-not-share");
  await expectReady(page);
  await page.getByRole("button", { name: "Play waving" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Play jumping" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^share/i }).focus();
  await page.keyboard.press("Enter");

  const field = page.getByLabel("Copy this choreography URL manually");
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();
  const value = await field.inputValue();
  expect(value).toBe(`${new URL(page.url()).origin}/${choreographyFragment(["waving", "jumping"])}`);
  expect(value).not.toContain("utm_source");
  expect(value).not.toContain("token");
  expect(await field.evaluate((input) => ({
    start: (input as HTMLInputElement).selectionStart,
    end: (input as HTMLInputElement).selectionEnd,
    length: (input as HTMLInputElement).value.length,
  }))).toMatchObject({ start: 0, end: value.length, length: value.length });
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});

test("treats native share cancellation neutrally without claiming copy success", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => { throw new DOMException("cancelled", "AbortError"); },
    });
  });
  const stats = await installChainRoutes(page);
  await page.goto("/");
  await expectReady(page);
  await page.getByRole("button", { name: /^share/i }).click();
  await expect(page.getByRole("button", { name: /share cancelled/i })).toBeVisible();
  await expect(page.getByLabel("Copy this choreography URL manually")).toHaveCount(0);
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});

test("reports clipboard success only after the canonical choreography URL is written", async ({ page }) => {
  await page.addInitScript(() => {
    const target = globalThis as typeof globalThis & { __qbitClipboardValue?: string };
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => { target.__qbitClipboardValue = value; },
      },
    });
  });
  const stats = await installChainRoutes(page);
  await page.goto("/?private=drop-me");
  await expectReady(page);
  await page.getByRole("button", { name: /^share/i }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /link copied/i })).toBeVisible();
  const copied = await page.evaluate(() => {
    const target = globalThis as typeof globalThis & { __qbitClipboardValue?: string };
    return target.__qbitClipboardValue;
  });
  expect(copied).toBe(`${new URL(page.url()).origin}/${choreographyFragment(["idle"])}`);
  expect(copied).not.toContain("private");
  await expect(page.getByLabel("Copy this choreography URL manually")).toHaveCount(0);
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});

test("passes WCAG A/AA checks and keeps core controls keyboard operable with visible focus", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stats = await installChainRoutes(page);
  await page.goto("/");
  await expectReady(page);

  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toBeVisible();
  expect(await focused.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none");

  await spriteInteraction(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("button", { name: "Play running-left" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Play running-right" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("button", { name: "Play jumping" })).toHaveAttribute("aria-pressed", "true");

  await xrayControl(page).focus();
  await page.keyboard.press("Enter");
  await expect(xrayControl(page)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(xrayControl(page)).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Play review" }).press("Enter");
  await expect(page.getByRole("button", { name: "Play review" })).toHaveAttribute("aria-pressed", "true");

  const outbound = page.locator('a[target="_blank"]');
  expect(await outbound.count()).toBeGreaterThan(0);
  for (const link of await outbound.all()) {
    await expect(link).toHaveAttribute("rel", /noreferrer/);
  }
  await expect(page.getByRole("link", { name: /Get Qbit for your coding agent/ })).toHaveAttribute("href", "https://codex-pets.net/#/pets/qbit");
  await expect(page.getByRole("link", { name: /Source/ }).first()).toHaveAttribute("href", "https://github.com/djh58/qbit-onchain-pet");
  await expect(page.locator(`a[href="${EXPLORER_ORIGIN}/tx/852748890119300166f0c3050da3fee5c55316d199bcff1425424c009d2e62b9"]`).first()).toBeVisible();
  await page.getByRole("button", { name: "Open receipt" }).click();
  await expect(page.locator("#chain-receipt")).toHaveAttribute("open", "");
  await expect(page.getByText("Qbit mainnet", { exact: true })).toBeVisible();
  await expect(page.locator(`a[href="${EXPLORER_ORIGIN}/block/${BLOCK_HASH}"]`)).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
  expect(stats).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});
