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

This public repository is a local TypeScript source release with a runnable local visual runtime app.

It includes:

- Source foundations under `src`.
- A local visual runtime under `apps/visual-runtime` with a browser frontend, local Node backend, deterministic demo mode, Three.js robot/world viewer, provider-readiness boundary, validation/execution/verification panels, replay and observability surfaces.
- Focused tests under `tests`.
- Local build, scan, and verification tooling.
- MIT license.

The local release is intended for source review, TypeScript validation, tests, build checks, safety/security scans, and local browser runtime experimentation. It now exposes local development commands for the visual runtime. It is still not a hosted production product, production database, public authentication product, physical robot controller, or turnkey deployment.

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

Run the visual runtime verification chain:

```bash
npm run verify:visual-runtime
```

That command typechecks the visual runtime, runs the visual runtime test suite, builds the local frontend, and runs the visual runtime scaffold verification script.

## Run The Local Visual Runtime

The visual runtime is local-first and runs with two local processes:

```bash
npm run dev:visual-runtime:backend
```

The backend listens on `http://127.0.0.1:4178`.

In a second terminal:

```bash
npm run dev:visual-runtime:frontend
```

The frontend listens on `http://127.0.0.1:5178` and proxies `/api` requests to the local backend.

Open `http://127.0.0.1:5178` in a browser. Demo mode requires no `.env` file and no model-provider API key. The UI currently exposes:

- A local operational dashboard, not a marketing page.
- A Three.js dog robot/world viewer built for the visual runtime.
- Preset deterministic demo tasks.
- Provider readiness status without exposing credentials to the browser.
- Plan, validation, gate decision, execution, verification, event trace, observation-boundary, replay, memory, audit stream, and Oops Loop surfaces.
- Manual hold, reset, retry, stop, and safe-hold controls for the local demo workflow.

The visual runtime is still local software. It is not hosted, not production deployed, not connected to a production database, not a public login system, and not a physical robot readiness claim.

## Final Local Visual Runtime Handoff

Current local handoff status:

- Install: `npm ci`
- Full verification: `npm run verify:tooling`
- Visual runtime verification: `npm run verify:visual-runtime`
- Backend: `npm run dev:visual-runtime:backend`
- Frontend: `npm run dev:visual-runtime:frontend`
- Browser URL: `http://127.0.0.1:5178`

Confirmed local behavior:

- Demo mode runs without `.env` and without a model-provider API key.
- The backend serves local health, runtime status, provider status, demo, execution, verification, observation, planning, and observability/audit endpoints.
- The frontend loads through Vite, proxies `/api` to the local backend, and keeps provider credentials outside browser-facing source and responses.
- The visual runtime includes automated checks for backend start, frontend start, browser app load, demo task flow, event/audit stream behavior, visual render evidence hooks, and no provider-key leak.

Remaining future work is outside this local handoff: hosted deployment, production database, public authentication, paid CI/CD, physical robot integration, external model-provider account setup, and production operations are not part of this repository's current local runtime claim.

## Optional Backend-Only Provider Configuration

The visual runtime works without provider credentials. Optional provider configuration is read by the backend process environment only. The browser must never receive, display, store, log, or bundle the raw provider key.

Safe variable names are documented in `.env.example`:

- `LLM_PROVIDER`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_BASE_URL`
- `MEBSUTA_DEMO_MODE`

Supported provider names in the current local source are `openai`, `gemini`, `anthropic`, and `local_compatible`. Set `MEBSUTA_DEMO_MODE` to `forced` or `true` to keep demo mode active even if provider variables exist.

Do not commit `.env`, provider keys, raw provider logs, private runtime recordings, or local config files. Demo mode does not require paid services. If you choose to use an external model provider, any provider account or billing is outside the local demo requirement.

## Available Scripts

- `npm run clean` removes generated local build output.
- `npm run typecheck` runs the source TypeScript check.
- `npm run typecheck:visual-runtime` runs the visual runtime TypeScript check.
- `npm run build` cleans, compiles source, and writes local build metadata.
- `npm run build:visual-runtime:frontend` builds the local visual runtime frontend.
- `npm run dev:visual-runtime:backend` starts the local visual runtime backend on `127.0.0.1:4178`.
- `npm run dev:visual-runtime:frontend` starts the local visual runtime frontend on `127.0.0.1:5178`.
- `npm run verify:visual-runtime` verifies the local visual runtime typecheck, tests, frontend build, and scaffold checks.
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
apps/visual-runtime/  Local visual runtime frontend, backend, shared contracts, and viewer source
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

The visual runtime demo also runs without a model-provider key. Generated or local-only artifacts such as `node_modules`, `dist`, `coverage`, logs, temporary folders, `.env` files, and local caches must stay out of Git.

## Contributions

Public contributions are not required for the current local source-release baseline. Issues and pull requests can be reviewed when they preserve the local-only scope, avoid secrets, and pass local verification.

Contribution governance files such as `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `CHANGELOG.md` are not part of the current mandatory public file set.

## Security

Do not commit secrets, tokens, credentials, `.env` files, generated artifacts, logs, dependency folders, or local machine output. Baseline local verification should not require real service credentials.

Use the built-in secret scan before publishing changes:

```bash
npm run scan:secrets
```

## License

MIT License. See `LICENSE`.
