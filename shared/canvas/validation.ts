import {
  CanvasBodySchema,
  SIX_BOXES,
  type CanvasBody,
} from "./schema.js";

/** One validation finding. `severity:"error"` blocks; paths are dot-joined. */
export interface Issue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export type ValidationMode = "draft" | "publish";

const err = (code: string, path: string, message: string): Issue => ({
  severity: "error",
  code,
  path,
  message,
});

const ROW_LISTS = [
  "outputs",
  "behaviors",
  "boxes",
  "actions",
  "plan",
  "observed",
  "reviews",
] as const;

/** A real observed-evidence row: date, value, source, learning, decision,
 *  verifier all filled (spec §5.1 — "quan sát thực tế kèm ngày, nguồn trích
 *  dẫn, bài học, quyết định và người xác nhận"). A blank row is NOT evidence. */
function isCompleteObservation(o: CanvasBody["observed"][number]): boolean {
  return [o.date, o.value, o.source, o.learning, o.decision, o.verifier].every(
    (v) => v.trim() !== "",
  );
}

/**
 * Validate a canvas body.
 *
 * draft   — types, enum membership, list bounds, unique row ids and
 *           referential integrity (boxes[].behavior_id). Empty strings are
 *           fine; wrong types and dangling references are not.
 * publish — everything in draft plus business completeness: required
 *           narrative fields, 1–3 outputs, 2–5 behaviors, the full six-box
 *           set decided and linked, ≥1 action/plan/review row, and — when
 *           meta.stage is VALIDATED — at least one fully populated
 *           observed-evidence row.
 */
export function validateCanvas(body: unknown, mode: ValidationMode): Issue[] {
  const issues: Issue[] = [];

  const parsed = CanvasBodySchema.safeParse(body);
  if (!parsed.success) {
    for (const zi of parsed.error.issues) {
      issues.push(
        err("schema", zi.path.join("."), `Payload không đúng schema: ${zi.message}`),
      );
    }
    return issues;
  }
  const b = parsed.data;

  // ---- both modes: identity + references -------------------------------
  const seen = new Map<string, string>();
  for (const list of ROW_LISTS) {
    b[list].forEach((row, i) => {
      const prev = seen.get(row.id);
      if (prev) {
        issues.push(
          err(
            "duplicate_id",
            `${list}.${i}.id`,
            `Row id "${row.id}" trùng với ${prev} — dedup/diff dựa trên id ổn định.`,
          ),
        );
      } else {
        seen.set(row.id, `${list}.${i}.id`);
      }
    });
  }

  const behaviorIds = new Set(b.behaviors.map((x) => x.id));
  b.boxes.forEach((box, i) => {
    if (box.behavior_id === null) {
      if (mode === "publish") {
        issues.push(
          err(
            "unconfirmed_behavior",
            `boxes.${i}.behavior_id`,
            `Box "${box.box.split(" | ")[0]}" chưa gắn Lever Behavior — cần xác nhận trước khi publish.`,
          ),
        );
      }
    } else if (!behaviorIds.has(box.behavior_id)) {
      issues.push(
        err(
          "missing_reference",
          `boxes.${i}.behavior_id`,
          `behavior_id "${box.behavior_id}" không tồn tại trong behaviors[].id.`,
        ),
      );
    }
  });

  if (mode === "draft") return issues;

  // ---- publish: business completeness ----------------------------------
  const req = (path: string, v: string, message: string) => {
    if (v.trim() === "") issues.push(err("required", path, message));
  };

  req("meta.title", b.meta.title, "Publish cần tên canvas (meta.title).");
  req("goal.statement", b.goal.statement, "Publish cần Goal (goal.statement).");
  req("kr.metric", b.kr.metric, "Key Result cần chỉ số đo (kr.metric).");
  req("kr.current", b.kr.current, "Key Result cần mức hiện tại (kr.current).");
  req("kr.target", b.kr.target, "Key Result cần mục tiêu (kr.target).");
  req("kr.deadline", b.kr.deadline, "Key Result cần thời hạn (kr.deadline).");
  req("kr.cs", b.kr.cs, "Key Result cần tiêu chuẩn chất lượng / cách đo (kr.cs).");
  req(
    "solution.direction",
    b.solution.direction,
    "Publish cần Solution Direction (solution.direction).",
  );
  req(
    "solution.logic",
    b.solution.logic,
    "Publish cần logic chốt hướng (solution.logic).",
  );

  if (b.outputs.length < 1) {
    issues.push(
      err("output_count", "outputs", "Publish cần 1–3 Critical Outputs."),
    );
  }
  b.outputs.forEach((o, i) => {
    req(`outputs.${i}.name`, o.name, "Critical Output cần tên.");
    req(`outputs.${i}.current`, o.current, "Critical Output cần mức hiện tại.");
    req(`outputs.${i}.target`, o.target, "Critical Output cần mục tiêu.");
    req(`outputs.${i}.deadline`, o.deadline, "Critical Output cần thời hạn.");
    req(`outputs.${i}.cs`, o.cs, "Critical Output cần tiêu chuẩn chất lượng.");
  });

  if (b.behaviors.length < 2) {
    issues.push(
      err("behavior_count", "behaviors", "Publish cần 2–5 Lever Behaviors."),
    );
  }
  b.behaviors.forEach((x, i) => {
    req(`behaviors.${i}.actor`, x.actor, "Lever Behavior cần chủ thể.");
    req(`behaviors.${i}.behavior`, x.behavior, "Lever Behavior cần nội dung hành vi.");
  });

  const boxNames = b.boxes.map((x) => x.box);
  const isCanonicalSet =
    boxNames.length === SIX_BOXES.length &&
    SIX_BOXES.every((name) => boxNames.includes(name));
  if (!isCanonicalSet) {
    issues.push(
      err(
        "box_set",
        "boxes",
        "Publish cần đủ sáu box chuẩn (SIX_BOXES), mỗi box đúng một lần.",
      ),
    );
  }
  b.boxes.forEach((box, i) => {
    req(`boxes.${i}.condition`, box.condition, "Box cần điều kiện cần có.");
    req(`boxes.${i}.evidence`, box.evidence, "Box cần hiện trạng / bằng chứng.");
    req(`boxes.${i}.gap`, box.gap, "Box cần mức khoảng cách (gap).");
    req(`boxes.${i}.priority`, box.priority, "Box cần mức ưu tiên (priority).");
  });

  if (b.actions.length < 1) {
    issues.push(
      err("action_count", "actions", "Publish cần ít nhất 1 hành động thử nghiệm."),
    );
  }
  b.actions.forEach((a, i) => {
    req(`actions.${i}.action`, a.action, "Hành động cần nội dung.");
    req(`actions.${i}.assignee_label`, a.assignee_label, "Hành động cần owner (assignee_label).");
    req(`actions.${i}.criteria`, a.criteria, "Hành động cần tiêu chí thành công.");
  });

  if (b.plan.length < 1) {
    issues.push(
      err("plan_count", "plan", "Publish cần ít nhất 1 dòng Measurement Plan."),
    );
  }
  b.plan.forEach((p, i) => {
    req(`plan.${i}.layer`, p.layer, "Dòng plan cần tầng (BEHAVIOR/OUTPUT/RESULT).");
    req(`plan.${i}.metric`, p.metric, "Dòng plan cần chỉ số / tiêu chí.");
  });

  if (b.reviews.length < 1) {
    issues.push(
      err("review_count", "reviews", "Publish cần ít nhất 1 mốc review."),
    );
  }
  b.reviews.forEach((r, i) => {
    req(`reviews.${i}.checkpoint`, r.checkpoint, "Dòng review cần mốc (checkpoint).");
  });

  if (
    b.meta.stage === "VALIDATED" &&
    !b.observed.some(isCompleteObservation)
  ) {
    issues.push(
      err(
        "validated_requires_evidence",
        "observed",
        "Stage VALIDATED cần ít nhất một quan sát thực tế đủ ngày, giá trị, nguồn, bài học, quyết định và người xác nhận — dòng trống không tính.",
      ),
    );
  }

  return issues;
}
