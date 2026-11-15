/**
 * Canonical fields a spreadsheet column can be mapped to (spec rev 7, section 05,
 * "Mapped rows"). Only mapped fields take part in evaluation; every other column
 * is kept for display.
 */
export type FieldType = "string" | "code" | "number" | "integer" | "date" | "enum";

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  values?: readonly string[];
  min?: number;
  max?: number;
}

export const SOURCE_KINDS = ["device_protocol", "clinical_rule", "reference_document"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const FIELDS: readonly FieldDef[] = Object.freeze([
  { name: "rowId", label: "Row id", type: "code" },
  // Local protocol / procedure
  { name: "protocolCode", label: "Protocol code", type: "code" },
  { name: "protocolName", label: "Protocol name", type: "string" },
  { name: "procedureCode", label: "Procedure code", type: "code" },
  // Conditions
  { name: "conditionCode", label: "Condition / indication code", type: "code" },
  { name: "indication", label: "Indication", type: "string" },
  { name: "ageMinYears", label: "Minimum age (years)", type: "number", min: 0, max: 130 },
  { name: "ageMaxYears", label: "Maximum age (years)", type: "number", min: 0, max: 130 },
  { name: "sex", label: "Sex", type: "enum", values: ["female", "male", "any"] },
  // Scope
  { name: "site", label: "Site", type: "string" },
  { name: "department", label: "Department", type: "string" },
  { name: "modality", label: "Modality", type: "string" },
  { name: "device", label: "Device / device group", type: "string" },
  { name: "population", label: "Population", type: "string" },
  // Result and presentation
  { name: "result", label: "Result", type: "string" },
  { name: "label", label: "Label", type: "string" },
  { name: "explanation", label: "Explanation", type: "string" },
  { name: "severity", label: "Severity", type: "enum", values: ["info", "warning", "critical"] },
  // Validity
  { name: "validFrom", label: "Valid from", type: "date" },
  { name: "reviewDue", label: "Review due", type: "date" },
  // Guidance metadata (e.g. ACR-derived content, when supplied)
  { name: "issuingOrganization", label: "Issuing organization", type: "string" },
  { name: "edition", label: "Edition", type: "string" },
  { name: "topic", label: "Topic", type: "string" },
  { name: "variant", label: "Variant", type: "string" },
  { name: "rating", label: "Appropriateness rating (1-9)", type: "integer", min: 1, max: 9 },
  { name: "reference", label: "Original reference", type: "string" },
  { name: "notes", label: "Notes", type: "string" },
] satisfies FieldDef[]);

export const FIELD_BY_NAME: ReadonlyMap<string, FieldDef> = new Map(FIELDS.map((f) => [f.name, f]));

/**
 * Fields a row of each kind must have (structural validation only; clinical
 * approval is a separate step). Arrays inside the list mean "one of".
 */
export const REQUIRED_BY_KIND: Record<SourceKind, ReadonlyArray<string | readonly string[]>> = {
  device_protocol: ["protocolCode"],
  clinical_rule: [["conditionCode", "indication"], "result"],
  reference_document: [],
};
