import { Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Activity, Library, Stethoscope, Workflow } from "lucide-react";
import { AppShell } from "./ui/AppShell";
import { LanguageMenu } from "./ui/LanguageMenu";
import { EditorSkeleton, ListPageSkeleton, Skeleton } from "./ui/Skeleton";
import { prefetch } from "./api/query";
import { AgentEditorPage } from "./pages/lazy";
import { AgentRelease } from "./pages/AgentRelease";
import { RunDetailPage, RunInspector } from "./pages/RunInspector";
import { useTranslation } from "react-i18next";
import { api, ApiError, type StudioUser } from "./api/client";
import { signIn, signOut } from "./auth/msal";
import { KnowledgeList } from "./pages/KnowledgeList";
import { ImportWizard } from "./pages/ImportWizard";
import { RevisionPage } from "./pages/RevisionPage";
import { AgentsList } from "./pages/AgentsList";

import { ClinicProfiles } from "./pages/ClinicProfiles";
import { AgentRuns } from "./pages/AgentRuns";

type MeState = { kind: "loading" } | { kind: "ok"; user: StudioUser } | { kind: "noAccess" } | { kind: "error"; message: string };

export function App({ initialAccount }: { initialAccount: string | null }) {
  const { t } = useTranslation();
  const [me, setMe] = useState<MeState>({ kind: "loading" });

  useEffect(() => {
    if (!initialAccount) return;
    api<{ user: StudioUser }>("/me")
      .then((r) => setMe({ kind: "ok", user: r.user }))
      .catch((err) =>
        setMe(err instanceof ApiError && err.status === 403 ? { kind: "noAccess" } : { kind: "error", message: (err as Error).message }),
      );
  }, [initialAccount]);


  if (!initialAccount) {
    return (
      <Centered>
        <h1 className="text-title font-semibold">{t("app.title")}</h1>
        <p className="text-sm text-ink-muted">{t("app.tagline")}</p>
        <button className="btn btn-primary w-full" onClick={() => void signIn()}>
          {t("app.signIn")}
        </button>
        <LanguageMenu />
      </Centered>
    );
  }
  if (me.kind === "loading") return <ShellSkeleton />;
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
    { to: "/knowledge", label: t("nav.knowledge"), icon: Library, warm: () => prefetch("/knowledge/sources") },
    { to: "/agents", label: t("nav.agents"), icon: Workflow, warm: () => prefetch("/agents") },
    { to: "/clinic-profiles", label: t("nav.profiles"), icon: Stethoscope, warm: () => prefetch("/clinic-profiles") },
    { to: "/runs", label: t("nav.runs"), icon: Activity, warm: () => prefetch("/runs") },
  ];
  return (
    <AppShell
      nav={nav}
      user={{ name: user.displayName ?? user.email ?? "", role: t(`roles.${user.role}`) }}
      onSignOut={() => void signOut()}
    >
      <Routes>
        <Route path="/" element={<Navigate to="/knowledge" replace />} />
        <Route path="/knowledge" element={<KnowledgeList user={user} />} />
        <Route path="/knowledge/:sourceId/import" element={<ImportWizard />} />
        <Route path="/knowledge/revisions/:revisionId" element={<RevisionPage user={user} />} />
        <Route path="/agents" element={<AgentsList user={user} />} />
        <Route
          path="/agents/:agentId"
          element={
            <Suspense fallback={<EditorSkeleton />}>
              <AgentEditorPage user={user} />
            </Suspense>
          }
        />
        <Route path="/agents/:agentId/runs" element={<AgentRuns />} />
        <Route path="/agents/:agentId/release" element={<AgentRelease user={user} />} />
        <Route path="/runs" element={<RunInspector />} />
        <Route path="/runs/:runId" element={<RunDetailPage />} />
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

/** Signing in: the shell's outline right away, filled once the user is known. */
function ShellSkeleton() {
  return (
    <div className="min-h-screen" aria-busy="true">
      <div className="fixed inset-y-0 start-0 hidden w-16 border-e border-line bg-surface md:block xl:w-60" />
      <div className="md:ps-16 xl:ps-60">
        <div className="flex h-14 items-center gap-3 border-b border-line bg-surface px-4 sm:px-6">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="ms-auto h-8 w-40" />
        </div>
        <div className="mx-auto max-w-[1680px] px-4 py-6 sm:px-6 lg:px-8">
          <ListPageSkeleton />
        </div>
      </div>
    </div>
  );
}
