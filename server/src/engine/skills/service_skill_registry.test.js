import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BUILTIN_PI_SKILLS } from "../agents/pi_skill_registry.js";

test("service registry exposes QueryAgent as one trusted model tool", () => {
  const smartQuery = BUILTIN_PI_SKILLS.find((skill) => skill.name === "smart_query");
  assert.equal(smartQuery.handler, "query_agent");
  assert.equal(smartQuery.tool_name, "query_project_data");
  const source = readFileSync("app/server/src/engine/skills/service_skill_registry.js", "utf8");
  assert.match(source, /\["query_agent", createQueryProjectDataTool\]/);
});

test("service registry ignores disabled and non-builtin service skills", () => {
  const source = readFileSync("app/server/src/engine/skills/service_skill_registry.js", "utf8");
  assert.match(source, /!skill\?\.builtin/);
  assert.match(source, /!\(skill\.effective_enabled \?\? skill\.is_enabled \?\? true\)/);
});
