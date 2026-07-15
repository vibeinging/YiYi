# 权限代码

## 权限枚举定义

```python
class PermissionCode(str, Enum):
    """权限代码枚举"""
    ASK_DATA = "ask_data"                        # 查询数据
    DATASOURCE_MANAGE = "datasource_manage"      # 管理数据源
    BUSINESS_MANAGE = "business_manage"          # 管理业务定义
    MODEL_SERVICE_MANAGE = "model_service_manage" # 管理AI服务
    REPORT_MANAGE = "report_manage"              # 管理报表
    MEMBER_MANAGE = "member_manage"              # 管理成员
```

## 权限说明

| 权限代码 | 说明 | 典型操作 |
|----------|------|----------|
| `ask_data` | 查询数据 | 智能问数、查看结果 |
| `datasource_manage` | 管理数据源 | 添加/编辑/删除数据库连接 |
| `business_manage` | 管理业务 | 配置业务实体、指标、样例 |
| `model_service_manage` | 管理 AI 服务 | 配置 LLM 模型 |
| `report_manage` | 管理报表 | 创建/编辑仪表盘 |
| `member_manage` | 管理成员 | 邀请/移除成员、分配角色 |

## 使用方式

### 路由依赖注入

```python
from api.dependencies.permission import PermissionChecker

@router.get("/projects/{project_id}/data")
async def query_data(
    project_id: str,
    user_id: str = Depends(PermissionChecker(["ask_data"]))
):
    """需要 ask_data 权限"""
    pass
```

### 快捷依赖

```python
from api.dependencies.permission import (
    require_ask_data,
    require_datasource_manage,
    require_business_manage,
    require_model_service_manage,
    require_report_manage,
    require_member_manage
)

@router.post("/projects/{project_id}/databases")
async def add_database(
    project_id: str,
    user_id: str = Depends(require_datasource_manage)
):
    """需要 datasource_manage 权限"""
    pass
```

## 权限检查流程

```
请求 → 提取 Token → 验证用户 → 获取项目成员关系
                                    ↓
                              检查角色权限
                                    ↓
                            ✅ 通过 / ❌ 403
```

## 注意事项

> **重要**
>
> - 所有项目资源接口都需要权限检查
> - 权限检查在路由层完成，服务层只负责数据过滤
> - 组合多个权限使用 `PermissionChecker(["perm1", "perm2"])`
