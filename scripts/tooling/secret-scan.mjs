import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = [
  "package.json",
  ".npmrc",
  "tsconfig.base.json",
  "tsconfig.src.json",
  "tsconfig.test.json",
  "eslint.config.mjs",
  "prettier.config.mjs",
  "vitest.config.ts",
  "scripts"
];
const ignoredDirectories = new Set(["node_modules", "dist", "coverage", ".vitest"]);
const secretPatterns = [
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "aws access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "github token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/ },
  { label: "openai key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { label: "password assignment", pattern: /\bpassword\s*[:=]\s*["'][^"']+["']/i },
  { label: "secret assignment", pattern: /\bsecret\s*[:=]\s*["'][^"']+["']/i },
  { label: "token assignment", pattern: /\btoken\s*[:=]\s*["'][^"']+["']/i }
];

async function listFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) {
          return [];
        }
        return listFiles(entryPath);
      }
      return [entryPath];
    })
  );

  return nested.flat();
}

const files = [];
for (const root of roots) {
  try {
    const rootFiles = await listFiles(root);
    files.push(...rootFiles);
  } catch {
    files.push(root);
  }
}

const findings = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    secretPatterns.forEach((secretPattern) => {
      if (secretPattern.pattern.test(line)) {
        findings.push(`${file}:${index + 1}: ${secretPattern.label}`);
      }
    });
  });
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
}
