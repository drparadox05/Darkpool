import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import type { SignedSwapOrder } from "@darkpool/shared";
import {
  createAgentWallet,
  createSettlementClient,
  createSettlementSigner,
  loadSettlementAddresses,
  MOCK_ERC20_ABI,
  resolveTokenAddress,
  type SettlementAddresses
} from "./settlement.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(srcDir, "..");
const repoRoot = resolve(packageDir, "../..");
const MIN_AGENT_GAS = 2n * 10n ** 16n;
const TARGET_AGENT_GAS = 5n * 10n ** 16n;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

dotenv.config({ path: resolve(repoRoot, ".env") });
dotenv.config();

async function main(): Promise<void> {
  const addresses = await requireAddresses();
  const rpcUrl = process.env.SETTLEMENT_RPC_URL ?? process.env.ZEROG_RPC_URL;
  const submitterPrivateKey = process.env.SETTLEMENT_SUBMITTER_PRIVATE_KEY ?? process.env.ZEROG_PRIVATE_KEY;

  if (!rpcUrl) {
    throw new Error("Missing SETTLEMENT_RPC_URL or ZEROG_RPC_URL.");
  }

  if (!submitterPrivateKey) {
    throw new Error("Missing SETTLEMENT_SUBMITTER_PRIVATE_KEY or ZEROG_PRIVATE_KEY.");
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();

  if (Number(network.chainId) !== addresses.chainId) {
    throw new Error(`Unexpected chain id ${network.chainId}. Expected deployed addresses chain ${addresses.chainId}.`);
  }

  const submitter = new Wallet(submitterPrivateKey, provider);
  const walletA = createAgentWallet("phase4-agent-a-seed").connect(provider);
  const walletB = createAgentWallet("phase4-agent-b-seed").connect(provider);
  const settlement = createSettlementClient({ addresses, rpcUrl, submitterPrivateKey });
  const signerA = createSettlementSigner(walletA);
  const signerB = createSettlementSigner(walletB);
  const weth = new Contract(addresses.tokens.mWETH, MOCK_ERC20_ABI, submitter);
  const usdc = new Contract(addresses.tokens.mUSDC, MOCK_ERC20_ABI, submitter);

  await ensureNativeGas(submitter, walletA.address);
  await ensureNativeGas(submitter, walletB.address);

  const wethAsA = weth.connect(walletA);
  const usdcAsB = usdc.connect(walletB);
  const sellWeth = 2n * 10n ** 15n;
  const buyUsdc = 6_000_000n;

  await (await weth.mint(walletA.address, sellWeth)).wait();
  await wait(500);
  await (await usdc.mint(walletB.address, buyUsdc)).wait();
  await wait(500);
  await (await wethAsA.getFunction("approve")(addresses.settlement, sellWeth)).wait();
  await wait(500);
  await (await usdcAsB.getFunction("approve")(addresses.settlement, buyUsdc)).wait();
  await wait(500);

  const beforeAWeth = await weth.balanceOf(walletA.address);
  const beforeAUsdc = await usdc.balanceOf(walletA.address);
  const beforeBWeth = await weth.balanceOf(walletB.address);
  const beforeBUsdc = await usdc.balanceOf(walletB.address);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 20 * 60).toString();
  const nonceBase = BigInt(Date.now());

  const orderA: SignedSwapOrder["order"] = {
    maker: walletA.address,
    taker: walletB.address,
    sellToken: resolveTokenAddress("mWETH", addresses),
    buyToken: resolveTokenAddress("mUSDC", addresses),
    sellAmount: sellWeth.toString(),
    buyAmount: buyUsdc.toString(),
    expiry,
    nonce: nonceBase.toString()
  };
  const orderB: SignedSwapOrder["order"] = {
    maker: walletB.address,
    taker: walletA.address,
    sellToken: resolveTokenAddress("mUSDC", addresses),
    buyToken: resolveTokenAddress("mWETH", addresses),
    sellAmount: buyUsdc.toString(),
    buyAmount: sellWeth.toString(),
    expiry,
    nonce: (nonceBase + 1n).toString()
  };

  const signedA = await signerA.signOrder(orderA, settlement.domain());
  const signedB = await signerB.signOrder(orderB, settlement.domain());
  const receipt = await settlement.submit(signedA, signedB, submitter);

  assert.ok(receipt, "Galileo settlement should return a receipt");

  const afterAWeth = await weth.balanceOf(walletA.address);
  const afterAUsdc = await usdc.balanceOf(walletA.address);
  const afterBWeth = await weth.balanceOf(walletB.address);
  const afterBUsdc = await usdc.balanceOf(walletB.address);

  assert.equal(afterAWeth, beforeAWeth - sellWeth, "agent A mWETH balance mismatch");
  assert.equal(afterAUsdc, beforeAUsdc + buyUsdc, "agent A mUSDC balance mismatch");
  assert.equal(afterBWeth, beforeBWeth + sellWeth, "agent B mWETH balance mismatch");
  assert.equal(afterBUsdc, beforeBUsdc - buyUsdc, "agent B mUSDC balance mismatch");

  console.log("✓ Galileo settlement submitted", {
    chainId: addresses.chainId,
    settlement: addresses.settlement,
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    orderHashes: receipt.orderHashes,
    agents: {
      a: walletA.address,
      b: walletB.address
    }
  });

  process.exit(0);
}

async function requireAddresses(): Promise<SettlementAddresses> {
  const addresses = await loadSettlementAddresses();

  if (!addresses) {
    throw new Error("Missing packages/contracts/addresses.json after Galileo deployment.");
  }

  return addresses;
}

async function ensureNativeGas(submitter: Wallet, recipient: string): Promise<void> {
  const balance = await submitter.provider!.getBalance(recipient);

  if (balance >= MIN_AGENT_GAS) {
    return;
  }

  await (await submitter.sendTransaction({ to: recipient, value: TARGET_AGENT_GAS - balance })).wait();
  await wait(500);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
