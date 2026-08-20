import { Preloader } from "@/components/preloader/Preloader";
import { Stage } from "@/components/stage/Stage";

export default function Home() {
  return (
    <>
      <Preloader />
      <main id="main">
        <Stage />
        {/* Remaining sections land in the phases that follow. */}
        <section className="flex h-dvh items-center justify-center px-gutter">
          <p className="rule-label">Next: X-Ray scanner</p>
        </section>
      </main>
    </>
  );
}
