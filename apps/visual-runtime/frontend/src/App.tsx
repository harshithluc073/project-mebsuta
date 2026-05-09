import { VISUAL_RUNTIME_APP_DECISION, createVisualRuntimeHealthSnapshot } from "../../shared/src/runtime_contracts";

import "./styles.css";

const health = createVisualRuntimeHealthSnapshot();

const surfaces = health.surfaces.map((surface) => (
  <li key={surface}>
    <span>{surface}</span>
    <strong>ready</strong>
  </li>
));

export const App = () => (
  <main className="runtime-shell">
    <section className="runtime-viewport" aria-label="Visual runtime viewport">
      <div className="viewport-frame">
        <div className="viewport-grid" />
        <div className="runtime-badge">VR-01</div>
      </div>
    </section>

    <aside className="runtime-panel" aria-label="Runtime scaffold status">
      <header>
        <p>Project Mebsuta</p>
        <h1>Visual Runtime</h1>
      </header>

      <dl className="status-list">
        <div>
          <dt>Status</dt>
          <dd>{health.status}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{health.mode}</dd>
        </div>
        <div>
          <dt>App Root</dt>
          <dd>{VISUAL_RUNTIME_APP_DECISION.appRoot}</dd>
        </div>
        <div>
          <dt>Browser Key Access</dt>
          <dd>{VISUAL_RUNTIME_APP_DECISION.browserSecretAccess}</dd>
        </div>
      </dl>

      <ul className="surface-list">{surfaces}</ul>
    </aside>
  </main>
);
