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
  const providerAddress = process.env.ZEROG_COMPUTE_PROVIDER_ADDRESS ?? process.argv[2];
  const depositAmount = Number(process.env.ZEROG_COMPUTE_DEPOSIT_AMOUNT ?? "3");
  const transferAmountWei = parseAmountToWei(process.env.ZEROG_COMPUTE_TRANSFER_AMOUNT ?? "1");

  if (!rpcUrl) {
    throw new Error("Missing ZEROG_COMPUTE_RPC_URL or ZEROG_RPC_URL.");
  }

  if (!privateKey) {
    throw new Error("Missing ZEROG_COMPUTE_PRIVATE_KEY or ZEROG_PRIVATE_KEY.");
  }

  if (!providerAddress) {
    throw new Error("Missing ZEROG_COMPUTE_PROVIDER_ADDRESS or provider address CLI argument.");
  }

  const broker = await createBroker(rpcUrl, privateKey);

  console.log("Funding 0G Compute account", {
    providerAddress,
    depositAmount,
    transferAmount: process.env.ZEROG_COMPUTE_TRANSFER_AMOUNT ?? "1"
  });

  const deposit = await broker.ledger.depositFund(depositAmount);
  console.log("✓ deposited to 0G Compute ledger", normalizeTx(deposit));

  const transfer = await broker.ledger.transferFund(providerAddress, "inference", transferAmountWei);
  console.log("✓ transferred to 0G Compute provider sub-account", normalizeTx(transfer));
  process.exit(0);
}

type ComputeBroker = {
  ledger: {
    depositFund(amount: number): Promise<unknown>;
    transferFund(providerAddress: string, serviceType: string, amount: bigint): Promise<unknown>;
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

  throw new Error(`0G Compute funding requires one of ${packageNames.join(", ")}. Cause: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function parseAmountToWei(amount: string): bigint {
  const [whole, fractional = ""] = amount.split(".");
  const paddedFractional = `${fractional}${"0".repeat(18)}`.slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(paddedFractional);
}

function normalizeTx(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }

  const record = result as Record<string, unknown>;
  return {
    hash: record.hash,
    transactionHash: record.transactionHash,
    blockNumber: record.blockNumber
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
