import {
  VisualRuntimeDemoRunSnapshot,
  VisualRuntimeDemoTask,
  VisualRuntimePlanStep,
  VisualRuntimeTelemetryEvent,
  VisualRuntimeValidationGate,
} from "./demo_contracts";

export type VisualRuntimeProviderPlanningMode = "demo_ready" | "provider_ready";

export type VisualRuntimeProviderPlanningSource =
  | "deterministic_demo_fallback"
  | "provider_structured_plan"
  | "provider_response_quarantined";

export interface VisualRuntimeProviderPlanningRequest {
  readonly schemaVersion: "vr-07-provider-plan-v1";
  readonly task: VisualRuntimeDemoTask;
  readonly allowedObservationSummary: readonly string[];
  readonly browserReceivesProviderKey: false;
}

export interface VisualRuntimeProviderPlanCandidate {
  readonly steps: readonly {
    readonly kind: string;
    readonly label: string;
  }[];
}

export interface VisualRuntimeProviderPlanMetadata {
  readonly provider: string;
  readonly model?: string;
  readonly baseUrlConfigured: boolean;
  readonly credentialExposed: false;
}

export interface VisualRuntimeProviderQuarantine {
  readonly reason: string;
  readonly redactedError: string;
  readonly providerRawOutputStored: false;
}

export type VisualRuntimeProviderPlanningResult =
  | {
      readonly mode: "demo_ready";
      readonly source: "deterministic_demo_fallback";
      readonly providerAttempted: false;
      readonly demoRun: VisualRuntimeDemoRunSnapshot;
      readonly browserReceivesProviderKey: false;
    }
  | {
      readonly mode: "provider_ready";
      readonly source: "provider_structured_plan";
      readonly providerAttempted: true;
      readonly request: VisualRuntimeProviderPlanningRequest;
      readonly provider: VisualRuntimeProviderPlanMetadata;
      readonly plan: readonly VisualRuntimePlanStep[];
      readonly validation: readonly VisualRuntimeValidationGate[];
      readonly telemetry: readonly VisualRuntimeTelemetryEvent[];
      readonly browserReceivesProviderKey: false;
    }
  | {
      readonly mode: "provider_ready";
      readonly source: "provider_response_quarantined";
      readonly providerAttempted: true;
      readonly request: VisualRuntimeProviderPlanningRequest;
      readonly provider: VisualRuntimeProviderPlanMetadata;
      readonly quarantine: VisualRuntimeProviderQuarantine;
      readonly demoRun: VisualRuntimeDemoRunSnapshot;
      readonly browserReceivesProviderKey: false;
    };
