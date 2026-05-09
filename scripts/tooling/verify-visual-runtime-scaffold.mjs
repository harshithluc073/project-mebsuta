import { existsSync, readFileSync } from "node:fs";

const requiredFiles = [
  "apps/visual-runtime/frontend/index.html",
  "apps/visual-runtime/frontend/vite.config.mts",
  "apps/visual-runtime/frontend/src/App.tsx",
  "apps/visual-runtime/frontend/src/main.tsx",
  "apps/visual-runtime/frontend/src/styles.css",
  "apps/visual-runtime/backend/src/server.ts",
  "apps/visual-runtime/shared/src/runtime_contracts.ts",
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

if (frontendSource.includes("LLM_API_KEY") || backendSource.includes("LLM_API_KEY")) {
  throw new Error("Visual runtime scaffold must not reference provider key variables in VR-01.");
}

console.info("VISUAL_RUNTIME_SCAFFOLD_OK");
