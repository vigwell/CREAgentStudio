/**
 * Safe reading of uploaded XLSX / CSV (spec rev 7, section 04 "Import and mapping"):
 * 10 MB file, 50 MB expanded, 10,000 rows in the selected sheet; macro-enabled,
 * encrypted, external links and embedded/executable content are rejected before
 * parsing; formulas are never executed (a formula cell is reported: export values).
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { parse as parseCsv } from "csv-parse/sync";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
export const MAX_ROWS = 10_000;

export class ImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export type FileType = "xlsx" | "csv";
/** A cell value as read: never a formula result. */
export type CellValue = string | number | boolean | Date | null;

export interface SheetRow {
  /** 1-based row number in the sheet / file. */
  rowNumber: number;
  /** Cell values by 0-based column. */
  values: CellValue[];
  /** Cells that held a formula (0-based columns). */
  formulaColumns: number[];
}

export interface SheetData {
  name: string | null;
  rows: SheetRow[];
}

export function fileTypeOf(filename: string): FileType {
  const ext = String(filename).toLowerCase().split(".").pop();
  if (ext === "xlsx") return "xlsx";
  if (ext === "csv") return "csv";
  throw new ImportError("unsupported_type", "Only .xlsx and .csv files are accepted");
}

const OLE_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Structural checks on the XLSX package before anything is parsed. */
export async function checkXlsxPackage(buf: Buffer): Promise<void> {
  if (buf.length > MAX_FILE_BYTES) throw new ImportError("too_large", "The file is larger than 10 MB");
  // Password-protected .xlsx files (and old .xls) are OLE compound files, not zip.
  if (buf.subarray(0, 8).equals(OLE_HEADER)) {
    throw new ImportError("encrypted", "Encrypted or legacy Excel files are not accepted; save as a normal .xlsx");
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf, { checkCRC32: false });
  } catch {
    throw new ImportError("not_xlsx", "The file is not a valid .xlsx workbook");
  }
  let expanded = 0;
  for (const entry of Object.values(zip.files)) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    expanded += size;
    const p = entry.name.toLowerCase();
    if (p.endsWith("vbaproject.bin") || p.includes("/activex/") || p.includes("/embeddings/")) {
      throw new ImportError("executable_content", "Workbooks with macros or embedded objects are not accepted");
    }
    if (p.includes("/externallinks/")) {
      throw new ImportError("external_links", "Workbooks with external links are not accepted; export values only");
    }
  }
  if (expanded > MAX_EXPANDED_BYTES) throw new ImportError("too_large", "The workbook expands to more than 50 MB");
  const types = await zip.file("[Content_Types].xml")?.async("string");
  if (!types) throw new ImportError("not_xlsx", "The file is not a valid .xlsx workbook");
  if (/macroEnabled/i.test(types)) {
    throw new ImportError("executable_content", "Macro-enabled workbooks are not accepted");
  }
}

function cellValue(v: ExcelJS.CellValue): { value: CellValue; formula: boolean } {
  if (v == null) return { value: null, formula: false };
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return { value: v, formula: false };
  if (v instanceof Date) return { value: v, formula: false };
  const o = v as unknown as Record<string, unknown>;
  if ("formula" in o || "sharedFormula" in o) return { value: null, formula: true };
  if (Array.isArray(o.richText)) {
    return { value: (o.richText as { text: string }[]).map((r) => r.text).join(""), formula: false };
  }
  if ("text" in o && typeof o.text === "string") return { value: o.text, formula: false };
  if ("error" in o) return { value: String(o.error), formula: false };
  return { value: String(v), formula: false };
}

export async function listXlsxSheets(buf: Buffer): Promise<{ name: string; rowCount: number }[]> {
  await checkXlsxPackage(buf);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => ({ name: ws.name, rowCount: ws.actualRowCount }));
}

export async function readXlsxSheet(buf: Buffer, sheetName: string): Promise<SheetData> {
  await checkXlsxPackage(buf);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new ImportError("no_sheet", `Sheet not found: ${sheetName}`);
  if (ws.actualRowCount > MAX_ROWS + 50) {
    throw new ImportError("too_many_rows", `The sheet has more than ${MAX_ROWS} rows`);
  }
  const rows: SheetRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values: CellValue[] = [];
    const formulaColumns: number[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const { value, formula } = cellValue(cell.value);
      values[col - 1] = value;
      if (formula) formulaColumns.push(col - 1);
    });
    for (let i = 0; i < values.length; i++) if (values[i] === undefined) values[i] = null;
    rows.push({ rowNumber, values, formulaColumns });
  });
  return { name: ws.name, rows };
}

function detectDelimiter(firstLine: string): string {
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

export function readCsv(buf: Buffer): SheetData {
  if (buf.length > MAX_FILE_BYTES) throw new ImportError("too_large", "The file is larger than 10 MB");
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes("\u0000")) throw new ImportError("not_csv", "The file is not a text CSV");
  const delimiter = detectDelimiter(text.split(/\r?\n/, 1)[0] ?? "");
  let records: string[][];
  try {
    records = parseCsv(text, { delimiter, relax_column_count: true, skip_empty_lines: false, bom: true });
  } catch (err) {
    throw new ImportError("bad_csv", `The CSV could not be read: ${(err as Error).message}`);
  }
  if (records.length > MAX_ROWS + 50) throw new ImportError("too_many_rows", `The file has more than ${MAX_ROWS} rows`);
  const rows: SheetRow[] = [];
  records.forEach((r, i) => {
    if (r.every((c) => String(c ?? "").trim() === "")) return;
    rows.push({ rowNumber: i + 1, values: r.map((c) => (String(c).trim() === "" ? null : String(c))), formulaColumns: [] });
  });
  return { name: null, rows };
}

/** Excel-style column letters (0 → A, 26 → AA). */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
