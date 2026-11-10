import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Local stand-in for the CAIL Gateway, started by the scaffold before Zotero
 * and driven from inside Zotero over plain HTTP:
 *   POST /__control  {responses: [...], catalog?}  script replies (last one
 *                                    repeats), reset log, optionally set GET /v1/catalog
 *   GET  /__log                           requests seen so far
 * Everything else under /v1/ consumes the next scripted response.
 */
export interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Hold the reply for this long so tests can abort mid-request. */
  delayMs?: number;
}

let catalog: unknown = { object: "list", data: [] };

export async function startStubServer(): Promise<http.Server> {
  let responses: ScriptedResponse[] = [];
  let log: Array<{
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
    closedEarly: boolean;
  }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/__control") {
        const control = JSON.parse(body);
        responses = control.responses ?? [];
        if (control.catalog !== undefined) catalog = control.catalog;
        log = [];
        res.end("{}");
        return;
      }
      if (req.url === "/__log") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(log));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/catalog") {
        // Public catalog; kept out of the chat request log.
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(catalog));
        return;
      }
      const entry = {
        url: req.url || "",
        headers: req.headers,
        body,
        closedEarly: false,
      };
      log.push(entry);
      res.on("close", () => {
        if (!res.writableFinished) entry.closedEarly = true;
      });
      const scripted =
        responses[Math.min(log.length, responses.length) - 1] ||
        ({ status: 500 } as ScriptedResponse);
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(scripted.status, {
          "Content-Type": "application/json",
          ...scripted.headers,
        });
        res.end(JSON.stringify(scripted.body ?? {}));
      }, scripted.delayMs || 0);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  process.env.METADATA_ASSISTANT_STUB_PORT = String(
    (server.address() as AddressInfo).port,
  );
  return server;
}
