"use strict";

// Policy tests for skill crawler.preflight + crawler.join tool additions.
// Authz only — no adapters/network. Needs dist/ built (npm run build).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist");
const authz = require(path.join(DIST, "authz", "engine.js"));
const policies = require(path.join(DIST, "authz", "policies.json"));
const TIERS = ["fast", "balanced", "deep"];
const tools = (skill, tier) => policies.skills[skill].tiers[tier].allowedTools.split(",");

test("crawler.preflight balanced: allowed, anthropic-cli, 180s, evaluate+wait tools", async () => {
  authz._reset();
  const r = await authz.check("crawler.preflight", "balanced");
  assert.equal(r.allow, true);
  assert.equal(r.provider, "anthropic-cli");
  assert.equal(r.timeoutMs, 180000);
  assert.ok(r.allowedTools.includes("cloak_evaluate"));
  assert.ok(r.allowedTools.includes("cloak_wait"));
});

test("crawler.preflight has no interactive tools in any tier", () => {
  for (const t of TIERS) {
    const list = tools("crawler.preflight", t).join(",");
    for (const bad of ["cloak_click", "cloak_type", "cloak_press_key"]) {
      assert.ok(!list.includes(bad), `${t} must not contain ${bad}`);
    }
  }
});

test("crawler.preflight deep/balanced resolve like crawler.join", async () => {
  authz._reset();
  for (const t of ["balanced", "deep"]) {
    const a = await authz.check("crawler.preflight", t);
    const b = await authz.check("crawler.join", t);
    assert.equal(a.provider, b.provider, t);
    assert.equal(a.model, b.model, t);
  }
});

test("crawler.join keeps old tools, gains evaluate, still lacks cloak_type", () => {
  const old = ["launch", "new_page", "navigate", "snapshot", "click", "read_page", "close"];
  for (const t of TIERS) {
    const list = tools("crawler.join", t);
    for (const o of old) assert.ok(list.includes(`mcp__CloakBrowser__cloak_${o}`), `${t} ${o}`);
    assert.ok(list.includes("mcp__CloakBrowser__cloak_evaluate"), t);
    assert.ok(!list.includes("mcp__CloakBrowser__cloak_type"), t);
  }
});

test("regression: every skill/tier in policies.json still has a provider", () => {
  for (const [skill, sp] of Object.entries(policies.skills)) {
    for (const [tier, b] of Object.entries(sp.tiers)) {
      assert.ok(b.provider || b.modelKey, `${skill}/${tier} missing provider/modelKey`);
    }
  }
});

test("unknown skill falls back to wildcard policy (not preflight's); unknown tier denied", async () => {
  authz._reset();
  const s = await authz.check("crawler.preflightx", "balanced");
  const w = await authz.check("*", "balanced");
  assert.equal(s.allow, w.allow);
  assert.equal(s.allowedTools, w.allowedTools);
  assert.notEqual(s.allowedTools, policies.skills["crawler.preflight"].tiers.balanced.allowedTools);
  const t = await authz.check("crawler.preflight", "ultra");
  assert.equal(t.allow, false);
  assert.match(t.reason, /tier 'ultra' not permitted/);
});
