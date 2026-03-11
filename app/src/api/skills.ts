/**
 * Skills API
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface SkillMetadata {
  name: string;
  description: string;
  emoji?: string;
  tags?: string[];
  author?: string;
  version?: string;
  license?: string;
  enabled?: boolean;
  path?: string;
  url?: string;
  source?: 'builtin' | 'customized' | 'openclaw' | 'hub';
}

export interface Skill extends SkillMetadata {
  content?: string;
  references?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
}

export interface ListSkillsOptions {
  source?: 'builtin' | 'customized' | 'openclaw' | 'hub';
  enabledOnly?: boolean;
}

/** Parse YAML frontmatter from SKILL.md content and merge into skill object */
function parseFrontmatter(skill: Skill): Skill {
  const content = skill.content || '';
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return skill;

  const yaml = match[1];
  const get = (key: string): string | undefined => {
    const m = yaml.match(new RegExp(`^${key}:\\s*"?([^"\\n]*)"?`, 'm'));
    return m ? m[1].trim() : undefined;
  };

  // Extract emoji from metadata block
  const emojiMatch = yaml.match(/"emoji":\s*"([^"]+)"/);

  // Extract tags if present
  const tagsMatch = yaml.match(/tags:\s*\n((?:\s+-\s+.+\n?)*)/);
  const tags = tagsMatch
    ? tagsMatch[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean)
    : undefined;

  return {
    ...skill,
    description: skill.description || get('description') || '',
    emoji: skill.emoji || (emojiMatch ? emojiMatch[1] : undefined),
    author: skill.author || get('author'),
    version: skill.version || get('version'),
    license: skill.license || get('license'),
    url: skill.url || get('homepage'),
    tags: skill.tags || tags,
  };
}

/**
 * 列出所有 Skills
 */
export async function listSkills(options?: ListSkillsOptions): Promise<Skill[]> {
  const skills = await invoke<Skill[]>('list_skills', {
    source: options?.source,
    enabledOnly: options?.enabledOnly,
  });
  return skills.map(parseFrontmatter);
}

/**
 * 获取 Skill 详情
 */
export async function getSkill(name: string): Promise<Skill> {
  const skill = await invoke<Skill>('get_skill', { name });
  return parseFrontmatter(skill);
}

/**
 * 获取 Skill 内容
 */
export async function getSkillContent(name: string, filePath?: string): Promise<string> {
  return await invoke<string>('get_skill_content', {
    name,
    file_path: filePath,
  });
}

/**
 * 启用 Skill
 */
export async function enableSkill(name: string): Promise<{ status: string; message?: string }> {
  return await invoke('enable_skill', { name });
}

/**
 * 禁用 Skill
 */
export async function disableSkill(name: string): Promise<{ status: string; message?: string }> {
  return await invoke('disable_skill', { name });
}

/**
 * 创建自定义 Skill
 */
export async function createSkill(
  name: string,
  content: string,
  references?: Record<string, unknown>,
  scripts?: Record<string, unknown>
): Promise<{ status: string; message?: string }> {
  return await invoke('create_skill', {
    name,
    content,
    references,
    scripts,
  });
}

/**
 * 更新 Skill 内容
 */
export async function updateSkill(
  name: string,
  content: string,
): Promise<{ status: string; message?: string }> {
  return await invoke('update_skill', { name, content });
}

/**
 * 从 URL 导入 Skill
 */
export async function importSkill(url: string): Promise<{ status: string; message?: string; skill?: Skill }> {
  return await invoke('import_skill', { url });
}

/**
 * 重新加载所有 Skills（热更新）
 */
export async function reloadSkills(): Promise<{ status: string; message?: string; count?: number }> {
  return await invoke('reload_skills');
}

// ============================================================================
// Skills Hub (ClawHub / OpenClaw)
// ============================================================================

export interface HubSkill {
  slug: string;
  name: string;
  description: string;
  version?: string;
  source_url?: string;
  author?: string;
  tags?: string[];
  security_verdict?: string;
  requires?: {
    env?: string[];
    bins?: string[];
  };
}

export interface HubConfig {
  base_url: string;
  search_path: string;
  detail_path: string;
  file_path: string;
  download_path: string;
  list_path: string;
}

export interface HubInstallResult {
  name: string;
  enabled: boolean;
  source_url: string;
}

/**
 * Search skills from hub (supports ClawHub vector search)
 */
export async function hubSearchSkills(
  query: string,
  limit?: number,
  hubUrl?: string,
): Promise<HubSkill[]> {
  return await invoke<HubSkill[]>('hub_search_skills', {
    query,
    limit: limit ?? 20,
    hubUrl,
  });
}

/**
 * List/browse skills from hub with sorting and pagination
 */
export async function hubListSkills(
  limit?: number,
  cursor?: string,
  sort?: string,
  hubUrl?: string,
): Promise<{ items: HubSkill[]; nextCursor: string | null }> {
  return await invoke('hub_list_skills', {
    limit: limit ?? 20,
    cursor,
    sort,
    hubUrl,
  });
}

/**
 * Install a skill from hub URL (ClawHub, skills.sh, GitHub)
 */
export async function hubInstallSkill(
  url: string,
  options?: {
    version?: string;
    enable?: boolean;
    overwrite?: boolean;
    hubUrl?: string;
  },
): Promise<HubInstallResult> {
  return await invoke('hub_install_skill', {
    url,
    version: options?.version,
    enable: options?.enable ?? true,
    overwrite: options?.overwrite ?? false,
    hubUrl: options?.hubUrl,
  });
}

/**
 * Get hub configuration
 */
export async function getHubConfig(): Promise<HubConfig> {
  return await invoke('get_hub_config');
}

/**
 * AI 生成技能 - 流式返回
 */
export async function generateSkillAI(
  description: string,
  onChunk: (text: string) => void,
  onDone: (fullContent: string) => void,
  onError: (error: string) => void,
): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];

  unlisteners.push(await listen<string>('skill-gen://chunk', (event) => {
    onChunk(event.payload);
  }));

  unlisteners.push(await listen<string>('skill-gen://complete', (event) => {
    onDone(event.payload);
  }));

  unlisteners.push(await listen<string>('skill-gen://error', (event) => {
    onError(event.payload);
  }));

  await invoke('generate_skill_ai', { description });

  return () => {
    unlisteners.forEach(fn => fn());
  };
}
