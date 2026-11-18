/**
 * Placeholders shaped like the content that is loading (no spinners): the page
 * keeps its layout, so nothing jumps when the data arrives.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`skeleton block rounded-control ${className}`} />;
}

export function TableSkeleton({ rows = 4, cols = 4, bare = false }: { rows?: number; cols?: number; bare?: boolean }) {
  return (
    <div className={bare ? "" : "card p-0"} aria-busy="true">
      <div className="flex gap-6 border-b border-line px-3 py-3">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-6 border-b border-line px-3 py-4 last:border-b-0">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={`h-3.5 flex-1 ${c === 0 ? "max-w-[220px]" : ""}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function HeaderSkeleton({ actions = 1 }: { actions?: number }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start" aria-busy="true">
      <div className="flex-1 space-y-2.5">
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-3.5 w-[min(560px,100%)]" />
      </div>
      <div className="flex gap-2">
        {Array.from({ length: actions }, (_, i) => (
          <Skeleton key={i} className="h-10 w-32" />
        ))}
      </div>
    </div>
  );
}

/** List page: title, intro, table. */
export function ListPageSkeleton({ cols = 4 }: { cols?: number }) {
  return (
    <div className="space-y-6">
      <HeaderSkeleton />
      <TableSkeleton cols={cols} />
    </div>
  );
}

/** Agent editor: palette, canvas, inspector. */
export function EditorSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <HeaderSkeleton actions={3} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[200px_minmax(0,1fr)_320px]">
        <div className="card hidden space-y-2 p-3 lg:block">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
        <div className="card flex h-[420px] items-center justify-center gap-6 md:h-[600px]">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-24" />
          ))}
        </div>
        <div className="card space-y-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      </div>
    </div>
  );
}

/** Detail page: title, a panel of fields, a table. */
export function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <HeaderSkeleton actions={2} />
      <div className="card grid grid-cols-1 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-36" />
          </div>
        ))}
      </div>
      <TableSkeleton rows={5} cols={5} />
    </div>
  );
}
