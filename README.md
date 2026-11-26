# CRE Agent Studio

One Studio for building, testing and approving CRE agents: clinical decision support (CDS) and voice scheduling. They share one core: sign-in, tenants, audit and the knowledge library.

## Layout

- `web/`: Studio web app (React 18, TypeScript, Vite, Tailwind, i18next; English and Hebrew with RTL)
- `api/`: backend (Node.js, TypeScript, Fastify)
- `db/migrations/`: SQL Server migrations, applied in name order (`GO` separates batches)

## Setup

```bash
cp .env.example .env      # fill DB_USER / DB_PASSWORD
npm install
npm run migrate           # applies pending migrations to XCreAgents
npm run seed:demo         # optional: demo knowledge, profiles, agents and runs (DEMO ·)
npm run ai:check          # optional: one synthetic request to the AI deployment (needs AI_API_KEY)
npm test                  # unit tests, plus database tests when .env is present
npm run dev               # API on http://localhost:4000
npm run dev:web           # web app on https://localhost:3000 (/api → API)
```

Requires Node.js 20 or later.

Deploying (one server hosts the web app and the API): see [DEPLOY.md](DEPLOY.md).

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

- **Agents** (week 2): typed block graph per agent kind, compiled into a
  manifest (no layout, sorted keys, `sha256:` hash). The compiler checks
  structure (one Start, every branch ends in a terminal, no cycles or
  unreachable blocks), typed decisions, upstream-only bindings, approved
  knowledge of the right kind, approved clinic & exam profiles, the AI call
  budget (2), prompts, prohibitions, and for voice that booking only follows a
  verified, resolved, profiled, confirmed path.

  | Endpoint | |
  |---|---|
  | `GET /agents/catalog` | blocks, operators, locked and optional rules, output categories |
  | `GET/POST /agents` | list / create {kind, name, intendedUse, scope} |
  | `GET /agents/:id` · `PUT /agents/:id/draft` | load / save draft (409 `stale_draft` if the version moved) |
  | `POST /agents/:id/compile` | problems, preview, manifest hash |
  | `POST/GET /agents/:id/candidates` | freeze an immutable candidate / list |
  | `GET/POST /clinic-profiles` · `POST /clinic-profiles/:id/revisions · approve · withdraw` | clinic & exam profiles |

- **CDS runs** (week 3): a frozen candidate runs over an immutable input
  snapshot (stored apart from run metadata, hashed) and the exact knowledge
  revisions it binds. Ordinary blocks activate all successors, a decision only
  the chosen port; skipped branches never supply data. Missing, denied or
  stale values are unknown, never false: the run pauses (`awaiting_input`,
  `needs_input`) and names the missing fields. One matching row gives a
  finding with that row as evidence; several or none give `needs_review` and
  no default. A withdrawn or expired source blocks the run. Findings in a
  denied output category are dropped and recorded. Test values are entered
  manually and attributed to the user.

  | Endpoint | |
  |---|---|
  | `POST /runs` | `Idempotency-Key` required (428); same key + same body replays, different body 409 |
  | `GET /runs/:id` · `GET /agents/:id/runs` | result, findings with evidence, steps, reviews |
  | `POST /runs/:id/reviews` | acknowledge / dismiss / defer (reason) against the run's snapshot hash (409 if stale) |

- **Release** (week 4): saved test cases (patient values plus the expected
  result, findings and decision branches) run in memory on a frozen version;
  a version is approved only by someone other than its author, after a passing
  run of the current suite on its exact manifest hash, with every bound source
  still approved. Activation rechecks this in one transaction; one version is
  active per agent, activating an earlier approved version is the rollback, and
  withdrawal (with a reason) stops new runs. Clinical runs (no candidate given)
  use the active version. The Run Inspector lists runs and shows every step,
  the rule a decision evaluated and the value it saw.

  | Endpoint | |
  |---|---|
  | `GET/POST /agents/:id/test-cases` · `PUT/DELETE …/:testCaseId` | test cases (PUT checks the version) |
  | `GET /agents/:id/versions` | frozen versions with status and last test result |
  | `POST/GET /candidates/:id/tests` | run the suite / last result, per case and per problem |
  | `POST /candidates/:id/approve · activate · withdraw` | release lifecycle |
  | `GET /candidates/:id/diff?against=` | blocks, connections, instructions, prohibitions, knowledge changed |
  | `GET /runs?agentId=&outcome=&purpose=&caseRef=` | Run Inspector list |

- **AI steps** (week 5): Azure AI Foundry, OpenAI v1 Responses API
  (`AI_ENDPOINT`, `AI_API_KEY`, `AI_DEPLOYMENT`, default
  `CREAgentStudio__gpt-6.1-sol`). The key stays in the server `.env`; the
  browser never calls the model. At most the candidate's AI budget (2) calls
  per run, within a 30 s active budget; every call uses a strict JSON schema.
  - *Patient information, AI step*: reads the optional clinical note and
    fills only fields the entered values don't have. A value is kept only if
    the model quotes the note verbatim and the quote contains the value;
    entered values always win. Kept values feed decisions and lookups and are
    shown as "from the clinical note, by AI" with the quote.
  - *Final synthesis, AI step*: rewrites the policy-filtered findings as a
    short summary in the agent's language. It gets the platform rules and the
    denied categories, can't add findings, and a summary with a number that
    isn't in the findings is rejected. The findings stay the result.
  - The note and findings are sent as data (instructions inside them are
    ignored); no case reference or user id is sent. A timeout, error or
    rejected reply falls back to the deterministic summary with a step note;
    AI never fails a run. Each run stores per-call status, model, time and
    tokens (`aiCalls`); the audit records status and model only.
  - Runs no longer hold a database transaction during AI calls (prepare,
    run, then store; a concurrent request with the same key replays).
  - A frozen version with AI steps records the AI model (`aiModel` in the
    manifest, shown in the version diff). It runs AI only with that model;
    after a model change the AI steps are skipped with a note until a new
    version is tested and approved.
  - Release tests run the deterministic logic only, so approval evidence is
    reproducible; AI steps are exercised in test runs.
  - A step linked only to a Prompt Builder record (no text) isn't sent until
    Prompt Builder integration resolves the text.

- **MRI protocol workflow** (Medilis handoff, 22 Nov 2026, V2): two AI blocks
  bound to an approved protocol table. *Anatomy detection* sends the referral
  text and the table's anatomy list (pediatric values containing "ילדים" for a
  pediatric case: the `pediatric` input, else age under 18; adult otherwise) and
  accepts only a listed value. *Protocol selection* sends only the protocol names
  of that anatomy and accepts exactly one of them, with a short Hebrew
  explanation. Unknown anatomy, a value or name outside the list, two names, or
  no AI give an unresolved result for review, never a guess. The selected
  protocol is shown with its row (number, name, contrast, Tesla) and the model's
  raw answers are kept on the run. The V2 prompts are built in
  (`api/src/runtime/mriPrompts.ts`; anatomy prompt without the editorial
  preamble, selection prompt limited to one protocol) and can be edited per
  block. `npm run seed:mri` imports `assets/mri/protocolsnewlastversion.xlsx`
  (254 rows, 80 anatomy values) and creates a ready test agent.
- **Scanned referrals** (`POST /referrals/text`, button "Read a scanned
  referral" in Test runs): the PDF or image goes to CRE's protocol service
  (`UploadReferralFile`, then `ExtractReferralText` with the returned fileId,
  as CRE web does) with the signed-in user's CRE token; the text is put into
  the referral, visible and editable before the run. The Studio doesn't store
  the file, and logs counts only. `CRE_API_BASE_URL` (default: CRE production
  API management, the one CRE web uses).

- **Monitoring** (`GET /monitoring?days=&agentId=&purpose=`, page
  *Monitoring*): runs, results, run time (median, 95%), stops for missing data
  and the fields most often missing, policy blocks by rule, clinician reviews,
  AI calls by status and tokens, per agent and department. Counts only, no
  clinical content. Each run records its active time (`durationMs`). Set
  `AI_PRICE_INPUT_PER_MTOK` / `AI_PRICE_OUTPUT_PER_MTOK` to show an AI cost
  estimate. Alerts through CRE operations are not wired yet.

- **Voice scheduling is out of scope for now** (Medilis, 15 Nov 2026: booking
  goes through RADICAL's scheduling APIs and a separate Twilio agent). The web
  app hides the voice agent type, voice agents and Clinic & exam profiles; the
  code and API stay. Build the web app with `VITE_VOICE_AGENTS=true` to show
  them again.

First-time users get access only through `AUTO_PROVISION_TENANT_ID`, which is for development. Until the Studio has a users screen, set roles with `npm run set-role -- <email> <admin|author|approver|viewer>` (the user signs in once first; without arguments it lists the users; changes are audited). Leave it empty in production, where a Studio admin adds users. The Medilis tenant (migration 0005) is `a6da57a3-bfe5-592d-a9a6-6c840a27d7a0`: with that id, the first user who signs in becomes admin and later users authors.

## Web app

Sign-in uses the CRE account (same Entra External ID tenant and API scope as CRE web)
through Studio's own app registration "CRE AgentStudio" (`8936e09d-…`, see DEPLOY.md);
the dev server runs on `https://localhost:3000`, which must be one of its redirect URIs.
Screens (week 1): Knowledge Library list, new source, import wizard
(file → sheet and header row with preview → column mapping with suggestions →
owner, dates and scope) and the revision page (rows, cell-level problems,
submit / approve / return / withdraw by role; the author can't approve).

Screens (week 2): **Agents** list and new agent (CDS or voice scheduling, intended
use, department and devices); the **agent editor** — block palette for the agent
type, graph canvas (React Flow; one exit per port, Start can't be removed),
inspector (label, deterministic / AI step, Prompt Builder reference or draft
prompt, typed decision condition on an upstream field, approved knowledge
revision, approved clinic & exam profile, output categories), agent
instructions, prohibitions (locked platform rules, optional restrictions,
custom restrictions mapped to an output category and confirmed by a reviewer),
Save with the loaded draft version (a concurrent save is reported instead of
overwritten), Compile (problems per block, readable preview, manifest hash)
and Freeze candidate; **Clinic & exam profiles** (site, department, RIS
procedure, yes/no screening questions, horizon; new revision per change,
approved by a different user, withdraw).

Screens (week 3): **Test runs** per CDS agent — choose a candidate, case
reference and test values, run, then see the outcome, findings with observed
inputs and evidence links to the source rows, the step trace, and acknowledge /
dismiss / defer each finding.

## Design

Layout follows the Vaplio back-office system, in CRE colours:
- Shell: sidebar on desktop (expanded or collapsed with the handle or Ctrl/⌘ B,
  remembered), icon rail on tablet, menu drawer on phone; top bar with user,
  language, theme (system / light / dark) and sign out.
- Semantic colour tokens only (`bg-surface`, `text-ink-muted`, `bg-accent`, …),
  defined once in `web/src/index.css` for light and dark; accent = CRE green.
- Flat panels and tables; controls in a row share one 40 px height; wide tables
  scroll inside their panel and the page never scrolls sideways; status pills
  always carry words.
- Logical properties throughout, so Hebrew mirrors the layout.
- The agent graph is edited on tablet and desktop; on a phone it is read-only
  (review, compile, test runs).
- Languages: the Report Engine's five (English, French, Hebrew, Arabic,
  Spanish) in a dropdown; Hebrew and Arabic are right-to-left. Block names are
  translated; platform rule texts stay as approved.
- Loading without spinners: skeletons shaped like the page, a thin progress
  bar for background requests, a cache that opens visited pages instantly and
  refreshes them quietly, data and code warmed on link hover, the graph editor
  loaded on demand, and buttons that say what they are doing ("Saving…").
  Ctrl/⌘ S saves an agent.
