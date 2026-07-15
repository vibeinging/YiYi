# 前端适配

## API 调用规范

### 添加 projectId 参数

所有 API 函数需要传入 `projectId`：

```javascript
// 定义 API 函数
export function getTablesReq(projectId, connectionId) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables`,
    method: 'get'
  })
}

export function createDatabaseReq(projectId, data) {
  return request({
    url: `/api/projects/${projectId}/databases`,
    method: 'post',
    data
  })
}
```

### 组件中获取 projectId

```javascript
import { useProjectStore } from '@/store/project'

const projectStore = useProjectStore()

// 调用 API
const res = await getTablesReq(
  projectStore.currentProjectId,
  connectionId
)
```

## 权限控制

### 菜单权限

根据用户权限显示/隐藏菜单：

```javascript
import { usePermissionStore } from '@/store/permission'

const permissionStore = usePermissionStore()

// 检查权限
const canManageDatasource = computed(() =>
  permissionStore.hasPermission('datasource_manage')
)
```

### 按钮权限

```vue
<template>
  <el-button
    v-if="canManage"
    @click="handleCreate"
  >
    新建数据源
  </el-button>
</template>

<script setup>
import { usePermissionStore } from '@/store/permission'

const permissionStore = usePermissionStore()
const canManage = computed(() =>
  permissionStore.hasPermission('datasource_manage')
)
</script>
```

## 错误处理

### 403 权限错误

```javascript
// axios 拦截器
service.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 403) {
      ElMessage.error('权限不足，请联系管理员')
    }
    return Promise.reject(error)
  }
)
```

### 401 认证错误

```javascript
if (error.response?.status === 401) {
  // 清除登录状态
  userStore.logout()
  // 跳转登录页
  router.push('/login')
}
```

## 注意事项

> **重要**
>
> - 所有 API 调用都需要传入正确的 `projectId`
> - 否则会返回 403 权限错误
> - `projectId` 从 `useProjectStore` 获取

## 完整示例

```vue
<template>
  <div class="database-list">
    <div class="header">
      <h2>数据源管理</h2>
      <el-button
        v-if="hasManagePermission"
        type="primary"
        @click="handleCreate"
      >
        新建数据源
      </el-button>
    </div>

    <el-table :data="databases" v-loading="loading">
      <el-table-column prop="name" label="名称" />
      <el-table-column prop="type" label="类型" />
      <el-table-column label="操作" v-if="hasManagePermission">
        <template #default="{ row }">
          <el-button size="small" @click="handleEdit(row)">编辑</el-button>
          <el-button size="small" type="danger" @click="handleDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useProjectStore } from '@/store/project'
import { usePermissionStore } from '@/store/permission'
import { getDatabasesReq, deleteDatabaseReq } from '@/api/database'

const projectStore = useProjectStore()
const permissionStore = usePermissionStore()

const databases = ref([])
const loading = ref(false)

const hasManagePermission = computed(() =>
  permissionStore.hasPermission('datasource_manage')
)

const loadDatabases = async () => {
  loading.value = true
  try {
    const res = await getDatabasesReq(projectStore.currentProjectId)
    databases.value = res.data
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadDatabases()
})
</script>
```
