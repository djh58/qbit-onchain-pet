const MAX_STATES = 16;
const MAX_FRAGMENT_BYTES = 512;
const MAX_DECODED_BYTES = 384;

export type ChoreographyDecode =
  | Readonly<{ ok: true; states: readonly string[] }>
  | Readonly<{
      ok: false;
      reason: "absent" | "alphabet" | "oversize" | "encoding" | "json" | "shape" | "unknown-state" | "non-canonical";
    }>;

type HashChangeSource = Readonly<{
  location: Readonly<{ hash: string }>;
  addEventListener: (type: "hashchange", listener: () => void) => void;
  removeEventListener: (type: "hashchange", listener: () => void) => void;
}>;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += BASE64_ALPHABET[(combined >>> 18) & 63];
    output += BASE64_ALPHABET[(combined >>> 12) & 63];
    output += second === undefined ? "=" : BASE64_ALPHABET[(combined >>> 6) & 63];
    output += third === undefined ? "=" : BASE64_ALPHABET[combined & 63];
  }
  return output;
}

function decodeBase64(input: string): Uint8Array | null {
  if (input.length % 4 === 1) return null;
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  const bytes: number[] = [];
  for (let index = 0; index < padded.length; index += 4) {
    const values = padded.slice(index, index + 4).split("").map((character) => character === "=" ? 0 : BASE64_ALPHABET.indexOf(character));
    const combined = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
    bytes.push((combined >>> 16) & 255);
    if (padded[index + 2] !== "=") bytes.push((combined >>> 8) & 255);
    if (padded[index + 3] !== "=") bytes.push(combined & 255);
  }
  return new Uint8Array(bytes);
}

function tokenFor(states: readonly string[]): string {
  const canonicalJson = JSON.stringify(states);
  return encodeBase64(new TextEncoder().encode(canonicalJson)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function encodeChoreography(states: readonly string[], allowedStateIds: readonly string[]): string {
  const allowed = new Set(allowedStateIds);
  if (states.length < 1 || states.length > MAX_STATES || states.some((state) => !allowed.has(state))) {
    throw new Error("Choreography must contain 1–16 known state IDs.");
  }
  const token = tokenFor(states);
  const fragment = `#play=${token}`;
  if (new TextEncoder().encode(fragment).length > MAX_FRAGMENT_BYTES) throw new Error("Choreography fragment is too large.");
  return fragment;
}

export function decodeChoreography(fragment: string, allowedStateIds: readonly string[]): ChoreographyDecode {
  if (!fragment.startsWith("#play=")) return { ok: false, reason: "absent" };
  if (new TextEncoder().encode(fragment).length > MAX_FRAGMENT_BYTES) return { ok: false, reason: "oversize" };
  const token = fragment.slice(6);
  if (!token || token.includes("=") || !/^[A-Za-z0-9_-]+$/.test(token)) return { ok: false, reason: "alphabet" };
  const decoded = decodeBase64(token);
  if (!decoded || decoded.byteLength > MAX_DECODED_BYTES) return { ok: false, reason: "encoding" };

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch {
    return { ok: false, reason: "json" };
  }

  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_STATES || value.some((item) => typeof item !== "string")) {
    return { ok: false, reason: "shape" };
  }
  const states = value as string[];
  const allowed = new Set(allowedStateIds);
  if (states.some((state) => !allowed.has(state))) return { ok: false, reason: "unknown-state" };
  if (tokenFor(states) !== token) return { ok: false, reason: "non-canonical" };
  return { ok: true, states: Object.freeze([...states]) };
}

// Hash navigation is a real input channel: back/forward and links pasted into
// an already-open tab replace the sequence without reloading recovered bytes.
// Decoding and all size/state bounds remain owned by decodeChoreography.
export function observeChoreographyFragment(
  source: HashChangeSource,
  onChange: (fragment: string) => void,
): () => void {
  const update = () => onChange(source.location.hash);
  update();
  source.addEventListener("hashchange", update);
  return () => source.removeEventListener("hashchange", update);
}
