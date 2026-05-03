import { expect } from "chai";
import { ethers } from "hardhat";

async function deployFixture() {
  const [deployer, owner, cloneBuyer] = await ethers.getSigners();
  const AgentBrainINFT = await ethers.getContractFactory("AgentBrainINFT");
  const inft = await AgentBrainINFT.deploy("DarkPool Agent Brain", "DPAGENT", deployer.address, 500);
  await inft.waitForDeployment();

  return { deployer, owner, cloneBuyer, inft };
}

describe("AgentBrainINFT", function () {
  it("mints agent brain metadata and clone economics", async function () {
    const { owner, inft } = await deployFixture();

    await expect(
      inft.mintAgent(owner.address, "ipfs://agent-a", "0g://root-hash-a", "0g://encrypted-key-a", ethers.parseEther("0.1"), owner.address, 500)
    )
      .to.emit(inft, "AgentMinted")
      .withArgs(1n, owner.address, "0g://root-hash-a", "0g://encrypted-key-a");

    const brain = await inft.brainData(1n);

    expect(await inft.ownerOf(1n)).to.equal(owner.address);
    expect(brain.metadataHash).to.equal("0g://root-hash-a");
    expect(brain.encryptedKeyURI).to.equal("0g://encrypted-key-a");
    expect(brain.parentTokenId).to.equal(0n);
    expect(await inft.cloneFee(1n)).to.equal(ethers.parseEther("0.1"));
  });

  it("clones an agent and pays the source owner", async function () {
    const { owner, cloneBuyer, inft } = await deployFixture();
    const cloneFee = ethers.parseEther("0.1");

    await inft.mintAgent(owner.address, "ipfs://agent-a", "0g://root-hash-a", "0g://encrypted-key-a", cloneFee, owner.address, 500);

    await expect(
      inft.connect(cloneBuyer).cloneAgent(1n, cloneBuyer.address, "ipfs://agent-a-clone", "0g://root-hash-clone", "0g://encrypted-key-clone", {
        value: cloneFee
      })
    ).to.changeEtherBalances([cloneBuyer, owner], [-cloneFee, cloneFee]);

    const brain = await inft.brainData(2n);

    expect(await inft.ownerOf(2n)).to.equal(cloneBuyer.address);
    expect(brain.parentTokenId).to.equal(1n);
  });

  it("keeps clone economics attached to the original royalty receiver after transfer", async function () {
    const { deployer, owner, cloneBuyer, inft } = await deployFixture();
    const cloneFee = ethers.parseEther("0.1");

    await inft.mintAgent(owner.address, "ipfs://agent-a", "0g://root-hash-a", "0g://encrypted-key-a", cloneFee, owner.address, 500);
    await inft.connect(owner).transferFrom(owner.address, deployer.address, 1n);

    await expect(
      inft.connect(cloneBuyer).cloneAgent(1n, cloneBuyer.address, "ipfs://agent-a-clone", "0g://root-hash-clone", "0g://encrypted-key-clone", {
        value: cloneFee
      })
    ).to.changeEtherBalances([cloneBuyer, owner, deployer], [-cloneFee, cloneFee, 0n]);

    expect(await inft.royaltyReceiver(2n)).to.equal(owner.address);
  });

  it("rejects an incorrect clone fee", async function () {
    const { owner, cloneBuyer, inft } = await deployFixture();
    const cloneFee = ethers.parseEther("0.1");

    await inft.mintAgent(owner.address, "ipfs://agent-a", "0g://root-hash-a", "0g://encrypted-key-a", cloneFee, owner.address, 500);

    await expect(
      inft.connect(cloneBuyer).cloneAgent(1n, cloneBuyer.address, "ipfs://agent-a-clone", "0g://root-hash-clone", "0g://encrypted-key-clone", {
        value: ethers.parseEther("0.05")
      })
    ).to.be.revertedWithCustomError(inft, "CloneFeeMismatch");
  });

  it("lets the owner update brain references", async function () {
    const { owner, inft } = await deployFixture();

    await inft.mintAgent(owner.address, "ipfs://agent-a", "0g://root-hash-a", "0g://encrypted-key-a", 0, owner.address, 500);
    await inft.connect(owner).updateBrain(1n, "ipfs://agent-a-v2", "0g://root-hash-v2", "0g://encrypted-key-v2");

    const brain = await inft.brainData(1n);

    expect(await inft.tokenURI(1n)).to.equal("ipfs://agent-a-v2");
    expect(brain.metadataHash).to.equal("0g://root-hash-v2");
    expect(brain.encryptedKeyURI).to.equal("0g://encrypted-key-v2");
  });
});
