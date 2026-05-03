import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { SEEDED_AGENTS } from "@darkpool/shared";
import type { SignedSwapOrder } from "@darkpool/shared";
import { startAgentRuntime } from "./index.js";
import { startMockAxlNode } from "./mock-axl-node.js";
import { runNegotiation } from "./negotiation.js";
import { createAgentWallet, loadSettlementAddresses, MOCK_ERC20_ABI, resolveTokenAddress, type SettlementAddresses } from "./settlement.js";

const HARDHAT_RPC_URL = "http://127.0.0.1:8545";
// Public Hardhat deterministic test account #0 — NOT a real secret.
// Documented at https://hardhat.org/hardhat-network/docs/reference#accounts
const HARDHAT_DEPLOYER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const srcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(srcDir, "../../..");
const contractsDir = resolve(repoRoot, "packages/contracts");
const localAddressesPath = resolve(repoRoot, ".darkpool-storage", "contracts-addresses.local.json");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type RunningProcess = {
  process: ChildProcess;
  stop(): Promise<void>;
};

async function main(): Promise<void> {
  const hardhat = await startHardhatNode();

  try {
    await deployContracts();
    const addresses = await requireAddresses();
    const provider = new JsonRpcProvider(HARDHAT_RPC_URL);
    const deployer = new Wallet(HARDHAT_DEPLOYER_PRIVATE_KEY, provider);
    const deployerNonce = { next: await provider.getTransactionCount(deployer.address, "pending") };
    const walletA = createAgentWallet("phase4-agent-a-seed").connect(provider);
    const walletB = createAgentWallet("phase4-agent-b-seed").connect(provider);
    const walletANonce = { next: await provider.getTransactionCount(walletA.address, "pending") };
    const walletBNonce = { next: await provider.getTransactionCount(walletB.address, "pending") };

    const weth = new Contract(addresses.tokens.mWETH, MOCK_ERC20_ABI, deployer);
    const usdc = new Contract(addresses.tokens.mUSDC, MOCK_ERC20_ABI, deployer);
    const settlementAddress = addresses.settlement;

    await fundNative(deployer, deployerNonce, walletA.address);
    await fundNative(deployer, deployerNonce, walletB.address);
    await fundAndApprove({ token: weth, owner: walletA, ownerNonce: walletANonce, deployer, deployerNonce, spender: settlementAddress, amount: 100n });
    await fundAndApprove({ token: usdc, owner: walletA, ownerNonce: walletANonce, deployer, deployerNonce, spender: settlementAddress, amount: 1_000_000n });
    await fundAndApprove({ token: weth, owner: walletB, ownerNonce: walletBNonce, deployer, deployerNonce, spender: settlementAddress, amount: 100n });
    await fundAndApprove({ token: usdc, owner: walletB, ownerNonce: walletBNonce, deployer, deployerNonce, spender: settlementAddress, amount: 1_000_000n });

    const beforeAWeth = await weth.balanceOf(walletA.address);
    const beforeAUsdc = await usdc.balanceOf(walletA.address);
    const beforeBWeth = await weth.balanceOf(walletB.address);
    const beforeBUsdc = await usdc.balanceOf(walletB.address);

    const [aggressive, conservative] = SEEDED_AGENTS;
    const axlA = await startMockAxlNode({
      peerId: "settle-smoke-agent-a",
      port: 19402,
      knownPeers: [{ peerId: "settle-smoke-agent-b", apiUrl: "http://127.0.0.1:19412" }]
    });
    const axlB = await startMockAxlNode({
      peerId: "settle-smoke-agent-b",
      port: 19412,
      knownPeers: [{ peerId: "settle-smoke-agent-a", apiUrl: "http://127.0.0.1:19402" }]
    });

    const agentA = await startAgentRuntime({
      profile: { ...aggressive, id: "settle-smoke-agent-a", peerId: "settle-smoke-agent-a", status: "online" },
      axlBaseUrl: axlA.apiUrl,
      axlTransport: "mock",
      mcpPort: 19502,
      privateKeySeed: "phase4-agent-a-seed",
      settlementAddresses: addresses,
      rpcUrl: HARDHAT_RPC_URL,
      settlementSubmitterPrivateKey: HARDHAT_DEPLOYER_PRIVATE_KEY,
      settlementAutoSubmit: true
    });
    const agentB = await startAgentRuntime({
      profile: { ...conservative, id: "settle-smoke-agent-b", peerId: "settle-smoke-agent-b", status: "online" },
      axlBaseUrl: axlB.apiUrl,
      axlTransport: "mock",
      mcpPort: 19512,
      privateKeySeed: "phase4-agent-b-seed",
      settlementAddresses: addresses,
      rpcUrl: HARDHAT_RPC_URL,
      settlementSubmitterPrivateKey: HARDHAT_DEPLOYER_PRIVATE_KEY,
      settlementAutoSubmit: true
    });

    await wait(200);

    const outcome = await runNegotiation(
      { axlClient: agentA.axlClient, signer: agentA.signer, settlement: agentA.settlement, tee: agentA.tee },
      {
        initiator: agentA.profile,
        counterpartyPeerId: agentB.profile.peerId,
        pair: "mWETH/mUSDC",
        sellToken: resolveTokenAddress("mWETH", addresses),
        buyToken: resolveTokenAddress("mUSDC", addresses),
        sellAmount: "2",
        referencePrice: 3000
      }
    );

    assert.equal(outcome.accepted, true, outcome.finalRationale);
    assert.ok(outcome.orderA && outcome.orderB, "accepted outcome should include submitted orders");

    const afterAWeth = await weth.balanceOf(walletA.address);
    const afterAUsdc = await usdc.balanceOf(walletA.address);
    const afterBWeth = await weth.balanceOf(walletB.address);
    const afterBUsdc = await usdc.balanceOf(walletB.address);

    assertTokenDeltas({
      addresses,
      before: { agentAWeth: beforeAWeth, agentAUsdc: beforeAUsdc, agentBWeth: beforeBWeth, agentBUsdc: beforeBUsdc },
      after: { agentAWeth: afterAWeth, agentAUsdc: afterAUsdc, agentBWeth: afterBWeth, agentBUsdc: afterBUsdc },
      orderA: outcome.orderA!.order,
      orderB: outcome.orderB!.order
    });

    console.log("✓ real settlement submitted", {
      accepted: outcome.accepted,
      rounds: outcome.rounds,
      orderHashes: { a: outcome.orderA!.orderHash, b: outcome.orderB!.orderHash },
      balances: {
        agentA: { mWETH: afterAWeth.toString(), mUSDC: afterAUsdc.toString() },
        agentB: { mWETH: afterBWeth.toString(), mUSDC: afterBUsdc.toString() }
      }
    });

    await agentA.close();
    await agentB.close();
    await axlA.close();
    await axlB.close();
  } finally {
    await hardhat.stop();
  }
}

async function startHardhatNode(): Promise<RunningProcess> {
  const child = spawn("pnpm", ["exec", "hardhat", "node", "--hostname", "127.0.0.1"], {
    cwd: contractsDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  const start = Date.now();

  while (!isHardhatReady(output) && Date.now() - start < 60_000) {
    if (child.exitCode !== null) {
      throw new Error(`Hardhat node exited early:\n${output}`);
    }

    await wait(200);
  }

  if (!isHardhatReady(output)) {
    child.kill("SIGTERM");
    throw new Error(`Timed out waiting for Hardhat node:\n${output}`);
  }

  return {
    process: child,
    async stop() {
      if (child.exitCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), wait(5_000)]);
    }
  };
}

async function deployContracts(): Promise<void> {
  await mkdir(dirname(localAddressesPath), { recursive: true });

  const deploy = spawn("pnpm", ["deploy:contracts:local"], {
    cwd: repoRoot,
    env: { ...process.env, HARDHAT_NETWORK: "localhost", CONTRACT_ADDRESSES_PATH: localAddressesPath },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  deploy.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  deploy.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  const [code] = (await once(deploy, "exit")) as [number | null];

  if (code !== 0) {
    throw new Error(`Contract deployment failed:\n${output}`);
  }
}

function isHardhatReady(output: string): boolean {
  return output.includes("Started HTTP and WebSocket JSON-RPC server") || output.includes("JSON-RPC server") || output.includes("Account #0");
}

async function requireAddresses(): Promise<SettlementAddresses> {
  const addresses = await loadSettlementAddresses(localAddressesPath);

  if (!addresses) {
    throw new Error("Missing packages/contracts/addresses.json after deployment");
  }

  return addresses;
}

async function fundAndApprove(options: {
  token: Contract;
  owner: Wallet;
  ownerNonce: { next: number };
  deployer: Wallet;
  deployerNonce: { next: number };
  spender: string;
  amount: bigint;
}): Promise<void> {
  const tokenAsDeployer = options.token.connect(options.deployer);
  const tokenAsOwner = options.token.connect(options.owner);

  await (
    await tokenAsDeployer.getFunction("mint")(options.owner.address, options.amount, {
      nonce: options.deployerNonce.next++
    })
  ).wait();
  await (
    await tokenAsOwner.getFunction("approve")(options.spender, options.amount, {
      nonce: options.ownerNonce.next++
    })
  ).wait();
}

function assertTokenDeltas(options: {
  addresses: SettlementAddresses;
  before: { agentAWeth: bigint; agentAUsdc: bigint; agentBWeth: bigint; agentBUsdc: bigint };
  after: { agentAWeth: bigint; agentAUsdc: bigint; agentBWeth: bigint; agentBUsdc: bigint };
  orderA: SignedSwapOrder["order"];
  orderB: SignedSwapOrder["order"];
}): void {
  const expected = {
    agentAWeth: options.before.agentAWeth,
    agentAUsdc: options.before.agentAUsdc,
    agentBWeth: options.before.agentBWeth,
    agentBUsdc: options.before.agentBUsdc
  };

  applyDelta(expected, "agentA", options.orderA.sellToken, -BigInt(options.orderA.sellAmount), options.addresses);
  applyDelta(expected, "agentA", options.orderA.buyToken, BigInt(options.orderA.buyAmount), options.addresses);
  applyDelta(expected, "agentB", options.orderB.sellToken, -BigInt(options.orderB.sellAmount), options.addresses);
  applyDelta(expected, "agentB", options.orderB.buyToken, BigInt(options.orderB.buyAmount), options.addresses);

  assert.equal(options.after.agentAWeth, expected.agentAWeth, "agent A mWETH balance mismatch");
  assert.equal(options.after.agentAUsdc, expected.agentAUsdc, "agent A mUSDC balance mismatch");
  assert.equal(options.after.agentBWeth, expected.agentBWeth, "agent B mWETH balance mismatch");
  assert.equal(options.after.agentBUsdc, expected.agentBUsdc, "agent B mUSDC balance mismatch");
}

function applyDelta(
  balances: { agentAWeth: bigint; agentAUsdc: bigint; agentBWeth: bigint; agentBUsdc: bigint },
  agent: "agentA" | "agentB",
  token: string,
  amount: bigint,
  addresses: SettlementAddresses
): void {
  const normalizedToken = token.toLowerCase();

  if (normalizedToken === addresses.tokens.mWETH.toLowerCase()) {
    if (agent === "agentA") {
      balances.agentAWeth += amount;
    } else {
      balances.agentBWeth += amount;
    }
    return;
  }

  if (normalizedToken === addresses.tokens.mUSDC.toLowerCase()) {
    if (agent === "agentA") {
      balances.agentAUsdc += amount;
    } else {
      balances.agentBUsdc += amount;
    }
    return;
  }

  throw new Error(`Unexpected token in settlement smoke: ${token}`);
}

async function fundNative(deployer: Wallet, deployerNonce: { next: number }, recipient: string): Promise<void> {
  await (
    await deployer.sendTransaction({
      to: recipient,
      value: 10n ** 18n,
      nonce: deployerNonce.next++
    })
  ).wait();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
