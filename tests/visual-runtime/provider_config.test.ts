import { describe, expect, it } from "vitest";

import { loadVisualRuntimeProviderReadiness } from "../../apps/visual-runtime/backend/src/config/provider_config";

describe("loadVisualRuntimeProviderReadiness", () => {
  it("uses demo readiness when no provider key is configured", () => {
    expect(loadVisualRuntimeProviderReadiness({})).toEqual({
      mode: "demo_ready",
      providerConfigured: false,
      credentialConfigured: false,
      baseUrlConfigured: false,
      demoMode: "auto",
      browserReceivesProviderKey: false
    });
  });

  it("accepts a clearly fake safe test credential without exposing the value", () => {
    const readiness = loadVisualRuntimeProviderReadiness({
      LLM_PROVIDER: "openai",
      LLM_API_KEY: "MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY",
      LLM_MODEL: "safe-test-model",
      LLM_BASE_URL: "http://127.0.0.1:11434/v1"
    });

    expect(readiness).toEqual({
      mode: "provider_ready",
      providerConfigured: true,
      credentialConfigured: true,
      provider: "openai",
      model: "safe-test-model",
      baseUrlConfigured: true,
      demoMode: "auto",
      browserReceivesProviderKey: false
    });
    expect(JSON.stringify(readiness)).not.toContain("MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY");
  });

  it("forces demo readiness even when safe provider fields are present", () => {
    expect(
      loadVisualRuntimeProviderReadiness({
        LLM_PROVIDER: "gemini",
        LLM_API_KEY: "MEBSUTA_SAFE_FAKE_TEST_VALUE_ONLY",
        MEBSUTA_DEMO_MODE: "forced"
      })
    ).toMatchObject({
      mode: "demo_ready",
      providerConfigured: true,
      credentialConfigured: true,
      demoMode: "forced",
      browserReceivesProviderKey: false
    });
  });
});
