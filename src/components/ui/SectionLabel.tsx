import { cn } from "@/lib/utils";

/**
 * The small monospaced eyebrow that marks every section.
 * `index` is rendered as a fixed-width ordinal so the labels align down the
 * left edge of the page regardless of section name length.
 */
export function SectionLabel({
  index,
  children,
  className,
}: {
  index: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("rule-label flex items-center gap-3", className)}>
      <span data-numeric className="text-signal">
        {String(index).padStart(2, "0")}
      </span>
      <span aria-hidden className="h-px w-8 bg-line-strong" />
      {children}
    </p>
  );
}
