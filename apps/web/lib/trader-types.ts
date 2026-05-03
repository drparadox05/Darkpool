import type { AcceptSwapOutput, Offer, ProposeSwapOutput, QuoteToolOutput, SignedSwapOrder } from "@darkpool/shared";

export type TokenMap = Record<string, string>;

export type OtcParticipant = {
  label: string;
  peerId: string;
  service?: string;
  pairs: string[];
  source: "env" | "topology" | "router";
};

export type EndpointHealth = {
  ok: boolean;
  url: string;
  detail?: string;
};

export type TraderStatus = {
  checkedAt: string;
  axl: EndpointHealth & {
    transport?: "mock" | "gensyn";
    selfPeerId?: string;
    peers: string[];
  };
  router: EndpointHealth & {
    services: string[];
  };
  wsHub: EndpointHealth & {
    events?: number;
    clients?: number;
  };
  settlement: {
    ok: boolean;
    chainId?: number;
    address?: string;
    agentBrainINFT?: string;
    tokens: TokenMap;
    autoSubmit: boolean;
    detail?: string;
  };
  zeroG: {
    compute: {
      ok: boolean;
      provider: string;
      model?: string;
      serviceProviderAddress?: string;
      verifyResponses?: boolean;
      providerExplorerUrl?: string;
      detail?: string;
    };
    storage: {
      ok: boolean;
      provider: string;
      rootHash?: string;
      indexerRpcUrl?: string;
      rpcUrl?: string;
      inftTokenId?: string;
      inftContractAddress?: string;
      inftContractExplorerUrl?: string;
      inftMintTxHash?: string;
      inftMintTxExplorerUrl?: string;
      storageUploadTxHash?: string;
      storageUploadTxExplorerUrl?: string;
      persistsMemoryEvents: boolean;
      detail?: string;
    };
    chain: {
      ok: boolean;
      chainId?: number;
      settlementAddress?: string;
      settlementExplorerUrl?: string;
      explorerName?: string;
      txExplorerBaseUrl?: string;
      addressExplorerBaseUrl?: string;
    };
  };
  participants: OtcParticipant[];
};

export type QuoteRequest = {
  counterpartyPeerId: string;
  pair: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  referencePrice?: number;
  counterpartyAddress?: string;
};

export type QuoteResponse = {
  ok: true;
  requestedAt: string;
  counterpartyPeerId: string;
  quote: QuoteToolOutput;
};

export type QuoteErrorResponse = {
  ok: false;
  error: string;
};

export type ProposeRequest = {
  counterpartyPeerId: string;
  signedOrder: SignedSwapOrder;
  expectation: Offer;
  round?: number;
};

export type ProposeResponse = {
  ok: true;
  requestedAt: string;
  counterpartyPeerId: string;
  result: ProposeSwapOutput;
};

export type ProposeErrorResponse = {
  ok: false;
  error: string;
};

export type AcceptRequest = {
  counterpartyPeerId: string;
  orderA: SignedSwapOrder;
  orderB: SignedSwapOrder;
};

export type AcceptResponse = {
  ok: true;
  requestedAt: string;
  counterpartyPeerId: string;
  result: AcceptSwapOutput;
};

export type AcceptErrorResponse = {
  ok: false;
  error: string;
};
