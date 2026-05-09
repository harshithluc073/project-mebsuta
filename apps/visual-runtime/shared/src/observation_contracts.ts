import { VisualRuntimeDemoTask } from "./demo_contracts";

export type VisualRuntimeObservationChannel =
  | "visual_summary"
  | "proprioception"
  | "contact"
  | "audio"
  | "task_context"
  | "memory_snippet";

export interface VisualRuntimeAllowedObservation {
  readonly channel: VisualRuntimeObservationChannel;
  readonly label: string;
  readonly value: string;
}

export interface VisualRuntimeObservationBoundary {
  readonly allowedChannels: readonly VisualRuntimeObservationChannel[];
  readonly redactedFields: readonly string[];
  readonly hiddenSimulatorTruthExposed: false;
  readonly backendOnlyObjectIdsExposed: false;
  readonly groundTruthSuccessLabelExposed: false;
}

export interface VisualRuntimeSensorPacket {
  readonly packetId: string;
  readonly task: Pick<VisualRuntimeDemoTask, "id" | "label" | "operatorText">;
  readonly observations: readonly VisualRuntimeAllowedObservation[];
  readonly boundary: VisualRuntimeObservationBoundary;
  readonly browserReceivesProviderKey: false;
}
