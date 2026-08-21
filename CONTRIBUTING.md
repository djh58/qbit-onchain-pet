# Contributing

Small fixes, decoder hardening, documentation improvements, and experiments
inspired by QPET are welcome.

For a non-trivial change, open an issue first so the approach can be discussed.
Fork the repository, work on a focused branch, and submit a pull request against
`main`.

## Local checks

Use Python 3.11 or newer and Node.js 22.13 or newer.

```bash
python3 -m unittest discover -s tests -v

cd site
npm ci
npm run lint
npm test
npm audit
```

Never commit wallet files, seed phrases, private keys, RPC credentials, `.env`
files, or deployment tokens. The included transaction ID and content hashes are
public chain identifiers, not secrets.

By contributing, you agree that your contribution is licensed under the MIT
license. See `THIRD_PARTY_NOTICES.md` and `ASSET_LICENSE.md` for provenance and
asset terms.

Please report vulnerabilities privately as described in `SECURITY.md`.
