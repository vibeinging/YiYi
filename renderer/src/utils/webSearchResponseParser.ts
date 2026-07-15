/**
 * 从原始 API 响应 JSON 推断 results_path 与字段映射（纯启发式，无需 LLM）
 * 用于「测试连接」成功后自动填入「响应解析」配置
 * @param {object} rawJson - API 返回的原始 JSON
 * @returns {object|null} 推断的映射配置，无法推断时返回 null
 */
export function inferResponseMappings(rawJson: any): any {
  if (!rawJson || typeof rawJson !== 'object') return null

  const candidatePaths: any[] = []

  function walk(obj: any, pathPrefix = '') {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) {
      if (obj.length > 0 && typeof obj[0] === 'object' && obj[0] !== null && !Array.isArray(obj[0])) {
        const path = pathPrefix ? `${pathPrefix}[*]` : '[*]'
        const score = pathPrefix.length + (pathPrefix.match(/results|items|hits|data|entries/i) ? 10 : 0)
        candidatePaths.push({ path, score, sample: obj[0] })
      }
      return
    }
    for (const key of Object.keys(obj)) {
      const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key
      const val = obj[key]
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
        const path = `${fullPath}[*]`
        const score = fullPath.length + (key.match(/results|items|hits|entries/i) ? 20 : 0) + (key === 'data' ? 5 : 0)
        candidatePaths.push({ path, score, sample: val[0] })
      }
      walk(val, fullPath)
    }
  }

  walk(rawJson)
  if (candidatePaths.length === 0) return null

  candidatePaths.sort((a, b) => b.score - a.score)
  const best = candidatePaths[0]
  const sample = best.sample
  const keys = typeof sample === 'object' && sample !== null ? Object.keys(sample) : []

  const titleCandidates = ['title', 'display_name', 'name', 'headline', 'label']
  const urlCandidates = ['url', 'link', 'href', 'id', 'doi', 'uri']
  const contentCandidates = ['content', 'abstract', 'snippet', 'description', 'summary', 'text']
  const dateCandidates = ['published_date', 'date', 'year', 'created_at', 'publication_date']

  function pickKey(candidates: any, keys: any) {
    for (const c of candidates) {
      if (keys.includes(c)) return c
    }
    for (const k of keys) {
      if (candidates.some((c: any) => k.toLowerCase().includes(c))) return k
    }
    return keys[0] || null
  }

  const mappings: any = {
    results_path: best.path,
    title: pickKey(titleCandidates, keys) || 'title',
    url: pickKey(urlCandidates, keys),
    content: pickKey(contentCandidates, keys),
    published_date: pickKey(dateCandidates, keys)
  }
  const result: any = { results_path: mappings.results_path, title: mappings.title }
  if (mappings.url) result.url = mappings.url
  if (mappings.content) result.content = mappings.content
  if (mappings.published_date) result.published_date = mappings.published_date
  return result
}
