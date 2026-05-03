import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { NextResponse } from "next/server";
import { loadRootEnv } from "../../../lib/server-env";
import {
  DEFAULT_AXL_API_URL,
  DEFAULT_AXL_ROUTER_URL,
  DEFAULT_WS_HUB_URL,
  stripTrailingSlash,
  withLocalFallback
} from "../../../lib/axl-url";
import type { OtcParticipant, TokenMap, TraderStatus } from "../../../lib/trader-types";

export const dynamic = "force-dynamic";

const AGENT_BRAIN_INFT_ABI = [
  "function brainData(uint256 tokenId) view returns (string metadataHash,string encryptedKeyURI,uint256 parentTokenId)"
] as const;

type BrainRootCacheEntry = { tokenId: string; address: string; rootHash: string | undefined };
let cachedBrainRoot: BrainRootCacheEntry | null = null;

type RawTopology = {
  our_public_key?: string;
  peers?: unknown[];
};

type RawRouterServices = Record<string, { endpoint?: string; healthy?: boolean }>;

type RawWsHealth = {
  ok?: boolean;
  clients?: number;
  events?: number;
};

type RawAddresses = {
  chainId?: number;
  contracts?: {
    DarkPoolSettlement?: string;
    MockUSDC?: string;
    MockWETH?: string;
    MockDAI?: string;
    AgentBrainINFT?: string;
  };
};

export async function GET() {
  loadRootEnv();

  const axlTransport = process.env.AXL_TRANSPORT === "gensyn" ? "gensyn" : "mock";
  const axlUrl = stripTrailingSlash(process.env.AXL_API_URL || DEFAULT_AXL_API_URL);
  const routerUrl = stripTrailingSlash(process.env.AXL_ROUTER_URL || DEFAULT_AXL_ROUTER_URL);
  const axlUrls = withLocalFallback(axlUrl, DEFAULT_AXL_API_URL);
  const routerUrls = withLocalFallback(routerUrl, DEFAULT_AXL_ROUTER_URL);
  const wsUrl = normalizeWsHubUrl(process.env.WS_HUB_URL || DEFAULT_WS_HUB_URL);

  const [axl, router, wsHub, settlement] = await Promise.all([
    readAxlStatus(axlUrls),
    axlTransport === "gensyn" ? readRouterStatus(routerUrls) : readMockRouterStatus(axlUrls),
    readWsStatus(wsUrl),
    readSettlementStatus()
  ]);

  const participants = buildParticipants(axl.peers);
  const status: TraderStatus = {
    checkedAt: new Date().toISOString(),
    axl: {
      ok: axl.ok,
      url: `${axl.url}/topology`,
      detail: axl.detail,
      transport: axlTransport,
      selfPeerId: axl.selfPeerId,
      peers: axl.peers
    },
    router: {
      ok: router.ok,
      url: `${router.url}/services`,
      detail: router.detail,
      services: router.services
    },
    wsHub: {
      ok: wsHub.ok,
      url: `${wsUrl}/health`,
      detail: wsHub.detail,
      events: wsHub.events,
      clients: wsHub.clients
    },
    settlement,
    zeroG: await readZeroGStatus(settlement),
    participants
  };

  return NextResponse.json(status);
}

async function readAxlStatus(axlUrls: string[]): Promise<{ ok: boolean; detail?: string; url: string; selfPeerId?: string; peers: string[] }> {
  const failures: string[] = [];

  for (const axlUrl of axlUrls) {
    try {
      const topology = await fetchJson<RawTopology>(`${axlUrl}/topology`);
      return {
        ok: true,
        url: axlUrl,
        detail: axlUrl === axlUrls[0] ? undefined : `Configured AXL endpoint failed; using local fallback ${axlUrl}.`,
        selfPeerId: topology.our_public_key,
        peers: normalizePeers(topology.peers)
      };
    } catch (error) {
      failures.push(`${axlUrl}: ${describeError(error)}`);
    }
  }

  return { ok: false, url: axlUrls[0] ?? DEFAULT_AXL_API_URL, detail: failures.join(" | "), peers: [] };
}

async function readRouterStatus(routerUrls: string[]): Promise<{ ok: boolean; detail?: string; url: string; services: string[] }> {
  const failures: string[] = [];

  for (const routerUrl of routerUrls) {
    try {
      const services = await fetchJson<RawRouterServices>(`${routerUrl}/services`);
      return {
        ok: true,
        url: routerUrl,
        detail: routerUrl === routerUrls[0] ? undefined : `Configured MCP router endpoint failed; using local fallback ${routerUrl}.`,
        services: Object.keys(services)
      };
    } catch (error) {
      failures.push(`${routerUrl}: ${describeError(error)}`);
    }
  }

  return { ok: false, url: routerUrls[0] ?? DEFAULT_AXL_ROUTER_URL, detail: failures.join(" | "), services: [] };
}

async function readMockRouterStatus(axlUrls: string[]): Promise<{ ok: boolean; detail?: string; url: string; services: string[] }> {
  const failures: string[] = [];

  for (const axlUrl of axlUrls) {
    try {
      await fetchJson<unknown>(`${axlUrl}/health`);
      return { ok: true, url: axlUrl, detail: "Mock AXL routes MCP calls directly over /a2a.", services: ["darkpool"] };
    } catch (error) {
      failures.push(`${axlUrl}: ${describeError(error)}`);
    }
  }

  return { ok: false, url: axlUrls[0] ?? DEFAULT_AXL_API_URL, detail: failures.join(" | "), services: [] };
}

async function readWsStatus(wsUrl: string): Promise<{ ok: boolean; detail?: string; events?: number; clients?: number }> {
  try {
    const health = await fetchJson<RawWsHealth>(`${wsUrl}/health`);
    return { ok: health.ok === true, events: health.events, clients: health.clients, detail: health.ok === true ? undefined : "WS hub returned ok=false" };
  } catch (error) {
    return { ok: false, detail: describeError(error) };
  }
}

async function readSettlementStatus(): Promise<TraderStatus["settlement"]> {
  try {
    const raw = await readFile(resolve(process.cwd(), "../../packages/contracts/addresses.json"), "utf8");
    const parsed = JSON.parse(raw) as RawAddresses;
    const tokens: TokenMap = {};

    if (parsed.contracts?.MockUSDC) {
      tokens.mUSDC = parsed.contracts.MockUSDC;
    }

    if (parsed.contracts?.MockWETH) {
      tokens.mWETH = parsed.contracts.MockWETH;
    }

    if (parsed.contracts?.MockDAI) {
      tokens.mDAI = parsed.contracts.MockDAI;
    }

    return {
      ok: Boolean(parsed.chainId && parsed.contracts?.DarkPoolSettlement),
      chainId: parsed.chainId,
      address: parsed.contracts?.DarkPoolSettlement,
      agentBrainINFT: parsed.contracts?.AgentBrainINFT,
      tokens,
      autoSubmit: process.env.SETTLEMENT_AUTO_SUBMIT === "true"
    };
  } catch (error) {
    return {
      ok: false,
      tokens: {},
      autoSubmit: process.env.SETTLEMENT_AUTO_SUBMIT === "true",
      detail: describeError(error)
    };
  }
}

async function readZeroGStatus(settlement: TraderStatus["settlement"]): Promise<TraderStatus["zeroG"]> {
  const computeProvider = firstNonEmpty(process.env.COMPUTE_PROVIDER) ?? "local";
  const computeRpcUrl = firstNonEmpty(process.env.ZEROG_COMPUTE_RPC_URL, process.env.ZEROG_RPC_URL);
  const computePrivateKey = firstNonEmpty(process.env.ZEROG_COMPUTE_PRIVATE_KEY, process.env.ZEROG_PRIVATE_KEY);
  const computeServiceProviderAddress = firstNonEmpty(process.env.ZEROG_COMPUTE_PROVIDER_ADDRESS);
  const storageProvider = firstNonEmpty(process.env.BRAINSTORE_PROVIDER) ?? "seed";
  const storageRpcUrl = firstNonEmpty(process.env.ZEROG_STORAGE_RPC_URL, process.env.ZEROG_RPC_URL);
  const storageIndexerRpcUrl = firstNonEmpty(process.env.ZEROG_STORAGE_INDEXER_RPC_URL);
  const storagePrivateKey = firstNonEmpty(process.env.ZEROG_PRIVATE_KEY);
  const inftTokenId = firstNonEmpty(process.env.AGENT_BRAIN_INFT_TOKEN_ID, process.env.INFT_TOKEN_ID);
  const inftContractAddress = firstNonEmpty(
    process.env.INFT_CONTRACT_ADDRESS,
    process.env.NEXT_PUBLIC_AGENT_BRAIN_INFT_ADDRESS,
    settlement.agentBrainINFT
  );
  const inftMintTxHash = firstNonEmpty(
    process.env.AGENT_BRAIN_INFT_MINT_TX,
    process.env.AGENT_BRAIN_INFT_MINT_TX_HASH,
    process.env.INFT_MINT_TX_HASH
  );
  const storageUploadTxHash = firstNonEmpty(
    process.env.AGENT_BRAIN_STORAGE_TX,
    process.env.AGENT_BRAIN_STORAGE_TX_HASH,
    process.env.BRAIN_STORAGE_TX_HASH
  );
  const bootstrapStorage = process.env.BRAINSTORE_BOOTSTRAP_ON_START === "true";
  const persistsMemoryEvents = process.env.BRAINSTORE_PERSIST_MEMORY_EVENTS !== "false";

  const brainRootHash = firstNonEmpty(process.env.BRAIN_ROOT_HASH)
    ?? (await resolveBrainRootFromINFT(inftTokenId, inftContractAddress));

  const explorer = resolveChainExplorer(settlement.chainId);

  return {
    compute: {
      ok: computeProvider === "0g" && Boolean(computeRpcUrl && computePrivateKey && computeServiceProviderAddress),
      provider: computeProvider,
      model: firstNonEmpty(process.env.ZEROG_COMPUTE_MODEL, process.env.ZEROG_COMPUTE_PROVIDER) ?? (computeProvider === "0g" ? "qwen3.6-plus" : undefined),
      serviceProviderAddress: computeServiceProviderAddress,
      verifyResponses: process.env.ZEROG_COMPUTE_VERIFY_RESPONSES !== "false",
      providerExplorerUrl: buildExplorerUrl(explorer.addressExplorerBaseUrl, computeServiceProviderAddress),
      detail: computeProvider === "0g" ? missingDetail("0G Compute", [
        ["RPC", computeRpcUrl],
        ["private key", computePrivateKey],
        ["provider address", computeServiceProviderAddress]
      ]) : "Set COMPUTE_PROVIDER=0g to route agent reasoning through 0G Compute."
    },
    storage: {
      ok: storageProvider === "0g" && Boolean(storageRpcUrl && storageIndexerRpcUrl && storagePrivateKey && (brainRootHash || inftTokenId || bootstrapStorage)),
      provider: storageProvider,
      rootHash: brainRootHash,
      indexerRpcUrl: storageIndexerRpcUrl,
      rpcUrl: storageRpcUrl,
      inftTokenId,
      inftContractAddress,
      inftContractExplorerUrl: buildExplorerUrl(explorer.addressExplorerBaseUrl, inftContractAddress),
      inftMintTxHash,
      inftMintTxExplorerUrl: buildExplorerUrl(explorer.txExplorerBaseUrl, inftMintTxHash),
      storageUploadTxHash,
      storageUploadTxExplorerUrl: buildExplorerUrl(explorer.txExplorerBaseUrl, storageUploadTxHash),
      persistsMemoryEvents,
      detail: storageProvider === "0g" ? missingDetail("0G Storage", [
        ["RPC", storageRpcUrl],
        ["indexer", storageIndexerRpcUrl],
        ["private key", storagePrivateKey],
        ["brain root, iNFT token, or bootstrap flag", brainRootHash || inftTokenId || (bootstrapStorage ? "true" : undefined)]
      ]) : "Set BRAINSTORE_PROVIDER=0g plus BRAIN_ROOT_HASH, INFT_TOKEN_ID, or BRAINSTORE_BOOTSTRAP_ON_START=true."
    },
    chain: {
      ok: settlement.ok && settlement.chainId === 16602,
      chainId: settlement.chainId,
      settlementAddress: settlement.address,
      settlementExplorerUrl: buildExplorerUrl(explorer.addressExplorerBaseUrl, settlement.address),
      explorerName: explorer.name,
      txExplorerBaseUrl: explorer.txExplorerBaseUrl,
      addressExplorerBaseUrl: explorer.addressExplorerBaseUrl
    }
  };
}

async function resolveBrainRootFromINFT(tokenId: string | undefined, contractAddress: string | undefined): Promise<string | undefined> {
  if (!tokenId || !contractAddress) {
    return undefined;
  }

  if (cachedBrainRoot && cachedBrainRoot.tokenId === tokenId && cachedBrainRoot.address === contractAddress) {
    return cachedBrainRoot.rootHash;
  }

  const rpcUrl = firstNonEmpty(process.env.INFT_RPC_URL, process.env.ZEROG_RPC_URL, process.env.SETTLEMENT_RPC_URL);

  if (!rpcUrl) {
    return undefined;
  }

  try {
    const provider = new JsonRpcProvider(rpcUrl);
    const contract = new Contract(getAddress(contractAddress), AGENT_BRAIN_INFT_ABI, provider);
    const data = await contract.brainData(BigInt(tokenId));
    const rootHash = parseZeroGRootHash(String(data[0]));
    cachedBrainRoot = { tokenId, address: contractAddress, rootHash };
    return rootHash;
  } catch (error) {
    console.warn("[/api/status] failed to resolve brain root hash from iNFT:", error instanceof Error ? error.message : error);
    cachedBrainRoot = { tokenId, address: contractAddress, rootHash: undefined };
    return undefined;
  }
}

function parseZeroGRootHash(reference: string): string | undefined {
  const stripped = reference.startsWith("0g://brain-key/")
    ? reference.slice("0g://brain-key/".length)
    : reference.startsWith("0g://")
    ? reference.slice("0g://".length)
    : reference;

  return /^0x[0-9a-fA-F]{64}$/.test(stripped) ? stripped : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

type ChainExplorer = {
  name?: string;
  txExplorerBaseUrl?: string;
  addressExplorerBaseUrl?: string;
};

function resolveChainExplorer(chainId?: number): ChainExplorer {
  const txDefault = chainId === 16602 ? "https://chainscan-galileo.0g.ai/tx/" : undefined;
  const addressDefault = chainId === 16602 ? "https://chainscan-galileo.0g.ai/address/" : undefined;
  const nameDefault = chainId === 16602 ? "0G Galileo Chainscan" : undefined;

  return {
    name: firstNonEmpty(process.env.NEXT_PUBLIC_EXPLORER_NAME) ?? nameDefault,
    txExplorerBaseUrl: firstNonEmpty(process.env.NEXT_PUBLIC_EXPLORER_TX_BASE_URL) ?? txDefault,
    addressExplorerBaseUrl: firstNonEmpty(process.env.NEXT_PUBLIC_EXPLORER_ADDRESS_BASE_URL) ?? addressDefault
  };
}

function buildExplorerUrl(baseUrl: string | undefined, suffix: string | undefined): string | undefined {
  if (!baseUrl || !suffix) {
    return undefined;
  }

  return `${baseUrl}${suffix}`;
}

function buildParticipants(axlPeers: string[]): OtcParticipant[] {
  const configured = parseConfiguredParticipants();
  const participants = new Map<string, OtcParticipant>();

  for (const participant of configured) {
    participants.set(participant.peerId, participant);
  }

  for (const peerId of axlPeers) {
    if (!participants.has(peerId)) {
      participants.set(peerId, {
        label: `AXL peer ${shortPeer(peerId)}`,
        peerId,
        service: undefined,
        pairs: [],
        source: "topology"
      });
    }
  }

  return [...participants.values()];
}

function parseConfiguredParticipants(): OtcParticipant[] {
  const raw = process.env.NEXT_PUBLIC_OTC_PARTICIPANTS ?? process.env.OTC_PARTICIPANTS ?? "";

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [labelOrPeer, maybePeer, maybePairs] = entry.split("|").map((part) => part.trim());
      const peerId = maybePeer || labelOrPeer;
      const label = maybePeer ? labelOrPeer : `AXL peer ${shortPeer(peerId)}`;
      return {
        label,
        peerId,
        service: "darkpool",
        pairs: maybePairs ? maybePairs.split(";").map((pair) => pair.trim()).filter(Boolean) : [],
        source: "env" as const
      };
    });
}

function normalizePeers(peers: RawTopology["peers"]): string[] {
  if (!Array.isArray(peers)) {
    return [];
  }

  return peers
    .map((peer) => {
      if (typeof peer === "string") {
        return peer;
      }

      if (!isRecord(peer)) {
        return undefined;
      }

      return peer.public_key ?? peer.peerId ?? peer.peer_id ?? peer.publicKey ?? peer.key ?? peer.id;
    })
    .filter((peer): peer is string => Boolean(peer));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
  }

  return response.json() as Promise<T>;
}

function normalizeWsHubUrl(url: string): string {
  const stripped = stripTrailingSlash(url);
  return stripped.endsWith("/publish") ? stripped.slice(0, -"/publish".length) : stripped;
}

function shortPeer(peerId: string): string {
  return peerId.length > 12 ? `${peerId.slice(0, 6)}…${peerId.slice(-4)}` : peerId;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingDetail(label: string, fields: Array<[string, string | undefined]>): string | undefined {
  const missing = fields.filter(([, value]) => !value).map(([name]) => name);

  if (missing.length === 0) {
    return undefined;
  }

  return `${label} missing ${missing.join(", ")}.`;
}

function isRecord(value: unknown): value is Record<string, string | undefined> {
  return typeof value === "object" && value !== null;
}
