# 预置角色

## 角色定义

```python
PRESET_ROLES = {
    "project_admin": [
        "ask_data",
        "datasource_manage",
        "business_manage",
        "model_service_manage",
        "report_manage",
        "member_manage"
    ],
    "developer": [
        "ask_data",
        "datasource_manage",
        "business_manage"
    ],
    "analyst": [
        "ask_data",
        "report_manage"
    ],
    "viewer": [
        "ask_data"
    ]
}
```

## 权限矩阵

| 权限 \ 角色 | project_admin | developer | analyst | viewer |
|-------------|:-------------:|:---------:|:-------:|:------:|
| ask_data | ✅ | ✅ | ✅ | ✅ |
| datasource_manage | ✅ | ✅ | ❌ | ❌ |
| business_manage | ✅ | ✅ | ❌ | ❌ |
| model_service_manage | ✅ | ❌ | ❌ | ❌ |
| report_manage | ✅ | ❌ | ✅ | ❌ |
| member_manage | ✅ | ❌ | ❌ | ❌ |

## 角色分配

### 创建项目时

创建者自动成为 `project_admin`。

### 邀请成员时

管理员可指定新成员的角色：

```python
await MemberService.add_member(
    db=db,
    project_id=project_id,
    user_id=user_id,
    role="developer"  # 指定角色
)
```

### 修改角色

```python
await MemberService.update_member_role(
    db=db,
    project_id=project_id,
    member_id=member_id,
    new_role="analyst"
)
```

## 自定义角色

当前版本仅支持预置角色。自定义角色功能规划中。

## 角色继承

角色之间没有继承关系，每个角色的权限是独立定义的。

| 场景 | 说明 |
|------|------|
| 需要多种权限 | 选择包含所需权限的角色 |
| 权限不足 | 联系管理员升级角色 |
| 权限过多 | 联系管理员调整角色 |
