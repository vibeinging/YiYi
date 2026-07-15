import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, "builtin");

function parseScalar(value) {
  const raw = String(value || "").trim();
  if (raw === "true") return true;
  if (raw === "false") return false;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseFrontmatter(markdown = "") {
  const text = String(markdown || "");
  if (!text.startsWith("---")) return [{}, text.trim()];
  const end = text.indexOf("\n---", 3);
  if (end < 0) return [{}, text.trim()];
  const header = text.slice(3, end).trim();
  const body = text.slice(end + 4).trim();
  const meta = {};
  let currentListKey = null;

  for (const line of header.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && currentListKey) {
      if (!Array.isArray(meta[currentListKey])) meta[currentListKey] = [];
      meta[currentListKey].push(parseScalar(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2];
    if (!value.trim()) {
      meta[key] = [];
      currentListKey = key;
    } else {
      meta[key] = parseScalar(value);
      currentListKey = null;
    }
  }

  return [meta, body];
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.map((x) => String(x || "").trim()).filter(Boolean) : [];
}

function loadSkillFile(skillDir) {
  const file = join(skillDir, "SKILL.md");
  if (!existsSync(file)) return null;
  const [meta, instructions] = parseFrontmatter(readFileSync(file, "utf8"));
  const name = String(meta.name || "").trim();
  if (!name) return null;
  return {
    name,
    display_name: String(meta.display_name || name).trim(),
    description: String(meta.description || "").trim(),
    category: String(meta.category || "general").trim(),
    tags: normalizeArray(meta.tags),
    allowed_tools: normalizeArray(meta.allowed_tools),
    instructions,
    builtin: true,
    runtime: String(meta.runtime || "prompt").trim(),
    side_effect: String(meta.side_effect || "read").trim(),
    requires_project: meta.requires_project === true,
    allow_implicit_invocation: meta.allow_implicit_invocation !== false,
    default_enabled: meta.default_enabled !== false,
    global: meta.global === true,
    handler: String(meta.handler || "").trim(),
    tool_name: String(meta.tool_name || "").trim(),
    path: file,
  };
}

export function loadBuiltinSkills(baseDir = BUILTIN_DIR) {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadSkillFile(join(baseDir, entry.name)))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export default { loadBuiltinSkills };
