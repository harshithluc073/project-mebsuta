import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = [
  ".npmrc",
  ".nvmrc",
  ".node-version",
  ".gitignore",
  ".editorconfig",
  ".prettierignore",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "tsconfig.src.json",
  "tsconfig.test.json",
  "eslint.config.mjs",
  "prettier.config.mjs",
  "vitest.config.ts",
  "scripts"
];

const ignoredDirectories = new Set(["node_modules", "dist", "coverage", ".vitest"]);
const blockedTerms = [
  ["task-marker", ["T", "O", "D", "O"]],
  ["repair-marker", ["F", "I", "X", "M", "E"]],
  ["undecided-marker", ["T", "B", "D"]],
  ["synthetic-marker", ["d", "u", "m", "m", "y"]],
  ["synthetic-marker", ["f", "a", "k", "e"]],
  ["shortcut-marker", ["h", "a", "c", "k"]],
  ["missing-implementation-marker", ["not", "implemented"]]
].map(([label, parts]) => ({
  label,
  pattern: new RegExp(`\\b${parts.join(parts.length === 2 ? "\\s+" : "")}\\b`, "i")
}));

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
    blockedTerms.forEach((term) => {
      if (term.pattern.test(line)) {
        findings.push(`${file}:${index + 1}: ${term.label}`);
      }
    });
  });
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
}
