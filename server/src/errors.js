// 用例层统一错误:throw new ApiError(msg, status) → transport 边界包成 fail 信封。
// 替代旧 handler 里的 `return fail(res, msg, status)`。
export class ApiError extends Error {
  constructor(message, status = 400, code = status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
