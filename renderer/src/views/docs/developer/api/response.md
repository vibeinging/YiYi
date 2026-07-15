# 响应格式

## 标准响应结构

### 成功响应

```json
{
  "success": true,
  "message": "操作成功",
  "data": {
    // 业务数据
  }
}
```

### 错误响应

```json
{
  "success": false,
  "message": "错误描述",
  "detail": {
    // 错误详情（可选）
  }
}
```

## HTTP 状态码

| 状态码 | 说明 | 使用场景 |
|--------|------|----------|
| 200 | 请求成功 | GET、PUT、DELETE 成功 |
| 201 | 创建成功 | POST 创建资源成功 |
| 400 | 请求参数错误 | 参数校验失败 |
| 401 | 未认证 | Token 无效或过期 |
| 403 | 权限不足 | 无权访问资源 |
| 404 | 资源不存在 | 请求的资源不存在 |
| 422 | 业务逻辑错误 | 业务规则不满足 |
| 500 | 服务器错误 | 服务端异常 |

## 异常类使用

```python
from core.exceptions import (
    auth_error,           # 401 - 认证失败
    permission_error,     # 403 - 权限不足
    not_found_error,      # 404 - 资源不存在
    validation_error,     # 400 - 参数错误
    business_error,       # 422 - 业务错误
    service_error         # 500 - 服务错误
)

# 认证失败
raise auth_error("Token 已过期")

# 权限不足
raise permission_error("需要管理员权限")

# 资源不存在
raise not_found_error("数据库连接不存在")

# 参数错误
raise validation_error("数据库名称不能为空")

# 业务错误
raise business_error("数据库连接已存在")

# 服务错误
raise service_error("连接数据库失败")
```

## 分页响应

```json
{
  "success": true,
  "message": "查询成功",
  "data": {
    "items": [
      // 数据列表
    ],
    "total": 100,
    "page": 1,
    "page_size": 20,
    "pages": 5
  }
}
```

## 前端处理

```javascript
// axios 响应拦截器
service.interceptors.response.use(
  response => {
    const res = response.data

    if (!res.success) {
      ElMessage.error(res.message || '请求失败')
      return Promise.reject(new Error(res.message))
    }

    return res
  },
  error => {
    const status = error.response?.status
    const message = error.response?.data?.message

    switch (status) {
      case 401:
        ElMessage.error('登录已过期，请重新登录')
        // 跳转登录
        break
      case 403:
        ElMessage.error(message || '权限不足')
        break
      case 404:
        ElMessage.error(message || '资源不存在')
        break
      default:
        ElMessage.error(message || '请求失败')
    }

    return Promise.reject(error)
  }
)
```
