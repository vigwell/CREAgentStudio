# Deploying CRE Agent Studio

One Node.js server hosts both parts: the web app at `/` and the API under `/api`
(the same paths the web app uses in development). Nothing else is needed in
front of it.

## Requirements

- Node.js 20 or later (Azure App Service, Linux, Node 20 LTS works as is)
- Outbound access to:
  - Azure SQL `cresqlserver.database.windows.net` (database `XCreAgents`). Allow the
    App Service's outbound IPs in the SQL firewall.
  - The CRE sign-in endpoints (`creenterprise.ciamlogin.com`).
  - Azure AI Foundry (`cre-openai-service-resource.services.ai.azure.com`).

## Build

From the repository root:

```bash
npm ci              # installs both workspaces (api and web), including build tools
npm run build       # api → api/dist, web → web/dist
```

## Database

```bash
npm run migrate     # applies the pending SQL migrations in db/migrations to XCreAgents
```

It is safe to run on every deploy: migrations already applied are skipped, and
a migration that changed after it was applied stops the run.

## Start

```bash
npm start           # node api/dist/server.js, listens on PORT (default 4000)
```

- **Azure App Service:** set the startup command to `npm start`. App Service
  provides `PORT`.
- **Health check:** `GET /api/health` returns `{"status":"ok"}` when the database
  answers.

## Environment variables

Set these as App Service application settings, or in a `.env` file at the
repository root (never commit it). `.env.example` lists them all.

| Variable | Required | Value |
|---|---|---|
| `DB_SERVER` | yes | `cresqlserver.database.windows.net` |
| `DB_NAME` | yes | `XCreAgents` |
| `DB_USER` / `DB_PASSWORD` | yes | SQL login for XCreAgents |
| `CRE_TENANT_ID` | yes | `8b95a7b3-effb-4d96-a5c2-118fe047e71a` (CRE Entra External ID tenant) |
| `CRE_API_CLIENT_ID` | yes | `790433ef-9282-4ca5-91df-bbb9369bb43e` (CRE API; the token audience) |
| `CRE_REQUIRED_SCOPE` | no | `access_as_user` (default) |
| `AI_API_KEY` | for AI steps | Azure OpenAI key. Without it, AI steps show as "not set up" and runs stay deterministic. |
| `AI_ENDPOINT` | no | default `https://cre-openai-service-resource.services.ai.azure.com/openai/v1` |
| `AI_DEPLOYMENT` | no | default `CREAgentStudio__gpt-6.1-sol` |
| `AI_TIMEOUT_MS` | no | default `20000` |
| `AI_PRICE_INPUT_PER_MTOK` / `AI_PRICE_OUTPUT_PER_MTOK` | no | USD per million tokens, for the cost estimate on Monitoring |
| `AUTO_PROVISION_TENANT_ID` | test only | `a6da57a3-bfe5-592d-a9a6-6c840a27d7a0` (Medilis tenant). See "First users" below. |
| `LOG_LEVEL` | no | `info` (default) |
| `PORT` | no | provided by App Service; default `4000` |
| `WEB_DIR` | no | the built web app. Default: `web/dist` in this repository (when started with `npm start`; `npm run dev` keeps the API at `/` for Vite's proxy). |

## Sign-in: the Studio app registration

The web app signs in to the CRE tenant (`creenterprise`) with its own app
registration, **CRE AgentStudio** (client id `8936e09d-4506-41ba-b51e-63796364d70e`).
It asks for the CRE API scope
`api://790433ef-9282-4ca5-91df-bbb9369bb43e/access_as_user`, the same one as CRE web.
The API checks that the token is meant for that scope.

On that app registration:

- **Authentication → Single-page application → Redirect URIs:** add the Studio
  address, exactly as the browser shows it but without a path or trailing slash
  (`https://<studio-host>`), and `https://localhost:3000` for development. The page
  address is used as the redirect URI after login and after logout.
- **API permissions:** add the CRE API's delegated permission `access_as_user`
  and grant admin consent. Without it, sign-in fails with a consent or scope
  error.

## First users

The Studio has no users screen yet.

- **Test environment:** set `AUTO_PROVISION_TENANT_ID` to the Medilis tenant
  above. The first person who signs in becomes admin, and everyone after that
  becomes an author.
- **Change a role:** run
  `npm run set-role -- <email> <admin|author|approver|viewer>` from the
  repository root, with the same environment variables. The user must have
  signed in once first. Run it without arguments to list the users.
- **Production:** leave `AUTO_PROVISION_TENANT_ID` empty and add users with
  `set-role`.

## Updating

Pull the branch, then run `npm ci && npm run build && npm run migrate`, and
restart. The page `index.html` is never cached, so users get the new version
on their next page load.
