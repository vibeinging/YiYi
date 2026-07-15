export const DEFAULT_SCHEMA_NAMES = new Set(['default', 'main'])

export function isDefaultSchemaName(schemaName?: string | null): boolean {
  const normalized = String(schemaName || '').trim().toLowerCase()
  return !normalized || DEFAULT_SCHEMA_NAMES.has(normalized)
}

export function formatSchemaTableDisplayName(
  schemaName?: string | null,
  tableName?: string | null
): string {
  const cleanTableName = String(tableName || '').trim()
  if (!cleanTableName) return ''

  const cleanSchemaName = String(schemaName || '').trim()
  if (isDefaultSchemaName(cleanSchemaName)) return cleanTableName

  return `${cleanSchemaName}.${cleanTableName}`
}

export function formatTableDisplayName(
  table?: {
    schema_name?: string | null
    table_name?: string | null
    name?: string | null
  } | null
): string {
  return formatSchemaTableDisplayName(table?.schema_name, table?.table_name || table?.name)
}
