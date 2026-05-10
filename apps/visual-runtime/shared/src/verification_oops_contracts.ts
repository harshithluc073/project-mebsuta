import { VisualRuntimeExecutionGateRun } from "./execution_gate_contracts";

export type VisualRuntimeVerificationOutcome = "success" | "failed";

export interface VisualRuntimeEvidenceSummary {
  readonly id: string;
  readonly source: "visible_execution" | "safe_hold_gate" | "allowed_observation";
  readonly summary: string;
  readonly hiddenSimulatorTruthExposed: false;
}

export interface VisualRuntimeFailureSummary {
  readonly code: "none" | "safe_hold";
  readonly message: string;
}

export interface VisualRuntimeCorrectionProposal {
  readonly proposalId: string;
  readonly status: "not_needed" | "proposed";
  readonly action: string;
  readonly autoCorrectionAllowed: false;
}

export interface VisualRuntimeOopsLoopState {
  readonly retryBudgetMax: 2;
  readonly retryAttemptsUsed: number;
  readonly retryBudgetRemaining: number;
  readonly boundedRetryAllowed: boolean;
  readonly manualStopAvailable: true;
  readonly safeHoldAvailable: true;
  readonly safeHoldActive: boolean;
  readonly correctionProposal: VisualRuntimeCorrectionProposal;
}

export interface VisualRuntimeVerificationOopsRun {
  readonly runId: string;
  readonly sourceRun: VisualRuntimeExecutionGateRun;
  readonly outcome: VisualRuntimeVerificationOutcome;
  readonly certificateId: string;
  readonly evidence: readonly VisualRuntimeEvidenceSummary[];
  readonly failure: VisualRuntimeFailureSummary;
  readonly oopsLoop: VisualRuntimeOopsLoopState;
  readonly browserReceivesProviderKey: false;
}
