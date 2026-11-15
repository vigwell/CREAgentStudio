import { describe, expect, it } from "vitest";
import type { BlockDef, Catalog } from "../api/client";
import { addBlock, connect, issuesByNode, paletteFor, parseConditionValue, removeBlocks, upstreamOf, type Graph } from "./graph";

const decision: BlockDef = { type: "decision", kinds: ["cds", "voice"], label: "Decision", ports: ["yes", "no"], outputs: [], aiCapable: false };
const catalog = {
  blocks: [
    { type: "start", kinds: ["cds", "voice"], label: "Start", ports: ["out"], outputs: [], aiCapable: false, start: true },
    decision,
    { type: "book", kinds: ["voice"], label: "Book", ports: [], outputs: [], aiCapable: false, terminal: true },
  ],
  operators: [],
  mandatoryRules: [],
  optionalRules: [],
  outputCategories: [],
} as Catalog;

const g: Graph = {
  nodes: [
    { id: "start", type: "start", label: "S", position: { x: 0, y: 100 } },
    { id: "a", type: "decision", label: "A", position: { x: 0, y: 200 } },
    { id: "b", type: "final_synthesis", label: "B", position: { x: 0, y: 300 } },
  ],
  edges: [
    { id: "e1", from: "start", port: "out", to: "a" },
    { id: "e2", from: "a", port: "yes", to: "b" },
  ],
};

describe("agent graph helpers", () => {
  it("palette hides Start and blocks of the other kind", () => {
    expect(paletteFor(catalog, "cds").map((b) => b.type)).toEqual(["decision"]);
    expect(paletteFor(catalog, "voice").map((b) => b.type)).toEqual(["decision", "book"]);
  });

  it("adds a block with a fresh id below the others", () => {
    const r = addBlock(g, decision);
    expect(r.id).toBe("decision-1");
    expect(r.graph.nodes.at(-1)!.position!.y).toBe(440);
  });

  it("one exit per port: reconnecting replaces the old edge", () => {
    const next = connect(g, "a", "yes", "start");
    expect(next.edges.filter((e) => e.from === "a" && e.port === "yes")).toHaveLength(1);
    expect(next.edges.find((e) => e.from === "a")!.to).toBe("start");
    expect(connect(g, "a", "no", "a")).toBe(g);
  });

  it("removing a block drops its edges but never removes Start", () => {
    const next = removeBlocks(g, ["a", "start"]);
    expect(next.nodes.map((n) => n.id)).toEqual(["start", "b"]);
    expect(next.edges).toEqual([]);
  });

  it("upstream lists only blocks that run before", () => {
    expect(upstreamOf(g, "b").map((n) => n.id).sort()).toEqual(["a", "start"]);
    expect(upstreamOf(g, "start")).toEqual([]);
  });

  it("groups issues by block", () => {
    const m = issuesByNode([
      { code: "x", message: "1", nodeId: "a" },
      { code: "y", message: "2", nodeId: "a" },
      { code: "z", message: "3" },
    ]);
    expect(m.get("a")).toHaveLength(2);
    expect(m.size).toBe(1);
  });

  it("types condition values for the compiler", () => {
    expect(parseConditionValue("30", "number", "lt")).toBe(30);
    expect(parseConditionValue("true", "boolean", "eq")).toBe(true);
    expect(parseConditionValue("a, b", "code", "in")).toEqual(["a", "b"]);
    expect(parseConditionValue("x", "code", "exists")).toBeUndefined();
  });
});
