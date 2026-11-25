/**
 * Suggest a field for each column from its header (English or Hebrew), so the
 * author only corrects the mapping. Never maps two columns to one field.
 */
const HINTS: [RegExp, string][] = [
  [/^(row ?id|id|מזהה)$/i, "rowId"],
  [/protocol.*(code|id|no|num)|^protocol$|קוד פרוטוקול|מספר פרוטוקול|^פרוטוקול$/i, "protocolCode"],
  [/protocol.*name|שם פרוטוקול/i, "protocolName"],
  [/procedure|cpt|פרוצדורה/i, "procedureCode"],
  [/anath?omy|אנטומיה|איבר/i, "anatomy"],
  [/(indication|condition).*(code)|icd|קוד התוויה/i, "conditionCode"],
  [/indication|התוויה|condition/i, "indication"],
  [/(min|minimum).*age|age.*(min|from)|גיל מינימ/i, "ageMinYears"],
  [/(max|maximum).*age|age.*(max|to)|גיל מקסימ/i, "ageMaxYears"],
  [/^sex$|gender|מין/i, "sex"],
  [/^site$|אתר/i, "site"],
  [/department|מחלקה/i, "department"],
  [/modality|מודליות/i, "modality"],
  [/device|scanner|מכשיר/i, "device"],
  [/population|אוכלוסי/i, "population"],
  [/^result$|recommend|תוצאה|המלצה/i, "result"],
  [/^label$|תווית/i, "label"],
  [/explanation|rationale|הסבר/i, "explanation"],
  [/severity|חומרה/i, "severity"],
  [/valid ?from|effective|בתוקף מ/i, "validFrom"],
  [/review|בדיקה עד|מועד בדיקה/i, "reviewDue"],
  [/issuing|organi[sz]ation|ארגון/i, "issuingOrganization"],
  [/edition|מהדורה/i, "edition"],
  [/topic|נושא/i, "topic"],
  [/variant|וריאנט/i, "variant"],
  [/rating|appropriateness|דירוג/i, "rating"],
  [/reference|source|מקור|הפניה/i, "reference"],
  [/note|comment|הערה/i, "notes"],
];

export function suggestMapping(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const h of headers) {
    const hit = HINTS.find(([re, field]) => !used.has(field) && re.test(h.trim()));
    if (hit) {
      out[h] = hit[1];
      used.add(hit[1]);
    }
  }
  return out;
}
