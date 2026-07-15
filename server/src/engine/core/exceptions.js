// 迁移自 backend/core/exceptions.py

/**
 * 统一异常处理模块
 *
 * 设计原则：
 * - 单一职责：只负责异常定义和处理
 * - 无特殊情况：所有错误都有明确的 HTTP 状态码
 * - 简洁性：使用最少的代码实现完整的错误处理
 *
 * 桌面版只需中文，t() 直接返回中文原文（消除多语言框架依赖）。
 */

// ---------------------------------------------------------------------------
// 极简 i18n：桌面版只用中文，直接回显 key
// ---------------------------------------------------------------------------

/**
 * 返回中文文案。key 可含 {} 占位符，args 按序替换。
 *
 * @param {string} key
 * @param {...*} args
 * @returns {string}
 */
function t(key, ...args) {
  let result = key;
  for (const arg of args) {
    result = result.replace('{}', String(arg));
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTTP 状态码常量（对应 Python fastapi.status）
// ---------------------------------------------------------------------------
export const HTTP_STATUS = Object.freeze({
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UNPROCESSABLE_ENTITY: 422,
  INTERNAL_SERVER_ERROR: 500,
});

// ---------------------------------------------------------------------------
// 基类
// ---------------------------------------------------------------------------

/**
 * API 错误基类（对应 Python BaseAPIError / HTTPException）。
 *
 * 携带结构化 detail，与 Python 响应格式对齐：
 * { success: false, message: string, detail: object }
 */
export class BaseAPIError extends Error {
  /**
   * @param {string} message 中文消息（key 传给 t()）
   * @param {number} statusCode HTTP 状态码
   * @param {Object} [detail={}] 附加细节
   */
  constructor(message, statusCode, detail = {}) {
    const translatedMessage = t(message);
    super(translatedMessage);
    this.name = new.target.name;
    this.statusCode = statusCode;
    /** 对齐 Python HTTPException.detail 结构 */
    this.detail = {
      success: false,
      message: translatedMessage,
      detail: detail || {},
    };
  }
}

// ---------------------------------------------------------------------------
// 具体异常类
// ---------------------------------------------------------------------------

/** 认证错误 (401) */
export class AuthenticationError extends BaseAPIError {
  constructor(message = '认证失败', detail = undefined) {
    super(message, HTTP_STATUS.UNAUTHORIZED, detail);
  }
}

/** 权限错误 (403) */
export class AuthorizationError extends BaseAPIError {
  constructor(message = '权限不足', detail = undefined) {
    super(message, HTTP_STATUS.FORBIDDEN, detail);
  }
}

/** 验证错误 (400) */
export class ValidationError extends BaseAPIError {
  constructor(message = '参数验证失败', detail = undefined) {
    super(message, HTTP_STATUS.BAD_REQUEST, detail);
  }
}

/** 资源不存在错误 (404) */
export class NotFoundError extends BaseAPIError {
  constructor(message = '资源不存在', detail = undefined) {
    super(message, HTTP_STATUS.NOT_FOUND, detail);
  }
}

/** 业务逻辑错误 (422) */
export class BusinessError extends BaseAPIError {
  constructor(message = '业务逻辑错误', detail = undefined) {
    super(message, HTTP_STATUS.UNPROCESSABLE_ENTITY, detail);
  }
}

/** 服务端错误 (500) */
export class ServiceError extends BaseAPIError {
  constructor(message = '服务端错误', detail = undefined) {
    super(message, HTTP_STATUS.INTERNAL_SERVER_ERROR, detail);
  }
}

/**
 * 业务信息性响应（校验提示，返回 200 状态码）。
 *
 * 用于业务规则校验的结果提示，不是错误也不是成功操作。
 * 响应格式同 successResponse，前端根据 _isInfoResponse 判断是否执行后续操作。
 *
 * 使用示例：
 *   throw new BusinessInfoResponse('您已是该项目成员');
 *   throw new BusinessInfoResponse('邀请链接已过期');
 */
export class BusinessInfoResponse extends Error {
  /**
   * @param {string} [message='业务信息提示']
   * @param {Object|null} [data=null]
   */
  constructor(message = '业务信息提示', data = null) {
    super(t(message));
    this.name = 'BusinessInfoResponse';
    this.response = {
      success: true,
      message: t(message),
      data: data || {},
      detail: {},
      _isInfoResponse: true,
    };
  }
}

// ---------------------------------------------------------------------------
// 便捷工厂函数（对应 Python 模块级函数）
// ---------------------------------------------------------------------------

/** 创建认证错误 */
export function authError(message = '认证失败', detail = undefined) {
  return new AuthenticationError(message, detail);
}

/** 创建权限错误 */
export function permissionError(message = '权限不足', detail = undefined) {
  return new AuthorizationError(message, detail);
}

/** 创建验证错误 */
export function validationError(message = '参数验证失败', detail = undefined) {
  return new ValidationError(message, detail);
}

/** 创建业务逻辑错误 */
export function businessError(message = '业务逻辑错误', detail = undefined) {
  return new BusinessError(message, detail);
}

/** 创建服务端错误 */
export function serviceError(message = '服务端错误', detail = undefined) {
  return new ServiceError(message, detail);
}
