# Qbit, permanently committed

The animated Qbit mascot, encoded in one Qbit mainnet transaction and
re-animated from chain data alone.

- [Live viewer](https://qbit-onchain-pet.thedanhepworth.chatgpt.site)
- [Mainnet transaction](https://mempool.qbit.org/tx/852748890119300166f0c3050da3fee5c55316d199bcff1425424c009d2e62b9)
- [Download Qbit for your coding agent](https://codex-pets.net/#/pets/qbit)
- Block: `53,026`
- Transaction: `852748890119300166f0c3050da3fee5c55316d199bcff1425424c009d2e62b9`
- QPET envelope SHA-256: `e9a9ce232eeee3657e87053edf27b0b1f5493c9111d9a37c41fc5cdb85a24247`
- Spritesheet SHA-256: `8ea6a2514e745bc4393f9a46cb37d207c2448c716e331143cb80ba14b0654333`

## What is here

- `qpet.py` builds, inscribes, decodes, and verifies QPET v1 envelopes.
- `assets/qbit/` contains the original codex-pets manifest and spritesheet.
- `site/` is the hosted client-only viewer.

The hosted viewer does **not** bundle the animation sheet. It downloads the
transaction from the public Qbit explorer, locates the OP_RETURN payload,
parses the QPET envelope, verifies the pinned envelope and sheet hashes, then
creates a temporary browser `blob:` URL from the recovered WebP bytes. The
favicon and social card are static derivatives; the animated mascot is not.

The explorer is the site's source for transaction membership and confirmation
metadata. The pinned hashes prevent it from substituting different mascot
bytes, but the browser is not doing independent full-node or SPV consensus
verification. Use the node-backed command below for an independent chain read.

## QPET v1 envelope

One OP_RETURN output contains one data push:

| Offset | Size | Field |
|---|---:|---|
| `0` | 4 | Magic `QPET` |
| `4` | 1 | Version `0x01` |
| `5` | 2 | Manifest length `M`, uint16 little-endian |
| `7` | `M` | Manifest JSON, UTF-8 |
| `7 + M` | rest | Spritesheet bytes |

The manifest carries the frame grid and full codex-pets animation table, so a
viewer can reconstruct all nine states from the transaction alone.

QPET v1 uses an exact manifest schema. Text fields must be bounded UTF-8,
animation states must have unique IDs and fit inside the declared grid, and the
spritesheet must be `image/webp` with an exact byte length and SHA-256 digest.
Decoders reject extra v1 fields, non-standard JSON constants, malformed
pushdata, multiple pushes, and declarations that do not match the recovered
bytes.

## Verify from your own node

```bash
python3 qpet.py \
  --cli /path/to/qbit-cli \
  --datadir /path/to/qbit/datadir \
  --chain main \
  --wallet your-wallet \
  view 852748890119300166f0c3050da3fee5c55316d199bcff1425424c009d2e62b9 \
  --out /tmp/qbit-pet.html
```

A successful reconstruction prints `sheet sha256 verified` before writing the
self-contained HTML viewer.

`qbit-cli` is read from `PATH` by default. The CLI defaults to mainnet and
qbit's normal data directory, with no wallet selected. Pass `--cli`,
`--datadir`, or `--wallet` only when your node setup needs them.

## Run the hosted viewer locally

```bash
cd site
npm install
npm test
npm run dev
```

## Inscribe a QPET

Global node and wallet flags must come before `inscribe`:

```bash
python3 qpet.py \
  --cli /path/to/qbit-cli \
  --datadir /path/to/qbit/datadir \
  --chain main \
  --wallet your-wallet \
  inscribe \
  --manifest assets/qbit/pet.json \
  --sheet assets/qbit/spritesheet.webp \
  --fee-rate 1 \
  --dry-run
```

Review the dry-run fee and virtual size carefully. Removing `--dry-run`
runs `testmempoolaccept` and then asks you to type `broadcast` before sending
that exact signed transaction. Automation must pass `--yes` explicitly.

The first QPET inscription was Qbit on testnet4 in block `82,220`:
`1706f311c617cff953530895c3d3503216774ba1dc6a2d758204009ceb41c7e6`.

## Contributing and reuse

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the local
checks and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

The repository is MIT licensed. Mascot terms are documented in
[ASSET_LICENSE.md](ASSET_LICENSE.md), and the Codex Pet Share animation-table
attribution is preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
