import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const srcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(srcDir, "../../..");
const defaultAxlApiUrl = "http://127.0.0.1:9002";
const defaultAxlRouterUrl = "http://127.0.0.1:9003";
const defaultMcpPort = 9102;

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

export type GensynAxlPreflightOptions = {
  axlApiUrl?: string;
  axlRouterUrl?: string;
  mcpPort?: number;
  configPath?: string;
  timeoutMs?: number;
};

export async function runGensynAxlPreflight(options: GensynAxlPreflightOptions = {}): Promise<void> {
  const axlApiUrl = normalizeUrl(options.axlApiUrl ?? process.env.AXL_API_URL ?? defaultAxlApiUrl);
  const axlRouterUrl = normalizeUrl(options.axlRouterUrl ?? process.env.AXL_ROUTER_URL ?? defaultAxlRouterUrl);
  const mcpPort = options.mcpPort ?? Number(process.env.MCP_PORT ?? defaultMcpPort);
  const configPath = options.configPath ?? process.env.GENSYN_AXL_CONFIG_PATH ?? resolve(repoRoot, "packages/axl-bin/node-config.agent-a.json");
  const timeoutMs = options.timeoutMs ?? Number(process.env.GENSYN_AXL_PREFLIGHT_TIMEOUT_MS ?? "3000");

  const results = await Promise.all([
    checkAxlTopology(axlApiUrl, timeoutMs),
    checkRouterReachable(axlRouterUrl, timeoutMs),
    checkMcpPortAvailable(mcpPort),
    checkAxlConfig(configPath)
  ]);

  for (const result of results) {
    console.log(`${result.ok ? "✓" : "✗"} ${result.name}: ${result.detail}`);
  }

  const failures = results.filter((result) => !result.ok);

  if (failures.length > 0) {
    throw new Error(
      `Gensyn AXL preflight failed. Start the real AXL node and MCP router, then retry. Expected bridge=${axlApiUrl}, router=${axlRouterUrl}, MCP port=${mcpPort}.`
    );
  }

  console.log("✓ real Gensyn AXL preflight passed");
}

async function checkAxlTopology(axlApiUrl: string, timeoutMs: number): Promise<CheckResult> {
  const url = `${axlApiUrl}/topology`;

  try {
    const response = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
    const text = await response.text();

    if (!response.ok) {
      return { name: "AXL bridge /topology", ok: false, detail: `HTTP ${response.status} ${response.statusText}: ${text}` };
    }

    const topology = text ? (JSON.parse(text) as unknown) : null;
    const peerCount = Array.isArray((topology as { peers?: unknown })?.peers) ? (topology as { peers: unknown[] }).peers.length : "unknown";
    return { name: "AXL bridge /topology", ok: true, detail: `reachable at ${url}, peers=${peerCount}` };
  } catch (error) {
    return { name: "AXL bridge /topology", ok: false, detail: formatError(error) };
  }
}

async function checkRouterReachable(axlRouterUrl: string, timeoutMs: number): Promise<CheckResult> {
  try {
    const response = await fetchWithTimeout(axlRouterUrl, { method: "HEAD" }, timeoutMs);
    return { name: "AXL MCP router", ok: true, detail: `HTTP server reachable at ${axlRouterUrl} (${response.status} ${response.statusText})` };
  } catch (error) {
    return { name: "AXL MCP router", ok: false, detail: formatError(error) };
  }
}

async function checkMcpPortAvailable(port: number): Promise<CheckResult> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { name: "Agent MCP port", ok: false, detail: `invalid MCP_PORT=${port}` };
  }

  return new Promise((resolveResult) => {
    const server = createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      resolveResult({ name: "Agent MCP port", ok: false, detail: `127.0.0.1:${port} unavailable (${error.code ?? error.message})` });
    });

    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveResult({ name: "Agent MCP port", ok: true, detail: `127.0.0.1:${port} available for local MCP callback` }));
    });
  });
}

async function checkAxlConfig(configPath: string): Promise<CheckResult> {
  try {
    const raw = await readFile(configPath, "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const hasPrivateKeyPath = typeof config.PrivateKeyPath === "string" && config.PrivateKeyPath.length > 0;
    const hasRouter = typeof config.router_addr === "string" && typeof config.router_port === "number";

    if (!hasPrivateKeyPath || !hasRouter) {
      return { name: "AXL node config", ok: false, detail: `${configPath} is missing PrivateKeyPath/router_addr/router_port` };
    }

    return { name: "AXL node config", ok: true, detail: `${configPath} parses with PrivateKeyPath=${config.PrivateKeyPath}` };
  } catch (error) {
    return { name: "AXL node config", ok: false, detail: formatError(error) };
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const cause = isErrorWithCause(error) ? error.cause : undefined;

    if (cause instanceof Error) {
      return `${error.message}: ${cause.message}`;
    }

    if (isNodeError(cause)) {
      return `${error.message}: ${cause.code ?? ""} ${cause.message}`.trim();
    }

    return error.message;
  }

  return String(error);
}

function isErrorWithCause(error: Error): error is Error & { cause: unknown } {
  return "cause" in error;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "message" in error;
}

dotenv.config({ path: resolve(repoRoot, ".env") });
dotenv.config();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGensynAxlPreflight().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
