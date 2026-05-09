export interface VisualRuntimeVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface VisualRuntimeWorldObject {
  readonly id: string;
  readonly label: string;
  readonly kind: "tool_crate" | "sensor_puck" | "payload_case" | "charging_pad";
  readonly position: VisualRuntimeVector3;
  readonly target: boolean;
}

export interface VisualRuntimeRobotPose {
  readonly position: VisualRuntimeVector3;
  readonly headingRadians: number;
  readonly gaitPhase: number;
}

export interface VisualRuntimeWorldSnapshot {
  readonly snapshotId: string;
  readonly robot: VisualRuntimeRobotPose;
  readonly objects: readonly VisualRuntimeWorldObject[];
  readonly targetZones: readonly VisualRuntimeWorldObject[];
  readonly activityPath: readonly VisualRuntimeVector3[];
  readonly hiddenSimulatorTruthExposed: false;
}

export const createInitialVisualRuntimeWorldSnapshot = (): VisualRuntimeWorldSnapshot => ({
  snapshotId: "vr-05-static-scene-snapshot",
  robot: {
    position: { x: 0, y: 0, z: 0 },
    headingRadians: 0,
    gaitPhase: 0,
  },
  objects: [
    {
      id: "payload-case-a",
      label: "Payload Case",
      kind: "payload_case",
      position: { x: -2.6, y: 0.25, z: -1.2 },
      target: false,
    },
    {
      id: "sensor-puck-a",
      label: "Sensor Puck",
      kind: "sensor_puck",
      position: { x: 2.7, y: 0.15, z: -1.5 },
      target: false,
    },
    {
      id: "tool-crate-a",
      label: "Tool Crate",
      kind: "tool_crate",
      position: { x: -3.2, y: 0.35, z: 1.8 },
      target: true,
    },
    {
      id: "charging-pad-a",
      label: "Charging Pad",
      kind: "charging_pad",
      position: { x: 2.8, y: 0.05, z: 2.0 },
      target: true,
    },
  ],
  targetZones: [
    {
      id: "inspection-zone",
      label: "Inspection Zone",
      kind: "sensor_puck",
      position: { x: 2.6, y: 0.05, z: -2.4 },
      target: true,
    },
    {
      id: "delivery-zone",
      label: "Delivery Zone",
      kind: "charging_pad",
      position: { x: -2.4, y: 0.05, z: 2.2 },
      target: true,
    },
  ],
  activityPath: [
    { x: -2.6, y: 0.04, z: -1.2 },
    { x: -1.2, y: 0.04, z: -0.3 },
    { x: 0.0, y: 0.04, z: 0.0 },
    { x: 1.5, y: 0.04, z: 0.8 },
    { x: 2.8, y: 0.04, z: 2.0 },
  ],
  hiddenSimulatorTruthExposed: false,
});
