// 迁移自 core/agentic_flow/demo/deep_research_discussion/tools/web_search_tool.py
//
// WebSearchTool - 网络搜索工具
//
// 支持多种搜索引擎 API，提供统一的搜索接口；根据不同专家角色调整搜索策略。
//
// 迁移要点：
// - Python httpx/requests → Node 内置 fetch（无需第三方依赖）。
// - API key：优先取构造时注入的 deps（{ env }），否则回落 process.env；不硬编码。
// - logging → console；asyncio.sleep → 基于 Promise 的 sleep。
// - 对外接口保持一致：class WebSearchTool extends BaseTool，execute(context, kwargs) → Result。

import { BaseTool, Result } from '../core/base_tool.js';

// 轻量 logger（对应 Python logging.getLogger）
const logger = {
  error: (...args) => console.error('[WebSearchTool]', ...args),
  warn: (...args) => console.warn('[WebSearchTool]', ...args),
  info: (...args) => console.info('[WebSearchTool]', ...args),
};

/** 基于 Promise 的 sleep（对应 asyncio.sleep） */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把对象编码成 query string（对应 httpx 的 params）。
 * 跳过 null/undefined 值。
 * @param {object} params
 * @returns {string} 形如 "a=1&b=2"
 */
function encodeQuery(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined) continue;
    usp.append(k, String(v));
  }
  return usp.toString();
}

/**
 * 网络搜索工具（对应 Python class WebSearchTool）
 *
 * 支持的搜索引擎：
 * - SerpApi (Google Search)
 * - Bing Search API
 * - DuckDuckGo (免费)
 */
export class WebSearchTool extends BaseTool {
  /**
   * @param {object} [deps] 可注入依赖
   * @param {object} [deps.env] API key 来源（覆盖 process.env），如 { SERPAPI_API_KEY, BING_SEARCH_API_KEY }
   * @param {typeof fetch} [deps.fetch] 自定义 fetch（便于测试），默认全局 fetch
   */
  constructor(deps = {}) {
    super('web_search', '网络搜索工具，获取最新信息', { version: '1.0.0' });

    // API key / fetch 注入：优先 deps.env，回落 process.env
    this._env = deps.env || (typeof process !== 'undefined' ? process.env : {}) || {};
    this._fetch = deps.fetch || (typeof fetch !== 'undefined' ? fetch : null);

    // 搜索引擎配置
    this.search_engines = {
      serpapi: {
        url: 'https://serpapi.com/search',
        api_key_env: 'SERPAPI_API_KEY',
        enabled: Boolean(this._getEnv('SERPAPI_API_KEY')),
      },
      bing: {
        url: 'https://api.bing.microsoft.com/v7.0/search',
        api_key_env: 'BING_SEARCH_API_KEY',
        enabled: Boolean(this._getEnv('BING_SEARCH_API_KEY')),
      },
      duckduckgo: {
        url: 'https://api.duckduckgo.com/',
        api_key_env: null,
        enabled: true, // DuckDuckGo 是免费的
      },
    };

    // 选择可用的搜索引擎
    this.active_engine = this._select_search_engine();
  }

  /** 从注入的 env / process.env 读取 key（对应 os.getenv） */
  _getEnv(name) {
    if (!name) return undefined;
    return this._env?.[name];
  }

  /**
   * 选择可用的搜索引擎（对应 _select_search_engine）
   * 优先级：SerpApi > Bing > DuckDuckGo
   * @returns {string}
   */
  _select_search_engine() {
    for (const [engine, config] of Object.entries(this.search_engines)) {
      if (config.enabled) {
        logger.info(`使用搜索引擎: ${engine}`);
        return engine;
      }
    }
    logger.warn('没有可用的搜索引擎API，将使用模拟数据');
    return 'mock';
  }

  /**
   * 执行网络搜索（对应 async execute）
   *
   * @param {object} context Agent 上下文
   * @param {object} [kwargs]
   * @param {string} [kwargs.query] 搜索查询
   * @param {number} [kwargs.max_results=10] 最大结果数
   * @param {string} [kwargs.role='general'] 专家角色，用于调整搜索策略
   * @param {string} [kwargs.search_type='web'] 搜索类型（web, news, academic 等）
   * @returns {Promise<Result>}
   */
  async execute(context, kwargs = {}) {
    const query = kwargs.query ?? '';
    if (!query) {
      return Result.createError('缺少查询参数');
    }

    const max_results = kwargs.max_results ?? 10;
    const role = kwargs.role ?? 'general';
    const search_type = kwargs.search_type ?? 'web';

    // 根据角色调整查询
    const adapted_query = this._adapt_query_for_role(query, role);

    logger.info(`开始搜索: ${adapted_query} (角色: ${role})`);

    // 执行搜索
    let results;
    if (this.active_engine === 'mock') {
      results = await this._mock_search(adapted_query, max_results, role);
    } else {
      results = await this._real_search(adapted_query, max_results, search_type);
    }

    if (!results || results.length === 0) {
      return Result.createError('搜索无结果');
    }

    // 处理结果
    const processed_results = this._process_results(results, role);

    return Result.create({
      query,
      adapted_query,
      role,
      search_engine: this.active_engine,
      results: processed_results,
      total_results: processed_results.length,
      search_time: new Date().toISOString(),
    });
  }

  /**
   * 根据角色调整搜索查询（对应 _adapt_query_for_role）
   * @param {string} query
   * @param {string} role
   * @returns {string}
   */
  _adapt_query_for_role(query, role) {
    const role_keywords = {
      技术专家: ['技术实现', '架构设计', '最佳实践', 'scalability', 'performance'],
      业务分析师: ['商业模式', 'ROI', '市场分析', '成本效益', 'business case'],
      行业专家: ['行业趋势', '标杆案例', '最佳实践', 'industry report'],
      研究员: ['研究', '数据', '统计', '报告', 'study'],
      质疑者: ['风险', '挑战', '问题', '失败案例', 'limitations'],
      主持人: ['概述', '总结', '关键点', 'overview'],
    };

    if (Object.prototype.hasOwnProperty.call(role_keywords, role)) {
      // 添加角色相关关键词
      const keywords = role_keywords[role];
      return `${query} (${keywords.slice(0, 2).join(' OR ')})`;
    }

    return query;
  }

  /**
   * 真实的网络搜索（对应 _real_search）
   * @param {string} query
   * @param {number} max_results
   * @param {string} search_type
   * @returns {Promise<Array<object>>}
   */
  async _real_search(query, max_results, search_type) {
    if (this.active_engine === 'serpapi') {
      return this._search_with_serpapi(query, max_results);
    }
    if (this.active_engine === 'bing') {
      return this._search_with_bing(query, max_results);
    }
    if (this.active_engine === 'duckduckgo') {
      return this._search_with_duckduckgo(query, max_results);
    }
    return [];
  }

  /**
   * 通过 fetch 发 GET 请求并解析 JSON（对应 httpx client.get + raise_for_status + json）。
   * @param {string} baseUrl
   * @param {object} [opts]
   * @param {object} [opts.params] query 参数
   * @param {object} [opts.headers] 请求头
   * @returns {Promise<object>}
   */
  async _getJson(baseUrl, { params = {}, headers = {} } = {}) {
    if (!this._fetch) {
      throw new Error('当前运行环境不支持 fetch');
    }
    const qs = encodeQuery(params);
    const url = qs ? `${baseUrl}?${qs}` : baseUrl;
    const response = await this._fetch(url, { method: 'GET', headers });
    // 对应 response.raise_for_status()
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
    }
    return response.json();
  }

  /**
   * 使用 SerpApi 进行 Google 搜索（对应 _search_with_serpapi）
   * @param {string} query
   * @param {number} max_results
   * @returns {Promise<Array<object>>}
   */
  async _search_with_serpapi(query, max_results) {
    const api_key = this._getEnv('SERPAPI_API_KEY');
    const params = {
      api_key,
      engine: 'google',
      q: query,
      num: max_results,
      hl: 'zh-cn',
      gl: 'cn',
    };

    try {
      const data = await this._getJson(this.search_engines.serpapi.url, { params });

      const organic = Array.isArray(data?.organic_results) ? data.organic_results : [];
      return organic.slice(0, max_results).map((item) => ({
        title: item?.title ?? '',
        url: item?.link ?? '',
        snippet: item?.snippet ?? '',
        displayed_link: item?.displayed_link ?? '',
        date: item?.date ?? '',
        source: 'Google',
      }));
    } catch (e) {
      logger.error(`SerpApi搜索失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * 使用 Bing 搜索 API（对应 _search_with_bing）
   * @param {string} query
   * @param {number} max_results
   * @returns {Promise<Array<object>>}
   */
  async _search_with_bing(query, max_results) {
    const api_key = this._getEnv('BING_SEARCH_API_KEY');
    const headers = { 'Ocp-Apim-Subscription-Key': api_key ?? '' };
    const params = {
      q: query,
      count: max_results,
      mkt: 'zh-CN',
      safesearch: 'Moderate',
    };

    try {
      const data = await this._getJson(this.search_engines.bing.url, { params, headers });

      const value = Array.isArray(data?.webPages?.value) ? data.webPages.value : [];
      return value.slice(0, max_results).map((item) => ({
        title: item?.name ?? '',
        url: item?.url ?? '',
        snippet: item?.snippet ?? '',
        displayed_link: item?.displayUrl ?? '',
        date: String(item?.dateLastCrawled ?? '').slice(0, 10),
        source: 'Bing',
      }));
    } catch (e) {
      logger.error(`Bing搜索失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * 使用 DuckDuckGo 搜索（即时答案 API）（对应 _search_with_duckduckgo）
   * @param {string} query
   * @param {number} max_results
   * @returns {Promise<Array<object>>}
   */
  async _search_with_duckduckgo(query, max_results) {
    const params = {
      q: query,
      format: 'json',
      no_html: 1,
      skip_disambig: 1,
    };

    try {
      const data = await this._getJson(this.search_engines.duckduckgo.url, { params });

      // DuckDuckGo 返回的是即时答案，不是完整的搜索结果
      const results = [];
      if (data?.Abstract) {
        results.push({
          title: data?.Heading ?? query,
          url: data?.AbstractURL ?? '',
          snippet: data?.Abstract ?? '',
          displayed_link: data?.AbstractURL ?? '',
          source: 'DuckDuckGo',
        });
      }

      // 相关主题
      const related = Array.isArray(data?.RelatedTopics) ? data.RelatedTopics : [];
      for (const topic of related.slice(0, max_results - 1)) {
        if (topic && 'Text' in topic) {
          const text = topic?.Text ?? '';
          results.push({
            title: String(text).split(' - ')[0],
            url: topic?.FirstURL ?? '',
            snippet: text,
            source: 'DuckDuckGo',
          });
        }
      }

      return results;
    } catch (e) {
      logger.error(`DuckDuckGo搜索失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * 模拟搜索结果（用于测试）（对应 _mock_search）
   * @param {string} query
   * @param {number} max_results
   * @param {string} role
   * @returns {Promise<Array<object>>}
   */
  async _mock_search(query, max_results, role) {
    // 等待一下，模拟搜索延迟
    await sleep(1000);

    const mock_results = [
      {
        title: `关于${query}的最新研究`,
        url: 'https://example.com/research1',
        snippet: `这是关于${query}的详细研究，包含了最新的发现和见解...`,
        displayed_link: 'example.com',
        date: '2024-01-15',
        source: 'MockSearch',
      },
      {
        title: `${query}的实际应用案例`,
        url: 'https://example.com/case1',
        snippet: `本文介绍了${query}在真实世界中的应用案例...`,
        displayed_link: 'example.com',
        date: '2024-01-10',
        source: 'MockSearch',
      },
      {
        title: `专家观点：${query}的未来发展`,
        url: 'https://example.com/expert1',
        snippet: `行业专家分享了他们对${query}未来发展的看法...`,
        displayed_link: 'example.com',
        date: '2024-01-05',
        source: 'MockSearch',
      },
    ];

    return mock_results.slice(0, max_results);
  }

  /**
   * 处理搜索结果，根据角色添加额外信息（对应 _process_results）
   * @param {Array<object>} results
   * @param {string} role
   * @returns {Array<object>}
   */
  _process_results(results, role) {
    const processed = [];
    for (const result of results) {
      // 添加相关性评分
      result.relevance_score = this._calculate_relevance(result, role);

      // 提取关键信息
      result.key_points = this._extract_key_points(result.snippet ?? '');

      // 添加角色特定的分析
      result.role_analysis = this._analyze_for_role(result, role);

      processed.push(result);
    }

    // 按相关性排序（降序）
    processed.sort((a, b) => b.relevance_score - a.relevance_score);
    return processed;
  }

  /**
   * 计算结果与角色的相关性（对应 _calculate_relevance）
   * @param {object} result
   * @param {string} role
   * @returns {number}
   */
  _calculate_relevance(result, role) {
    const title = String(result?.title ?? '').toLowerCase();
    const snippet = String(result?.snippet ?? '').toLowerCase();
    const content = `${title} ${snippet}`.toLowerCase();

    const role_keywords = {
      技术专家: ['技术', '实现', '架构', '性能', '可扩展'],
      业务分析师: ['商业', '市场', '成本', '收益', 'roi'],
      行业专家: ['行业', '趋势', '标杆', '实践'],
      研究员: ['研究', '数据', '报告', '统计'],
      质疑者: ['风险', '问题', '挑战', '局限'],
      主持人: ['概述', '总结', '关键', '要点'],
    };

    let score = 0.5; // 基础分

    if (Object.prototype.hasOwnProperty.call(role_keywords, role)) {
      const keywords = role_keywords[role];
      for (const keyword of keywords) {
        if (content.includes(keyword)) {
          score += 0.1;
        }
      }
    }

    return Math.min(score, 1.0);
  }

  /**
   * 从文本中提取关键点（对应 _extract_key_points）
   * @param {string} text
   * @returns {Array<string>}
   */
  _extract_key_points(text) {
    // 简单的句子分割和过滤
    const sentences = String(text ?? '').split('。');
    const key_points = [];

    for (let sentence of sentences) {
      sentence = sentence.trim();
      if (sentence.length > 20 && !sentence.includes('?')) {
        key_points.push(sentence);
      }
    }

    return key_points.slice(0, 3); // 最多返回 3 个关键点
  }

  /**
   * 为特定角色分析搜索结果（对应 _analyze_for_role）
   * @param {object} result
   * @param {string} role
   * @returns {string}
   */
  _analyze_for_role(result, role) {
    const analysis = {
      技术专家: '技术实现需要考虑架构设计和性能优化',
      业务分析师: '需要评估商业价值和投资回报率',
      行业专家: '这与当前行业发展趋势相符',
      研究员: '需要更多的数据支持这一结论',
      质疑者: '可能存在未考虑到的风险因素',
      主持人: '这是讨论中的一个重要观点',
    };

    return analysis[role] ?? '值得关注的信息';
  }
}

export default WebSearchTool;
