import { useTranslation } from "react-i18next";
import type { RevisionStatus } from "../api/client";

const COLORS: Record<RevisionStatus | "none", string> = {
  draft: "bg-slate-100 text-slate-700",
  in_review: "bg-amber-100 text-amber-800",
  approved: "bg-brand-soft text-brand-strong",
  withdrawn: "bg-red-100 text-red-700",
  expired: "bg-orange-100 text-orange-800",
  none: "bg-slate-50 text-slate-400",
};

export function StatusBadge({ status }: { status: RevisionStatus | null }) {
  const { t } = useTranslation();
  const s = status ?? "none";
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${COLORS[s]}`}>{t(`status.${s}`)}</span>;
}
