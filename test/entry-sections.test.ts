import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  buildAppendSystemPrompt,
  extractPersistentSections,
  loadPersistentSections,
} from "../src/orchestrator/entry-sections.js";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const promptDir = path.join(root, "prompts");

test("extracts exactly the three persistent sections from the real 00-entry.md", async () => {
  const entry = await readFile(path.join(promptDir, "00-entry.md"), "utf8");
  const { sections, combined } = extractPersistentSections(entry);

  assert.ok(sections["How This Splits Between Us"].startsWith("## How This Splits Between Us"));
  assert.ok(sections["Artifacts"].startsWith("## Artifacts"));
  assert.ok(sections["Standing Guardrails"].startsWith("## Standing Guardrails"));

  // Verbatim: a line from each section survives untouched.
  assert.ok(combined.includes("**Do not show me a diff until I've stated what I think the fix is.**"));
  assert.ok(combined.includes("**Artifact F — The Per-Project Feedback Log.**"));
  assert.ok(combined.includes("- A \"no\" is always an acceptable outcome"));

  // Not included: Phase 0 and the loading rules stay for the agent to read itself.
  assert.ok(!combined.includes("## Phase 0: Entry"));
  assert.ok(!combined.includes("## How These Files Load"));
  assert.ok(!combined.includes("Experience level."));

  // Each section's text is a contiguous substring of the source file
  // (line endings normalised, in case a checkout converted them).
  const lf = entry.replace(/\r\n/g, "\n");
  for (const s of Object.values(sections)) assert.ok(lf.includes(s));
});

test("fails loudly when a section is missing", () => {
  assert.throws(
    () => extractPersistentSections("# x\n\n## Artifacts\n\nstuff\n"),
    /missing the "## How This Splits Between Us"/
  );
});

test("append prompt names the on-disk locations and ends with the sections", async () => {
  const sections = await loadPersistentSections(promptDir);
  const text = buildAppendSystemPrompt(sections, {
    promptDir: "/p",
    artifactHome: "/a",
    repoDir: "/r",
  });
  assert.ok(text.includes("live in: /p"));
  assert.ok(text.includes("already chosen: /a"));
  assert.ok(text.includes("working directory: /r"));
  assert.ok(text.trimEnd().endsWith(sections.combined.trimEnd()));
});
