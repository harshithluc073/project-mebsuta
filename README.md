# Project Mebsuta

Project Mebsuta is an embodied AI robotics runtime concept: a system design for an agent that reasons from simulated sensor evidence, proposes high-level plans, validates those plans through deterministic safety and feasibility gates, executes motion through conventional control layers, and verifies task success from embodied observations.

The core idea is simple: the agent should not be an all-knowing simulator god. It should perceive through virtual cameras, microphones, proprioception, contact signals, and memory, then act through validated robotics-style execution paths.

## What It Is

Project Mebsuta explores a hybrid architecture for embodied intelligence:

- A simulated world provides physics, objects, contacts, rendering, and audio events.
- A virtual hardware layer turns simulation state into embodied sensor packets.
- An information firewall prevents hidden simulator truth from reaching cognition.
- A cognitive layer proposes plans from task instructions, observations, memory, and constraints.
- Validators check schema, safety, reachability, embodiment limits, provenance, and task scope.
- Deterministic control layers handle motion primitives, trajectories, IK-style feasibility, PD-style tracking, and execution monitoring.
- Verification modules decide whether a task succeeded using sensor-grounded evidence.
- An Oops Loop gathers failure evidence, asks for correction, validates the correction, and retries within budget.
- Memory modules preserve episodic and spatial observations with confidence, staleness, and contradiction handling.
- Observability modules make runtime decisions inspectable through events, traces, redaction, replay, and monologue-style summaries.

In short: Mebsuta is a source foundation for experimenting with how an embodied AI system can reason, act, verify, correct itself, and remain auditable without exposing hidden ground truth to the reasoning layer.

## What It Does

The repository contains TypeScript source contracts and implementation foundations for:

- Simulation and physics-facing services.
- Virtual hardware and sensor buses.
- Embodiment, kinematics, reach, contact, and actuator boundaries.
- Cognitive request routing and structured response handling.
- Prompt and information-firewall contracts.
- Orchestration state machines.
- Spatial reasoning and coordinate-frame utilities.
- Deterministic control and manipulation primitives.
- Verification certificates and success/failure evaluation.
- Oops Loop correction workflows.
- Memory, retrieval, staleness, and provenance handling.
- Acoustic event interpretation and audio reasoning surfaces.
- Safety policies, safe-hold states, and validation gates.
- API/server boundary contracts.
- Observability, replay, redaction, and telemetry surfaces.
- QA, benchmark, release, operations, performance, and risk foundations.

The code is organized as a local source foundation. It is meant to be read, tested, typechecked, and extended locally.

## Core Concept

Project Mebsuta is built around five major ideas.

### 1. Embodied Realism

The reasoning layer should only receive information the agent could plausibly observe or remember. Backend object IDs, hidden coordinates, scene graphs, QA labels, and ground-truth success flags must stay outside cognitive-facing contracts.

### 2. High-Level Cognition, Deterministic Execution

The cognitive layer can propose intent, plans, risks, observations, and corrections. It does not directly actuate the agent. Execution is routed through validators, motion primitives, control services, and safety monitors.

### 3. No Reinforcement-Learning Control Dependency

The architecture is centered on explicit contracts, validation, planning, IK/trajectory/PD-style deterministic control, verification, and correction loops rather than trained motor policies or reward-driven control.

### 4. Verification Before Trust

Task completion is not assumed from a plan. The system needs embodied evidence, spatial checks, residuals, ambiguity handling, and success certificates before declaring success.

### 5. Auditability And Safe Correction

The runtime is designed to preserve traces: prompts, validation decisions, memory writes, safety events, observations, failures, corrections, and verification evidence. When something fails, the Oops Loop uses evidence to propose a bounded correction instead of retrying blindly.

## Current Repository Status

This public repository is a local TypeScript source release.

It includes:

- Source foundations under `src`.
- Focused tests under `tests`.
- Local build, scan, and verification tooling.
- MIT license.

The local release is intended for source review, TypeScript validation, tests, build checks, and safety/security scans. It does not currently expose a top-level command that starts a finished interactive browser app, hosted API server, production database, or public authentication product.

It does not include:

- Internal planning documents.
- Internal trackers.
- Production-readiness documents.
- Generated build output.
- Dependency folders.
- Local environment files.
- Hosted deployment configuration.
- Paid CI/CD configuration.

## Important Boundary

This repository is not currently:

- A hosted production product.
- A deployed browser application.
- A deployed backend API.
- A production database system.
- A complete public login/authentication product.
- A cloud deployment template.
- A live robotics controller.
- A turnkey production SaaS deployment.

It is a local source foundation for the architecture and contracts behind those kinds of systems.

## Requirements

- Node.js `24.11.0` or compatible with `>=24.11.0 <26`
- npm `>=11.0.0`
- Package manager target: `npm@11.6.2`

The repository includes `.node-version`, `.nvmrc`, and `package-lock.json` to make local setup predictable.

## Install

Install dependencies from the checked-in lockfile:

```bash
npm ci
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

## Available Scripts

- `npm run clean` removes generated local build output.
- `npm run typecheck` runs the source TypeScript check.
- `npm run build` cleans, compiles source, and writes local build metadata.
- `npm run lint` runs ESLint.
- `npm run format:check` checks formatting.
- `npm run format` writes formatting changes.
- `npm run test` runs the Vitest suite.
- `npm run test:unit` runs unit tests.
- `npm run test:contracts` runs contract tests.
- `npm run test:boundary` runs boundary tests.
- `npm run test:security` runs security tests.
- `npm run test:safety` runs safety tests.
- `npm run coverage` runs coverage locally.
- `npm run audit:dependencies` runs an npm high-severity dependency audit.
- `npm run scan:secrets` scans for secret-like content.
- `npm run scan:placeholders` scans for placeholder markers.
- `npm run verify:tooling` runs the main local verification chain.

## Project Structure

```text
src/                 TypeScript source foundations and contracts
tests/               Focused local verification tests
scripts/tooling/     Local build, scan, and cleanup tooling
package.json         npm scripts and project metadata
package-lock.json    Locked dependency graph
```

## Local-Only Setup

Baseline verification does not require:

- A paid hosting account.
- A domain name.
- A production database.
- A cloud account.
- A third-party auth provider.
- A paid observability service.
- Paid CI/CD.
- A model-provider API key.
- A deployed frontend or backend.

Generated or local-only artifacts such as `node_modules`, `dist`, `coverage`, logs, temporary folders, `.env` files, and local caches must stay out of Git.

## Security

Do not commit secrets, tokens, credentials, `.env` files, generated artifacts, logs, dependency folders, or local machine output. Baseline local verification should not require real service credentials.

Use the built-in secret scan before publishing changes:

```bash
npm run scan:secrets
```

## License

MIT License. See `LICENSE`.
