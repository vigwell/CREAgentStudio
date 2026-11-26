/**
 * One ACR rule table from the two catalogues of the Medilis handoff
 * (acr_cds_table__ct.xlsx, acr_cds_table__mri.xlsx; ACR_Setup.md):
 *
 * - First sheet of each workbook only (the service's parser reads only that
 *   one; the second, exam-normalization sheet is not used).
 * - Same 12 columns A–L in both; a Modality column (CT / MRI) is added, so the
 *   ACR steps can route by modality and keep the catalogues apart.
 * - Exact duplicate rows (MRI_ORBIT_001–028 occur twice with identical
 *   content) are collapsed to one; a repeated Rule ID with different content
 *   is rejected. The original workbooks stay unchanged.
 * - Cell text is kept exactly as written (internal spaces included).
 */
import ExcelJS from "exceljs";
import { ImportError, listXlsxSheets, readXlsxSheet, type CellValue } from "./spreadsheet.js";

export const ACR_SHEET = "ACR rules";
export const ACR_MODALITY_HEADER = "Modality";
/** Import mapping for the combined table (clinical rule): every other column is kept for display. */
export const ACR_MAPPING: Record<string, string> = {
  "Rule ID": "rowId",
  "ACR Topic": "topic",
  "ACR Variant / מצב קליני": "indication",
  "בדיקה מומלצת לפי ACR": "result",
  [ACR_MODALITY_HEADER]: "modality",
};

export interface AcrTableCounts {
  modality: "CT" | "MRI";
  sheet: string;
  rows: number;
  unique: number;
  collapsed: string[];
}

const text = (v: CellValue | undefined) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v));

async function readCatalogue(buf: Buffer, modality: "CT" | "MRI") {
  const [first] = await listXlsxSheets(buf);
  if (!first) throw new ImportError("no_sheet", `${modality}: the workbook has no sheet`);
  const sheet = await readXlsxSheet(buf, first.name);
  const [head, ...data] = sheet.rows;
  if (!head) throw new ImportError("no_header", `${modality}: the first sheet is empty`);
  const headers = head.values.map((v) => text(v).trim());
  const byId = new Map<string, string[]>();
  const collapsed: string[] = [];
  let rows = 0;
  for (const r of data) {
    if (r.formulaColumns.length) throw new ImportError("formula", `${modality} row ${r.rowNumber}: formula cell — export the sheet with values only`);
    const values = headers.map((_, i) => text(r.values[i]));
    const id = values[0].trim();
    if (!id) continue;
    rows += 1;
    const seen = byId.get(id);
    if (seen) {
      if (seen.join("\u0000") !== values.join("\u0000")) throw new ImportError("conflicting_duplicate", `${modality}: Rule ID ${id} repeats with different content`);
      collapsed.push(id);
      continue;
    }
    byId.set(id, values);
  }
  return { headers, rows: [...byId.values()], counts: { modality, sheet: first.name, rows, unique: byId.size, collapsed } satisfies AcrTableCounts };
}

/** The combined workbook (one sheet, CT rows then MRI rows) and what was read from each catalogue. */
export async function buildAcrTable(ct: Buffer, mri: Buffer): Promise<{ buffer: Buffer; counts: AcrTableCounts[] }> {
  const a = await readCatalogue(ct, "CT");
  const b = await readCatalogue(mri, "MRI");
  if (a.headers.join("|") !== b.headers.join("|")) throw new ImportError("headers", "The CT and MRI workbooks have different columns");
  for (const h of Object.keys(ACR_MAPPING)) {
    if (h !== ACR_MODALITY_HEADER && !a.headers.includes(h)) throw new ImportError("headers", `Column "${h}" not found`);
  }
  const ids = new Set(a.rows.map((r) => r[0].trim()));
  const clash = b.rows.find((r) => ids.has(r[0].trim()));
  if (clash) throw new ImportError("conflicting_duplicate", `Rule ID ${clash[0]} is in both catalogues`);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(ACR_SHEET);
  ws.addRow([...a.headers, ACR_MODALITY_HEADER]);
  const cells = (r: string[]) => r.map((v) => (v === "" ? null : v)); // empty stays empty, not ""
  for (const r of a.rows) ws.addRow([...cells(r), "CT"]);
  for (const r of b.rows) ws.addRow([...cells(r), "MRI"]);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, counts: [a.counts, b.counts] };
}
