import { createHash, randomUUID } from "node:crypto";
import { JsonRpcProvider, Wallet } from "ethers";
import type { ComputeRequest, ComputeResponse } from "@darkpool/shared";

export type ComputeClient = {
  complete(request: ComputeRequest): Promise<ComputeResponse>;
};

export type ComputeClientInfo = {
  provider: string;
  model: string;
  serviceProviderAddress?: string;
  verifyResponses?: boolean;
};

export type ComputeClientOptions = {
  provider?: "local" | "0g";
  model?: string;
  rpcUrl?: string;
  privateKey?: string;
  serviceProviderAddress?: string;
  verifyResponses?: boolean;
};

export class LocalDeterministicComputeClient implements ComputeClient {
  readonly provider = "local-deterministic";
  readonly model: string;

  constructor(model = "darkpool-local-strategy-v1") {
    this.model = model;
  }

  async complete(request: ComputeRequest): Promise<ComputeResponse> {
    const prompt = request.messages.map((message) => `${message.role}: ${message.content}`).join("\n");
    const digest = createHash("sha256").update(prompt).digest("hex").slice(0, 12);

    return {
      content: `local-compute:${digest}: quote conservatively, preserve atomic settlement compatibility, and explain risk constraints.`,
      provider: this.provider,
      model: this.model,
      requestId: randomUUID()
    };
  }
}

export class ZeroGComputeClient implements ComputeClient {
  readonly provider = "0g";
  readonly model: string;
  private readonly rpcUrl: string;
  private readonly privateKey: string;
  readonly serviceProviderAddress: string;
  readonly verifyResponses: boolean;

  constructor(options: Required<Pick<ComputeClientOptions, "model" | "rpcUrl" | "privateKey" | "serviceProviderAddress">> & Pick<ComputeClientOptions, "verifyResponses">) {
    this.model = options.model;
    this.rpcUrl = options.rpcUrl;
    this.privateKey = options.privateKey;
    this.serviceProviderAddress = options.serviceProviderAddress;
    this.verifyResponses = options.verifyResponses ?? true;
  }

  async complete(request: ComputeRequest): Promise<ComputeResponse> {
    const broker = await createZeroGComputeBroker(this.rpcUrl, this.privateKey);
    const metadata = await broker.inference.getServiceMetadata(this.serviceProviderAddress);
    const headers = await broker.inference.getRequestHeaders(this.serviceProviderAddress);
    const model = this.model || metadata.model;
    const response = await fetch(`${metadata.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify({
        messages: request.messages,
        model,
        temperature: request.temperature,
        max_tokens: request.maxTokens
      })
    });

    if (!response.ok) {
      throw new Error(`0G Compute request failed with ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as ZeroGChatCompletionResponse;
    const requestId = response.headers.get("ZG-Res-Key") ?? data.id ?? randomUUID();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error(`0G Compute response did not include assistant content: ${JSON.stringify(data)}`);
    }

    if (this.verifyResponses && broker.inference.processResponse && requestId) {
      await broker.inference.processResponse(this.serviceProviderAddress, requestId);
    }

    return {
      content,
      provider: this.provider,
      model,
      requestId
    };
  }
}

export function createComputeClientFromEnv(options: ComputeClientOptions = {}): ComputeClient {
  const provider = options.provider ?? (process.env.COMPUTE_PROVIDER as "local" | "0g" | undefined) ?? "local";
  const model = options.model ?? process.env.ZEROG_COMPUTE_MODEL ?? process.env.ZEROG_COMPUTE_PROVIDER ?? "qwen3.6-plus";

  if (provider === "0g") {
    const rpcUrl = options.rpcUrl ?? process.env.ZEROG_COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL;
    const privateKey = options.privateKey ?? process.env.ZEROG_COMPUTE_PRIVATE_KEY ?? process.env.ZEROG_PRIVATE_KEY;
    const serviceProviderAddress = options.serviceProviderAddress ?? process.env.ZEROG_COMPUTE_PROVIDER_ADDRESS;

    if (!rpcUrl) {
      throw new Error("0G Compute requires ZEROG_COMPUTE_RPC_URL or ZEROG_RPC_URL.");
    }

    if (!privateKey) {
      throw new Error("0G Compute requires ZEROG_COMPUTE_PRIVATE_KEY or ZEROG_PRIVATE_KEY.");
    }

    if (!serviceProviderAddress) {
      throw new Error("0G Compute requires ZEROG_COMPUTE_PROVIDER_ADDRESS.");
    }

    return new ZeroGComputeClient({
      model,
      rpcUrl,
      privateKey,
      serviceProviderAddress,
      verifyResponses: options.verifyResponses ?? process.env.ZEROG_COMPUTE_VERIFY_RESPONSES !== "false"
    });
  }

  return new LocalDeterministicComputeClient(model);
}

export function describeComputeClient(client: ComputeClient): ComputeClientInfo {
  if (client instanceof ZeroGComputeClient) {
    return {
      provider: client.provider,
      model: client.model,
      serviceProviderAddress: client.serviceProviderAddress,
      verifyResponses: client.verifyResponses
    };
  }

  if (client instanceof LocalDeterministicComputeClient) {
    return {
      provider: client.provider,
      model: client.model
    };
  }

  return {
    provider: "custom",
    model: "custom"
  };
}

type ZeroGComputeBroker = {
  inference: {
    getServiceMetadata(providerAddress: string): Promise<{ endpoint: string; model: string }>;
    getRequestHeaders(providerAddress: string): Promise<Record<string, string>>;
    processResponse?: (providerAddress: string, requestId: string) => Promise<unknown>;
  };
};

type ZeroGComputeSdk = {
  createZGComputeNetworkBroker(wallet: Wallet): Promise<ZeroGComputeBroker>;
};

type ZeroGChatCompletionResponse = {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

async function createZeroGComputeBroker(rpcUrl: string, privateKey: string): Promise<ZeroGComputeBroker> {
  const packageNames = ["@0glabs/0g-serving-broker", "@0gfoundation/0g-compute-ts-sdk"];
  let lastError: unknown = null;

  for (const packageName of packageNames) {
    try {
      const sdk = (await import(packageName)) as ZeroGComputeSdk;
      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);
      return sdk.createZGComputeNetworkBroker(wallet);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`0G Compute provider requires one of ${packageNames.join(", ")}. Install a supported SDK in @darkpool/agent-runtime before setting COMPUTE_PROVIDER=0g. Cause: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
