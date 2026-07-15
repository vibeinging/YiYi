import { randomUUID } from "node:crypto";
import { basename } from "node:path";

const MAX_ATTACHMENTS = 12;

function cleanText(value) {
  return String(value || "").trim();
}

export function normalizeMessageAttachments(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const path = cleanText(item.path || item.file_path || item.filePath);
    if (!path) continue;
    const name = cleanText(item.name || item.file_name || item.filename) || basename(path);
    out.push({
      path,
      name,
      is_dir: Boolean(item.is_dir || item.isDir || item.type === "dir"),
    });
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

export function buildUserContentItems(content, attachments = []) {
  const items = [];
  for (const attachment of normalizeMessageAttachments(attachments)) {
    items.push({
      id: randomUUID(),
      type: "attachment",
      content: attachment.name,
      metadata: {
        path: attachment.path,
        name: attachment.name,
        is_dir: attachment.is_dir,
      },
      is_complete: true,
      display_type: "file",
    });
  }
  const text = String(content || "").trim();
  if (text) {
    items.push({
      id: randomUUID(),
      type: "text",
      content: text,
      metadata: {},
      is_complete: true,
      display_type: "text",
    });
  }
  return items.length ? items : [{
    id: randomUUID(),
    type: "text",
    content: "请处理附件。",
    metadata: {},
    is_complete: true,
    display_type: "text",
  }];
}

export function buildAttachmentContextMessage(userMessage, attachments = []) {
  const normalized = normalizeMessageAttachments(attachments);
  const text = String(userMessage || "").trim() || "请处理附件。";
  if (!normalized.length) return text;
  const lines = normalized.map((attachment, index) => {
    const kind = attachment.is_dir ? "目录" : "文件";
    return `${index + 1}. ${kind}: ${attachment.name}\n   路径: ${attachment.path}`;
  });
  return `${text}\n\n## 用户随消息附加的本地文件\n${lines.join("\n")}\n\n请把这些附件视为用户当前问题的一部分。需要了解附件内容时,直接使用 read/ls/grep/find 等本地文件工具读取,不要回答无法访问本地文件。`;
}
