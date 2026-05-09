import { existsSync, readFileSync } from "node:fs";

const requiredFiles = [
  ".env.example",
  "apps/visual-runtime/frontend/index.html",
  "apps/visual-runtime/frontend/vite.config.mts",
  "apps/visual-runtime/frontend/src/App.tsx",
  "apps/visual-runtime/frontend/src/main.tsx",
  "apps/visual-runtime/frontend/src/styles.css",
  "apps/visual-runtime/backend/src/server.ts",
  "apps/visual-runtime/backend/src/config/provider_config.ts",
  "apps/visual-runtime/shared/src/runtime_contracts.ts",
  "tests/visual-runtime/provider_config.test.ts",
  "tsconfig.visual-runtime.json"
];

const missingFiles = requiredFiles.filter((filePath) => !existsSync(filePath));

if (missingFiles.length > 0) {
  throw new Error(`Visual runtime scaffold is missing required files: ${missingFiles.join(", ")}`);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const requiredScripts = [
  "typecheck:visual-runtime",
  "build:visual-runtime:frontend",
  "dev:visual-runtime:frontend",
  "dev:visual-runtime:backend",
  "verify:visual-runtime"
];

const missingScripts = requiredScripts.filter((scriptName) => !packageJson.scripts?.[scriptName]);

if (missingScripts.length > 0) {
  throw new Error(`Visual runtime scaffold is missing scripts: ${missingScripts.join(", ")}`);
}

const frontendSource = readFileSync("apps/visual-runtime/frontend/src/App.tsx", "utf8");
const backendSource = readFileSync("apps/visual-runtime/backend/src/server.ts", "utf8");
const providerConfigSource = readFileSync(
  "apps/visual-runtime/backend/src/config/provider_config.ts",
  "utf8"
);
const envExample = readFileSync(".env.example", "utf8");

const expectedEnvNames = [
  "LLM_PROVIDER=",
  "LLM_API_KEY=",
  "LLM_MODEL=",
  "LLM_BASE_URL=",
  "MEBSUTA_DEMO_MODE="
];

const missingEnvNames = expectedEnvNames.filter((name) => !envExample.includes(name));

if (missingEnvNames.length > 0) {
  throw new Error(`.env.example is missing safe variable names: ${missingEnvNames.join(", ")}`);
}

if (frontendSource.includes("LLM_API_KEY") || frontendSource.includes("VITE_")) {
  throw new Error("Visual runtime frontend must not reference provider key variables.");
}

if (!backendSource.includes("createVisualRuntimeHealthSnapshot")) {
  throw new Error("Visual runtime backend scaffold health surface is missing.");
}

if (!providerConfigSource.includes("browserReceivesProviderKey: false")) {
  throw new Error("Visual runtime provider config must preserve the browser secret boundary.");
}

console.info("VISUAL_RUNTIME_SCAFFOLD_OK");
