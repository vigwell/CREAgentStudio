/**
 * A form field: one-line label, the control, then an optional hint below it.
 * A label's "(…)" part moves into the hint, so labels in a row stay one line and
 * every control in the row starts at the same height.
 */
export function splitLabel(label: string): { label: string; hint: string | null } {
  const m = /^(.*?)\s*[(（](.+)[)）]\s*$/.exec(label);
  // Only a phrase moves into the hint ("comma separated"); a unit or a single word stays ("Age (years)").
  return m && m[1] && /\s/.test(m[2].trim()) ? { label: m[1], hint: m[2] } : { label, hint: null };
}

export function Field({
  label,
  hint,
  className = "",
  children,
}: {
  label: string;
  hint?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  const parts = splitLabel(label);
  const note = hint ?? parts.hint;
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="label" title={parts.label}>
        {parts.label}
      </span>
      {children}
      {note && <span className="hint">{note}</span>}
    </label>
  );
}
