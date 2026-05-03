import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { JsonRpcProvider, Wallet } from "ethers";

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(srcDir, "..");
const repoRoot = resolve(packageDir, "../..");

dotenv.config({ path: resolve(repoRoot, ".env") });
dotenv.config();

async function main(): Promise<void> {
  const rpcUrl = process.env.ZEROG_COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL;
  const privateKey = process.env.ZEROG_COMPUTE_PRIVATE_KEY ?? process.env.ZEROG_PRIVATE_KEY;

  if (!rpcUrl) {
    throw new Error("Missing ZEROG_COMPUTE_RPC_URL or ZEROG_RPC_URL.");
  }

  if (!privateKey) {
    throw new Error("Missing ZEROG_COMPUTE_PRIVATE_KEY or ZEROG_PRIVATE_KEY.");
  }

  const broker = await createBroker(rpcUrl, privateKey);
  const services = await broker.inference.listService();

  console.log("✓ 0G Compute providers", normalizeServices(services));
}

type ComputeBroker = {
  inference: {
    listService(): Promise<unknown>;
  };
};

type ComputeSdk = {
  createZGComputeNetworkBroker(wallet: Wallet): Promise<ComputeBroker>;
};

async function createBroker(rpcUrl: string, privateKey: string): Promise<ComputeBroker> {
  const packageNames = ["@0glabs/0g-serving-broker", "@0gfoundation/0g-compute-ts-sdk"];
  let lastError: unknown = null;

  for (const packageName of packageNames) {
    try {
      const sdk = (await import(packageName)) as ComputeSdk;
      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);
      return sdk.createZGComputeNetworkBroker(wallet);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`0G Compute provider discovery requires one of ${packageNames.join(", ")}. Cause: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function normalizeServices(services: unknown): unknown {
  if (!Array.isArray(services)) {
    return services;
  }

  return services.map((service) => {
    if (!service || typeof service !== "object") {
      return service;
    }

    const record = service as Record<string, unknown>;
    return {
      provider: record.provider ?? record.providerAddress ?? record.address,
      model: record.model,
      name: record.name,
      endpoint: record.endpoint,
      verifiability: record.verifiability,
      inputPrice: record.inputPrice,
      outputPrice: record.outputPrice
    };
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
