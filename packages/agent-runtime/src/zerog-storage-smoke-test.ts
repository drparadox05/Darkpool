import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { SEEDED_AGENTS } from "@darkpool/shared";
import { BrainStore, createSeedBrain } from "./brain-store.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(srcDir, "..");
const repoRoot = resolve(packageDir, "../..");

dotenv.config({ path: resolve(repoRoot, ".env") });
dotenv.config();

async function main(): Promise<void> {
  assertRequiredEnv(["BRAINSTORE_PASSPHRASE", "ZEROG_PRIVATE_KEY", "ZEROG_STORAGE_INDEXER_RPC_URL"]);

  const profile = SEEDED_AGENTS[0];
  const brain = createSeedBrain(profile);
  const store = new BrainStore({
    provider: "0g",
    passphrase: process.env.BRAINSTORE_PASSPHRASE ?? "",
    zeroG: {
      rpcUrl: process.env.ZEROG_STORAGE_RPC_URL ?? process.env.ZEROG_RPC_URL,
      indexerRpcUrl: process.env.ZEROG_STORAGE_INDEXER_RPC_URL,
      privateKey: process.env.ZEROG_PRIVATE_KEY
    }
  });

  const receipt = await store.saveBrain(brain);
  const loaded = await store.loadBrain(receipt.rootHash);

  assert.equal(loaded.agentId, brain.agentId);
  assert.equal(loaded.ensName, brain.ensName);
  assert.equal(loaded.systemPrompt, brain.systemPrompt);

  console.log("✓ 0G Storage brain round-trip", {
    rootHash: receipt.rootHash,
    storageUri: receipt.storageUri,
    byteLength: receipt.byteLength,
    txHash: receipt.txHash ?? null,
    agentId: loaded.agentId,
    ensName: loaded.ensName
  });
}

function assertRequiredEnv(names: string[]): void {
  const missing = names.filter((name) => !process.env[name]);

  if (!process.env.ZEROG_STORAGE_RPC_URL && !process.env.ZEROG_RPC_URL) {
    missing.push("ZEROG_STORAGE_RPC_URL or ZEROG_RPC_URL");
  }

  if (missing.length > 0) {
    throw new Error(`Missing required 0G Storage env vars: ${missing.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
