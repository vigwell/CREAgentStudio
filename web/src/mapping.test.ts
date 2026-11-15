import { describe, expect, it } from "vitest";
import { suggestMapping } from "./mapping";

describe("suggestMapping", () => {
  it("maps common English and Hebrew headers, each field once", () => {
    expect(suggestMapping(["Protocol", "Protocol name", "Indication code", "Min age", "Contrast", "Review"])).toEqual({
      Protocol: "protocolCode",
      "Protocol name": "protocolName",
      "Indication code": "conditionCode",
      "Min age": "ageMinYears",
      Review: "reviewDue",
    });
    expect(suggestMapping(["קוד פרוטוקול", "התוויה", "תוצאה", "מכשיר"])).toEqual({
      "קוד פרוטוקול": "protocolCode",
      התוויה: "indication",
      תוצאה: "result",
      מכשיר: "device",
    });
    expect(suggestMapping(["Device", "Scanner"])).toEqual({ Device: "device" });
  });
});
