# CRE Agent Studio

One Studio for building, testing and approving CRE agents: clinical decision support (CDS) and voice scheduling. They share one core: sign-in, tenants, audit and the knowledge library.

## Layout

- `api/`: backend (Node.js, TypeScript, Fastify)
- `db/migrations/`: SQL Server migrations, applied in name order (`GO` separates batches)

## Setup

```bash
cp .env.example .env      # fill DB_USER / DB_PASSWORD
npm install
npm run migrate           # applies pending migrations to XCreAgents
npm test                  # unit tests, plus database tests when .env is present
npm run dev               # API on http://localhost:4000
```

Requires Node.js 20 or later.

## What is in place

- **Sign-in:** the API accepts the same CRE access tokens as CRE web (Entra External ID tenant `creenterprise`, API scope `access_as_user`). A token is checked for signature, issuer, audience, expiry and scope.
- **Tenants:** each Studio user belongs to one tenant. Row-level security in SQL Server filters every tenant table by `SESSION_CONTEXT('tenant_id')`, which the API sets per unit of work (`withTenant`). This means a missing `WHERE tenant_id = …` can't leak data.
- **Audit:** `studio.audit_log` is append-only (UPDATE and DELETE are rejected by a trigger).
- **Endpoints:** `GET /health` checks the database. `GET /me` returns the signed-in Studio user, or 401 (bad token) or 403 (no Studio access).

First-time users get access only through `AUTO_PROVISION_TENANT_ID`, which is for development. Leave it empty in production, where a Studio admin adds users.
