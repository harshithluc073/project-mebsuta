import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../../apps/visual-runtime/frontend/src/App";
import { createVisualRuntimeSensorPacket } from "../../apps/visual-runtime/backend/src/observation_firewall";
import { createVisualRuntimeServer } from "../../apps/visual-runtime/backend/src/server";
import { createVisualRuntimeStructuredPlanningRun } from "../../apps/visual-runtime/backend/src/provider_planning";

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

describe("visual runtime observation firewall", () => {
  it("builds allowed sensor packets without hidden simulator truth or backend-only ids", () => {
    const packet = createVisualRuntimeSensorPacket({
      taskId: "inspect_work_cell",
      now: () => "2026-05-10T00:00:00.000Z",
    });
    const serialized = JSON.stringify(packet);

    expect(packet.boundary.hiddenSimulatorTruthExposed).toBe(false);
    expect(packet.boundary.backendOnlyObjectIdsExposed).toBe(false);
    expect(packet.boundary.groundTruthSuccessLabelExposed).toBe(false);
    expect(packet.observations.map((observation) => observation.channel)).toEqual([
      "visual_summary",
      "proprioception",
      "contact",
      "audio",
      "task_context",
      "memory_snippet",
    ]);
    expect(serialized).not.toContain("hiddenSimulatorTruthExposed\":true");
    expect(serialized).not.toContain("payload-case-a");
    expect(serialized).not.toContain("sensor-puck-a");
    expect(serialized).not.toContain("inspection-zone");
    expect(serialized).not.toContain("\"result\":\"passed\"");
  });

  it("uses the same allowed observation boundary for demo fallback and provider planning", async () => {
    const demoPacket = createVisualRuntimeSensorPacket({
      taskId: "deliver_payload_case",
      now: () => "2026-05-10T00:00:00.000Z",
    });
    const providerResult = await createVisualRuntimeStructuredPlanningRun({
      taskId: "deliver_payload_case",
      now: () => "2026-05-10T00:00:00.000Z",
      providerConfigInput: {
        LLM_PROVIDER: "openai",
        LLM_API_KEY: "MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY",
      },
      providerPlanTransport: {
        requestStructuredPlan: async (request) => ({
          steps: request.sensorPacket.observations.slice(0, 4).map((observation, index) => ({
            kind: index === 0 ? "observe" : index === 1 ? "navigate" : index === 2 ? "manipulate" : "verify",
            label: `Use allowed ${observation.channel} packet evidence`,
          })),
        }),
      },
    });

    expect(providerResult.source).toBe("provider_structured_plan");
    if (providerResult.source !== "provider_structured_plan") {
      throw new Error("Expected provider structured plan.");
    }

    expect(providerResult.request.sensorPacket.boundary).toEqual(demoPacket.boundary);
    expect(JSON.stringify(providerResult)).not.toContain("MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY");
    expect(JSON.stringify(providerResult)).not.toContain("payload-case-a");
  });

  it("serves allowed sensor packets through the local backend boundary", async () => {
    const server = createVisualRuntimeServer({
      now: () => "2026-05-10T00:00:00.000Z",
    });
    openServers.push(server);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Visual runtime test server did not expose a local port.");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/observation/packet?taskId=return_to_charger`);
    expect(response.ok).toBe(true);
    const packet = (await response.json()) as ReturnType<typeof createVisualRuntimeSensorPacket>;

    expect(packet.packetId).toBe("vr-08-sensor-packet-return_to_charger");
    expect(packet.boundary.hiddenSimulatorTruthExposed).toBe(false);
    expect(packet.browserReceivesProviderKey).toBe(false);
  });

  it("renders the allowed observation boundary in the visual runtime UI", () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain('data-vr08-observation-boundary="ready"');
    expect(markup).toContain('data-vr08-hidden-truth="false"');
    expect(markup).toContain('data-vr08-backend-ids="false"');
    expect(markup).toContain('data-vr08-success-label="false"');
    expect(markup).toContain("Visible scene");
    expect(markup).toContain("Robot body");
    expect(markup).toContain("hidden truth blocked");
    expect(markup).not.toContain("payload-case-a");
    expect(markup).not.toContain("zone-dock-blue");
    expect(markup).not.toContain("MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY");
  });
});
