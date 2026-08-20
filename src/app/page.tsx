import { Preloader } from "@/components/preloader/Preloader";
import { SiteHeader } from "@/components/ui/SiteHeader";
import { Reticle } from "@/components/ui/Reticle";
import { Stage } from "@/components/stage/Stage";
import { XraySectionLazy } from "@/components/xray/XraySectionLazy";

export default function Home() {
  return (
    <>
      <Preloader />
      <SiteHeader />
      <Reticle />
      <main id="main">
        <Stage />
        <XraySectionLazy />
        {/* Remaining sections land in the phases that follow. */}
        <section className="flex h-dvh items-center justify-center px-gutter">
          <p className="rule-label">Next: Neural OS playground</p>
        </section>
      </main>
    </>
  );
}
