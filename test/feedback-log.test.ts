import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { appendFeedbackEntry, formatFeedbackFacts, normalizeTags, parseFeedbackLog, readFeedbackLog, serializeFeedbackLog, setFeedbackStale } from "../src/orchestrator/feedback-log.js";

test("feedback log: parse round-trips the on-disk format", () => {
  const text = [
    "# Feedback Log (Artifact F)",
    "",
    "intro text",
    "",
    "## 2026-01-02T03:04:05Z · #conventions #tests",
    "Put tests under tests/unit.",
    "Source: PR #1 review",
    "",
    "## 2026-02-03T04:05:06Z · #review #stale",
    "Maintainers dislike long PRs.",
    "",
    "## 2026-03-04T05:06:07Z",
    "No tags, no source, two",
    "lines.",
  ].join("\n");
  const { preamble, entries } = parseFeedbackLog(text);
  assert.match(preamble, /^# Feedback Log/);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { id: "2026-01-02T03:04:05Z", at: "2026-01-02T03:04:05Z", tags: ["conventions", "tests"], lesson: "Put tests under tests/unit.", source: "PR #1 review", stale: false });
  assert.equal(entries[1].stale, true);
  assert.deepEqual(entries[1].tags, ["review"]);
  assert.equal(entries[2].lesson, "No tags, no source, two\nlines.");
  assert.equal(entries[2].source, null);

  const again = parseFeedbackLog(serializeFeedbackLog(preamble, entries));
  assert.deepEqual(again.entries, entries);
  assert.equal(again.preamble, preamble);
});

test("feedback log: tag normalisation", () => {
  assert.deepEqual(normalizeTags("Conventions, #Tests  ci/cd stale"), ["conventions", "tests", "ci/cd"]);
  assert.deepEqual(normalizeTags(["Review Style", "review-style"]), ["review-style"]);
  assert.deepEqual(normalizeTags(undefined), []);
});

test("feedback log: append creates the file with a preamble, keeps order, flags stale", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mendophyte-fb-"));
  try {
    const empty = await readFeedbackLog(home);
    assert.equal(empty.exists, false);
    assert.deepEqual(formatFeedbackFacts(empty), ["- OBSERVED: no feedback log yet (Artifact F is created on the first entry)."]);

    const a = await appendFeedbackEntry(home, { lesson: "First lesson.", tags: "tests, Conventions", source: "PR #1" });
    assert.equal(a.log.exists, true);
    assert.equal(path.basename(a.log.path!), "F-feedback-log.md");
    const text = await readFile(a.log.path!, "utf8");
    assert.match(text, /^# Feedback Log \(Artifact F\)/);
    assert.match(text, /## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z · #tests #conventions\nFirst lesson\.\nSource: PR #1\n/);

    const b = await appendFeedbackEntry(home, { lesson: "Second lesson.", at: a.entry.at });
    assert.notEqual(b.entry.id, a.entry.id, "same-second appends get a unique id");
    assert.equal(b.log.entries.length, 2);
    assert.equal(b.log.entries[0].lesson, "First lesson.", "append-only: order preserved");

    const flagged = await setFeedbackStale(home, a.entry.id, true);
    assert.equal(flagged.entries[0].stale, true);
    assert.match(await readFile(a.log.path!, "utf8"), /#tests #conventions #stale/);
    const unflagged = await setFeedbackStale(home, a.entry.id, false);
    assert.equal(unflagged.entries[0].stale, false);
    await assert.rejects(setFeedbackStale(home, "nope", true), /no entry/);
    await assert.rejects(appendFeedbackEntry(home, { lesson: "  " }), /lesson is required/);

    // An existing differently-named log is picked up rather than shadowed.
    const home2 = await mkdtemp(path.join(os.tmpdir(), "mendophyte-fb2-"));
    await writeFile(path.join(home2, "feedback.md"), "## 2026-01-01T00:00:00Z · #x\nold lesson\n");
    const found = await readFeedbackLog(home2);
    assert.equal(path.basename(found.path!), "feedback.md");
    assert.equal(found.entries.length, 1);
    const facts = formatFeedbackFacts(found);
    assert.match(facts[0], /1 entry/);
    assert.match(facts[1], /\[x\]: old lesson/);
    await rm(home2, { recursive: true, force: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
