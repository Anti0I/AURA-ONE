import { Preloader } from "@/components/preloader/Preloader";
import { SiteHeader } from "@/components/ui/SiteHeader";
import { Reticle } from "@/components/ui/Reticle";
import { Stage } from "@/components/stage/Stage";
import { XraySectionLazy } from "@/components/xray/XraySectionLazy";
import { PlaygroundSectionLazy } from "@/components/playground/PlaygroundSectionLazy";

export default function Home() {
  return (
    <>
      <Preloader />
      <SiteHeader />
      <Reticle />
      <main id="main">
        <Stage />
        <XraySectionLazy />
        <PlaygroundSectionLazy />
        {/* Configurator lands in the next phase. */}
        <section className="flex h-dvh items-center justify-center px-gutter">
          <p className="rule-label">Next: configurator</p>
        </section>
      </main>
    </>
  );
}
