import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { AgentBrainDocument, AgentProfile, BrainMemoryEvent, BrainStorageReceipt } from "@darkpool/shared";
import { SEEDED_AGENTS } from "@darkpool/shared";
import { AxlClient, type AxlTransport } from "./axl-client.js";
import { createBrainStoreFromEnv, createSeedBrain } from "./brain-store.js";
import { createComputeClientFromEnv, describeComputeClient, type ComputeClient } from "./compute-client.js";
import { createDarkpoolTools } from "./darkpool-tools.js";
import { loadAgentBrainINFTReference } from "./inft-brain.js";
import { startDarkpoolMcpServer, type RunningMcpServer, createPingTool } from "./mcp-server.js";
import {
  createAgentWallet,
  createSettlementClient,
  createSettlementSigner,
  loadSettlementAddresses,
  type SettlementAddresses,
  type SettlementClient,
  type SettlementSigner
} from "./settlement.js";
import { createAgentStrategy, type AgentStrategy } from "./strategy.js";
import { createWsTee, type WsTee } from "./ws-tee.js";

export type AgentRuntimeOptions = {
  profile: AgentProfile;
  axlBaseUrl: string;
  axlTransport?: AxlTransport;
  axlRouterUrl?: string;
  mcpPort: number;
  callbackUrl?: string;
  brain?: AgentBrainDocument;
  computeClient?: ComputeClient;
  privateKeySeed?: string;
  settlementAddresses?: SettlementAddresses | null;
  rpcUrl?: string;
  settlementSubmitterPrivateKey?: string;
  settlementAutoSubmit?: boolean;
  wsTeeUrl?: string;
  brainStorage?: RuntimeBrainStorageInfo;
};

export type RuntimeBrainStorageInfo = {
  provider: "seed" | "local" | "0g" | "0g-inft";
  rootHash?: string;
  storageUri?: string;
  encryptedKeyURI?: string;
  byteLength?: number;
  txHash?: string;
  tokenId?: string;
  contractAddress?: string;
};

export type RunningAgentRuntime = {
  profile: AgentProfile;
  axlClient: AxlClient;
  mcpServer: RunningMcpServer;
  brain: AgentBrainDocument;
  strategy: AgentStrategy;
  signer: SettlementSigner;
  settlement: SettlementClient;
  tee: WsTee;
  brainStorage: RuntimeBrainStorageInfo;
  close: () => Promise<void>;
};

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(srcDir, "..");
const repoRoot = resolve(packageDir, "../..");

dotenv.config({ path: resolve(repoRoot, ".env") });
dotenv.config();

export async function startAgentRuntime(options: AgentRuntimeOptions): Promise<RunningAgentRuntime> {
  const axlClient = new AxlClient({
    baseUrl: options.axlBaseUrl,
    peerId: options.profile.peerId,
    transport: options.axlTransport ?? parseAxlTransport(process.env.AXL_TRANSPORT),
    routerUrl: options.axlRouterUrl ?? process.env.AXL_ROUTER_URL
  });
  const brain = options.brain ?? createSeedBrain(options.profile);
  const computeClient = options.computeClient ?? createComputeClientFromEnv();
  const compute = describeComputeClient(computeClient);
  const brainStorage = options.brainStorage ?? { provider: "seed" as const };
  const strategy = createAgentStrategy({ profile: options.profile, brain, computeClient });

  const seed =
    options.privateKeySeed ??
    getAgentPrivateKeyEnvValue(agentPrivateKeyEnvName(options.profile.peerId)) ??
    getAgentPrivateKeyEnvValue(agentPrivateKeyEnvName(options.profile.id)) ??
    `${options.profile.peerId}-${options.profile.ensName}`;
  const wallet = createAgentWallet(seed);
  const signer = createSettlementSigner(wallet);

  const addresses = Object.prototype.hasOwnProperty.call(options, "settlementAddresses") ? (options.settlementAddresses ?? null) : await loadSettlementAddresses();
  const settlementAutoSubmit = options.settlementAutoSubmit ?? process.env.SETTLEMENT_AUTO_SUBMIT === "true";
  const settlement = createSettlementClient({
    addresses,
    rpcUrl: settlementAutoSubmit ? (options.rpcUrl ?? process.env.SETTLEMENT_RPC_URL) : undefined,
    submitterPrivateKey: settlementAutoSubmit ? (options.settlementSubmitterPrivateKey ?? process.env.SETTLEMENT_SUBMITTER_PRIVATE_KEY) : undefined,
    submitEnabled: settlementAutoSubmit
  });
  const tee = createWsTee({ url: options.wsTeeUrl ?? process.env.WS_HUB_URL, agentId: options.profile.peerId, ensName: options.profile.ensName });

  const persistMemoryEvent = createMemoryEventPersister(brain, brainStorage, tee);
  const darkpoolTools = createDarkpoolTools({ profile: options.profile, strategy, signer, settlement, tee, persistMemoryEvent });
  const tools = [createPingTool(options.profile), ...darkpoolTools];

  const mcpServer = await startDarkpoolMcpServer({
    profile: options.profile,
    axlClient,
    port: options.mcpPort,
    callbackUrl: options.callbackUrl,
    tools
  });

  tee.publish("agent:registered", {
    peerId: options.profile.peerId,
    ensName: options.profile.ensName,
    role: options.profile.role,
    address: signer.address,
    mcpUrl: mcpServer.callbackUrl,
    compute,
    brainStorage,
    settlement: addresses ? { chainId: addresses.chainId, address: addresses.settlement } : null
  });

  if (brainStorage.provider === "0g" || brainStorage.provider === "0g-inft") {
    tee.publish("0g:storage", {
      stage: "brain-loaded",
      ...brainStorage
    });
  }

  console.log(`[agent:${options.profile.peerId}] ${options.profile.ensName} registered darkpool MCP at ${mcpServer.callbackUrl} (address ${signer.address})`);
  console.log(`[agent:${options.profile.peerId}] 0G stack`, {
    compute,
    brainStorage,
    settlement: addresses ? { chainId: addresses.chainId, address: addresses.settlement } : null
  });

  return {
    profile: options.profile,
    axlClient,
    mcpServer,
    brain,
    strategy,
    signer,
    settlement,
    tee,
    brainStorage,
    close: async () => {
      await tee.close();
      await mcpServer.close();
    }
  };
}

async function loadProfile(): Promise<AgentProfile> {
  const personality = process.env.PERSONALITY ?? process.env.AGENT_ROLE ?? "aggressive";
  const profilePath = process.env.PERSONALITY_PATH ?? resolve(packageDir, "personalities", `${personality}.json`);
  const raw = await readFile(profilePath, "utf8").catch(() => "");
  const fallback = SEEDED_AGENTS.find((agent) => agent.role === personality) ?? SEEDED_AGENTS[0];
  const loaded = raw ? (JSON.parse(raw) as AgentProfile) : fallback;

  return {
    ...loaded,
    id: process.env.AGENT_ID ?? loaded.id,
    peerId: process.env.AXL_PEER_ID ?? process.env.AGENT_ID ?? loaded.peerId,
    ensName: process.env.AGENT_ENS ?? loaded.ensName,
    status: "online"
  };
}

function parseAxlTransport(raw: string | undefined): AxlTransport {
  return raw === "gensyn" ? "gensyn" : "mock";
}

function agentPrivateKeyEnvName(value: string): string {
  return `AGENT_PRIVATE_KEY_${value.toUpperCase().replace(/-/g, "_")}`;
}

function getAgentPrivateKeyEnvValue(name: string): string | undefined {
  const value = process.env[name];

  if (!value) {
    return undefined;
  }

  return /^0x[0-9a-fA-F]{64}$/.test(value) ? value : undefined;
}

async function main(): Promise<void> {
  const profile = await loadProfile();
  const brainLoad = await loadRuntimeBrain(profile);
  const runtime = await startAgentRuntime({
    profile,
    brain: brainLoad.brain,
    brainStorage: brainLoad.storage,
    axlBaseUrl: process.env.AXL_API_URL ?? "http://127.0.0.1:9002",
    axlTransport: parseAxlTransport(process.env.AXL_TRANSPORT),
    axlRouterUrl: process.env.AXL_ROUTER_URL,
    mcpPort: Number(process.env.MCP_PORT ?? "9102"),
    callbackUrl: process.env.MCP_CALLBACK_URL
  });

  const pingTarget = process.env.INITIATE_PING_TO;

  if (pingTarget) {
    setTimeout(async () => {
      try {
        const topology = await runtime.axlClient.topology();
        console.log(`[agent:${profile.peerId}] topology`, topology);
        const pong = await runtime.axlClient.callTool(pingTarget, "darkpool", "ping", {
          message: `hello from ${profile.ensName}`,
          pair: profile.pairs[0]
        });
        console.log(`[agent:${profile.peerId}] ping result`, pong);
      } catch (error) {
        console.error(`[agent:${profile.peerId}] ping failed`, error);
      }
    }, Number(process.env.PING_DELAY_MS ?? "1500"));
  }

  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

type RuntimeBrainLoad = {
  brain: AgentBrainDocument;
  storage: RuntimeBrainStorageInfo;
};

async function loadRuntimeBrain(profile: AgentProfile): Promise<RuntimeBrainLoad> {
  const brainRootHash = process.env.BRAIN_ROOT_HASH;

  if (brainRootHash) {
    const provider = process.env.BRAINSTORE_PROVIDER === "0g" ? "0g" : "local";
    return {
      brain: await createBrainStoreFromEnv().loadBrain(brainRootHash),
      storage: { provider, rootHash: brainRootHash }
    };
  }

  const tokenId = process.env.AGENT_BRAIN_INFT_TOKEN_ID ?? process.env.INFT_TOKEN_ID;

  if (tokenId) {
    const reference = await loadAgentBrainINFTReference(BigInt(tokenId));
    console.log(`[agent:${profile.peerId}] loaded brain reference from AgentBrainINFT`, {
      tokenId: reference.tokenId.toString(),
      rootHash: reference.rootHash,
      contractAddress: reference.contractAddress
    });
    return {
      brain: await createBrainStoreFromEnv({ provider: "0g" }).loadBrain(reference.rootHash),
      storage: {
        provider: "0g-inft",
        rootHash: reference.rootHash,
        storageUri: reference.tokenURI,
        encryptedKeyURI: reference.encryptedKeyURI,
        tokenId: reference.tokenId.toString(),
        contractAddress: reference.contractAddress
      }
    };
  }

  if (process.env.BRAINSTORE_PROVIDER === "0g" && process.env.BRAINSTORE_BOOTSTRAP_ON_START === "true") {
    const store = createBrainStoreFromEnv({ provider: "0g" });
    const receipt = await store.saveBrain(createSeedBrain(profile));
    return {
      brain: await store.loadBrain(receipt.rootHash),
      storage: storageInfoFromReceipt(receipt, "0g")
    };
  }

  return {
    brain: createSeedBrain(profile),
    storage: { provider: "seed" }
  };
}

function createMemoryEventPersister(brain: AgentBrainDocument, brainStorage: RuntimeBrainStorageInfo, tee: WsTee): ((event: BrainMemoryEvent) => Promise<void>) | undefined {
  if ((brainStorage.provider !== "0g" && brainStorage.provider !== "0g-inft") || process.env.BRAINSTORE_PERSIST_MEMORY_EVENTS === "false") {
    return undefined;
  }

  const store = createBrainStoreFromEnv({ provider: "0g" });
  const provider = brainStorage.provider === "0g-inft" ? "0g-inft" : "0g";

  return async (event) => {
    brain.memoryLog = [...brain.memoryLog, event];

    try {
      const receipt = await store.saveBrain(brain);
      Object.assign(brainStorage, storageInfoFromReceipt(receipt, provider));
      tee.publish("0g:storage", {
        stage: "memory-persisted",
        eventKind: event.kind,
        memoryEvents: brain.memoryLog.length,
        ...brainStorage
      });
    } catch (error) {
      tee.publish("0g:storage", {
        stage: "memory-persist-failed",
        provider: brainStorage.provider,
        eventKind: event.kind,
        detail: error instanceof Error ? error.message : String(error)
      });
      console.error(`[agent:${brain.agentId}] failed to persist memory event to 0G Storage`, error);
    }
  };
}

function storageInfoFromReceipt(receipt: BrainStorageReceipt, provider: "0g" | "0g-inft"): RuntimeBrainStorageInfo {
  return {
    provider,
    rootHash: receipt.rootHash,
    storageUri: receipt.storageUri,
    encryptedKeyURI: receipt.encryptedKeyURI,
    byteLength: receipt.byteLength,
    txHash: receipt.txHash
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
