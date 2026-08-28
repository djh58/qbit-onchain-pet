import {
  expect,
  expectReady,
  installBlobProbe,
  installChainRoutes,
  installHonoraryChainRoutes,
  mascotSurface,
  spriteInteraction,
  test,
} from "./harness";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installBlobProbe(page);
});

test("recovers recipient-bound Miner One from mainnet, proves the block-one honor, and switches to the OG", async ({ page }) => {
  const original = await installChainRoutes(page);
  const honorary = await installHonoraryChainRoutes(page);

  await page.goto("/honorary");
  await expectReady(page);
  await expect(spriteInteraction(page, "Miner One")).toBeVisible();
  await expect(page.getByRole("link", { name: "Miner #1 · Mainnet" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "OG · Mainnet" })).not.toHaveAttribute("aria-current", "page");
  await expect(mascotSurface(page).locator("img")).toHaveAttribute("src", /^blob:/);
  expect(honorary).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
  expect(original).toEqual({ transactionRequests: 0, blockRequests: 0, unexpectedExplorerRequests: [] });

  await page.getByRole("button", { name: "Open receipt" }).click();
  await expect(page.getByText("Qbit mainnet", { exact: true })).toBeVisible();
  await expect(page.getByText("exact output index + amount + script verified ✓", { exact: true })).toBeVisible();
  await expect(page.getByText("1 · 0.00010000 QBT · v2_p2mr", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /qb1z8q6dsf8sla7vcn2gzxnspuzpshzrkkk80c2a67xdpea2yxkpsm4qmzhake/ })).toHaveAttribute(
    "href",
    "https://mempool.qbit.org/address/qb1z8q6dsf8sla7vcn2gzxnspuzpshzrkkk80c2a67xdpea2yxkpsm4qmzhake",
  );
  await expect(page.getByText("52203834d824f0ff7ccc4d4811a700f04185c43b5ac77e15dd78cd0e7aa21ac186ea", { exact: true })).toBeVisible();
  await expect(page.getByText("the miner of Qbit mainnet block 1", { exact: true })).toBeVisible();
  await expect(page.getByText("ckpool · /qbit-mining-bootstrap/", { exact: true })).toBeVisible();
  await expect(page.getByText("53dd2d8982bea1dd1676f6506a497a31c14a81aad21639d019e3658150f231af", { exact: false })).toBeVisible();

  await page.getByRole("link", { name: "OG · Mainnet" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expectReady(page);
  await expect(spriteInteraction(page)).toBeVisible();
  expect(original).toEqual({ transactionRequests: 1, blockRequests: 1, unexpectedExplorerRequests: [] });
});
