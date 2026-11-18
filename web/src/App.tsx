import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Library, Stethoscope, Workflow } from "lucide-react";
import { AppShell } from "./ui/AppShell";
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
        <h1 className="text-title font-semibold">{t("app.title")}</h1>
        <p className="text-sm text-ink-muted">{t("app.tagline")}</p>
        <button className="btn btn-primary w-full" onClick={() => void signIn()}>
          {t("app.signIn")}
        </button>
        <button className="text-sm text-ink-subtle underline hover:text-ink" onClick={toggleLang}>
          {t("app.language")}
        </button>
      </Centered>
    );
  }
  if (me.kind === "loading") return <Centered>{t("app.loading")}</Centered>;
  if (me.kind === "noAccess" || me.kind === "error") {
    return (
      <Centered>
        <p className="text-sm text-ink">{me.kind === "noAccess" ? t("app.noAccess") : me.message}</p>
        <button className="btn" onClick={() => void signOut()}>
          {t("app.signOut")}
        </button>
      </Centered>
    );
  }

  const user = me.user;
  const nav = [
    { to: "/knowledge", label: t("nav.knowledge"), icon: Library },
    { to: "/agents", label: t("nav.agents"), icon: Workflow },
    { to: "/clinic-profiles", label: t("nav.profiles"), icon: Stethoscope },
  ];
  return (
    <AppShell
      nav={nav}
      user={{ name: user.displayName ?? user.email ?? "", role: t(`roles.${user.role}`) }}
      onSignOut={() => void signOut()}
      onToggleLanguage={toggleLang}
    >
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
    </AppShell>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="card flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-panel bg-accent text-base font-bold text-accent-ink">CRE</span>
        {children}
      </div>
    </div>
  );
}
