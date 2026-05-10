import { useEffect, useMemo, useState } from "react";

import {
  DEFAULT_VISUAL_RUNTIME_DEMO_TASK,
  VISUAL_RUNTIME_DEMO_TASKS,
  VisualRuntimeDemoRunSnapshot,
  VisualRuntimeDemoTask,
  VisualRuntimeDemoTaskId,
} from "../../shared/src/demo_contracts";
import { VisualRuntimeExecutionGateRun } from "../../shared/src/execution_gate_contracts";
import { VisualRuntimeSensorPacket } from "../../shared/src/observation_contracts";
import { VISUAL_RUNTIME_APP_DECISION } from "../../shared/src/runtime_contracts";
import { VisualRuntimeVerificationOopsRun } from "../../shared/src/verification_oops_contracts";
import { RobotWorldViewer } from "./components/RobotWorldViewer";

import "./styles.css";

type PanelTone = "ready" | "pending" | "hold" | "quiet";

interface RuntimeStatus {
  readonly status: string;
  readonly mode: string;
  readonly commandBoundary: string;
  readonly worldSnapshotBoundary: string;
  readonly eventStreamBoundary: string;
  readonly browserReceivesProviderKey: false;
}

interface ProviderStatus {
  readonly mode: string;
  readonly providerConfigured: boolean;
  readonly credentialConfigured: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly browserReceivesProviderKey: false;
}

interface StatusTile {
  readonly label: string;
  readonly value: string;
  readonly tone: PanelTone;
}

interface DemoTasksResponse {
  readonly mode: "demo_ready";
  readonly tasks: readonly VisualRuntimeDemoTask[];
  readonly browserReceivesProviderKey: false;
}

const fallbackSensorPacket: VisualRuntimeSensorPacket = {
  packetId: "vr-08-awaiting-backend",
  task: {
    id: DEFAULT_VISUAL_RUNTIME_DEMO_TASK.id,
    label: DEFAULT_VISUAL_RUNTIME_DEMO_TASK.label,
    operatorText: DEFAULT_VISUAL_RUNTIME_DEMO_TASK.operatorText,
  },
  observations: [
    {
      channel: "visual_summary",
      label: "Visible scene",
      value: "Awaiting local backend packet; hidden simulator truth stays blocked.",
    },
    {
      channel: "proprioception",
      label: "Robot body",
      value: "Awaiting local backend packet; no privileged coordinates exposed.",
    },
    {
      channel: "contact",
      label: "Contact",
      value: "Awaiting local backend packet; contact state is limited to safe summaries.",
    },
    {
      channel: "audio",
      label: "Audio",
      value: "Awaiting local backend packet; no private logs or raw provider data are present.",
    },
    {
      channel: "task_context",
      label: "Task",
      value: DEFAULT_VISUAL_RUNTIME_DEMO_TASK.operatorText,
    },
    {
      channel: "memory_snippet",
      label: "Memory",
      value: "Local demo memory is limited to prior safe task summaries.",
    },
  ],
  boundary: {
    allowedChannels: ["visual_summary", "proprioception", "contact", "audio", "task_context", "memory_snippet"],
    redactedFields: [
      "worldSnapshot.hiddenSimulatorTruthExposed",
      "worldSnapshot.objects[].id",
      "worldSnapshot.targetZones[].id",
      "verification.result",
      "provider.rawOutput",
      "provider.credential",
    ],
    hiddenSimulatorTruthExposed: false,
    backendOnlyObjectIdsExposed: false,
    groundTruthSuccessLabelExposed: false,
  },
  browserReceivesProviderKey: false,
};

const API_BASE_URL = "/api";

const fallbackRuntimeStatus: RuntimeStatus = {
  status: "local_backend_unavailable",
  mode: "demo_ready",
  commandBoundary: "awaiting_backend",
  worldSnapshotBoundary: "awaiting_demo_snapshot",
  eventStreamBoundary: "awaiting_demo_telemetry",
  browserReceivesProviderKey: false,
};

const fallbackProviderStatus: ProviderStatus = {
  mode: "demo_ready",
  providerConfigured: false,
  credentialConfigured: false,
  browserReceivesProviderKey: false,
};

const planRows = [
  ["P1", "Accept operator task", "queued"],
  ["P2", "Assemble allowed observation", "waiting"],
  ["P3", "Validate plan schema", "waiting"],
  ["P4", "Execute visible primitive", "locked"],
] as const;

const validationRows = [
  ["Schema", "pending"],
  ["Task scope", "pending"],
  ["Safety policy", "pending"],
  ["Reachability", "pending"],
  ["Evidence boundary", "pending"],
] as const;

const executionRows = [
  ["00:00", "Idle stance", "ready"],
  ["--:--", "Plan accepted", "pending"],
  ["--:--", "Motion primitive", "pending"],
  ["--:--", "Verification", "pending"],
] as const;

const traceRows = [
  "frontend shell mounted",
  "runtime status panel ready",
  "provider status redacted",
  "three.js robot viewer active",
] as const;

const toStatusText = (value: boolean): string => (value ? "yes" : "no");

const toPillTone = (state: string): PanelTone =>
  state === "complete" || state === "passed" ? "ready" : state === "blocked" ? "hold" : "pending";

const fetchJson = async <T,>(path: string, fallback: T): Promise<T> => {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return fallback;
    }

    return (await response.json()) as T;
  } catch {
    return fallback;
  }
};

const StatusPill = ({ tone, children }: { readonly tone: PanelTone; readonly children: string }) => (
  <span className={`status-pill status-pill-${tone}`}>{children}</span>
);

const MetricTile = ({ tile }: { readonly tile: StatusTile }) => (
  <div className="metric-tile">
    <span>{tile.label}</span>
    <strong>{tile.value}</strong>
    <StatusPill tone={tile.tone}>{tile.tone}</StatusPill>
  </div>
);

export const App = () => {
  const [taskText, setTaskText] = useState(DEFAULT_VISUAL_RUNTIME_DEMO_TASK.operatorText);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>(fallbackRuntimeStatus);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>(fallbackProviderStatus);
  const [demoTasks, setDemoTasks] = useState<readonly VisualRuntimeDemoTask[]>(VISUAL_RUNTIME_DEMO_TASKS);
  const [selectedTaskId, setSelectedTaskId] = useState<VisualRuntimeDemoTaskId>(DEFAULT_VISUAL_RUNTIME_DEMO_TASK.id);
  const [demoRun, setDemoRun] = useState<VisualRuntimeExecutionGateRun | VisualRuntimeDemoRunSnapshot | null>(null);
  const [demoRunState, setDemoRunState] = useState<"idle" | "running" | "complete">("idle");
  const [manualControlState, setManualControlState] = useState<"ready" | "manual_stop" | "safe_hold">("ready");
  const [retryAttemptsUsed, setRetryAttemptsUsed] = useState(0);
  const [sensorPacket, setSensorPacket] = useState<VisualRuntimeSensorPacket>(fallbackSensorPacket);
  const [verificationOops, setVerificationOops] = useState<VisualRuntimeVerificationOopsRun | null>(null);

  useEffect(() => {
    let active = true;

    const refreshStatus = async () => {
      const [runtime, provider, demoTaskResponse, observationPacket] = await Promise.all([
        fetchJson<RuntimeStatus>("/runtime/status", fallbackRuntimeStatus),
        fetchJson<ProviderStatus>("/provider/status", fallbackProviderStatus),
        fetchJson<DemoTasksResponse>("/demo/tasks", {
          mode: "demo_ready",
          tasks: VISUAL_RUNTIME_DEMO_TASKS,
          browserReceivesProviderKey: false,
        }),
        fetchJson<VisualRuntimeSensorPacket>(
          `/observation/packet?taskId=${encodeURIComponent(selectedTaskId)}`,
          fallbackSensorPacket,
        ),
      ]);

      if (active) {
        setRuntimeStatus(runtime);
        setProviderStatus(provider);
        setDemoTasks(demoTaskResponse.tasks);
        setSensorPacket(observationPacket);
      }
    };

    void refreshStatus();

    return () => {
      active = false;
    };
  }, [selectedTaskId]);

  const metrics = useMemo<readonly StatusTile[]>(
    () => [
      {
        label: "Runtime",
        value: runtimeStatus.status,
        tone: runtimeStatus.status === "local_backend_ready" ? "ready" : "hold",
      },
      {
        label: "Mode",
        value: runtimeStatus.mode,
        tone: runtimeStatus.mode === "provider_ready" || runtimeStatus.mode === "demo_ready" ? "ready" : "quiet",
      },
      {
        label: "Demo",
        value: demoRunState,
        tone: demoRunState === "complete" ? "ready" : demoRunState === "running" ? "pending" : "quiet",
      },
      {
        label: "Browser key",
        value: "blocked",
        tone: "ready",
      },
    ],
    [demoRunState, runtimeStatus.mode, runtimeStatus.status],
  );

  const selectedTask =
    demoTasks.find((task) => task.id === selectedTaskId) ?? demoTasks[0] ?? DEFAULT_VISUAL_RUNTIME_DEMO_TASK;
  const verificationEvidence =
    verificationOops?.evidence.map((evidence) => evidence.summary) ??
    demoRun?.verification.evidence ??
    ["awaiting deterministic demo task"];
  const traceEntries = demoRun?.telemetry.map((event) => event.message) ?? traceRows;

  const runDemoTask = async () => {
    setDemoRunState("running");
    const verificationRun = await fetchJson<VisualRuntimeVerificationOopsRun | null>(
      `/verification/run?taskId=${encodeURIComponent(selectedTaskId)}&retryAttemptsUsed=${retryAttemptsUsed}`,
      null,
    );

    if (!verificationRun) {
      setDemoRunState("idle");
      return;
    }

    const observationPacket = await fetchJson<VisualRuntimeSensorPacket>(
      `/observation/packet?taskId=${encodeURIComponent(selectedTaskId)}`,
      fallbackSensorPacket,
    );
    setDemoRun(verificationRun.sourceRun);
    setVerificationOops(verificationRun);
    setSensorPacket(observationPacket);
    setTaskText(verificationRun.sourceRun.task.operatorText);
    setManualControlState(verificationRun.oopsLoop.safeHoldActive ? "safe_hold" : "ready");
    setDemoRunState("complete");
  };

  const resetDemoTask = () => {
    setDemoRun(null);
    setVerificationOops(null);
    setDemoRunState("idle");
    setManualControlState("ready");
    setRetryAttemptsUsed(0);
    setTaskText(selectedTask.operatorText);
  };

  const requestBoundedRetry = () => {
    if (!verificationOops?.oopsLoop.boundedRetryAllowed) {
      return;
    }

    setRetryAttemptsUsed((current) =>
      Math.min(verificationOops.oopsLoop.retryBudgetMax, current + 1),
    );
    setDemoRunState("idle");
  };

  const gateDecision =
    demoRun && "gateDecision" in demoRun
      ? demoRun.gateDecision
      : {
          status: "safe_hold" as const,
          blockReason: "none" as const,
          safeHoldEntered: true,
          executionPrimitive: "safe_hold" as const,
          summary: "Awaiting VR-09 validation gate decision.",
        };

  return (
    <main className="runtime-shell" data-runtime-shell="vr-06" data-vr06-demo-run={demoRunState}>
      <section className="workspace-region" aria-label="Robot and world workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Project Mebsuta</p>
            <h1>Visual Runtime Console</h1>
          </div>
          <div className="topbar-actions" aria-label="Runtime command controls">
            <button type="button" onClick={runDemoTask}>
              Submit
            </button>
            <button
              type="button"
              onClick={() => {
                setDemoRunState("idle");
                setManualControlState("manual_stop");
              }}
            >
              Hold
            </button>
            <button type="button" onClick={resetDemoTask}>
              Reset
            </button>
          </div>
        </header>

        <section className="viewport-panel" aria-label="Robot world viewport">
          <div className="viewport-header">
            <span>Robot / World</span>
            <StatusPill tone={demoRunState === "complete" ? "ready" : "pending"}>{demoRunState}</StatusPill>
          </div>
          <RobotWorldViewer executionPath={demoRun?.executionPath} executionRunId={demoRun?.runId} />
        </section>

        <section className="task-panel" aria-label="Task input panel">
          <label htmlFor="task-input">Task</label>
          <div className="demo-task-controls">
            <select
              aria-label="Preset demo task"
              value={selectedTaskId}
              onChange={(event) => {
                const nextTaskId = event.target.value as VisualRuntimeDemoTaskId;
                const nextTask = demoTasks.find((task) => task.id === nextTaskId);
                setSelectedTaskId(nextTaskId);
                setTaskText(nextTask?.operatorText ?? taskText);
              }}
            >
              {demoTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.label}
                </option>
              ))}
            </select>
            <StatusPill tone="ready">no env required</StatusPill>
          </div>
          <textarea
            id="task-input"
            value={taskText}
            onChange={(event) => setTaskText(event.target.value)}
            rows={3}
          />
        </section>
      </section>

      <aside className="dashboard-region" aria-label="Runtime dashboard">
        <section className="metric-grid" aria-label="Status summary">
          {metrics.map((tile) => (
            <MetricTile key={tile.label} tile={tile} />
          ))}
        </section>

        <section className="panel-grid" aria-label="Runtime status panels">
          <article className="panel">
            <h2>Provider</h2>
            <dl>
              <div>
                <dt>Configured</dt>
                <dd>{toStatusText(providerStatus.providerConfigured)}</dd>
              </div>
              <div>
                <dt>Credential</dt>
                <dd>{providerStatus.credentialConfigured ? "present" : "absent"}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{providerStatus.model ?? "demo"}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{providerStatus.mode}</dd>
              </div>
            </dl>
          </article>

          <article className="panel">
            <h2>Runtime</h2>
            <dl>
              <div>
                <dt>Commands</dt>
                <dd>{runtimeStatus.commandBoundary}</dd>
              </div>
              <div>
                <dt>World</dt>
                <dd>{runtimeStatus.worldSnapshotBoundary}</dd>
              </div>
              <div>
                <dt>Events</dt>
                <dd>{runtimeStatus.eventStreamBoundary}</dd>
              </div>
            </dl>
          </article>

          <article className="panel span-two">
            <h2>Plan</h2>
            <div className="row-table">
              {(demoRun?.plan ?? planRows.map(([id, label, state]) => ({ id, label, state }))).map(({ id, label, state }) => (
                <div key={id}>
                  <span>{id}</span>
                  <strong>{label}</strong>
                  <StatusPill tone={toPillTone(state)}>{state}</StatusPill>
                </div>
              ))}
            </div>
          </article>

          <article className="panel">
            <h2>Validation</h2>
            <div className="compact-list">
              {(demoRun?.validation ?? validationRows.map(([gate, state]) => ({ gate, state, reason: "pending" }))).map((row) => (
                <div key={row.gate}>
                  <span title={row.reason}>{row.gate}</span>
                  <StatusPill tone={toPillTone(row.state)}>{row.state}</StatusPill>
                </div>
              ))}
            </div>
          </article>

          <article
            className="panel"
            data-vr09-execution-gate={gateDecision.status}
            data-vr09-safe-hold={String(gateDecision.safeHoldEntered)}
          >
            <h2>Gate Decision</h2>
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{gateDecision.status}</dd>
              </div>
              <div>
                <dt>Reason</dt>
                <dd>{gateDecision.blockReason}</dd>
              </div>
              <div>
                <dt>Primitive</dt>
                <dd>{gateDecision.executionPrimitive}</dd>
              </div>
              <div>
                <dt>Summary</dt>
                <dd>{gateDecision.summary}</dd>
              </div>
            </dl>
          </article>

          <article className="panel">
            <h2>Execution</h2>
            <div className="timeline">
              {(demoRun?.execution ?? executionRows.map(([time, label, state]) => ({ time, label, state }))).map((row) => (
                <div key={`${row.time}-${row.label}`}>
                  <time>{row.time}</time>
                  <span>{row.label}</span>
                  <StatusPill tone={toPillTone(row.state)}>{row.state}</StatusPill>
                </div>
              ))}
            </div>
          </article>

          <article
            className="panel"
            data-vr10-verification-chain="ready"
            data-vr10-outcome={verificationOops?.outcome ?? "pending"}
          >
            <h2>Verification</h2>
            <dl>
              <div>
                <dt>Certificate</dt>
                <dd>{verificationOops?.certificateId ?? demoRun?.verification.certificateId ?? "pending"}</dd>
              </div>
              <div>
                <dt>Evidence</dt>
                <dd>{verificationEvidence[0]}</dd>
              </div>
              <div>
                <dt>Failure</dt>
                <dd>{verificationOops?.failure.message ?? "awaiting verification outcome"}</dd>
              </div>
              <div>
                <dt>Result</dt>
                <dd data-vr06-verification={demoRun?.verification.result ?? "pending"}>
                  {verificationOops?.outcome ?? demoRun?.verification.result ?? "not started"}
                </dd>
              </div>
            </dl>
            <ol className="trace-list">
              {verificationEvidence.map((evidence) => (
                <li key={evidence}>{evidence}</li>
              ))}
            </ol>
          </article>

          <article className="panel">
            <h2>Event Trace</h2>
            <ol className="trace-list">
              {traceEntries.map((row) => (
                <li key={row}>{row}</li>
              ))}
            </ol>
          </article>

          <article className="panel span-two" data-vr08-observation-boundary="ready">
            <h2>Observation Boundary</h2>
            <div className="observation-grid">
              {sensorPacket.observations.map((observation) => (
                <div key={`${observation.channel}-${observation.label}`}>
                  <span>{observation.label}</span>
                  <strong>{observation.value}</strong>
                </div>
              ))}
            </div>
            <div className="boundary-row">
              <span data-vr08-hidden-truth={String(sensorPacket.boundary.hiddenSimulatorTruthExposed)}>
                hidden truth blocked
              </span>
              <span data-vr08-backend-ids={String(sensorPacket.boundary.backendOnlyObjectIdsExposed)}>
                backend ids blocked
              </span>
              <span data-vr08-success-label={String(sensorPacket.boundary.groundTruthSuccessLabelExposed)}>
                success labels blocked
              </span>
            </div>
          </article>

          <article
            className="panel span-two"
            data-vr10-oops-loop="bounded"
            data-vr10-retry-remaining={verificationOops?.oopsLoop.retryBudgetRemaining ?? 2}
            data-vr10-manual-control={manualControlState}
          >
            <h2>Oops Loop</h2>
            <div className="oops-grid">
              <div>
                <span>Retry budget</span>
                <strong>
                  {verificationOops
                    ? `${verificationOops.oopsLoop.retryBudgetRemaining} / ${verificationOops.oopsLoop.retryBudgetMax}`
                    : "2 / 2"}
                </strong>
              </div>
              <div>
                <span>Correction proposal</span>
                <strong>{verificationOops?.oopsLoop.correctionProposal.action ?? "awaiting verification outcome"}</strong>
              </div>
              <div>
                <span>Safe hold</span>
                <strong>{manualControlState}</strong>
              </div>
            </div>
            <div className="control-strip">
              <button
                type="button"
                disabled={!verificationOops?.oopsLoop.boundedRetryAllowed}
                onClick={requestBoundedRetry}
              >
                Retry
              </button>
              <button type="button" onClick={() => setManualControlState("manual_stop")}>
                Stop
              </button>
              <button type="button" onClick={() => setManualControlState("safe_hold")}>
                Safe Hold
              </button>
            </div>
          </article>
        </section>

        <footer className="runtime-footer">
          <span>{VISUAL_RUNTIME_APP_DECISION.frontendRoot}</span>
          <span>{VISUAL_RUNTIME_APP_DECISION.browserSecretAccess}</span>
        </footer>
      </aside>
    </main>
  );
};
