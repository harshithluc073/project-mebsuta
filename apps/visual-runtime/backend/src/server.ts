import { ServerResponse, createServer } from "node:http";
import { pathToFileURL } from "node:url";

import {
  VISUAL_RUNTIME_APP_DECISION,
  createVisualRuntimeHealthSnapshot,
} from "../../shared/src/runtime_contracts";

const DEFAULT_PORT = 4178;

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void => {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "http://localhost:5178",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
};

export const createVisualRuntimeServer = () =>
  createServer((request, response) => {
    if (request.url === "/health") {
      writeJson(response, 200, createVisualRuntimeHealthSnapshot());
      return;
    }

    if (request.url === "/app-decision") {
      writeJson(response, 200, VISUAL_RUNTIME_APP_DECISION);
      return;
    }

    writeJson(response, 404, {
      error: "not_found",
      status: "scaffold_ready",
    });
  });

export const startVisualRuntimeServer = (port = DEFAULT_PORT): void => {
  const server = createVisualRuntimeServer();

  server.listen(port, "127.0.0.1", () => {
    console.info(`Project Mebsuta visual runtime backend listening on http://127.0.0.1:${port}`);
  });
};

const entrypointUrl = pathToFileURL(process.argv[1] ?? "").href;

if (import.meta.url === entrypointUrl) {
  startVisualRuntimeServer();
}
