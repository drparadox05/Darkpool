import { randomUUID } from "node:crypto";
import { DEFAULT_AXL_API_URL, withLocalFallback } from "./axl-url";

type JsonRpcResponse<T> = {
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export type McpCallParams = {
  peerId: string;
  service: string;
  tool: string;
  args: Record<string, unknown>;
  errorPrefix: string;
};

export type McpCallResult<T> =
  | { ok: true; result: T }
  | { ok: false; status: number; error: string };

export async function callMcpTool<T>(params: McpCallParams): Promise<McpCallResult<T>> {
  const axlUrls = withLocalFallback(process.env.AXL_API_URL || DEFAULT_AXL_API_URL, DEFAULT_AXL_API_URL);
  const failures: string[] = [];

  for (const url of axlUrls) {
    try {
      return await callMcpToolAtUrl<T>(url, params);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ok: false, status: 502, error: `${params.errorPrefix}: ${failures.join(" | ")}` };
}

async function callMcpToolAtUrl<T>(axlUrl: string, params: McpCallParams): Promise<McpCallResult<T>> {
  const response = await fetch(
    `${axlUrl}/mcp/${encodeURIComponent(params.peerId)}/${encodeURIComponent(params.service)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        id: randomUUID(),
        params: {
          name: params.tool,
          arguments: params.args
        }
      })
    }
  );

  const rawText = await response.text();

  if (!response.ok) {
    return { ok: false, status: 502, error: `${params.errorPrefix}: HTTP ${response.status} ${response.statusText}: ${rawText}` };
  }

  const parsed = parseJsonRpcResponse(rawText);

  if (parsed.error) {
    return { ok: false, status: 502, error: parsed.error.message ?? `${params.errorPrefix} with JSON-RPC error` };
  }

  return { ok: true, result: decodeMcpResult<T>(parsed.result) };
}

function decodeMcpResult<T>(result: unknown): T {
  if (isRecord(result)) {
    if ("structuredContent" in result) {
      return result.structuredContent as T;
    }

    if (Array.isArray(result.content)) {
      const textPart = result.content.find((part) => isRecord(part) && typeof part.text === "string");

      if (isRecord(textPart) && typeof textPart.text === "string") {
        try {
          return JSON.parse(textPart.text) as T;
        } catch {
          return textPart.text as T;
        }
      }
    }
  }

  return result as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJsonRpcResponse(rawText: string): JsonRpcResponse<unknown> {
  try {
    return JSON.parse(rawText) as JsonRpcResponse<unknown>;
  } catch {
    return { error: { message: `Invalid JSON-RPC response: ${rawText.slice(0, 240)}` } };
  }
}
