export type VisualRuntimeProviderName = "openai" | "gemini" | "anthropic" | "local_compatible";

export type VisualRuntimeDemoMode = "auto" | "forced";

export interface VisualRuntimeProviderConfigInput {
  readonly LLM_PROVIDER?: string;
  readonly LLM_API_KEY?: string;
  readonly LLM_MODEL?: string;
  readonly LLM_BASE_URL?: string;
  readonly MEBSUTA_DEMO_MODE?: string;
}

export interface VisualRuntimeProviderReadiness {
  readonly mode: "demo_ready" | "provider_ready";
  readonly providerConfigured: boolean;
  readonly credentialConfigured: boolean;
  readonly provider?: VisualRuntimeProviderName;
  readonly model?: string;
  readonly baseUrlConfigured: boolean;
  readonly demoMode: VisualRuntimeDemoMode;
  readonly browserReceivesProviderKey: false;
}

const PROVIDERS = new Set<VisualRuntimeProviderName>([
  "openai",
  "gemini",
  "anthropic",
  "local_compatible",
]);

const trimOptional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const parseProvider = (value: string | undefined): VisualRuntimeProviderName | undefined => {
  const normalized = trimOptional(value)?.toLowerCase();
  if (!normalized || !PROVIDERS.has(normalized as VisualRuntimeProviderName)) {
    return undefined;
  }

  return normalized as VisualRuntimeProviderName;
};

const parseDemoMode = (value: string | undefined): VisualRuntimeDemoMode => {
  const normalized = trimOptional(value)?.toLowerCase();
  return normalized === "true" || normalized === "forced" ? "forced" : "auto";
};

export const loadVisualRuntimeProviderReadiness = (
  input: VisualRuntimeProviderConfigInput = process.env,
): VisualRuntimeProviderReadiness => {
  const provider = parseProvider(input.LLM_PROVIDER);
  const credentialConfigured = Boolean(trimOptional(input.LLM_API_KEY));
  const model = trimOptional(input.LLM_MODEL);
  const baseUrlConfigured = Boolean(trimOptional(input.LLM_BASE_URL));
  const demoMode = parseDemoMode(input.MEBSUTA_DEMO_MODE);
  const providerReady = Boolean(provider && credentialConfigured && demoMode !== "forced");

  return {
    mode: providerReady ? "provider_ready" : "demo_ready",
    providerConfigured: Boolean(provider),
    credentialConfigured,
    provider,
    model,
    baseUrlConfigured,
    demoMode,
    browserReceivesProviderKey: false,
  };
};
