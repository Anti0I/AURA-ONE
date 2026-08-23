"use client";

import { create } from "zustand";
import type { MaterialId } from "@/data/materials";

/**
 * Discrete UI state only.
 *
 * Hard rule for this project: if a value changes more than a handful of times
 * per second, it does not live here. Zustand notifies React, React reconciles,
 * and at 120 Hz that reconciliation is the frame budget. Per-frame values go
 * to `store/transient.ts` instead.
 *
 * Everything below changes a handful of times in a whole visit, and each field
 * has a reader. `audioEnabled`, `devInspector`, `paletteOpen` and `aiEngine`
 * used to sit here too; the first three lost their controls and the fourth
 * never had a reader outside the inspector that displayed it.
 */
export interface AppState {
  /** Preloader has finished and the hero has been revealed. */
  booted: boolean;
  /** 0..1, written at most ~30x during boot, so it is safe as React state. */
  bootProgress: number;
  material: MaterialId;
  /** Which scrollytelling phase is on screen, for the progress rail. */
  storyPhase: 0 | 1 | 2;

  setBooted: (v: boolean) => void;
  setBootProgress: (v: number) => void;
  setMaterial: (id: MaterialId) => void;
  setStoryPhase: (p: 0 | 1 | 2) => void;
}

export const useAppStore = create<AppState>((set) => ({
  booted: false,
  bootProgress: 0,
  material: "obsidian",
  storyPhase: 0,

  setBooted: (booted) => set({ booted }),
  setBootProgress: (bootProgress) => set({ bootProgress }),
  setMaterial: (material) => set({ material }),
  setStoryPhase: (storyPhase) => set({ storyPhase }),
}));
