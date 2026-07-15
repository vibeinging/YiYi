// 数据库配置类型
export interface DatabaseConfig {
  id?: string;
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  database?: string; // 兼容旧版
  db_type: string;
  description: string;
  tables?: TableInfo[];
  views?: ViewInfo[];
  procedures?: ProcedureInfo[];
  functions?: FunctionInfo[];
  relationships?: RelationshipInfo[];
}

// 表格信息类型
export interface TableInfo {
  id?: string;
  table_name: string;
  table_schema?: string;
  table_type: string;
  description?: string;
  columns?: ColumnInfo[];
  database_id?: string;
}

// 列信息类型
export interface ColumnInfo {
  id?: string;
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  column_default?: string;
  description?: string;
  is_primary_key?: boolean;
  is_foreign_key?: boolean;
  is_indexed?: boolean;
  table_id?: string;
  table_name?: string;
}

// 视图信息类型
export interface ViewInfo {
  id?: string;
  view_name: string;
  view_schema?: string;
  description?: string;
  database_id?: string;
}

// 存储过程信息类型
export interface ProcedureInfo {
  id?: string;
  procedure_name: string;
  procedure_schema?: string;
  description?: string;
  database_id?: string;
}

// 函数信息类型
export interface FunctionInfo {
  id?: string;
  function_name: string;
  function_schema?: string;
  description?: string;
  database_id?: string;
}

// 关系信息类型
export interface RelationshipInfo {
  id?: string;
  relationship_type: string; // one_to_one, one_to_many, many_to_many
  source_table_id: string;
  source_column_id: string;
  target_table_id: string;
  target_column_id: string;
  description?: string;
  source_table_name?: string;
  source_column_name?: string;
  target_table_name?: string;
  target_column_name?: string;
  database_id?: string;
}

// 元数据统计类型
export interface MetadataStats {
  tables: number;
  tablesWithDescription: number;
  columns: number;
  columnsWithDescription: number;
  relationships: number;
  relationshipsWithDescription: number;
  tableCompletenessPercentage: number;
  columnCompletenessPercentage: number;
  relationshipCompletenessPercentage: number;
  overallCompletenessPercentage: number;
}

// 缺失元数据类型
export interface MissingMetadata {
  tables: TableInfo[];
  columns: ColumnInfo[];
  relationships: RelationshipInfo[];
}

// 描述表单类型
export interface DescriptionForm {
  type: string;
  id: string;
  item: any;
  description: string;
}

// 数据库类型选项
export interface DbTypeOption {
  value: string;
  name: string;
}

// ==================== 查询历史相关类型 ====================

// 查询历史类型
export interface QueryHistory {
  id: string;
  title: string;
  description?: string;
  database_id: string;
  database?: string;
  natural_language_query: string;
  sql_query: string;
  result_summary?: any;
  result_preview?: any;
  row_count?: number;
  execution_time?: string;
  result_size_bytes?: number;
  config?: QueryConfig;
  is_favorite: boolean;
  vector_embedding?: number[];
  nl2sql_history_id?: string;
  created_at: string;
  updated_at: string;
}

// 查询配置类型
export interface QueryConfig {
  llmModelId?: string;
  maxTokens?: number;
  autoSaveQuery?: boolean;
}
