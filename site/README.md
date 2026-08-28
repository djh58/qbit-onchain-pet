# Qbit Genesis — Bytes. Then being.

This client-only experience begins without a mascot. It supports two pinned
artifacts through one verification pipeline:

- `/` recovers the original Qbit from mainnet transaction
  `852748890119300166f0c3050da3fee5c55316d199bcff1425424c009d2e62b9`.
- `/honorary` recovers Miner One from recipient-bound mainnet transaction
  `53dd2d8982bea1dd1676f6506a497a31c14a81aad21639d019e3658150f231af`.

For either route, the browser reconstructs and checks the transaction ID,
locates the pinned output, decodes its QPET v1 envelope, validates the manifest,
and verifies both pinned SHA-256 digests. Only then does it create one temporary
`blob:` URL from the recovered WebP.

The cropped animation and chain X-ray are two views of that same Blob-backed
surface and the same immutable frame selection. There is no animation sheet,
data URL, canvas copy, or runtime image fallback in the application bundle.
Static favicon and social-card files are the explicit metadata allowlist.

Confirmation wording is intentionally qualified. Transaction and block status
are reported by the Qbit mainnet explorer (`mempool.qbit.org`); the browser checks the reported locator against the
explorer's block-height endpoint but does not perform independent full-node or
SPV consensus verification. The pinned hashes establish byte identity. The
repository's `qpet.py view` command is the local-node path.

Choreographies use a bounded `#play=<base64url(JSON-array)>` fragment containing
only 1–16 verified manifest state IDs. A recipient still has to recover and
verify the inscription before anything plays. Sharing uses Web Share, then the
secure Clipboard API, then an honest focused manual-copy field.

```bash
npm install
npm test
npm run dev
```

The full site test runs typechecking, lint, a production build, pure state/
codec/player/share tests, SSR header and absence checks, and a scan proving the
known spritesheet and envelope bytes (plus common hex/base64 encodings) do not
occur anywhere in the emitted production files.
