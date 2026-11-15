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

- **Knowledge Library** (spec rev 7, sections 04–05): upload an XLSX/CSV
  (10 MB, 50 MB expanded, 10,000 rows; macro-enabled, encrypted, external links
  and embedded objects rejected; formulas never executed), choose sheet and
  header row, preview, map existing columns to canonical fields
  (`GET /knowledge/fields`), get row/cell-level errors with cell references.
  Each import is a new immutable revision (original file + checksum kept):
  draft → in review → approved by a different approver → withdrawn; an approved
  revision past its review date shows as expired. All steps are audited.

  | Endpoint | |
  |---|---|
  | `POST /knowledge/files` | multipart upload; returns fileId, sheets, sha256 |
  | `GET /knowledge/files/:id/preview?sheet=&headerRow=` | headers + first rows |
  | `GET/POST /knowledge/sources` | list (with latest revision) / create {kind, name, issuingOrg} |
  | `POST /knowledge/sources/:id/revisions` | {fileId, sheet, headerRow, mapping, scope, clinicalOwner, effectiveFrom, reviewDue} |
  | `GET /knowledge/revisions/:id?page=&pageSize=` | revision + rows |
  | `POST /knowledge/revisions/:id/submit · approve · return · withdraw` | approval flow (roles: author / approver) |

First-time users get access only through `AUTO_PROVISION_TENANT_ID`, which is for development. Leave it empty in production, where a Studio admin adds users.
