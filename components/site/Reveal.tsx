"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Reveals its children once they scroll into view, then stops observing.
 *
 * Reduced-motion users are shown everything immediately rather than being given
 * a shorter animation, because the request is for no motion, not less of it.
 */
export function Reveal({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "section";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      // Fire a little before the section is fully in view, so the motion has
      // finished by the time the reader's eye reaches the content.
      { rootMargin: "0px 0px -10% 0px", threshold: 0.04 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as never}
      className={`dr-reveal ${shown ? "dr-in" : ""} ${className}`}
    >
      {children}
    </Tag>
  );
}

/** Marks a child for staggered entry inside a Reveal. */
export function stagger(i: number, step = 55) {
  return { transitionDelay: `${i * step}ms` };
}
