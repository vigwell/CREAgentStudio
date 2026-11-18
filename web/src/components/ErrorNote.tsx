export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="rounded-control border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
      {message}
    </div>
  );
}
