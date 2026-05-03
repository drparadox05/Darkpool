"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, CircleAlert, Cpu, Database, ExternalLink, Loader2, RefreshCw, ShieldCheck, Users, Zap } from "lucide-react";
import { BrowserProvider, Contract, Interface, TypedDataEncoder } from "ethers";
import { DARKPOOL_EIP712_TYPES, type ComputeResponse, type Offer, type SignedSwapOrder, type WsEvent } from "@darkpool/shared";
import type { AcceptErrorResponse, AcceptRequest, AcceptResponse, ProposeErrorResponse, ProposeRequest, ProposeResponse, QuoteErrorResponse, QuoteRequest, QuoteResponse, TraderStatus } from "../lib/trader-types";
import { useStatus, useWallet } from "../lib/app-context";
import { useWsFeed } from "../lib/use-ws-feed";

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

type WindowWithEthereum = Window & {
  ethereum?: EthereumProvider;
};

type TradeSide = "buy" | "sell";

type RequestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; response: QuoteResponse }
  | { status: "error"; error: string };

type ProposeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; response: ProposeResponse; signedOrder: SignedSwapOrder }
  | { status: "error"; error: string };

type AcceptState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; response: AcceptResponse; orderA: SignedSwapOrder; orderB: SignedSwapOrder }
  | { status: "error"; error: string };

type SettlementCheck = {
  label: string;
  maker: string;
  token: string;
  required: string;
  balance: string;
  allowance: string;
  expiry: string;
  balanceOk: boolean;
  allowanceOk: boolean;
  expiryOk: boolean;
  isUserOrder: boolean;
};

type SettlementState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; checks: SettlementCheck[] }
  | { status: "approving"; checks: SettlementCheck[] }
  | { status: "submitting"; checks: SettlementCheck[]; approvalTxHash?: string }
  | { status: "success"; checks: SettlementCheck[]; transactionHash: string; blockNumber?: number | null; approvalTxHash?: string }
  | { status: "error"; error: string; checks?: SettlementCheck[]; approvalTxHash?: string; transactionHash?: string };

type ActionStatus = "pending" | "loading" | "success" | "error";

type UiAction = {
  id: string;
  label: string;
  status: ActionStatus;
  detail?: string;
  txHash?: string;
  timestamp: string;
};

type ProposalRound = {
  round: number;
  expectation: Offer;
  signedOrder: SignedSwapOrder;
  response: ProposeResponse;
  timestamp: string;
};

const DEFAULT_STATUS: RequestState = { status: "idle" };
const DEFAULT_PROPOSE_STATUS: ProposeState = { status: "idle" };
const DEFAULT_ACCEPT_STATUS: AcceptState = { status: "idle" };
const DEFAULT_SETTLEMENT_STATUS: SettlementState = { status: "idle" };
const DEFAULT_REFERENCE_PRICE = 3000;
const MAX_NEGOTIATION_ROUNDS = 3;
const SETTLEMENT_ORDER_MIN_TTL_SECONDS = 2 * 60 * 60;
const SWAP_ORDER_TYPES = {
  SwapOrder: DARKPOOL_EIP712_TYPES.SwapOrder.map((field) => ({ name: field.name, type: field.type }))
};
const DARKPOOL_SETTLEMENT_ABI = [
  "function settle((address maker,address taker,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 expiry,uint256 nonce) orderA,(address maker,address taker,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 expiry,uint256 nonce) orderB,bytes signatureA,bytes signatureB) external returns (bytes32 orderHashA, bytes32 orderHashB)",
  "error ExpiredOrder(bytes32 orderHash)",
  "error InvalidCounterparty()",
  "error InvalidOrderShape()",
  "error InvalidSignature(bytes32 orderHash,address signer,address expectedSigner)",
  "error MismatchedOrders()",
  "error OrderAlreadyFinalized(bytes32 orderHash)",
  "error UnauthorizedCancel()"
] as const;
const SETTLEMENT_INTERFACE = new Interface(DARKPOOL_SETTLEMENT_ABI);
const ERC20_ABI = [
  "function approve(address spender,uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner,address spender) external view returns (uint256)"
] as const;

export function TraderConsole() {
  const { address: walletAddress, error: walletError, isConnecting: walletConnecting } = useWallet();
  const { status, error: statusError, loading: statusLoading } = useStatus();
  const [side, setSide] = useState<TradeSide>("buy");
  const [sellSymbol, setSellSymbol] = useState("mUSDC");
  const [buySymbol, setBuySymbol] = useState("mWETH");
  const [sellAmount, setSellAmount] = useState("6000");
  const [referencePrice, setReferencePrice] = useState(String(DEFAULT_REFERENCE_PRICE));
  const [selectedPeerId, setSelectedPeerId] = useState("");
  const [manualPeerId, setManualPeerId] = useState("");
  const [quoteState, setQuoteState] = useState<RequestState>(DEFAULT_STATUS);
  const [proposeState, setProposeState] = useState<ProposeState>(DEFAULT_PROPOSE_STATUS);
  const [proposalRounds, setProposalRounds] = useState<ProposalRound[]>([]);
  const [acceptState, setAcceptState] = useState<AcceptState>(DEFAULT_ACCEPT_STATUS);
  const [settlementState, setSettlementState] = useState<SettlementState>(DEFAULT_SETTLEMENT_STATUS);
  const [actions, setActions] = useState<UiAction[]>(() => [
    createAction("connect-wallet", "Connect wallet", "pending", "Waiting for browser wallet connection."),
    createAction("refresh-status", "Load real infra status", "pending", "AXL, MCP router, WS hub, 0G Compute, 0G Storage, and Galileo settlement metadata."),
    createAction("request-quote", "Request OTC quote", "pending", "No quote requested yet."),
    createAction("sign-propose", "Sign order and propose swap", "pending", "Waiting for quote acceptance."),
    createAction("review-counter", "Review counter-offer", "pending", "Only needed if the counterparty counters."),
    createAction("accept-swap", "Verify complementary signatures", "pending", "Waiting for counterparty acceptance."),
    createAction("preflight-settlement", "Check balances and allowances", "pending", "Runs before on-chain settlement."),
    createAction("submit-settlement", "Submit on-chain settlement", "pending", "Optional final wallet transaction.")
  ]);

  useEffect(() => {
    if (!status || selectedPeerId) {
      return;
    }

    const darkpoolPeer = status.participants.find((participant) => participant.service === "darkpool") ?? status.participants[0];

    if (darkpoolPeer) {
      setSelectedPeerId(darkpoolPeer.peerId);
    }
  }, [selectedPeerId, status]);

  useEffect(() => {
    if (walletConnecting) {
      updateAction("connect-wallet", "loading", "Requesting accounts from the injected browser wallet.");
    } else if (walletAddress) {
      updateAction("connect-wallet", "success", `Connected ${shortAddress(walletAddress)}.`);
    } else if (walletError) {
      updateAction("connect-wallet", "error", walletError);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, walletConnecting, walletError]);

  useEffect(() => {
    if (statusLoading) {
      updateAction("refresh-status", "loading", "Checking real AXL bridge, MCP router, WS hub, 0G Compute, 0G Storage, and Galileo settlement metadata.");
      return;
    }

    if (statusError) {
      updateAction("refresh-status", "error", statusError);
      return;
    }

    if (status) {
      const allOk = status.axl.ok && status.router.ok && status.settlement.ok && status.zeroG.compute.ok && status.zeroG.storage.ok;
      updateAction(
        "refresh-status",
        allOk ? "success" : "error",
        `AXL ${status.axl.ok ? "online" : "offline"} · 0G Compute ${status.zeroG.compute.ok ? "live" : "not live"} · 0G Storage ${status.zeroG.storage.ok ? "live" : "not live"} · Galileo ${status.zeroG.chain.ok ? "chain 16602" : "missing"}.`
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, statusLoading, statusError]);

  const tokens = status?.settlement.tokens ?? {};
  const tokenSymbols = useMemo(() => Object.keys(tokens), [tokens]);
  const sellToken = tokens[sellSymbol] ?? sellSymbol;
  const buyToken = tokens[buySymbol] ?? buySymbol;
  const activePeerId = manualPeerId.trim() || selectedPeerId;
  const pair = `${buySymbol}/${sellSymbol}`;
  const canRequestQuote = Boolean(walletAddress && activePeerId && sellAmount && sellToken && buyToken);
  const quotePreview = buildQuoteRequestAmounts(side, sellAmount, referencePrice);
  const explorerBaseUrl = process.env.NEXT_PUBLIC_EXPLORER_TX_BASE_URL || (status?.settlement.chainId === 16602 ? "https://chainscan-galileo.0g.ai/tx/" : "");

  async function requestQuote() {
    if (!walletAddress) {
      setQuoteState({ status: "error", error: "Connect wallet first so the counterparty can quote against your address." });
      return;
    }

    if (!activePeerId) {
      setQuoteState({ status: "error", error: "Select or paste a real AXL counterparty peer ID." });
      return;
    }

    setQuoteState({ status: "loading" });
    setProposeState(DEFAULT_PROPOSE_STATUS);
    setProposalRounds([]);
    setAcceptState(DEFAULT_ACCEPT_STATUS);
    setSettlementState(DEFAULT_SETTLEMENT_STATUS);
    updateAction("request-quote", "loading", `Calling darkpool/getQuote on ${shortPeer(activePeerId)} over AXL.`);
    updateAction("sign-propose", "pending", "Waiting for quote acceptance.");
    updateAction("review-counter", "pending", "Only needed if the counterparty counters.");
    updateAction("accept-swap", "pending", "Waiting for counterparty acceptance.");
    updateAction("preflight-settlement", "pending", "Runs after complementary signatures are verified.");
    updateAction("submit-settlement", "pending", "Optional final wallet transaction.");

    try {
      const payload: QuoteRequest = {
        counterpartyPeerId: activePeerId,
        pair,
        sellToken: buyToken,
        buyToken: sellToken,
        sellAmount: quotePreview.counterpartySellAmount,
        referencePrice: quotePreview.referencePrice,
        counterpartyAddress: walletAddress
      };
      const response = await fetch("/api/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = (await response.json()) as QuoteResponse | QuoteErrorResponse;

      if (!response.ok || !body.ok) {
        throw new Error((body as QuoteErrorResponse).error || `HTTP ${response.status} ${response.statusText}`);
      }

      setQuoteState({ status: "success", response: body });
      updateAction("request-quote", "success", `Quote from ${body.quote.agentEns}: sell ${body.quote.offer.sellAmount} for ${body.quote.offer.buyAmount}.`);
    } catch (error) {
      const message = formatErrorMessage(error);
      setQuoteState({ status: "error", error: message });
      updateAction("request-quote", "error", message);
    }
  }

  async function signAndPropose() {
    if (quoteState.status !== "success") {
      setProposeState({ status: "error", error: "Request a quote first." });
      return;
    }

    await signAndProposeOffer(quoteState.response.quote.offer, 1);
  }

  async function signAndProposeCounterOffer() {
    if (proposeState.status !== "success" || !proposeState.response.result.counterOffer) {
      setProposeState({ status: "error", error: "No counter-offer is available to sign." });
      return;
    }

    const latestRound = proposalRounds[proposalRounds.length - 1]?.round ?? 1;
    const nextRound = latestRound + 1;

    if (nextRound > MAX_NEGOTIATION_ROUNDS) {
      updateAction("review-counter", "error", `Reached ${MAX_NEGOTIATION_ROUNDS} visible negotiation rounds without acceptance.`);
      return;
    }

    await signAndProposeOffer(proposeState.response.result.counterOffer, nextRound);
  }

  async function signAndProposeOffer(expectation: Offer, round: number) {
    if (quoteState.status !== "success") {
      setProposeState({ status: "error", error: "Request a quote first." });
      return;
    }

    if (!walletAddress) {
      setProposeState({ status: "error", error: "Connect wallet before signing." });
      return;
    }

    if (!status?.settlement.chainId || !status.settlement.address) {
      setProposeState({ status: "error", error: "Settlement domain is unavailable. Check packages/contracts/addresses.json and /api/status." });
      return;
    }

    const ethereum = (window as WindowWithEthereum).ethereum;

    if (!ethereum) {
      setProposeState({ status: "error", error: "No injected wallet found for EIP-712 signing." });
      return;
    }

    const actionId = round === 1 ? "sign-propose" : "review-counter";
    setProposeState({ status: "loading" });
    setAcceptState(DEFAULT_ACCEPT_STATUS);
    setSettlementState(DEFAULT_SETTLEMENT_STATUS);
    updateAction(actionId, "loading", `Opening wallet EIP-712 signature prompt for round ${round} inverse SwapOrder.`);
    updateAction("accept-swap", "pending", "Waiting for proposeSwap result.");
    updateAction("preflight-settlement", "pending", "Runs after complementary signatures are verified.");
    updateAction("submit-settlement", "pending", "Optional final wallet transaction.");

    try {
      const quote = quoteState.response.quote;
      const order: SignedSwapOrder["order"] = {
        maker: walletAddress,
        taker: quote.agentAddress,
        sellToken: expectation.buyToken,
        buyToken: expectation.sellToken,
        sellAmount: expectation.buyAmount,
        buyAmount: expectation.sellAmount,
        expiry: expiryUnixFromIso(expectation.expiresAt),
        nonce: newNonce()
      };
      assertUnsignedIntegerField("sellAmount", order.sellAmount);
      assertUnsignedIntegerField("buyAmount", order.buyAmount);
      assertUnsignedIntegerField("expiry", order.expiry);
      assertUnsignedIntegerField("nonce", order.nonce);
      const domain = {
        name: "DarkPoolSettlement",
        version: "1",
        chainId: status.settlement.chainId,
        verifyingContract: status.settlement.address
      };
      const typedData = {
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" }
          ],
          SwapOrder: SWAP_ORDER_TYPES.SwapOrder
        },
        primaryType: "SwapOrder",
        domain,
        message: order
      };
      updateAction(actionId, "loading", `Wallet prompt open for round ${round}: sign ${order.sellAmount} for ${order.buyAmount}.`);
      const signature = (await ethereum.request({
        method: "eth_signTypedData_v4",
        params: [walletAddress, JSON.stringify(typedData)]
      })) as string;
      const signedOrder: SignedSwapOrder = {
        order,
        signature,
        orderHash: TypedDataEncoder.hash(domain, SWAP_ORDER_TYPES, order),
        signerAddress: walletAddress
      };
      const payload: ProposeRequest = {
        counterpartyPeerId: quoteState.response.counterpartyPeerId,
        signedOrder,
        expectation,
        round
      };
      updateAction(actionId, "loading", `Calling darkpool/proposeSwap for round ${round} over AXL with signed order ${shortHash(signedOrder.orderHash)}.`);
      const response = await fetch("/api/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = (await response.json()) as ProposeResponse | ProposeErrorResponse;

      if (!response.ok || !body.ok) {
        throw new Error((body as ProposeErrorResponse).error || `HTTP ${response.status} ${response.statusText}`);
      }

      setProposeState({ status: "success", response: body, signedOrder });
      setProposalRounds((current) => [...current, { round, expectation, signedOrder, response: body, timestamp: new Date().toISOString() }]);
      updateAction(actionId, "success", `Round ${round}: signed ${shortHash(signedOrder.orderHash)} and proposeSwap returned ${body.result.decision}.`);

      if (body.result.decision === "accept" && body.result.counterSignedOrder) {
        await verifyAcceptedSwap(signedOrder, body.result.counterSignedOrder, quoteState.response.counterpartyPeerId);
      } else if (body.result.decision === "counter") {
        const nextRound = round + 1;
        const counterDetail = body.result.counterOffer ? `Counter offer received: sell ${body.result.counterOffer.sellAmount} for ${body.result.counterOffer.buyAmount}.` : body.result.rationale;
        updateAction("review-counter", nextRound <= MAX_NEGOTIATION_ROUNDS ? "success" : "error", nextRound <= MAX_NEGOTIATION_ROUNDS ? `${counterDetail} Review and sign round ${nextRound}.` : `${counterDetail} Reached max rounds.`);
        updateAction("accept-swap", "pending", "Counter offer received; wallet review/signing for counter terms is next.");
      } else {
        updateAction("accept-swap", "error", body.result.rationale);
      }
    } catch (error) {
      const message = formatErrorMessage(error);
      setProposeState({ status: "error", error: message });
      updateAction(actionId, "error", message);
    }
  }

  async function verifyAcceptedSwap(orderA: SignedSwapOrder, orderB: SignedSwapOrder, counterpartyPeerId: string) {
    setAcceptState({ status: "loading" });
    updateAction("accept-swap", "loading", "Calling darkpool/acceptSwap to verify both signed orders over AXL.");

    try {
      const payload: AcceptRequest = {
        counterpartyPeerId,
        orderA,
        orderB
      };
      const response = await fetch("/api/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = (await response.json()) as AcceptResponse | AcceptErrorResponse;

      if (!response.ok || !body.ok) {
        throw new Error((body as AcceptErrorResponse).error || `HTTP ${response.status} ${response.statusText}`);
      }

      if (!body.result.accepted) {
        throw new Error(body.result.rationale);
      }

      setAcceptState({ status: "success", response: body, orderA, orderB });
      updateAction("accept-swap", "success", body.result.rationale);
      await checkSettlement(orderA, orderB);
    } catch (error) {
      const message = formatErrorMessage(error);
      setAcceptState({ status: "error", error: message });
      updateAction("accept-swap", "error", message);
    }
  }

  async function checkSettlement(orderA?: SignedSwapOrder, orderB?: SignedSwapOrder) {
    const orders = resolveSettlementOrders(orderA, orderB);

    if (!orders) {
      setSettlementState({ status: "error", error: "No complementary signed orders available for settlement checks." });
      updateAction("preflight-settlement", "error", "No complementary signed orders available.");
      return;
    }

    if (!status?.settlement.address) {
      setSettlementState({ status: "error", error: "Settlement contract address is unavailable." });
      updateAction("preflight-settlement", "error", "Settlement contract address is unavailable.");
      return;
    }

    const ethereum = (window as WindowWithEthereum).ethereum;

    if (!ethereum) {
      setSettlementState({ status: "error", error: "No injected wallet found for settlement checks." });
      updateAction("preflight-settlement", "error", "No injected wallet found.");
      return;
    }

    setSettlementState({ status: "checking" });
    updateAction("preflight-settlement", "loading", "Reading ERC-20 balances and settlement allowances from the connected chain.");

    try {
      const provider = new BrowserProvider(ethereum);
      const checks = await buildSettlementChecks(provider, status.settlement.address, walletAddress, orders.orderA, orders.orderB);
      setSettlementState({ status: "ready", checks });

      const userCheck = checks.find((check) => check.isUserOrder);
      const fundingProblems = checks.filter((check) => !check.balanceOk || !check.allowanceOk);
      const expiredProblems = checks.filter((check) => !check.expiryOk);

      if (expiredProblems.length) {
        updateAction("preflight-settlement", "error", `${expiredProblems.length} signed order(s) expired. Request a fresh quote and sign again before settlement.`);
      } else if (fundingProblems.length) {
        updateAction("preflight-settlement", "error", `${fundingProblems.length} funding/allowance issue(s). ${userCheck && !userCheck.allowanceOk ? "Approve your sell token to continue." : "Counterparty funding/allowance must be fixed before settlement."}`);
      } else {
        updateAction("preflight-settlement", "success", "Both signed orders are unexpired and have enough balance and settlement allowance.");
      }
    } catch (error) {
      const message = formatErrorMessage(error);
      setSettlementState({ status: "error", error: message });
      updateAction("preflight-settlement", "error", message);
    }
  }

  async function approveUserSellToken() {
    const orders = resolveSettlementOrders();

    if (!orders || !status?.settlement.address || !walletAddress) {
      return;
    }

    const checks = "checks" in settlementState && settlementState.checks ? settlementState.checks : [];
    const userCheck = checks.find((check) => check.isUserOrder);

    if (!userCheck) {
      setSettlementState({ status: "error", error: "No user order found for approval.", checks });
      updateAction("preflight-settlement", "error", "No user order found for approval.");
      return;
    }

    const ethereum = (window as WindowWithEthereum).ethereum;

    if (!ethereum) {
      setSettlementState({ status: "error", error: "No injected wallet found for approval.", checks });
      updateAction("preflight-settlement", "error", "No injected wallet found for approval.");
      return;
    }

    setSettlementState({ status: "approving", checks });
    updateAction("preflight-settlement", "loading", `Approving settlement to spend ${userCheck.required} from ${shortAddress(userCheck.token)}.`);

    try {
      const provider = new BrowserProvider(ethereum);
      const signer = await provider.getSigner();
      const token = new Contract(userCheck.token, ERC20_ABI, signer);
      const approvalTx = await token.approve(status.settlement.address, BigInt(userCheck.required));
      updateAction("preflight-settlement", "loading", "Approval transaction submitted; waiting for confirmation.", approvalTx.hash);
      const receipt = await approvalTx.wait();
      updateAction("preflight-settlement", "success", "User sell-token allowance approved.", approvalTx.hash);
      setSettlementState({ status: "submitting", checks, approvalTxHash: approvalTx.hash });
      await checkSettlement(orders.orderA, orders.orderB);

      if (!receipt) {
        return;
      }
    } catch (error) {
      const message = formatErrorMessage(error);
      setSettlementState({ status: "error", error: message, checks });
      updateAction("preflight-settlement", "error", message);
    }
  }

  async function submitSettlement() {
    const orders = resolveSettlementOrders();

    if (!orders || !status?.settlement.address) {
      setSettlementState({ status: "error", error: "No verified signed orders or settlement address available." });
      updateAction("submit-settlement", "error", "No verified signed orders or settlement address available.");
      return;
    }

    const ethereum = (window as WindowWithEthereum).ethereum;

    if (!ethereum) {
      setSettlementState({ status: "error", error: "No injected wallet found for settlement submission." });
      updateAction("submit-settlement", "error", "No injected wallet found.");
      return;
    }

    const checks = "checks" in settlementState && settlementState.checks ? settlementState.checks : [];
    const problems = checks.filter((check) => !check.balanceOk || !check.allowanceOk || !check.expiryOk);

    if (problems.length) {
      setSettlementState({ status: "error", error: "Fix all expiry, balance, and allowance checks before submitting settlement.", checks });
      updateAction("submit-settlement", "error", "Fix all expiry, balance, and allowance checks before submitting settlement.");
      return;
    }

    setSettlementState({ status: "submitting", checks });
    updateAction("submit-settlement", "loading", "Submitting DarkPoolSettlement.settle from the connected wallet.");

    try {
      const provider = new BrowserProvider(ethereum);
      const latestBlock = await provider.getBlock("latest");
      const currentTimestamp = BigInt(latestBlock?.timestamp ?? Math.floor(Date.now() / 1000));

      if (isExpired(orders.orderA.order.expiry, currentTimestamp) || isExpired(orders.orderB.order.expiry, currentTimestamp)) {
        throw new Error("Signed order expired. Request a fresh quote and sign the settlement orders again.");
      }

      const signer = await provider.getSigner();
      const settlement = new Contract(status.settlement.address, DARKPOOL_SETTLEMENT_ABI, signer);
      const transaction = await settlement.settle(toContractOrder(orders.orderA.order), toContractOrder(orders.orderB.order), orders.orderA.signature, orders.orderB.signature);
      updateAction("submit-settlement", "loading", "Settlement transaction submitted; waiting for confirmation.", transaction.hash);
      const receipt = await transaction.wait();
      setSettlementState({ status: "success", checks, transactionHash: transaction.hash, blockNumber: receipt?.blockNumber ?? null });
      updateAction("submit-settlement", "success", `Settlement confirmed${receipt?.blockNumber ? ` in block ${receipt.blockNumber}` : ""}.`, transaction.hash);
    } catch (error) {
      const message = formatErrorMessage(error);
      setSettlementState({ status: "error", error: message, checks });
      updateAction("submit-settlement", "error", message);
    }
  }

  function resolveSettlementOrders(orderA?: SignedSwapOrder, orderB?: SignedSwapOrder): { orderA: SignedSwapOrder; orderB: SignedSwapOrder } | null {
    if (orderA && orderB) {
      return { orderA, orderB };
    }

    if (acceptState.status === "success") {
      return { orderA: acceptState.orderA, orderB: acceptState.orderB };
    }

    if (proposeState.status === "success" && proposeState.response.result.counterSignedOrder) {
      return { orderA: proposeState.signedOrder, orderB: proposeState.response.result.counterSignedOrder };
    }

    return null;
  }

  function updateAction(id: string, actionStatus: ActionStatus, detail?: string, txHash?: string) {
    setActions((current) => current.map((action) => action.id === id ? { ...action, status: actionStatus, detail, txHash: txHash ?? action.txHash, timestamp: new Date().toISOString() } : action));
  }

  return (
    <section className="overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/55 shadow-2xl shadow-cyan-950/20 backdrop-blur">
      <div className="border-b border-white/10 bg-gradient-to-r from-cyan-300/[0.08] via-white/[0.03] to-violet-400/[0.08] p-5 sm:p-7">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.25em] text-cyan-100">
              <Zap size={13} />
              Live console
            </p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-4xl">Route, negotiate, sign, and settle a private OTC intent.</h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
              This is the product cockpit: set an intent, choose an AXL peer, ask for a quote, sign EIP-712 terms, and watch 0G/Galileo artifacts update as the trade progresses.
            </p>
          </div>
          <ConsoleOverview status={status} loading={statusLoading} statusError={statusError} walletAddress={walletAddress} actions={actions} />
        </div>
      </div>

      <div className="grid gap-6 p-4 sm:p-6 xl:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-6">
          <div className="rounded-[1.75rem] border border-white/10 bg-slate-950/70 p-5 backdrop-blur sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-200/70">Step 01 · Trade intent</p>
                <h3 className="mt-2 text-2xl font-semibold text-white">Design your OTC request</h3>
              </div>
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-300/10 text-cyan-200">
                <Zap size={18} />
              </div>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm text-slate-300">Side</span>
                <select value={side} onChange={(event) => setSide(event.target.value as TradeSide)} className="w-full rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-white outline-none ring-cyan-300/20 focus:ring-4">
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-sm text-slate-300">Spend / sell token</span>
                <TokenSelect value={sellSymbol} onChange={setSellSymbol} tokenSymbols={tokenSymbols} fallback={["mUSDC", "mWETH", "mDAI"]} />
              </label>

              <label className="space-y-2">
                <span className="text-sm text-slate-300">Receive / buy token</span>
                <TokenSelect value={buySymbol} onChange={setBuySymbol} tokenSymbols={tokenSymbols} fallback={["mWETH", "mUSDC", "mDAI"]} />
              </label>

              <label className="space-y-2">
                <span className="text-sm text-slate-300">Spend / sell amount</span>
                <input value={sellAmount} onChange={(event) => setSellAmount(event.target.value)} className="w-full rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-white outline-none ring-cyan-300/20 focus:ring-4" />
              </label>

              <label className="space-y-2 sm:col-span-2">
                <span className="text-sm text-slate-300">Reference price</span>
                <input value={referencePrice} onChange={(event) => setReferencePrice(event.target.value)} inputMode="decimal" className="w-full rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-white outline-none ring-cyan-300/20 focus:ring-4" />
              </label>
            </div>

            <div className="mt-4 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-4 text-sm leading-6 text-cyan-50">
              {side === "buy" ? (
                <>Buying <span className="font-semibold text-white">{buySymbol}</span> using <span className="font-semibold text-white">{sellAmount} {sellSymbol}</span>.</>
              ) : (
                <>Selling <span className="font-semibold text-white">{sellAmount} {sellSymbol}</span> for <span className="font-semibold text-white">{buySymbol}</span>.</>
              )} Quote asks the counterparty to sell <span className="font-semibold text-white">{quotePreview.counterpartySellAmount} {buySymbol}</span> for your wallet-signed inverse order.
            </div>
          </div>

          <div className="rounded-[1.75rem] border border-white/10 bg-slate-950/70 p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-200/70">Step 02 · Counterparty</p>
                <h3 className="mt-2 text-2xl font-semibold text-white">Select an OTC peer</h3>
              </div>
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-300/10 text-cyan-200">
                <Users size={18} />
              </div>
            </div>

            <div className="mt-5 space-y-2">
              {status?.participants.length ? (
                status.participants.map((participant) => {
                  const isSelected = selectedPeerId === participant.peerId && !manualPeerId;
                  return (
                    <label
                      key={participant.peerId}
                      className={`group relative flex cursor-pointer items-center gap-4 rounded-2xl border p-4 transition ${isSelected ? "border-cyan-300/60 bg-cyan-300/[0.08]" : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]"}`}
                    >
                      <input
                        type="radio"
                        checked={isSelected}
                        onChange={() => { setSelectedPeerId(participant.peerId); setManualPeerId(""); }}
                        className="sr-only"
                      />
                      <PeerAvatar label={participant.label} active={isSelected} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate font-medium text-white">{participant.label}</p>
                          {participant.service ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/25 bg-emerald-300/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-200">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                              {participant.service}
                            </span>
                          ) : null}
                          {/* <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">{participant.source}</span> */}
                        </div>
                        <p className="mt-1 truncate font-mono text-xs text-slate-400">{shortPeer(participant.peerId)}</p>
                        {participant.pairs.length ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {participant.pairs.map((pair) => (
                              <span key={pair} className="rounded-md bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-cyan-100/90">{pair}</span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 transition ${isSelected ? "border-cyan-300 bg-cyan-300" : "border-white/20 bg-transparent group-hover:border-white/40"}`}>
                        {isSelected ? <CheckCircle2 size={14} className="text-slate-950" strokeWidth={3} /> : null}
                      </div>
                    </label>
                  );
                })
              ) : (
                <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-50">
                  No configured darkpool participants found. Paste a real AXL peer ID below or set <code className="font-mono">OTC_PARTICIPANTS</code> before starting the web app.
                </div>
              )}
            </div>

            <label className="mt-5 block space-y-2">
              <span className="text-xs font-medium uppercase tracking-wider text-slate-400">Or paste a manual AXL peer ID</span>
              <input
                value={manualPeerId}
                onChange={(event) => setManualPeerId(event.target.value)}
                placeholder="64-char Gensyn AXL public key"
                className="w-full rounded-xl border border-white/10 bg-slate-900/80 px-4 py-3 font-mono text-sm text-white placeholder:text-slate-500 outline-none ring-cyan-300/20 focus:ring-4"
              />
            </label>

            <button
              type="button"
              onClick={requestQuote}
              disabled={!canRequestQuote || quoteState.status === "loading"}
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {quoteState.status === "loading" ? <Loader2 size={18} className="animate-spin" /> : <ArrowRight size={18} />}
              {walletAddress ? "Ask selected peer for OTC quote" : "Connect wallet to request a quote"}
            </button>

            <QuoteResult
              quoteState={quoteState}
              proposeState={proposeState}
              proposalRounds={proposalRounds}
              acceptState={acceptState}
              settlementState={settlementState}
              canPropose={Boolean(walletAddress && status?.settlement.ok)}
              explorerBaseUrl={explorerBaseUrl}
              status={status}
              onPropose={signAndPropose}
              onProposeCounterOffer={signAndProposeCounterOffer}
              onCheckSettlement={() => void checkSettlement()}
              onApproveUserSellToken={() => void approveUserSellToken()}
              onSubmitSettlement={() => void submitSettlement()}
            />
          </div>
        </div>

        <div className="space-y-6">
          <div id="proof">
            <ZeroGProofPanel status={status} />
          </div>
          <ActionTimeline actions={actions} explorerBaseUrl={explorerBaseUrl} />
        </div>
      </div>
    </section>
  );
}

function TokenSelect({ value, onChange, tokenSymbols, fallback }: { value: string; onChange: (value: string) => void; tokenSymbols: string[]; fallback: string[] }) {
  const options = tokenSymbols.length ? tokenSymbols : fallback;

  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-white outline-none ring-cyan-300/20 focus:ring-4">
      {options.map((symbol) => (
        <option key={symbol} value={symbol}>{symbol}</option>
      ))}
    </select>
  );
}

function ConsoleOverview({ status, loading, statusError, walletAddress, actions }: { status: TraderStatus | null; loading: boolean; statusError: string | null; walletAddress: string | null; actions: UiAction[] }) {
  const completed = actions.filter((action) => action.status === "success").length;
  const active = actions.find((action) => action.status === "loading") ?? actions.find((action) => action.status === "error") ?? actions.find((action) => action.status === "pending");
  const infraOk = Boolean(status?.axl.ok && status.router.ok && status.settlement.ok && status.zeroG.compute.ok && status.zeroG.storage.ok);
  const cards = [
    {
      label: "Wallet",
      value: walletAddress ? shortAddress(walletAddress) : "Not connected",
      state: walletAddress ? "ok" : "warn"
    },
    {
      label: "Infra",
      value: loading ? "Checking..." : statusError ? "Needs attention" : infraOk ? "Live rails" : "Partial",
      state: loading ? "loading" : statusError || !infraOk ? "warn" : "ok"
    },
    {
      label: "Progress",
      value: `${completed}/${actions.length} steps`,
      state: completed === actions.length ? "ok" : active?.status === "error" ? "error" : "warn"
    }
  ] as const;

  return (
    <div className="grid min-w-full gap-3 sm:grid-cols-3 xl:min-w-[520px]">
      {cards.map((card) => (
        <div key={card.label} className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">{card.label}</p>
            <StatusDot state={card.state} />
          </div>
          <p className="mt-3 truncate font-mono text-sm text-white">{card.value}</p>
        </div>
      ))}
      <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-4 sm:col-span-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-100/80">Current stage</p>
          <p className="text-sm font-medium text-white">{active?.label ?? "Ready for next route"}</p>
        </div>
        <p className="mt-2 text-xs leading-5 text-cyan-50/80">{active?.detail ?? "Start by connecting a wallet and requesting an OTC quote."}</p>
      </div>
    </div>
  );
}

function StatusDot({ state }: { state: "ok" | "warn" | "error" | "loading" }) {
  const color = state === "ok" ? "bg-emerald-400" : state === "error" ? "bg-rose-400" : state === "loading" ? "bg-slate-400" : "bg-amber-400";

  return (
    <span className="relative flex h-2.5 w-2.5">
      {state !== "loading" ? <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${color} opacity-50`}></span> : null}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${color}`}></span>
    </span>
  );
}

function ComputeProof({ compute, label, status }: { compute?: ComputeResponse; label: string; status: TraderStatus | null }) {
  if (!compute) {
    return null;
  }

  const computeStatus = status?.zeroG.compute;
  const providerAddress = computeStatus?.serviceProviderAddress;
  const providerExplorer = computeStatus?.providerExplorerUrl;
  const verified = computeStatus?.verifyResponses;
  const isZeroG = compute.provider === "0g";

  return (
    <div className="mt-3 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-3 text-xs text-cyan-50">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-white">{label}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-1 uppercase ${isZeroG ? "bg-emerald-300/15 text-emerald-100" : "bg-amber-300/15 text-amber-100"}`}>
            {isZeroG ? "0G Compute" : compute.provider}
          </span>
          {isZeroG && verified ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-cyan-300/20 px-2 py-1 uppercase text-cyan-50">
              <ShieldCheck size={12} /> verified response
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <p className="break-all font-mono text-cyan-100/80">model {compute.model}</p>
        <p className="break-all font-mono text-cyan-100/80">request {compute.requestId}</p>
        {providerAddress ? (
          <p className="break-all font-mono text-cyan-100/80 sm:col-span-2">
            provider{" "}
            {providerExplorer ? (
              <a href={providerExplorer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline decoration-cyan-300/40 underline-offset-2 hover:text-cyan-50">
                {providerAddress} <ExternalLink size={12} />
              </a>
            ) : (
              providerAddress
            )}
          </p>
        ) : null}
      </div>
      {compute.content ? (
        <details className="mt-3 rounded-xl bg-slate-950/60 p-3 text-cyan-50/90" open>
          <summary className="cursor-pointer text-[11px] uppercase tracking-[0.2em] text-cyan-200/80">0G Compute reasoning output</summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-cyan-50/95">{compute.content}</pre>
        </details>
      ) : null}
    </div>
  );
}

function ActionTimeline({ actions, explorerBaseUrl }: { actions: UiAction[]; explorerBaseUrl: string }) {
  const completed = actions.filter((action) => action.status === "success").length;
  const total = actions.length;

  return (
    <div className="rounded-3xl border border-white/10 bg-slate-950/70 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-200/70">Demo tape</p>
          <h3 className="mt-2 text-2xl font-semibold text-white">End-to-end progress</h3>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
          <span className="font-mono text-white">{completed}</span>
          <span className="text-slate-500">/</span>
          <span className="font-mono text-slate-400">{total}</span>
          <span>steps</span>
        </div>
      </div>

      <ol className="relative mt-6 space-y-1">
        {actions.map((action, index) => {
          const isLast = index === actions.length - 1;
          return (
            <li key={action.id} className="relative pl-10">
              {!isLast ? (
                <span
                  aria-hidden
                  className={`absolute left-[15px] top-8 h-[calc(100%-1rem)] w-px ${action.status === "success" ? "bg-emerald-400/30" : "bg-white/10"}`}
                ></span>
              ) : null}
              <span className="absolute left-0 top-2">
                <ActionMarker status={action.status} />
              </span>
              <div className={`rounded-2xl border p-4 transition ${markerContainerClass(action.status)}`}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-white">{action.label}</p>
                  <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                    <ClientTime iso={action.timestamp} />
                  </span>
                </div>
                {action.detail ? <p className="mt-1.5 text-xs leading-5 text-slate-300">{action.detail}</p> : null}
                {action.txHash ? <TxLink txHash={action.txHash} explorerBaseUrl={explorerBaseUrl} className="mt-2.5" /> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ActionMarker({ status }: { status: ActionStatus }) {
  const ringClass = status === "loading"
    ? "border-cyan-300 bg-cyan-300/20 shadow-[0_0_12px_rgba(34,211,238,0.6)]"
    : status === "success"
    ? "border-emerald-400 bg-emerald-400"
    : status === "error"
    ? "border-rose-400 bg-rose-400"
    : "border-white/25 bg-slate-950";

  return (
    <span className={`grid h-[30px] w-[30px] place-items-center rounded-full border-2 ${ringClass}`}>
      {status === "loading" ? <Loader2 size={12} className="animate-spin text-cyan-100" strokeWidth={3} /> : null}
      {status === "success" ? <CheckCircle2 size={14} className="text-slate-950" strokeWidth={3} /> : null}
      {status === "error" ? <CircleAlert size={14} className="text-slate-950" strokeWidth={3} /> : null}
      {status === "pending" ? <span className="h-1.5 w-1.5 rounded-full bg-white/30"></span> : null}
    </span>
  );
}

function markerContainerClass(status: ActionStatus): string {
  if (status === "loading") {
    return "border-cyan-300/20 bg-cyan-300/[0.06]";
  }

  if (status === "success") {
    return "border-emerald-300/15 bg-emerald-300/[0.04]";
  }

  if (status === "error") {
    return "border-rose-300/20 bg-rose-300/[0.05]";
  }

  return "border-white/5 bg-white/[0.02]";
}

function PeerAvatar({ label, active }: { label: string; active: boolean }) {
  const initials = label
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("") || "?";

  return (
    <div
      className={`relative grid h-10 w-10 flex-shrink-0 place-items-center rounded-full text-xs font-semibold transition ${active ? "bg-gradient-to-br from-cyan-300 to-violet-400 text-slate-950" : "bg-white/5 text-slate-300"}`}
    >
      {initials}
      {active ? (
        <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 ring-2 ring-slate-950"></span>
      ) : null}
    </div>
  );
}

function QuoteResult({
  quoteState,
  proposeState,
  proposalRounds,
  acceptState,
  settlementState,
  canPropose,
  explorerBaseUrl,
  status,
  onPropose,
  onProposeCounterOffer,
  onCheckSettlement,
  onApproveUserSellToken,
  onSubmitSettlement
}: {
  quoteState: RequestState;
  proposeState: ProposeState;
  proposalRounds: ProposalRound[];
  acceptState: AcceptState;
  settlementState: SettlementState;
  canPropose: boolean;
  explorerBaseUrl: string;
  status: TraderStatus | null;
  onPropose: () => void;
  onProposeCounterOffer: () => void;
  onCheckSettlement: () => void;
  onApproveUserSellToken: () => void;
  onSubmitSettlement: () => void;
}) {
  if (quoteState.status === "idle") {
    return null;
  }

  if (quoteState.status === "loading") {
    return <div className="mt-4 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-4 text-sm text-cyan-50">Waiting for real AXL/MCP response...</div>;
  }

  if (quoteState.status === "error") {
    return <div className="mt-4 rounded-2xl border border-rose-300/20 bg-rose-300/10 p-4 text-sm text-rose-50">{quoteState.error}</div>;
  }

  const quote = quoteState.response.quote;

  return (
    <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4 text-sm text-emerald-50">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-white">Quote from {quote.agentEns}</p>
        <span className="rounded-full bg-emerald-300/15 px-3 py-1 text-xs">confidence {Math.round(quote.confidence * 100)}%</span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <p className="text-emerald-100/70">Sell</p>
          <p className="mt-1 break-all font-semibold text-white">{quote.offer.sellAmount} {shortToken(quote.offer.sellToken)}</p>
        </div>
        <div>
          <p className="text-emerald-100/70">Buy</p>
          <p className="mt-1 break-all font-semibold text-white">{quote.offer.buyAmount} {shortToken(quote.offer.buyToken)}</p>
        </div>
        <div>
          <p className="text-emerald-100/70">Expires</p>
          <p className="mt-1 font-semibold text-white">{quote.offer.expiresAt}</p>
        </div>
      </div>
      <p className="mt-4 leading-6 text-emerald-50/90">{quote.rationale}</p>
      <ComputeProof compute={quote.compute} label="0G Compute quote proof" status={status} />
      <p className="mt-3 break-all font-mono text-xs text-emerald-100/70">agent address {quote.agentAddress}</p>
      <button type="button" onClick={onPropose} disabled={!canPropose || proposeState.status === "loading" || proposalRounds.length > 0} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-60">
        {proposeState.status === "loading" ? <Loader2 size={18} className="animate-spin" /> : <ShieldCheck size={18} />}
        {proposalRounds.length > 0 ? "Round 1 signed" : "Sign inverse order and propose swap"}
      </button>
      <ProposeResult
        proposeState={proposeState}
        proposalRounds={proposalRounds}
        canPropose={canPropose}
        status={status}
        onProposeCounterOffer={onProposeCounterOffer}
      />
      <AcceptResult acceptState={acceptState} />
      <SettlementPanel
        settlementState={settlementState}
        acceptState={acceptState}
        explorerBaseUrl={explorerBaseUrl}
        onCheckSettlement={onCheckSettlement}
        onApproveUserSellToken={onApproveUserSellToken}
        onSubmitSettlement={onSubmitSettlement}
      />
    </div>
  );
}

function ProposeResult({
  proposeState,
  proposalRounds,
  canPropose,
  status,
  onProposeCounterOffer
}: {
  proposeState: ProposeState;
  proposalRounds: ProposalRound[];
  canPropose: boolean;
  status: TraderStatus | null;
  onProposeCounterOffer: () => void;
}) {
  if (proposeState.status === "idle" && proposalRounds.length === 0) {
    return null;
  }

  if (proposeState.status === "loading") {
    return (
      <div className="mt-4 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-4 text-sm text-cyan-50">
        Waiting for wallet signature and real AXL propose response...
        <ProposalRoundHistory proposalRounds={proposalRounds} />
      </div>
    );
  }

  if (proposeState.status === "error") {
    return (
      <div className="mt-4 rounded-2xl border border-rose-300/20 bg-rose-300/10 p-4 text-sm text-rose-50">
        {proposeState.error}
        <ProposalRoundHistory proposalRounds={proposalRounds} />
      </div>
    );
  }

  if (proposeState.status !== "success") {
    return <ProposalRoundHistory proposalRounds={proposalRounds} />;
  }

  const result = proposeState.response.result;
  const counterOffer = result.counterOffer;
  const latestRound = proposalRounds[proposalRounds.length - 1];
  const canSignCounter = Boolean(counterOffer && latestRound && latestRound.round < MAX_NEGOTIATION_ROUNDS && canPropose);

  return (
    <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-sm text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-white">Counterparty decision: {result.decision}</p>
        <span className="rounded-full bg-white/10 px-3 py-1 text-xs">order {proposeState.signedOrder.orderHash.slice(0, 10)}…</span>
      </div>
      <p className="mt-3 leading-6 text-slate-300">{result.rationale}</p>
      <ComputeProof compute={result.compute} label="0G Compute counter proof" status={status} />
      {result.counterSignedOrder ? <p className="mt-3 break-all font-mono text-xs text-emerald-200">counter order {result.counterSignedOrder.orderHash}</p> : null}
      {counterOffer ? (
        <div className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4">
          <p className="font-semibold text-amber-50">Counter-offer requires wallet review</p>
          <OfferSummary offer={counterOffer} />
          <button type="button" onClick={onProposeCounterOffer} disabled={!canSignCounter} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-amber-300 px-4 py-2 font-semibold text-slate-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60">
            <ShieldCheck size={16} />
            {latestRound && latestRound.round >= MAX_NEGOTIATION_ROUNDS ? "Max rounds reached" : `Sign counter-offer round ${(latestRound?.round ?? 1) + 1}`}
          </button>
        </div>
      ) : null}
      <ProposalRoundHistory proposalRounds={proposalRounds} />
    </div>
  );
}

function ProposalRoundHistory({ proposalRounds }: { proposalRounds: ProposalRound[] }) {
  if (!proposalRounds.length) {
    return null;
  }

  return (
    <div className="mt-4 space-y-3">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Visible proposal rounds</p>
      {proposalRounds.map((round) => (
        <div key={`${round.round}-${round.signedOrder.orderHash}`} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium text-white">Round {round.round}</p>
            <span className="rounded-full bg-white/10 px-2 py-1 text-xs uppercase text-slate-300">{round.response.result.decision}</span>
          </div>
          <OfferSummary offer={round.expectation} />
          <p className="mt-2 break-all font-mono text-xs text-slate-400">signed order {round.signedOrder.orderHash}</p>
          {round.response.result.counterSignedOrder ? <p className="mt-1 break-all font-mono text-xs text-emerald-200">counter order {round.response.result.counterSignedOrder.orderHash}</p> : null}
          <p className="mt-2 text-xs text-slate-500"><ClientTime iso={round.timestamp} /></p>
        </div>
      ))}
    </div>
  );
}

function OfferSummary({ offer }: { offer: Offer }) {
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-3">
      <div>
        <p className="text-xs text-slate-400">Counterparty sells</p>
        <p className="mt-1 break-all font-semibold text-white">{offer.sellAmount} {shortToken(offer.sellToken)}</p>
      </div>
      <div>
        <p className="text-xs text-slate-400">Counterparty receives</p>
        <p className="mt-1 break-all font-semibold text-white">{offer.buyAmount} {shortToken(offer.buyToken)}</p>
      </div>
      <div>
        <p className="text-xs text-slate-400">Expires</p>
        <p className="mt-1 font-semibold text-white">{offer.expiresAt}</p>
      </div>
    </div>
  );
}

function AcceptResult({ acceptState }: { acceptState: AcceptState }) {
  if (acceptState.status === "idle") {
    return null;
  }

  if (acceptState.status === "loading") {
    return <div className="mt-4 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-4 text-sm text-cyan-50">Verifying complementary signatures with `acceptSwap` over AXL...</div>;
  }

  if (acceptState.status === "error") {
    return <div className="mt-4 rounded-2xl border border-rose-300/20 bg-rose-300/10 p-4 text-sm text-rose-50">{acceptState.error}</div>;
  }

  return (
    <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4 text-sm text-emerald-50">
      <p className="font-semibold text-white">Complementary signed orders verified</p>
      <p className="mt-2 text-emerald-50/90">{acceptState.response.result.rationale}</p>
      <div className="mt-3 space-y-1 font-mono text-xs text-emerald-100/80">
        <p className="break-all">user order {acceptState.orderA.orderHash}</p>
        <p className="break-all">counter order {acceptState.orderB.orderHash}</p>
      </div>
    </div>
  );
}

function SettlementPanel({
  settlementState,
  acceptState,
  explorerBaseUrl,
  onCheckSettlement,
  onApproveUserSellToken,
  onSubmitSettlement
}: {
  settlementState: SettlementState;
  acceptState: AcceptState;
  explorerBaseUrl: string;
  onCheckSettlement: () => void;
  onApproveUserSellToken: () => void;
  onSubmitSettlement: () => void;
}) {
  if (acceptState.status !== "success") {
    return null;
  }

  const checks = "checks" in settlementState && settlementState.checks ? settlementState.checks : [];
  const userNeedsApproval = checks.some((check) => check.isUserOrder && check.expiryOk && check.balanceOk && !check.allowanceOk);
  const allChecksPass = checks.length > 0 && checks.every((check) => check.expiryOk && check.balanceOk && check.allowanceOk);
  const isBusy = settlementState.status === "checking" || settlementState.status === "approving" || settlementState.status === "submitting";

  return (
    <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-sm text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-white">On-chain settlement readiness</p>
        <button type="button" onClick={onCheckSettlement} disabled={isBusy} className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-100 transition hover:bg-white/10 disabled:opacity-60">
          {settlementState.status === "checking" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Recheck
        </button>
      </div>

      {settlementState.status === "idle" ? <p className="mt-3 text-slate-300">Run settlement preflight to show balances and allowances before the final wallet transaction.</p> : null}
      {settlementState.status === "checking" ? <p className="mt-3 text-cyan-100">Reading token balances and allowances...</p> : null}
      {settlementState.status === "error" ? <p className="mt-3 text-rose-200">{settlementState.error}</p> : null}

      {checks.length ? (
        <div className="mt-4 grid gap-3">
          {checks.map((check) => (
            <div key={`${check.label}-${check.maker}-${check.token}`} className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-white">{check.label}</p>
                <span className={`rounded-full px-2 py-1 text-xs ${check.expiryOk && check.balanceOk && check.allowanceOk ? "bg-emerald-300/10 text-emerald-200" : "bg-amber-300/10 text-amber-100"}`}>
                  {check.expiryOk && check.balanceOk && check.allowanceOk ? "ready" : "needs action"}
                </span>
              </div>
              <p className="mt-2 break-all font-mono text-xs text-slate-400">maker {check.maker}</p>
              <p className="mt-1 break-all font-mono text-xs text-slate-400">token {check.token}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-4">
                <CheckValue label="Required" value={check.required} ok />
                <CheckValue label="Balance" value={check.balance} ok={check.balanceOk} />
                <CheckValue label="Allowance" value={check.allowance} ok={check.allowanceOk} />
                <CheckValue label="Expiry" value={new Date(Number(check.expiry) * 1000).toLocaleString()} ok={check.expiryOk} />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {settlementState.status === "success" ? (
        <div className="mt-4 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-3 text-emerald-50">
          <p className="font-semibold text-white">Settlement confirmed{settlementState.blockNumber ? ` in block ${settlementState.blockNumber}` : ""}</p>
          <TxLink txHash={settlementState.transactionHash} explorerBaseUrl={explorerBaseUrl} className="mt-2" />
        </div>
      ) : null}

      {settlementState.status === "submitting" && settlementState.approvalTxHash ? <TxLink txHash={settlementState.approvalTxHash} explorerBaseUrl={explorerBaseUrl} className="mt-3" /> : null}

      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" onClick={onApproveUserSellToken} disabled={!userNeedsApproval || isBusy} className="inline-flex items-center gap-2 rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50">
          {settlementState.status === "approving" ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
          Approve my sell token
        </button>
        <button type="button" onClick={onSubmitSettlement} disabled={!allChecksPass || isBusy} className="inline-flex items-center gap-2 rounded-full bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50">
          {settlementState.status === "submitting" ? <Loader2 size={16} className="animate-spin" /> : <ExternalLink size={16} />}
          Submit settlement transaction
        </button>
      </div>
    </div>
  );
}

function CheckValue({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className={`rounded-xl border p-2 ${ok ? "border-emerald-300/20 bg-emerald-300/10" : "border-rose-300/20 bg-rose-300/10"}`}>
      <p className="text-xs text-slate-300">{label}</p>
      <p className="mt-1 break-all font-mono text-xs text-white">{value}</p>
    </div>
  );
}

function TxLink({ txHash, explorerBaseUrl, className = "" }: { txHash: string; explorerBaseUrl: string; className?: string }) {
  if (!explorerBaseUrl) {
    return <p className={`${className} break-all font-mono text-xs text-cyan-100`}>tx {txHash}</p>;
  }

  return (
    <a href={`${explorerBaseUrl}${txHash}`} target="_blank" rel="noreferrer" className={`${className} inline-flex items-center gap-2 break-all font-mono text-xs text-cyan-100 underline decoration-cyan-300/40 underline-offset-4 hover:text-cyan-50`}>
      <ExternalLink size={14} />
      {txHash}
    </a>
  );
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function shortPeer(peerId: string): string {
  return peerId.length > 14 ? `${peerId.slice(0, 8)}…${peerId.slice(-6)}` : peerId;
}

function shortToken(token: string): string {
  return token.startsWith("0x") ? shortAddress(token) : token;
}

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 10)}…${hash.slice(-4)}` : hash;
}

function ClientTime({ iso }: { iso: string }) {
  const [time, setTime] = useState("—");

  useEffect(() => {
    setTime(new Date(iso).toLocaleTimeString());
  }, [iso]);

  return <>{time}</>;
}

function ZeroGProofPanel({ status }: { status: TraderStatus | null }) {
  const { events } = useWsFeed();
  const computeEvents = useMemo(() => events.filter((event) => event.kind === "0g:compute").slice(-12).reverse(), [events]);
  const storageEvents = useMemo(() => events.filter((event) => event.kind === "0g:storage").slice(-12).reverse(), [events]);

  if (!status) {
    return null;
  }

  const compute = status.zeroG.compute;
  const storage = status.zeroG.storage;
  const chain = status.zeroG.chain;
  const explorerName = chain.explorerName ?? "block explorer";

  return (
    <div className="rounded-3xl border border-cyan-300/20 bg-cyan-300/5 p-5 shadow-glow">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {/* <p className="text-sm uppercase tracking-[0.3em] text-cyan-200/80">Proof of 0G integration</p> */}
          <h3 className="mt-2 text-xl font-semibold text-white">Verifiable artifacts</h3>
          <p className="mt-1 text-xs text-slate-400">
            Every quote and counter triggers a real 0G Compute call; every quote/propose/accept persists a memory event to 0G Storage. All hashes link to {explorerName}.
          </p>
        </div>
        {/* <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-3 text-cyan-100">
          <FileSearch />
        </div> */}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <ProofCard
          title="0G Compute"
          icon={<Cpu size={16} />}
          ok={compute.ok}
          subtitle={compute.ok ? "Agent reasoning routed through 0G Compute marketplace" : compute.detail ?? "Set COMPUTE_PROVIDER=0g."}
          rows={[
            { label: "Provider", value: compute.serviceProviderAddress, href: compute.providerExplorerUrl, mono: true },
            { label: "Model", value: compute.model },
            { label: "Verification", value: compute.verifyResponses === undefined ? undefined : compute.verifyResponses ? "ZG verified responses" : "unverified" }
          ]}
        />

        <ProofCard
          title="0G Storage / iNFT brain"
          icon={<Database size={16} />}
          ok={storage.ok}
          subtitle={storage.ok ? "Agent brain stored on 0G; memory events persist on every action" : storage.detail ?? "Set BRAINSTORE_PROVIDER=0g."}
          rows={[
            { label: "iNFT contract", value: storage.inftContractAddress, href: storage.inftContractExplorerUrl, mono: true },
            { label: "iNFT token id", value: storage.inftTokenId ? `#${storage.inftTokenId}` : undefined },
            { label: "iNFT mint tx", value: storage.inftMintTxHash, href: storage.inftMintTxExplorerUrl, mono: true, hint: storage.inftMintTxHash ? undefined : "set AGENT_BRAIN_INFT_MINT_TX in .env" },
            { label: "Brain root hash", value: storage.rootHash, mono: true },
            { label: "0G Storage tx", value: storage.storageUploadTxHash, href: storage.storageUploadTxExplorerUrl, mono: true, hint: storage.storageUploadTxHash ? undefined : "set AGENT_BRAIN_STORAGE_TX in .env" },
          ]}
        />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <ProofTape
          title="Live 0G Compute calls"
          icon={<Cpu size={14} />}
          empty="No 0G Compute calls observed yet. Request a quote or propose a counter to trigger one."
          rows={computeEvents.map((event, index) => formatComputeRow(event, index))}
        />
        <ProofTape
          title="Live 0G Storage uploads"
          icon={<Database size={14} />}
          empty="No 0G Storage uploads observed yet. Quote, propose, or accept to persist a memory event."
          rows={storageEvents.map((event, index) => formatStorageRow(event, index, chain.txExplorerBaseUrl))}
        />
      </div>
    </div>
  );
}

type ProofRow = {
  label: string;
  value?: string;
  href?: string;
  mono?: boolean;
  hint?: string;
};

function ProofCard({ title, icon, ok, subtitle, rows }: { title: string; icon: React.ReactNode; ok: boolean; subtitle: string; rows: ProofRow[] }) {
  return (
    <div className={`rounded-2xl border p-4 ${ok ? "border-emerald-300/20 bg-emerald-300/5" : "border-amber-300/20 bg-amber-300/5"}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-white">
          {ok ? <CheckCircle2 size={16} className="text-emerald-200" /> : <CircleAlert size={16} className="text-amber-200" />}
          {icon}
          {title}
        </div>
        <span className={`rounded-full px-2 py-1 text-xs uppercase ${ok ? "bg-emerald-300/15 text-emerald-100" : "bg-amber-300/15 text-amber-100"}`}>{ok ? "live" : "needs config"}</span>
      </div>
      <p className="mt-2 text-xs text-slate-300">{subtitle}</p>
      <dl className="mt-4 grid gap-2 text-xs">
        {rows.map((row) => (
          <ProofRowDisplay key={row.label} row={row} />
        ))}
      </dl>
    </div>
  );
}

function ProofRowDisplay({ row }: { row: ProofRow }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-start gap-3">
      <dt className="text-slate-400">{row.label}</dt>
      <dd className={`break-all text-slate-100 ${row.mono ? "font-mono text-[11px]" : ""}`}>
        {row.value ? (
          row.href ? (
            <a href={row.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-cyan-200 underline decoration-cyan-300/40 underline-offset-2 hover:text-cyan-100">
              {row.value}
              <ExternalLink size={11} />
            </a>
          ) : (
            row.value
          )
        ) : (
          <span className="text-amber-200/80">{row.hint ?? "not configured"}</span>
        )}
      </dd>
    </div>
  );
}

type ProofTapeRow = {
  id: string;
  title: string;
  detail?: string;
  meta?: string;
  href?: string;
  href2?: { href: string; label: string };
  timestamp: string;
};

function ProofTape({ title, icon, empty, rows }: { title: string; icon: React.ReactNode; empty: string; rows: ProofTapeRow[] }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-white">
        {icon}
        {title}
        <span className="ml-auto rounded-full bg-white/10 px-2 py-1 text-xs uppercase text-slate-300">{rows.length} events</span>
      </div>
      <div className="mt-3 space-y-2 max-h-72 overflow-auto pr-1">
        {rows.length === 0 ? (
          <p className="rounded-xl border border-white/5 bg-white/[0.02] p-3 text-xs text-slate-400">{empty}</p>
        ) : (
          rows.map((row) => (
            <div key={row.id} className="rounded-xl border border-white/5 bg-white/[0.03] p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-white">{row.title}</p>
                <p className="text-[10px] text-slate-500"><ClientTime iso={row.timestamp} /></p>
              </div>
              {row.detail ? <p className="mt-1 break-words text-slate-300">{row.detail}</p> : null}
              {row.meta ? <p className="mt-1 break-all font-mono text-[10px] text-slate-400">{row.meta}</p> : null}
              <div className="mt-1 flex flex-wrap gap-3">
                {row.href ? (
                  <a href={row.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-cyan-200 underline decoration-cyan-300/40 underline-offset-2 hover:text-cyan-100">
                    open <ExternalLink size={10} />
                  </a>
                ) : null}
                {row.href2 ? (
                  <a href={row.href2.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-cyan-200 underline decoration-cyan-300/40 underline-offset-2 hover:text-cyan-100">
                    {row.href2.label} <ExternalLink size={10} />
                  </a>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatComputeRow(event: WsEvent, index: number): ProofTapeRow {
  const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
  const stage = typeof payload.stage === "string" ? payload.stage : "compute";
  const provider = typeof payload.provider === "string" ? payload.provider : "0g";
  const model = typeof payload.model === "string" ? payload.model : undefined;
  const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
  const verifyResponses = typeof payload.verifyResponses === "boolean" ? payload.verifyResponses : undefined;
  const contentPreview = typeof payload.contentPreview === "string" ? payload.contentPreview : undefined;
  const agent = typeof payload.agent === "string" ? payload.agent : event.ensName;

  return {
    id: `${event.kind}-${event.timestamp}-${requestId ?? event.agentId ?? index}`,
    title: `${stage} · ${provider}${verifyResponses ? " · verified" : ""}`,
    detail: contentPreview,
    meta: [agent ? `agent ${agent}` : null, model ? `model ${model}` : null, requestId ? `request ${requestId}` : null].filter(Boolean).join(" · "),
    timestamp: event.timestamp
  };
}

function formatStorageRow(event: WsEvent, index: number, txExplorerBaseUrl?: string): ProofTapeRow {
  const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
  const stage = typeof payload.stage === "string" ? payload.stage : "memory-persisted";
  const eventKind = typeof payload.eventKind === "string" ? payload.eventKind : undefined;
  const memoryEvents = typeof payload.memoryEvents === "number" ? payload.memoryEvents : undefined;
  const provider = typeof payload.provider === "string" ? payload.provider : "0g";
  const rootHash = typeof payload.rootHash === "string" ? payload.rootHash : undefined;
  const txHash = typeof payload.txHash === "string" ? payload.txHash : undefined;
  const detail = typeof payload.detail === "string" ? payload.detail : undefined;
  const tokenId = typeof payload.tokenId === "string" ? payload.tokenId : undefined;
  const txExplorer = txHash && txExplorerBaseUrl ? `${txExplorerBaseUrl}${txHash}` : undefined;

  return {
    id: `${event.kind}-${event.timestamp}-${txHash ?? rootHash ?? index}`,
    title: `${stage} · ${provider}${eventKind ? ` · ${eventKind}` : ""}${typeof memoryEvents === "number" ? ` · ${memoryEvents} events` : ""}`,
    detail: detail ?? (tokenId ? `iNFT #${tokenId}` : undefined),
    meta: [rootHash ? `root ${rootHash}` : null, txHash ? `tx ${txHash}` : null].filter(Boolean).join(" · "),
    href: txExplorer,
    timestamp: event.timestamp
  };
}

function createAction(id: string, label: string, status: ActionStatus, detail?: string): UiAction {
  return {
    id,
    label,
    status,
    detail,
    timestamp: new Date().toISOString()
  };
}

function formatErrorMessage(error: unknown): string {
  const decoded = decodeSettlementError(error);

  if (decoded) {
    return decoded;
  }

  if (error instanceof Error && error.message && error.message !== "[object Object]") {
    return error.message;
  }

  if (isRecord(error)) {
    const directMessage = getString(error.message) ?? getString(error.reason) ?? getString(error.shortMessage);

    if (directMessage && directMessage !== "[object Object]") {
      return directMessage;
    }

    const nested = error.error ?? error.data ?? error.cause;

    if (nested) {
      const nestedMessage = formatErrorMessage(nested);

      if (nestedMessage !== "[object Object]") {
        return nestedMessage;
      }
    }

    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown object error";
    }
  }

  return String(error);
}

function decodeSettlementError(error: unknown): string | undefined {
  const data = getErrorData(error);

  if (!data) {
    return undefined;
  }

  try {
    const parsed = SETTLEMENT_INTERFACE.parseError(data);

    if (!parsed) {
      return undefined;
    }

    if (parsed.name === "ExpiredOrder") {
      return `Signed order expired (${parsed.args[0]}). Request a fresh quote and sign again.`;
    }

    return `${parsed.name}(${parsed.args.map((value) => typeof value === "bigint" ? value.toString() : String(value)).join(", ")})`;
  } catch {
    return undefined;
  }
}

function getErrorData(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  if (typeof error.data === "string") {
    return error.data;
  }

  if (isRecord(error.error) && typeof error.error.data === "string") {
    return error.error.data;
  }

  if (isRecord(error.info) && isRecord(error.info.error) && typeof error.info.error.data === "string") {
    return error.info.error.data;
  }

  if (isRecord(error.cause)) {
    return getErrorData(error.cause);
  }

  return undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function buildSettlementChecks(
  provider: BrowserProvider,
  settlementAddress: string,
  walletAddress: string | null,
  orderA: SignedSwapOrder,
  orderB: SignedSwapOrder
): Promise<SettlementCheck[]> {
  const latestBlock = await provider.getBlock("latest");
  const currentTimestamp = BigInt(latestBlock?.timestamp ?? Math.floor(Date.now() / 1000));
  const orders = [
    { label: "User signed order", signedOrder: orderA },
    { label: "Counterparty signed order", signedOrder: orderB }
  ];

  return Promise.all(
    orders.map(async ({ label, signedOrder }) => {
      const token = new Contract(signedOrder.order.sellToken, ERC20_ABI, provider);
      const required = BigInt(signedOrder.order.sellAmount);
      const [balance, allowance] = (await Promise.all([
        token.balanceOf(signedOrder.order.maker),
        token.allowance(signedOrder.order.maker, settlementAddress)
      ])) as [bigint, bigint];

      return {
        label,
        maker: signedOrder.order.maker,
        token: signedOrder.order.sellToken,
        required: required.toString(),
        balance: balance.toString(),
        allowance: allowance.toString(),
        expiry: signedOrder.order.expiry,
        balanceOk: balance >= required,
        allowanceOk: allowance >= required,
        expiryOk: !isExpired(signedOrder.order.expiry, currentTimestamp),
        isUserOrder: Boolean(walletAddress && signedOrder.order.maker.toLowerCase() === walletAddress.toLowerCase())
      };
    })
  );
}

function toContractOrder(order: SignedSwapOrder["order"]) {
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

function buildQuoteRequestAmounts(side: TradeSide, amount: string, referencePriceInput: string): { counterpartySellAmount: string; referencePrice?: number } {
  const referencePrice = Number(referencePriceInput);
  const numericAmount = Number(amount);

  if (!Number.isFinite(referencePrice) || !Number.isFinite(numericAmount) || referencePrice === 0) {
    return {
      counterpartySellAmount: amount,
      referencePrice: Number.isFinite(referencePrice) ? referencePrice : undefined
    };
  }

  if (side === "sell") {
    return {
      counterpartySellAmount: trimDecimal(numericAmount * referencePrice),
      referencePrice: 1 / referencePrice
    };
  }

  return {
    counterpartySellAmount: trimDecimal(numericAmount / referencePrice),
    referencePrice
  };
}

function expiryUnixFromIso(expiresAt: string): string {
  const millis = Date.parse(expiresAt);
  const minimumExpiry = Math.floor(Date.now() / 1000) + SETTLEMENT_ORDER_MIN_TTL_SECONDS;

  if (Number.isFinite(millis)) {
    return BigInt(Math.max(Math.floor(millis / 1000), minimumExpiry)).toString();
  }

  return BigInt(minimumExpiry).toString();
}

function isExpired(expiry: string, currentTimestamp: bigint): boolean {
  return BigInt(expiry) <= currentTimestamp;
}

function newNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return BigInt(`0x${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`).toString();
}

function trimDecimal(value: number): string {
  return Number(value.toFixed(8)).toString();
}

function assertUnsignedIntegerField(field: string, value: string): void {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Wallet signing requires ${field} to be an unsigned integer string, got "${value}". Enter settlement base-unit amounts or adjust the reference price so the quote returns integer amounts.`);
  }
}
