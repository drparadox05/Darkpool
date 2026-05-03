import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Interface, JsonRpcProvider, TypedDataEncoder, Wallet, getAddress, type ContractTransactionReceipt, type Provider } from "ethers";
import { DARKPOOL_EIP712_TYPES, type SignedSwapOrder } from "@darkpool/shared";

export const SWAP_ORDER_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  SwapOrder: DARKPOOL_EIP712_TYPES.SwapOrder.map((field) => ({ name: field.name, type: field.type }))
};

export type SwapOrderValues = SignedSwapOrder["order"];

export type SettlementAddresses = {
  chainId: number;
  settlement: string;
  tokens: Record<string, string>;
};

export type Eip712Domain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
};

export type SettlementSigner = {
  address: string;
  wallet: Wallet;
  signOrder(order: SwapOrderValues, domain: Eip712Domain): Promise<SignedSwapOrder>;
};

export type SettlementClient = {
  addresses: SettlementAddresses | null;
  domain(): Eip712Domain;
  canSubmit(): boolean;
  submit(orderA: SignedSwapOrder, orderB: SignedSwapOrder, submitter?: Wallet): Promise<SettlementSubmitResult | null>;
};

export type SettlementSubmitResult = {
  transactionHash: string;
  blockNumber: number | null;
  gasUsed: string | null;
  orderHashes: {
    a: string;
    b: string;
  };
};

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(srcDir, "..");
const repoRoot = resolve(packageDir, "../..");

const DEFAULT_DOMAIN: Eip712Domain = {
  name: "DarkPoolSettlement",
  version: "1",
  chainId: 31337,
  verifyingContract: "0x0000000000000000000000000000000000000000"
};

export async function loadSettlementAddresses(overridePath?: string): Promise<SettlementAddresses | null> {
  const addressesPath = overridePath ?? resolve(repoRoot, "packages/contracts/addresses.json");

  try {
    const raw = await readFile(addressesPath, "utf8");
    const parsed = JSON.parse(raw) as {
      chainId: number;
      contracts: { DarkPoolSettlement: string; MockUSDC: string; MockWETH: string; MockDAI: string };
    };

    return {
      chainId: parsed.chainId,
      settlement: getAddress(parsed.contracts.DarkPoolSettlement),
      tokens: {
        mUSDC: getAddress(parsed.contracts.MockUSDC),
        mWETH: getAddress(parsed.contracts.MockWETH),
        mDAI: getAddress(parsed.contracts.MockDAI)
      }
    };
  } catch {
    return null;
  }
}

export function resolveTokenAddress(symbol: string, addresses: SettlementAddresses | null): string {
  if (!addresses) {
    return "0x0000000000000000000000000000000000000000";
  }

  return addresses.tokens[symbol] ?? "0x0000000000000000000000000000000000000000";
}

export function createAgentWallet(seed: string): Wallet {
  const hex = toPrivateKeyHex(seed);
  return new Wallet(hex);
}

export function createSettlementSigner(wallet: Wallet): SettlementSigner {
  return {
    address: wallet.address,
    wallet,
    async signOrder(order, domain) {
      const orderForSigning = serializeOrderForSigning(order);
      const signature = await wallet.signTypedData(domain, SWAP_ORDER_TYPES, orderForSigning);
      const orderHash = TypedDataEncoder.hash(domain, SWAP_ORDER_TYPES, orderForSigning);

      return {
        order,
        signature,
        orderHash,
        signerAddress: wallet.address
      };
    }
  };
}

export type SettlementClientOptions = {
  addresses: SettlementAddresses | null;
  rpcUrl?: string;
  submitterPrivateKey?: string;
  submitEnabled?: boolean;
};

export function createSettlementClient(options: SettlementClientOptions): SettlementClient {
  const provider: JsonRpcProvider | null = options.rpcUrl ? new JsonRpcProvider(options.rpcUrl) : null;
  const defaultSubmitter = options.submitterPrivateKey && provider ? new Wallet(options.submitterPrivateKey, provider) : null;
  const submitEnabled = options.submitEnabled ?? true;

  return {
    addresses: options.addresses,
    domain() {
      if (!options.addresses) {
        return { ...DEFAULT_DOMAIN };
      }

      return {
        name: "DarkPoolSettlement",
        version: "1",
        chainId: options.addresses.chainId,
        verifyingContract: options.addresses.settlement
      };
    },
    canSubmit() {
      return Boolean(submitEnabled && options.addresses && provider && defaultSubmitter);
    },
    async submit(orderA, orderB, submitter) {
      if (!submitEnabled || !options.addresses || !provider) {
        return null;
      }

      const connectedSubmitter = connectSubmitter(submitter ?? defaultSubmitter, provider);

      if (!connectedSubmitter) {
        return null;
      }

      const settlement = new Contract(options.addresses.settlement, DARKPOOL_SETTLEMENT_ABI, connectedSubmitter);

      try {
        await assertSettlementPreflight(options.addresses, provider, orderA, orderB);
        const transaction = await settlement.settle(toContractOrder(orderA.order), toContractOrder(orderB.order), orderA.signature, orderB.signature);
        const receipt = (await transaction.wait()) as ContractTransactionReceipt | null;

        return {
          transactionHash: transaction.hash,
          blockNumber: receipt?.blockNumber ?? null,
          gasUsed: receipt?.gasUsed?.toString() ?? null,
          orderHashes: {
            a: orderA.orderHash,
            b: orderB.orderHash
          }
        };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Settlement preflight failed")) {
          throw error;
        }

        throw new Error(`Settlement submit failed: ${describeSettlementError(error)}`);
      }
    }
  };
}

export const DARKPOOL_SETTLEMENT_ABI = [
  "function settle((address maker,address taker,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 expiry,uint256 nonce) orderA,(address maker,address taker,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 expiry,uint256 nonce) orderB,bytes signatureA,bytes signatureB) external returns (bytes32 orderHashA, bytes32 orderHashB)",
  "error ExpiredOrder(bytes32 orderHash)",
  "error InvalidCounterparty()",
  "error InvalidOrderShape()",
  "error InvalidSignature(bytes32 orderHash,address signer,address expectedSigner)",
  "error MismatchedOrders()",
  "error OrderAlreadyFinalized(bytes32 orderHash)",
  "error UnauthorizedCancel()",
  "error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)",
  "error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)"
] as const;

export const MOCK_ERC20_ABI = [
  "function mint(address to,uint256 amount) external",
  "function approve(address spender,uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner,address spender) external view returns (uint256)",
  "function decimals() external view returns (uint8)"
] as const;

function toPrivateKeyHex(seed: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(seed)) {
    return seed;
  }

  const normalized = seed.replace(/[^0-9a-fA-F]/g, "").padStart(64, "0").slice(0, 64);

  if (normalized.length !== 64) {
    return `0x${"1".padStart(64, "0")}`;
  }

  return `0x${normalized}`;
}

function serializeOrderForSigning(order: SwapOrderValues) {
  return {
    maker: order.maker,
    taker: order.taker,
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    sellAmount: order.sellAmount,
    buyAmount: order.buyAmount,
    expiry: order.expiry,
    nonce: order.nonce
  };
}

function toContractOrder(order: SwapOrderValues) {
  return {
    maker: order.maker,
    taker: order.taker,
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    sellAmount: BigInt(order.sellAmount),
    buyAmount: BigInt(order.buyAmount),
    expiry: BigInt(order.expiry),
    nonce: BigInt(order.nonce)
  };
}

async function assertSettlementPreflight(
  addresses: SettlementAddresses,
  provider: Provider,
  orderA: SignedSwapOrder,
  orderB: SignedSwapOrder
): Promise<void> {
  const problems = [
    ...(await findOrderFundingProblems(addresses, provider, orderA.order)),
    ...(await findOrderFundingProblems(addresses, provider, orderB.order))
  ];

  if (problems.length > 0) {
    throw new Error(`Settlement preflight failed: ${problems.join("; ")}. Fund/mint and approve both maker wallets before enabling SETTLEMENT_AUTO_SUBMIT=true.`);
  }
}

async function findOrderFundingProblems(addresses: SettlementAddresses, provider: Provider, order: SwapOrderValues): Promise<string[]> {
  const token = new Contract(order.sellToken, MOCK_ERC20_ABI, provider);
  const required = BigInt(order.sellAmount);
  const [balance, allowance] = (await Promise.all([
    token.balanceOf(order.maker),
    token.allowance(order.maker, addresses.settlement)
  ])) as [bigint, bigint];
  const problems: string[] = [];

  if (balance < required) {
    problems.push(`${order.maker} balance ${balance.toString()} < required ${required.toString()} for token ${order.sellToken}`);
  }

  if (allowance < required) {
    problems.push(`${order.maker} allowance ${allowance.toString()} < required ${required.toString()} for token ${order.sellToken} spender ${addresses.settlement}`);
  }

  return problems;
}

function describeSettlementError(error: unknown): string {
  const data = getErrorData(error);

  if (data) {
    const parsed = SETTLEMENT_INTERFACE.parseError(data);

    if (parsed) {
      return `${parsed.name}(${parsed.args.map(formatErrorArg).join(", ")})`;
    }
  }

  return error instanceof Error ? error.message : String(error);
}

function getErrorData(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const directData = error.data;

  if (typeof directData === "string") {
    return directData;
  }

  const info = error.info;

  if (isRecord(info) && isRecord(info.error) && typeof info.error.data === "string") {
    return info.error.data;
  }

  return undefined;
}

function formatErrorArg(value: unknown): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const SETTLEMENT_INTERFACE = new Interface(DARKPOOL_SETTLEMENT_ABI);

function connectSubmitter(wallet: Wallet | null, provider: Provider): Wallet | null {
  if (!wallet) {
    return null;
  }

  return wallet.provider ? wallet : wallet.connect(provider);
}
