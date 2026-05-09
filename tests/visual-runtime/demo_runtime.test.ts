import { afterEach, describe, expect, it } from "vitest";

import { createVisualRuntimeServer } from "../../apps/visual-runtime/backend/src/server";
import { createVisualRuntimeDemoRun } from "../../apps/visual-runtime/backend/src/demo_runtime";

const openServers: ReturnType<typeof createVisualRuntimeServer>[] = [];

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

describe("visual runtime deterministic demo", () => {
  it("creates an end-to-end demo run without provider credentials", () => {
    const run = createVisualRuntimeDemoRun({
      taskId: "deliver_payload_case",
      now: () => "2026-05-09T00:00:00.000Z",
    });

    expect(run.mode).toBe("demo_ready");
    expect(run.browserReceivesProviderKey).toBe(false);
    expect(run.task.id).toBe("deliver_payload_case");
    expect(run.plan).toHaveLength(4);
    expect(run.validation.every((gate) => gate.state === "passed")).toBe(true);
    expect(run.execution.at(-1)?.state).toBe("complete");
    expect(run.verification.result).toBe("passed");
    expect(run.verification.hiddenSimulatorTruthExposed).toBe(false);
    expect(run.telemetry.map((event) => event.message)).toContain("deterministic plan generated without LLM");
    expect(run.worldSnapshot.hiddenSimulatorTruthExposed).toBe(false);
  });

  it("serves demo tasks and demo runs from the local backend boundary", async () => {
    const server = createVisualRuntimeServer({
      now: () => "2026-05-09T00:00:00.000Z",
    });
    openServers.push(server);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe("string");

    if (!address || typeof address === "string") {
      throw new Error("Visual runtime test server did not expose a local port.");
    }

    const tasksResponse = await fetch(`http://127.0.0.1:${address.port}/demo/tasks`);
    expect(tasksResponse.ok).toBe(true);
    const tasks = (await tasksResponse.json()) as { readonly browserReceivesProviderKey: boolean };
    expect(tasks.browserReceivesProviderKey).toBe(false);

    const runResponse = await fetch(`http://127.0.0.1:${address.port}/demo/run?taskId=inspect_work_cell`);
    expect(runResponse.ok).toBe(true);
    const run = (await runResponse.json()) as ReturnType<typeof createVisualRuntimeDemoRun>;
    expect(run.task.id).toBe("inspect_work_cell");
    expect(run.verification.result).toBe("passed");
    expect(run.browserReceivesProviderKey).toBe(false);
  });
});
