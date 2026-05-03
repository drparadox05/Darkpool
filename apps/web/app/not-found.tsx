import { ArrowLeft, Bot } from "lucide-react";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(8,145,178,0.28),transparent_40%),#020617] px-4 py-20 text-slate-100 sm:px-6 lg:px-10">
      <div className="mx-auto flex max-w-2xl flex-col items-center rounded-[2rem] border border-white/10 bg-slate-950/70 p-8 text-center shadow-glow backdrop-blur">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-cyan-300 via-sky-200 to-violet-300 text-slate-950 shadow-[0_0_28px_rgba(56,189,248,0.35)]">
          <Bot size={24} strokeWidth={2.4} />
        </div>
        <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.3em] text-cyan-200/70">404</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white">Route not found</h1>
        <p className="mt-4 max-w-md text-sm leading-6 text-slate-300">
          This AgentMute route does not exist. Return to the landing page to view the product story and live OTC console.
        </p>
        <a href="/" className="mt-7 inline-flex items-center gap-2 rounded-full bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200">
          <ArrowLeft size={16} />
          Back to AgentMute
        </a>
      </div>
    </main>
  );
}
