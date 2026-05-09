/**
 * Runtime process roles and execution modes for the PIT-B02 composition root.
 */

export const RUNTIME_MODES = Object.freeze([
  "local_validation",
  "scenario_runner",
  "replay_validation",
  "qa_contract_validation",
] as const);

export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const RUNTIME_PROCESS_ROLES = Object.freeze([
  "composition_root",
  "scenario_admission",
  "health_readiness",
] as const);

export type RuntimeProcessRole = (typeof RUNTIME_PROCESS_ROLES)[number];

export function isRuntimeMode(value: string): value is RuntimeMode {
  return RUNTIME_MODES.includes(value as RuntimeMode);
}

