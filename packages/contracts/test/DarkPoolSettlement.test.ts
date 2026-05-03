import { expect } from "chai";
import { ethers } from "hardhat";

const SWAP_ORDER_TYPES = {
  SwapOrder: [
    { name: "maker", type: "address" },
    { name: "taker", type: "address" },
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" }
  ]
};

async function deployFixture() {
  const [deployer, makerA, makerB, outsider] = await ethers.getSigners();
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("Mock USDC", "mUSDC", 6);
  const weth = await MockERC20.deploy("Mock Wrapped Ether", "mWETH", 18);
  const DarkPoolSettlement = await ethers.getContractFactory("DarkPoolSettlement");
  const settlement = await DarkPoolSettlement.deploy();

  await usdc.waitForDeployment();
  await weth.waitForDeployment();
  await settlement.waitForDeployment();

  await usdc.mint(makerA.address, ethers.parseUnits("120000", 6));
  await weth.mint(makerB.address, ethers.parseEther("40"));

  return { deployer, makerA, makerB, outsider, usdc, weth, settlement };
}

async function buildSignedOrders() {
  const fixture = await deployFixture();
  const { makerA, makerB, usdc, weth, settlement } = fixture;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const settlementAddress = await settlement.getAddress();
  const usdcAddress = await usdc.getAddress();
  const wethAddress = await weth.getAddress();
  const latest = await ethers.provider.getBlock("latest");
  const expiry = BigInt((latest?.timestamp ?? 0) + 3600);
  const usdcAmount = ethers.parseUnits("120000", 6);
  const wethAmount = ethers.parseEther("40");

  const orderA = {
    maker: makerA.address,
    taker: makerB.address,
    sellToken: usdcAddress,
    buyToken: wethAddress,
    sellAmount: usdcAmount,
    buyAmount: wethAmount,
    expiry,
    nonce: 1n
  };
  const orderB = {
    maker: makerB.address,
    taker: makerA.address,
    sellToken: wethAddress,
    buyToken: usdcAddress,
    sellAmount: wethAmount,
    buyAmount: usdcAmount,
    expiry,
    nonce: 2n
  };
  const domain = {
    name: "DarkPoolSettlement",
    version: "1",
    chainId,
    verifyingContract: settlementAddress
  };
  const signatureA = await makerA.signTypedData(domain, SWAP_ORDER_TYPES, orderA);
  const signatureB = await makerB.signTypedData(domain, SWAP_ORDER_TYPES, orderB);

  await usdc.connect(makerA).approve(settlementAddress, usdcAmount);
  await weth.connect(makerB).approve(settlementAddress, wethAmount);

  return { ...fixture, orderA, orderB, signatureA, signatureB, usdcAmount, wethAmount };
}

describe("DarkPoolSettlement", function () {
  it("atomically settles complementary signed orders", async function () {
    const { makerA, makerB, usdc, weth, settlement, orderA, orderB, signatureA, signatureB, usdcAmount, wethAmount } =
      await buildSignedOrders();

    await expect(settlement.settle(orderA, orderB, signatureA, signatureB)).to.emit(settlement, "Trade");

    expect(await usdc.balanceOf(makerB.address)).to.equal(usdcAmount);
    expect(await weth.balanceOf(makerA.address)).to.equal(wethAmount);
  });

  it("rejects replay of finalized orders", async function () {
    const { settlement, orderA, orderB, signatureA, signatureB } = await buildSignedOrders();

    await settlement.settle(orderA, orderB, signatureA, signatureB);

    await expect(settlement.settle(orderA, orderB, signatureA, signatureB)).to.be.revertedWithCustomError(
      settlement,
      "OrderAlreadyFinalized"
    );
  });

  it("rejects mismatched consideration", async function () {
    const { settlement, orderA, orderB, signatureA, signatureB } = await buildSignedOrders();
    const badOrderB = { ...orderB, buyAmount: orderB.buyAmount - 1n };

    await expect(settlement.settle(orderA, badOrderB, signatureA, signatureB)).to.be.revertedWithCustomError(
      settlement,
      "MismatchedOrders"
    );
  });

  it("lets makers cancel unsigned liquidity before settlement", async function () {
    const { settlement, orderA, makerA } = await buildSignedOrders();
    const orderHash = await settlement.hashOrder(orderA);

    await expect(settlement.connect(makerA).cancelOrder(orderA)).to.emit(settlement, "OrderCancelled").withArgs(orderHash, makerA.address, 1n);
  });

  it("rejects cancellation by non-maker", async function () {
    const { settlement, orderA, outsider } = await buildSignedOrders();

    await expect(settlement.connect(outsider).cancelOrder(orderA)).to.be.revertedWithCustomError(settlement, "UnauthorizedCancel");
  });
});
