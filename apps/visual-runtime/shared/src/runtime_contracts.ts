export type VisualRuntimeSurface = "frontend" | "backend" | "shared";

export type VisualRuntimeMode = "demo_ready" | "provider_unconfigured";

export interface VisualRuntimeAppDecision {
  readonly appRoot: "apps/visual-runtime";
  readonly frontendRoot: "apps/visual-runtime/frontend";
  readonly backendRoot: "apps/visual-runtime/backend";
  readonly sharedRoot: "apps/visual-runtime/shared";
  readonly publicSourceSafe: true;
  readonly browserSecretAccess: "forbidden";
}

export interface VisualRuntimeHealthSnapshot {
  readonly app: "project-mebsuta-visual-runtime";
  readonly status: "scaffold_ready";
  readonly mode: VisualRuntimeMode;
  readonly surfaces: readonly VisualRuntimeSurface[];
  readonly browserReceivesProviderKey: false;
}

export const VISUAL_RUNTIME_APP_DECISION: VisualRuntimeAppDecision = {
  appRoot: "apps/visual-runtime",
  frontendRoot: "apps/visual-runtime/frontend",
  backendRoot: "apps/visual-runtime/backend",
  sharedRoot: "apps/visual-runtime/shared",
  publicSourceSafe: true,
  browserSecretAccess: "forbidden",
};

export const createVisualRuntimeHealthSnapshot = (): VisualRuntimeHealthSnapshot => ({
  app: "project-mebsuta-visual-runtime",
  status: "scaffold_ready",
  mode: "provider_unconfigured",
  surfaces: ["frontend", "backend", "shared"],
  browserReceivesProviderKey: false,
});
