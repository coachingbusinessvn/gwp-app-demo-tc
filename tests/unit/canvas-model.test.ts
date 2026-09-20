import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanvasBody } from "../../shared/canvas/schema.js";
import { blankBody, sanitizeBody } from "../../web/canvas/model.js";

/**
 * Gate-review fix (phase 2): sanitizeBody must be LOSSLESS for canonical
 * bodies — the editor loads every server draft through it, so a coercion
 * that drops observed[].measurement or regenerates row ids silently
 * destroys evidence on the next autosave. The lossy adapter path remains
 * for explicitly imported legacy/editor shapes only.
 */

const canonical = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
) as CanvasBody;

function canonicalWithMeasurement(): CanvasBody {
  const body = JSON.parse(JSON.stringify(canonical)) as CanvasBody;
  body.observed = [
    {
      id: "11111111-2222-3333-4444-555555555555",
      date: "2026-09-10",
      layer: "OUTPUT",
      value: "78%",
      source: "báo cáo tuần",
      confidence: "HIGH",
      learning: "",
      decision: "",
      verifier: "",
      measurement: {
        metricId: "66666666-7777-8888-9999-000000000000",
        definitionRevision: 1,
        layer: "OUTPUT",
        date: "2026-09-10",
        value: 78,
        unit: "%",
        baseline: 65,
        target: 75,
      },
    },
  ];
  return body;
}

describe("sanitizeBody — canonical bodies are lossless", () => {
  it("passes observed[].measurement and every field through verbatim", () => {
    const src = canonicalWithMeasurement();
    const out = sanitizeBody(src, [], true);
    expect(out).toEqual(src);
    expect(out.observed[0].measurement).toEqual(
      src.observed[0].measurement,
    );
  });

  it("keeps row ids — even on content-empty rows", () => {
    const src = canonicalWithMeasurement();
    const emptyId = "99999999-8888-7777-6666-555555555555";
    src.observed.push({
      id: emptyId,
      date: "",
      layer: "",
      value: "",
      source: "",
      confidence: "",
      learning: "",
      decision: "",
      verifier: "",
    });
    const out = sanitizeBody(src, [], true);
    expect(out.observed.map((r: { id?: string }) => r.id)).toContain(emptyId);
  });

  it("returns a deep copy — mutating the result never touches the source", () => {
    const src = canonicalWithMeasurement();
    const out = sanitizeBody(src, [], true);
    out.observed[0].value = "MUTATED";
    out.meta.title = "MUTATED";
    expect(src.observed[0].value).not.toBe("MUTATED");
    expect(src.meta.title).not.toBe("MUTATED");
  });

  it("still unwraps a saved DTO envelope and keeps the canonical body intact", () => {
    const src = canonicalWithMeasurement();
    const out = sanitizeBody({ body: src } as unknown as CanvasBody, [], true);
    expect(out.observed[0].measurement).toBeTruthy();
  });
});

describe("sanitizeBody — untrusted versioned input is validated, not trusted", () => {
  it("a schema_version:1 payload with malformed boxes salvages by name — never resets", () => {
    const warnings: string[] = [];
    const src = canonicalWithMeasurement() as unknown as Record<string, unknown>;
    // Five boxes, one carrying data a wholesale reset would destroy.
    const boxes = (canonical.boxes as Array<Record<string, unknown>>).slice(0, 5).map((b) => ({
      ...b,
      condition: "KEEP-ME",
    }));
    src.boxes = boxes;
    const out = sanitizeBody(src, warnings);
    expect(out.boxes).toHaveLength(6);
    expect(out.boxes.filter((b: { condition?: string }) => b.condition === "KEEP-ME")).toHaveLength(5);
  });

  it("salvages a schema-shaped measurement through the coercing path", () => {
    const warnings: string[] = [];
    const src = canonicalWithMeasurement();
    const out = sanitizeBody(src, warnings);
    expect(out.observed[0].measurement).toEqual(
      src.observed[0].measurement,
    );
  });

  it("drops a malformed measurement with a warning instead of risking a 400 save", () => {
    const warnings: string[] = [];
    const src = canonicalWithMeasurement();
    (src.observed[0] as Record<string, unknown>).measurement = {
      metricId: "not-a-uuid",
      value: "abc",
    };
    const out = sanitizeBody(src, warnings);
    expect(out.observed[0].measurement).toBeUndefined();
    expect(warnings.some((w) => w.includes("measurement"))).toBe(true);
  });

  it("warns on unknown top-level keys that the strict server would reject", () => {
    const warnings: string[] = [];
    const src = canonicalWithMeasurement() as unknown as Record<string, unknown>;
    src.foreignField = { anything: true };
    const out = sanitizeBody(src, warnings);
    expect((out as Record<string, unknown>).foreignField).toBeUndefined();
    expect(warnings.some((w) => w.includes("foreignField"))).toBe(true);
  });

  it("warns on unknown row-level keys that would break the strict save", () => {
    const warnings: string[] = [];
    const src = canonicalWithMeasurement();
    (src.observed[0] as Record<string, unknown>).rogue = "x";
    const out = sanitizeBody(src, warnings);
    expect((out.observed[0] as Record<string, unknown>).rogue).toBeUndefined();
    expect(warnings.some((w) => w.includes("rogue"))).toBe(true);
  });

  it("drops non-object rows instead of letting them break rendering", () => {
    const warnings: string[] = [];
    const src = canonicalWithMeasurement() as unknown as Record<string, unknown>;
    (src.observed as unknown[]).push("not-a-row");
    const out = sanitizeBody(src, warnings);
    expect(out.observed.every((r: unknown) => r && typeof r === "object")).toBe(true);
  });
});

describe("sanitizeBody — legacy/editor shapes still coerce", () => {
  it("coerces a legacy row (no schema_version) and resolves aliases", () => {
    const warnings: string[] = [];
    const legacy = {
      meta: { title: "Legacy canvas" },
      actions: [{ owner: "Chị Hai", status: "doing" }],
    };
    const out = sanitizeBody(legacy as unknown as CanvasBody, warnings);
    expect(out.meta.title).toBe("Legacy canvas");
    expect(out.actions[0].assignee_label).toBe("Chị Hai");
    expect(out.schema_version).toBe(1);
  });

  it("blankBody round-trips through the trusted canonical path unchanged", () => {
    const b = blankBody();
    expect(sanitizeBody(b, [], true)).toEqual(b);
  });
});
