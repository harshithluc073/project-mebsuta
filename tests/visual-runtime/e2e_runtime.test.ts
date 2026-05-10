import { readFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import react from "@vitejs/plugin-react";
import { createServer as createViteServer, ViteDevServer } from "vite";

import { createVisualRuntimeServer } from "../../apps/visual-runtime/backend/src/server";
import { VisualRuntimeObservabilityAuditSnapshot } from "../../apps/visual-runtime/shared/src/observability_contracts";
import { VisualRuntimeVerificationOopsRun } from "../../apps/visual-runtime/shared/src/verification_oops_contracts";

const fixedTimestamp = "2026-05-10T13:30:00.000Z";
const safeFakeKey = "MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY";
const runningBackends: ReturnType<typeof createVisualRuntimeServer>[] = [];
const runningFrontends: ViteDevServer[] = [];

const closeBackend = (server: ReturnType<typeof createVisualRuntimeServer>) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

const startBackend = async () => {
  const server = createVisualRuntimeServer({
    providerConfigInput: {
      LLM_PROVIDER: "openai",
      LLM_API_KEY: safeFakeKey,
      LLM_MODEL: "safe-test-model",
    },
    now: () => fixedTimestamp,
  });
  runningBackends.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

const startFrontend = async (backendUrl: string) => {
  const server = await createViteServer({
    configFile: false,
    logLevel: "silent",
    root: "apps/visual-runtime/frontend",
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: {
        "/api": {
          target: backendUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  });
  await server.listen();
  runningFrontends.push(server);
  const address = server.httpServer?.address() as AddressInfo;

  return `http://127.0.0.1:${address.port}`;
};

const readText = async (url: string) => {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.text();
};

const readJson = async <T,>(url: string) => {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
};

afterEach(async () => {
  await Promise.all(runningFrontends.splice(0).map((server) => server.close()));
  await Promise.all(runningBackends.splice(0).map(closeBackend));
});

describe("visual runtime end-to-end local app checks", () => {
  it("starts the backend and frontend, loads the browser app, and keeps provider keys out", async () => {
    const backendUrl = await startBackend();
    const frontendUrl = await startFrontend(backendUrl);

    await expect(readJson(`${backendUrl}/health`)).resolves.toMatchObject({
      health: "ok",
      localOnly: true,
      browserReceivesProviderKey: false,
    });

    const html = await readText(frontendUrl);
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain("/src/main.tsx");
    expect(html).not.toContain(safeFakeKey);

    const mainModule = await readText(`${frontendUrl}/src/main.tsx`);
    expect(mainModule).toContain("createRoot");
    expect(mainModule).not.toContain("LLM_API_KEY");
    expect(mainModule).not.toContain(safeFakeKey);

    const providerStatus = await readJson<Record<string, unknown>>(`${frontendUrl}/api/provider/status`);
    expect(providerStatus).toMatchObject({
      mode: "provider_ready",
      credentialConfigured: true,
      browserReceivesProviderKey: false,
    });
    expect(JSON.stringify(providerStatus)).not.toContain(safeFakeKey);
  });

  it("runs the demo task flow and exposes event stream audit state through the frontend proxy", async () => {
    const backendUrl = await startBackend();
    const frontendUrl = await startFrontend(backendUrl);

    const verificationRun = await readJson<VisualRuntimeVerificationOopsRun>(
      `${frontendUrl}/api/verification/run?taskId=inspect_work_cell&retryAttemptsUsed=0`,
    );
    expect(verificationRun.outcome).toBe("success");
    expect(verificationRun.sourceRun.plan.map((step) => step.state)).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
    ]);
    expect(verificationRun.sourceRun.execution.length).toBeGreaterThanOrEqual(4);
    expect(verificationRun.sourceRun.telemetry.map((event) => event.message)).toContain(
      "execution gate decision: accepted",
    );
    expect(verificationRun.browserReceivesProviderKey).toBe(false);

    const audit = await readJson<VisualRuntimeObservabilityAuditSnapshot>(
      `${frontendUrl}/api/observability/audit?taskId=inspect_work_cell&retryAttemptsUsed=0`,
    );
    expect(audit.eventStream.map((event) => event.surface)).toEqual([
      "event_stream",
      "memory_write",
      "plan_history",
      "verification_evidence",
      "oops_episode",
      "redacted_trace",
    ]);
    expect(audit.replay.stateProgressionMatches).toBe(true);
    expect(audit.replay.apiKeyPresentInReplay).toBe(false);
    expect(JSON.stringify(audit)).not.toContain(safeFakeKey);
  });

  it("covers real visual render evidence without committing generated build output", async () => {
    const viewerSource = await readFile(
      "apps/visual-runtime/frontend/src/components/RobotWorldViewer.tsx",
      "utf8",
    );
    const sceneSource = await readFile(
      "apps/visual-runtime/frontend/src/scene/robotWorldScene.ts",
      "utf8",
    );

    expect(viewerSource).toContain('data-vr05-viewer="ready"');
    expect(viewerSource).toContain('data-render-metric="triangles"');
    expect(viewerSource).toContain('data-render-metric="draw-calls"');
    expect(sceneSource).toContain("new THREE.WebGLRenderer");
    expect(sceneSource).toContain("preserveDrawingBuffer: true");
    expect(sceneSource).toContain('dataset.visualRuntimeCanvas = "vr-05"');
    expect(sceneSource).toContain('dataset.vr05DogRobot = "detailed-visible"');
    expect(sceneSource).toContain('dataset.vr05Environment = "detailed-visible"');
    expect(sceneSource).toContain("this.renderer.render(this.scene, this.camera)");
    expect(sceneSource).toContain("this.renderer.info.render.triangles");
  });
});
