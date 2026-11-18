/**
 * Back-office shell (pattern from the Vaplio design system, in CRE colours):
 * - desktop (≥1280 px): sidebar expanded (icon + title) or collapsed (icons with tooltips);
 *   toggle with the handle or Ctrl/⌘ B, remembered on the device;
 * - tablet (768–1279 px): collapsed icon rail;
 * - phone (<768 px): no sidebar; the menu button opens the same navigation as a drawer.
 * Logical properties throughout, so Hebrew (RTL) mirrors the layout.
 */
import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Languages, LogOut, Menu, Monitor, Moon, Sun, X, type LucideIcon } from "lucide-react";
import { applyTheme, readFlag, storedTheme, writeFlag, type ThemeChoice } from "./theme";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const COLLAPSE_KEY = "studio.sidebarCollapsed";

export function AppShell({
  nav,
  user,
  onSignOut,
  onToggleLanguage,
  children,
}: {
  nav: NavItem[];
  user: { name: string; role: string };
  onSignOut: () => void;
  onToggleLanguage: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => readFlag(COLLAPSE_KEY, false));
  const [drawer, setDrawer] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme);

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => setDrawer(false), [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed((c) => {
          writeFlag(COLLAPSE_KEY, !c);
          return !c;
        });
      }
      if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = () =>
    setCollapsed((c) => {
      writeFlag(COLLAPSE_KEY, !c);
      return !c;
    });
  const nextTheme: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;

  return (
    <div className="min-h-screen">
      {/* Sidebar: icon rail on tablet, expanded or collapsed on desktop, hidden on phone. */}
      <aside
        className={`fixed inset-y-0 start-0 z-30 hidden flex-col border-e border-line bg-surface md:flex md:w-16 ${collapsed ? "" : "xl:w-60"}`}
        aria-label={t("nav.main")}
      >
        <Brand compact={collapsed} />
        <NavList nav={nav} compact={collapsed} />
        <button
          type="button"
          onClick={toggle}
          className="absolute -end-3 top-[18px] hidden h-6 w-6 items-center justify-center rounded-full border border-line-strong bg-surface text-ink-muted shadow-sm hover:text-ink xl:flex"
          title={`${collapsed ? t("nav.expand") : t("nav.collapse")} (Ctrl/⌘ B)`}
          aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
        >
          {collapsed ? <ChevronRight size={14} className="rtl:rotate-180" /> : <ChevronLeft size={14} className="rtl:rotate-180" />}
        </button>
      </aside>

      {/* Phone drawer: the same navigation. */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label={t("nav.main")}>
          <button className="absolute inset-0 bg-black/40" aria-label={t("nav.close")} onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 start-0 flex w-72 max-w-[85vw] flex-col bg-surface shadow-float">
            <div className="flex items-center">
              <Brand compact={false} />
              <button className="icon-btn ms-auto me-2" onClick={() => setDrawer(false)} aria-label={t("nav.close")}>
                <X size={20} />
              </button>
            </div>
            <NavList nav={nav} compact={false} />
            <div className="mt-auto border-t border-line p-4 text-sm">
              <div className="font-medium text-ink">{user.name}</div>
              <div className="text-ink-subtle">{user.role}</div>
            </div>
          </div>
        </div>
      )}

      <div className={`md:ps-16 ${collapsed ? "" : "xl:ps-60"}`}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur sm:px-6">
          <button className="icon-btn md:hidden" onClick={() => setDrawer(true)} aria-label={t("nav.menu")}>
            <Menu size={20} />
          </button>
          <span className="truncate text-sm font-semibold text-ink md:hidden">{t("app.title")}</span>
          <div className="ms-auto flex items-center gap-1">
            <span className="me-2 hidden text-end text-sm leading-tight sm:block">
              <span className="block font-medium text-ink">{user.name}</span>
              <span className="block text-caption text-ink-subtle">{user.role}</span>
            </span>
            <button className="icon-btn" onClick={onToggleLanguage} title={t("app.language")} aria-label={t("app.language")}>
              <Languages size={18} />
            </button>
            <button
              className="icon-btn"
              onClick={() => setTheme(nextTheme[theme])}
              title={t(`theme.${theme}`)}
              aria-label={t(`theme.${theme}`)}
            >
              <ThemeIcon size={18} />
            </button>
            <button className="icon-btn" onClick={onSignOut} title={t("app.signOut")} aria-label={t("app.signOut")}>
              <LogOut size={18} className="rtl:rotate-180" />
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

function Brand({ compact }: { compact: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-4">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-accent text-sm font-bold text-accent-ink">CRE</span>
      <span className={`truncate text-sm font-semibold text-ink ${compact ? "hidden" : "hidden xl:block"} max-md:block`}>{t("app.title")}</span>
    </div>
  );
}

function NavList({ nav, compact }: { nav: NavItem[]; compact: boolean }) {
  return (
    <nav className="flex flex-col gap-1 p-2">
      {nav.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          title={item.label}
          className={({ isActive }) =>
            `flex h-10 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors ${
              isActive ? "bg-highlight text-ink" : "text-ink-muted hover:bg-surface-sunken hover:text-ink"
            }`
          }
        >
          <item.icon size={18} className="shrink-0" />
          <span className={`truncate ${compact ? "hidden" : "hidden xl:inline"} max-md:inline`}>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
