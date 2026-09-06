import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalBroker, QuestionBroker } from "../src/orchestrator/approvals.js";

const q = [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }];

test("question broker: fails closed with nobody listening, and tells the agent to ask in prose", async () => {
  const b = new QuestionBroker();
  const d = await b.request(q);
  assert.equal(d.answered, false);
  assert.match(d.reason ?? "", /ask in prose/);
  assert.equal(b.pending().length, 0);
});

test("question broker: answered through the UI resolves the agent's tool call with the answers", async () => {
  const b = new QuestionBroker();
  const seen: string[] = [];
  b.on("pending", (r) => {
    seen.push(r.id);
    assert.equal(b.pending().length, 1);
    assert.ok(b.answer(r.id, { "Which?": "B" }));
  });
  const d = await b.request(q);
  assert.deepEqual(d, { answered: true, answers: { "Which?": "B" } });
  assert.equal(seen.length, 1);
  assert.equal(b.answer(seen[0], {}), false, "a resolved request cannot be answered twice");
});

test("question broker: dismiss and dismissAll deny with the reason; abort signal dismisses too", async () => {
  const b = new QuestionBroker();
  b.on("pending", (r) => b.dismiss(r.id, "not now"));
  const d = await b.request(q);
  assert.deepEqual(d, { answered: false, reason: "not now" });

  const b2 = new QuestionBroker();
  b2.on("pending", () => b2.dismissAll("Session closed."));
  assert.deepEqual(await b2.request(q), { answered: false, reason: "Session closed." });

  const b3 = new QuestionBroker();
  const ac = new AbortController();
  b3.on("pending", () => ac.abort());
  const d3 = await b3.request(q, ac.signal);
  assert.equal(d3.answered, false);
  assert.equal(b3.pending().length, 0);
});

test("approval broker: fails closed with nobody listening", async () => {
  const b = new ApprovalBroker();
  const d = await b.request({ toolName: "Bash", input: { command: "git push" }, command: "git push", match: { ruleId: "git-push", label: "push", why: "" } as any, cwd: "/" });
  assert.equal(d.approved, false);
});
