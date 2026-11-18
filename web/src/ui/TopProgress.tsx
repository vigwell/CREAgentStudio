/**
 * Thin bar at the very top while requests run (shown only if they take more than
 * 150 ms, so quick requests don't flicker). Replaces spinners for background work.
 */
import { useEffect, useState } from "react";
import { onApiActivity } from "../api/client";

export function TopProgress() {
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => onApiActivity((n) => setBusy(n > 0)), []);
  useEffect(() => {
    if (!busy) {
      const t = setTimeout(() => setVisible(false), 200);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(t);
  }, [busy]);
  return (
    <div aria-hidden className={`pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}>
      <div className={`top-progress h-full bg-accent ${busy ? "" : "w-full"}`} />
    </div>
  );
}
