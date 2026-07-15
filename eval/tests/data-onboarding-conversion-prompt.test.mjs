import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  hasExplicitProjectCreateRequest,
  hasExplicitProjectSessionMoveRequest,
} from '../../server/src/engine/agents/product_tool_intent.js';
import {
  BUILTIN_PI_SKILLS,
  canActivatePromptSkill,
  formatPiSkillInstructions,
  listGlobalPiSkills,
  renderPiSkillsIndexPrompt,
} from '../../server/src/engine/agents/pi_skill_registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillPath = join(__dirname, '../../server/src/engine/skills/builtin/data_onboarding/SKILL.md');
const projectManagementSkillPath = join(__dirname, '../../server/src/engine/skills/builtin/project_management/SKILL.md');
const workspaceAgentPath = join(__dirname, '../../server/src/engine/agents/workspace_agent.js');
const productCatalogPath = join(__dirname, '../../server/src/engine/agents/product_tool_catalog.js');

test('data_onboarding conversion prompt avoids dangling waiting steps', () => {
  const content = readFileSync(skillPath, 'utf8');
  assert.match(content, /allow_implicit_invocation: false/);
  assert.match(content, /requires_project: true/);
  assert.match(content, /global: false/);
  assert.doesNotMatch(content, /project_session_move/);
  assert.doesNotMatch(content, /project_create/);
  assert.match(content, /update_plan 只列本轮会实际执行的动作/);
  assert.match(content, /不要把“等待用户导入数据\/等待用户确认项目创建完成”这类下一轮用户动作写成 todo 或 doing 步骤/);
});

test('workspace agent streams local file listing results without waiting for final answer', () => {
  const content = readFileSync(workspaceAgentPath, 'utf8');
  assert.match(content, /SHOW_RESULT[\s\S]*"ls"/);
  assert.match(content, /SHOW_RESULT[\s\S]*"find"/);
  assert.match(content, /SHOW_RESULT[\s\S]*"grep"/);
  assert.match(content, /content_type: "tool_result"/);
});

test('data_onboarding requires an explicit user request before creating projects', async () => {
  const content = readFileSync(skillPath, 'utf8');
  const catalog = readFileSync(productCatalogPath, 'utf8');

  assert.match(content, /不要创建问数项目,不要迁移会话;这些是 project_management 的职责/);
  assert.match(content, /确认流程只确认执行,不是用户主动提出创建项目的证据/);
  assert.match(catalog, /create_smart_qa_project/);
  assert.match(catalog, /仅当用户本轮文本明确要求创建\/新建\/重建\/转成\/升级为智能问数项目或工作区时使用/);

  assert.equal(
    hasExplicitProjectCreateRequest({ input_data: { user_message: '2026-06-23打车发票 加起来是多少钱' } }),
    false,
  );
  assert.equal(
    hasExplicitProjectCreateRequest({ input_data: { user_message: '把这些PDF导入到问数项目' } }),
    false,
  );
  assert.equal(
    hasExplicitProjectCreateRequest({ input_data: { user_message: '创建一个项目' } }),
    true,
  );
  assert.equal(
    hasExplicitProjectCreateRequest({ input_data: { user_message: '创建一个工作区' } }),
    true,
  );
  assert.equal(
    hasExplicitProjectCreateRequest({ input_data: { user_message: 'create a project' } }),
    true,
  );
  assert.equal(
    hasExplicitProjectCreateRequest({ input_data: { user_message: '创建一个名为打车发票统计的问数项目' } }),
    true,
  );
  assert.equal(
    hasExplicitProjectCreateRequest({ input_data: { user_message: '创建一个叫2026年6月23日打车发票金额统计的问数项目' } }),
    true,
  );
  assert.equal(
    hasExplicitProjectCreateRequest({ input_data: { user_message: '把当前会话转成问数项目' } }),
    true,
  );
  assert.equal(
    hasExplicitProjectCreateRequest({ input_data: { user_message: '把这个会话转到智能问数工作区' } }),
    true,
  );
  assert.equal(
    hasExplicitProjectCreateRequest({ input_data: { user_message: 'create an ask-data project for invoices' } }),
    true,
  );

  const productTools = readFileSync(join(__dirname, '../../server/src/engine/agents/product_tools.js'), 'utf8');
  assert.match(productTools, /PROJECT_CREATE_REQUIRES_EXPLICIT_USER_REQUEST/);
  assert.match(productTools, /hasExplicitProjectCreateRequest\(agentContext\)/);
});

test('project_session_move requires an explicit session move request', async () => {
  const catalog = readFileSync(productCatalogPath, 'utf8');
  const productTools = readFileSync(join(__dirname, '../../server/src/engine/agents/product_tools.js'), 'utf8');
  const projectManagement = readFileSync(projectManagementSkillPath, 'utf8');

  assert.match(catalog, /普通文件分析、发票统计、导入数据和确认卡都不能触发/);
  assert.match(projectManagement, /没有明确迁移命令时,绝不能调用 project_session_move/);
  assert.match(projectManagement, /转成智能问数项目\/工作区”是创建新项目/);
  assert.match(productTools, /PROJECT_SESSION_MOVE_REQUIRES_EXPLICIT_USER_REQUEST/);
  assert.match(productTools, /hasExplicitProjectSessionMoveRequest\(agentContext\)/);

  assert.equal(
    hasExplicitProjectSessionMoveRequest({ input_data: { user_message: '2026-06-23打车发票 这里面需要报销多少钱' } }),
    false,
  );
  assert.equal(
    hasExplicitProjectSessionMoveRequest({ input_data: { user_message: '把这些PDF导入到问数项目' } }),
    false,
  );
  assert.equal(
    hasExplicitProjectSessionMoveRequest({ input_data: { user_message: '确认执行' } }),
    false,
  );
  assert.equal(
    hasExplicitProjectSessionMoveRequest({ input_data: { user_message: '把当前对话迁移到打车发票统计项目' } }),
    true,
  );
  assert.equal(
    hasExplicitProjectSessionMoveRequest({ input_data: { user_message: '把这个会话转到智能问数工作区' } }),
    false,
  );
  assert.equal(
    hasExplicitProjectSessionMoveRequest({ input_data: { user_message: '把当前会话迁移到已有问数项目' } }),
    true,
  );
  assert.equal(
    hasExplicitProjectSessionMoveRequest({ input_data: { user_message: 'move this session to the existing ask data project named invoices' } }),
    true,
  );
});

test('project read tools are basic capabilities across workspaces', () => {
  const catalog = readFileSync(productCatalogPath, 'utf8');
  const productTools = readFileSync(join(__dirname, '../../server/src/engine/agents/product_tools.js'), 'utf8');
  const projectManagement = readFileSync(projectManagementSkillPath, 'utf8');

  assert.match(catalog, /project_detail/);
  assert.match(catalog, /只读基础能力,可在任意工作区/);
  assert.match(productTools, /async function projectDetailTool/);
  assert.match(productTools, /project_detail: projectDetailTool/);
  assert.match(projectManagement, /project_list 和 project_detail 是只读基础能力/);
  assert.match(projectManagement, /不要把 project_list 或 project_detail 误当成迁移前置条件/);
});

test('data_onboarding stops after import failures instead of guessing from filenames', () => {
  const content = readFileSync(skillPath, 'utf8');
  assert.match(content, /如果导入、解析或任务状态返回失败,本轮停止/);
  assert.match(content, /不要改用文件名、路径、目录列表或猜测内容来回答原问题/);
  assert.match(content, /不要声称已读取未成功解析的文件内容/);
});

test('product file tools expand home directory paths before classifying', () => {
  const productTools = readFileSync(join(__dirname, '../../server/src/engine/agents/product_tools.js'), 'utf8');
  assert.match(productTools, /import \{ homedir \} from "node:os"/);
  assert.match(productTools, /text === "~"/);
  assert.match(productTools, /text\.startsWith\("~\/"\)/);
});

test('project creation workspace events carry the source session id', () => {
  const content = readFileSync(workspaceAgentPath, 'utf8');
  assert.match(content, /session_id:\s*agentContext\?\.session_id\s*\|\|\s*agentContext\?\.input_data\?\.session_id\s*\|\|\s*null/);
  assert.match(content, /toolName === "project_create" \|\| toolName === "create_smart_qa_project"/);
  assert.match(content, /toolName === "project_session_move"\) event = "session_moved"/);
});

test('project_management runtime prompts expose project_session_move', () => {
  const content = readFileSync(projectManagementSkillPath, 'utf8');
  assert.match(content, /name: project_management/);
  assert.match(content, /allow_implicit_invocation: false/);
  assert.match(content, /global: true/);
  assert.match(content, /project_detail/);
  assert.match(content, /project_session_move/);
  assert.match(content, /create_smart_qa_project/);
  assert.match(content, /不要回答“我无法迁移”或建议用户手动切换/);

  const skill = BUILTIN_PI_SKILLS.find((item) => item.name === 'project_management');
  assert.ok(skill, 'project_management builtin skill exists');
  assert.equal(skill.requires_project, false);
  assert.equal(skill.allow_implicit_invocation, false);
  assert.ok(skill.allowed_tools.includes('project_detail'));
  assert.ok(skill.allowed_tools.includes('project_session_move'));
  assert.ok(skill.allowed_tools.includes('create_smart_qa_project'));

  const indexPrompt = renderPiSkillsIndexPrompt([{ ...skill, effective_enabled: true }]);
  assert.equal(indexPrompt, "");

  const instructions = formatPiSkillInstructions(skill);
  assert.match(instructions, /Allowed tools: .*project_detail/);
  assert.match(instructions, /Allowed tools: .*project_session_move/);
  assert.match(instructions, /Allowed tools: .*create_smart_qa_project/);
  assert.match(instructions, /project_session_move[\s\S]*完成/);

  const workspaceAgent = readFileSync(workspaceAgentPath, 'utf8');
  assert.doesNotMatch(workspaceAgent, /fallbackSkill = listGlobalPiSkills\(\)\.find/);
});

test('data_onboarding is hidden from implicit skill index', () => {
  const globalSkills = listGlobalPiSkills();
  const onboarding = BUILTIN_PI_SKILLS.find((item) => item.name === 'data_onboarding');
  const projectManagement = BUILTIN_PI_SKILLS.find((item) => item.name === 'project_management');
  assert.ok(onboarding, 'data_onboarding builtin skill exists');
  assert.ok(projectManagement, 'project_management builtin skill exists');
  assert.equal(onboarding.allow_implicit_invocation, false);
  assert.equal(onboarding.requires_project, true);
  assert.equal(projectManagement.allow_implicit_invocation, false);
  assert.equal(projectManagement.requires_project, false);
  assert.equal(globalSkills.some((item) => item.name === 'data_onboarding'), false);
  assert.equal(globalSkills.some((item) => item.name === 'project_management'), true);

  const indexPrompt = renderPiSkillsIndexPrompt([
    { ...onboarding, effective_enabled: true },
    { ...projectManagement, effective_enabled: true },
  ]);
  assert.doesNotMatch(indexPrompt, /data_onboarding/);
  assert.doesNotMatch(indexPrompt, /project_management/);
  assert.equal(canActivatePromptSkill({ ...projectManagement, effective_enabled: true }), false);
  assert.equal(canActivatePromptSkill({ ...projectManagement, effective_enabled: true }, { routedSkillName: 'project_management' }), true);
  assert.equal(canActivatePromptSkill({ name: 'visible_skill', runtime: 'prompt', allow_implicit_invocation: true }), true);

  const workspaceAgent = readFileSync(workspaceAgentPath, 'utf8');
  assert.match(workspaceAgent, /canActivatePromptSkill\(skill, \{ routedSkillName \}\)/);
  assert.match(workspaceAgent, /implicit_invocation_disabled/);
});
