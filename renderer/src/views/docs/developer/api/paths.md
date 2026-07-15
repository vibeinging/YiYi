# API 路径规范

## 路径格式

所有项目资源的 API 路径格式：

```
/api/projects/{project_id}/{resource}
/api/projects/{project_id}/{resource}/{resource_id}
```

## 资源路径表

| 资源类型 | 路径格式 | 说明 |
|----------|----------|------|
| 数据库连接 | `/projects/{pid}/databases/{cid}` | 单个数据库连接 |
| 表 | `/projects/{pid}/databases/{cid}/tables/{tid}` | 数据库中的表 |
| 列 | `/projects/{pid}/databases/{cid}/columns/{col_id}` | 表中的列 |
| 业务 | `/projects/{pid}/businesses/{bid}` | 业务定义 |
| 成员 | `/projects/{pid}/members/{mid}` | 项目成员 |
| 报表 | `/projects/{pid}/dashboards/{did}` | 仪表盘 |

## 路径参数

| 参数 | 说明 | 格式 |
|------|------|------|
| `project_id` | 项目 ID | UUID |
| `database_id` | 数据库连接 ID | UUID |
| `table_id` | 表 ID | UUID |
| `business_id` | 业务 ID | UUID |
| `member_id` | 成员 ID | UUID |

## 查询参数

### 分页

```
GET /projects/{pid}/databases?page=1&page_size=20
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `page` | 页码 | 1 |
| `page_size` | 每页数量 | 20 |

### 搜索

```
GET /projects/{pid}/databases?keyword=mysql
```

### 排序

```
GET /projects/{pid}/databases?order_by=created_at&order=desc
```

## 示例

### 获取项目的所有数据库

```
GET /api/projects/550e8400-e29b-41d4-a716-446655440000/databases
```

### 获取单个数据库详情

```
GET /api/projects/550e8400-e29b-41d4-a716-446655440000/databases/123e4567-e89b-12d3-a456-426614174000
```

### 获取数据库的表列表

```
GET /api/projects/550e8400-e29b-41d4-a716-446655440000/databases/123e4567-e89b-12d3-a456-426614174000/tables
```
