import { describe, expect, it } from "vitest";

import { MebsutaRuntime } from "../../src/runtime/mebsuta_runtime";
import { BackendApiServer } from "../../src/server/api_server";
import type { ApiActorRole, ApiRouteRequest, BackendApiRoute } from "../../src/server/api_contracts";

describe("PIT-B03 backend API foundation", () => {
  it("serves runtime profile and readiness through versioned envelopes", async () => {
    const runtime = await startedRuntime();
    const server = new BackendApiServer({ runtime });

    const profile = await server.handleRequest(request("/api/v1/runtime/profile", "GET", "operator"));
    const readiness = await server.handleRequest(request("/api/v1/runtime/readiness", "GET", "operator"));

    expect(profile.status).toBe("ok");
    expect(profile.status_code).toBe(200);
    expect(profile.api_version).toBe("1.0.0");
    expect(readiness.status).toBe("ok");
    expect(readiness.data).toMatchObject({ readiness_state: "ready", accepting_scenarios: true });
  });

  it("rejects unauthorized and version-incompatible mutating route requests", async () => {
    const runtime = await startedRuntime();
    const server = new BackendApiServer({ runtime });

    const unauthorized = await server.handleRequest(request("/api/v1/scenarios/launch", "POST", "auditor", {
      scenario_ref: "scenario:api",
      task_ref: "task:api",
      requested_at_ms: 5_000,
      truth_boundary_status: "runtime_embodied_only",
    }));
    const incompatible = await server.handleRequest({
      ...request("/api/v1/runtime/health", "GET", "operator"),
      context: { ...request("/api/v1/runtime/health", "GET", "operator").context, api_version: "2.0.0", request_ref: "request:bad-version" },
    });

    expect(unauthorized.status).toBe("rejected");
    expect(unauthorized.status_code).toBe(401);
    expect(incompatible.status).toBe("rejected");
    expect(incompatible.status_code).toBe(412);
    expect(incompatible.error?.error_class).toBe("version_incompatible");
  });

  it("launches an admitted scenario through runtime admission and emits ordered events", async () => {
    const runtime = await startedRuntime();
    const server = new BackendApiServer({ runtime });

    const launched = await server.handleRequest(request("/api/v1/scenarios/launch", "POST", "operator", {
      scenario_ref: "scenario:api-foundation",
      task_ref: "runtime:api-test:task",
      requested_at_ms: 6_000,
      truth_boundary_status: "runtime_embodied_only",
    }));
    const events = await server.handleRequest(request("/api/v1/events", "GET", "operator"));

    expect(launched.status).toBe("ok");
    expect(launched.status_code).toBe(202);
    expect(launched.data).toMatchObject({ decision: "admitted" });
    expect(events.status).toBe("ok");
    expect(events.data).toMatchObject({ cursor: { last_sequence: 1 } });
  });

  it("rejects command authority when runtime readiness or safety-sensitive policy blocks mutation", async () => {
    const runtime = MebsutaRuntime.fromEnvironment({ MEBSUTA_RUNTIME_MODE: "local_validation", MEBSUTA_RUNTIME_REF: "runtime:api-unstarted" }, ["--validation"]);
    const server = new BackendApiServer({ runtime });

    const rejected = await server.handleRequest(request("/api/v1/operator-commands", "POST", "operator", {
      command: "launch_scenario",
      reason: "Request launch before runtime readiness.",
      scenario_ref: "scenario:blocked",
      idempotency_ref: "idempotency:blocked-command",
    }));

    expect(rejected.status).toBe("rejected");
    expect(rejected.status_code).toBe(401);
    expect(rejected.error?.error_class).toBe("unauthorized");
  });

  it("publishes safety-critical command events with acknowledgement semantics", async () => {
    const runtime = await startedRuntime();
    const server = new BackendApiServer({ runtime });

    const accepted = await server.handleRequest(request("/api/v1/operator-commands", "POST", "safety_operator", {
      command: "enter_safe_hold",
      reason: "Safety operator requests conservative hold.",
      idempotency_ref: "idempotency:safe-hold-command",
    }));
    const events = await server.handleRequest(request("/api/v1/events", "GET", "operator"));
    const payload = events.data as { readonly events: readonly { readonly priority: string; readonly acknowledgement_required: boolean }[] };

    expect(accepted.status).toBe("ok");
    expect(payload.events[0]).toMatchObject({ priority: "safety_critical", acknowledgement_required: true });
  });
});

async function startedRuntime(): Promise<MebsutaRuntime> {
  const runtime = MebsutaRuntime.fromEnvironment({ MEBSUTA_RUNTIME_MODE: "local_validation", MEBSUTA_RUNTIME_REF: "runtime:api-test" }, ["--validation"]);
  await runtime.start(4_000);
  return runtime;
}

function request<TBody>(
  path: BackendApiRoute,
  method: "GET" | "POST",
  actorRole: ApiActorRole,
  body?: TBody,
): ApiRouteRequest<TBody> {
  return {
    method,
    path,
    body,
    context: {
      request_ref: `request:${path.replace(/[^a-z0-9]+/gi, "-")}:${actorRole}`,
      correlation_ref: `correlation:${actorRole}`,
      actor_ref: `actor:${actorRole}`,
      actor_role: actorRole,
      source_surface: actorRole === "qa_engineer" ? "qa_console" : "operator_console",
      api_version: "1.0.0",
      received_at_ms: 4_500,
      policy_refs: ["policy:pit-b03-api-foundation"],
    },
  };
}

