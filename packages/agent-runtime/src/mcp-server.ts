import { createServer, type Server } from "node:http";
import type { AgentProfile, McpToolCall, McpToolDefinition, McpToolResult } from "@darkpool/shared";
import type { AxlClient } from "./axl-client.js";
import { readJson, sendJson } from "./http.js";

export type ToolContext = {
  call: McpToolCall;
  profile: AgentProfile;
};

export type ToolRegistration = {
  definition: McpToolDefinition;
  handler: (input: unknown, context: ToolContext) => Promise<unknown> | unknown;
};

export type DarkpoolMcpServerOptions = {
  profile: AgentProfile;
  axlClient: AxlClient;
  port: number;
  callbackUrl?: string;
  tools?: ToolRegistration[];
};

export type RunningMcpServer = {
  server: Server;
  callbackUrl: string;
  close: () => Promise<void>;
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export async function startDarkpoolMcpServer(options: DarkpoolMcpServerOptions): Promise<RunningMcpServer> {
  const callbackUrl = options.callbackUrl ?? `http://127.0.0.1:${options.port}`;
  const tools = new Map((options.tools ?? [createPingTool(options.profile)]).map((tool) => [tool.definition.name, tool]));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", callbackUrl);

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, agent: options.profile.ensName });
        return;
      }

      if (req.method === "GET" && url.pathname === "/tools/list") {
        sendJson(res, 200, { service: "darkpool", tools: [...tools.values()].map((tool) => tool.definition) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/mcp") {
        const request = await readJson<JsonRpcRequest>(req);
        const result = await handleJsonRpcMcpRequest(request, tools, options.profile);
        sendJson(res, result.status, result.body);
        return;
      }

      if (req.method === "POST" && url.pathname === "/tools/call") {
        const call = await readJson<McpToolCall>(req);
        const tool = tools.get(call.tool);

        if (!tool) {
          const result: McpToolResult = { id: call.id, ok: false, error: `Unknown tool ${call.tool}` };
          sendJson(res, 404, result);
          return;
        }

        const result = await handleDirectToolCall(call, tool, options.profile);
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { ok: false, error: `Route not found: ${req.method} ${url.pathname}` });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: errorMessage(error, "MCP request failed") });
    }
  });

  await new Promise<void>((resolveListen) => server.listen(options.port, resolveListen));

  await options.axlClient.registerMcp({
    service: "darkpool",
    callbackUrl,
    endpoint: `${callbackUrl.replace(/\/$/, "")}/mcp`,
    tools: [...tools.values()].map((tool) => tool.definition)
  });

  return {
    server,
    callbackUrl,
    close: async () => {
      await options.axlClient.deregisterMcp("darkpool").catch(() => undefined);
      await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    }
  };
}

async function handleDirectToolCall(call: McpToolCall, tool: ToolRegistration, profile: AgentProfile): Promise<McpToolResult> {
  try {
    const output = await tool.handler(call.input, { call, profile });
    return { id: call.id, ok: true, result: output };
  } catch (error) {
    return { id: call.id, ok: false, error: errorMessage(error, `Tool ${call.tool} failed`) };
  }
}

async function handleJsonRpcMcpRequest(
  request: JsonRpcRequest,
  tools: Map<string, ToolRegistration>,
  profile: AgentProfile
): Promise<{ status: number; body: unknown }> {
  const id = request.id ?? null;

  if (request.method === "tools/list") {
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: { tools: [...tools.values()].map((tool) => tool.definition) }
      }
    };
  }

  if (request.method === "tools/call") {
    const name = typeof request.params?.name === "string" ? request.params.name : typeof request.params?.tool === "string" ? request.params.tool : "";
    const tool = tools.get(name);

    if (!tool) {
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool ${name || "<missing>"}` }
        }
      };
    }

    let output: unknown;

    try {
      output = await tool.handler(request.params?.arguments, {
        profile,
        call: {
          id: String(id ?? ""),
          service: "darkpool",
          tool: name,
          input: request.params?.arguments,
          from: "gensyn-axl",
          to: profile.peerId
        }
      });
    } catch (error) {
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: errorMessage(error, `Tool ${name} failed`),
            data: { tool: name }
          }
        }
      };
    }

    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output
        }
      }
    };
  }

  return {
    status: 200,
    body: {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unsupported MCP method ${request.method ?? "<missing>"}` }
    }
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  const message = String(error);
  return message ? message : fallback;
}

export function createPingTool(profile: AgentProfile): ToolRegistration {
  return {
    definition: {
      name: "ping",
      description: "Return a signed-off liveness response from a darkpool agent.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
          pair: { type: "string" }
        }
      }
    },
    handler: (input, context) => ({
      pong: true,
      from: profile.ensName,
      peerId: profile.peerId,
      role: profile.role,
      receivedFrom: context.call.from,
      receivedAt: new Date().toISOString(),
      echo: input
    })
  };
}
