import { ethers } from "hardhat";

const MIN_DEPLOYER_BALANCE_WEI = 10n ** 16n;

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);
  const expectedChainId = BigInt(process.env.ZEROG_CHAIN_ID ?? "16602");

  if (network.chainId !== expectedChainId) {
    throw new Error(`Unexpected chain id ${network.chainId}. Expected ${expectedChainId} for 0G Galileo.`);
  }

  if (balance < MIN_DEPLOYER_BALANCE_WEI) {
    throw new Error(`Deployer ${deployer.address} has insufficient 0G gas balance: ${ethers.formatEther(balance)} 0G.`);
  }

  console.log("✓ Galileo deployment preflight passed", {
    deployer: deployer.address,
    chainId: Number(network.chainId),
    balance: ethers.formatEther(balance)
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
