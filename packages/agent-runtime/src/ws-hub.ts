import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { WsEvent } from "@darkpool/shared";
import { readJson, sendJson } from "./http.js";

export type WsHubOptions = {
  port: number;
  history?: number;
};

export type RunningWsHub = {
  port: number;
  publishUrl: string;
  wsUrl: string;
  publish(event: WsEvent): void;
  close(): Promise<void>;
};

export async function startWsHub(options: WsHubOptions): Promise<RunningWsHub> {
  const historyLimit = options.history ?? 200;
  const history: WsEvent[] = [];
  const clients = new Set<WebSocket>();

  const httpServer = createServer(async (req, res) => {
    try {
      if (!req.url) {
        sendJson(res, 404, { ok: false, error: "Missing URL" });
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { ok: true, clients: clients.size, events: history.length });
        return;
      }

      if (req.method === "GET" && req.url === "/events") {
        sendJson(res, 200, { events: history });
        return;
      }

      if (req.method === "POST" && req.url === "/publish") {
        const event = await readJson<WsEvent>(req);
        broadcast(event);
        sendJson(res, 202, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: `Route not found: ${req.method} ${req.url}` });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (socket: WebSocket, _request: IncomingMessage) => {
    clients.add(socket);

    for (const event of history) {
      socket.send(JSON.stringify(event));
    }

    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  await new Promise<void>((resolveListen) => httpServer.listen(options.port, resolveListen));

  const publishUrl = `http://127.0.0.1:${options.port}/publish`;
  const wsUrl = `ws://127.0.0.1:${options.port}/ws`;

  console.log(`[ws-hub] listening on ${wsUrl} (publish via POST ${publishUrl})`);

  function broadcast(event: WsEvent): void {
    history.push(event);

    while (history.length > historyLimit) {
      history.shift();
    }

    const payload = JSON.stringify(event);

    for (const socket of clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }

  return {
    port: options.port,
    publishUrl,
    wsUrl,
    publish: broadcast,
    close: () =>
      new Promise((resolveClose, reject) => {
        for (const socket of clients) {
          socket.close();
        }

        wss.close();
        httpServer.close((error) => (error ? reject(error) : resolveClose()));
      })
  };
}

async function main(): Promise<void> {
  const port = Number(process.env.WS_HUB_PORT ?? "8787");
  await startWsHub({ port });
  console.log("[ws-hub] started. Press Ctrl+C to stop.");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
