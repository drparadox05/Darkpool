import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { JsonRpcProvider, Wallet } from "ethers";
import type { AgentBrainDocument, AgentProfile, BrainStorageReceipt, EncryptedBrainEnvelope } from "@darkpool/shared";

const scrypt = promisify(scryptCallback);
const ENVELOPE_VERSION = "aes-256-gcm-scrypt-v1" as const;

export type BrainStorageProvider = "local" | "0g";

export type BrainStoreOptions = {
  provider?: BrainStorageProvider;
  localDir?: string;
  passphrase: string;
  zeroG?: ZeroGStorageOptions;
};

export type ZeroGStorageOptions = {
  rpcUrl?: string;
  indexerRpcUrl?: string;
  privateKey?: string;
  finalityRequired?: boolean;
  expectedReplica?: number;
  skipTx?: boolean;
  skipIfFinalized?: boolean;
  feeWei?: bigint;
  gasPriceWei?: bigint;
  gasLimit?: bigint;
};

export class BrainStore {
  readonly provider: BrainStorageProvider;
  readonly localDir: string;
  private readonly passphrase: string;
  private readonly zeroG: ZeroGStorageOptions;

  constructor(options: BrainStoreOptions) {
    this.provider = options.provider ?? "local";
    this.localDir = options.localDir ?? resolve(process.cwd(), ".darkpool-storage", "brains");
    this.passphrase = options.passphrase;
    this.zeroG = options.zeroG ?? {};

    if (!this.passphrase) {
      throw new Error("BrainStore requires BRAINSTORE_PASSPHRASE or an explicit passphrase.");
    }
  }

  async saveBrain(brain: AgentBrainDocument): Promise<BrainStorageReceipt> {
    const envelope = await encryptBrain(brain, this.passphrase);

    if (this.provider === "0g") {
      return this.saveEncryptedEnvelopeToZeroG(envelope);
    }

    return this.saveEncryptedEnvelope(envelope);
  }

  async loadBrain(rootHash: string): Promise<AgentBrainDocument> {
    if (this.provider === "0g") {
      return this.loadEncryptedEnvelopeFromZeroG(rootHash);
    }

    const envelopePath = resolve(this.localDir, `${rootHash}.json`);
    const raw = await readFile(envelopePath, "utf8");
    return decryptBrain(JSON.parse(raw) as EncryptedBrainEnvelope, this.passphrase);
  }

  private async saveEncryptedEnvelope(envelope: EncryptedBrainEnvelope): Promise<BrainStorageReceipt> {
    await mkdir(this.localDir, { recursive: true });

    const serialized = JSON.stringify(envelope, null, 2);
    const rootHash = `0g-local-${createHash("sha256").update(serialized).digest("hex")}`;
    const envelopePath = resolve(this.localDir, `${rootHash}.json`);

    await writeFile(envelopePath, `${serialized}\n`, "utf8");

    return {
      rootHash,
      storageUri: `local://${envelopePath}`,
      encryptedKeyURI: `local://brain-key/${rootHash}`,
      byteLength: Buffer.byteLength(serialized)
    };
  }

  private async saveEncryptedEnvelopeToZeroG(envelope: EncryptedBrainEnvelope): Promise<BrainStorageReceipt> {
    const serialized = JSON.stringify(envelope, null, 2);
    const adapter = await createZeroGStorageAdapter(this.zeroG);
    const upload = await adapter.upload(Buffer.from(`${serialized}\n`, "utf8"));

    return {
      rootHash: upload.rootHash,
      storageUri: `0g://${upload.rootHash}`,
      encryptedKeyURI: `0g://brain-key/${upload.rootHash}`,
      byteLength: Buffer.byteLength(serialized),
      txHash: upload.txHash
    };
  }

  private async loadEncryptedEnvelopeFromZeroG(rootHash: string): Promise<AgentBrainDocument> {
    const adapter = await createZeroGStorageAdapter(this.zeroG);
    const raw = await adapter.download(rootHash);
    return decryptBrain(JSON.parse(raw.toString("utf8")) as EncryptedBrainEnvelope, this.passphrase);
  }
}

type ZeroGStorageAdapter = {
  upload(data: Buffer): Promise<{ rootHash: string; txHash?: string }>;
  download(rootHash: string): Promise<Buffer>;
};

type ZeroGStorageSdk = {
  Indexer: new (indexerRpcUrl: string) => unknown;
  MemData?: new (data: Uint8Array) => unknown;
  ZgFile?: { fromFilePath(filePath: string): Promise<unknown> };
};

async function createZeroGStorageAdapter(options: ZeroGStorageOptions): Promise<ZeroGStorageAdapter> {
  const rpcUrl = options.rpcUrl ?? process.env.ZEROG_STORAGE_RPC_URL ?? process.env.ZEROG_RPC_URL;
  const indexerRpcUrl = options.indexerRpcUrl ?? process.env.ZEROG_STORAGE_INDEXER_RPC_URL;
  const privateKey = options.privateKey ?? process.env.ZEROG_PRIVATE_KEY;

  if (!rpcUrl) {
    throw new Error("0G Storage requires ZEROG_STORAGE_RPC_URL or ZEROG_RPC_URL.");
  }

  if (!indexerRpcUrl) {
    throw new Error("0G Storage requires ZEROG_STORAGE_INDEXER_RPC_URL.");
  }

  if (!privateKey) {
    throw new Error("0G Storage requires ZEROG_PRIVATE_KEY.");
  }

  const sdk = await loadZeroGStorageSdk();
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(privateKey, provider);
  const indexer = patchZeroGIndexerCompatibility(new sdk.Indexer(indexerRpcUrl) as ZeroGIndexer, indexerRpcUrl);
  const uploadOptions = createZeroGUploadOptions(options);
  const transactionOptions = createZeroGTransactionOptions(options);

  return {
    async upload(data) {
      if (sdk.MemData) {
        const memData = new sdk.MemData(new Uint8Array(data)) as ZeroGUploadData;
        const [tree, treeError] = await memData.merkleTree();

        if (treeError !== null) {
          throw new Error(`0G Storage merkle tree error: ${stringifyZeroGError(treeError)}`);
        }

        const [uploadResult, uploadError] = await indexer.upload(memData, rpcUrl, signer, uploadOptions, undefined, transactionOptions);

        if (uploadError !== null) {
          throw new Error(`0G Storage upload error: ${stringifyZeroGError(uploadError)}`);
        }

        return normalizeZeroGUploadResult(uploadResult, tree?.rootHash());
      }

      return uploadViaTemporaryFile({ data, sdk, indexer, rpcUrl, signer, uploadOptions, transactionOptions });
    },
    async download(rootHash) {
      const outputPath = resolve(process.cwd(), ".darkpool-storage", "0g-downloads", `${rootHash}.json`);
      await mkdir(resolve(outputPath, ".."), { recursive: true });

      const error = await indexer.download(rootHash, outputPath, true);

      if (error !== null) {
        throw new Error(`0G Storage download error: ${stringifyZeroGError(error)}`);
      }

      try {
        return await readFile(outputPath);
      } finally {
        await rm(outputPath, { force: true });
      }
    }
  };
}

async function loadZeroGStorageSdk(): Promise<ZeroGStorageSdk> {
  const overridePackageName = process.env.ZEROG_STORAGE_SDK_PACKAGE;
  const packageNames = overridePackageName ? [overridePackageName] : ["@0gfoundation/0g-ts-sdk", "@0gfoundation/0g-storage-ts-sdk", "@0glabs/0g-ts-sdk"];
  let lastError: unknown = null;

  for (const packageName of packageNames) {
    try {
      return (await import(packageName)) as ZeroGStorageSdk;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`0G Storage provider requires one of ${packageNames.join(", ")}. Install a supported SDK in @darkpool/agent-runtime before setting BRAINSTORE_PROVIDER=0g. Cause: ${stringifyZeroGError(lastError)}`);
}

async function uploadViaTemporaryFile(options: {
  data: Buffer;
  sdk: ZeroGStorageSdk;
  indexer: ZeroGIndexer;
  rpcUrl: string;
  signer: Wallet;
  uploadOptions?: ZeroGUploadOptions;
  transactionOptions?: ZeroGTransactionOptions;
}): Promise<{ rootHash: string; txHash?: string }> {
  if (!options.sdk.ZgFile) {
    throw new Error("0G Storage SDK does not expose MemData or ZgFile upload helpers.");
  }

  const tempDir = resolve(process.cwd(), ".darkpool-storage", "0g-upload-tmp");
  await mkdir(tempDir, { recursive: true });
  const tempPath = resolve(tempDir, `brain-${Date.now()}-${randomBytes(6).toString("hex")}.json`);
  let file: (ZeroGUploadData & { close?: () => Promise<void> }) | null = null;

  try {
    await writeFile(tempPath, options.data);
    file = (await options.sdk.ZgFile.fromFilePath(tempPath)) as ZeroGUploadData & { close?: () => Promise<void> };
    const [tree, treeError] = await file.merkleTree();

    if (treeError !== null) {
      throw new Error(`0G Storage merkle tree error: ${stringifyZeroGError(treeError)}`);
    }

    const [uploadResult, uploadError] = await options.indexer.upload(file, options.rpcUrl, options.signer, options.uploadOptions, undefined, options.transactionOptions);

    if (uploadError !== null) {
      throw new Error(`0G Storage upload error: ${stringifyZeroGError(uploadError)}`);
    }

    return normalizeZeroGUploadResult(uploadResult, tree?.rootHash());
  } finally {
    await file?.close?.();
    await rm(tempPath, { force: true });
  }
}

type ZeroGIndexer = {
  getShardedNodes?: () => Promise<unknown>;
  upload(data: ZeroGUploadData, rpcUrl: string, signer: Wallet, uploadOptions?: ZeroGUploadOptions, retryOptions?: unknown, transactionOptions?: ZeroGTransactionOptions): Promise<[unknown, unknown | null]>;
  download(rootHash: string, outputPath: string, withProof: boolean): Promise<unknown | null>;
};

type ZeroGUploadOptions = {
  finalityRequired?: boolean;
  expectedReplica?: number;
  skipTx?: boolean;
  skipIfFinalized?: boolean;
  fee?: bigint;
  onProgress?: (message: string) => void;
};

type ZeroGTransactionOptions = {
  gasPrice?: bigint;
  gasLimit?: bigint;
};

type ZeroGUploadData = {
  merkleTree(): Promise<[ZeroGMerkleTree | null, unknown | null]>;
};

type ZeroGMerkleTree = {
  rootHash(): string;
};

function normalizeZeroGUploadResult(uploadResult: unknown, fallbackRootHash?: string): { rootHash: string; txHash?: string } {
  if (!uploadResult || typeof uploadResult !== "object") {
    if (fallbackRootHash) {
      return { rootHash: fallbackRootHash };
    }

    throw new Error("0G Storage upload returned an empty result.");
  }

  const result = uploadResult as { rootHash?: unknown; txHash?: unknown; rootHashes?: unknown; txHashes?: unknown };
  const rootHash = typeof result.rootHash === "string" ? result.rootHash : Array.isArray(result.rootHashes) && typeof result.rootHashes[0] === "string" ? result.rootHashes[0] : fallbackRootHash;

  if (!rootHash) {
    throw new Error(`0G Storage upload did not return a root hash: ${JSON.stringify(uploadResult)}`);
  }

  const txHash = typeof result.txHash === "string" ? result.txHash : Array.isArray(result.txHashes) && typeof result.txHashes[0] === "string" ? result.txHashes[0] : undefined;

  return { rootHash, txHash };
}

function stringifyZeroGError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function patchZeroGIndexerCompatibility(indexer: ZeroGIndexer, indexerRpcUrl: string): ZeroGIndexer {
  indexer.getShardedNodes = async () => requestZeroGIndexer(indexerRpcUrl, "indexer_getShardedNodes", []);
  return indexer;
}

async function requestZeroGIndexer(indexerRpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(indexerRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`0G Storage indexer ${method} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }

  const parsed = JSON.parse(text) as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

  if (parsed.error) {
    throw new Error(`0G Storage indexer ${method} error ${parsed.error.code ?? "unknown"}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
  }

  return parsed.result;
}

function createZeroGUploadOptions(options: ZeroGStorageOptions): ZeroGUploadOptions | undefined {
  const uploadOptions: ZeroGUploadOptions = {};
  const finalityRequired = options.finalityRequired ?? parseOptionalBoolean(process.env.ZEROG_STORAGE_FINALITY_REQUIRED);
  const expectedReplica = options.expectedReplica ?? parseOptionalPositiveInteger(process.env.ZEROG_STORAGE_EXPECTED_REPLICA);
  const skipTx = options.skipTx ?? parseOptionalBoolean(process.env.ZEROG_STORAGE_SKIP_TX);
  const skipIfFinalized = options.skipIfFinalized ?? parseOptionalBoolean(process.env.ZEROG_STORAGE_SKIP_IF_FINALIZED);
  const fee = options.feeWei ?? parseOptionalBigInt(process.env.ZEROG_STORAGE_FEE_WEI);

  if (finalityRequired !== undefined) {
    uploadOptions.finalityRequired = finalityRequired;
  }

  if (expectedReplica !== undefined) {
    uploadOptions.expectedReplica = expectedReplica;
  }

  if (skipTx !== undefined) {
    uploadOptions.skipTx = skipTx;
  }

  if (skipIfFinalized !== undefined) {
    uploadOptions.skipIfFinalized = skipIfFinalized;
  }

  if (fee !== undefined) {
    uploadOptions.fee = fee;
  }

  if (parseOptionalBoolean(process.env.ZEROG_STORAGE_LOG_PROGRESS) === true) {
    uploadOptions.onProgress = (message) => console.log(`[0g-storage] ${message}`);
  }

  return Object.keys(uploadOptions).length > 0 ? uploadOptions : undefined;
}

function createZeroGTransactionOptions(options: ZeroGStorageOptions): ZeroGTransactionOptions | undefined {
  const transactionOptions: ZeroGTransactionOptions = {};
  const gasPrice = options.gasPriceWei ?? parseOptionalBigInt(process.env.ZEROG_STORAGE_GAS_PRICE_WEI);
  const gasLimit = options.gasLimit ?? parseOptionalBigInt(process.env.ZEROG_STORAGE_GAS_LIMIT);

  if (gasPrice !== undefined) {
    transactionOptions.gasPrice = gasPrice;
  }

  if (gasLimit !== undefined) {
    transactionOptions.gasLimit = gasLimit;
  }

  return Object.keys(transactionOptions).length > 0 ? transactionOptions : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`Expected boolean env value, received ${value}.`);
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer env value, received ${value}.`);
  }

  return parsed;
}

function parseOptionalBigInt(value: string | undefined): bigint | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  return BigInt(value);
}

export async function encryptBrain(brain: AgentBrainDocument, passphrase: string): Promise<EncryptedBrainEnvelope> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = (await scrypt(passphrase, salt, 32)) as Buffer;
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plainText = Buffer.from(JSON.stringify(brain), "utf8");
  const cipherText = Buffer.concat([cipher.update(plainText), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: ENVELOPE_VERSION,
    cipherText: cipherText.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    salt: salt.toString("base64"),
    createdAt: new Date().toISOString(),
    metadata: {
      agentId: brain.agentId,
      ensName: brain.ensName
    }
  };
}

export async function decryptBrain(envelope: EncryptedBrainEnvelope, passphrase: string): Promise<AgentBrainDocument> {
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported brain envelope version: ${envelope.version}`);
  }

  const key = (await scrypt(passphrase, Buffer.from(envelope.salt, "base64"), 32)) as Buffer;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plainText = Buffer.concat([decipher.update(Buffer.from(envelope.cipherText, "base64")), decipher.final()]);

  return JSON.parse(plainText.toString("utf8")) as AgentBrainDocument;
}

export function createSeedBrain(profile: AgentProfile): AgentBrainDocument {
  const riskTolerance = profile.role === "aggressive" ? "high" : profile.role === "conservative" ? "low" : "medium";

  return {
    version: "1",
    agentId: profile.id,
    ensName: profile.ensName,
    role: profile.role,
    systemPrompt: `You are ${profile.ensName}, a ${profile.role} dark-pool OTC trading agent. Negotiate privately, obey risk limits, and only accept atomic settlement-compatible swaps.`,
    strategy: {
      riskTolerance,
      maxSlippageBps: profile.role === "aggressive" ? 120 : profile.role === "conservative" ? 35 : 75,
      minProfitBps: profile.role === "arbitrageur" ? 40 : 10,
      preferredPairs: profile.pairs
    },
    memoryLog: [
      {
        timestamp: new Date().toISOString(),
        kind: "observation",
        content: profile.intent
      }
    ]
  };
}

export function createBrainStoreFromEnv(overrides: Partial<BrainStoreOptions> = {}): BrainStore {
  return new BrainStore({
    provider: overrides.provider ?? (process.env.BRAINSTORE_PROVIDER as BrainStorageProvider | undefined) ?? "local",
    localDir: overrides.localDir ?? process.env.BRAINSTORE_LOCAL_DIR,
    passphrase: overrides.passphrase ?? process.env.BRAINSTORE_PASSPHRASE ?? "",
    zeroG: overrides.zeroG ?? {
      rpcUrl: process.env.ZEROG_STORAGE_RPC_URL ?? process.env.ZEROG_RPC_URL,
      indexerRpcUrl: process.env.ZEROG_STORAGE_INDEXER_RPC_URL,
      privateKey: process.env.ZEROG_PRIVATE_KEY
    }
  });
}
