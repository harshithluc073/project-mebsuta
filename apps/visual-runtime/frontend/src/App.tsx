import { useEffect, useMemo, useState } from "react";

import { VISUAL_RUNTIME_APP_DECISION } from "../../shared/src/runtime_contracts";

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

const API_BASE_URL = "/api";

const fallbackRuntimeStatus: RuntimeStatus = {
  status: "local_backend_unavailable",
  mode: "demo_ready",
  commandBoundary: "awaiting_backend",
  worldSnapshotBoundary: "pending_visual_runtime_scene",
  eventStreamBoundary: "pending_runtime_events",
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
  "event stream reserved",
] as const;

const toStatusText = (value: boolean): string => (value ? "yes" : "no");

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
  const [taskText, setTaskText] = useState("Inspect the work cell and wait for a validated task.");
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>(fallbackRuntimeStatus);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>(fallbackProviderStatus);

  useEffect(() => {
    let active = true;

    const refreshStatus = async () => {
      const [runtime, provider] = await Promise.all([
        fetchJson<RuntimeStatus>("/runtime/status", fallbackRuntimeStatus),
        fetchJson<ProviderStatus>("/provider/status", fallbackProviderStatus),
      ]);

      if (active) {
        setRuntimeStatus(runtime);
        setProviderStatus(provider);
      }
    };

    void refreshStatus();

    return () => {
      active = false;
    };
  }, []);

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
        tone: runtimeStatus.mode === "provider_ready" ? "ready" : "quiet",
      },
      {
        label: "Provider",
        value: providerStatus.provider ?? "demo",
        tone: providerStatus.providerConfigured ? "ready" : "quiet",
      },
      {
        label: "Browser key",
        value: "blocked",
        tone: "ready",
      },
    ],
    [providerStatus.provider, providerStatus.providerConfigured, runtimeStatus.mode, runtimeStatus.status],
  );

  return (
    <main className="runtime-shell" data-runtime-shell="vr-04">
      <section className="workspace-region" aria-label="Robot and world workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Project Mebsuta</p>
            <h1>Visual Runtime Console</h1>
          </div>
          <div className="topbar-actions" aria-label="Runtime command controls">
            <button type="button">Submit</button>
            <button type="button">Hold</button>
            <button type="button">Reset</button>
          </div>
        </header>

        <section className="viewport-panel" aria-label="Robot world viewport">
          <div className="viewport-header">
            <span>Robot / World</span>
            <StatusPill tone="pending">scene pending VR-05</StatusPill>
          </div>
          <div className="viewport-frame">
            <div className="world-grid" />
            <div className="viewport-reticle" />
            <div className="zone zone-a">inspection zone</div>
            <div className="zone zone-b">target zone</div>
            <div className="robot-anchor">
              <span />
              <strong>robot origin</strong>
            </div>
          </div>
        </section>

        <section className="task-panel" aria-label="Task input panel">
          <label htmlFor="task-input">Task</label>
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
              {planRows.map(([id, label, state]) => (
                <div key={id}>
                  <span>{id}</span>
                  <strong>{label}</strong>
                  <StatusPill tone={state === "queued" ? "ready" : "pending"}>{state}</StatusPill>
                </div>
              ))}
            </div>
          </article>

          <article className="panel">
            <h2>Validation</h2>
            <div className="compact-list">
              {validationRows.map(([label, state]) => (
                <div key={label}>
                  <span>{label}</span>
                  <StatusPill tone="pending">{state}</StatusPill>
                </div>
              ))}
            </div>
          </article>

          <article className="panel">
            <h2>Execution</h2>
            <div className="timeline">
              {executionRows.map(([time, label, state]) => (
                <div key={`${time}-${label}`}>
                  <time>{time}</time>
                  <span>{label}</span>
                  <StatusPill tone={state === "ready" ? "ready" : "pending"}>{state}</StatusPill>
                </div>
              ))}
            </div>
          </article>

          <article className="panel">
            <h2>Verification</h2>
            <dl>
              <div>
                <dt>Certificate</dt>
                <dd>pending</dd>
              </div>
              <div>
                <dt>Evidence</dt>
                <dd>awaiting task</dd>
              </div>
              <div>
                <dt>Result</dt>
                <dd>not started</dd>
              </div>
            </dl>
          </article>

          <article className="panel">
            <h2>Event Trace</h2>
            <ol className="trace-list">
              {traceRows.map((row) => (
                <li key={row}>{row}</li>
              ))}
            </ol>
          </article>

          <article className="panel span-two">
            <h2>Oops Loop</h2>
            <div className="oops-grid">
              <div>
                <span>Retry budget</span>
                <strong>3</strong>
              </div>
              <div>
                <span>Correction</span>
                <strong>idle</strong>
              </div>
              <div>
                <span>Safe hold</span>
                <strong>armed</strong>
              </div>
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
