# Qbit Genesis — Bytes. Then being.

Two animated on-chain QPETs, each recovered from its transaction and animated
only after every pinned byte verifies in the browser: the original Qbit mascot
and Miner One, an honorary QPET for the miner of Qbit mainnet block 1.

- [Original Qbit viewer](https://qbit-onchain-pet.thedanhepworth.chatgpt.site)
- [Miner One honorary viewer](https://qbit-onchain-pet.thedanhepworth.chatgpt.site/honorary)
- [Original Qbit mainnet transaction](https://mempool.qbit.org/tx/852748890119300166f0c3050da3fee5c55316d199bcff1425424c009d2e62b9)
- [Miner One mainnet transaction](https://mempool.qbit.org/tx/53dd2d8982bea1dd1676f6506a497a31c14a81aad21639d019e3658150f231af)
- [Download Qbit for your coding agent](https://codex-pets.net/#/pets/qbit)

| QPET | Network / block | Transaction | Envelope SHA-256 | Spritesheet SHA-256 |
|---|---|---|---|---|
| Qbit | Mainnet / `53,026` | `852748890119300166f0c3050da3fee5c55316d199bcff1425424c009d2e62b9` | `e9a9ce232eeee3657e87053edf27b0b1f5493c9111d9a37c41fc5cdb85a24247` | `8ea6a2514e745bc4393f9a46cb37d207c2448c716e331143cb80ba14b0654333` |
| Miner One | Mainnet / `63,174` | `53dd2d8982bea1dd1676f6506a497a31c14a81aad21639d019e3658150f231af` | `ca2a0c0d16aeb3b370592521d6c02ee181684028683fe3602f214322b43d05e5` | `128f1ebbc42239286c21c622ad5892237d2d73842fdf3481989b70606046a7cc` |

Miner One also commits an honorary transfer at output `1`: exactly
`0.00010000 QBT` to the block-one coinbase payout address
`qb1z8q6dsf8sla7vcn2gzxnspuzpshzrkkk80c2a67xdpea2yxkpsm4qmzhake`.

## What is here

- `qpet.py` builds, inscribes, decodes, and verifies QPET v1 envelopes.
- `assets/qbit/` contains the original codex-pets manifest and spritesheet.
- `assets/miner-one/` contains the honorary manifest and production spritesheet.
- `scripts/build-miner-one-sprite.mjs` deterministically rebuilds Miner One from
  the canonical Qbit sheet; `scripts/verify-miner-one-sprite.mjs` checks cell
  bounds, accessory coverage, unused cells, and pixel-grid integrity.
- `site/` is the hosted client-only viewer.

The hosted viewer does **not** bundle either animation sheet. It downloads the
selected transaction from the matching public Qbit explorer, locates the
OP_RETURN payload, parses the QPET envelope, verifies the pinned envelope and
sheet hashes, and—for Miner One—verifies the exact recipient output index,
address, amount, and script. Only then does it create a temporary browser
`blob:` URL from the recovered WebP bytes. The favicon and social card are
static derivatives; the animated mascots are not.

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
`--datadir`, `--rpc-port`, or `--wallet` only when your node setup needs them.

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
install -d -m 700 ~/.local/state/qpet

python3 qpet.py \
  --cli /path/to/qbit-cli \
  --datadir /path/to/qbit/datadir \
  --chain main \
  --wallet your-wallet \
  inscribe \
  --manifest assets/qbit/pet.json \
  --sheet assets/qbit/spritesheet.webp \
  --fee-rate 1 \
  --dry-run \
  --out-signed ~/.local/state/qpet/qpet.signed.hex

python3 qpet.py \
  --cli /path/to/qbit-cli \
  --datadir /path/to/qbit/datadir \
  --chain main \
  broadcast \
  --signed ~/.local/state/qpet/qpet.signed.hex \
  --expected-txid 64_HEX_TXID_FROM_DRY_RUN \
  --expected-envelope-sha256 e9a9ce232eeee3657e87053edf27b0b1f5493c9111d9a37c41fc5cdb85a24247 \
  --expected-pet-id qbit \
  --qpet-only
```

`--out-signed` is required. It exclusively creates a private mode-`0600` file and refuses to
overwrite an existing path before contacting the node. The dry run funds and
signs once, decodes the exact signed bytes, verifies the QPET at output zero,
and runs `testmempoolaccept` without broadcasting. Review its transaction ID,
output index, hashes, lengths, fee, and virtual size. Then use `broadcast` to
validate and send those saved bytes without funding or signing again. Replace
`64_HEX_TXID_FROM_DRY_RUN` with the exact transaction ID printed by the dry
run. The broadcast command will refuse a different transaction, envelope, pet
ID, or output arrangement. This is
important for stateful PQC signatures: do not repeat `inscribe` merely to send
a transaction you already saved. Keep the signed file in durable private
storage until the transaction is confirmed; do not use an ephemeral directory.
The wallet's funded-input lock is memory-only, so keep the node running and do
not spend from that wallet between signing and immediate broadcast. If any
post-funding step fails, stop and inspect the saved file and locked input; do
not unlock, restart, or re-sign reflexively.

To bind an honorary inscription to a recipient, pass the same exact address and
amount while preparing and broadcasting. The helper validates the address on
the selected chain and refuses unless the signed transaction keeps the QPET at
output zero, the recipient at output one, and deterministic change after both:

The Miner One mainnet mint used this recipient-bound shape:

```bash
python3 qpet.py --chain main ... inscribe ... \
  --recipient qb1z8q6dsf8sla7vcn2gzxnspuzpshzrkkk80c2a67xdpea2yxkpsm4qmzhake \
  --recipient-amount 0.00010000 \
  --dry-run \
  --out-signed ~/.local/state/qpet/honorary.signed.hex

python3 qpet.py --chain main ... broadcast \
  --signed ~/.local/state/qpet/honorary.signed.hex \
  --expected-txid 53dd2d8982bea1dd1676f6506a497a31c14a81aad21639d019e3658150f231af \
  --expected-envelope-sha256 ca2a0c0d16aeb3b370592521d6c02ee181684028683fe3602f214322b43d05e5 \
  --expected-pet-id miner-one \
  --recipient qb1z8q6dsf8sla7vcn2gzxnspuzpshzrkkk80c2a67xdpea2yxkpsm4qmzhake \
  --recipient-amount 0.00010000
```

Both direct `inscribe` broadcasts and `broadcast --signed` ask you to type
`broadcast`. Non-interactive automation must pass `--yes` explicitly; without
it, the command refuses before any RPC call.

## Contributing and reuse

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the local
checks and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

The repository is MIT licensed. Mascot terms are documented in
[ASSET_LICENSE.md](ASSET_LICENSE.md), and the Codex Pet Share animation-table
attribution is preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
