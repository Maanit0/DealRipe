"use client";

import { useEffect, useState } from "react";

function fmt(iso: string, tz?: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(tz ? { timeZone: tz } : {}),
    });
  } catch {
    return iso;
  }
}

/**
 * Renders a timestamp in the VIEWER's local timezone. The server (and the first
 * client paint) render in UTC so hydration matches; immediately after mount it
 * switches to the browser's local time, which is what the viewer expects.
 * Without this, server-rendered timestamps show Vercel's UTC clock (a 4:44pm
 * Pacific send printed as 11:44pm).
 */
export function LocalTime({ iso, className }: { iso: string; className?: string }) {
  const [text, setText] = useState(() => fmt(iso, "UTC"));
  useEffect(() => {
    setText(fmt(iso));
  }, [iso]);
  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}
