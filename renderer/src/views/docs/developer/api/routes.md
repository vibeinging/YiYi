# 路由使用

## 权限依赖注入

在路由中使用权限检查：

```python
from api.dependencies.permission import (
    require_ask_data,
    require_datasource_manage,
    require_business_manage
)

# 查询类接口 - 需要基础查询权限
@router.get("/projects/{project_id}/business")
async def list_business(
    project_id: str,
    user_id: str = Depends(require_ask_data),
    db: AsyncSession = Depends(get_db)
):
    """获取业务列表 - 需要查询权限"""
    return await BusinessService.list_businesses(db, project_id)

# 管理类接口 - 需要业务管理权限
@router.post("/projects/{project_id}/business")
async def create_business(
    project_id: str,
    request: BusinessCreateRequest,
    user_id: str = Depends(require_business_manage),
    db: AsyncSession = Depends(get_db)
):
    """创建业务 - 需要管理权限"""
    return await BusinessService.create_business(
        db, project_id, user_id, request.name
    )
```

## 完整示例

```python
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.dependencies.database import get_db
from api.dependencies.permission import (
    require_ask_data,
    require_datasource_manage
)
from api.schemas.database import DatabaseCreate, DatabaseUpdate
from api.services.database_service import DatabaseService

router = APIRouter(prefix="/projects/{project_id}/databases")

@router.get("")
async def list_databases(
    project_id: str,
    user_id: str = Depends(require_ask_data),
    db: AsyncSession = Depends(get_db)
):
    """获取数据库列表"""
    return await DatabaseService.list_databases(db, project_id)

@router.post("")
async def create_database(
    project_id: str,
    request: DatabaseCreate,
    user_id: str = Depends(require_datasource_manage),
    db: AsyncSession = Depends(get_db)
):
    """创建数据库连接"""
    return await DatabaseService.create_database(
        db, project_id, user_id, request
    )

@router.put("/{database_id}")
async def update_database(
    project_id: str,
    database_id: str,
    request: DatabaseUpdate,
    user_id: str = Depends(require_datasource_manage),
    db: AsyncSession = Depends(get_db)
):
    """更新数据库连接"""
    return await DatabaseService.update_database(
        db, project_id, database_id, request
    )

@router.delete("/{database_id}")
async def delete_database(
    project_id: str,
    database_id: str,
    user_id: str = Depends(require_datasource_manage),
    db: AsyncSession = Depends(get_db)
):
    """删除数据库连接"""
    return await DatabaseService.delete_database(
        db, project_id, database_id
    )
```

## 权限选择原则

| 操作类型 | 推荐权限 |
|----------|----------|
| GET (查询) | `ask_data` 或对应管理权限 |
| POST (创建) | 对应管理权限 |
| PUT (更新) | 对应管理权限 |
| DELETE (删除) | 对应管理权限 |
