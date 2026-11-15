import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import {
  ImportError,
  checkXlsxPackage,
  columnLetter,
  fileTypeOf,
  listXlsxSheets,
  readCsv,
  readXlsxSheet,
} from "../src/knowledge/spreadsheet.js";
import { headersOf, normalizeRows, validateMapping } from "../src/knowledge/normalize.js";

async function workbook(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const protocolSheet = (wb: ExcelJS.Workbook) => {
  const info = wb.addWorksheet("Info");
  info.addRow(["Hospital CT protocols — DEMO"]);
  const ws = wb.addWorksheet("CT 01");
  ws.addRow(["Local CT protocol list"]); // a title row above the header
  ws.addRow(["Protocol", "Name", "Indication code", "Min age", "Contrast", "Review"]);
  ws.addRow(["CT-HEAD-01", "Head without contrast", "DEMO-STROKE", 18, "No", new Date(Date.UTC(2027, 0, 31))]);
  ws.addRow(["CT-CHEST-02", "Chest with contrast", "DEMO-PE", "16", "Yes", "15/03/2027"]);
  ws.addRow([]);
  ws.addRow(["CT-ABD-03", "Abdomen", "DEMO-APP", "adult", "Yes", "2027-02-30"]);
  ws.addRow(["", "No protocol code", "DEMO-X", 40, "No", null]);
  ws.getCell("D7").value = { formula: "20+20", result: 40 } as ExcelJS.CellFormulaValue;
};

describe("file types and limits", () => {
  it("accepts .xlsx and .csv only", () => {
    expect(fileTypeOf("Protocols.XLSX")).toBe("xlsx");
    expect(fileTypeOf("a.csv")).toBe("csv");
    expect(() => fileTypeOf("a.xlsm")).toThrow(ImportError);
    expect(() => fileTypeOf("a.xls")).toThrow(/Only .xlsx and .csv/);
  });

  it("column letters", () => {
    expect([0, 25, 26, 51, 701].map(columnLetter)).toEqual(["A", "Z", "AA", "AZ", "ZZ"]);
  });

  it("rejects encrypted / legacy files (OLE header)", async () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)]);
    await expect(checkXlsxPackage(ole)).rejects.toMatchObject({ code: "encrypted" });
  });

  it("rejects macros, external links and embedded objects", async () => {
    const base = await workbook(protocolSheet);
    for (const [path, code] of [
      ["xl/vbaProject.bin", "executable_content"],
      ["xl/externalLinks/externalLink1.xml", "external_links"],
      ["xl/embeddings/oleObject1.bin", "executable_content"],
    ] as const) {
      const zip = await JSZip.loadAsync(base);
      zip.file(path, "x");
      const bad = await zip.generateAsync({ type: "nodebuffer" });
      await expect(checkXlsxPackage(bad)).rejects.toMatchObject({ code });
    }
  });

  it("rejects macro-enabled content types and non-zip files", async () => {
    const zip = await JSZip.loadAsync(await workbook(protocolSheet));
    const types = await zip.file("[Content_Types].xml")!.async("string");
    zip.file("[Content_Types].xml", types.replace("sheet.main+xml", "sheet.main.macroEnabled+xml"));
    await expect(checkXlsxPackage(await zip.generateAsync({ type: "nodebuffer" }))).rejects.toMatchObject({ code: "executable_content" });
    await expect(checkXlsxPackage(Buffer.from("hello"))).rejects.toMatchObject({ code: "not_xlsx" });
  });

  it("rejects files over 10 MB", async () => {
    await expect(checkXlsxPackage(Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: "too_large" });
    expect(() => readCsv(Buffer.alloc(10 * 1024 * 1024 + 1, 0x41))).toThrow(/10 MB/);
  });
});

describe("reading", () => {
  it("lists sheets and reads values; formulas are not executed", async () => {
    const buf = await workbook(protocolSheet);
    expect((await listXlsxSheets(buf)).map((s) => s.name)).toEqual(["Info", "CT 01"]);
    const sheet = await readXlsxSheet(buf, "CT 01");
    const r7 = sheet.rows.find((r) => r.rowNumber === 7)!;
    expect(r7.formulaColumns).toEqual([3]);
    expect(r7.values[3]).toBeNull();
    await expect(readXlsxSheet(buf, "Nope")).rejects.toMatchObject({ code: "no_sheet" });
  });

  it("CSV: BOM, semicolon delimiter, Hebrew, blank lines", () => {
    const csv = "﻿קוד;שם;תוצאה\nA1;ראש;מתאים\n\nA2;חזה;לבדיקה\n";
    const sheet = readCsv(Buffer.from(csv, "utf8"));
    expect(sheet.rows.map((r) => r.values)).toEqual([
      ["קוד", "שם", "תוצאה"],
      ["A1", "ראש", "מתאים"],
      ["A2", "חזה", "לבדיקה"],
    ]);
    expect(sheet.rows.map((r) => r.rowNumber)).toEqual([1, 2, 4]);
  });
});

describe("mapping and normalized rows", () => {
  it("headers from any row; blank and duplicate names made unique", async () => {
    const sheet = readCsv(Buffer.from("a,,a\n1,2,3\n"));
    expect(headersOf(sheet, 1)).toEqual(["a", "Column B", "a (2)"]);
    expect(() => headersOf(sheet, 5)).toThrow(/Row 5/);
  });

  it("mapping problems: unknown column / field, field twice, required fields per kind", () => {
    const h = ["Protocol", "Name", "Code"];
    expect(validateMapping(h, { Protocol: "protocolCode" }, "device_protocol")).toEqual([]);
    expect(validateMapping(h, { Nope: "protocolCode", Name: "bogus" }, "device_protocol")).toEqual([
      "Column not found: Nope",
      "Unknown field: bogus",
    ]);
    expect(validateMapping(h, { Protocol: "label", Name: "label" }, "device_protocol")).toEqual([
      'Field label is mapped from both "Protocol" and "Name"',
      "Map a column to protocolCode",
    ]);
    expect(validateMapping(h, { Code: "conditionCode" }, "clinical_rule")).toEqual(["Map a column to result"]);
    expect(validateMapping(h, {}, "reference_document")).toEqual([]);
  });

  it("typed values, cell references and row-level errors (the author's sheet stays as it is)", async () => {
    const sheet = await readXlsxSheet(await workbook(protocolSheet), "CT 01");
    const n = normalizeRows(sheet, {
      headerRow: 2,
      kind: "device_protocol",
      mapping: { Protocol: "protocolCode", Name: "protocolName", "Indication code": "conditionCode", "Min age": "ageMinYears", Review: "reviewDue" },
    });
    expect(n.headers).toEqual(["Protocol", "Name", "Indication code", "Min age", "Contrast", "Review"]);
    expect(n.rows.map((r) => r.originalRow)).toEqual([3, 4, 6, 7]); // empty row 5 skipped
    const byRow = new Map(n.rows.map((r) => [r.originalRow, r]));
    expect(byRow.get(3)!.mapped).toEqual({ protocolCode: "CT-HEAD-01", protocolName: "Head without contrast", conditionCode: "DEMO-STROKE", ageMinYears: 18, reviewDue: "2027-01-31" });
    expect(byRow.get(3)!.cells.Contrast).toEqual({ v: "No", ref: "CT 01!E3" }); // unmapped column kept for display
    expect(byRow.get(4)!.mapped.ageMinYears).toBe(16);
    expect(byRow.get(4)!.mapped.reviewDue).toBe("2027-03-15"); // DD/MM/YYYY
    expect(byRow.get(6)!.errors.map((e) => [e.ref, e.message])).toEqual([
      ["CT 01!D6", 'Minimum age (years): "adult" is not a number'],
      ["CT 01!F6", 'Review due: "2027-02-30" is not a date (use YYYY-MM-DD or DD/MM/YYYY)'],
    ]);
    const r7 = n.rows.find((r) => r.originalRow === 7)!;
    expect(r7.errors.map((e) => e.message)).toEqual([
      "Minimum age (years): formula cell — export the sheet with values only",
      "Missing protocolCode",
    ]);
    expect(n.errorCount).toBe(2);
    expect(n.rowsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("clinical rules need a condition or indication and a result; repeated row ids are reported", () => {
    const sheet = readCsv(Buffer.from("Id,Indication,Result,Rating\nR1,Headache,CT head,7\nR1,,CT chest,9\nR3,Trauma,,10\n"));
    const n = normalizeRows(sheet, {
      headerRow: 1,
      kind: "clinical_rule",
      mapping: { Id: "rowId", Indication: "indication", Result: "result", Rating: "rating" },
    });
    expect(n.rows[0].errors).toEqual([]);
    expect(n.rows[1].errors.map((e) => e.message)).toEqual(["Missing conditionCode or indication", 'Row id "R1" repeats row 2']);
    expect(n.rows[2].errors.map((e) => e.message)).toEqual(["Appropriateness rating (1-9): 10 is above 9", "Missing result"]);
  });

  it("a bad mapping is refused before any row is read", () => {
    const sheet = readCsv(Buffer.from("A,B\n1,2\n"));
    expect(() => normalizeRows(sheet, { headerRow: 1, kind: "device_protocol", mapping: { A: "label" } })).toThrow(/protocolCode/);
  });
});
