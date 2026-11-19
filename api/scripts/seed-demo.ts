/**
 * Demo data for trying the Studio (Medilis tenant): knowledge sources, clinic &
 * exam profiles, agents with frozen candidates, and a few test runs. Everything
 * uses non-clinical DEMO codes. Two demo users author and approve it, so the
 * independent-approval rules hold; a few items are left in review / draft for
 * you to approve yourself. Safe to run again (existing demo items are skipped).
 *
 *   npm run seed:demo
 */
import ExcelJS from "exceljs";
import sql from "mssql";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { withTenant } from "../src/db/tenant.js";
import type { StudioUser } from "../src/services/users.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { AgentService } from "../src/agents/service.js";
import { RunService } from "../src/runtime/service.js";
import { ReleaseService } from "../src/release/service.js";
import { AI_PROVIDER } from "../src/runtime/aiClient.js";

const TENANT = process.env.AUTO_PROVISION_TENANT_ID || "a6da57a3-bfe5-592d-a9a6-6c840a27d7a0";
const log = (...a: unknown[]) => console.log(...a);

async function xlsx(sheet: string, rows: (string | number | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const config = loadConfig();
const db = await createPool(config);
try {
  // ---------------------------------------------------------------- demo users
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
    const real = await new sql.Request(tx).query("SELECT display_name, email, role FROM studio.users WHERE cre_oid NOT LIKE 'demo-%'");
    log("Studio users in the tenant:", real.recordset.map((u: Record<string, unknown>) => `${u.display_name ?? u.email} (${u.role})`).join(", ") || "none yet");
    return out;
  });
  const author = users["demo-author"];
  const approver = users["demo-approver"];

  const knowledge = new KnowledgeService(db);
  // Versions with AI steps freeze the AI model in use (none when AI isn't set up).
  const agents = new AgentService(db, config.AI_API_KEY ? { provider: AI_PROVIDER, deployment: config.AI_DEPLOYMENT } : null);
  const runs = new RunService(db);

  // ---------------------------------------------------------------- knowledge
  const existing = await knowledge.listSources(author);
  const byName = new Map(existing.map((s) => [s.name, s]));

  async function source(
    name: string,
    kind: "device_protocol" | "clinical_rule" | "reference_document",
    issuingOrg: string,
    sheet: string,
    rows: (string | number | null)[][],
    mapping: Record<string, string>,
    finalState: "approved" | "in_review" | "draft",
    scope: Record<string, unknown> | null = null,
  ): Promise<string> {
    const have = byName.get(name);
    if (have?.latestRevision) {
      log(`  = ${name} (exists, ${have.latestRevision.status})`);
      return have.latestRevision.id;
    }
    const src = have ?? (await knowledge.createSource(author, { kind, name, issuingOrg }));
    const file = await knowledge.uploadFile(author, `${name}.xlsx`, await xlsx(sheet, rows));
    const rev = await knowledge.createRevision(author, src.id, {
      fileId: file.fileId,
      sheet,
      headerRow: 1,
      mapping,
      scope,
      clinicalOwner: "Dr. Demo Author",
      effectiveFrom: "2026-11-01",
      reviewDue: "2027-11-01",
    });
    if (finalState !== "draft") await knowledge.submit(author, rev.id);
    if (finalState === "approved") await knowledge.approve(approver, rev.id);
    log(`  + ${name} (${finalState})`);
    return rev.id;
  }

  log("Knowledge Library");
  const ctProtocols = await source(
    "DEMO · CT 01 protocols",
    "device_protocol",
    "Medilis (demo)",
    "CT 01",
    [
      ["Protocol", "Protocol name", "Indication code", "Min age", "Device", "Notes"],
      ["CT-HEAD-01", "Head without contrast", "DEMO-STROKE", 18, "CT-01", "Stroke pathway"],
      ["CT-CHEST-PE", "CT pulmonary angiography", "DEMO-PE", 18, "CT-01", "Contrast required"],
      ["CT-CHEST-PE-LD", "CTPA low dose", "DEMO-PE", 18, "CT-01", "Second matching row: shows 'needs review'"],
      ["CT-ABD-APP", "Abdomen and pelvis with contrast", "DEMO-APPENDICITIS", 12, "CT-01", null],
      ["CT-KUB-01", "Kidneys, ureters, bladder (no contrast)", "DEMO-KIDNEY-STONE", 18, "CT-01", null],
      ["CT-HEAD-PED", "Paediatric head", "DEMO-HEAD-TRAUMA", 0, "CT-01", "Children"],
    ],
    { Protocol: "protocolCode", "Protocol name": "protocolName", "Indication code": "conditionCode", "Min age": "ageMinYears", Device: "device", Notes: "notes" },
    "approved",
    { modality: "CT", devices: ["CT-01"] },
  );
  const contrastRules = await source(
    "DEMO · Contrast safety rules",
    "clinical_rule",
    "Medilis (demo)",
    "Rules",
    [
      ["Indication code", "Result", "Label", "Severity", "Explanation"],
      ["DEMO-PE", "contrast_check", "Check renal function before contrast", "warning", "Confirm a recent eGFR before iodinated contrast."],
      ["DEMO-APPENDICITIS", "contrast_check", "Check contrast allergy history", "warning", "Ask about previous reactions to contrast."],
      ["DEMO-STROKE", "no_contrast", "Non-contrast study first", "info", "Start without contrast."],
    ],
    { "Indication code": "conditionCode", Result: "result", Label: "label", Severity: "severity", Explanation: "explanation" },
    "approved",
  );
  const prepDoc = await source(
    "DEMO · CT patient preparation",
    "reference_document",
    "Radiology (demo)",
    "Instructions",
    [
      ["Topic", "Text"],
      ["Fasting", "Nothing to eat for 4 hours before a contrast scan."],
      ["Arrival", "Arrive 30 minutes early with your referral."],
      ["Medication", "Bring a list of your medications."],
    ],
    { Topic: "topic", Text: "notes" },
    "approved",
  );
  await source(
    "DEMO · MRI 02 protocols",
    "device_protocol",
    "Medilis (demo)",
    "MRI 02",
    [
      ["Protocol", "Protocol name", "Indication code"],
      ["MR-KNEE-01", "Knee routine", "DEMO-KNEE-PAIN"],
      ["MR-LSPINE-01", "Lumbar spine routine", "DEMO-BACK-PAIN"],
    ],
    { Protocol: "protocolCode", "Protocol name": "protocolName", "Indication code": "conditionCode" },
    "in_review",
  );
  void prepDoc;

  // ---------------------------------------------------------------- clinic & exam profiles
  log("Clinic & exam profiles");
  const profiles = await agents.listProfiles(author);
  const profileNamed = (n: string) => profiles.find((p) => p.name === n);
  let ctProfileId = profileNamed("DEMO · CT abdomen with contrast")?.id as string | undefined;
  if (!ctProfileId) {
    const p = await agents.createProfile(author, {
      name: "DEMO · CT abdomen with contrast",
      site: "Main campus",
      department: "Radiology",
      risProcedureCode: "DEMO-CT-ABD-C",
      horizonDays: 30,
      questions: [
        { id: "q1", text: "Are you or could you be pregnant?", answerType: "yes_no" },
        { id: "q2", text: "Have you had a reaction to contrast before?", answerType: "yes_no" },
        { id: "q3", text: "Do you have kidney disease?", answerType: "yes_no" },
      ],
    });
    await agents.approveProfile(approver, p.id);
    ctProfileId = p.id;
    log("  + DEMO · CT abdomen with contrast (approved)");
  } else log("  = DEMO · CT abdomen with contrast (exists)");
  if (!profileNamed("DEMO · MRI knee")) {
    await agents.createProfile(author, {
      name: "DEMO · MRI knee",
      site: "North clinic",
      department: "Radiology",
      risProcedureCode: "DEMO-MR-KNEE",
      horizonDays: 45,
      questions: [
        { id: "q1", text: "Do you have a pacemaker or other implant?", answerType: "yes_no" },
        { id: "q2", text: "Are you claustrophobic?", answerType: "yes_no" },
      ],
    });
    log("  + DEMO · MRI knee (draft: approve it yourself)");
  } else log("  = DEMO · MRI knee (exists)");

  // ---------------------------------------------------------------- agents
  log("Agents");
  const agentList = await agents.list(author);
  const P = (x: number, y: number) => ({ x, y });

  async function agent(
    name: string,
    kind: "cds" | "voice",
    intendedUse: string,
    scope: Record<string, unknown>,
    draft: { graph: { nodes: unknown[]; edges: unknown[] }; agentPrompt: { draftText: string }; prohibitions: { optional: string[]; custom: unknown[] } },
    freeze: boolean,
  ): Promise<{ id: string; candidateId: string | null; created: boolean }> {
    const have = agentList.find((a) => a.name === name);
    if (have) {
      const c = await agents.candidates(author, have.id!);
      log(`  = ${name} (exists)`);
      return { id: have.id!, candidateId: (c[0]?.id as string) ?? null, created: false };
    }
    const a = await agents.create(author, { kind, name, intendedUse, scope });
    await agents.saveDraft(author, a.id, { version: 1, ...draft } as never);
    const compiled = await agents.compileDraft(author, a.id);
    if (!compiled.ok) throw new Error(`${name} does not compile: ${compiled.issues.map((i) => i.message).join("; ")}`);
    let candidateId: string | null = null;
    if (freeze) candidateId = (await agents.createCandidate(author, a.id)).id;
    log(`  + ${name}${freeze ? " (candidate #1 frozen)" : ""}`);
    return { id: a.id, candidateId, created: true };
  }

  const referral = await agent(
    "DEMO · CT referral protocol check",
    "cds",
    "Match a CT referral to the local CT 01 protocol for radiologist review.",
    { department: "Radiology", devices: ["CT-01"] },
    {
      agentPrompt: { draftText: "Check CT referrals against the approved local protocol table and list the matching protocol with its source row for the radiologist to review." },
      prohibitions: { optional: ["P09", "P11"], custom: [] },
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Referral", position: P(0, 180) },
          { id: "patient", type: "patient_service", label: "Patient data", position: P(240, 180) },
          { id: "hasInd", type: "decision", label: "Indication present?", condition: { nodeId: "patient", field: "hasIndication", operator: "eq", value: true }, position: P(480, 180) },
          { id: "proto", type: "protocol_lookup", label: "CT 01 protocol", knowledgeRevisionId: ctProtocols, position: P(740, 60) },
          { id: "ask", type: "instruction", label: "Ask the referrer for an indication", position: P(740, 300) },
          { id: "final", type: "final_synthesis", label: "Review summary", executionKind: "ai", prompt: { draftText: "Summarise the matched protocol with its evidence for the radiologist." }, outputCategories: ["protocol_match", "safety_flag", "missing_data_notice"], position: P(1000, 180) },
        ],
        edges: [
          { id: "e1", from: "start", port: "out", to: "patient" },
          { id: "e2", from: "patient", port: "out", to: "hasInd" },
          { id: "e3", from: "hasInd", port: "yes", to: "proto" },
          { id: "e4", from: "hasInd", port: "no", to: "ask" },
          { id: "e5", from: "proto", port: "out", to: "final" },
          { id: "e6", from: "ask", port: "out", to: "final" },
        ],
      },
    },
    true,
  );

  const contrast = await agent(
    "DEMO · Contrast safety check",
    "cds",
    "Flag contrast safety points (renal function, allergy) for clinician review before a contrast CT.",
    { department: "Radiology" },
    {
      agentPrompt: { draftText: "Before a contrast CT, list the approved contrast safety points that apply, with their source rows, for the clinician to review." },
      prohibitions: { optional: ["P09"], custom: [] },
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Contrast request", position: P(0, 180) },
          { id: "patient", type: "patient_service", label: "Patient data", position: P(240, 180) },
          { id: "rules", type: "guidance_lookup", label: "Contrast safety rules", knowledgeRevisionId: contrastRules, position: P(480, 180) },
          { id: "lowEgfr", type: "decision", label: "eGFR below 30?", condition: { nodeId: "patient", field: "egfr", operator: "lt", value: 30 }, position: P(720, 180) },
          { id: "renal", type: "instruction", label: "Low eGFR: discuss contrast with the radiologist", position: P(960, 80) },
          { id: "final", type: "final_synthesis", label: "Safety summary", executionKind: "ai", prompt: { draftText: "List the safety points with their sources." }, outputCategories: ["appropriateness_finding", "safety_flag", "missing_data_notice"], position: P(1200, 180) },
        ],
        edges: [
          { id: "e1", from: "start", port: "out", to: "patient" },
          { id: "e2", from: "patient", port: "out", to: "rules" },
          { id: "e3", from: "rules", port: "out", to: "lowEgfr" },
          { id: "e4", from: "lowEgfr", port: "yes", to: "renal" },
          { id: "e5", from: "lowEgfr", port: "no", to: "final" },
          { id: "e6", from: "renal", port: "out", to: "final" },
        ],
      },
    },
    true,
  );

  await agent(
    "DEMO · CT outpatient scheduling (voice)",
    "voice",
    "Book CT abdomen appointments for verified callers with an open referral.",
    { department: "Radiology" },
    {
      agentPrompt: { draftText: "Schedule CT abdomen appointments for verified callers. Never give clinical advice; transfer to staff when unsure." },
      prohibitions: { optional: [], custom: [] },
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Incoming call", position: P(0, 180) },
          { id: "auth", type: "verify_authority", label: "Verify caller", position: P(220, 180) },
          { id: "order", type: "resolve_order", label: "Find the referral", position: P(440, 180) },
          { id: "profile", type: "clinic_profile", label: "CT abdomen clinic", clinicProfileId: ctProfileId, position: P(660, 180) },
          { id: "slots", type: "offer_slots", label: "Offer slots", position: P(880, 180) },
          { id: "confirm", type: "confirmation", label: "Read back", position: P(1100, 180) },
          { id: "book", type: "book", label: "Book", position: P(1320, 80) },
          { id: "staff", type: "transfer_staff", label: "Transfer to staff", position: P(1320, 300) },
        ],
        edges: [
          { id: "v1", from: "start", port: "out", to: "auth" },
          { id: "v2", from: "auth", port: "out", to: "order" },
          { id: "v3", from: "order", port: "out", to: "profile" },
          { id: "v4", from: "profile", port: "out", to: "slots" },
          { id: "v5", from: "slots", port: "out", to: "confirm" },
          { id: "v6", from: "confirm", port: "yes", to: "book" },
          { id: "v7", from: "confirm", port: "no", to: "staff" },
        ],
      },
    },
    false,
  );

  // ---------------------------------------------------------------- test runs
  if (referral.created && referral.candidateId) {
    log("Test runs (DEMO · CT referral protocol check)");
    const cases: [string, Record<string, unknown>][] = [
      ["DEMO-CASE-101", { indicationCode: "DEMO-STROKE", ageYears: 67, sex: "male" }],
      ["DEMO-CASE-102", { indicationCode: "DEMO-PE", ageYears: 52, sex: "female", egfr: 74 }],
      ["DEMO-CASE-103", { hasIndication: false, ageYears: 40 }],
      ["DEMO-CASE-104", { indicationCode: "DEMO-UNLISTED", ageYears: 30 }],
      ["DEMO-CASE-105", {}],
    ];
    for (const [caseRef, manualValues] of cases) {
      const r = await runs.start(author, `seed-${caseRef}`, { agentId: referral.id, candidateId: referral.candidateId, caseRef, inputs: { manualValues } });
      const d = await runs.get(author, r.runId);
      log(`  ${caseRef}: ${d.outcome}`);
    }
  }
  // ---------------------------------------------------------------- release
  const release = new ReleaseService(db);
  async function cases(agentId: string, list: { name: string; values: Record<string, unknown>; expected: Record<string, unknown> }[]) {
    const have = await release.listTestCases(author, agentId);
    for (const c of list) {
      if (have.some((h) => h.name === c.name)) continue;
      await release.createTestCase(author, agentId, { name: c.name, inputs: { manualValues: c.values }, expected: c.expected as never });
    }
  }
  log("Release");
  await cases(referral.id, [
    { name: "Stroke matches the head protocol", values: { indicationCode: "DEMO-STROKE", ageYears: 67 }, expected: { outcome: "findings", findingCodes: ["PROTOCOL_MATCH_REVIEW"], path: [{ nodeId: "hasInd", state: "completed", port: "yes" }] } },
    { name: "PE matches two rows: needs review", values: { indicationCode: "DEMO-PE", ageYears: 52 }, expected: { outcome: "needs_review", findingCodes: ["PROTOCOL_CONFLICT"] } },
    { name: "Unlisted indication: no default", values: { indicationCode: "DEMO-UNLISTED", ageYears: 30 }, expected: { outcome: "needs_review", findingCodes: ["PROTOCOL_NO_MATCH"] } },
    { name: "No indication: ask the referrer", values: { hasIndication: false }, expected: { outcome: "findings", findingCodes: ["INSTRUCTION"], path: [{ nodeId: "hasInd", state: "completed", port: "no" }] } },
    { name: "Nothing entered: waits for input", values: {}, expected: { outcome: "needs_input", path: [{ nodeId: "hasInd", state: "awaiting_input" }] } },
  ]);
  if (referral.candidateId) {
    const versions = await release.listCandidates(author, referral.id);
    const v1 = versions.find((v) => v.id === referral.candidateId);
    if (v1?.status === "candidate") {
      const t = await release.runTests(author, v1.id);
      log(`  referral check: tests ${t.passed ? "passed" : "FAILED"} (${t.caseCount})`);
      if (t.passed) {
        await release.approve(approver, v1.id);
        await release.activate(approver, v1.id);
        log("  referral check: version 1 approved and active");
      }
    } else log(`  referral check: version 1 is ${v1?.status}`);
  }
  await cases(contrast.id, [
    { name: "PE with low eGFR: renal flag", values: { indicationCode: "DEMO-PE", egfr: 25 }, expected: { outcome: "findings", findingCodes: ["GUIDANCE_MATCH_REVIEW", "INSTRUCTION"], path: [{ nodeId: "lowEgfr", state: "completed", port: "yes" }] } },
    { name: "PE without eGFR: waits for input", values: { indicationCode: "DEMO-PE" }, expected: { outcome: "needs_input", path: [{ nodeId: "lowEgfr", state: "awaiting_input" }] } },
  ]);
  if (contrast.candidateId) {
    const v = (await release.listCandidates(author, contrast.id)).find((x) => x.id === contrast.candidateId);
    if (v?.status === "candidate" && !v.lastTest) {
      const t = await release.runTests(author, v.id);
      log(`  contrast check: tests ${t.passed ? "passed" : "FAILED"}; left for you to approve and activate`);
    }
  }
  log("Done. Sign in and look for the items named DEMO ·");
} finally {
  await db.close();
}
