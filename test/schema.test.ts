import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSION_STATE_JSON_SCHEMA, parseSessionState } from "../src/orchestrator/schema.js";

test("schema: minimal state still validates without triage", () => {
  const r = parseSessionState({ phase: 0, phase_complete: false, your_turn_items: [] });
  assert.ok(r.state);
  assert.equal(r.state!.triage, undefined);
});

test("schema: shallow and deep triage validate; criteria are constrained", () => {
  const shallow = parseSessionState({
    phase: 3,
    phase_complete: false,
    your_turn_items: [{ id: "choose", kind: "choose_candidate", prompt: "Pick one", blocks: "none" }],
    triage: {
      mode: "shallow",
      task_type: "bug",
      chosen: null,
      none_tractable: null,
      filtered_out: [{ title: "x", reason: "claimed" }],
      candidates: [{ id: "a", rank: 1, title: "A", source: "#1", reason: "r", scores: [{ criterion: "reproducibility", value: "positive", note: "" }] }],
    },
  });
  assert.ok(shallow.state, shallow.error);

  const deep = parseSessionState({
    phase: 3,
    phase_complete: true,
    your_turn_items: [],
    triage: {
      mode: "deep",
      task_type: "performance",
      chosen: {
        candidate_id: "a",
        root_cause_in_repo: "yes",
        reproducible_or_baseline: "not_yet",
        scope: "one_module",
        danger: "blast_radius",
        danger_reason: "hot path",
        doability: "conditional",
        doability_reason: "needs the benchmark harness",
        time_to_first_build: "slow",
        escalated_by_compatibility: true,
      },
      none_tractable: null,
      filtered_out: [],
      candidates: [{ id: "a", rank: 1, title: "A", source: "profile", reason: "r", scores: [{ criterion: "profiling_signal", value: "unobserved", note: "no profile yet" }] }],
    },
  });
  assert.ok(deep.state, deep.error);

  const bad = parseSessionState({
    phase: 3,
    phase_complete: false,
    your_turn_items: [],
    triage: { mode: "shallow", task_type: "bug", chosen: null, none_tractable: null, filtered_out: [], candidates: [{ id: "a", rank: 1, title: "A", source: "#1", reason: "r", scores: [{ criterion: "vibes", value: "positive", note: "" }] }] },
  });
  assert.ok(bad.error);
  assert.match(bad.error!, /criterion/);
});

test("schema: JSON schema is draft-07 and lists the triage criteria", () => {
  const s = JSON.stringify(SESSION_STATE_JSON_SCHEMA);
  assert.match(s, /draft-07/);
  assert.match(s, /"reproducibility"/);
  assert.match(s, /"blast_radius"/);
  assert.ok(!s.includes("propertyNames"), "no record-style schemas; arrays of objects only");
});
