import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createVisualRuntimeVerificationOopsRun } from "../../apps/visual-runtime/backend/src/verification_oops";
import { createVisualRuntimeServer } from "../../apps/visual-runtime/backend/src/server";
import { App } from "../../apps/visual-runtime/frontend/src/App";
import { VisualRuntimePlanStep } from "../../apps/visual-runtime/shared/src/demo_contracts";

const fixedTimestamp = "2026-05-10T11:00:00.000Z";
const openServers: ReturnType<typeof createVisualRuntimeServer>[] = [];

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
    label: "Exit outside the visible work cell",
    state: "complete",
  },
  {
    id: "P3",
    kind: "manipulate",
    label: "Bypass safe hold and collide with a blocked zone",
    state: "complete",
  },
  {
    id: "P4",
    kind: "verify",
    label: "Verify the unsafe motion",
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

describe("visual runtime verification and Oops Loop", () => {
  it("generates visible success evidence for a valid task", () => {
    const run = createVisualRuntimeVerificationOopsRun({
      taskId: "return_to_charger",
      now: () => fixedTimestamp,
    });

    expect(run.outcome).toBe("success");
    expect(run.certificateId).toBe("vr-10-success-return_to_charger-certificate");
    expect(run.evidence.map((item) => item.source)).toContain("visible_execution");
    expect(run.evidence.every((item) => item.hiddenSimulatorTruthExposed === false)).toBe(true);
    expect(run.failure.code).toBe("none");
  });

  it("generates visible failure evidence when safe hold blocks execution", () => {
    const run = createVisualRuntimeVerificationOopsRun({
      taskId: "deliver_payload_case",
      now: () => fixedTimestamp,
      planOverride: unsafePlan,
    });

    expect(run.outcome).toBe("failed");
    expect(run.certificateId).toBe("vr-10-failure-deliver_payload_case-certificate");
    expect(run.failure.code).toBe("safe_hold");
    expect(run.evidence.map((item) => item.source)).toContain("safe_hold_gate");
    expect(run.oopsLoop.safeHoldActive).toBe(true);
    expect(run.sourceRun.executionPath).toHaveLength(0);
  });

  it("keeps Oops Loop retry behavior bounded and operator controlled", () => {
    const run = createVisualRuntimeVerificationOopsRun({
      taskId: "deliver_payload_case",
      now: () => fixedTimestamp,
      retryAttemptsUsed: 99,
      planOverride: unsafePlan,
    });

    expect(run.oopsLoop.retryBudgetMax).toBe(2);
    expect(run.oopsLoop.retryAttemptsUsed).toBe(2);
    expect(run.oopsLoop.retryBudgetRemaining).toBe(0);
    expect(run.oopsLoop.boundedRetryAllowed).toBe(false);
    expect(run.oopsLoop.manualStopAvailable).toBe(true);
    expect(run.oopsLoop.correctionProposal.autoCorrectionAllowed).toBe(false);
  });

  it("serves verification and Oops Loop runs through the local backend boundary", async () => {
    const server = createVisualRuntimeServer({
      now: () => fixedTimestamp,
    });
    openServers.push(server);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/verification/run?taskId=inspect_work_cell&retryAttemptsUsed=1`,
    );
    expect(response.ok).toBe(true);
    const run = (await response.json()) as ReturnType<typeof createVisualRuntimeVerificationOopsRun>;

    expect(run.runId).toBe("vr-10-verification-oops-inspect_work_cell");
    expect(run.outcome).toBe("success");
    expect(run.oopsLoop.retryAttemptsUsed).toBe(1);
    expect(run.browserReceivesProviderKey).toBe(false);
  });

  it("renders the full verification and Oops Loop chain in the UI", () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain('data-vr10-verification-chain="ready"');
    expect(markup).toContain('data-vr10-oops-loop="bounded"');
    expect(markup).toContain("Correction proposal");
    expect(markup).toContain("Retry");
    expect(markup).toContain("Stop");
    expect(markup).toContain("Safe Hold");
    expect(markup).not.toContain("MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY");
  });
});
