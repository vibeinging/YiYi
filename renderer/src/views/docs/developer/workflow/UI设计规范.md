# UI 设计规范

## 概述

本文档定义了 YiW 项目的前端 UI 设计规范，采用现代化的 iOS 风格设计语言，强调简洁、优雅和一致性。

**设计理念**：

- **简洁优先**：减少视觉噪音，突出核心内容
- **统一体验**：所有页面使用一致的布局和交互模式
- **流畅动效**：平滑的过渡和动画提升用户体验
- **响应式设计**：适配不同屏幕尺寸

---

## 一、主题色彩

### 1.1 主色调 - YiW 深绿

```scss
$primary-color: #17483e; // 主要操作按钮、强调文字
$primary-gradient: linear-gradient(135deg, #17483e 0%, #2f6f60 100%);
```

**使用场景**：

- Active 状态的 tab 文字颜色
- 主要操作按钮（primary button）
- 重要图标
- 链接文字

### 1.2 中性色

```scss
// 文字颜色
$text-primary: #303133; // 主要文字
$text-regular: #606266; // 常规文字
$text-secondary: #909399; // 次要文字
$text-placeholder: #c0c4cc; // 占位符

// 背景色
$bg-primary: #ffffff; // 主要背景（卡片）
$bg-secondary: #f8f9fa; // 次要背景（容器、分组）
$bg-tertiary: #f5f7fa; // 三级背景

// 边框色
$border-light: #e6e6e6; // 浅色边框
$border-base: #dcdfe6; // 常规边框
$border-dark: #c0c4cc; // 深色边框
```

### 1.3 功能色

```scss
$success-color: #67c23a; // 成功状态
$warning-color: #e6a23c; // 警告状态
$danger-color: #f56c6c; // 危险操作、错误
$info-color: #409eff; // 信息提示、链接
```

---

## 二、布局系统

### 2.1 整体布局结构

采用 Flexbox 布局，确保内容垂直填充：

```scss
.tab-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 0;
}
```

### 2.2 卡片系统

#### 统一白色背景卡片

所有内容区域使用统一的白色卡片：

```scss
.content-card {
  background: #ffffff;
  border-radius: 12px;
  padding: 0 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

  &:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  }
}
```

**关键特性**：

- 圆角 `12px`
- 微妙的阴影 `0 1px 3px rgba(0, 0, 0, 0.06)`
- Hover 时增强阴影效果
- Flex 布局确保垂直填充

#### 其他卡片类型

```scss
// 操作卡片（顶部操作区）
.operations-card {
  background: #ffffff;
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
  flex-shrink: 0;
}

// 搜索卡片
.search-card {
  background: #ffffff;
  border-radius: 12px;
  padding: 16px 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
  flex-shrink: 0;
}
```

### 2.3 间距规范

```scss
// 标准间距
$spacing-xs: 4px;
$spacing-sm: 8px;
$spacing-md: 12px;
$spacing-lg: 16px;
$spacing-xl: 20px;
$spacing-xxl: 24px;

// 使用示例
gap: 8px; // 按钮之间的水平间距
row-gap: 12px; // 按钮换行时的垂直间距
margin-bottom: 16px; // 区块之间的间距
padding: 20px; // 卡片内边距
```

---

## 三、组件规范

### 3.1 Tab 标签页

#### iOS 风格 Tabs (推荐)

模仿 iOS Segmented Control 的胶囊式设计：

```vue
<el-tabs class="ios-tabs" type="border-card">
  <el-tab-pane label="表信息" name="table-info">
    <!-- 内容 -->
  </el-tab-pane>
</el-tabs>
```

**视觉特征**：

- 灰色圆角容器 `background: #f8f9fa` + `border-radius: 12px`
- Active tab 为白色卡片，带微妙阴影
- 非 active tab 悬停时显示半透明背景
- 隐藏滚动条，支持平滑滚动
- Active tab 自动居中显示

**样式定义**：

```scss
.ios-tabs.el-tabs {
  .el-tabs__nav-wrap {
    padding-top: 10px;
    background-color: #f8f9fa;
    border-radius: 12px;
  }

  .el-tabs__item {
    height: 40px;
    padding: 0 20px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 500;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);

    &.is-active {
      color: #17483e;
      background: #ffffff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
      font-weight: 600;
    }

    &:hover:not(.is-active) {
      background-color: rgba(0, 0, 0, 0.04);
    }
  }
}
```

#### Tab 居中滚动

当 tab 过多时，active tab 应自动滚动到中心位置：

```javascript
const scrollActiveTabToCenter = () => {
  const activeTab = document.querySelector(".el-tabs__item.is-active");
  const navScroll = document.querySelector(".el-tabs__nav-scroll");

  if (!activeTab || !navScroll) return;

  const tabCenter = activeTab.offsetLeft + activeTab.offsetWidth / 2;
  const navCenter = navScroll.offsetWidth / 2;
  const scrollLeft = tabCenter - navCenter;

  navScroll.scrollTo({
    left: scrollLeft,
    behavior: "smooth",
  });
};
```

### 3.2 按钮

#### 按钮类型

```vue
<!-- 主要按钮 - 用于页面主操作 -->
<el-button type="primary">确定</el-button>

<!-- 默认按钮 - 用于次要操作 -->
<el-button type="default">取消</el-button>

<!-- 朴素按钮（描边） -->
<el-button type="primary" plain>生成</el-button>

<!-- 文字按钮 -->
<el-button type="text">展开</el-button>
```

#### 表格操作按钮

表格内的操作按钮使用链接文字样式（不带 type），**必须添加图标**：

```vue
<!-- 生成向量按钮 -->
<el-button size="small" @click="handleGenerate">
  <el-icon><Connection /></el-icon>
  生成向量
</el-button>

<!-- 删除按钮 -->
<el-button size="small" @click="handleDelete">
  <el-icon><Delete /></el-icon>
  删除
</el-button>

<!-- 编辑按钮 -->
<el-button size="small" @click="handleEdit">
  <el-icon><Edit /></el-icon>
  编辑
</el-button>

<!-- 查看按钮 -->
<el-button size="small" @click="handleView">
  <el-icon><View /></el-icon>
  查看
</el-button>
```

**规范说明**：

- 不使用 `type="primary"` 或 `type="danger"`，保持简洁
- 每个操作按钮必须带有对应的图标
- 图标放在文字前面，使用 `<el-icon>` 包裹
- 常用图标：`Connection`（生成）、`Delete`（删除）、`Edit`（编辑）、`View`（查看）、`Download`（下载）、`Refresh`（刷新）

#### 按钮组布局

批量操作按钮使用 flex 布局，支持自动换行：

```scss
.action-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px; // 水平间距
  row-gap: 12px; // 垂直间距（换行时）
}
```

#### 按钮尺寸

```vue
<el-button size="large">大按钮</el-button>
<!-- 高度 40px -->
<el-button size="default">默认</el-button>
<!-- 高度 32px -->
<el-button size="small">小按钮</el-button>
<!-- 高度 24px -->
```

### 3.3 表格

#### 标准表格

```vue
<div class="table-container">
  <el-table
    :data="tableData"
    stripe
    style="width: 100%"
    height="100%"
  >
    <el-table-column prop="name" label="名称" />
    <el-table-column prop="type" label="类型" />
  </el-table>
</div>
```

**关键特性**：

- 使用斑马纹 `stripe`
- 表格容器使用 flex 布局，高度自适应
- 列对齐使用 `align="center"`

#### 表格容器布局

```scss
.table-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
```

### 3.4 分页

```vue
<div class="column-pagination">
  <el-pagination
    v-model:current-page="currentPage"
    :page-size="pageSize"
    :total="total"
    layout="prev, pager, next, total"
    @current-change="handlePageChange"
  />
</div>
```

```scss
.column-pagination {
  flex-shrink: 0;
  margin-top: 16px;
  padding: 10px 0;
  display: flex;
  justify-content: center;
  background: #fff;
}
```

### 3.5 对话框

#### 标准对话框

```vue
<el-dialog
  v-model="dialogVisible"
  title="对话框标题"
  width="60%"
  :close-on-click-modal="false"
>
  <div class="dialog-content">
    <!-- 内容 -->
  </div>

  <template #footer>
    <div class="dialog-footer">
      <el-button @click="handleCancel">取消</el-button>
      <el-button type="primary" @click="handleConfirm">确定</el-button>
    </div>
  </template>
</el-dialog>
```

**规范**：

- 宽度使用百分比 `width="60%"`，适配不同屏幕
- 禁止点击遮罩关闭 `:close-on-click-modal="false"`
- Footer 按钮右对齐，使用 flex 布局

```scss
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
```

### 3.6 文本展开/收起

长文本默认收起，超过阈值显示展开按钮：

```vue
<div class="text-collapse" :class="{ expanded: isExpanded }">
  <strong>标题:</strong>
  <span class="text-content">
    {{ longText }}
  </span>
  <el-button
    v-if="longText && longText.length > 50"
    type="text"
    size="small"
    @click="isExpanded = !isExpanded"
  >
    {{ isExpanded ? '收起' : '展开' }}
  </el-button>
</div>
```

```scss
.text-collapse {
  display: flex;
  align-items: center;
  gap: 8px;

  .text-content {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    transition: all 0.3s ease;
  }

  &.expanded .text-content {
    -webkit-line-clamp: unset;
    overflow: visible;
  }
}
```

### 3.7 Empty 状态

```vue
<div class="empty-placeholder">
  <el-empty description="暂无数据">
    <el-button type="primary" @click="handleAction">
      操作按钮
    </el-button>
  </el-empty>
</div>
```

```scss
.empty-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  flex: 1;
}
```

### 3.8 Loading 状态

```vue
<div class="loading-placeholder">
  <div class="loading-content">
    <el-icon class="loading-icon" :size="48">
      <Loading />
    </el-icon>
    <div class="loading-text">正在加载...</div>
    <div class="loading-subtext">请稍候</div>
  </div>
</div>
```

```scss
.loading-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  flex: 1;

  .loading-icon {
    color: #17483e;
    animation: rotate 2s linear infinite;
  }
}

@keyframes rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
```

---

## 四、动画与过渡

### 4.1 标准过渡

使用 cubic-bezier 缓动函数实现流畅动画：

```scss
transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
```

### 4.2 常见动画场景

#### Hover 效果

```scss
// 卡片 Hover
.card {
  transition: box-shadow 0.3s cubic-bezier(0.4, 0, 0.2, 1);

  &:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  }
}

// 按钮 Hover
.button {
  transition: all 0.2s ease;

  &:hover {
    background-color: rgba(0, 0, 0, 0.04);
  }
}
```

#### Tab 切换动画

```scss
.el-tabs__item {
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
```

#### 展开/收起动画

```scss
.text-content {
  transition: all 0.3s ease;
}
```

---

## 五、响应式设计

### 5.1 断点

```scss
// 移动端
@media (max-width: 768px) {
  .operations-header {
    flex-direction: column;
    gap: 12px;
  }

  .header-actions {
    justify-content: center;
  }
}

// 平板
@media (max-width: 1024px) {
  .content-card {
    padding: 16px;
  }
}
```

### 5.2 栅格布局

使用 CSS Grid 实现多列布局（如实体管理三列布局）：

```scss
.grid-layout {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 20px;
  height: 100%;
}

@media (max-width: 1024px) {
  .grid-layout {
    grid-template-columns: 1fr;
  }
}
```

---

## 六、交互规范

### 6.1 批量操作

批量操作统一放在页面顶部操作区：

```vue
<div class="operations-header">
  <div class="header-actions">
    <el-button type="danger" plain @click="handleBatchDelete">
      批量删除
    </el-button>
    <el-button type="primary" @click="handleBatchGenerate">
      批量生成
    </el-button>
  </div>
</div>
```

**原则**：

- 批量删除按钮使用危险色 `type="danger"`
- 危险操作必须二次确认
- 操作完成后显示成功/失败统计

### 6.2 确认对话框

危险操作使用 `ElMessageBox.confirm`：

```javascript
try {
  await ElMessageBox.confirm("确定要删除吗？此操作不可恢复！", "⚠️ 删除确认", {
    confirmButtonText: "确定删除",
    cancelButtonText: "取消",
    type: "warning",
    distinguishCancelAndClose: true,
  });

  // 执行删除操作
} catch (error) {
  if (error !== "cancel") {
    ElMessage.error("操作失败");
  }
}
```

### 6.3 反馈提示

```javascript
// 成功提示
ElMessage.success("操作成功");

// 警告提示
ElMessage.warning("请先选择数据");

// 错误提示
ElMessage.error("操作失败");

// 信息提示
ElMessage.info("正在处理...");
```

### 6.4 Loading 状态

```javascript
// 按钮 loading
const loading = ref(false);

const handleAction = async () => {
  loading.value = true;
  try {
    await doSomething();
  } finally {
    loading.value = false;
  }
};
```

```vue
<el-button :loading="loading" @click="handleAction">
  提交
</el-button>
```

---

## 七、辅助类

### 7.1 共享样式

所有页面导入共享样式：

```scss
@import "./shared-styles.scss";
```

### 7.2 常用工具类

```scss
// 文字截断
.text-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// 多行截断
.text-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

// Flex 居中
.flex-center {
  display: flex;
  align-items: center;
  justify-content: center;
}
```

---

## 八、文件组织

### 8.1 目录结构

```
webui/src/
├── theme/yiw-warm/          # 主题目录
│   ├── index.scss                  # 主题入口
│   ├── custom/
│   │   └── ios-style.scss          # iOS 风格自定义样式
│   └── element-plus/
│       └── tabs.scss               # Tab 组件样式覆盖
├── views/
│   └── database/
│       ├── index.vue               # 数据库页面主入口
│       └── components/
│           ├── shared-styles.scss  # 共享样式
│           ├── DatabaseTableInfo.vue
│           ├── TableStructureView.vue
│           ├── TableBatchActions.vue
│           └── EntityManager.vue
```

### 8.2 组件命名

- **大驼峰命名**：`TableStructureView.vue`
- **多单词组件名**：避免单个单词（如 `Table.vue`）
- **有意义的名称**：名称应准确描述组件功能

---

## 九、可访问性

### 9.1 语义化 HTML

```vue
<!-- 好 -->
<header class="page-header">
  <h1>页面标题</h1>
</header>

<!-- 不好 -->
<div class="page-header">
  <div class="title">页面标题</div>
</div>
```

### 9.2 键盘导航

确保所有交互元素可通过键盘访问：

- 使用 `<button>` 而不是 `<div>` + `@click`
- Tab 键可以遍历所有可交互元素
- Enter/Space 可以触发按钮

---

## 十、性能优化

### 10.1 虚拟滚动

大数据列表使用虚拟滚动：

```vue
<el-table :data="largeDataset" height="600" virtual-scroll />
```

### 10.2 懒加载

Tab 内容懒加载：

```javascript
const loadTableColumns = async (tableId) => {
  if (!table.columns || table.columns.length === 0) {
    const res = await getTableColumnsReq(databaseId, tableId);
    table.columns = res.data.items;
  }
};
```

### 10.3 防抖与节流

搜索框使用防抖：

```javascript
import { debounce } from "lodash-es";

const handleSearch = debounce((keyword) => {
  // 搜索逻辑
}, 300);
```

---

## 十一、开发规范

### 11.1 组件模板

```vue
<template>
  <div class="component-name">
    <!-- 内容 -->
  </div>
</template>

<script setup>
import { ref, computed, watch } from "vue";
import { ElMessage } from "element-plus";

const props = defineProps({
  // props 定义
});

const emit = defineEmits(["event-name"]);

// 响应式数据
const loading = ref(false);

// 计算属性
const computedValue = computed(() => {
  // 计算逻辑
});

// 方法
const handleAction = async () => {
  // 处理逻辑
};
</script>

<style lang="scss" scoped>
@import "./shared-styles.scss";

.component-name {
  // 样式
}
</style>
```

### 11.2 代码风格

- 使用 `<script setup>` 语法
- Props 和 emits 使用 `defineProps` 和 `defineEmits`
- 样式使用 `scoped` 避免污染
- 使用 SCSS 嵌套语法
- 遵循 2 空格缩进

### 11.3 注释规范

```javascript
// 单行注释用于简短说明

/**
 * 多行注释用于复杂逻辑
 * 说明函数功能、参数、返回值
 */
const complexFunction = (param) => {
  // 实现
};
```

---

## 十二、检查清单

在提交代码前，确保：

- [ ] 使用统一的白色卡片布局
- [ ] Tab 使用 iOS 风格
- [ ] 按钮间距使用 gap 布局
- [ ] 危险操作有二次确认
- [ ] Loading 状态正确显示
- [ ] 空状态有友好提示
- [ ] 长文本支持展开/收起
- [ ] 表格高度自适应
- [ ] 分页器正确显示
- [ ] Hover 效果流畅
- [ ] 动画使用标准过渡
- [ ] 响应式适配移动端
- [ ] 代码通过 ESLint 检查

---

## 附录

### 相关文件

- `webui/src/theme/yiw-warm/element-plus/tabs.scss` - Tab 样式
- `webui/src/views/database/components/shared-styles.scss` - 共享样式
- `webui/src/views/database/components/TableStructureView.vue` - 表结构视图示例

### 参考资源

- [Element Plus 官方文档](https://element-plus.org/)
- [iOS Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
- [Material Design](https://material.io/design)

---

**文档版本**: v1.0
**最后更新**: 2025-01-12
**维护者**: YiW 团队
