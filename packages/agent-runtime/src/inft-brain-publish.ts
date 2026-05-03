import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Contract, Interface, JsonRpcProvider, Wallet, getAddress } from "ethers";
import { SEEDED_AGENTS, type AgentProfile, type BrainStorageReceipt } from "@darkpool/shared";
import { createBrainStoreFromEnv, createSeedBrain } from "./brain-store.js";
import { AGENT_BRAIN_INFT_ABI, loadAgentBrainINFTAddress } from "./inft-brain.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(srcDir, "../../..");

const AGENT_BRAIN_INTERFACE = new Interface(AGENT_BRAIN_INFT_ABI);

type PublishedBrain = {
  receipt: BrainStorageReceipt;
  tokenURI: string;
  metadataHash: string;
  encryptedKeyURI: string;
};

async function main(): Promise<void> {
  requireRealBrainStore();

  const { address: inftAddress, chainId } = await loadAgentBrainINFTAddress();
  const wallet = createPublisherWallet();
  const network = await wallet.provider?.getNetwork();

  if (chainId && network && Number(network.chainId) !== chainId) {
    throw new Error(`AgentBrainINFT address file is for chain ${chainId}, but INFT_RPC_URL/ZEROG_RPC_URL is connected to chain ${network.chainId.toString()}.`);
  }

  const inft = new Contract(inftAddress, AGENT_BRAIN_INFT_ABI, wallet);
  const profile = loadProfile();
  const brainStore = createBrainStoreFromEnv({ provider: "0g" });
  const publishedBrain = await publishBrain(profile, brainStore);
  const tokenId = process.env.INFT_TOKEN_ID;

  if (tokenId) {
    await updateBrain(inft, BigInt(tokenId), publishedBrain);
    return;
  }

  await mintBrain(inft, wallet.address, publishedBrain);
}

async function publishBrain(profile: AgentProfile, brainStore: ReturnType<typeof createBrainStoreFromEnv>): Promise<PublishedBrain> {
  const brain = createSeedBrain(profile);
  const receipt = await brainStore.saveBrain(brain);
  const tokenURI = process.env.INFT_TOKEN_URI ?? receipt.storageUri;
  const metadataHash = process.env.INFT_METADATA_HASH ?? receipt.storageUri;
  const encryptedKeyURI = process.env.INFT_ENCRYPTED_KEY_URI ?? receipt.encryptedKeyURI;

  return { receipt, tokenURI, metadataHash, encryptedKeyURI };
}

async function mintBrain(inft: Contract, publisherAddress: string, publishedBrain: PublishedBrain): Promise<void> {
  const to = getAddress(process.env.INFT_TO ?? publisherAddress);
  const cloneFeeWei = parseBigIntEnv("INFT_CLONE_FEE_WEI", 0n);
  const royaltyReceiver = getAddress(process.env.INFT_ROYALTY_RECEIVER ?? to);
  const royaltyBps = parseRoyaltyBps(process.env.INFT_ROYALTY_BPS ?? "500");
  const transaction = await inft.mintAgent(
    to,
    publishedBrain.tokenURI,
    publishedBrain.metadataHash,
    publishedBrain.encryptedKeyURI,
    cloneFeeWei,
    royaltyReceiver,
    royaltyBps
  );
  const receipt = await transaction.wait();
  const tokenId = findTokenId(receipt?.logs ?? [], "AgentMinted");

  if (tokenId === null) {
    throw new Error(`AgentBrainINFT mint transaction ${transaction.hash} did not emit AgentMinted.`);
  }

  await assertBrainReferences(inft, tokenId, publishedBrain);
  console.log("✓ published encrypted brain and minted AgentBrainINFT", {
    tokenId: tokenId.toString(),
    transactionHash: transaction.hash,
    brainRootHash: publishedBrain.receipt.rootHash,
    brainTxHash: publishedBrain.receipt.txHash,
    tokenURI: publishedBrain.tokenURI,
    metadataHash: publishedBrain.metadataHash,
    encryptedKeyURI: publishedBrain.encryptedKeyURI
  });
}

async function updateBrain(inft: Contract, tokenId: bigint, publishedBrain: PublishedBrain): Promise<void> {
  const transaction = await inft.updateBrain(tokenId, publishedBrain.tokenURI, publishedBrain.metadataHash, publishedBrain.encryptedKeyURI);
  await transaction.wait();
  await assertBrainReferences(inft, tokenId, publishedBrain);
  console.log("✓ published encrypted brain and updated AgentBrainINFT", {
    tokenId: tokenId.toString(),
    transactionHash: transaction.hash,
    brainRootHash: publishedBrain.receipt.rootHash,
    brainTxHash: publishedBrain.receipt.txHash,
    tokenURI: publishedBrain.tokenURI,
    metadataHash: publishedBrain.metadataHash,
    encryptedKeyURI: publishedBrain.encryptedKeyURI
  });
}

async function assertBrainReferences(inft: Contract, tokenId: bigint, publishedBrain: PublishedBrain): Promise<void> {
  const brainData = await inft.brainData(tokenId);
  const tokenURI = await inft.tokenURI(tokenId);
  const onchainMetadataHash = String(brainData[0]);
  const onchainEncryptedKeyURI = String(brainData[1]);

  if (tokenURI !== publishedBrain.tokenURI) {
    throw new Error(`AgentBrainINFT tokenURI mismatch for token ${tokenId}: ${tokenURI} != ${publishedBrain.tokenURI}`);
  }

  if (onchainMetadataHash !== publishedBrain.metadataHash) {
    throw new Error(`AgentBrainINFT metadataHash mismatch for token ${tokenId}: ${onchainMetadataHash} != ${publishedBrain.metadataHash}`);
  }

  if (onchainEncryptedKeyURI !== publishedBrain.encryptedKeyURI) {
    throw new Error(`AgentBrainINFT encryptedKeyURI mismatch for token ${tokenId}: ${onchainEncryptedKeyURI} != ${publishedBrain.encryptedKeyURI}`);
  }
}

function createPublisherWallet(): Wallet {
  const rpcUrl = process.env.INFT_RPC_URL ?? process.env.ZEROG_RPC_URL ?? process.env.SETTLEMENT_RPC_URL;
  const privateKey = process.env.INFT_PRIVATE_KEY ?? process.env.ZEROG_PRIVATE_KEY;

  if (!rpcUrl) {
    throw new Error("Publishing AgentBrainINFT requires INFT_RPC_URL or ZEROG_RPC_URL.");
  }

  if (!privateKey) {
    throw new Error("Publishing AgentBrainINFT requires INFT_PRIVATE_KEY or ZEROG_PRIVATE_KEY.");
  }

  return new Wallet(privateKey, new JsonRpcProvider(rpcUrl));
}

function loadProfile(): AgentProfile {
  const role = process.env.PERSONALITY ?? process.env.AGENT_ROLE ?? "aggressive";
  const fallback = SEEDED_AGENTS.find((agent) => agent.role === role) ?? SEEDED_AGENTS[0];

  return {
    ...fallback,
    id: process.env.AGENT_ID ?? fallback.id,
    peerId: process.env.AXL_PEER_ID ?? process.env.AGENT_ID ?? fallback.peerId,
    ensName: process.env.AGENT_ENS ?? fallback.ensName,
    status: "online"
  };
}

function requireRealBrainStore(): void {
  if (process.env.BRAINSTORE_PROVIDER !== "0g") {
    throw new Error("Publishing AgentBrainINFT brain references requires BRAINSTORE_PROVIDER=0g. Local brain storage is an offline fallback and does not count as real iNFT publishing.");
  }
}

function parseBigIntEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  return raw ? BigInt(raw) : fallback;
}

function parseRoyaltyBps(raw: string): number {
  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0 || value > 1_000) {
    throw new Error(`INFT_ROYALTY_BPS must be an integer between 0 and 1000, got ${raw}.`);
  }

  return value;
}

function findTokenId(logs: Array<{ topics: readonly string[]; data: string }>, eventName: string): bigint | null {
  for (const log of logs) {
    try {
      const parsed = AGENT_BRAIN_INTERFACE.parseLog({ topics: [...log.topics], data: log.data });

      if (parsed?.name === eventName) {
        return BigInt(parsed.args[0].toString());
      }
    } catch {
      continue;
    }
  }

  return null;
}

dotenv.config({ path: resolve(repoRoot, ".env") });
dotenv.config();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
