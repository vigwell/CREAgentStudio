import { useEffect, useState } from "react";

/** True while the media query matches (false where matchMedia doesn't exist, e.g. tests). */
export function useMedia(query: string): boolean {
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Dark theme in effect: the user's choice (data-theme) or else the OS setting. */
export function useDarkTheme(): boolean {
  const osDark = useMedia("(prefers-color-scheme: dark)");
  const read = () => (typeof document === "undefined" ? null : document.documentElement.getAttribute("data-theme"));
  const [forced, setForced] = useState<string | null>(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setForced(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return forced ? forced === "dark" : osDark;
}
