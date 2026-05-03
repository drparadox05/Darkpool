import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, getAddress, type Provider } from "ethers";

const srcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(srcDir, "../../..");
const defaultAddressesPath = resolve(repoRoot, "packages/contracts/addresses.json");

export const AGENT_BRAIN_INFT_ABI = [
  "function mintAgent(address to,string tokenURI,string metadataHash,string encryptedKeyURI,uint256 cloneFeeWei,address royaltyReceiver,uint96 tokenRoyaltyBps) external returns (uint256 tokenId)",
  "function updateBrain(uint256 tokenId,string tokenURI,string metadataHash,string encryptedKeyURI) external",
  "function brainData(uint256 tokenId) view returns (string metadataHash,string encryptedKeyURI,uint256 parentTokenId)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "event AgentMinted(uint256 indexed tokenId,address indexed owner,string metadataHash,string encryptedKeyURI)",
  "event BrainUpdated(uint256 indexed tokenId,string metadataHash,string encryptedKeyURI)"
] as const;

export type AgentBrainINFTReference = {
  tokenId: bigint;
  contractAddress: string;
  tokenURI: string;
  metadataHash: string;
  encryptedKeyURI: string;
  parentTokenId: bigint;
  rootHash: string;
};

type ContractAddressesFile = {
  chainId?: number;
  contracts?: {
    AgentBrainINFT?: string;
  };
};

export async function loadAgentBrainINFTReference(tokenId: bigint, provider?: Provider): Promise<AgentBrainINFTReference> {
  const { address: contractAddress, chainId } = await loadAgentBrainINFTAddress();
  const resolvedProvider = provider ?? createINFTProvider();
  const network = await resolvedProvider.getNetwork();

  if (chainId && Number(network.chainId) !== chainId) {
    throw new Error(`AgentBrainINFT address file is for chain ${chainId}, but INFT_RPC_URL/ZEROG_RPC_URL is connected to chain ${network.chainId.toString()}.`);
  }

  const inft = new Contract(contractAddress, AGENT_BRAIN_INFT_ABI, resolvedProvider);
  const brainData = await inft.brainData(tokenId);
  const tokenURI = await inft.tokenURI(tokenId);
  const metadataHash = String(brainData[0]);
  const encryptedKeyURI = String(brainData[1]);
  const parentTokenId = BigInt(brainData[2].toString());
  const rootHash = parseZeroGRootHash(metadataHash);

  return { tokenId, contractAddress, tokenURI, metadataHash, encryptedKeyURI, parentTokenId, rootHash };
}

export async function loadAgentBrainINFTAddress(): Promise<{ address: string; chainId?: number }> {
  const override = process.env.INFT_CONTRACT_ADDRESS ?? process.env.NEXT_PUBLIC_AGENT_BRAIN_INFT_ADDRESS;

  if (override) {
    return { address: getAddress(override) };
  }

  const addressesPath = process.env.CONTRACT_ADDRESSES_PATH ? resolve(process.env.CONTRACT_ADDRESSES_PATH) : defaultAddressesPath;
  const raw = await readFile(addressesPath, "utf8");
  const addresses = JSON.parse(raw) as ContractAddressesFile;
  const address = addresses.contracts?.AgentBrainINFT;

  if (!address) {
    throw new Error(`Missing contracts.AgentBrainINFT in ${addressesPath}. Set INFT_CONTRACT_ADDRESS to load an iNFT brain.`);
  }

  return { address: getAddress(address), chainId: addresses.chainId };
}

export function createINFTProvider(): JsonRpcProvider {
  const rpcUrl = process.env.INFT_RPC_URL ?? process.env.ZEROG_RPC_URL ?? process.env.SETTLEMENT_RPC_URL;

  if (!rpcUrl) {
    throw new Error("Loading AgentBrainINFT brain references requires INFT_RPC_URL or ZEROG_RPC_URL.");
  }

  return new JsonRpcProvider(rpcUrl);
}

export function parseZeroGRootHash(reference: string): string {
  const rootHash = reference.startsWith("0g://brain-key/")
    ? reference.slice("0g://brain-key/".length)
    : reference.startsWith("0g://")
      ? reference.slice("0g://".length)
      : reference;

  if (!/^0x[0-9a-fA-F]{64}$/.test(rootHash)) {
    throw new Error(`AgentBrainINFT reference is not a 0G root hash: ${reference}`);
  }

  return rootHash;
}
