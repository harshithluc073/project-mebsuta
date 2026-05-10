import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createVisualRuntimeExecutionGateRun } from "../../apps/visual-runtime/backend/src/execution_gate";
import { createVisualRuntimeServer } from "../../apps/visual-runtime/backend/src/server";
import { App } from "../../apps/visual-runtime/frontend/src/App";
import { VisualRuntimePlanStep } from "../../apps/visual-runtime/shared/src/demo_contracts";

const fixedTimestamp = "2026-05-10T01:00:00.000Z";
const openServers: ReturnType<typeof createVisualRuntimeServer>[] = [];

const invalidPlan: readonly VisualRuntimePlanStep[] = [
  {
    id: "P1",
    kind: "observe",
    label: "Only observe and stop",
    state: "complete",
  },
];

const unsafePlan: readonly VisualRuntimePlanStep[] = [
  {
    id: "P1",
    kind: "observe",
    label: "Read the allowed visual observation packet",
    state: "complete",
  },
  {
    id: "P2",
    kind: "navigate",
    label: "Exit the work cell and collide with the loading door",
    state: "complete",
  },
  {
    id: "P3",
    kind: "manipulate",
    label: "Override safe hold while moving the payload",
    state: "complete",
  },
  {
    id: "P4",
    kind: "verify",
    label: "Verify the unsafe external route",
    state: "complete",
  },
];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        }),
    ),
  );
});

describe("visual runtime safety validation and execution gate", () => {
  it("rejects invalid plans before execution primitives start", () => {
    const run = createVisualRuntimeExecutionGateRun({
      taskId: "inspect_work_cell",
      now: () => fixedTimestamp,
      planOverride: invalidPlan,
    });

    expect(run.gateDecision.status).toBe("safe_hold");
    expect(run.gateDecision.blockReason).toBe("invalid_plan");
    expect(run.gateDecision.safeHoldEntered).toBe(true);
    expect(run.validation.find((gate) => gate.gate === "Schema")?.state).toBe("blocked");
    expect(run.executionPath).toHaveLength(0);
    expect(run.execution.map((event) => event.label)).toContain("Visible execution primitive not started");
  });

  it("blocks unsafe tasks and enters safe hold", () => {
    const run = createVisualRuntimeExecutionGateRun({
      taskId: "deliver_payload_case",
      now: () => fixedTimestamp,
      planOverride: unsafePlan,
    });

    expect(run.gateDecision.status).toBe("safe_hold");
    expect(run.gateDecision.blockReason).toBe("unsafe_policy");
    expect(run.validation.find((gate) => gate.gate === "Safety policy")?.state).toBe("blocked");
    expect(run.gateDecision.executionPrimitive).toBe("safe_hold");
    expect(run.telemetry.map((event) => event.message)).toContain("execution gate decision: safe_hold");
  });

  it("allows valid tasks to execute through the visible route primitive", () => {
    const run = createVisualRuntimeExecutionGateRun({
      taskId: "return_to_charger",
      now: () => fixedTimestamp,
    });

    expect(run.gateDecision.status).toBe("accepted");
    expect(run.gateDecision.safeHoldEntered).toBe(false);
    expect(run.validation.every((gate) => gate.state === "passed")).toBe(true);
    expect(run.executionPath.length).toBeGreaterThan(1);
    expect(run.worldSnapshot.robot.position).toEqual(run.executionPath.at(-1));
    expect(run.execution.at(-1)?.state).toBe("complete");
  });

  it("serves gated execution runs through the local backend boundary", async () => {
    const server = createVisualRuntimeServer({
      now: () => fixedTimestamp,
    });
    openServers.push(server);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/execution/run?taskId=inspect_work_cell`);
    expect(response.ok).toBe(true);
    const run = (await response.json()) as ReturnType<typeof createVisualRuntimeExecutionGateRun>;

    expect(run.runId).toBe("vr-09-gated-inspect_work_cell");
    expect(run.gateDecision.status).toBe("accepted");
    expect(run.browserReceivesProviderKey).toBe(false);
  });

  it("renders gate decisions in the visual runtime UI", () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain("Gate Decision");
    expect(markup).toContain('data-vr09-execution-gate="safe_hold"');
    expect(markup).toContain('data-vr09-safe-hold="true"');
    expect(markup).toContain("Awaiting VR-09 validation gate decision.");
    expect(markup).not.toContain("MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY");
  });
});
