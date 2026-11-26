/**
 * ACR-based decision support for testing (Medilis handoff, Vigen 22 Nov 2026,
 * second case study): builds one ACR rule table from the CT and MRI
 * catalogues as supplied (assets/acr; exact duplicate rows collapsed, a
 * Modality column added), imports it into the Knowledge Library and creates
 * the agent
 *   Start → ACR topic detection (AI) → ACR rule selection (AI) → Summary
 * with the supplied prompts and a frozen candidate, ready for test runs. The
 * two demo users author and approve it (TEST names make clear it is a test
 * setup, not a clinically approved catalogue). Safe to run again: existing
 * items are kept.
 *
 *   npm run seed:acr [-- ct.xlsx mri.xlsx]
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
import { DEFAULT_ACR_TOPIC_PROMPT } from "../src/runtime/acrPrompts.js";
import { ACR_MAPPING, ACR_SHEET, buildAcrTable } from "../src/knowledge/acrTable.js";

const TENANT = process.env.AUTO_PROVISION_TENANT_ID || "a6da57a3-bfe5-592d-a9a6-6c840a27d7a0";
const SOURCE = "TEST · ACR rules CT + MRI (Medilis)";
const AGENT = "TEST · ACR decision support (CT/MRI)";
const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "..", "assets", "acr");
const ctFile = path.resolve(process.argv[2] ?? path.join(assets, "acr_cds_table__ct.xlsx"));
const mriFile = path.resolve(process.argv[3] ?? path.join(assets, "acr_cds_table__mri.xlsx"));
const log = (...a: unknown[]) => console.log(...a);

for (const f of [ctFile, mriFile]) {
  if (!fs.existsSync(f)) {
    console.error(`ACR table not found: ${f}`);
    process.exit(1);
  }
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

  // ---------------------------------------------------------------- rule table
  log("Knowledge Library");
  const sources = await knowledge.listSources(author);
  const have = sources.find((s) => s.name === SOURCE);
  let revisionId: string;
  if (have?.latestRevision) {
    revisionId = have.latestRevision.id;
    log(`  = ${SOURCE} (exists, ${have.latestRevision.status})`);
  } else {
    const table = await buildAcrTable(fs.readFileSync(ctFile), fs.readFileSync(mriFile));
    for (const c of table.counts) {
      log(`  ${c.modality}: sheet "${c.sheet}", ${c.rows} rows, ${c.unique} unique${c.collapsed.length ? ` (${c.collapsed.length} exact duplicates collapsed: ${c.collapsed[0]}…${c.collapsed[c.collapsed.length - 1]})` : ""}`);
    }
    const src = have ?? (await knowledge.createSource(author, { kind: "clinical_rule", name: SOURCE, issuingOrg: "Medilis (ACR-based)" }));
    const up = await knowledge.uploadFile(author, "acr_cds_rules_ct_mri.xlsx", table.buffer);
    const rev = await knowledge.createRevision(author, src.id, {
      fileId: up.fileId,
      sheet: ACR_SHEET,
      headerRow: 1,
      // Requested exam, ratings, scores, alternative, contrast and system decision stay as columns: shown with each rule.
      mapping: ACR_MAPPING,
      scope: { modality: "CT, MRI" },
      clinicalOwner: "Medilis clinical team",
      effectiveFrom: "2026-11-22",
      reviewDue: "2027-11-22",
    });
    const counts = rev as unknown as { rowCount?: number; errorCount?: number };
    if (counts.errorCount) throw new Error(`${SOURCE}: ${counts.errorCount} rows have problems; check the files`);
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
      intendedUse: "Match a CT or MRI referral to the ACR-based rule catalogue and show the matching rules with their recommendation, for radiologist review.",
      scope: { department: "Radiology", modality: "CT, MRI" },
    });
    const P = (x: number, y: number) => ({ x, y });
    await agents.saveDraft(author, a.id, {
      version: 1,
      agentPrompt: {
        draftText:
          "Read the referral (with priors, labs and diagnoses when given), determine the ACR topic and the requested modality (CT or MRI), and rank the matching rules of that topic from the approved ACR-based catalogue with a short Hebrew explanation each, for the radiologist to review. Never choose a rule outside the catalogue.",
      },
      prohibitions: { optional: ["P09"], custom: [] },
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Referral", position: P(0, 160) },
          { id: "topic", type: "acr_topic_detection", label: "ACR topic", executionKind: "ai", knowledgeRevisionId: revisionId, prompt: { draftText: DEFAULT_ACR_TOPIC_PROMPT }, position: P(260, 160) },
          // Empty prompt: the built-in CT and MRI selection prompts (frozen with the version), chosen by the detected modality.
          { id: "rules", type: "acr_rule_selection", label: "ACR rules", executionKind: "ai", knowledgeRevisionId: revisionId, prompt: null, position: P(520, 160) },
          {
            id: "final",
            type: "final_synthesis",
            label: "Result",
            executionKind: "deterministic",
            prompt: { draftText: "List the matching rules or what needs review." },
            outputCategories: ["appropriateness_finding", "missing_data_notice"],
            position: P(780, 160),
          },
        ],
        edges: [
          { id: "e1", from: "start", port: "out", to: "topic" },
          { id: "e2", from: "topic", port: "out", to: "rules" },
          { id: "e3", from: "rules", port: "out", to: "final" },
        ],
      },
    } as never);
    const compiled = await agents.compileDraft(author, a.id);
    if (!compiled.ok) throw new Error(`${AGENT} does not compile: ${compiled.issues.map((i) => i.message).join("; ")}`);
    await agents.createCandidate(author, a.id);
    log(`  + ${AGENT} (candidate #1 frozen${config.AI_API_KEY ? `, AI model ${config.AI_DEPLOYMENT}` : ", AI not set up"})`);
  }
  log("Done. Open Agents → the ACR agent → Test runs, and enter the referral.");
} finally {
  await db.close();
}
