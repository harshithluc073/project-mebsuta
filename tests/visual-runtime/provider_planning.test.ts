import { afterEach, describe, expect, it } from "vitest";

import { createVisualRuntimeServer } from "../../apps/visual-runtime/backend/src/server";
import {
  VisualRuntimeProviderPlanTransport,
  createVisualRuntimeStructuredPlanningRun,
} from "../../apps/visual-runtime/backend/src/provider_planning";

const safeFakeCredential = "MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY";
const openServers: ReturnType<typeof createVisualRuntimeServer>[] = [];

const validProviderTransport: VisualRuntimeProviderPlanTransport = {
  requestStructuredPlan: async () => ({
    steps: [
      { kind: "observe", label: "Read the allowed visual observation packet" },
      { kind: "navigate", label: "Move through the visible route to the selected zone" },
      { kind: "inspect", label: "Inspect the requested visible target object" },
      { kind: "verify", label: "Verify the result from allowed visible evidence" },
    ],
  }),
};

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

describe("visual runtime provider planning", () => {
  it("falls back to the deterministic demo run when the provider key is missing", async () => {
    const result = await createVisualRuntimeStructuredPlanningRun({
      taskId: "inspect_work_cell",
      now: () => "2026-05-09T00:00:00.000Z",
      providerConfigInput: {
        LLM_PROVIDER: "openai",
      },
      providerPlanTransport: validProviderTransport,
    });

    expect(result.mode).toBe("demo_ready");
    expect(result.source).toBe("deterministic_demo_fallback");
    expect(result.providerAttempted).toBe(false);
    expect(result.browserReceivesProviderKey).toBe(false);

    if (result.source !== "deterministic_demo_fallback") {
      throw new Error("Expected deterministic demo fallback.");
    }

    expect(result.demoRun.verification.result).toBe("passed");
  });

  it("accepts a schema-valid provider plan without exposing the configured key", async () => {
    const result = await createVisualRuntimeStructuredPlanningRun({
      taskId: "deliver_payload_case",
      now: () => "2026-05-09T00:00:00.000Z",
      providerConfigInput: {
        LLM_PROVIDER: "openai",
        LLM_API_KEY: safeFakeCredential,
        LLM_MODEL: "safe-test-model",
      },
      providerPlanTransport: validProviderTransport,
    });

    expect(result.mode).toBe("provider_ready");
    expect(result.source).toBe("provider_structured_plan");
    expect(result.providerAttempted).toBe(true);
    expect(JSON.stringify(result)).not.toContain(safeFakeCredential);

    if (result.source !== "provider_structured_plan") {
      throw new Error("Expected structured provider plan.");
    }

    expect(result.provider.credentialExposed).toBe(false);
    expect(result.plan).toHaveLength(4);
    expect(result.validation.every((gate) => gate.state === "passed")).toBe(true);
  });

  it("quarantines invalid provider output and redacts provider errors", async () => {
    const result = await createVisualRuntimeStructuredPlanningRun({
      taskId: "return_to_charger",
      now: () => "2026-05-09T00:00:00.000Z",
      providerConfigInput: {
        LLM_PROVIDER: "gemini",
        LLM_API_KEY: safeFakeCredential,
        LLM_MODEL: "safe-test-model",
      },
      providerPlanTransport: {
        requestStructuredPlan: async () => {
          throw new Error(`provider failed with ${safeFakeCredential}`);
        },
      },
    });

    expect(result.mode).toBe("provider_ready");
    expect(result.source).toBe("provider_response_quarantined");
    expect(JSON.stringify(result)).not.toContain(safeFakeCredential);

    if (result.source !== "provider_response_quarantined") {
      throw new Error("Expected provider quarantine.");
    }

    expect(result.quarantine.reason).toBe("provider_plan_rejected");
    expect(result.quarantine.redactedError).toContain("[redacted-provider-key]");
    expect(result.quarantine.providerRawOutputStored).toBe(false);
    expect(result.demoRun.mode).toBe("demo_ready");
  });

  it("serves backend-only planning runs through the local server boundary", async () => {
    const server = createVisualRuntimeServer({
      now: () => "2026-05-09T00:00:00.000Z",
      providerConfigInput: {
        LLM_PROVIDER: "anthropic",
        LLM_API_KEY: safeFakeCredential,
        LLM_MODEL: "safe-test-model",
      },
      providerPlanTransport: validProviderTransport,
    });
    openServers.push(server);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Visual runtime test server did not expose a local port.");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/planning/run?taskId=inspect_work_cell`);
    expect(response.ok).toBe(true);
    const result = (await response.json()) as Awaited<ReturnType<typeof createVisualRuntimeStructuredPlanningRun>>;

    expect(result.mode).toBe("provider_ready");
    expect(result.source).toBe("provider_structured_plan");
    expect(JSON.stringify(result)).not.toContain(safeFakeCredential);
  });
});
