import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRemoteUrl } from "../src/orchestrator/preflight/forge.js";

test("forge: github https and ssh forms", () => {
  const a = parseRemoteUrl("https://github.com/owner/repo.git");
  assert.equal(a?.kind, "github");
  assert.equal(a?.owner, "owner");
  assert.equal(a?.repo, "repo");
  assert.equal(a?.apiUrl, "https://api.github.com/repos/owner/repo");
  assert.equal(a?.webUrl, "https://github.com/owner/repo");

  const b = parseRemoteUrl("git@github.com:owner/repo.git");
  assert.equal(b?.kind, "github");
  assert.equal(b?.path, "owner/repo");

  const c = parseRemoteUrl("ssh://git@github.com/owner/repo");
  assert.equal(c?.apiUrl, a?.apiUrl);
});

test("forge: gitlab nested groups keep the full path, URL-encoded for the API", () => {
  const f = parseRemoteUrl("git@gitlab.com:group/subgroup/project.git");
  assert.equal(f?.kind, "gitlab");
  assert.equal(f?.path, "group/subgroup/project");
  assert.equal(f?.owner, "group/subgroup");
  assert.equal(f?.repo, "project");
  assert.equal(f?.apiUrl, "https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Fproject");

  const self = parseRemoteUrl("https://gitlab.example.org/team/tool.git");
  assert.equal(self?.kind, "gitlab");
  assert.equal(self?.apiUrl, "https://gitlab.example.org/api/v4/projects/team%2Ftool");
});

test("forge: codeberg is gitea-flavoured; unknown hosts get no API URL", () => {
  const cb = parseRemoteUrl("https://codeberg.org/user/thing");
  assert.equal(cb?.kind, "gitea");
  assert.equal(cb?.apiUrl, "https://codeberg.org/api/v1/repos/user/thing");

  const ghe = parseRemoteUrl("https://github.corp.example/org/repo.git");
  assert.equal(ghe?.kind, "github");
  assert.equal(ghe?.apiUrl, "https://github.corp.example/api/v3/repos/org/repo");

  const unk = parseRemoteUrl("https://git.example.com/a/b.git");
  assert.equal(unk?.kind, "unknown");
  assert.equal(unk?.apiUrl, null);
  assert.equal(unk?.webUrl, "https://git.example.com/a/b");
});

test("forge: garbage and local paths are rejected", () => {
  assert.equal(parseRemoteUrl(""), null);
  assert.equal(parseRemoteUrl("/home/me/repo"), null);
  assert.equal(parseRemoteUrl("file:///home/me/repo"), null);
  assert.equal(parseRemoteUrl("https://github.com/onlyowner"), null);
});
