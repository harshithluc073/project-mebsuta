import { createVisualRuntimeDemoRun } from "./demo_runtime";
import { getVisualRuntimeDemoTask } from "../../shared/src/demo_contracts";
import {
  VisualRuntimeAllowedObservation,
  VisualRuntimeObservationBoundary,
  VisualRuntimeSensorPacket,
} from "../../shared/src/observation_contracts";
import { VisualRuntimeWorldObject, VisualRuntimeWorldSnapshot } from "../../shared/src/world_contracts";

interface ObservationFirewallOptions {
  readonly taskId?: string;
  readonly now?: () => string;
}

const boundary: VisualRuntimeObservationBoundary = {
  allowedChannels: [
    "visual_summary",
    "proprioception",
    "contact",
    "audio",
    "task_context",
    "memory_snippet",
  ],
  redactedFields: [
    "worldSnapshot.hiddenSimulatorTruthExposed",
    "worldSnapshot.objects[].id",
    "worldSnapshot.targetZones[].id",
    "verification.result",
    "provider.rawOutput",
    "provider.credential",
  ],
  hiddenSimulatorTruthExposed: false,
  backendOnlyObjectIdsExposed: false,
  groundTruthSuccessLabelExposed: false,
};

const describeObject = (object: VisualRuntimeWorldObject): string =>
  `${object.label} visible as ${object.kind.replace("_", " ")}`;

const createVisualSummary = (snapshot: VisualRuntimeWorldSnapshot): string => {
  const objects = snapshot.objects.map(describeObject).join("; ");
  const zones = snapshot.targetZones.map((zone) => `${zone.label} visible`).join("; ");
  return `Robot is in the local work cell. Objects: ${objects}. Zones: ${zones}.`;
};

const createProprioception = (snapshot: VisualRuntimeWorldSnapshot): string =>
  `Robot pose summary: heading ${snapshot.robot.headingRadians.toFixed(2)} rad, gait phase ${snapshot.robot.gaitPhase.toFixed(1)}.`;

const createContactSummary = (snapshot: VisualRuntimeWorldSnapshot): string => {
  const finalPathPoint = snapshot.activityPath[snapshot.activityPath.length - 1];
  if (!finalPathPoint) {
    return "No visible route contact point is active.";
  }

  return `Visible route endpoint reached near x:${finalPathPoint.x.toFixed(1)}, z:${finalPathPoint.z.toFixed(1)}.`;
};

const createObservations = (
  snapshot: VisualRuntimeWorldSnapshot,
  taskText: string,
): readonly VisualRuntimeAllowedObservation[] => [
  {
    channel: "visual_summary",
    label: "Visible scene",
    value: createVisualSummary(snapshot),
  },
  {
    channel: "proprioception",
    label: "Robot body",
    value: createProprioception(snapshot),
  },
  {
    channel: "contact",
    label: "Contact",
    value: createContactSummary(snapshot),
  },
  {
    channel: "audio",
    label: "Audio",
    value: "No local audio event detected in the current demo run.",
  },
  {
    channel: "task_context",
    label: "Task",
    value: taskText,
  },
  {
    channel: "memory_snippet",
    label: "Memory",
    value: "Prior local demo route stayed inside the visible work cell.",
  },
];

export const createVisualRuntimeSensorPacket = (
  options: ObservationFirewallOptions = {},
): VisualRuntimeSensorPacket => {
  const task = getVisualRuntimeDemoTask(options.taskId);
  const demoRun = createVisualRuntimeDemoRun({
    taskId: task.id,
    now: options.now,
  });

  return {
    packetId: `vr-08-sensor-packet-${task.id}`,
    task: {
      id: task.id,
      label: task.label,
      operatorText: task.operatorText,
    },
    observations: createObservations(demoRun.worldSnapshot, task.operatorText),
    boundary,
    browserReceivesProviderKey: false,
  };
};
