import { describe, expect, it } from "vitest";
import { manualValues } from "./AgentRuns";

describe("manualValues", () => {
  it("sends only entered values, typed", () => {
    expect(manualValues({ indicationCode: " DEMO-A ", ageYears: "54", pregnant: "false", egfr: "", sex: "" })).toEqual({ indicationCode: "DEMO-A", ageYears: 54, pregnant: false });
  });
});
