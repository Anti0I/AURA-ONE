import { Preloader } from "@/components/preloader/Preloader";
import { SiteHeader } from "@/components/ui/SiteHeader";
import { SiteFooter } from "@/components/ui/SiteFooter";
import { Reticle } from "@/components/ui/Reticle";
import { Stage } from "@/components/stage/Stage";
import { XraySectionLazy } from "@/components/xray/XraySectionLazy";
import { ConfiguratorSectionLazy } from "@/components/configurator/ConfiguratorSectionLazy";
import { AcousticsSectionLazy } from "@/components/acoustics/AcousticsSectionLazy";

export default function Home() {
  return (
    <>
      <Preloader />
      <SiteHeader />
      <Reticle />
      <main id="main">
        <Stage />
        <XraySectionLazy />
        <ConfiguratorSectionLazy />
        <AcousticsSectionLazy />
      </main>
      <SiteFooter />
    </>
  );
}
