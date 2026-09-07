// End-to-end walkthrough of the built UI against the scripted fake session.
//
//   npm run build && npm run test:browser
//
// Starts its own server on a spare port with an isolated home directory,
// creates a throwaway git repository as the "clone", drives every panel
// with a real Chrome/Chromium/Edge, and writes screenshots to
// test/browser/shots/ (kept as CI artifacts, so Windows and Linux renders
// can be compared side by side). Exits non-zero if any step fails.
//
// Browser: set MENDOPHYTE_CHROME to an executable, or let it find one.
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const OUT = path.join(here, "shots");
const PORT = Number(process.env.MENDOPHYTE_TEST_PORT || 4399);
const WIN = process.platform === "win32";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function findChrome() {
  if (process.env.MENDOPHYTE_CHROME) return process.env.MENDOPHYTE_CHROME;
  const c = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : WIN
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  const hit = c.find((p) => p && existsSync(p));
  if (!hit) throw new Error(`No Chrome/Chromium/Edge found; set MENDOPHYTE_CHROME. Tried: ${c.join(", ")}`);
  return hit;
}

/** A small repository with enough history for the fragility overlay and a package.json for check detection. */
function makeFixture(base) {
  const repo = path.join(base, "demo-clone");
  mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "f@x", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "f@x" } });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "f@x");
  git("config", "user.name", "fixture");
  git("config", "commit.gpgsign", "false");
  const w = (rel, txt) => {
    const p = path.join(repo, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, txt);
  };
  w("README.md", "# demo-clone\n\nA fixture repository for Mendophyte's browser walkthrough.\n");
  w("LICENSE.md", "MIT\n");
  w("CHANGELOG.md", "# Changelog\n\n## 0.1.0\n- first\n");
  w("package.json", JSON.stringify({ name: "demo-clone", version: "0.1.0", private: true, scripts: { test: "node --test", build: "node -e 0", typecheck: "node -e 0" } }, null, 2) + "\n");
  w("examples/session-stores/README.md", "# session stores\n");
  w("scripts/gh.sh", "#!/bin/sh\necho gh\n");
  w(".github/workflows/ci.yml", "name: ci\non: [push]\njobs: {}\n");
  w(".claude/commands/label-issue.md", "label it\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  for (let i = 1; i <= 8; i++) {
    w("CHANGELOG.md", `# Changelog\n\n## 0.1.${i}\n- fix: entry ${i}\n`);
    if (i === 3) w("README.md", "# demo-clone\n\nUpdated.\n");
    git("add", "-A");
    git("commit", "-q", "-m", `chore: Update CHANGELOG.md (${i})`);
  }
  git("remote", "add", "origin", "https://github.com/anthropics/claude-agent-sdk-typescript.git");
  return repo;
}

async function waitFor(url, ms) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    if (Date.now() - t0 > ms) throw new Error(`server did not answer at ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const base = mkdtempSync(path.join(os.tmpdir(), "mendo-walk-"));
const home = path.join(base, "home");
mkdirSync(home);
const REPO = makeFixture(base);
const serverEnv = { ...process.env, MENDOPHYTE_FAKE_SESSION: "1", HOME: home, USERPROFILE: home, MENDOPHYTE_NO_OPEN: "1" };
const server = spawn(process.execPath, [path.join(root, "dist", "cli.js"), "--port", String(PORT), "--no-open"], { env: serverEnv, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const stopServer = async () => {
  try {
    await fetch(`http://localhost:${PORT}/api/shutdown`, { method: "POST" });
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 500));
  try {
    server.kill();
  } catch {
    /* gone */
  }
};

let failures = 0;
try {
  await waitFor(`http://localhost:${PORT}/api/health`, 30_000);
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name + ".png") }); };
  const step = async (label, fn) => {
    try {
      await fn();
      console.log("ok  ", label);
    } catch (e) {
      failures++;
      console.log("FAIL", label, "->", String(e.message).split("\n")[0]);
      await shot("fail-" + label.replace(/\W+/g, "-")).catch(() => {});
    }
  };

  await page.goto(`http://localhost:${PORT}/`);
  await step("app renders with default layout", async () => {
    await page.getByText("Session", { exact: true }).first().click();
    await page.getByText("Sessions", { exact: true }).waitFor({ timeout: 10000 });
    await page.getByText("live", { exact: true }).waitFor({ timeout: 5000 });
    for (const t of ["Progress", "Conversation", "Your turn", "Verification", "Diff"]) await page.getByText(t, { exact: true }).first().waitFor({ timeout: 3000 });
  });
  await shot("01-empty");

  await step("create a session", async () => {
    await page.getByPlaceholder("/home/me/src/some-project").fill(REPO);
    await page.getByRole("button", { name: "Start session" }).click();
    await page.getByText("How much experience do you have").first().waitFor({ timeout: 30000 });
  });
  await shot("02-first-question");

  await step("capability panel shows preflight", async () => {
    await page.getByText("Capability", { exact: true }).first().click();
    await page.getByText(/full forge access|partial access|local clone only/).first().waitFor({ timeout: 10000 });
  });
  await shot("03-capability");

  await step("answer question via your-turn panel", async () => {
    await page.getByPlaceholder("Your answer, in your own words").first().fill("Experienced");
    await page.getByRole("button", { name: "Submit" }).first().click();
    await page.getByText("What do you want to do here?").first().waitFor({ timeout: 15000 });
  });
  await step("answer the agent's question card", async () => {
    await page.getByText("the agent asks").waitFor({ timeout: 15000 });
    await page.getByText("Find me something", { exact: true }).click();
    await page.getByRole("button", { name: "Send answers" }).click();
    await page.getByText("Session type: Find me something").first().waitFor({ timeout: 15000 });
    await page.getByText("choose a candidate").first().waitFor({ timeout: 15000 });
  });
  await step("rich reply renders headings as boxes and a table", async () => {
    await page.getByText("Conversation", { exact: true }).first().click();
    await page.locator(".sec-title", { hasText: "Recommendation" }).waitFor({ timeout: 5000 });
    await page.locator(".prose table").first().waitFor();
  });
  await shot("03b-rich-reply");
  await step("progress tree: bud connectors start after the labels", async () => {
    await page.getByText("Progress", { exact: true }).first().click();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);
    const overlap = await page.evaluate(() => {
      const svg = document.querySelector(".spine svg");
      const labels = Array.from(svg.querySelectorAll("text.label")).map((t) => t.getBoundingClientRect());
      const buds = Array.from(svg.querySelectorAll("circle.bud")).map((c) => c.getBoundingClientRect());
      return buds.filter((b) => labels.some((l) => b.left < l.right && b.right > l.left && b.top < l.bottom && b.bottom > l.top)).length;
    });
    if (overlap) throw new Error(`${overlap} bud(s) overlap a label`);
  });
  await shot("03c-spine");
  await step("triage board shows ranked cards with criteria chips and a matrix", async () => {
    await page.getByText("Triage", { exact: true }).first().click();
    await page.getByText("Triage · shallow pass").waitFor({ timeout: 5000 });
    await page.locator(".tri-card").getByText("Lexer mis-tokenises astral-plane code points").first().waitFor();
    await page.getByText("Filtered out (2)").waitFor();
    await page.getByText("matrix view").click();
    await page.locator(".tri-matrix td.cell.unobs").first().waitFor({ timeout: 3000 });
    await shot("04a-triage-matrix");
    await page.getByText("card view").click();
  });
  await step("choosing a candidate yields the deep-pass card with the danger gauge", async () => {
    await page.getByRole("button", { name: "Take this into the deep pass" }).first().click();
    await page.getByText("Triage · deep pass").waitFor({ timeout: 15000 });
    await page.locator(".gauge-seg.now").waitFor();
    await page.getByText("Your turn", { exact: true }).first().click();
    await page.getByText("state your hypothesis").first().waitFor({ timeout: 15000 });
  });
  await shot("04b-triage-deep");
  await step("diff panel is locked while hypothesis pending", async () => {
    await page.getByText("The diff stays hidden until it").waitFor({ timeout: 5000 });
  });
  await step("hypothesis answer triggers guardrail modal", async () => {
    await page.getByPlaceholder("Your answer, in your own words").first().fill("In the lexer's code point iteration, it indexes UTF-16 units.");
    await page.getByRole("button", { name: "Submit" }).first().click();
    await page.getByRole("dialog").waitFor({ timeout: 15000 });
    await page.getByText("Create a git commit").waitFor();
  });
  await shot("05-approval-modal");
  await step("decline with reason reaches the agent", async () => {
    await page.getByPlaceholder("e.g. not until the test is written").fill("write the regression test first");
    await page.getByRole("button", { name: "Decline" }).click();
    await page.getByText("won't run").first().waitFor({ timeout: 10000 });
    await page.getByText("write the failing test").first().waitFor({ timeout: 10000 });
  });
  await step("diff unlocked after hypothesis consumed", async () => {
    if (await page.getByText("The diff stays hidden").count()) throw new Error("still locked");
  });
  await shot("06-after-decline");
  await step("spine shows phase 4", async () => {
    await page.getByText("In phase 4.").waitFor({ timeout: 5000 });
  });
  await step("verification panel detect + run via UI", async () => {
    await page.getByText("Verification", { exact: true }).first().click();
    await page.getByRole("button", { name: "Detect project checks" }).click();
    await page.getByText(/npm test|No candidate checks found/).first().waitFor({ timeout: 15000 });
  });
  await shot("07-verification-detected");
  await step("files panel lists repo and overlays fragility", async () => {
    await page.getByText("Files", { exact: true }).first().click();
    await page.getByPlaceholder("filter paths").waitFor({ timeout: 5000 });
    await page.getByText("CHANGELOG.md", { exact: true }).first().waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Show fragility" }).click();
    await page.getByRole("button", { name: "Recompute heat" }).waitFor({ timeout: 30000 });
    await page.getByPlaceholder("filter paths").fill("README");
    await page.getByText("README.md", { exact: true }).first().click();
    await page.getByText(/lines · \d+ bytes/).first().waitFor({ timeout: 5000 });
  });
  await shot("07b-files-and-viewer");
  await step("artifacts panel shows live-written artifacts", async () => {
    await page.getByText("Artifacts", { exact: true }).first().click();
    await page.getByText("Recon Notes", { exact: true }).first().waitFor({ timeout: 10000 });
    await page.getByRole("heading", { name: "Recon Notes (Artifact A)" }).waitFor({ timeout: 5000 });
    await page.getByText("Glossary", { exact: true }).first().click();
    await page.getByText("astral plane").first().waitFor({ timeout: 5000 });
    await page.getByPlaceholder("find in this artifact").fill("churn");
    await page.locator("mark").first().waitFor({ timeout: 3000 });
  });
  await shot("07c-artifacts");
  await step("terminal panel runs a command in the clone", async () => {
    await page.getByText(/^Terminal( · .*)?$/).first().click();
    await page.getByText("live", { exact: true }).nth(1).waitFor({ timeout: 20000 });
    await page.locator(".term-host .xterm-helper-textarea").first().focus();
    await page.keyboard.type(WIN ? "echo hello-pty\r" : "printf hello-%s pty; echo; pwd\n");
    await page.getByText(/hello-pty/).first().waitFor({ timeout: 15000 });
    if (!WIN) await page.getByText(/demo-clone/).first().waitFor({ timeout: 5000 });
  });
  await shot("07d-terminal");
  await step("submission panel shows observed PR absence, CI source and sync", async () => {
    await page.getByText("Submission", { exact: true }).first().click();
    await page.getByText(/no pull request for/).waitFor({ timeout: 30000 });
    await page.getByText(/observed via/).waitFor();
    await page.getByText("Branch sync").waitFor();
  });
  await shot("07e-submission");
  await step("feedback log: add, search, tag filter, flag stale", async () => {
    await page.getByText("Feedback log", { exact: true }).first().click();
    await page.getByPlaceholder("search lessons, sources, tags").waitFor({ timeout: 5000 });
    await page.getByPlaceholder("What did real feedback teach").fill("Squash before requesting review; the maintainer asked twice.");
    await page.getByPlaceholder("tags: conventions, tests, review").fill("review, git");
    await page.getByPlaceholder("source: PR #482 review by @alice").fill("PR #9 review");
    await page.getByRole("button", { name: "Append" }).click();
    await page.getByText("Squash before requesting review").first().waitFor({ timeout: 5000 });
    await page.getByPlaceholder("search lessons, sources, tags").fill("squash");
    if ((await page.locator(".fb-entry").count()) !== 1) throw new Error("search should narrow to one entry");
    await page.getByPlaceholder("search lessons, sources, tags").fill("");
    await page.getByRole("button", { name: "flag stale" }).first().click();
    await page.getByText("possibly stale").first().waitFor({ timeout: 5000 });
  });
  await shot("07f-feedback");
  await step("benchmark panel compares baseline and after", async () => {
    await page.getByRole("button", { name: "View" }).click();
    await page.getByRole("button", { name: /^Panels/ }).hover();
    await page.getByRole("menuitemcheckbox", { name: /^Benchmark/ }).click();
    await page.keyboard.press("Escape");
    await page.getByText("Saved runs (2)").waitFor({ timeout: 15000 });
    await page.getByText(/Baseline “baseline” → after “after fix”/).waitFor({ timeout: 10000 });
    await page.getByText(/faster|within noise/).first().waitFor();
  });
  await shot("07g-benchmark");
  await step("debug log panel opens from Help and records a marker", async () => {
    await page.getByRole("button", { name: "Help" }).click();
    await page.getByRole("menuitemcheckbox", { name: /Debug log/ }).click();
    await page.getByText(/\.mendophyte[\/\\]logs[\/\\]mendophyte-.*\.md/).first().waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Mark this moment" }).click();
    await page.getByText(/marker: user pressed/).first().waitFor({ timeout: 10000 });
  });
  await shot("07h-debug-log");
  await step("switch theme to minimal + dark", async () => {
    await page.getByRole("button", { name: "View" }).click();
    await page.getByRole("button", { name: /^Appearance/ }).hover();
    await page.getByRole("button", { name: /Theme: Minimal/ }).click();
    await page.getByRole("button", { name: "View" }).click();
    await page.getByRole("button", { name: /^Appearance/ }).hover();
    await page.getByRole("button", { name: /Scheme: dark/ }).click();
    await page.waitForTimeout(300);
  });
  await shot("08-minimal-dark");
  await step("back to vine dark", async () => {
    await page.getByRole("button", { name: "View" }).click();
    await page.getByRole("button", { name: /^Appearance/ }).hover();
    await page.getByRole("button", { name: /Theme: Vine/ }).click();
    await page.waitForTimeout(300);
  });
  await shot("09-vine-dark");
  await step("reload keeps session, layout and replays events", async () => {
    await page.reload();
    await page.getByText("Conversation", { exact: true }).first().waitFor({ timeout: 10000 });
    await page.getByText("Progress", { exact: true }).first().click();
    await page.getByText("In phase 4.").waitFor({ timeout: 10000 });
    await page.getByText("Conversation", { exact: true }).first().click();
    await page.locator(".sec-title", { hasText: "Recommendation" }).waitFor({ timeout: 10000 });
  });
  await shot("10-after-reload");

  console.log(errors.length ? `console issues:\n  ${errors.join("\n  ")}` : "console issues: none");
  if (errors.length) failures++;
  await browser.close();
} catch (e) {
  failures++;
  console.log("FAIL (setup)", e.message);
  console.log(serverLog.slice(-2000));
} finally {
  await stopServer();
  rmSync(base, { recursive: true, force: true });
}
console.log(failures ? `${failures} failure(s); screenshots in ${OUT}` : `all steps passed; screenshots in ${OUT}`);
process.exit(failures ? 1 : 0);
