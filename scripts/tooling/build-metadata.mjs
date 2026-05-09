import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const lockfile = await readFile("package-lock.json", "utf8");
const lockfileSha256 = createHash("sha256").update(lockfile).digest("hex");

const commandOutput = (command, args) => {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "unavailable";
  }
};

const metadata = {
  projectName: packageJson.name,
  packageVersion: packageJson.version,
  buildTimestamp: new Date().toISOString(),
  nodeVersion: process.version,
  npmVersion: commandOutput("npm", ["--version"]),
  typescriptVersion: commandOutput("npx", ["tsc", "--version"]),
  packageManager: packageJson.packageManager,
  lockfileSha256,
  buildTarget: "source-contracts",
  runtimeModeCompatibility: ["local", "ci"],
  validationCommands: ["typecheck", "lint", "test", "scan:secrets", "scan:placeholders"]
};

await mkdir("dist/metadata", { recursive: true });
await writeFile("dist/metadata/build-manifest.json", `${JSON.stringify(metadata, null, 2)}\n`);
