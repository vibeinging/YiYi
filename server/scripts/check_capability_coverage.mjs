#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { capabilityCoverage } from '../src/engine/agents/capability_bridge.js';
import { ROUTES } from '../src/transport/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const report = capabilityCoverage(ROUTES);
const excludedTotal = Object.values(report.excluded).reduce((sum, value) => sum + value, 0);
if (excludedTotal !== report.excluded_routes) throw new Error('能力覆盖统计不一致');
if (report.excluded.invalid > 0) throw new Error(`存在 ${report.excluded.invalid} 条无法解释的不可发现 route`);
if (new Set(report.operation_ids).size !== report.operation_ids.length) throw new Error('operation_id 不唯一');

console.log(`能力覆盖: ${report.discoverable_routes}/${report.total_routes} (${report.coverage_percent}%)`);
console.log(`Schema: declared=${report.declared_schema} inferred=${report.inferred_schema}`);
console.log(`排除: ${JSON.stringify(report.excluded)}`);

if (process.argv.includes('--write-report')) {
  const date = new Date().toISOString().slice(0, 10);
  const file = path.resolve(__dirname, '..', '..', '..', 'docs', 'reports', `${date}_app-capability-coverage.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `# App Agent 能力覆盖报告\n\n生成时间：${new Date().toISOString()}\n\n| 项目 | 数量 |\n|---|---:|\n| Registry route 总数 | ${report.total_routes} |\n| Agent 可发现 | ${report.discoverable_routes} |\n| 明确参数结构 | ${report.declared_schema} |\n| 推断参数结构 | ${report.inferred_schema} |\n| 排除 | ${report.excluded_routes} |\n\n覆盖率：**${report.coverage_percent}%**\n\n排除原因：\n\n- 免登录接口：${report.excluded.unauthenticated}\n- 流式 Agent 接口：${report.excluded.streaming}\n- Agent 自调用接口：${report.excluded.agent_self}\n- 明确隐藏：${report.excluded.explicitly_hidden}\n- 无法解释：${report.excluded.invalid}\n\n检查规则：operation_id 必须唯一；所有排除项必须有明确原因；新增普通用户 route 默认自动进入能力目录。\n`);
  console.log(`报告: ${file}`);
}
