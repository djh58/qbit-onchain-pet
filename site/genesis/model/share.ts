export type ShareOutcome = "shared" | "copied" | "cancelled" | "manual" | "failed";

export type ShareAdapter = Readonly<{
  share?: (data: ShareData) => Promise<void>;
  clipboardWrite?: (value: string) => Promise<void>;
  secureContext: boolean;
  manualAvailable: boolean;
}>;

export type ShareAttemptGuard = Readonly<{
  mount: () => void;
  begin: () => number | null;
  isCurrent: (attempt: number) => boolean;
  invalidate: () => void;
}>;

export function buildGenesisShareUrl(
  location: Readonly<{ origin: string; pathname: string }>,
  fragment: string,
): string {
  const url = new URL(location.origin);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== location.origin) {
    throw new TypeError("Share origin is invalid.");
  }
  // Assigning pathname after origin construction keeps a leading `//` in the
  // path; it can never reinterpret inscription-controlled or routed text as a host.
  url.pathname = location.pathname;
  url.hash = fragment;
  return url.toString();
}

export function createShareAttemptGuard(): ShareAttemptGuard {
  let mounted = false;
  let currentAttempt = 0;
  return Object.freeze({
    mount() {
      mounted = true;
    },
    begin() {
      if (!mounted) return null;
      currentAttempt += 1;
      return currentAttempt;
    },
    isCurrent(attempt: number) {
      return mounted && attempt === currentAttempt;
    },
    invalidate() {
      mounted = false;
      currentAttempt += 1;
    },
  });
}

function isCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function shareGenesis(url: string, adapter: ShareAdapter): Promise<ShareOutcome> {
  if (!/^https?:\/\//.test(url)) return "failed";
  if (adapter.share) {
    try {
      await adapter.share({
        title: "Qbit Genesis — Bytes. Then being.",
        text: "Watch one Qbit mainnet transaction become the verified Qbit mascot.",
        url,
      });
      return "shared";
    } catch (error) {
      if (isCancellation(error)) return "cancelled";
    }
  }

  if (adapter.secureContext && adapter.clipboardWrite) {
    try {
      await adapter.clipboardWrite(url);
      return "copied";
    } catch {
      // A selectable field is the honest fallback when permission is denied.
    }
  }

  return adapter.manualAvailable ? "manual" : "failed";
}
