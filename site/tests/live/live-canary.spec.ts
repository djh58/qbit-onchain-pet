import {
  expect,
  test as base,
  type APIResponse,
  type Page,
} from "@playwright/test";

const SITE_ORIGIN = "https://qbit-onchain-pet.thedanhepworth.chatgpt.site";
const EXPLORER_ORIGIN = "https://mempool.qbit.org";
const SOURCE_REPOSITORY = "https://github.com/djh58/qbit-onchain-pet";
const CODEX_PETS_URL = "https://codex-pets.net/#/pets/qbit";
const TRANSACTION_ID = "852748890119300166f0c3050da3fee5c55316d199bcff1425424c009d2e62b9";
const BLOCK_HEIGHT = 53_026;
const BLOCK_HASH = "0000000000000000893a81d2e44e1e16cbaf59cd58f901b6be29603ad2935460";
const TRANSACTION_URL = `${EXPLORER_ORIGIN}/api/tx/${TRANSACTION_ID}`;
const BLOCK_URL = `${EXPLORER_ORIGIN}/api/block-height/${BLOCK_HEIGHT}`;
const HONORARY_TRANSACTION_ID = "53dd2d8982bea1dd1676f6506a497a31c14a81aad21639d019e3658150f231af";
const HONORARY_BLOCK_HEIGHT = 63_174;
const HONORARY_BLOCK_HASH = "000000000000000027a132d416c0d5dfd8a8b6bca42c0b6548a6d3ec66b4a100";
const HONORARY_TRANSACTION_URL = `${EXPLORER_ORIGIN}/api/tx/${HONORARY_TRANSACTION_ID}`;
const HONORARY_BLOCK_URL = `${EXPLORER_ORIGIN}/api/block-height/${HONORARY_BLOCK_HEIGHT}`;
const HONORARY_RECIPIENT = "qb1z8q6dsf8sla7vcn2gzxnspuzpshzrkkk80c2a67xdpea2yxkpsm4qmzhake";
const HONORARY_RECIPIENT_SCRIPT = "52203834d824f0ff7ccc4d4811a700f04185c43b5ac77e15dd78cd0e7aa21ac186ea";
const HONORARY_SHEET_SHA256 = "128f1ebbc42239286c21c622ad5892237d2d73842fdf3481989b70606046a7cc";
const STATE_IDS = [
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

type LiveHealth = Readonly<{
  consoleErrors: string[];
  pageErrors: string[];
  requestFailures: string[];
}>;

const test = base.extend<{ liveHealth: LiveHealth }>({
  liveHealth: [async ({ page }, use) => {
    const health: LiveHealth = {
      consoleErrors: [],
      pageErrors: [],
      requestFailures: [],
    };
    page.on("console", (message) => {
      if (message.type() === "error") health.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => health.pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      health.requestFailures.push(
        `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`,
      );
    });

    await use(health);

    expect.soft(health.consoleErrors, "unexpected browser console errors").toEqual([]);
    expect.soft(health.pageErrors, "uncaught browser page errors").toEqual([]);
    expect.soft(health.requestFailures, "unexpected browser request failures").toEqual([]);
  }, { auto: true }],
});

function expectCors(response: APIResponse): void {
  const headers = response.headers();
  expect(headers["access-control-allow-origin"]).toBe("*");
  expect(headers["access-control-allow-methods"]?.split(/\s*,\s*/)).toContain("GET");
}

function expectSecurityHeaders(headers: Record<string, string>): void {
  const contentSecurityPolicy = headers["content-security-policy"] ?? "";
  for (const directive of [
    "default-src 'none'",
    "connect-src 'self' https://mempool.qbit.org",
    "img-src 'self' blob:",
    "font-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "manifest-src 'self'",
  ]) {
    expect(contentSecurityPolicy, `CSP must contain ${directive}`).toContain(directive);
  }
  expect(headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=(), payment=()");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["strict-transport-security"]?.toLowerCase()).toContain("max-age=31536000");
  expect(headers["strict-transport-security"]?.toLowerCase()).toContain("includesubdomains");
}

async function expectFavicon(
  response: APIResponse,
  contentType: RegExp,
  signature: readonly number[],
): Promise<void> {
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(contentType);
  const bytes = await response.body();
  expect(bytes.byteLength).toBeGreaterThan(signature.length);
  expect(Array.from(bytes.subarray(0, signature.length))).toEqual(signature);
}

async function installBlobProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = globalThis as typeof globalThis & {
      __qbitLiveBlobProbe?: {
        created: Array<{ url: string; size: number; type: string }>;
      };
    };
    const originalCreate = URL.createObjectURL.bind(URL);
    target.__qbitLiveBlobProbe = { created: [] };
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = originalCreate(object);
      target.__qbitLiveBlobProbe?.created.push({
        url,
        size: object instanceof Blob ? object.size : 0,
        type: object instanceof Blob ? object.type : "media-source",
      });
      return url;
    };
  });
}

test("production is explorer-attested and awakens one on-chain Qbit Blob", async ({ page, request }, testInfo) => {
  const configuredBaseURL = String(testInfo.project.use.baseURL ?? SITE_ORIGIN);
  const configuredOrigin = new URL(configuredBaseURL).origin;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installBlobProbe(page);

  const homeResponse = await request.get("/", { timeout: 30_000 });
  expect(homeResponse.status()).toBe(200);
  expect(homeResponse.url()).toMatch(new RegExp(`^${configuredOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?$`));
  expect(homeResponse.headers()["content-type"]).toContain("text/html");
  expectSecurityHeaders(homeResponse.headers());

  const [iconResponse, pngResponse] = await Promise.all([
    request.get("/favicon.ico?v=2", { timeout: 30_000 }),
    request.get("/favicon.png?v=2", { timeout: 30_000 }),
  ]);
  await expectFavicon(iconResponse, /^image\/(?:vnd\.microsoft\.icon|x-icon)\b/i, [0, 0, 1, 0]);
  await expectFavicon(pngResponse, /^image\/png\b/i, [137, 80, 78, 71, 13, 10, 26, 10]);

  const explorerHeaders = {
    Accept: "application/json",
    Origin: configuredOrigin,
  };
  const [transactionResponse, blockResponse] = await Promise.all([
    request.get(TRANSACTION_URL, { headers: explorerHeaders, timeout: 30_000 }),
    request.get(BLOCK_URL, {
      headers: { Accept: "text/plain", Origin: configuredOrigin },
      timeout: 30_000,
    }),
  ]);
  expect(transactionResponse.status()).toBe(200);
  expectCors(transactionResponse);
  const transactionBytes = await transactionResponse.body();
  expect(transactionBytes.byteLength).toBeGreaterThan(9_548);
  expect(transactionBytes.byteLength).toBeLessThanOrEqual(400 * 1_024);
  const transaction = JSON.parse(transactionBytes.toString("utf8")) as Record<string, unknown>;
  expect(transaction).toMatchObject({
    txid: TRANSACTION_ID,
    status: {
      confirmed: true,
      block_height: BLOCK_HEIGHT,
      block_hash: BLOCK_HASH,
    },
  });
  expect(Array.isArray(transaction.vout)).toBe(true);
  const transactionOutputs = transaction.vout as unknown[];
  expect(transactionOutputs.length).toBeGreaterThanOrEqual(1);
  expect(transactionOutputs[0]).toMatchObject({ value: 0, scriptpubkey_type: "op_return" });
  expect(blockResponse.status()).toBe(200);
  expectCors(blockResponse);
  expect((await blockResponse.text()).trim()).toBe(BLOCK_HASH);

  const pageTransactionResponse = page.waitForResponse(
    (response) => response.url() === TRANSACTION_URL && response.status() === 200,
    { timeout: 45_000 },
  );
  const pageBlockResponse = page.waitForResponse(
    (response) => response.url() === BLOCK_URL && response.status() === 200,
    { timeout: 45_000 },
  );
  const [documentResponse, browserTransactionResponse, browserBlockResponse] = await Promise.all([
    page.goto("/", { waitUntil: "domcontentloaded" }),
    pageTransactionResponse,
    pageBlockResponse,
  ]);
  expect(documentResponse?.status()).toBe(200);
  expect(browserTransactionResponse.headers()["access-control-allow-origin"]).toBe("*");
  expect(browserBlockResponse.headers()["access-control-allow-origin"]).toBe("*");

  const sourceLink = page.locator(`a[href="${SOURCE_REPOSITORY}"]`).first();
  await expect(sourceLink).toBeVisible();
  await expect(sourceLink).toHaveAttribute("target", "_blank");
  await expect(sourceLink).toHaveAttribute("rel", /noreferrer/);
  const codexPetsLink = page.locator(`a[href="${CODEX_PETS_URL}"]`).first();
  await expect(codexPetsLink).toBeVisible();
  await expect(codexPetsLink).toContainText("https://codex-pets.net/#/pets/qbit");
  await expect(page.locator('link[rel="icon"][href^="/favicon.ico"]')).toHaveCount(1);
  await expect(page.locator('link[rel="icon"][href^="/favicon.png"]')).toHaveCount(1);

  const transactionExplorerURL = `${EXPLORER_ORIGIN}/tx/${TRANSACTION_ID}`;
  const blockExplorerURL = `${EXPLORER_ORIGIN}/block/${BLOCK_HASH}`;
  await expect(page.locator(`a[href="${transactionExplorerURL}"]`).first()).toBeVisible();
  await page.getByText("Complete chain receipt", { exact: true }).click();
  await expect(page.locator(`a[href="${blockExplorerURL}"]`)).toBeVisible();

  const status = page.getByRole("status");
  await expect(status).toContainText("Recovered from Qbit mainnet");
  await expect(status).toContainText("confirmed, reported by mempool.qbit.org");
  await expect(page.getByText("bytes verified; current block status unavailable", { exact: true })).toHaveCount(0);

  const mascotSurface = page.locator('[data-media-origin="verified-blob"]');
  await expect(mascotSurface).toHaveCount(1);
  const image = mascotSurface.locator("img");
  await expect(image).toHaveCount(1);
  await expect(page.locator('img[src^="blob:"]')).toHaveCount(1);
  await expect(page.locator("img")).toHaveCount(1);
  const imageFacts = await image.evaluate((node) => {
    const imageNode = node as HTMLImageElement;
    const target = globalThis as typeof globalThis & { __qbitLiveImageNode?: HTMLImageElement };
    target.__qbitLiveImageNode = imageNode;
    return {
      src: imageNode.src,
      naturalWidth: imageNode.naturalWidth,
      naturalHeight: imageNode.naturalHeight,
      complete: imageNode.complete,
    };
  });
  expect(imageFacts).toMatchObject({
    naturalWidth: 1_536,
    naturalHeight: 1_872,
    complete: true,
  });
  expect(imageFacts.src).toMatch(/^blob:/);
  expect(await page.evaluate(() => {
    const target = globalThis as typeof globalThis & {
      __qbitLiveBlobProbe?: { created: Array<{ url: string; size: number; type: string }> };
    };
    return target.__qbitLiveBlobProbe?.created;
  })).toEqual([{ url: imageFacts.src, size: 8_616, type: "image/webp" }]);

  const stateControls = page.getByRole("group", { name: "Nine manifest-defined Qbit states" });
  const stateButtons = stateControls.getByRole("button");
  await expect(stateButtons).toHaveCount(9);
  for (const stateId of STATE_IDS) {
    const button = page.getByRole("button", { name: `Play ${stateId}`, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }

  await page.keyboard.down("x");
  await expect(page.locator('[data-xray="open"]')).toHaveCount(1);
  await expect(mascotSurface).toHaveAttribute(
    "aria-label",
    "The verified Qbit spritesheet with the current animation cell highlighted",
  );
  await expect(page.getByText(`sha256 8ea6a2514e745bc4393f9a46cb37d207c2448c716e331143cb80ba14b0654333`)).toBeVisible();
  expect(await image.evaluate((node) => {
    const target = globalThis as typeof globalThis & { __qbitLiveImageNode?: HTMLImageElement };
    return {
      sameNode: node === target.__qbitLiveImageNode,
      src: (node as HTMLImageElement).src,
      blobImageCount: document.querySelectorAll('img[src^="blob:"]').length,
    };
  })).toEqual({ sameNode: true, src: imageFacts.src, blobImageCount: 1 });
  await page.keyboard.up("x");
  await expect(page.locator('[data-xray="closed"]')).toHaveCount(1);
});

test("production recovers the recipient-bound mainnet Miner One Blob", async ({ page, request }, testInfo) => {
  const configuredBaseURL = String(testInfo.project.use.baseURL ?? SITE_ORIGIN);
  const configuredOrigin = new URL(configuredBaseURL).origin;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installBlobProbe(page);

  const honoraryResponse = await request.get("/honorary", { timeout: 30_000 });
  expect(honoraryResponse.status()).toBe(200);
  expect(honoraryResponse.headers()["content-type"]).toContain("text/html");
  expectSecurityHeaders(honoraryResponse.headers());

  const explorerHeaders = { Accept: "application/json", Origin: configuredOrigin };
  const [transactionResponse, blockResponse] = await Promise.all([
    request.get(HONORARY_TRANSACTION_URL, { headers: explorerHeaders, timeout: 30_000 }),
    request.get(HONORARY_BLOCK_URL, {
      headers: { Accept: "text/plain", Origin: configuredOrigin },
      timeout: 30_000,
    }),
  ]);
  expect(transactionResponse.status()).toBe(200);
  expectCors(transactionResponse);
  const transaction = JSON.parse((await transactionResponse.body()).toString("utf8")) as {
    txid: string;
    size: number;
    vsize: number;
    fee: number;
    status: { confirmed: boolean; block_height: number; block_hash: string };
    vout: Array<{
      value: number;
      scriptpubkey: string;
      scriptpubkey_type: string;
      scriptpubkey_address?: string;
    }>;
  };
  expect(transaction).toMatchObject({
    txid: HONORARY_TRANSACTION_ID,
    size: 14_494,
    vsize: 14_494,
    fee: 28_990,
    status: {
      confirmed: true,
      block_height: HONORARY_BLOCK_HEIGHT,
      block_hash: HONORARY_BLOCK_HASH,
    },
  });
  expect(transaction.vout[0]).toMatchObject({ value: 0, scriptpubkey_type: "op_return" });
  expect(transaction.vout[1]).toMatchObject({
    value: 10_000,
    scriptpubkey: HONORARY_RECIPIENT_SCRIPT,
    scriptpubkey_type: "v2_p2mr",
    scriptpubkey_address: HONORARY_RECIPIENT,
  });
  expect(blockResponse.status()).toBe(200);
  expectCors(blockResponse);
  expect((await blockResponse.text()).trim()).toBe(HONORARY_BLOCK_HASH);

  const pageTransactionResponse = page.waitForResponse(
    (response) => response.url() === HONORARY_TRANSACTION_URL && response.status() === 200,
    { timeout: 45_000 },
  );
  const pageBlockResponse = page.waitForResponse(
    (response) => response.url() === HONORARY_BLOCK_URL && response.status() === 200,
    { timeout: 45_000 },
  );
  const [documentResponse, browserTransactionResponse, browserBlockResponse] = await Promise.all([
    page.goto("/honorary", { waitUntil: "domcontentloaded" }),
    pageTransactionResponse,
    pageBlockResponse,
  ]);
  expect(documentResponse?.status()).toBe(200);
  expect(browserTransactionResponse.headers()["access-control-allow-origin"]).toBe("*");
  expect(browserBlockResponse.headers()["access-control-allow-origin"]).toBe("*");

  const status = page.getByRole("status");
  await expect(status).toContainText("Recovered from Qbit mainnet");
  await expect(status).toContainText("confirmed, reported by mempool.qbit.org");
  await expect(page.getByText("Miner #1 · Mainnet", { exact: true })).toBeVisible();
  await expect(page.getByText("OG · Mainnet", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("testnet");

  const mascotSurface = page.locator('[data-media-origin="verified-blob"]');
  await expect(mascotSurface).toHaveCount(1);
  const image = mascotSurface.locator("img");
  await expect(image).toHaveCount(1);
  const imageFacts = await image.evaluate((node) => ({
    src: (node as HTMLImageElement).src,
    naturalWidth: (node as HTMLImageElement).naturalWidth,
    naturalHeight: (node as HTMLImageElement).naturalHeight,
    complete: (node as HTMLImageElement).complete,
  }));
  expect(imageFacts).toMatchObject({ naturalWidth: 1_536, naturalHeight: 1_872, complete: true });
  expect(imageFacts.src).toMatch(/^blob:/);
  expect(await page.evaluate(() => {
    const target = globalThis as typeof globalThis & {
      __qbitLiveBlobProbe?: { created: Array<{ url: string; size: number; type: string }> };
    };
    return target.__qbitLiveBlobProbe?.created;
  })).toEqual([{ url: imageFacts.src, size: 9_644, type: "image/webp" }]);

  await page.getByText("Complete chain receipt", { exact: true }).click();
  await expect(page.getByText("exact output index + amount + script verified ✓", { exact: true })).toBeVisible();
  await expect(page.getByText(`1 · 0.00010000 QBT · v2_p2mr`, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `${HONORARY_RECIPIENT} ↗`, exact: true })).toBeVisible();
  await expect(page.getByText(HONORARY_RECIPIENT_SCRIPT, { exact: true })).toBeVisible();
  await expect(page.locator(`a[href="${EXPLORER_ORIGIN}/tx/${HONORARY_TRANSACTION_ID}"]`).first()).toBeVisible();
  await expect(page.locator(`a[href="${EXPLORER_ORIGIN}/block/${HONORARY_BLOCK_HASH}"]`).first()).toBeVisible();

  await page.keyboard.down("x");
  await expect(page.locator('[data-xray="open"]')).toHaveCount(1);
  await expect(page.getByText(`sha256 ${HONORARY_SHEET_SHA256}`)).toBeVisible();
  await page.keyboard.up("x");
  await expect(page.locator('[data-xray="closed"]')).toHaveCount(1);
});
