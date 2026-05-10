import { IncomingMessage, Server, ServerResponse, createServer } from "node:http";
import { pathToFileURL } from "node:url";

import {
  VisualRuntimeProviderConfigInput,
  loadVisualRuntimeProviderReadiness,
} from "./config/provider_config";
import { createVisualRuntimeDemoRun } from "./demo_runtime";
import { createVisualRuntimeExecutionGateRun } from "./execution_gate";
import { createVisualRuntimeSensorPacket } from "./observation_firewall";
import {
  VisualRuntimeProviderPlanTransport,
  createVisualRuntimeStructuredPlanningRun,
} from "./provider_planning";
import { createVisualRuntimeVerificationOopsRun } from "./verification_oops";
import { VISUAL_RUNTIME_DEMO_TASKS } from "../../shared/src/demo_contracts";
import {
  VISUAL_RUNTIME_APP_DECISION,
  createVisualRuntimeHealthSnapshot,
} from "../../shared/src/runtime_contracts";

const DEFAULT_PORT = 4178;

export interface VisualRuntimeServerOptions {
  readonly providerConfigInput?: VisualRuntimeProviderConfigInput;
  readonly providerPlanTransport?: VisualRuntimeProviderPlanTransport;
  readonly now?: () => string;
}

const createTimestamp = (options: VisualRuntimeServerOptions): string =>
  options.now?.() ?? new Date().toISOString();

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void => {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "http://localhost:5178",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
};

const createProviderStatus = (options: VisualRuntimeServerOptions) =>
  loadVisualRuntimeProviderReadiness(options.providerConfigInput);

const createRuntimeStatus = (options: VisualRuntimeServerOptions) => {
  const providerStatus = createProviderStatus(options);

  return {
    runtime: "project-mebsuta-visual-runtime",
    status: "local_backend_ready",
    mode: providerStatus.mode,
    localOnly: true,
    commandBoundary: "vr_09_execution_gate_ready",
    worldSnapshotBoundary: "visual_scene_snapshot_ready",
    eventStreamBoundary: "demo_telemetry_snapshot_ready",
    browserReceivesProviderKey: false,
    timestamp: createTimestamp(options),
  } as const;
};

const createHealthStatus = (options: VisualRuntimeServerOptions) => ({
  ...createVisualRuntimeHealthSnapshot(),
  backend: "local_node_http",
  health: "ok",
  localOnly: true,
  providerMode: createProviderStatus(options).mode,
  timestamp: createTimestamp(options),
});

const normalizePath = (request: IncomingMessage): string => {
  const host = request.headers.host ?? "127.0.0.1";
  return new URL(request.url ?? "/", `http://${host}`).pathname;
};

const createRequestUrl = (request: IncomingMessage): URL => {
  const host = request.headers.host ?? "127.0.0.1";
  return new URL(request.url ?? "/", `http://${host}`);
};

export const createVisualRuntimeServer = (options: VisualRuntimeServerOptions = {}): Server =>
  createServer((request, response) => {
    const pathname = normalizePath(request);
    const requestUrl = createRequestUrl(request);

    if (request.method !== "GET") {
      writeJson(response, 405, {
        error: "method_not_allowed",
        status: "local_backend_ready",
      });
      return;
    }

    if (pathname === "/health") {
      writeJson(response, 200, createHealthStatus(options));
      return;
    }

    if (pathname === "/runtime/status") {
      writeJson(response, 200, createRuntimeStatus(options));
      return;
    }

    if (pathname === "/provider/status") {
      writeJson(response, 200, createProviderStatus(options));
      return;
    }

    if (pathname === "/app-decision") {
      writeJson(response, 200, VISUAL_RUNTIME_APP_DECISION);
      return;
    }

    if (pathname === "/demo/tasks") {
      writeJson(response, 200, {
        mode: "demo_ready",
        tasks: VISUAL_RUNTIME_DEMO_TASKS,
        browserReceivesProviderKey: false,
      });
      return;
    }

    if (pathname === "/demo/run") {
      writeJson(
        response,
        200,
        createVisualRuntimeDemoRun({
          taskId: requestUrl.searchParams.get("taskId") ?? undefined,
          now: options.now,
        }),
      );
      return;
    }

    if (pathname === "/execution/run") {
      writeJson(
        response,
        200,
        createVisualRuntimeExecutionGateRun({
          taskId: requestUrl.searchParams.get("taskId") ?? undefined,
          now: options.now,
        }),
      );
      return;
    }

    if (pathname === "/verification/run") {
      writeJson(
        response,
        200,
        createVisualRuntimeVerificationOopsRun({
          taskId: requestUrl.searchParams.get("taskId") ?? undefined,
          retryAttemptsUsed: Number(requestUrl.searchParams.get("retryAttemptsUsed") ?? 0),
          now: options.now,
        }),
      );
      return;
    }

    if (pathname === "/planning/run") {
      void createVisualRuntimeStructuredPlanningRun({
        taskId: requestUrl.searchParams.get("taskId") ?? undefined,
        now: options.now,
        providerConfigInput: options.providerConfigInput,
        providerPlanTransport: options.providerPlanTransport,
      })
        .then((planningRun) => {
          writeJson(response, 200, planningRun);
        })
        .catch(() => {
          writeJson(response, 500, {
            error: "planning_run_failed",
            status: "local_backend_ready",
            browserReceivesProviderKey: false,
          });
        });
      return;
    }

    if (pathname === "/observation/packet") {
      writeJson(
        response,
        200,
        createVisualRuntimeSensorPacket({
          taskId: requestUrl.searchParams.get("taskId") ?? undefined,
          now: options.now,
        }),
      );
      return;
    }

    writeJson(response, 404, {
      error: "not_found",
      status: "local_backend_ready",
    });
  });

export const startVisualRuntimeServer = (port = DEFAULT_PORT): Server => {
  const server = createVisualRuntimeServer();

  server.listen(port, "127.0.0.1", () => {
    console.info(`Project Mebsuta visual runtime backend listening on http://127.0.0.1:${port}`);
  });

  return server;
};

const entrypointUrl = pathToFileURL(process.argv[1] ?? "").href;

if (import.meta.url === entrypointUrl) {
  startVisualRuntimeServer();
}
