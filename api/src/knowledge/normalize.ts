/**
 * Spreadsheet rows → normalized knowledge rows (spec rev 7, section 05).
 * The author picks the header row and maps existing columns to canonical
 * fields; nothing has to be rewritten into a new layout. Every column is kept
 * for display with its cell reference; only mapped fields are typed and
 * validated. Errors are per row / cell so the author can fix the source.
 */
import { createHash } from "node:crypto";
import { FIELD_BY_NAME, REQUIRED_BY_KIND, type FieldDef, type SourceKind } from "./fields.js";
import { MAX_ROWS, ImportError, columnLetter, type CellValue, type SheetData } from "./spreadsheet.js";

export type Mapping = Record<string, string>; // column header → canonical field

export interface RowError {
  field: string | null;
  ref: string | null;
  message: string;
}

export interface NormalizedRow {
  rowId: string;
  originalRow: number;
  cells: Record<string, { v: CellValue; ref: string }>;
  mapped: Record<string, string | number>;
  errors: RowError[];
}

export interface Normalized {
  headers: string[];
  rows: NormalizedRow[];
  errorCount: number;
  rowsSha256: string;
}

/** Header names of the chosen row (blank headers become "Column C"; duplicates get " (2)"). */
export function headersOf(sheet: SheetData, headerRow: number): string[] {
  const row = sheet.rows.find((r) => r.rowNumber === headerRow);
  if (!row) throw new ImportError("no_header", `Row ${headerRow} is empty or does not exist`);
  const seen = new Map<string, number>();
  return row.values.map((v, i) => {
    let name = v == null || String(v).trim() === "" ? `Column ${columnLetter(i)}` : String(v).trim();
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    return name;
  });
}

/** Problems with the mapping itself (unknown columns / fields, a field mapped twice, missing required fields). */
export function validateMapping(headers: string[], mapping: Mapping, kind: SourceKind): string[] {
  const problems: string[] = [];
  const used = new Map<string, string>();
  for (const [column, field] of Object.entries(mapping)) {
    if (!headers.includes(column)) problems.push(`Column not found: ${column}`);
    if (!FIELD_BY_NAME.has(field)) problems.push(`Unknown field: ${field}`);
    if (used.has(field)) problems.push(`Field ${field} is mapped from both "${used.get(field)}" and "${column}"`);
    used.set(field, column);
  }
  for (const req of REQUIRED_BY_KIND[kind]) {
    const options = Array.isArray(req) ? req : [req];
    if (!options.some((f) => used.has(f))) problems.push(`Map a column to ${options.join(" or ")}`);
  }
  return problems;
}

function toDate(v: CellValue): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v ?? "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s); // day/month/year (Israel / Europe)
  if (m) return iso(+m[3], +m[2], +m[1]);
  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Typed value of a mapped cell, or an error message. */
export function typedValue(def: FieldDef, v: CellValue): { value?: string | number; error?: string } {
  const text = v instanceof Date ? v.toISOString() : String(v ?? "").trim();
  switch (def.type) {
    case "string":
    case "code":
      return { value: text };
    case "number":
    case "integer": {
      const n = typeof v === "number" ? v : Number(text.replace(/\s/g, ""));
      if (!Number.isFinite(n)) return { error: `${def.label}: "${text}" is not a number` };
      if (def.type === "integer" && !Number.isInteger(n)) return { error: `${def.label}: "${text}" is not a whole number` };
      if (def.min != null && n < def.min) return { error: `${def.label}: ${n} is below ${def.min}` };
      if (def.max != null && n > def.max) return { error: `${def.label}: ${n} is above ${def.max}` };
      return { value: n };
    }
    case "date": {
      const d = toDate(v);
      return d ? { value: d } : { error: `${def.label}: "${text}" is not a date (use YYYY-MM-DD or DD/MM/YYYY)` };
    }
    case "enum": {
      const low = text.toLowerCase();
      if (def.values!.includes(low)) return { value: low };
      return { error: `${def.label}: "${text}" must be one of ${def.values!.join(", ")}` };
    }
  }
}

export function normalizeRows(
  sheet: SheetData,
  opts: { headerRow: number; mapping: Mapping; kind: SourceKind },
): Normalized {
  const headers = headersOf(sheet, opts.headerRow);
  const problems = validateMapping(headers, opts.mapping, opts.kind);
  if (problems.length) throw new ImportError("bad_mapping", problems.join("; "));

  const dataRows = sheet.rows.filter((r) => r.rowNumber > opts.headerRow);
  if (dataRows.length > MAX_ROWS) throw new ImportError("too_many_rows", `More than ${MAX_ROWS} rows`);
  const sheetPrefix = sheet.name ? `${sheet.name}!` : "";
  const columnIndex = new Map(headers.map((h, i) => [h, i]));
  const rows: NormalizedRow[] = [];
  const seenIds = new Map<string, number>();
  let errorCount = 0;

  for (const r of dataRows) {
    const cells: NormalizedRow["cells"] = {};
    headers.forEach((h, i) => {
      const v = r.values[i] ?? null;
      if (v !== null) cells[h] = { v, ref: `${sheetPrefix}${columnLetter(i)}${r.rowNumber}` };
    });
    if (!Object.keys(cells).length) continue;

    const mapped: NormalizedRow["mapped"] = {};
    const errors: RowError[] = [];
    for (const [column, field] of Object.entries(opts.mapping)) {
      const def = FIELD_BY_NAME.get(field)!;
      const i = columnIndex.get(column)!;
      const ref = `${sheetPrefix}${columnLetter(i)}${r.rowNumber}`;
      if (r.formulaColumns.includes(i)) {
        errors.push({ field, ref, message: `${def.label}: formula cell — export the sheet with values only` });
        continue;
      }
      const v = r.values[i] ?? null;
      if (v === null || String(v).trim() === "") continue;
      const t = typedValue(def, v);
      if (t.error) errors.push({ field, ref, message: t.error });
      else mapped[field] = t.value!;
    }
    for (const req of REQUIRED_BY_KIND[opts.kind]) {
      const options = Array.isArray(req) ? req : [req];
      if (!options.some((f) => mapped[f] !== undefined && mapped[f] !== "")) {
        errors.push({ field: options.join("|"), ref: `${sheetPrefix}row ${r.rowNumber}`, message: `Missing ${options.join(" or ")}` });
      }
    }
    if (typeof mapped.ageMinYears === "number" && typeof mapped.ageMaxYears === "number" && mapped.ageMinYears > mapped.ageMaxYears) {
      errors.push({ field: "ageMinYears", ref: `${sheetPrefix}row ${r.rowNumber}`, message: "Minimum age is above maximum age" });
    }
    const rowId = mapped.rowId !== undefined ? String(mapped.rowId) : `${sheet.name ?? "csv"}!${r.rowNumber}`;
    const firstRow = seenIds.get(rowId);
    if (firstRow !== undefined) {
      errors.push({ field: "rowId", ref: `${sheetPrefix}row ${r.rowNumber}`, message: `Row id "${rowId}" repeats row ${firstRow}` });
    } else seenIds.set(rowId, r.rowNumber);
    if (errors.length) errorCount += 1;
    rows.push({ rowId, originalRow: r.rowNumber, cells, mapped, errors });
  }

  const rowsSha256 = createHash("sha256")
    .update(JSON.stringify(rows.map((r) => [r.rowId, r.originalRow, r.mapped])))
    .digest("hex");
  return { headers, rows, errorCount, rowsSha256 };
}
