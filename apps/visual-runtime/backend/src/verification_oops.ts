import { VisualRuntimePlanStep } from "../../shared/src/demo_contracts";
import { VisualRuntimeVerificationOopsRun } from "../../shared/src/verification_oops_contracts";
import { createVisualRuntimeExecutionGateRun } from "./execution_gate";

interface VerificationOopsOptions {
  readonly taskId?: string;
  readonly now?: () => string;
  readonly retryAttemptsUsed?: number;
  readonly planOverride?: readonly VisualRuntimePlanStep[];
}

const RETRY_BUDGET_MAX = 2;

const clampRetryAttempts = (attempts: number | undefined): number => {
  if (attempts === undefined || Number.isNaN(attempts)) {
    return 0;
  }

  return Math.max(0, Math.min(RETRY_BUDGET_MAX, Math.floor(attempts)));
};

export const createVisualRuntimeVerificationOopsRun = (
  options: VerificationOopsOptions = {},
): VisualRuntimeVerificationOopsRun => {
  const sourceRun = createVisualRuntimeExecutionGateRun({
    taskId: options.taskId,
    now: options.now,
    planOverride: options.planOverride,
  });
  const retryAttemptsUsed = clampRetryAttempts(options.retryAttemptsUsed);
  const retryBudgetRemaining = RETRY_BUDGET_MAX - retryAttemptsUsed;
  const success = sourceRun.gateDecision.status === "accepted";
  const certificateId = success
    ? `vr-10-success-${sourceRun.task.id}-certificate`
    : `vr-10-failure-${sourceRun.task.id}-certificate`;

  return {
    runId: `vr-10-verification-oops-${sourceRun.task.id}`,
    sourceRun,
    outcome: success ? "success" : "failed",
    certificateId,
    evidence: success
      ? [
          {
            id: "E1",
            source: "visible_execution",
            summary: `Visible route completed with ${sourceRun.executionPath.length} route points.`,
            hiddenSimulatorTruthExposed: false,
          },
          {
            id: "E2",
            source: "allowed_observation",
            summary: "Verification used allowed visual evidence and gate telemetry only.",
            hiddenSimulatorTruthExposed: false,
          },
        ]
      : [
          {
            id: "E1",
            source: "safe_hold_gate",
            summary: sourceRun.gateDecision.summary,
            hiddenSimulatorTruthExposed: false,
          },
          {
            id: "E2",
            source: "allowed_observation",
            summary: "Failure evidence is limited to validation gates and safe-hold telemetry.",
            hiddenSimulatorTruthExposed: false,
          },
        ],
    failure: success
      ? {
          code: "none",
          message: "No failure detected from allowed visual execution evidence.",
        }
      : {
          code: "safe_hold",
          message: `Execution did not start because ${sourceRun.gateDecision.blockReason} entered safe hold.`,
        },
    oopsLoop: {
      retryBudgetMax: RETRY_BUDGET_MAX,
      retryAttemptsUsed,
      retryBudgetRemaining,
      boundedRetryAllowed: !success && retryBudgetRemaining > 0,
      manualStopAvailable: true,
      safeHoldAvailable: true,
      safeHoldActive: !success,
      correctionProposal: success
        ? {
            proposalId: `vr-10-no-correction-${sourceRun.task.id}`,
            status: "not_needed",
            action: "No correction proposed after successful allowed-evidence verification.",
            autoCorrectionAllowed: false,
          }
        : {
            proposalId: `vr-10-correction-${sourceRun.task.id}`,
            status: "proposed",
            action: "Keep robot in safe hold, preserve current observation boundary, and request one bounded retry after operator review.",
            autoCorrectionAllowed: false,
          },
    },
    browserReceivesProviderKey: false,
  };
};
