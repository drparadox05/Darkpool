export type AgentRole = "aggressive" | "conservative" | "arbitrageur" | "custom";

export type AgentProfile = {
  id: string;
  ensName: string;
  peerId: string;
  role: AgentRole;
  status: "online" | "offline" | "negotiating";
  intent: string;
  pairs: string[];
  pnlUsd: number;
  color: string;
};

export type AxlPeer = {
  peerId: string;
  apiUrl: string;
};

export type AxlTopology = {
  self: AxlPeer;
  peers: AxlPeer[];
};

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
};

export type McpRegisterRequest = {
  service: string;
  tools: McpToolDefinition[];
  callbackUrl: string;
  endpoint?: string;
};

export type McpToolCall = {
  id: string;
  service: string;
  tool: string;
  input: unknown;
  from: string;
  to: string;
};

export type McpToolResult = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type A2AEnvelope = {
  id: string;
  from: string;
  to: string;
  service: string;
  tool: string;
  payload: unknown;
  timestamp: string;
};

export type Offer = {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  expiresAt: string;
};

export type NegotiationMessage = {
  id: string;
  from: string;
  to: string;
  kind: "quote" | "counter" | "accept" | "reject" | "settlement";
  rationale: string;
  offer?: Offer;
  timestamp: string;
};


export type BrainMemoryEvent = {
  timestamp: string;
  kind: "observation" | "negotiation" | "settlement" | "risk";
  content: string;
};

export type AgentBrainDocument = {
  version: "1";
  agentId: string;
  ensName: string;
  role: AgentRole;
  systemPrompt: string;
  strategy: {
    riskTolerance: "low" | "medium" | "high";
    maxSlippageBps: number;
    minProfitBps: number;
    preferredPairs: string[];
  };
  memoryLog: BrainMemoryEvent[];
};

export type EncryptedBrainEnvelope = {
  version: "aes-256-gcm-scrypt-v1";
  cipherText: string;
  iv: string;
  authTag: string;
  salt: string;
  createdAt: string;
  metadata: {
    agentId: string;
    ensName: string;
  };
};

export type BrainStorageReceipt = {
  rootHash: string;
  storageUri: string;
  encryptedKeyURI: string;
  byteLength: number;
  txHash?: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ComputeRequest = {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
};

export type ComputeResponse = {
  content: string;
  provider: string;
  model: string;
  requestId: string;
};

export type DraftQuoteInput = {
  pair: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  referencePrice?: number;
};

export type DraftQuote = Offer & {
  confidence: number;
  rationale: string;
  compute?: ComputeResponse;
};

export type DraftCounterInput = {
  history: NegotiationMessage[];
  targetPair: string;
};

export type SignedSwapOrder = {
  order: {
    maker: string;
    taker: string;
    sellToken: string;
    buyToken: string;
    sellAmount: string;
    buyAmount: string;
    expiry: string;
    nonce: string;
  };
  signature: string;
  orderHash: string;
  signerAddress: string;
};

export type QuoteToolInput = {
  pair: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  referencePrice?: number;
  counterpartyAddress?: string;
};

export type QuoteToolOutput = {
  offer: Offer;
  confidence: number;
  rationale: string;
  agentEns: string;
  agentAddress: string;
  nonce: string;
  compute?: ComputeResponse;
};

export type ProposeSwapInput = {
  signedOrder: SignedSwapOrder;
  expectation: Offer;
  round: number;
};

export type ProposeSwapOutput = {
  decision: "accept" | "counter" | "reject";
  rationale: string;
  counterSignedOrder?: SignedSwapOrder;
  counterOffer?: Offer;
  compute?: ComputeResponse;
};

export type AcceptSwapInput = {
  orderA: SignedSwapOrder;
  orderB: SignedSwapOrder;
};

export type AcceptSwapOutput = {
  accepted: boolean;
  rationale: string;
};

export type SignSettlementInput = {
  order: SignedSwapOrder["order"];
};

export type SignSettlementOutput = SignedSwapOrder;

export type WsEventKind =
  | "agent:registered"
  | "0g:compute"
  | "0g:storage"
  | "negotiation:started"
  | "negotiation:message"
  | "negotiation:completed"
  | "settlement:signed"
  | "settlement:submitted"
  | "settlement:confirmed"
  | "settlement:failed"
  | "settlement:simulated"
  | "a2a:request"
  | "a2a:response";

export type WsEvent = {
  kind: WsEventKind;
  agentId: string;
  ensName?: string;
  timestamp: string;
  payload: unknown;
};

export type SwapOrder = {
  maker: string;
  taker: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  expiry: bigint;
  nonce: bigint;
};

export const DARKPOOL_EIP712_TYPES = {
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
} as const;

export const SEEDED_AGENTS: AgentProfile[] = [
  {
    id: "agent-a",
    ensName: "aggressive.darkpool-agents.eth",
    peerId: "agent-a",
    role: "aggressive",
    status: "online",
    intent: "Rebalance toward 60% ETH / 40% USDC before Friday.",
    pairs: ["mWETH/mUSDC", "mDAI/mUSDC"],
    pnlUsd: 1280,
    color: "from-rose-500 to-orange-400"
  },
  {
    id: "agent-b",
    ensName: "conservative.darkpool-agents.eth",
    peerId: "agent-b",
    role: "conservative",
    status: "online",
    intent: "Preserve stablecoin value and quote only inside risk limits.",
    pairs: ["mUSDC/mWETH", "mUSDC/mDAI"],
    pnlUsd: 420,
    color: "from-sky-500 to-cyan-300"
  },
  {
    id: "agent-c",
    ensName: "arbitrageur.darkpool-agents.eth",
    peerId: "agent-c",
    role: "arbitrageur",
    status: "offline",
    intent: "Monitor spreads and join when settlement contracts are deployed.",
    pairs: ["mWETH/mDAI", "mDAI/mUSDC"],
    pnlUsd: 0,
    color: "from-violet-500 to-fuchsia-400"
  }
];
