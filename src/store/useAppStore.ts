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
 */
export interface AppState {
  /** Preloader has finished and the hero has been revealed. */
  booted: boolean;
  /** 0..1, written at most ~30x during boot, so it is safe as React state. */
  bootProgress: number;
  audioEnabled: boolean;
  devInspector: boolean;
  paletteOpen: boolean;
  material: MaterialId;
  /** Which scrollytelling phase is on screen, for the progress rail. */
  storyPhase: 0 | 1 | 2;
  /** Set once the user opts into the on-device model. */
  aiEngine: "deterministic" | "webgpu";

  setBooted: (v: boolean) => void;
  setBootProgress: (v: number) => void;
  toggleAudio: () => void;
  toggleDevInspector: () => void;
  setPaletteOpen: (v: boolean) => void;
  setMaterial: (id: MaterialId) => void;
  setStoryPhase: (p: 0 | 1 | 2) => void;
  setAiEngine: (e: "deterministic" | "webgpu") => void;
}

export const useAppStore = create<AppState>((set) => ({
  booted: false,
  bootProgress: 0,
  audioEnabled: false,
  devInspector: false,
  paletteOpen: false,
  material: "obsidian",
  storyPhase: 0,
  aiEngine: "deterministic",

  setBooted: (booted) => set({ booted }),
  setBootProgress: (bootProgress) => set({ bootProgress }),
  toggleAudio: () => set((s) => ({ audioEnabled: !s.audioEnabled })),
  toggleDevInspector: () => set((s) => ({ devInspector: !s.devInspector })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setMaterial: (material) => set({ material }),
  setStoryPhase: (storyPhase) => set({ storyPhase }),
  setAiEngine: (aiEngine) => set({ aiEngine }),
}));
