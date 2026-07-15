// 迁移自 yiw_kernel/data_analyze/planner/dbagents/models.py
//
// dbagents 共享数据模型。Python 版用 pydantic BaseModel；Node 版用纯 class，
// 保留 to_dict / from_dict 静态接口名 100% 一致，供 SQLGenerationAgent 等 1:1 import 调用。

/**
 * 统一的 SQL 候选数据结构（对应 Python pydantic SQLCandidate）
 */
export class SQLCandidate {
  /**
   * @param {object} [opts]
   * @param {string} [opts.sql='']
   * @param {string} [opts.reasoning='']
   */
  constructor({ sql = '', reasoning = '' } = {}) {
    this.sql = sql;
    this.reasoning = reasoning;
  }

  /**
   * 转换为字典格式，用于 Agent 间传递
   * @returns {{sql: string, reasoning: string}}
   */
  to_dict() {
    return {
      sql: this.sql,
      reasoning: this.reasoning,
    };
  }

  /**
   * 从字典创建实例
   * @param {object} [data={}]
   * @returns {SQLCandidate}
   */
  static from_dict(data = {}) {
    return new SQLCandidate({
      sql: (data && data.sql) || '',
      reasoning: (data && data.reasoning) || '',
    });
  }
}
