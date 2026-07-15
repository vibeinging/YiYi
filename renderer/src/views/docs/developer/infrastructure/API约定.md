# API 交互规范

## 概述

本文档定义了系统前后端交互的规范，包括 HTTP 状态码使用、错误处理、响应格式等标准。

## 设计原则

### 式设计理念

- **单一职责**: 每个错误类型都有明确的 HTTP 状态码
- **无特殊情况**: 消除复杂的错误码判断，依赖标准 HTTP 语义
- **简洁性**: 使用最少的代码实现完整的错误处理
- **实用性**: 错误处理既要准确又要易于维护

## HTTP 状态码规范

### 成功响应

- **200 OK**: 请求成功，返回数据

### 客户端错误 (4xx)

- **400 Bad Request**: 参数验证失败、请求格式错误
- **401 Unauthorized**: 认证失败、令牌无效或过期
- **403 Forbidden**: 权限不足、访问被拒绝
- **404 Not Found**: 请求的资源不存在
- **422 Unprocessable Entity**: 业务逻辑错误、数据验证失败

### 服务端错误 (5xx)

- **500 Internal Server Error**: 服务器内部错误、数据库连接失败等

## 响应格式规范

### 成功响应格式

```json
{
  "success": true,
  "message": "操作成功",
  "data": {
    // 具体数据
  }
}
```

### 错误响应格式

```json
{
  "success": false,
  "message": "错误描述",
  "detail": {
    // 详细错误信息（可选）
  }
}
```

## 状态码与错误类型映射

| HTTP 状态码 | 错误类型     | 说明                             |
| ----------- | ------------ | -------------------------------- |
| 400         | 参数验证错误 | 请求参数格式错误、缺少必需参数   |
| 401         | 认证失败     | 令牌无效、令牌过期、用户不存在   |
| 403         | 权限不足     | 用户权限不足、访问被拒绝         |
| 404         | 资源不存在   | 用户、数据库、会话、任务等不存在 |
| 422         | 业务逻辑错误 | 业务规则违反、数据冲突、状态异常 |
| 500         | 服务端错误   | 服务器内部故障、数据库连接失败   |

## 前端处理规范

### 成功响应处理

```javascript
// 只检查 success 字段
const { success, data } = response.data;

if (success === true) {
  // 处理成功数据
  return data;
}
```

### 错误响应处理

```javascript
// 只依赖 HTTP 状态码
if (status === 401) {
  // 跳转登录页
  window.location.href = "/login";
}

if (status === 403) {
  // 显示权限错误
  showMessage("权限不足");
}

if (status === 404) {
  // 显示资源不存在
  showMessage("资源不存在");
}

if (status === 422) {
  // 显示业务逻辑错误
  showMessage("请求处理失败");
}

if (status === 400) {
  // 显示参数错误
  showMessage("请求参数错误");
}
```

### 认证跳转逻辑

```javascript
if (status === 401) {
  // 清除用户信息
  store.setToken("");
  store.setUserInfo({ userInfo: null, roles: [], codes: [] });

  // 跳转登录页（带重定向）
  if (window.location.pathname !== "/login") {
    window.location.href = `/login?redirect=${encodeURIComponent(
      window.location.pathname
    )}`;
  }
}
```

## 后端实现规范

### 异常类使用

```python
from core.exceptions import (
    auth_error,           # 401
    permission_error,     # 403
    user_not_found_error, # 404
    validation_error,    # 400
    business_error,      # 422
    service_error        # 500
)

# 使用示例
if not user:
    raise user_not_found_error("用户不存在")

if not has_permission:
    raise permission_error("权限不足")

if not validate_params(params):
    raise validation_error("参数验证失败")
```

### 全局异常处理

```python
@app.exception_handler(BaseAPIError)
async def api_exception_handler(request: Request, exc: BaseAPIError):
    """自定义API异常处理"""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "success": False,
            "code": exc.error_code.value,
            "message": exc.detail.get("message", str(exc)),
            "detail": exc.detail.get("detail", {})
        }
    )
```

## 特殊场景处理

### ignoreMsg 机制

允许前端指定不显示错误信息：

```javascript
// 不显示错误信息
axiosReq({
  url: "/api/data",
  ignoreMsg: true,
});
```

## 网络错误处理

```javascript
// 网络错误或无响应
if (!err.response) {
  showMessage("网络连接失败，请检查网络设置");
  return;
}
```

## 版本兼容性

### 响应格式说明

- **成功判断**: 使用 `success: boolean` 字段
- **错误分类**: 完全依赖 HTTP 状态码
- **错误信息**: 使用 `message` 字段，支持 `msg` 字段作为回退

## 最佳实践

### 后端开发

1. **使用合适的异常类**: 根据错误类型选择正确的异常
2. **提供清晰的错误信息**: 错误信息应该具体且有用
3. **保持一致性**: 同类错误使用相同的错误码
4. **记录错误日志**: 所有异常都应该记录到日志系统

### 前端开发

1. **依赖 HTTP 状态码**: 只使用 HTTP 状态码判断错误类型
2. **处理网络错误**: 区分网络问题和服务器问题
3. **用户友好提示**: 错误提示要用户友好
4. **自动跳转**: 认证失败自动跳转登录页

### 调试和监控

1. **状态码统计**: 基于 HTTP 状态码进行错误统计
2. **响应时间监控**: 监控不同状态码的响应时间
3. **用户行为分析**: 分析错误对用户行为的影响

## 示例场景

### 用户登录

```http
POST /api/user/login
```

**成功响应**:

```json
{
  "success": true,
  "message": "登录成功",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "user": {...}
  }
}
```

**错误响应**:

```json
{
  "success": false,
  "message": "密码错误",
  "detail": {}
}
```

### 数据库连接

```http
POST /api/database/test
```

**成功响应**:

```json
{
  "success": true,
  "message": "连接成功",
  "data": {
    "status": "connected"
  }
}
```

**错误响应**:

```json
{
  "success": false,
  "message": "数据库连接失败",
  "detail": {
    "error": "Connection refused"
  }
}
```

## 更新日志

### v2.0.0 (2025-09-26)

- 完全基于 HTTP 状态码的错误处理
- 移除业务错误码，简化前后端交互
- 统一响应格式规范
- 简化前端错误处理逻辑
- 完善异常处理机制
