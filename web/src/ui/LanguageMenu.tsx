/** Language dropdown (the Report Engine's five UI languages). Keyboard: arrows, Enter, Esc. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Languages } from "lucide-react";
import { UI_LANGUAGES } from "../i18n";

export function LanguageMenu({ compact = false }: { compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const current = UI_LANGUAGES.find((l) => l.value === i18n.language) ?? UI_LANGUAGES[0];

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, UI_LANGUAGES.findIndex((l) => l.value === current.value)));
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, current.value]);

  const choose = (code: string) => {
    setOpen(false);
    if (code !== i18n.language) void i18n.changeLanguage(code);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") setActive((a) => (a + 1) % UI_LANGUAGES.length);
    else if (e.key === "ArrowUp") setActive((a) => (a - 1 + UI_LANGUAGES.length) % UI_LANGUAGES.length);
    else if (e.key === "Enter") choose(UI_LANGUAGES[active].value);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={root} className="relative" onKeyDown={onKey}>
      <button
        type="button"
        className={compact ? "icon-btn" : "flex h-10 items-center gap-1.5 rounded-control px-2.5 text-ink-muted hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${t("app.language")}: ${current.label}`}
        title={t("app.language")}
        onClick={() => setOpen((o) => !o)}
      >
        <Languages size={18} />
        {!compact && (
          <>
            <span className="text-sm font-medium uppercase tracking-wide">{current.value}</span>
            <ChevronDown size={14} className="text-ink-subtle" />
          </>
        )}
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={t("app.language")}
          className="animate-pop absolute end-0 top-full z-50 mt-1.5 w-44 overflow-hidden rounded-panel border border-line bg-surface py-1 shadow-float"
        >
          {UI_LANGUAGES.map((l, i) => (
            <li
              key={l.value}
              role="option"
              aria-selected={l.value === current.value}
              lang={l.value}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(l.value)}
              className={`flex h-9 cursor-pointer items-center gap-2 px-3 text-sm ${i === active ? "bg-surface-sunken" : ""} ${
                l.value === current.value ? "font-medium text-ink" : "text-ink-muted"
              }`}
            >
              <span className="flex-1">{l.label}</span>
              <span className="text-xs uppercase text-ink-subtle">{l.value}</span>
              {l.value === current.value && <Check size={15} className="text-accent" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
