import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..', '..');
const readAppFile = (...parts) => fs.readFileSync(path.join(appRoot, ...parts), 'utf8');

test('agent nav defaults open unless the saved width is explicitly zero', () => {
  const shell = readAppFile('renderer', 'src', 'views', 'agent', 'YiWShell.tsx');

  assert.match(shell, /const\s+savedNavWidthRaw\s*=\s*localStorage\.getItem\(NAV_STORAGE_KEY\)/);
  assert.match(shell, /useState\(\(\)\s*=>\s*savedNavWidthRaw\s*===\s*'0'\)/);
  assert.doesNotMatch(shell, /localStorage\.getItem\('yiw-layout-nav-width'\)\s*\|\|\s*0/);
});

test('agent nav toggle stays beside the macOS traffic lights in both states', () => {
  const shell = readAppFile('renderer', 'src', 'views', 'agent', 'YiWShell.tsx');
  const theme = readAppFile('renderer', 'src', 'views', 'agent', 'yiw-theme.scss');
  const moduleCss = readAppFile('renderer', 'src', 'views', 'agent', 'yiw.module.scss');

  assert.match(shell, /\{showNavEdgeToggle\s*&&\s*createPortal\(\s*<button[\s\S]*data-edge-toggle="nav"[\s\S]*document\.body\s*\)\}/);
  assert.doesNotMatch(shell, /\{navCollapsed\s*&&\s*createPortal\(\s*<button[\s\S]*data-edge-toggle="nav"/);
  assert.match(theme, /body\[data-yiw-nav-collapsed='true'\]\s+\.yiw-root\s+\.yiw-dragbar-side/);
  assert.match(moduleCss, /\.rail\[data-collapsed='true'\]\s*\{[\s\S]*padding:\s*0;/);
  assert.match(moduleCss, /\.navEdgeToggle\s*\{[\s\S]*width:\s*34px;[\s\S]*height:\s*34px;/);
});

test('agent skills entries keep app and project scopes separate', () => {
  const shell = readAppFile('renderer', 'src', 'views', 'agent', 'YiWShell.tsx');
  const appSettings = readAppFile('renderer', 'src', 'views', 'agent', 'YiWSettings.tsx');
  const settings = readAppFile('renderer', 'src', 'views', 'project', 'settings', 'index.tsx');

  assert.match(shell, /'skills'/);
  assert.match(shell, /onOpenSkills=\{\(\)\s*=>\s*openSettings\('skills'\)\}/);
  assert.doesNotMatch(shell, /const\s+openProjectSkills\s*=\s*useCallback/);
  assert.match(appSettings, /<SkillsPage\s+scope="app"\s*\/>/);
  assert.match(settings, /case\s+'skills':[\s\S]*<SkillManagement/);
});
