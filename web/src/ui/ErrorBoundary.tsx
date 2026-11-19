/**
 * Last line of defence: if a page fails to render, show a calm message with a way
 * forward instead of a blank screen. Resets when the user moves to another page.
 */
import { Component, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

class Boundary extends Component<{ children: ReactNode; fallback: (reset: () => void) => ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("page failed", error);
  }
  render() {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children;
  }
}

export function PageErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  return (
    <Boundary
      key={location.pathname}
      fallback={(reset) => (
        <div role="alert" className="card mx-auto max-w-lg space-y-3 text-center">
          <h1 className="text-title font-semibold text-ink">{t("app.pageFailed")}</h1>
          <p className="text-sm text-ink-muted">{t("app.pageFailedHint")}</p>
          <div className="flex justify-center gap-2">
            <button className="btn" onClick={reset}>
              {t("app.tryAgain")}
            </button>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              {t("app.reload")}
            </button>
          </div>
        </div>
      )}
    >
      {children}
    </Boundary>
  );
}
