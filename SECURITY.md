# Security policy

Security fixes are applied to the current `main` branch.

Please do not open a public issue for a vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/djh58/qbit-onchain-pet/security/advisories/new)
and include the affected file, reproduction steps, impact, and a suggested fix
when possible.

The hosted viewer never needs wallet access, node RPC credentials, or private
keys. Do not send any of those values in a report.

QPET manifests and transaction data are untrusted input. Reports involving the
decoder, generated HTML viewer, public explorer boundary, content verification,
or inscription safety are especially useful.
