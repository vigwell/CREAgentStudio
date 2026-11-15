import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface CreIdentity {
  oid: string;
  email: string | null;
  name: string | null;
}

export interface CreTokenVerifierOptions {
  tenantId: string;
  audience: string;
  requiredScope: string;
  /** Injected in tests; defaults to the CIAM tenant's public keys. */
  keys?: JWTVerifyGetKey;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export function creIssuer(tenantId: string) {
  return `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0`;
}

export function creJwksUrl(tenantId: string) {
  return new URL(`https://${tenantId}.ciamlogin.com/${tenantId}/discovery/v2.0/keys`);
}

/** Validates CRE (Entra External ID) access tokens issued for the CRE API. */
export function createCreTokenVerifier(opts: CreTokenVerifierOptions) {
  const keys = opts.keys ?? createRemoteJWKSet(creJwksUrl(opts.tenantId));
  const issuer = creIssuer(opts.tenantId);

  return async function verify(token: string): Promise<CreIdentity> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer,
        audience: opts.audience,
        algorithms: ["RS256"],
        clockTolerance: 60,
      }));
    } catch (err) {
      throw new AuthError(`invalid token: ${(err as Error).name}`);
    }
    const scopes = String(payload.scp ?? "").split(" ");
    if (!scopes.includes(opts.requiredScope)) throw new AuthError("missing scope");
    const oid = typeof payload.oid === "string" ? payload.oid : null;
    if (!oid) throw new AuthError("missing oid");
    const email =
      typeof payload.preferred_username === "string"
        ? payload.preferred_username
        : typeof payload.email === "string"
          ? payload.email
          : null;
    const name = typeof payload.name === "string" ? payload.name : null;
    return { oid, email, name };
  };
}

export type CreTokenVerifier = ReturnType<typeof createCreTokenVerifier>;

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}
