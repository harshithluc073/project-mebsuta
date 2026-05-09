# Project Mebsuta

Project Mebsuta is a local TypeScript source foundation for embodied runtime contracts, safety boundaries, verification flows, memory/state handling, observability, release evidence, and related test surfaces.

This repository is an open-source source release. It is designed to install, build, scan, and verify locally.

## Status

Current public release status:

- Local TypeScript source foundation.
- Local test and verification tooling.
- MIT licensed.
- No paid services required for baseline local verification.
- Not a hosted production product.
- Not a deployed frontend application.
- Not a deployed backend API.
- Not a production database system.
- Not a complete public authentication product.

The repository contains implementation foundations and contracts under `src`, plus focused tests under `tests`. It does not include private planning documents, internal trackers, production-readiness documents, generated build output, dependency folders, or local environment files.

## Requirements

- Node.js `24.11.0` or compatible with `>=24.11.0 <26`
- npm `>=11.0.0`

The repository includes `.node-version`, `.nvmrc`, and `package-lock.json` to make local setup predictable.

## Install

```bash
npm install
```

## Verify Locally

Run the full local verification suite:

```bash
npm run verify:tooling
```

Useful individual checks:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run scan:secrets
npm run scan:placeholders
```

## Project Structure

```text
src/                 TypeScript source foundations and contracts
tests/               Focused local verification tests
scripts/tooling/     Local build, scan, and cleanup tooling
package.json         npm scripts and project metadata
package-lock.json    Locked dependency graph
```

## Local-Only Boundary

Baseline verification does not require:

- A paid hosting account.
- A domain name.
- A production database.
- A cloud account.
- A third-party auth provider.
- A paid observability service.
- A model-provider API key.
- A deployed frontend or backend.

## Security

Do not commit secrets, tokens, credentials, `.env` files, generated artifacts, logs, dependency folders, or local machine output. Use the built-in secret scan before publishing changes:

```bash
npm run scan:secrets
```

## License

MIT License. See `LICENSE`.
