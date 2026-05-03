import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ethers, network } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const mockUSDC = await MockERC20.deploy("Mock USDC", "mUSDC", 6);
  await mockUSDC.waitForDeployment();
  const mockWETH = await MockERC20.deploy("Mock Wrapped Ether", "mWETH", 18);
  await mockWETH.waitForDeployment();
  const mockDAI = await MockERC20.deploy("Mock DAI", "mDAI", 18);
  await mockDAI.waitForDeployment();

  const DarkPoolSettlement = await ethers.getContractFactory("DarkPoolSettlement");
  const settlement = await DarkPoolSettlement.deploy();
  await settlement.waitForDeployment();

  const AgentBrainINFT = await ethers.getContractFactory("AgentBrainINFT");
  const agentBrain = await AgentBrainINFT.deploy("DarkPool Agent Brain", "DPAGENT", deployer.address, 500);
  await agentBrain.waitForDeployment();

  await (await mockUSDC.mint(deployer.address, ethers.parseUnits("1000000", 6))).wait();
  await (await mockWETH.mint(deployer.address, ethers.parseEther("1000"))).wait();
  await (await mockDAI.mint(deployer.address, ethers.parseEther("1000000"))).wait();

  const addresses = {
    chainId: Number(chainId),
    network: network.name,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    settlement: await settlement.getAddress(),
    tokens: {
      mUSDC: await mockUSDC.getAddress(),
      mWETH: await mockWETH.getAddress(),
      mDAI: await mockDAI.getAddress()
    },
    contracts: {
      MockUSDC: await mockUSDC.getAddress(),
      MockWETH: await mockWETH.getAddress(),
      MockDAI: await mockDAI.getAddress(),
      DarkPoolSettlement: await settlement.getAddress(),
      AgentBrainINFT: await agentBrain.getAddress()
    }
  };

  const outputPath = process.env.CONTRACT_ADDRESSES_PATH ? resolve(process.env.CONTRACT_ADDRESSES_PATH) : resolve(__dirname, "../addresses.json");
  await writeFile(outputPath, `${JSON.stringify(addresses, null, 2)}\n`);

  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
