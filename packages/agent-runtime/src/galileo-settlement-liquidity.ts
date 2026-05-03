import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Contract, JsonRpcProvider, MaxUint256, Wallet, formatUnits, parseEther, parseUnits } from "ethers";
import { createAgentWallet, loadSettlementAddresses, MOCK_ERC20_ABI, type SettlementAddresses } from "./settlement.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(srcDir, "..");
const repoRoot = resolve(packageDir, "../..");
const MIN_AGENT_GAS = parseEther("0.02");
const TARGET_AGENT_GAS = parseEther("0.05");
const DEFAULT_TOKEN_TARGETS: Record<string, string> = {
  mUSDC: "1000000",
  mWETH: "1000",
  mDAI: "1000000"
};

const wait = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

dotenv.config({ path: resolve(repoRoot, ".env") });
dotenv.config();

type WalletTarget = {
  label: string;
  wallet: Wallet;
};

async function main(): Promise<void> {
  const addresses = await requireAddresses();
  const rpcUrl = process.env.SETTLEMENT_RPC_URL ?? process.env.ZEROG_RPC_URL;
  const submitterPrivateKey = process.env.SETTLEMENT_SUBMITTER_PRIVATE_KEY ?? process.env.ZEROG_PRIVATE_KEY;
  const checkOnly = process.argv.includes("--check") || process.env.SETTLEMENT_LIQUIDITY_CHECK_ONLY === "true";

  if (!rpcUrl) {
    throw new Error("Missing SETTLEMENT_RPC_URL or ZEROG_RPC_URL.");
  }

  if (!submitterPrivateKey && !checkOnly) {
    throw new Error("Missing SETTLEMENT_SUBMITTER_PRIVATE_KEY or ZEROG_PRIVATE_KEY. This key pays gas and mints mock demo tokens.");
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();

  if (Number(network.chainId) !== addresses.chainId) {
    throw new Error(`Unexpected chain id ${network.chainId}. Expected deployed addresses chain ${addresses.chainId}.`);
  }

  const submitter = submitterPrivateKey ? new Wallet(submitterPrivateKey, provider) : null;
  const targets = resolveWalletTargets().map((target) => ({ ...target, wallet: target.wallet.connect(provider) }));

  if (!targets.length) {
    throw new Error("No agent wallet targets resolved. Set AGENT_ID/AXL_PEER_ID/AGENT_ENS or SETTLEMENT_LIQUIDITY_AGENT_SEEDS.");
  }

  console.log("Ensuring Galileo settlement liquidity", {
    chainId: addresses.chainId,
    settlement: addresses.settlement,
    mode: checkOnly ? "check" : "fund",
    submitter: submitter?.address ?? null,
    targets: targets.map((target) => ({ label: target.label, address: target.wallet.address }))
  });

  for (const target of targets) {
    await ensureNativeGas(provider, submitter, target.wallet.address, checkOnly);
    await ensureTokenBalancesAndApprovals(addresses, provider, submitter, target, checkOnly);
  }

  console.log(checkOnly ? "✓ Galileo settlement liquidity check complete" : "✓ Galileo settlement liquidity ready");
  process.exit(0);
}

async function requireAddresses(): Promise<SettlementAddresses> {
  const addresses = await loadSettlementAddresses();

  if (!addresses) {
    throw new Error("Missing packages/contracts/addresses.json after Galileo deployment.");
  }

  return addresses;
}

function resolveWalletTargets(): WalletTarget[] {
  const targets: WalletTarget[] = [];
  const explicitSeeds = splitCsv(process.env.SETTLEMENT_LIQUIDITY_AGENT_SEEDS);

  for (const [index, seed] of explicitSeeds.entries()) {
    addTarget(targets, `explicit-seed-${index + 1}`, seed);
  }

  const id = process.env.AGENT_ID;
  const ensName = process.env.AGENT_ENS;
  const peerId = process.env.AXL_PEER_ID ?? id;

  if (isMeaningfulValue(id) && isMeaningfulValue(ensName) && isMeaningfulValue(peerId)) {
    addTarget(targets, id, resolveAgentSeed(id, peerId, ensName));
  }

  for (const idCandidate of ["agent-a", "agent-b", "agent-c"]) {
    const privateKey = getAgentPrivateKeyEnvValue(agentPrivateKeyEnvName(idCandidate));

    if (privateKey) {
      addTarget(targets, idCandidate, privateKey);
    }
  }

  const agentBPeerId = process.env.AGENT_B_PEER_ID;

  if (isMeaningfulValue(agentBPeerId)) {
    addTarget(targets, "agent-b-from-peer", resolveAgentSeed("agent-b", agentBPeerId, "conservative.darkpool-agents.eth"));
  }

  return dedupeTargets(targets);
}

function addTarget(targets: WalletTarget[], label: string, seed: string): void {
  try {
    targets.push({ label, wallet: createAgentWallet(seed) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Skipping ${label}: could not derive settlement wallet (${message})`);
  }
}

function isMeaningfulValue(value: string | undefined): value is string {
  return Boolean(value && value !== "null" && value !== "undefined");
}

function resolveAgentSeed(id: string, peerId: string, ensName: string): string {
  return getAgentPrivateKeyEnvValue(agentPrivateKeyEnvName(peerId)) ?? getAgentPrivateKeyEnvValue(agentPrivateKeyEnvName(id)) ?? `${peerId}-${ensName}`;
}

function agentPrivateKeyEnvName(value: string): string {
  return `AGENT_PRIVATE_KEY_${value.toUpperCase().replace(/-/g, "_")}`;
}

function getEnvValue(name: string): string | undefined {
  const value = process.env[name];

  return value ? value : undefined;
}

function getAgentPrivateKeyEnvValue(name: string): string | undefined {
  const value = getEnvValue(name);

  if (!value) {
    return undefined;
  }

  return /^0x[0-9a-fA-F]{64}$/.test(value) ? value : undefined;
}

function splitCsv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function dedupeTargets(targets: WalletTarget[]): WalletTarget[] {
  const seen = new Set<string>();
  const deduped: WalletTarget[] = [];

  for (const target of targets) {
    const normalized = target.wallet.address.toLowerCase();

    if (!seen.has(normalized)) {
      seen.add(normalized);
      deduped.push(target);
    }
  }

  return deduped;
}

async function ensureNativeGas(provider: JsonRpcProvider, submitter: Wallet | null, recipient: string, checkOnly: boolean): Promise<void> {
  const balance = await provider.getBalance(recipient);

  if (balance >= MIN_AGENT_GAS) {
    console.log(`✓ native gas ready for ${recipient}: ${formatUnits(balance, 18)}`);
    return;
  }

  const topUp = TARGET_AGENT_GAS - balance;

  if (checkOnly) {
    console.log(`Needs native gas for ${recipient}: current ${formatUnits(balance, 18)}, top-up ${formatUnits(topUp, 18)}`);
    return;
  }

  if (!submitter) {
    throw new Error("Missing submitter wallet for native gas top-up.");
  }

  console.log(`Funding native gas for ${recipient}: +${formatUnits(topUp, 18)}`);
  await (await submitter.sendTransaction({ to: recipient, value: topUp })).wait();
  await wait(500);
}

async function ensureTokenBalancesAndApprovals(
  addresses: SettlementAddresses,
  provider: JsonRpcProvider,
  submitter: Wallet | null,
  target: WalletTarget,
  checkOnly: boolean
): Promise<void> {
  for (const [symbol, tokenAddress] of Object.entries(addresses.tokens)) {
    const tokenReader = new Contract(tokenAddress, MOCK_ERC20_ABI, provider);
    const tokenAsSubmitter = submitter ? tokenReader.connect(submitter) : null;
    const tokenAsOwner = tokenReader.connect(target.wallet);
    const decimals = Number(await tokenReader.getFunction("decimals")());
    const targetAmount = parseUnits(process.env[`SETTLEMENT_LIQUIDITY_${symbol}`] ?? DEFAULT_TOKEN_TARGETS[symbol] ?? "1000000", decimals);
    const balance = BigInt(await tokenReader.getFunction("balanceOf")(target.wallet.address));

    if (balance < targetAmount) {
      const mintAmount = targetAmount - balance;

      if (checkOnly) {
        console.log(`Needs ${symbol} mint for ${target.label}: current ${formatUnits(balance, decimals)}, target ${formatUnits(targetAmount, decimals)}`);
      } else {
        if (!tokenAsSubmitter) {
          throw new Error(`Missing submitter wallet for ${symbol} mint.`);
        }

        console.log(`Minting ${formatUnits(mintAmount, decimals)} ${symbol} to ${target.label} ${target.wallet.address}`);
        await (await tokenAsSubmitter.getFunction("mint")(target.wallet.address, mintAmount)).wait();
        await wait(500);
      }
    } else {
      console.log(`✓ ${symbol} balance ready for ${target.label}: ${formatUnits(balance, decimals)}`);
    }

    const allowance = BigInt(await tokenReader.getFunction("allowance")(target.wallet.address, addresses.settlement));

    if (allowance < targetAmount) {
      if (checkOnly) {
        console.log(`Needs ${symbol} approval for ${target.label}: current ${formatUnits(allowance, decimals)}, target ${formatUnits(targetAmount, decimals)}`);
      } else {
        console.log(`Approving settlement for ${target.label} ${symbol}`);
        await (await tokenAsOwner.getFunction("approve")(addresses.settlement, MaxUint256)).wait();
        await wait(500);
      }
    } else {
      console.log(`✓ ${symbol} allowance ready for ${target.label}: ${formatUnits(allowance, decimals)}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
