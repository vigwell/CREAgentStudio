import { useTranslation } from "react-i18next";
import type { RevisionStatus } from "../api/client";
import { StatusPill, type Tone } from "../ui/StatusPill";

const TONES: Record<RevisionStatus | "none", Tone> = {
  draft: "neutral",
  in_review: "warning",
  approved: "success",
  withdrawn: "danger",
  expired: "warning",
  none: "neutral",
};

export function StatusBadge({ status }: { status: RevisionStatus | null }) {
  const { t } = useTranslation();
  const s = status ?? "none";
  return <StatusPill tone={TONES[s]}>{t(`status.${s}`)}</StatusPill>;
}
