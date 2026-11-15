import { describe, expect, it, beforeAll } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type KeyLike } from "jose";
import { createCreTokenVerifier, creIssuer, AuthError } from "../src/auth/creToken.js";

const TENANT = "8b95a7b3-effb-4d96-a5c2-118fe047e71a";
const AUD = "790433ef-9282-4ca5-91df-bbb9369bb43e";
let privateKey: KeyLike;
let verify: ReturnType<typeof createCreTokenVerifier>;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" };
  verify = createCreTokenVerifier({
    tenantId: TENANT,
    audience: AUD,
    requiredScope: "access_as_user",
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
});

function token(claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: string } = {}) {
  return new SignJWT({ scp: "access_as_user", oid: "oid-1", preferred_username: "a@b.com", name: "A", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? creIssuer(TENANT))
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(privateKey);
}

describe("CRE token verifier", () => {
  it("accepts a valid CRE token", async () => {
    expect(await verify(await token({}))).toEqual({ oid: "oid-1", email: "a@b.com", name: "A" });
  });
  it("rejects another audience", async () => {
    await expect(verify(await token({}, { aud: "other" }))).rejects.toBeInstanceOf(AuthError);
  });
  it("rejects another issuer", async () => {
    await expect(verify(await token({}, { iss: "https://evil/v2.0" }))).rejects.toBeInstanceOf(AuthError);
  });
  it("rejects an expired token", async () => {
    await expect(verify(await token({}, { exp: "-10m" }))).rejects.toThrow(/invalid token/);
  });
  it("rejects a token without the API scope", async () => {
    await expect(verify(await token({ scp: "User.Read" }))).rejects.toThrow(/missing scope/);
  });
  it("rejects a token without oid", async () => {
    await expect(verify(await token({ oid: undefined }))).rejects.toThrow(/missing oid/);
  });
});
