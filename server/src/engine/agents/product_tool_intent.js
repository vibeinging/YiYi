const ASK_DATA_PROJECT_PATTERN = /(?:问数项目|智能问数项目|问数工作区|智能问数工作区|\bask[-\s]?data\s+(?:project|workspace)\b)/i;
const EXPLICIT_PROJECT_CREATE_PATTERNS = [
  /(?:创建|新建|建立|建一个|建个|重建|重新创建).{0,40}(?:问数项目|智能问数项目|问数工作区|智能问数工作区|项目|工作区)/i,
  /(?:问数项目|智能问数项目|问数工作区|智能问数工作区|项目|工作区).{0,40}(?:创建|新建|建立|重建|重新创建)/i,
  /(?:转成|转换成|转换为|升级为).{0,40}(?:问数项目|智能问数项目|问数工作区|智能问数工作区|项目|工作区)/i,
  /(?:把|将)?当前会话.{0,40}(?:转成|转换成|转换为|升级为).{0,40}(?:问数项目|智能问数项目|问数工作区|智能问数工作区|项目|工作区)/i,
  /(?:把|将)?(?:当前|这个|这条|该)?(?:会话|对话|聊天).{0,40}(?:转到|转入|切到|进入).{0,40}(?:问数项目|智能问数项目|问数工作区|智能问数工作区|智能问数)/i,
  /\b(?:create|recreate|make)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:(?:ask[-\s]?data|data)\s+)?(?:project|workspace)\b/i,
  /\bconvert\s+(?:this\s+|current\s+)?(?:session|chat|conversation).{0,40}\bto\s+(?:an?\s+)?(?:(?:ask[-\s]?data|data)\s+)?(?:project|workspace)\b/i,
];
const SESSION_WORD_PATTERN = /(?:当前|这个|这条|该)?(?:会话|对话|聊天)/i;
const SESSION_MOVE_VERB_PATTERN = /(?:迁移|移动|转移|移到|转到|转入|切到|放到)/i;
const SESSION_MOVE_EXISTING_HINT_PATTERN = /(?:已有|现有|已存在|存在的|指定|目标|某个|某一|原有|之前的)/i;
const SESSION_MOVE_TARGET_PATTERN = /(?:到|入|至|进|放到|移到|转到|转入|切到)([^,，。；;!?！？\n]{1,60})(?:项目|工作区)/i;
const GENERIC_ASK_DATA_TARGETS = new Set([
  "问数",
  "智能问数",
  "问数项目",
  "智能问数项目",
  "问数工作区",
  "智能问数工作区",
  "项目",
  "工作区",
]);
const EXPLICIT_SESSION_MOVE_ENGLISH_PATTERNS = [
  /\b(?:move|migrate|transfer)\s+(?:this\s+|current\s+)?(?:session|chat|conversation).{0,60}\b(?:to|into)\s+(?:the\s+)?(?:existing|current|target|named)\b.{0,80}\b(?:project|workspace)\b/i,
  /\b(?:move|migrate|transfer)\s+(?:it|this).{0,60}\b(?:to|into)\s+(?:the\s+)?(?:existing|current|target|named)\b.{0,80}\b(?:project|workspace)\b/i,
];

function cleanIntentText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeProjectTarget(value) {
  return cleanIntentText(value)
    .replace(/[“”"'`《》「」『』（）()\[\]【】]/g, "")
    .replace(/^(?:已有|现有|已存在|存在的|指定|目标|某个|某一|原有|之前的|一个|这个|该|的)+/, "")
    .replace(/(?:问数|智能问数)?(?:项目|工作区)$/i, "")
    .replace(/\s+/g, "");
}

function hasNamedSessionMoveTarget(message) {
  const match = SESSION_MOVE_TARGET_PATTERN.exec(message);
  if (!match) return false;
  const rawTarget = match[1] || "";
  const target = cleanIntentText(rawTarget).replace(/\s+/g, "");
  if (!target || GENERIC_ASK_DATA_TARGETS.has(target)) return false;
  return normalizeProjectTarget(rawTarget).length >= 2;
}

export function hasAskDataProjectReference(raw) {
  return ASK_DATA_PROJECT_PATTERN.test(cleanIntentText(raw));
}

export function hasExplicitProjectCreateText(raw) {
  const message = cleanIntentText(raw);
  if (!message) return false;
  return EXPLICIT_PROJECT_CREATE_PATTERNS.some((pattern) => pattern.test(message));
}

export const hasExplicitAskDataProjectCreateText = hasExplicitProjectCreateText;

export function hasExplicitProjectSessionMoveText(raw) {
  const message = cleanIntentText(raw);
  if (!message) return false;
  if (EXPLICIT_SESSION_MOVE_ENGLISH_PATTERNS.some((pattern) => pattern.test(message))) return true;
  if (!SESSION_WORD_PATTERN.test(message) || !SESSION_MOVE_VERB_PATTERN.test(message)) return false;
  return SESSION_MOVE_EXISTING_HINT_PATTERN.test(message) || hasNamedSessionMoveTarget(message);
}

export function hasExplicitProjectCreateRequest(agentContext) {
  const message = cleanIntentText(
    agentContext?.input_data?.user_message ||
    agentContext?.input_data?.original_user_message ||
    agentContext?.user_message ||
    "",
  );
  return hasExplicitProjectCreateText(message);
}

export function hasExplicitProjectSessionMoveRequest(agentContext) {
  const message = cleanIntentText(
    agentContext?.input_data?.user_message ||
    agentContext?.input_data?.original_user_message ||
    agentContext?.user_message ||
    "",
  );
  return hasExplicitProjectSessionMoveText(message);
}
