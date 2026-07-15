export function applyExplicitAggregateHints(sql, question) {
  const text = String(question || '');
  if (!text) return sql;
  const targetAggregates = explicitAggregateColumns(text);
  let out = String(sql || '');
  for (const [column, aggregate] of targetAggregates.entries()) {
    out = replaceAggregateForColumn(out, column, aggregate);
  }
  return out;
}

function explicitAggregateColumns(question) {
  const targets = new Map();
  const segments = String(question || '').split(/[。；;.!?\n]/).map((s) => s.trim()).filter(Boolean);
  for (const segment of segments) {
    const columns = extractColumnTokens(segment);
    if (!columns.length) continue;
    if (/(求和|合计|汇总|SUM\s*\(|\bSUM\b)/i.test(segment)) {
      for (const column of columns) targets.set(column, 'SUM');
    }
    if (/(取单值|单值|节点级|MAX\s*\(|\bMAX\b)/i.test(segment)) {
      for (const column of columns) {
        if (!targets.has(column)) targets.set(column, 'MAX');
      }
    }
  }
  return targets;
}

function extractColumnTokens(text) {
  const columns = new Set();
  for (const match of String(text || '').matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
    const token = match[0];
    if (token.includes('_')) columns.add(token);
  }
  return [...columns];
}

function replaceAggregateForColumn(sql, column, aggregate) {
  const escaped = escapeRegExp(column);
  const quotedColumn = `(?:(?:[\\w]+\\.)?(?:["\`\\[]?${escaped}["\`\\]]?))`;
  const pattern = new RegExp(`\\b(?:SUM|MAX|MIN|AVG)\\s*\\(\\s*(DISTINCT\\s+)?(${quotedColumn})\\s*\\)`, 'gi');
  return String(sql || '').replace(pattern, (_match, distinct = '', expr = column) => {
    const prefix = aggregate === 'SUM' && distinct ? distinct : '';
    return `${aggregate}(${prefix}${expr})`;
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
