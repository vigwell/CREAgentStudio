import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";

/** Title, intro and the page's actions; actions wrap under the title on phones. */
export function PageHeader({
  title,
  intro,
  back,
  meta,
  actions,
}: {
  title: React.ReactNode;
  intro?: React.ReactNode;
  back?: { to: string; label: string };
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        {back && (
          <Link to={back.to} className="mb-1 inline-flex items-center gap-1 text-sm text-ink-subtle hover:text-ink">
            <ChevronLeft size={16} className="rtl:rotate-180" />
            {back.label}
          </Link>
        )}
        <h1 className="page-title break-words">{title}</h1>
        {meta && <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-muted">{meta}</div>}
        {intro && <p className="page-intro">{intro}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
    </div>
  );
}
