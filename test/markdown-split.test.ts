import { test } from "node:test";
import assert from "node:assert/strict";

// The splitter is browser code but pure; load it without a DOM by stubbing what it never touches here.
(globalThis as any).DOMParser ??= class {};
const { splitSections, looksLikeMarkdown } = await import("../web/src/markdown.js");

test("markdown: replies split at headings, never inside fences, plain text stays one section", () => {
  const md = ["Intro line.", "", "## What I found", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "```", "## not a heading", "```", "", "### Detail", "text", "## Recommendation", "Wait."].join("\n");
  const s = splitSections(md);
  assert.deepEqual(s.map((x) => [x.title, x.level]), [[null, 0], ["What I found", 2], ["Detail", 3], ["Recommendation", 2]]);
  assert.match(s[1].body, /## not a heading/, "heading-looking line inside a fence stays in the body");
  assert.equal(s[3].body.trim(), "Wait.");
  assert.deepEqual(splitSections("just a sentence"), [{ title: null, level: 0, body: "just a sentence\n" }]);
  assert.equal(looksLikeMarkdown("just a sentence"), false);
  assert.equal(looksLikeMarkdown("Pick **one** now"), true);
  assert.equal(looksLikeMarkdown("## Recommendation\nWait."), true);
  assert.equal(looksLikeMarkdown("- a\n- b"), true);
});
