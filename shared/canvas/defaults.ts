import {
  CANVAS_BUSINESS_SCHEMA,
  CANVAS_PAYLOAD_VERSION,
  SIX_BOXES,
  type CanvasBody,
  type SixBox,
} from "./schema.js";

/** Injected clock (same shape as server `Clock`) — keeps output deterministic. */
export type Clock = () => Date;

/**
 * RFC-4122 row id for new canvas rows. Uses crypto.randomUUID when present
 * (Node ≥19, all modern browsers); Math.random fallback only for exotic
 * runtimes — ids are for dedup/diff identity, not security tokens.
 */
export function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function blankOutput(): CanvasBody["outputs"][number] {
  return { id: newId(), name: "", current: "", target: "", deadline: "", cs: "" };
}

export function blankBehavior(): CanvasBody["behaviors"][number] {
  return {
    id: newId(),
    actor: "",
    behavior: "",
    context: "",
    outputs: "",
    signal: "",
    freq: "",
  };
}

export function blankBox(box: SixBox): CanvasBody["boxes"][number] {
  return {
    id: newId(),
    box,
    condition: "",
    evidence: "",
    gap: "",
    priority: "",
    behavior_id: null,
    action: "",
    assignee_label: "",
  };
}

export function blankAction(): CanvasBody["actions"][number] {
  return {
    id: newId(),
    action: "",
    start: "",
    deadline: "",
    assignee_label: "",
    supporter_label: "",
    criteria: "",
    status: "Chưa bắt đầu",
    risk: "",
  };
}

export function blankPlanRow(
  layer: CanvasBody["plan"][number]["layer"] = "",
): CanvasBody["plan"][number] {
  return {
    id: newId(),
    date: "",
    layer,
    metric: "",
    baseline: "",
    target: "",
    source: "",
    collector: "",
    verifier: "",
  };
}

export function blankObserved(): CanvasBody["observed"][number] {
  return {
    id: newId(),
    date: "",
    layer: "",
    value: "",
    source: "",
    confidence: "",
    learning: "",
    decision: "",
    verifier: "",
  };
}

export function blankReview(
  checkpoint = "",
): CanvasBody["reviews"][number] {
  return {
    id: newId(),
    checkpoint,
    date: "",
    behavior_evidence: "",
    output_evidence: "",
    result_evidence: "",
    works: "",
    not_works: "",
    learning: "",
    verifier: "",
  };
}

/**
 * Empty canvas — mirrors blankState() in canvas-online/index.html:
 * 1 output, 2 behaviors, the six fixed boxes, 1 action, 3 plan rows
 * (BEHAVIOR/OUTPUT/RESULT), 1 observed row, 2 review checkpoints.
 */
export function blankCanvas(clock: Clock): CanvasBody {
  return {
    schema_version: CANVAS_PAYLOAD_VERSION,
    meta: {
      title: "",
      owner: "",
      stage: "DRAFT",
      mode: "GUIDED",
      updated: clock().toISOString().slice(0, 10),
      schema: CANVAS_BUSINESS_SCHEMA,
    },
    goal: { statement: "", context: "" },
    kr: { metric: "", current: "", target: "", deadline: "", cs: "" },
    outputs: [blankOutput()],
    solution: { direction: "", logic: "" },
    behaviors: [blankBehavior(), blankBehavior()],
    boxes: SIX_BOXES.map((box) => blankBox(box)),
    actions: [blankAction()],
    risks: "",
    plan: [blankPlanRow("BEHAVIOR"), blankPlanRow("OUTPUT"), blankPlanRow("RESULT")],
    observed: [blankObserved()],
    reviews: [blankReview("Sau 7 ngày"), blankReview("Sau 2–4 tuần")],
  };
}
