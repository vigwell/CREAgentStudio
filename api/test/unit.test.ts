import { describe, expect, it } from "vitest";
import { splitBatches, checksum } from "../src/db/migrate.js";
import { bearerToken } from "../src/auth/creToken.js";
import { loadConfig } from "../src/config.js";

describe("splitBatches", () => {
  it("splits on GO lines only", () => {
    const sql = "CREATE SCHEMA a;\nGO\nSELECT 'GO here';\n  go  \n-- only a comment\nGO\n";
    expect(splitBatches(sql)).toEqual(["CREATE SCHEMA a;", "SELECT 'GO here';"]);
  });
});

describe("checksum", () => {
  it("ignores CRLF vs LF", () => {
    expect(checksum("a\r\nb")).toBe(checksum("a\nb"));
  });
});

describe("bearerToken", () => {
  it("reads a bearer token", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer x")).toBe("x");
    expect(bearerToken("Basic x")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe("loadConfig", () => {
  it("names missing settings without printing values", () => {
    expect(() => loadConfig({ DB_PASSWORD: "s3cret" } as NodeJS.ProcessEnv)).toThrow(
      /DB_SERVER/,
    );
    try {
      loadConfig({ DB_PASSWORD: "s3cret" } as NodeJS.ProcessEnv);
    } catch (e) {
      expect(String(e)).not.toContain("s3cret");
    }
  });
});
