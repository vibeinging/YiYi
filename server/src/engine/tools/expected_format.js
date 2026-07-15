// 迁移自 yiw_kernel/data_analyze/planner/prompts/expected_format.py

/**
 * 期望输出格式定义。
 *
 * Python 源使用 pydantic BaseModel/RootModel + @model_validator 做运行时校验。
 * JS 版用普通 class + 静态工厂方法替代，保留同名字段和 to_dict / formatted_dependencies
 * 等下游调用的接口。校验仅做关键字段的类型检查（轻量策略）。
 */

// ---- QuestionEnhancementAnswer ----

export class QuestionEnhancementAnswer {
  /** @param {{ enhanced_question: string, reasoning: string }} data */
  constructor({ enhanced_question, reasoning }) {
    this.enhanced_question = enhanced_question;
    this.reasoning = reasoning;
  }

  /** @param {object} data */
  static from(data) {
    return new QuestionEnhancementAnswer(data);
  }
}

// ---- NameIntermediateTableAnswer ----

export class NameIntermediateTableAnswer {
  /** @param {{ name: string }} data */
  constructor({ name }) {
    this.name = name;
  }

  static from(data) {
    return new NameIntermediateTableAnswer(data);
  }
}

// ---- ProfileEnhancementAnswer ----

export class ProfileEnhancementAnswer {
  /**
   * @param {{ table: object, columns: Array<object> }} data
   */
  constructor({ table, columns }) {
    this.table = table;
    this.columns = columns;
  }

  static from(data) {
    return new ProfileEnhancementAnswer(data);
  }
}

// ---- DictFormatAnswer ----
// Python 源是 RootModel[Dict[str, Any]]，根对象即是 dict 本身。
// JS 版持有 root 属性，dict_format 属性对齐 Python 的 @property。

export class DictFormatAnswer {
  /** @param {object} root */
  constructor(root) {
    this.root = root;
  }

  /** Python: @property dict_format */
  get dict_format() {
    return this.root;
  }

  static from(data) {
    return new DictFormatAnswer(data);
  }
}

// ---- CallingSubAgentAnswer ----

export class CallingSubAgentAnswer {
  /**
   * @param {{
   *   subagent: string,
   *   arguments: object|null,
   *   direct_answer: boolean|null
   * }} data
   */
  constructor({ subagent, arguments: args = null, direct_answer = null }) {
    this.subagent = subagent;
    this.arguments = args;
    this.direct_answer = direct_answer;

    // @model_validator: if subagent is set, arguments must be object and direct_answer bool
    if (this.subagent && !(typeof this.arguments === 'object' && typeof this.direct_answer === 'boolean')) {
      throw new Error('arguments and direct_answer must be provided if subagent is called.');
    }
  }

  to_dict() {
    const res = { subagent: this.subagent };
    if (this.arguments) res.arguments = this.arguments;
    if (this.direct_answer) res.direct_answer = this.direct_answer;
    return res;
  }

  static from(data) {
    return new CallingSubAgentAnswer(data);
  }
}

// ---- AmbiguityEliminationAnswer ----

export class AmbiguityEliminationAnswer {
  /** @param {{ description: string }} data */
  constructor({ description }) {
    this.description = description;
  }

  static from(data) {
    return new AmbiguityEliminationAnswer(data);
  }
}

// ---- RagAnswer ----

export class RagAnswer {
  /** @param {{ can_answer: boolean, answer: string|null }} data */
  constructor({ can_answer, answer = null }) {
    this.can_answer = can_answer;
    this.answer = answer;
  }

  static from(data) {
    return new RagAnswer(data);
  }
}

// ---- _ExtractedItem (内部类) ----

class _ExtractedItem {
  /**
   * @param {{ context: string, type: 'entity'|'dimension'|'metric' }} data
   */
  constructor({ context, type }) {
    this.context = context;
    this.type = type;
  }
}

// ---- ComponentExtractionAnswer ----

export class ComponentExtractionAnswer {
  /** @param {{ extracted_items: Array<{context: string, type: string}> }} data */
  constructor({ extracted_items }) {
    this.extracted_items = (extracted_items || []).map(i => new _ExtractedItem(i));
  }

  static from(data) {
    return new ComponentExtractionAnswer(data);
  }
}

// ---- DecompositionAnswer ----

export class DecompositionAnswer {
  /**
   * @param {{
   *   expected_schema: Object<string, string>,
   *   query: string,
   *   dependencies: Array<number|string>,
   *   is_final_subquery: boolean
   * }} data
   */
  constructor({ expected_schema, query, dependencies, is_final_subquery }) {
    this.expected_schema = expected_schema;
    this.query = query;
    this.dependencies = dependencies;
    this.is_final_subquery = is_final_subquery;
  }

  /** Python: @property formatted_dependencies — converts all to int */
  get formatted_dependencies() {
    return this.dependencies.map(d => parseInt(d, 10));
  }

  static from(data) {
    return new DecompositionAnswer(data);
  }
}

// ---- ExtractAnswer ----

export class ExtractAnswer {
  /** @param {{ extracted_value: *, reasoning: string }} data */
  constructor({ extracted_value, reasoning }) {
    this.extracted_value = extracted_value;
    this.reasoning = reasoning;
  }

  static from(data) {
    return new ExtractAnswer(data);
  }
}

// ---- StructuredExtractAnswer ----

export class StructuredExtractAnswer {
  /** @param {{ data?: object|null, reasoning: string }} opts */
  constructor({ data = null, reasoning }) {
    this.data = data;
    this.reasoning = reasoning;
  }

  static from(opts) {
    return new StructuredExtractAnswer(opts);
  }
}

// ---- ExtractSchemaField ----

export class ExtractSchemaField {
  /** @param {{ name: string, type: string, description?: string|null }} data */
  constructor({ name, type, description = null }) {
    this.name = name;
    this.type = type;
    this.description = description;
  }

  static from(data) {
    return new ExtractSchemaField(data);
  }
}

// ---- FilterAnswer ----

export class FilterAnswer {
  /** @param {{ flag: boolean, data?: object|null, reasoning: string }} data */
  constructor({ flag, data = null, reasoning }) {
    this.flag = flag;
    this.data = data;
    this.reasoning = reasoning;
  }

  static from(data) {
    return new FilterAnswer(data);
  }
}

// ---- ComparisonAnswer ----

export class ComparisonAnswer {
  /** @param {{ comparison_result?: string|null, reasoning: string }} data */
  constructor({ comparison_result = null, reasoning }) {
    this.comparison_result = comparison_result; // 'a>b' | 'a<b' | 'a==b' | null
    this.reasoning = reasoning;
  }

  static from(data) {
    return new ComparisonAnswer(data);
  }
}

// ---- SummaryAnswer ----

export class SummaryAnswer {
  /** @param {{ summary: string, reasoning: string }} data */
  constructor({ summary, reasoning }) {
    this.summary = summary;
    this.reasoning = reasoning;
  }

  static from(data) {
    return new SummaryAnswer(data);
  }
}
