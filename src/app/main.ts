/**
 * Local validation entrypoint for PIT-B02 runtime composition.
 */

import { MebsutaRuntime } from "../runtime/mebsuta_runtime";

async function main(): Promise<void> {
  const runtime = MebsutaRuntime.fromEnvironment(process.env, process.argv.slice(2));
  const started = await runtime.start();
  const admitted = runtime.admitScenario({
    scenario_ref: "scenario:local-validation",
    task_ref: started.orchestration_snapshot.task_ref,
    requested_at_ms: started.readiness.generated_at_ms + 1,
    truth_boundary_status: "runtime_embodied_only",
    operator_ref: "operator:local-validation",
  });
  const shutdown = await runtime.shutdown(started.readiness.generated_at_ms + 2);

  const ok = started.readiness.readiness_state === "ready"
    && admitted.decision === "admitted"
    && shutdown.graceful
    && shutdown.readiness.health_state === "stopped";

  process.stdout.write(`${JSON.stringify({
    schema_version: "mebsuta.runtime_validation_result.v1",
    ok,
    runtime_ref: shutdown.runtime_ref,
    readiness: started.readiness.readiness_state,
    admission: admitted.decision,
    shutdown: shutdown.readiness.health_state,
  }, null, 2)}\n`);

  if (!ok) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown runtime validation failure.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

