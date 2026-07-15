# 最佳实践

## 1. 权限检查原则

### 路由层检查权限

所有权限验证在路由层完成：

```python
@router.post("/projects/{project_id}/databases")
async def create_database(
    project_id: str,
    user_id: str = Depends(require_datasource_manage),  # 路由层检查
    db: AsyncSession = Depends(get_db)
):
    # 服务层不检查权限
    return await DatabaseService.create_database(db, project_id, request)
```

### 服务层数据隔离

服务层只负责基于 `project_id` 的数据过滤：

```python
class DatabaseService:
    @staticmethod
    async def list_databases(db: AsyncSession, project_id: str):
        # 按 project_id 过滤
        stmt = select(Database).where(
            Database.project_id == project_id,
            Database.deleted_at.is_(None)
        )
        return await db.execute(stmt)
```

### 最小权限原则

每个接口只分配必要的最小权限：

```python
# ✅ 正确：查询只需要 ask_data
@router.get("/projects/{project_id}/data")
async def query_data(user_id: str = Depends(require_ask_data)):
    pass

# ❌ 错误：查询不需要管理权限
@router.get("/projects/{project_id}/data")
async def query_data(user_id: str = Depends(require_datasource_manage)):
    pass
```

## 2. 缓存策略

### 缓存 Key 规范

缓存 Key 必须包含 `project_id`：

```python
# ✅ 正确
cache_key = f"project:{project_id}:databases"

# ❌ 错误：可能导致数据泄漏
cache_key = f"databases:{database_id}"
```

### 缓存失效

```python
async def clear_project_cache(project_id: str):
    """清除项目相关的所有缓存"""
    pattern = f"project:{project_id}:*"
    await redis.delete_pattern(pattern)
```

### 敏感数据不缓存

```python
# ❌ 不要缓存
cache_key = f"project:{project_id}:db_password"

# ✅ 每次从数据库读取
password = await get_encrypted_password(database_id)
```

## 3. 数据隔离

### 查询添加过滤条件

```python
# 所有查询添加 project_id 过滤
stmt = select(Table).where(
    Table.project_id == project_id,  # 项目隔离
    Table.deleted_at.is_(None)        # 软删除过滤
)
```

### 关联查询验证

```python
async def get_table(db, project_id: str, table_id: str):
    table = await db.get(Table, table_id)

    # 验证资源属于当前项目
    if table.project_id != project_id:
        raise PermissionError("Access denied")

    return table
```

## 4. 错误处理

使用标准异常类：

```python
from core.exceptions import (
    auth_error,           # 401
    permission_error,     # 403
    not_found_error,      # 404
    validation_error,     # 400
    business_error,       # 422
    service_error         # 500
)

if not has_permission:
    raise permission_error("权限不足")
```
