"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppStore } from "@/store/useAppStore";
import { MATERIALS } from "@/data/materials";
import { scrollTo } from "@/lib/scroll/scrollEngine";
import { tick, sweepDown } from "@/lib/audio/synth";
import { cn } from "@/lib/utils";

interface Command {
  id: string;
  label: string;
  group: string;
  hint?: string;
  run: () => void;
}

/**
 * Command palette.
 *
 * Present because the rest of the page is deeply pointer-driven — a scrubbed
 * canvas, a scanner you aim, a product you drag — and every one of those is a
 * dead end for someone navigating by keyboard. This is the parallel route:
 * anything the page can do, reachable from `⌘K` and typed.
 *
 * It is also the fastest way for anyone to get around a site whose sections are
 * separated by several viewports of scroll.
 */
export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const setOpen = useAppStore((s) => s.setPaletteOpen);
  const setMaterial = useAppStore((s) => s.setMaterial);
  const toggleAudio = useAppStore((s) => s.toggleAudio);
  const toggleInspector = useAppStore((s) => s.toggleDevInspector);

  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<Element | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, [setOpen]);

  const commands = useMemo<Command[]>(() => {
    const go = (selector: string) => () => {
      close();
      // One frame so the palette is gone before the scroll starts; otherwise
      // the backdrop's removal and the scroll animate against each other.
      requestAnimationFrame(() => scrollTo(selector));
    };

    return [
      { id: "top", label: "Go to top", group: "Navigate", run: go("#stage") },
      { id: "scanner", label: "Neural scanner", group: "Navigate", run: go("#scanner") },
      { id: "configurator", label: "Configurator", group: "Navigate", run: go("#configurator") },
      { id: "engineering", label: "Engineering notes", group: "Navigate", hint: "page", run: () => {
          close();
          router.push("/engineering");
        } },

      ...MATERIALS.map((material, i) => ({
        id: `finish-${material.id}`,
        label: `Finish: ${material.name}`,
        group: "Configure",
        hint: material.code,
        run: () => {
          setMaterial(material.id);
          tick(880 + i * 110, 0.11);
          close();
          requestAnimationFrame(() => scrollTo("#configurator"));
        },
      })),

      {
        id: "audio",
        label: "Toggle ambient sound",
        group: "System",
        run: () => {
          toggleAudio();
          close();
        },
      },
      {
        id: "inspector",
        label: "Toggle dev inspector",
        group: "System",
        hint: "D",
        run: () => {
          toggleInspector();
          close();
        },
      },
    ];
  }, [close, router, setMaterial, toggleAudio, toggleInspector]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    // Substring, not fuzzy. Fuzzy matching over eleven commands mostly
    // produces surprising ordering; with a list this size, ranking by where
    // the match lands is both simpler and more predictable.
    return commands
      .map((command) => ({
        command,
        at: `${command.group} ${command.label}`.toLowerCase().indexOf(q),
      }))
      .filter((r) => r.at !== -1)
      .sort((a, b) => a.at - b.at)
      .map((r) => r.command);
  }, [commands, query]);

  /* ---- Open / close ---------------------------------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useAppStore.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement;
      inputRef.current?.focus();
      return;
    }
    // Returning focus is not a nicety: without it, dismissing the palette
    // drops a keyboard user back at the top of the document.
    if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`#palette-${results[active]?.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open, results]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      sweepDown();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % Math.max(results.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % Math.max(results.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      results[active]?.run();
    }
  };

  let lastGroup = "";

  return (
    <div
      className="fixed inset-0 z-[95] flex items-start justify-center bg-void/70 px-4 pt-[12vh] backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
        className="w-full max-w-lg overflow-hidden rounded-tile border border-line-strong bg-surface shadow-2xl"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={results[active] ? `palette-${results[active].id}` : undefined}
          aria-autocomplete="list"
          placeholder="Type a command…"
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-ink outline-none placeholder:text-ink-faint"
        />

        {/*
          A `listbox` may only contain `option` or `group` — not list items,
          and not buttons. The obvious `ul > li > button role="option"` markup
          nests three invalid relationships at once, and options here are not
          focusable by design: this is the combobox pattern, where the input
          keeps focus and `aria-activedescendant` points at the active option.
        */}
        <div
          ref={listRef}
          id="palette-results"
          role="listbox"
          aria-label="Commands"
          className="max-h-[52vh] overflow-y-auto py-1.5"
        >
          {results.length === 0 ? (
            <p className="rule-label px-4 py-6 text-center">No match</p>
          ) : (
            results.map((command, i) => {
              const showGroup = command.group !== lastGroup;
              lastGroup = command.group;
              return (
                <div
                  key={command.id}
                  role="group"
                  aria-label={showGroup ? command.group : undefined}
                >
                  {showGroup ? (
                    <p aria-hidden className="rule-label px-4 pb-1 pt-3">
                      {command.group}
                    </p>
                  ) : null}
                  <div
                    id={`palette-${command.id}`}
                    role="option"
                    aria-selected={i === active}
                    onPointerEnter={() => setActive(i)}
                    onClick={command.run}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left text-sm transition-colors",
                      i === active ? "bg-raised text-ink" : "text-ink-dim",
                    )}
                  >
                    <span className="flex-1">{command.label}</span>
                    {command.hint ? (
                      <span className="rule-label">{command.hint}</span>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <footer className="flex gap-4 border-t border-line px-4 py-2">
          <Key label="↑↓" action="navigate" />
          <Key label="↵" action="run" />
          <Key label="esc" action="close" />
        </footer>
      </div>
    </div>
  );
}

function Key({ label, action }: { label: string; action: string }) {
  return (
    <span className="rule-label flex items-center gap-1.5">
      <kbd className="rounded border border-line-strong px-1.5 py-0.5 text-ink-dim">
        {label}
      </kbd>
      {action}
    </span>
  );
}
