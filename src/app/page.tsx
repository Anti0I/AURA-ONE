import { Preloader } from "@/components/preloader/Preloader";
import { SiteHeader } from "@/components/ui/SiteHeader";
import { Reticle } from "@/components/ui/Reticle";
import { Stage } from "@/components/stage/Stage";
import { XraySectionLazy } from "@/components/xray/XraySectionLazy";
import { PlaygroundSectionLazy } from "@/components/playground/PlaygroundSectionLazy";
import { ConfiguratorSectionLazy } from "@/components/configurator/ConfiguratorSectionLazy";

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
        <ConfiguratorSectionLazy />
      </main>
    </>
  );
}
