import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createVisualRuntimeObservabilityAuditSnapshot,
  redactVisualRuntimeTraceText,
} from "../../apps/visual-runtime/backend/src/observability_surface";
import { createVisualRuntimeServer } from "../../apps/visual-runtime/backend/src/server";
import { App } from "../../apps/visual-runtime/frontend/src/App";

const fixedTimestamp = "2026-05-10T12:00:00.000Z";
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

describe("visual runtime memory, replay, and observability surfaces", () => {
  it("builds a replay surface with the same state progression", () => {
    const snapshot = createVisualRuntimeObservabilityAuditSnapshot({
      taskId: "inspect_work_cell",
      now: () => fixedTimestamp,
    });

    expect(snapshot.auditId).toBe("vr-11-audit-inspect_work_cell");
    expect(snapshot.replay.stateProgressionMatches).toBe(true);
    expect(snapshot.replay.stateProgression).toEqual(snapshot.replay.replayedStateProgression);
    expect(snapshot.memoryWrites[0]?.authority).toBe("verification_certificate");
    expect(snapshot.verificationEvidence.length).toBeGreaterThan(0);
    expect(snapshot.oopsEpisode.autoCorrectionAllowed).toBe(false);
    expect(snapshot.browserReceivesProviderKey).toBe(false);
  });

  it("redacts trace text before replay exposure", () => {
    const redacted = redactVisualRuntimeTraceText(
      "provider key=MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY remained backend-only",
    );

    expect(redacted.redactionApplied).toBe(true);
    expect(redacted.text).toContain("[redacted]");
    expect(redacted.text).not.toContain("MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY");
  });

  it("keeps API key material out of replay snapshots", () => {
    const snapshot = createVisualRuntimeObservabilityAuditSnapshot({
      taskId: "deliver_payload_case",
      now: () => fixedTimestamp,
      traceInputs: ["provider key=MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY"],
    });
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.replay.apiKeyPresentInReplay).toBe(false);
    expect(serialized).not.toContain("MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY");
    expect(serialized).toContain("[redacted]");
  });

  it("serves the audit snapshot through the local backend boundary", async () => {
    const server = createVisualRuntimeServer({
      now: () => fixedTimestamp,
    });
    openServers.push(server);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/observability/audit?taskId=return_to_charger`,
    );
    expect(response.ok).toBe(true);
    const snapshot = (await response.json()) as ReturnType<typeof createVisualRuntimeObservabilityAuditSnapshot>;

    expect(snapshot.auditId).toBe("vr-11-audit-return_to_charger");
    expect(snapshot.eventStream.map((event) => event.surface)).toContain("redacted_trace");
    expect(snapshot.replay.stateProgressionMatches).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY");
  });

  it("renders VR-11 audit surfaces in the UI shell", () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain('data-vr11-audit-surface="ready"');
    expect(markup).toContain('data-vr11-event-stream="ready"');
    expect(markup).toContain('data-vr11-memory-write="ready"');
    expect(markup).toContain('data-vr11-plan-history="ready"');
    expect(markup).toContain('data-vr11-verification-evidence="ready"');
    expect(markup).toContain('data-vr11-oops-episode="ready"');
    expect(markup).toContain('data-vr11-redacted-trace="ready"');
    expect(markup).not.toContain("MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY");
  });
});
