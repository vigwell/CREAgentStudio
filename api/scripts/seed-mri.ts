/**
 * MRI protocol workflow for testing (Medilis handoff, Vigen 22 Nov 2026):
 * imports the V2 protocol table (protocolsnewlastversion.xlsx, 254 rows,
 * 80 anatomy values) into the Knowledge Library and creates the agent
 *   Start → Anatomy detection (AI) → Protocol selection (AI) → Summary
 * with the V2 prompts and a frozen candidate, ready for test runs with
 * referral text. The two demo users author and approve it (TEST names make
 * clear it is a test setup, not a clinically approved table). Safe to run
 * again: existing items are kept.
 *
 *   npm run seed:mri [-- path/to/protocolsnewlastversion.xlsx]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { withTenant } from "../src/db/tenant.js";
import type { StudioUser } from "../src/services/users.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { AgentService } from "../src/agents/service.js";
import { AI_PROVIDER } from "../src/runtime/aiClient.js";
import { DEFAULT_ANATOMY_PROMPT, DEFAULT_SELECTION_PROMPT } from "../src/runtime/mriPrompts.js";

const TENANT = process.env.AUTO_PROVISION_TENANT_ID || "a6da57a3-bfe5-592d-a9a6-6c840a27d7a0";
const SOURCE = "TEST · MRI protocols V2 (Medilis)";
const AGENT = "TEST · MRI protocol selection (V2)";
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(process.argv[2] ?? path.join(here, "..", "..", "assets", "mri", "protocolsnewlastversion.xlsx"));
const log = (...a: unknown[]) => console.log(...a);

if (!fs.existsSync(file)) {
  console.error(`Protocol table not found: ${file}`);
  process.exit(1);
}

const config = loadConfig();
const db = await createPool(config);
try {
  const users = await withTenant(db, TENANT, async (tx) => {
    const out: Record<string, StudioUser> = {};
    for (const [key, name, role] of [
      ["demo-author", "Dr. Demo Author", "author"],
      ["demo-approver", "Dr. Demo Approver", "approver"],
    ] as const) {
      let r = (await new sql.Request(tx).input("oid", key).query("SELECT id, role FROM studio.users WHERE cre_oid = @oid")).recordset[0];
      if (!r) {
        r = (
          await new sql.Request(tx)
            .input("t", sql.UniqueIdentifier, TENANT)
            .input("oid", key)
            .input("name", name)
            .input("role", role)
            .query("INSERT INTO studio.users (tenant_id, cre_oid, display_name, role) OUTPUT inserted.id, inserted.role VALUES (@t, @oid, @name, @role)")
        ).recordset[0];
      }
      out[key] = { id: String(r.id).toLowerCase(), tenantId: TENANT, email: null, displayName: name, role };
    }
    return out;
  });
  const author = users["demo-author"];
  const approver = users["demo-approver"];
  const knowledge = new KnowledgeService(db);
  const agents = new AgentService(db, config.AI_API_KEY ? { provider: AI_PROVIDER, deployment: config.AI_DEPLOYMENT } : null);

  // ---------------------------------------------------------------- protocol table
  log("Knowledge Library");
  const sources = await knowledge.listSources(author);
  const have = sources.find((s) => s.name === SOURCE);
  let revisionId: string;
  if (have?.latestRevision) {
    revisionId = have.latestRevision.id;
    log(`  = ${SOURCE} (exists, ${have.latestRevision.status})`);
  } else {
    const src = have ?? (await knowledge.createSource(author, { kind: "device_protocol", name: SOURCE, issuingOrg: "Medilis" }));
    const up = await knowledge.uploadFile(author, path.basename(file), fs.readFileSync(file));
    const rev = await knowledge.createRevision(author, src.id, {
      fileId: up.fileId,
      sheet: "Protocols",
      headerRow: 1,
      // domain, contrast and Tesla stay as columns: shown with the selected protocol.
      mapping: { anathomy: "anatomy", protocol_number: "protocolCode", protocol_name: "protocolName" },
      scope: { modality: "MRI" },
      clinicalOwner: "Medilis clinical team",
      effectiveFrom: "2026-11-22",
      reviewDue: "2027-11-22",
    });
    const counts = rev as unknown as { rowCount?: number; errorCount?: number };
    if (counts.errorCount) throw new Error(`${SOURCE}: ${counts.errorCount} rows have problems; check the file`);
    await knowledge.submit(author, rev.id);
    await knowledge.approve(approver, rev.id);
    revisionId = rev.id;
    log(`  + ${SOURCE} (approved, ${counts.rowCount ?? "?"} rows)`);
  }

  // ---------------------------------------------------------------- agent
  log("Agents");
  const existing = (await agents.list(author)).find((a) => a.name === AGENT);
  if (existing) log(`  = ${AGENT} (exists)`);
  else {
    const a = await agents.create(author, {
      kind: "cds",
      name: AGENT,
      intendedUse: "Suggest one MRI protocol from the local protocol table for a referral, with a short explanation, for radiologist review.",
      scope: { department: "Radiology", modality: "MRI" },
    });
    const P = (x: number, y: number) => ({ x, y });
    await agents.saveDraft(author, a.id, {
      version: 1,
      agentPrompt: {
        draftText:
          "Read the MRI referral, determine the anatomy from the approved protocol table and select one protocol of that anatomy with a short Hebrew explanation, for the radiologist to review. Never choose a protocol outside the table.",
      },
      prohibitions: { optional: ["P09"], custom: [] },
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Referral", position: P(0, 160) },
          { id: "anatomy", type: "anatomy_detection", label: "Anatomy", executionKind: "ai", knowledgeRevisionId: revisionId, prompt: { draftText: DEFAULT_ANATOMY_PROMPT }, position: P(260, 160) },
          { id: "protocol", type: "protocol_selection", label: "MRI protocol", executionKind: "ai", knowledgeRevisionId: revisionId, prompt: { draftText: DEFAULT_SELECTION_PROMPT }, position: P(520, 160) },
          {
            id: "final",
            type: "final_synthesis",
            label: "Result",
            executionKind: "deterministic",
            prompt: { draftText: "List the selected protocol or what needs review." },
            outputCategories: ["protocol_match", "missing_data_notice"],
            position: P(780, 160),
          },
        ],
        edges: [
          { id: "e1", from: "start", port: "out", to: "anatomy" },
          { id: "e2", from: "anatomy", port: "out", to: "protocol" },
          { id: "e3", from: "protocol", port: "out", to: "final" },
        ],
      },
    } as never);
    const compiled = await agents.compileDraft(author, a.id);
    if (!compiled.ok) throw new Error(`${AGENT} does not compile: ${compiled.issues.map((i) => i.message).join("; ")}`);
    await agents.createCandidate(author, a.id);
    log(`  + ${AGENT} (candidate #1 frozen${config.AI_API_KEY ? `, AI model ${config.AI_DEPLOYMENT}` : ", AI not set up"})`);
  }
  log("Done. Open Agents → the MRI agent → Test runs, and enter the referral text.");
} finally {
  await db.close();
}
