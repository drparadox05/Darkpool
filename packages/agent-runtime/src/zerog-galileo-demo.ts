import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { JsonRpcProvider } from "ethers";
import { SEEDED_AGENTS, type AgentBrainDocument } from "@darkpool/shared";
import { createBrainStoreFromEnv, createSeedBrain } from "./brain-store.js";
import { createComputeClientFromEnv } from "./compute-client.js";
import { loadAgentBrainINFTReference } from "./inft-brain.js";
import { loadSettlementAddresses } from "./settlement.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(srcDir, "../../..");

dotenv.config({ path: resolve(repoRoot, ".env") });
dotenv.config();

async function main(): Promise<void> {
  const settlement = await readGalileoSettlement();
  const compute = await runZeroGComputeProof();
  const storage = await runZeroGStorageProof();

  console.log("✓ 0G Galileo judge demo report", {
    chain: settlement,
    compute,
    storage
  });
}

async function readGalileoSettlement(): Promise<Record<string, unknown>> {
  const addresses = await loadSettlementAddresses();
  const rpcUrl = process.env.SETTLEMENT_RPC_URL ?? process.env.ZEROG_RPC_URL;
  let connectedChainId: number | undefined;

  if (!addresses) {
    throw new Error("Missing Galileo contract addresses. Run pnpm deploy:contracts:galileo or restore packages/contracts/addresses.json.");
  }

  if (rpcUrl) {
    const network = await new JsonRpcProvider(rpcUrl).getNetwork();
    connectedChainId = Number(network.chainId);
  }

  if (addresses.chainId !== 16602) {
    throw new Error(`Expected Galileo chain 16602 in contract addresses, got ${addresses.chainId}.`);
  }

  if (connectedChainId && connectedChainId !== addresses.chainId) {
    throw new Error(`RPC chain ${connectedChainId} does not match contract address chain ${addresses.chainId}.`);
  }

  return {
    chainId: addresses.chainId,
    connectedChainId,
    settlement: addresses.settlement,
    tokens: addresses.tokens
  };
}

async function runZeroGComputeProof(): Promise<Record<string, unknown>> {
  assertRequiredEnv("0G Compute", [
    ["COMPUTE_PROVIDER=0g", process.env.COMPUTE_PROVIDER === "0g" ? "0g" : undefined],
    ["ZEROG_COMPUTE_RPC_URL or ZEROG_RPC_URL", process.env.ZEROG_COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL],
    ["ZEROG_COMPUTE_PRIVATE_KEY or ZEROG_PRIVATE_KEY", process.env.ZEROG_COMPUTE_PRIVATE_KEY ?? process.env.ZEROG_PRIVATE_KEY],
    ["ZEROG_COMPUTE_PROVIDER_ADDRESS", process.env.ZEROG_COMPUTE_PROVIDER_ADDRESS]
  ]);

  const client = createComputeClientFromEnv({ provider: "0g" });
  const response = await client.complete({
    messages: [
      { role: "system", content: "You are validating 0G Compute for an autonomous OTC dark-pool agent demo." },
      { role: "user", content: "Return one concise sentence explaining that this quote rationale came from 0G Compute." }
    ],
    temperature: 0,
    maxTokens: 96
  });

  if (response.provider !== "0g") {
    throw new Error(`Expected 0G Compute provider, got ${response.provider}.`);
  }

  return {
    provider: response.provider,
    model: response.model,
    requestId: response.requestId,
    contentPreview: response.content.slice(0, 180)
  };
}

async function runZeroGStorageProof(): Promise<Record<string, unknown>> {
  assertRequiredEnv("0G Storage", [
    ["BRAINSTORE_PROVIDER=0g", process.env.BRAINSTORE_PROVIDER === "0g" ? "0g" : undefined],
    ["BRAINSTORE_PASSPHRASE", process.env.BRAINSTORE_PASSPHRASE],
    ["ZEROG_PRIVATE_KEY", process.env.ZEROG_PRIVATE_KEY],
    ["ZEROG_STORAGE_RPC_URL or ZEROG_RPC_URL", process.env.ZEROG_STORAGE_RPC_URL ?? process.env.ZEROG_RPC_URL],
    ["ZEROG_STORAGE_INDEXER_RPC_URL", process.env.ZEROG_STORAGE_INDEXER_RPC_URL]
  ]);

  const store = createBrainStoreFromEnv({ provider: "0g" });
  const tokenId = process.env.AGENT_BRAIN_INFT_TOKEN_ID ?? process.env.INFT_TOKEN_ID;
  const brainRootHash = process.env.BRAIN_ROOT_HASH;
  let brain: AgentBrainDocument;
  let source: Record<string, unknown>;

  if (tokenId) {
    const reference = await loadAgentBrainINFTReference(BigInt(tokenId));
    brain = await store.loadBrain(reference.rootHash);
    source = {
      source: "AgentBrainINFT",
      tokenId: reference.tokenId.toString(),
      contractAddress: reference.contractAddress,
      rootHash: reference.rootHash,
      storageUri: reference.tokenURI,
      encryptedKeyURI: reference.encryptedKeyURI
    };
  } else if (brainRootHash) {
    brain = await store.loadBrain(brainRootHash);
    source = {
      source: "BRAIN_ROOT_HASH",
      rootHash: brainRootHash
    };
  } else {
    const receipt = await store.saveBrain(createSeedBrain(SEEDED_AGENTS[0]));
    brain = await store.loadBrain(receipt.rootHash);
    source = {
      source: "bootstrap-upload",
      rootHash: receipt.rootHash,
      storageUri: receipt.storageUri,
      encryptedKeyURI: receipt.encryptedKeyURI,
      txHash: receipt.txHash
    };
  }

  const shouldWriteMemory = process.env.ZEROG_DEMO_WRITE_MEMORY === "true";

  if (!shouldWriteMemory) {
    return {
      ...source,
      agentId: brain.agentId,
      ensName: brain.ensName,
      memoryEvents: brain.memoryLog.length,
      memoryWriteSkipped: true
    };
  }

  brain.memoryLog = [
    ...brain.memoryLog,
    {
      timestamp: new Date().toISOString(),
      kind: "observation",
      content: "Judge demo proved encrypted agent brain memory can be persisted through 0G Storage."
    }
  ];

  const receipt = await store.saveBrain(brain);
  const loaded = await store.loadBrain(receipt.rootHash);

  return {
    ...source,
    updatedRootHash: receipt.rootHash,
    updatedStorageUri: receipt.storageUri,
    updatedTxHash: receipt.txHash,
    agentId: loaded.agentId,
    ensName: loaded.ensName,
    memoryEvents: loaded.memoryLog.length,
    memoryWriteSkipped: false
  };
}

function assertRequiredEnv(label: string, entries: Array<[string, string | undefined]>): void {
  const missing = entries.filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`${label} missing required env: ${missing.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
