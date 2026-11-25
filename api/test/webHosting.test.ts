import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { AuthError } from "../src/auth/creToken.js";
import type { Db } from "../src/db/pool.js";

const db = { request: () => ({ query: async () => ({ recordset: [{ ok: 1 }] }) }) } as unknown as Db;
const verifyToken = async () => {
  throw new AuthError("bad token");
};

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-web-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id=root></div>");
  fs.writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log(1)");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("one server for the web app and the API (deployment)", () => {
  it("serves the API under /api", async () => {
    const app = buildApp({ db, verifyToken, logLevel: "silent", webDir: dir });
    expect((await app.inject("/api/health")).json()).toEqual({ status: "ok" });
    expect((await app.inject({ url: "/api/me", headers: { authorization: "Bearer x" } })).statusCode).toBe(401);
    // unknown API route: JSON 404, never the web page
    const missing = await app.inject("/api/nope");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "not_found" });
    await app.close();
  });

  it("serves the web app, its files, and its pages (e.g. /agents) as index.html", async () => {
    const app = buildApp({ db, verifyToken, logLevel: "silent", webDir: dir });
    const home = await app.inject("/");
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('id=root');
    expect(home.headers["cache-control"]).toBe("no-cache");
    const page = await app.inject("/agents/123");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    const asset = await app.inject("/assets/app-abc123.js");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect((await app.inject("/assets/missing.js")).statusCode).toBe(404);
    await app.close();
  });

  it("without the web app the API stays at / (development and tests)", async () => {
    const app = buildApp({ db, verifyToken, logLevel: "silent" });
    expect((await app.inject("/health")).json()).toEqual({ status: "ok" });
    expect((await app.inject("/api/health")).statusCode).toBe(404);
    const noBuild = buildApp({ db, verifyToken, logLevel: "silent", webDir: path.join(dir, "missing") });
    expect((await noBuild.inject("/health")).statusCode).toBe(200);
    await app.close();
    await noBuild.close();
  });
});
