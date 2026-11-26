/**
 * Account menu in the header: initials and name; the menu holds who is signed
 * in (name, email, role), the theme choice and Sign out. Keyboard: Enter / Space
 * opens, Esc closes and returns focus to the button.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, LogOut, Monitor, Moon, Sun } from "lucide-react";
import type { ThemeChoice } from "./theme";

/** The account's display name without a trailing note in brackets ("Dana Levi (Developer)" → "Dana Levi"). */
export function shortName(name: string): string {
  const s = name.replace(/\s*[([][^)\]]*[)\]]\s*$/, "").trim();
  return s || name.trim();
}

export function initials(name: string): string {
  const words = shortName(name).split(/[\s@._-]+/).filter(Boolean);
  const chars = words.slice(0, 2).map((w) => Array.from(w)[0] ?? "");
  return chars.join("").toUpperCase() || "?";
}

const THEMES: { value: ThemeChoice; icon: typeof Sun }[] = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
];

export function UserMenu({
  user,
  theme,
  onTheme,
  onSignOut,
}: {
  user: { name: string; role: string; email?: string | null };
  theme: ThemeChoice;
  onTheme: (t: ThemeChoice) => void;
  onSignOut: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const name = shortName(user.name);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        className="flex h-10 items-center gap-2 rounded-control px-1.5 text-start hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("app.account", { name })}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar name={user.name} />
        <span className="hidden max-w-[12rem] truncate text-sm font-medium text-ink lg:block">{name}</span>
        <ChevronDown size={14} className="hidden shrink-0 text-ink-subtle lg:block" />
      </button>

      {open && (
        <div role="menu" aria-label={t("app.account", { name })} className="animate-pop absolute end-0 top-full z-50 mt-1.5 w-72 overflow-hidden rounded-panel border border-line bg-surface shadow-float">
          <div className="flex items-center gap-3 border-b border-line p-4">
            <Avatar name={user.name} large />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-ink" title={user.name}>
                {name}
              </div>
              {user.email && <div className="truncate text-caption text-ink-subtle">{user.email}</div>}
              <span className="mt-1 inline-flex rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-ink">{user.role}</span>
            </div>
          </div>

          <div className="border-b border-line p-3">
            <div className="mb-2 px-1 text-caption text-ink-subtle">{t("theme.label")}</div>
            <div className="grid grid-cols-3 gap-1 rounded-control bg-surface-sunken p-1" role="radiogroup" aria-label={t("theme.label")}>
              {THEMES.map(({ value, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={theme === value}
                  onClick={() => onTheme(value)}
                  className={`flex h-8 items-center justify-center gap-1.5 rounded-[5px] text-sm transition-colors ${
                    theme === value ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  <Icon size={14} />
                  {t(`theme.option.${value}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="p-1.5">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
              className="flex h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
            >
              <LogOut size={16} className="rtl:rotate-180" />
              {t("app.signOut")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-accent-ink ${large ? "h-10 w-10 text-sm" : "h-8 w-8 text-xs"}`}
    >
      {initials(name)}
    </span>
  );
}
