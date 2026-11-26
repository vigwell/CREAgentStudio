import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthError, type CreIdentity } from "../src/auth/creToken.js";
import type { Db } from "../src/db/pool.js";
import { createCreReferralClient, textOf } from "../src/runtime/creReferral.js";

const ok = (payload: unknown) => new Response(JSON.stringify({ success: true, payload }), { status: 200, headers: { "content-type": "application/json" } });

function fakeCre(replies: Record<string, () => Response>) {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: init.body });
    const path = new URL(url).pathname.split("/api/")[1];
    return replies[path]();
  }) as unknown as typeof fetch;
  return { calls, client: createCreReferralClient({ baseUrl: "https://cre.example/CreReportingMicroservice/", fetchImpl }) };
}

describe("CRE referral OCR client", () => {
  it("uploads the files as 'Files', then extracts with the returned fileId, with the user's token", async () => {
    const f = fakeCre({ "Protocol/UploadReferralFile": () => ok({ fileId: "F-1" }), "Protocol/ExtractReferralText": () => ok({ extractedText: "  כאב כתף ממושך  " }) });
    const r = await f.client.extractText("user-token", [{ name: "ref.pdf", data: Buffer.from("%PDF") }]);
    expect(r).toEqual({ fileId: "F-1", text: "כאב כתף ממושך" });
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://cre.example/CreReportingMicroservice/api/Protocol/UploadReferralFile",
      "https://cre.example/CreReportingMicroservice/api/Protocol/ExtractReferralText",
    ]);
    expect(f.calls.every((c) => c.auth === "Bearer user-token")).toBe(true);
    expect((f.calls[0].body as FormData).getAll("Files")).toHaveLength(1);
    expect(JSON.parse(String(f.calls[1].body))).toEqual({ fileId: "F-1" });
  });

  it("reads the text from a string or Pascal-case payload", () => {
    expect(textOf("abc")).toBe("abc");
    expect(textOf({ ExtractedText: "x" })).toBe("x");
    expect(textOf({ other: 1 })).toBeNull();
  });

  it("CRE errors become clear errors (refused, failed envelope, unreachable)", async () => {
    const refused = fakeCre({ "Protocol/UploadReferralFile": () => new Response("", { status: 401 }) });
    await expect(refused.client.extractText("t", [{ name: "a.png", data: Buffer.from("x") }])).rejects.toMatchObject({ code: "cre_auth" });
    const failed = fakeCre({
      "Protocol/UploadReferralFile": () => new Response(JSON.stringify({ Success: false, ErrorInfo: { Message: "Unsupported file" } }), { status: 200 }),
    });
    await expect(failed.client.extractText("t", [{ name: "a.png", data: Buffer.from("x") }])).rejects.toMatchObject({ code: "cre_ocr_failed", message: "CRE: Unsupported file" });
    const down = createCreReferralClient({ baseUrl: "https://cre.example", fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    await expect(down.extractText("t", [{ name: "a.png", data: Buffer.from("x") }])).rejects.toMatchObject({ code: "cre_unreachable" });
  });
});

describe("POST /referrals/text", () => {
  const db = { request: () => ({ query: async () => ({ recordset: [] }) }) } as unknown as Db;
  const verifyToken = async (token: string): Promise<CreIdentity> => {
    if (token !== "good") throw new AuthError("bad token");
    return { oid: "o1" } as CreIdentity;
  };

  it("needs a signed-in user", async () => {
    const app = buildApp({ db, verifyToken, logLevel: "silent" });
    const r = await app.inject({ method: "POST", url: "/referrals/text", headers: { authorization: "Bearer bad" } });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

});
