import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

loadEnv({ path: resolve(__dirname, "../../.env") });
loadEnv();

const privateKey = process.env.ZEROG_PRIVATE_KEY;
const accounts = privateKey ? [privateKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    hardhat: {
      chainId: 31337
    },
    ogGalileo: {
      url: process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai",
      chainId: Number(process.env.ZEROG_CHAIN_ID ?? "16601"),
      accounts
    }
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};

export default config;
