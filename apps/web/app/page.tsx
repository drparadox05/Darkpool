import { AppHeader } from "../components/AppHeader";
import { Hero } from "../components/Hero";
import { LiveTape } from "../components/LiveTape";
import { ProductStory } from "../components/ProductStory";
import { TraderConsole } from "../components/TraderConsole";

export default function Page() {
  return (
    <main id="top" className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(8,145,178,0.28),transparent_40%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.22),transparent_35%),radial-gradient(circle_at_50%_48%,rgba(15,23,42,0.98),rgba(2,6,23,1)_62%)] text-slate-100">
      <AppHeader />
      <Hero />
      <ProductStory />

      <div className="mx-auto max-w-7xl px-4 pb-20 sm:px-6 lg:px-10">
        <section id="console" className="scroll-mt-24">
          <TraderConsole />
        </section>

        <section id="tape" className="mt-10 scroll-mt-24">
          <LiveTape />
        </section>
      </div>
    </main>
  );
}
