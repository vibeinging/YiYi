import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..', '..');
const readAppFile = (...parts) => fs.readFileSync(path.join(appRoot, ...parts), 'utf8');

test('agent app zoom uses transform-based compensation instead of CSS zoom', () => {
  const settings = readAppFile('renderer', 'src', 'views', 'agent', 'YiWSettings.tsx');
  const theme = readAppFile('renderer', 'src', 'views', 'agent', 'yiw-theme.scss');

  assert.doesNotMatch(settings, /style\.zoom|\.zoom\s*=/);
  assert.match(settings, /removeProperty\('zoom'\)/);
  assert.match(theme, /width:\s*calc\(100%\s*\/\s*var\(--yiw-zoom,\s*1\)\)/);
  assert.match(theme, /height:\s*calc\(100%\s*\/\s*var\(--yiw-zoom,\s*1\)\)/);
  assert.match(theme, /transform:\s*scale\(var\(--yiw-zoom,\s*1\)\)/);
  assert.match(theme, /transform-origin:\s*0 0/);
});

test('electron shell disables native page zoom so app zoom has one owner', () => {
  const main = readAppFile('electron', 'main.js');

  assert.doesNotMatch(main, /role:\s*['"](resetZoom|zoomIn|zoomOut)['"]/);
  assert.match(main, /function lockPageZoom/);
  assert.match(main, /setZoomLevel\(0\)/);
  assert.match(main, /setZoomFactor\(1\)/);
  assert.match(main, /setVisualZoomLevelLimits\(1,\s*1\)/);
});

test('electron shell restores the last main window size on launch', () => {
  const main = readAppFile('electron', 'main.js');

  assert.match(main, /function windowStatePath/);
  assert.match(main, /main-window-state\.json/);
  assert.match(main, /function loadWindowState/);
  assert.match(main, /function saveWindowState/);
  assert.match(main, /width:\s*windowState\.width/);
  assert.match(main, /height:\s*windowState\.height/);
  assert.match(main, /if \(!windowState\.hasPosition\) mainWindow\.center\(\)/);
  assert.match(main, /mainWindow\.on\('resize', \(\) => scheduleSaveWindowState\(mainWindow\)\)/);
  assert.match(main, /mainWindow\.on\('move', \(\) => scheduleSaveWindowState\(mainWindow\)\)/);
  assert.doesNotMatch(main, /mainWindow\.center\(\);\s*\n\s*lockPageZoom/);
});
