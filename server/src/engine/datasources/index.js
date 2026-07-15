// 迁移自 yiw_kernel/data_sources/__init__.py
//
// 数据源模块(汇总导出)
//
// 提供:
// - DataProfilerTool / ProfilingResult: 数据画像工具与结果
// - Grep*Tool: 扁平化 Schema 探索工具
// - BusinessDataSources 及各 DataSource 类型
// - Profile / Column / QueryResult / DataGrep 等核心类
//
// 注:Python 原 __init__ 还导出 DataSourceResolver / datasource_resolver,
//    该 resolver(resolver.py)尚未在 Node 迁移(TODO),此处未导出。

// ── tools ──
export {
  DataProfilerTool,
  ProfilingResult,
  GrepDataSourceTool,
  GrepTablesTool,
  GrepColumnsTool,
  GrepEntitiesTool,
} from './data_profiler_tool.js';

// ── datasource 核心 ──
export { QueryResult, DataSource } from './data_source.js';
export {
  BusinessDataSources,
  UnstructuredDataSource,
  TempFileDataSource,
  MCPDataSource,
} from './business_data_sources.js';
export { DatabaseDataSource } from './database_data_source.js';
export { IntermediateDataSource } from './intermediate_data_source.js';
export { IntermediateStorageService } from './intermediate_storage_service.js';
export {
  DataGrep,
  normalize_entity_key,
  invalidate_grep_entities_cache,
} from './data_grep.js';
export { Profile, Column, dump_profiles_desc } from './profile.js';

// ── DuckDB 访问辅助(Node 特有,抽取自 chat.js) ──
export {
  duckSchema,
  duckRun,
  duckRunRecords,
  duckListTables,
  duckTableSchema,
  duckSampleRows,
  duckTableExists,
  sanitizeTableName,
  sanitizeColumnName,
} from './duck.js';
