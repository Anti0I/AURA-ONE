import { Preloader } from "@/components/preloader/Preloader";
import { SiteHeader } from "@/components/ui/SiteHeader";
import { SiteFooter } from "@/components/ui/SiteFooter";
import { Reticle } from "@/components/ui/Reticle";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { DevInspector } from "@/components/devhud/DevInspector";
import { Stage } from "@/components/stage/Stage";
import { XraySectionLazy } from "@/components/xray/XraySectionLazy";
import { ConfiguratorSectionLazy } from "@/components/configurator/ConfiguratorSectionLazy";

export default function Home() {
  return (
    <>
      <Preloader />
      <SiteHeader />
      <Reticle />
      <CommandPalette />
      <DevInspector />
      <main id="main">
        <Stage />
        <XraySectionLazy />
        <ConfiguratorSectionLazy />
      </main>
      <SiteFooter />
    </>
  );
}
