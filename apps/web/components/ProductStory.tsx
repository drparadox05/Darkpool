import type { ComponentType } from "react";
import { ArrowRight, Bot, BrainCircuit, ChartNoAxesCombined, CheckCircle2, CircleDollarSign, Coins, LockKeyhole, Network, Radar, ShieldCheck, Sparkles } from "lucide-react";

type IconType = ComponentType<{ size?: number; className?: string }>;

type StoryCard = {
  Icon: IconType;
  label: string;
  title: string;
  body: string;
};

const productPillars: StoryCard[] = [
  {
    Icon: LockKeyhole,
    label: "Private intent",
    title: "No public order-book leakage",
    body: "Treasuries can ask for block liquidity through agent-to-agent RFQ instead of broadcasting size, side, and urgency to the market."
  },
  {
    Icon: Bot,
    label: "Agent execution",
    title: "Counterparties negotiate for you",
    body: "Each peer runs its own policy, quotes terms, counters risk, signs complementary orders, and leaves a visible audit trail."
  },
  {
    Icon: ShieldCheck,
    label: "Verifiable rails",
    title: "Wallet-signed and provable",
    body: "EIP-712 orders settle on Galileo while 0G Compute and 0G Storage attach proof to reasoning, memories, and settlement artifacts."
  }
];

const pmfCards = [
  {
    label: "Buyer",
    title: "Protocol treasuries, funds, OTC desks, and AI wallets",
    points: ["Need large trades without market impact", "Need policy-controlled counterparties", "Need proof for internal review"]
  },
  {
    label: "Wedge",
    title: "Start with private stablecoin and blue-chip treasury swaps",
    points: ["High-value, repeatable workflow", "Clear pain around slippage and leakage", "Simple fee model per routed or settled trade"]
  },
  {
    label: "Retention",
    title: "Agent memories and policies compound over time",
    points: ["Recurring counterparties improve execution", "Risk rules become institutional knowledge", "Audit logs make compliance easier"]
  }
];

const marketVectors: StoryCard[] = [
  {
    Icon: Coins,
    label: "OTC execution",
    title: "Private block liquidity",
    body: "The market already routes meaningful size through OTC workflows. AgentMute gives that workflow programmable discovery, negotiation, and settlement."
  },
  {
    Icon: BrainCircuit,
    label: "AI wallets",
    title: "Autonomous treasury operators",
    body: "As agent wallets manage capital, they need counterparties, risk limits, memory, approvals, and signed execution rails rather than a chat window."
  },
  {
    Icon: Network,
    label: "A2A networks",
    title: "Routing layer for machine orderflow",
    body: "Gensyn AXL-style peer discovery creates a natural distribution path for liquidity agents, strategy agents, and treasury agents."
  },
  {
    Icon: CircleDollarSign,
    label: "Business model",
    title: "Multiple fee surfaces",
    body: "RFQ routing, settlement fees, hosted agent policies, premium compliance exports, and verified memory storage can become separate product lines."
  }
];

const workflow = [
  { step: "01", title: "Treasury intent", body: "Describe side, pair, size, and reference price without posting to a public book." },
  { step: "02", title: "Private RFQ", body: "AXL peers price the request using their own strategy and 0G-backed reasoning." },
  { step: "03", title: "Wallet signature", body: "The trader signs an inverse EIP-712 order only when terms are acceptable." },
  { step: "04", title: "Settlement proof", body: "Complementary orders are verified, preflighted, and settled on-chain with artifact links." }
];

export function ProductStory() {
  return (
    <section id="product" className="mx-auto max-w-7xl scroll-mt-24 px-4 py-12 sm:px-6 lg:px-10 lg:py-16">
      <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-6 shadow-glow backdrop-blur md:p-8">
          <p className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.25em] text-cyan-100">
            <Sparkles size={13} /> What the product is
          </p>
          <h2 className="mt-6 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            AgentMute is a private execution network for AI-native OTC trading.
          </h2>
          <p className="mt-5 text-base leading-7 text-slate-300">
            It turns a treasury trade intent into an agent-to-agent negotiation: discover a peer, request a quote, sign a wallet-native order, verify the counterparty signature, and settle without exposing the full negotiation to a public market.
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {["Private RFQ", "Agent negotiation", "On-chain settlement"].map((item) => (
              <div key={item} className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                <CheckCircle2 size={18} className="text-emerald-300" />
                <p className="mt-3 text-sm font-semibold text-white">{item}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-1">
          {productPillars.map(({ Icon, label, title, body }) => (
            <article key={title} className="rounded-[1.75rem] border border-white/10 bg-slate-950/70 p-5 backdrop-blur transition hover:border-cyan-300/30 hover:bg-cyan-300/[0.04]">
              <div className="flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-2xl bg-cyan-300/10 text-cyan-100">
                  <Icon size={20} />
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-200/70">{label}</p>
                  <h3 className="mt-1 font-semibold text-white">{title}</h3>
                </div>
              </div>
              <p className="mt-4 text-sm leading-6 text-slate-300">{body}</p>
            </article>
          ))}
        </div>
      </div>

      <div id="pmf" className="mt-6 scroll-mt-24 rounded-[2rem] border border-white/10 bg-slate-950/65 p-6 backdrop-blur md:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-cyan-200/70">Product-market fit</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">A sharp wedge into private autonomous capital movement.</h2>
          </div>
          <p className="max-w-2xl text-sm leading-6 text-slate-300">
            The strongest early users are teams that already trade size, already coordinate OTC manually, and increasingly want AI agents to execute within policy rather than only suggest actions.
          </p>
        </div>

        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {pmfCards.map((card) => (
            <article key={card.label} className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-violet-200/75">{card.label}</p>
              <h3 className="mt-3 text-lg font-semibold text-white">{card.title}</h3>
              <ul className="mt-5 space-y-3">
                {card.points.map((point) => (
                  <li key={point} className="flex gap-3 text-sm leading-6 text-slate-300">
                    <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-cyan-300"></span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>

      <div id="market" className="mt-6 grid scroll-mt-24 gap-5 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="rounded-[2rem] border border-cyan-300/20 bg-gradient-to-br from-cyan-300/12 via-slate-950/80 to-violet-400/10 p-6 md:p-8">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-cyan-300 text-slate-950">
            <ChartNoAxesCombined size={22} />
          </div>
          <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.3em] text-cyan-100/80">Potential</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">The upside is becoming the RFQ layer for machine-driven orderflow.</h2>
          <p className="mt-5 text-sm leading-7 text-slate-300">
            If autonomous wallets become real operators, they will need negotiation, liquidity discovery, risk controls, and settlement rails. AgentMute is positioned as the coordination layer between those agents and human-controlled wallets.
          </p>
          <a href="#console" className="mt-7 inline-flex items-center gap-2 rounded-full bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200">
            Try the live console <ArrowRight size={16} />
          </a>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {marketVectors.map(({ Icon, label, title, body }) => (
            <article key={title} className="rounded-3xl border border-white/10 bg-white/[0.035] p-5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">{label}</p>
                <Icon size={18} className="text-cyan-200" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">{title}</h3>
              <p className="mt-3 text-sm leading-6 text-slate-300">{body}</p>
            </article>
          ))}
        </div>
      </div>

      <div className="mt-6 rounded-[2rem] border border-white/10 bg-slate-950/70 p-6 md:p-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-cyan-200/70">Workflow</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white">From intent to settlement in one visible path.</h2>
          </div>
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-4 py-2 text-sm text-emerald-100">
            <Radar size={16} /> Built for live agent networks
          </div>
        </div>
        <div className="mt-8 grid gap-4 lg:grid-cols-4">
          {workflow.map((item) => (
            <article key={item.step} className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03] p-5">
              <p className="font-mono text-sm text-cyan-200">{item.step}</p>
              <h3 className="mt-5 text-lg font-semibold text-white">{item.title}</h3>
              <p className="mt-3 text-sm leading-6 text-slate-300">{item.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
