# Qbit, permanently committed

A client-only viewer for the QPET inscription in Qbit mainnet block 53,026.

The page fetches transaction
`852748890119300166f0c3050da3fee5c55316d199bcff1425424c009d2e62b9`
from the public Qbit explorer, extracts the QPET v1 OP_RETURN envelope, verifies
the envelope and spritesheet SHA-256 hashes, and animates the recovered WebP.
The animation sheet is not bundled with the site.

The explorer supplies transaction and confirmation data; pinned hashes prevent
different mascot bytes from being substituted. This is a client-only explorer
verification path, not an independent full-node or SPV proof.

The deployed page links back to the public source at
<https://github.com/djh58/qbit-onchain-pet>.

```bash
npm install
npm run dev
npm test
```
