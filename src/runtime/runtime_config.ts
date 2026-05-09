/**
 * Environment-backed runtime configuration for local validation and scenario
 * admission. This file intentionally avoids server, storage, and deployment
 * concerns reserved for later PIT steps.
 */

import { isRuntimeMode, type RuntimeMode, type RuntimeProcessRole } from "./runtime_modes";

export const RUNTIME_CONFIG_SCHEMA_VERSION = "mebsuta.runtime_config.v1" as const;

export interface RuntimeEnvironment {
  readonly [name: string]: string | undefined;
}

export interface RuntimeConfig {
  readonly schema_version: typeof RUNTIME_CONFIG_SCHEMA_VERSION;
  readonly runtime_ref: string;
  readonly mode: RuntimeMode;
  readonly process_role: RuntimeProcessRole;
  readonly started_by: string;
  readonly local_validation: boolean;
  readonly readiness_timeout_ms: number;
  readonly graceful_shutdown_timeout_ms: number;
  readonly admission_requires_ready_runtime: boolean;
  readonly admission_requires_normal_safety: boolean;
  readonly admission_requires_safe_hold_clear: boolean;
}

export interface RuntimeConfigResult {
  readonly config?: RuntimeConfig;
  readonly issues: readonly string[];
}

export function loadRuntimeConfig(env: RuntimeEnvironment, argv: readonly string[] = []): RuntimeConfigResult {
  const issues: string[] = [];
  const modeCandidate = optionValue(argv, "--mode") ?? env.MEBSUTA_RUNTIME_MODE ?? "local_validation";
  const processRole = optionValue(argv, "--process-role") ?? env.MEBSUTA_PROCESS_ROLE ?? "composition_root";
  const runtimeRef = optionValue(argv, "--runtime-ref") ?? env.MEBSUTA_RUNTIME_REF ?? "runtime:local-validation";

  if (!isRuntimeMode(modeCandidate)) {
    issues.push(`Unsupported runtime mode: ${modeCandidate}.`);
  }
  if (!["composition_root", "scenario_admission", "health_readiness"].includes(processRole)) {
    issues.push(`Unsupported process role: ${processRole}.`);
  }
  if (!isSafeRef(runtimeRef)) {
    issues.push("Runtime ref must be non-empty, whitespace-free, and boundary-safe.");
  }

  const readinessTimeoutMs = numberFrom(env.MEBSUTA_READINESS_TIMEOUT_MS, 5_000, "MEBSUTA_READINESS_TIMEOUT_MS", issues);
  const shutdownTimeoutMs = numberFrom(env.MEBSUTA_GRACEFUL_SHUTDOWN_TIMEOUT_MS, 3_000, "MEBSUTA_GRACEFUL_SHUTDOWN_TIMEOUT_MS", issues);

  if (issues.length > 0) {
    return Object.freeze({ issues });
  }

  const config: RuntimeConfig = Object.freeze({
    schema_version: RUNTIME_CONFIG_SCHEMA_VERSION,
    runtime_ref: runtimeRef,
    mode: modeCandidate as RuntimeMode,
    process_role: processRole as RuntimeProcessRole,
    started_by: sanitizeStartedBy(env.USERNAME ?? env.USER ?? "local_operator"),
    local_validation: argv.includes("--validation") || env.MEBSUTA_LOCAL_VALIDATION === "1" || modeCandidate === "local_validation",
    readiness_timeout_ms: readinessTimeoutMs,
    graceful_shutdown_timeout_ms: shutdownTimeoutMs,
    admission_requires_ready_runtime: true,
    admission_requires_normal_safety: true,
    admission_requires_safe_hold_clear: true,
  });
  return Object.freeze({ config, issues: Object.freeze([]) });
}

export function redactRuntimeConfig(config: RuntimeConfig): Omit<RuntimeConfig, "started_by"> & { readonly started_by: "redacted" } {
  return Object.freeze({ ...config, started_by: "redacted" as const });
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function numberFrom(value: string | undefined, fallback: number, name: string, issues: string[]): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    issues.push(`${name} must be a positive finite number.`);
    return fallback;
  }
  return Math.trunc(parsed);
}

function isSafeRef(ref: string): boolean {
  return ref.trim().length > 0 && !/\s/.test(ref) && !/(ground_truth|qa_|scene_graph|backend|hidden)/i.test(ref);
}

function sanitizeStartedBy(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 80) || "local_operator";
}

