"use client";

import type { Ref } from "react";
import { STORY } from "@/data/story";
import { useAppStore } from "@/store/useAppStore";
import { ProgressRail } from "@/components/ui/ProgressRail";

/**
 * The walkthrough's rail, bound to the story phase in the store.
 *
 * A wrapper rather than a prop on `Stage`, and the reason is re-renders. The
 * phase changes three times per visit, and whichever component subscribes to it
 * re-renders on each — so it is this one, which is cheap, and not `Stage`,
 * which would re-attach the caption refs the frame loop writes to every tick.
 */
export function StoryRail({ ref }: { ref: Ref<HTMLDivElement> }) {
  const phase = useAppStore((s) => s.storyPhase);

  return (
    <ProgressRail
      ref={ref}
      steps={STORY}
      active={phase}
      sectionId="stage"
      // 460svh with a 13% hero hold; land the playhead a little inside each
      // phase so its caption is already up when the scroll arrives.
      targets={[0.22, 0.5, 0.84]}
      label="Walkthrough phases"
    />
  );
}
