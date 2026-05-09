/**
 * Risk scoring model.
 *
 * Blueprint: `architecture_docs/22_RISK_REGISTER_AND_MITIGATION_ARCHITECTURE.md`
 * sections 22.3.2, 22.3.3, 22.6, 22.9.2, and 22.11.
 *
 * The model converts qualitative severity and likelihood into a deterministic
 * 1-25 score, then applies mitigation efficacy and detection confidence to
 * compute residual risk without hiding critical no-go conditions.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  RISK_BLUEPRINT_REF,
  RiskContractError,
  buildRiskValidationReport,
  freezeRiskArray,
  likelihoodWeight,
  makeRiskRef,
  riskIssue,
  riskRouteForIssues,
  severityWeight,
  validateRiskRatio,
  validateRiskRef,
} from "./risk_register_entry";
import type { RiskLikelihood, RiskSeverity, RiskValidationReport } from "./risk_register_entry";

export const RISK_SCORING_MODEL_SCHEMA_VERSION = "mebsuta.risk.risk_scoring_model.v1" as const;

export type RiskScoreBand = "low" | "medium" | "high" | "critical";

export interface RiskScoreInput {
  readonly score_ref: Ref;
  readonly risk_ref: Ref;
  readonly severity: RiskSeverity;
  readonly likelihood: RiskLikelihood;
  readonly mitigation_efficacy_ratio?: number;
  readonly detection_confidence_ratio?: number;
  readonly no_go_condition?: boolean;
}

export interface RiskScore {
  readonly schema_version: typeof RISK_SCORING_MODEL_SCHEMA_VERSION;
  readonly score_ref: Ref;
  readonly risk_ref: Ref;
  readonly severity: RiskSeverity;
  readonly likelihood: RiskLikelihood;
  readonly inherent_score: number;
  readonly mitigation_efficacy_ratio: number;
  readonly detection_confidence_ratio: number;
  readonly residual_score: number;
  readonly score_band: RiskScoreBand;
  readonly release_blocking: boolean;
  readonly determinism_hash: string;
}

/**
 * Scores a risk with deterministic arithmetic and validates the result.
 */
export function buildRiskScore(input: RiskScoreInput): RiskScore {
  const score = normalizeRiskScore(input);
  const report = validateRiskScore(score);
  if (!report.ok) {
    throw new RiskContractError("Risk score failed validation.", report.issues);
  }
  return score;
}

export function normalizeRiskScore(input: RiskScoreInput): RiskScore {
  const inherentScore = severityWeight(input.severity) * likelihoodWeight(input.likelihood);
  const mitigation = clampRatio(input.mitigation_efficacy_ratio ?? 0);
  const detection = clampRatio(input.detection_confidence_ratio ?? 0.5);
  const residualScore = round2(Math.max(1, inherentScore * (1 - mitigation * 0.7) * (1 - detection * 0.2)));
  const releaseBlocking = input.no_go_condition === true || input.severity === "critical" || residualScore >= 16;
  const base = {
    schema_version: RISK_SCORING_MODEL_SCHEMA_VERSION,
    score_ref: input.score_ref,
    risk_ref: input.risk_ref,
    severity: input.severity,
    likelihood: input.likelihood,
    inherent_score: inherentScore,
    mitigation_efficacy_ratio: mitigation,
    detection_confidence_ratio: detection,
    residual_score: residualScore,
    score_band: scoreBandForResidual(residualScore, input.severity),
    release_blocking: releaseBlocking,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function validateRiskScore(score: RiskScore): RiskValidationReport {
  const issues: ValidationIssue[] = [];
  validateRiskRef(score.score_ref, "$.score_ref", issues);
  validateRiskRef(score.risk_ref, "$.risk_ref", issues);
  validateRiskRatio(score.mitigation_efficacy_ratio, "$.mitigation_efficacy_ratio", issues);
  validateRiskRatio(score.detection_confidence_ratio, "$.detection_confidence_ratio", issues);
  if (!Number.isFinite(score.inherent_score) || score.inherent_score < 1 || score.inherent_score > 25) {
    issues.push(riskIssue("error", "RiskInherentScoreInvalid", "$.inherent_score", "Inherent risk score must be finite and within [1, 25].", "Recompute from severity and likelihood weights."));
  }
  if (!Number.isFinite(score.residual_score) || score.residual_score < 1 || score.residual_score > 25) {
    issues.push(riskIssue("error", "RiskResidualScoreInvalid", "$.residual_score", "Residual risk score must be finite and within [1, 25].", "Clamp the mitigation and detection ratios before scoring."));
  }
  if (score.severity === "critical" && score.release_blocking === false) {
    issues.push(riskIssue("error", "CriticalScoreNotBlocking", "$.release_blocking", "Critical scored risks must block release review until monitored or retired.", "Keep release_blocking true for critical risks."));
  }
  return buildRiskValidationReport(makeRiskRef("risk_score_report", score.score_ref), issues, riskRouteForIssues(issues));
}

export function scoreBandForResidual(residualScore: number, severity: RiskSeverity): RiskScoreBand {
  if (severity === "critical" || residualScore >= 16) {
    return "critical";
  }
  if (residualScore >= 10) {
    return "high";
  }
  if (residualScore >= 5) {
    return "medium";
  }
  return "low";
}

export function aggregateRiskScores(scores: readonly RiskScore[]): {
  readonly highest_residual_score: number;
  readonly release_blocking_count: number;
  readonly critical_count: number;
  readonly average_residual_score: number;
  readonly determinism_hash: string;
} {
  const highest = scores.reduce((max, score) => Math.max(max, score.residual_score), 0);
  const releaseBlocking = scores.filter((score) => score.release_blocking).length;
  const criticalCount = scores.filter((score) => score.score_band === "critical").length;
  const average = scores.length === 0 ? 0 : round2(scores.reduce((sum, score) => sum + score.residual_score, 0) / scores.length);
  const base = {
    highest_residual_score: highest,
    release_blocking_count: releaseBlocking,
    critical_count: criticalCount,
    average_residual_score: average,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export function scoreRisksFromRegister(
  risks: readonly { readonly risk_ref: Ref; readonly severity: RiskSeverity; readonly likelihood: RiskLikelihood; readonly no_go_condition: boolean }[],
  mitigationRatios: Readonly<Record<string, number>> = {},
  detectionRatios: Readonly<Record<string, number>> = {},
): readonly RiskScore[] {
  return freezeRiskArray(risks.map((risk) => buildRiskScore({
    score_ref: makeRiskRef("score", risk.risk_ref),
    risk_ref: risk.risk_ref,
    severity: risk.severity,
    likelihood: risk.likelihood,
    mitigation_efficacy_ratio: mitigationRatios[risk.risk_ref] ?? 0,
    detection_confidence_ratio: detectionRatios[risk.risk_ref] ?? 0.5,
    no_go_condition: risk.no_go_condition,
  })));
}

function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export const RISK_SCORING_MODEL_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: RISK_SCORING_MODEL_SCHEMA_VERSION,
  blueprint: RISK_BLUEPRINT_REF,
  sections: freezeRiskArray(["22.3.2", "22.3.3", "22.6", "22.9.2", "22.11"]),
  component: "RiskScoringModel",
});
