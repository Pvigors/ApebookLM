"use client";

import { useEffect, useState } from "react";

const cn = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");

/**
 * NotebookLM-style live status: a pulsing dot + shimmering text that cycles
 * through the given steps. Use during long-running work (generating, thinking).
 */
export function DynamicStatus({
  steps,
  interval = 2000,
  className,
}: {
  steps: string[];
  interval?: number;
  className?: string;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (steps.length <= 1) return;
    const t = setInterval(() => setI((v) => v + 1), interval);
    return () => clearInterval(t);
  }, [steps.length, interval]);
  const text = steps[i % steps.length] ?? "";
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
      </span>
      <span key={text} className="shimmer-text animate-fadeup font-medium">
        {text}
      </span>
    </span>
  );
}
