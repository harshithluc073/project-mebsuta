# Security Policy

Project Mebsuta is a local-only TypeScript source release. It is not a hosted production service, not a deployed backend API, not a production database, and not a complete public authentication product.

## Supported Versions

Security review applies to the current `main` branch and the `0.1.x` source-release line.

Older local snapshots, private workspaces, generated build output, dependency folders, and unreviewed internal planning files are not supported public security surfaces.

## Reporting Vulnerabilities

Do not post exploit details, proof-of-concept payloads, credentials, private keys, tokens, or sensitive reproduction data in public GitHub issues.

Use GitHub private vulnerability reporting for this repository if it is enabled. If private vulnerability reporting is not enabled, open a minimal public issue that says a security report is available, without including exploit details, secrets, or sensitive logs. Wait for a maintainer-approved private reporting path before sharing details.

This policy intentionally does not publish private personal contact details.

## Secret Handling

Never commit:

- Secrets.
- API keys.
- Model-provider keys.
- GitHub tokens.
- OAuth client secrets.
- Session secrets.
- JWT signing secrets.
- Database URLs with credentials.
- Passwords.
- Private keys.
- Service account credentials.
- Webhook secrets.
- `.env` or `.env.*` files.
- Logs.
- Generated build output.
- Coverage output.
- Dependency folders.
- Temporary folders.
- Local machine output.

The repository ignore rules keep local-only and generated artifacts out of Git, including `node_modules`, `dist`, `coverage`, `.vitest`, logs, `.env` files, `tmp`, and `temp`.

## Local Verification

Baseline local verification does not require paid services, paid hosting, a paid domain, a paid database, a paid auth provider, paid CI/CD, or real service credentials.

Run the local secret scan before publishing changes:

```bash
npm run scan:secrets
```

The secret scan is a guardrail, not a replacement for staged-file review. Before every public commit, inspect staged files and confirm that only intended public files are included.

## Security Scope

Security-relevant source in this repository includes policy, safety, auth, redaction, observability, runtime, verification, and release foundations. These are local source contracts and implementation foundations. They do not mean the repository is running a hosted production security operation.

Generated artifacts, local caches, local environment files, private reports, internal trackers, and planning documents are not public security evidence and should not be committed unless a later explicit public-review step approves them.
