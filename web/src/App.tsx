import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, ApiError, type StudioUser } from "./api/client";
import { signIn, signOut } from "./auth/msal";
import { KnowledgeList } from "./pages/KnowledgeList";
import { ImportWizard } from "./pages/ImportWizard";
import { RevisionPage } from "./pages/RevisionPage";
import { AgentsList } from "./pages/AgentsList";
import { AgentEditor } from "./pages/AgentEditor";
import { ClinicProfiles } from "./pages/ClinicProfiles";
import { AgentRuns } from "./pages/AgentRuns";

type MeState = { kind: "loading" } | { kind: "ok"; user: StudioUser } | { kind: "noAccess" } | { kind: "error"; message: string };

export function App({ initialAccount }: { initialAccount: string | null }) {
  const { t, i18n } = useTranslation();
  const [me, setMe] = useState<MeState>({ kind: "loading" });

  useEffect(() => {
    if (!initialAccount) return;
    api<{ user: StudioUser }>("/me")
      .then((r) => setMe({ kind: "ok", user: r.user }))
      .catch((err) =>
        setMe(err instanceof ApiError && err.status === 403 ? { kind: "noAccess" } : { kind: "error", message: (err as Error).message }),
      );
  }, [initialAccount]);

  const toggleLang = () => void i18n.changeLanguage(i18n.language === "he" ? "en" : "he");

  if (!initialAccount) {
    return (
      <Centered>
        <h1 className="text-2xl font-bold">{t("app.title")}</h1>
        <button className="btn btn-primary" onClick={() => void signIn()}>
          {t("app.signIn")}
        </button>
        <button className="text-sm text-slate-500 underline" onClick={toggleLang}>
          {t("app.language")}
        </button>
      </Centered>
    );
  }
  if (me.kind === "loading") return <Centered>{t("app.loading")}</Centered>;
  if (me.kind === "noAccess" || me.kind === "error") {
    return (
      <Centered>
        <p className="max-w-md text-center text-slate-700">{me.kind === "noAccess" ? t("app.noAccess") : me.message}</p>
        <button className="btn" onClick={() => void signOut()}>
          {t("app.signOut")}
        </button>
      </Centered>
    );
  }

  const user = me.user;
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <Link to="/" className="text-lg font-bold text-brand-strong">
            {t("app.title")}
          </Link>
          <nav className="flex gap-4 text-sm font-medium text-slate-600">
            <Link to="/knowledge" className="hover:text-brand-strong">
              {t("nav.knowledge")}
            </Link>
            <Link to="/agents" className="hover:text-brand-strong">
              {t("nav.agents")}
            </Link>
            <Link to="/clinic-profiles" className="hover:text-brand-strong">
              {t("nav.profiles")}
            </Link>
          </nav>
          <div className="ms-auto flex items-center gap-3 text-sm">
            <span className="text-slate-600">
              {user.displayName ?? user.email} · <span className="font-medium">{t(`roles.${user.role}`)}</span>
            </span>
            <button className="text-slate-500 underline" onClick={toggleLang}>
              {t("app.language")}
            </button>
            <button className="btn" onClick={() => void signOut()}>
              {t("app.signOut")}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Routes>
          <Route path="/" element={<Navigate to="/knowledge" replace />} />
          <Route path="/knowledge" element={<KnowledgeList user={user} />} />
          <Route path="/knowledge/:sourceId/import" element={<ImportWizard />} />
          <Route path="/knowledge/revisions/:revisionId" element={<RevisionPage user={user} />} />
          <Route path="/agents" element={<AgentsList user={user} />} />
          <Route path="/agents/:agentId" element={<AgentEditor user={user} />} />
          <Route path="/agents/:agentId/runs" element={<AgentRuns />} />
          <Route path="/clinic-profiles" element={<ClinicProfiles user={user} />} />
          <Route path="*" element={<Navigate to="/knowledge" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">{children}</div>;
}
