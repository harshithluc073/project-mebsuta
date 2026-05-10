import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createVisualRuntimeServer } from "../../apps/visual-runtime/backend/src/server";

const fixedTimestamp = "2026-05-09T00:00:00.000Z";

const runningServers: ReturnType<typeof createVisualRuntimeServer>[] = [];

const startTestServer = async (
  providerConfigInput: Parameters<typeof createVisualRuntimeServer>[0]["providerConfigInput"] = {}
) => {
  const server = createVisualRuntimeServer({
    providerConfigInput,
    now: () => fixedTimestamp
  });
  runningServers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

const readJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json();
};

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        })
    )
  );
});

describe("visual runtime backend server", () => {
  it("starts locally and responds to health checks", async () => {
    const baseUrl = await startTestServer();

    await expect(readJson(`${baseUrl}/health`)).resolves.toMatchObject({
      app: "project-mebsuta-visual-runtime",
      backend: "local_node_http",
      health: "ok",
      localOnly: true,
      providerMode: "demo_ready",
      browserReceivesProviderKey: false,
      timestamp: fixedTimestamp
    });
  });

  it("reports runtime status without requiring hosted infrastructure", async () => {
    const baseUrl = await startTestServer();

    await expect(readJson(`${baseUrl}/runtime/status`)).resolves.toEqual({
      runtime: "project-mebsuta-visual-runtime",
      status: "local_backend_ready",
      mode: "demo_ready",
      localOnly: true,
      commandBoundary: "vr_09_execution_gate_ready",
      worldSnapshotBoundary: "visual_scene_snapshot_ready",
      eventStreamBoundary: "vr_11_audit_replay_ready",
      browserReceivesProviderKey: false,
      timestamp: fixedTimestamp
    });
  });

  it("reports provider readiness without exposing the configured credential", async () => {
    const baseUrl = await startTestServer({
      LLM_PROVIDER: "openai",
      LLM_API_KEY: "MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY",
      LLM_MODEL: "safe-test-model"
    });

    const providerStatus = await readJson(`${baseUrl}/provider/status`);

    expect(providerStatus).toEqual({
      mode: "provider_ready",
      providerConfigured: true,
      credentialConfigured: true,
      provider: "openai",
      model: "safe-test-model",
      baseUrlConfigured: false,
      demoMode: "auto",
      browserReceivesProviderKey: false
    });
    expect(JSON.stringify(providerStatus)).not.toContain("MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY");
  });

  it("keeps missing-key behavior in demo readiness", async () => {
    const baseUrl = await startTestServer({ LLM_PROVIDER: "openai" });

    await expect(readJson(`${baseUrl}/provider/status`)).resolves.toMatchObject({
      mode: "demo_ready",
      providerConfigured: true,
      credentialConfigured: false,
      browserReceivesProviderKey: false
    });
  });
});
