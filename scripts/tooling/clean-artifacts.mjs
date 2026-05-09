import { rm } from "node:fs/promises";

const generatedPaths = ["dist", "coverage", ".vitest"];

await Promise.all(
  generatedPaths.map((path) =>
    rm(path, {
      force: true,
      recursive: true
    })
  )
);
