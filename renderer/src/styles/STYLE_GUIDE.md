# YiW 前端样式指南

本文档介绍项目中的全局样式类，请优先使用这些样式，避免重复编写。

## 文件结构

```
src/styles/
├── index.scss                    # 入口文件，导入所有样式
├── scss-suger.scss               # Flex 布局工具类
├── reset-elemenet-plus-style.scss # Element Plus 样式定制
├── components.scss               # 公共组件样式
├── transition.scss               # 动画样式
└── STYLE_GUIDE.md                # 本文档
```

---

## 1. Flex 布局工具类 (scss-suger.scss)

### 命名规则
- 格式: `{方向}{主轴对齐}{交叉轴对齐}`
- 方向: `row` (水平) / `column` (垂直)
- 主轴: `S` (start) / `C` (center) / `E` (end) / `B` (space-between) / `A` (space-around)
- 交叉轴: `S` (start) / `C` (center) / `E` (end)

### 常用类名

```html
<!-- 水平布局 -->
<div class="rowSC">左对齐，垂直居中</div>
<div class="rowBC">两端对齐，垂直居中（最常用）</div>
<div class="rowCC">水平垂直居中</div>
<div class="rowEC">右对齐，垂直居中</div>

<!-- 垂直布局 -->
<div class="columnSS">顶部左对齐</div>
<div class="columnSC">顶部水平居中</div>
<div class="columnCC">完全居中</div>
<div class="columnBC">垂直两端对齐，水平居中</div>

<!-- 换行 -->
<div class="rowBC wrap">两端对齐，可换行</div>
```

### 完整列表

| 类名 | 主轴对齐 | 交叉轴对齐 |
|------|----------|------------|
| rowSS | flex-start | flex-start |
| rowSC | flex-start | center |
| rowSE | flex-start | flex-end |
| rowBC | space-between | center |
| rowBS | space-between | flex-start |
| rowBE | space-between | flex-end |
| rowCC | center | center |
| rowCS | center | flex-start |
| rowCE | center | flex-end |
| rowEC | flex-end | center |
| rowEE | flex-end | flex-end |
| columnSS | flex-start | flex-start |
| columnSC | flex-start | center |
| columnSE | flex-start | flex-end |
| columnBC | space-between | center |
| columnBS | space-between | flex-start |
| columnBE | space-between | flex-end |
| columnCC | center | center |
| columnCS | center | flex-start |
| columnCE | center | flex-end |

---

## 2. 公共组件样式 (components.scss)

所有组件样式以 `ad-` 为前缀 (YiW)。

### 2.1 CSS 变量

```scss
// 主色调
--ad-primary: #17483e;
--ad-primary-light: rgba(23, 72, 62, 0.08);

// 文本颜色
--ad-text-primary: #1e293b;
--ad-text-secondary: #64748b;
--ad-text-muted: #94a3b8;

// 边框和背景
--ad-border: #e2e8f0;
--ad-bg-white: #ffffff;
--ad-bg-gray: #f8fafc;
--ad-bg-hover: #f1f5f9;

// 状态颜色
--ad-danger: #ef4444;
--ad-success: #10b981;
--ad-warning: #f59e0b;

// 间距
--ad-spacing-xs: 4px;
--ad-spacing-sm: 8px;
--ad-spacing-md: 16px;
--ad-spacing-lg: 24px;
--ad-spacing-xl: 32px;

// 圆角
--ad-radius-sm: 6px;
--ad-radius-md: 8px;
--ad-radius-lg: 12px;
```

### 2.2 详情视图布局

用于: 数据源详情、业务详情、文档详情等有"返回+标题+内容"的页面。

```html
<div class="ad-detail-view">
  <div class="ad-detail-header">
    <el-button link class="header-back-btn" @click="goBack">
      <el-icon><ArrowLeft /></el-icon>
    </el-button>
    <span class="header-title">详情标题</span>
    <div class="header-actions">
      <el-button>操作按钮</el-button>
    </div>
  </div>
  <div class="ad-detail-content">
    <!-- 内容区 -->
  </div>
</div>
```

### 2.3 详情标签页

配合详情视图使用的标签页布局。

```html
<div class="ad-detail-view">
  <div class="ad-detail-header">...</div>
  <el-tabs class="ad-detail-tabs" v-model="activeTab">
    <el-tab-pane label="数据源管理" name="datasources">
      <!-- 内容 -->
    </el-tab-pane>
    <el-tab-pane label="设置" name="settings">
      <!-- 内容 -->
    </el-tab-pane>
  </el-tabs>
</div>
```

### 2.4 列表视图

用于: 侧边栏列表、文档列表等。

```html
<div class="ad-list-toolbar">
  <span class="toolbar-title">列表标题</span>
  <div class="toolbar-actions">
    <el-button>添加</el-button>
  </div>
</div>

<div class="ad-list-container">
  <div class="ad-list-item" :class="{ 'is-active': isActive }">
    <div class="item-icon">
      <el-icon><Document /></el-icon>
    </div>
    <div class="item-content">
      <div class="item-name">项目名称</div>
      <div class="item-desc">描述信息</div>
    </div>
    <div class="item-actions">
      <el-button link>删除</el-button>
    </div>
  </div>
</div>
```

### 2.5 卡片组件

```html
<div class="ad-card ad-card--shadow">
  <div class="ad-card-header">
    <div>
      <div class="card-title">卡片标题</div>
      <div class="card-desc">卡片描述</div>
    </div>
    <el-button>操作</el-button>
  </div>
  <div class="ad-card-body">
    <!-- 内容 -->
  </div>
  <div class="ad-card-footer">
    <el-button>取消</el-button>
    <el-button type="primary">确定</el-button>
  </div>
</div>
```

### 2.6 空状态

```html
<div class="ad-empty-state">
  <div class="empty-illustration">
    <!-- 自定义插图 -->
  </div>
  <div class="empty-title">暂无数据</div>
  <div class="empty-desc">这里是空状态的描述文字</div>
  <div class="empty-features">
    <el-tag>功能1</el-tag>
    <el-tag>功能2</el-tag>
  </div>
  <div class="empty-action">
    <el-button type="primary">创建</el-button>
  </div>
</div>
```

### 2.7 危险操作区

用于: 删除、重置等危险操作。

```html
<div class="ad-danger-zone">
  <div class="danger-title">危险操作</div>
  <div class="danger-desc">删除后数据将无法恢复</div>
  <div class="danger-action">
    <el-button type="danger">删除</el-button>
  </div>
</div>
```

### 2.8 表单区块

```html
<div class="ad-form-section">
  <div class="section-title">基本信息</div>
  <div class="section-content">
    <el-form>...</el-form>
  </div>
</div>
```

### 2.9 侧边栏布局

用于: 左侧列表 + 右侧详情的双栏布局。

```html
<div class="ad-sidebar-layout">
  <div class="sidebar-panel" :class="{ 'is-collapsed': isCollapsed }">
    <!-- 左侧列表 -->
  </div>
  <div class="collapse-btn" @click="toggleCollapse">
    <el-icon><component :is="isCollapsed ? 'ArrowRight' : 'ArrowLeft'" /></el-icon>
  </div>
  <div class="main-panel">
    <!-- 右侧内容 -->
  </div>
</div>
```

### 2.10 卡片网格布局 ⭐新增

用于: 数据源列表、业务列表等多卡片展示，自带响应式布局。

```html
<div class="ad-page-list">
  <div class="ad-page-toolbar">
    <span class="toolbar-count">共 5 个连接</span>
    <div class="toolbar-actions">
      <el-button type="primary">创建</el-button>
    </div>
  </div>

  <div class="ad-page-content ad-card-grid">
    <div class="ad-grid-card" v-for="item in list" :key="item.id">
      <div class="grid-card-header">
        <div class="grid-card-title">
          <el-tag size="small">MySQL</el-tag>
          <span>{{ item.name }}</span>
        </div>
        <div class="grid-card-actions" @click.stop>
          <el-button link size="small">管理</el-button>
          <el-button link type="danger" size="small">删除</el-button>
        </div>
      </div>
      <div class="grid-card-body">
        <div class="grid-card-info">
          <span class="info-tag">localhost:3306</span>
          <span class="info-tag">mydb</span>
        </div>
        <div class="grid-card-desc">数据库描述</div>
      </div>
      <div class="grid-card-footer">创建于 2024-12-25</div>
    </div>

    <!-- 空状态 -->
    <div class="ad-page-empty" v-if="list.length === 0">
      <el-empty description="暂无数据" />
    </div>
  </div>
</div>
```

**响应式断点**:
- `> 1200px`: 三列布局
- `768px - 1200px`: 两列布局
- `< 768px`: 单列布局

### 2.11 创建视图 ⭐新增

用于: 创建数据源、创建业务等表单页面。

```html
<div class="ad-create-view">
  <div class="ad-create-header">
    <el-button link @click="goBack">
      <el-icon><ArrowLeft /></el-icon>
      返回列表
    </el-button>
    <span class="header-title">创建数据源</span>
  </div>
  <div class="ad-create-content">
    <el-form class="create-form">
      <!-- 表单内容 -->
    </el-form>
  </div>
</div>
```

### 2.12 信息展示区 ⭐新增

用于: 项目信息、元数据等只读信息展示。

```html
<div class="ad-info-display">
  <div class="info-item">
    <span class="info-label">项目ID</span>
    <span class="info-value">abc-123-def</span>
  </div>
  <div class="info-item">
    <span class="info-label">创建时间</span>
    <span class="info-value">2024-12-25 10:30</span>
  </div>
</div>
```

### 2.13 标签页图标标签 ⭐新增

用于: Tabs 标签带图标的情况。

```html
<el-tabs>
  <el-tab-pane>
    <template #label>
      <span class="ad-tab-label">
        <el-icon><Grid /></el-icon>
        <span>表信息</span>
      </span>
    </template>
  </el-tab-pane>
</el-tabs>
```

### 2.14 详情页布局 ⭐新增

用于: 数据库详情、数据源详情等带返回按钮和标签页的页面。

```html
<div class="ad-detail-page">
  <!-- 头部: 返回按钮 + 标题 -->
  <div class="ad-detail-page-header">
    <el-button link @click="goBack">
      <el-icon><ArrowLeft /></el-icon>
    </el-button>
    <span class="header-title">数据库详情</span>
    <el-tag size="small">MySQL</el-tag>
  </div>

  <!-- 内容区 -->
  <div class="ad-detail-page-content">
    <!-- 普通标签页 -->
    <el-tabs v-model="activeTab" class="ad-detail-tabs">
      <el-tab-pane name="tables">
        <template #label>
          <span class="ad-tab-label">
            <el-icon><Grid /></el-icon>
            <span>表信息</span>
          </span>
        </template>
        <!-- 内容 -->
      </el-tab-pane>
    </el-tabs>
  </div>
</div>
```

**可用类名**:

| 类名 | 说明 |
|-----|------|
| `.ad-detail-page` | 详情页容器，全高度 flex 列布局 |
| `.ad-detail-page-header` | 头部区域，含返回按钮和标题 |
| `.ad-detail-page-content` | 内容区域，flex: 1 自动填充 |
| `.ad-detail-tabs` | 普通详情页标签页，全高度 |
| `.ad-detail-tabs-bordered` | Border-card 类型标签页 |
| `.ad-tab-label` | 标签页图标+文字组合 |

**Border-card 类型示例**:

```html
<el-tabs v-model="activeTab" type="border-card" class="ad-detail-tabs-bordered">
  <el-tab-pane name="tables">
    <template #label>
      <span class="ad-tab-label">
        <el-icon><Grid /></el-icon>
        <span>表信息</span>
      </span>
    </template>
  </el-tab-pane>
</el-tabs>
```

### 2.15 工具类

```html
<!-- 文本溢出 -->
<span class="ad-ellipsis">很长的文本...</span>

<!-- 多行溢出 -->
<p class="ad-line-clamp-2">限制两行...</p>
<p class="ad-line-clamp-3">限制三行...</p>

<!-- 禁止选择 -->
<div class="ad-no-select">不可选择的内容</div>

<!-- 可点击样式 -->
<div class="ad-clickable">点击有反馈</div>

<!-- 隐藏滚动条 -->
<div class="ad-hide-scrollbar">隐藏滚动条但可滚动</div>
```

---

## 3. Element Plus 样式定制 (reset-elemenet-plus-style.scss)

### 3.1 Select 下拉框

```html
<el-select popper-class="styled-select-popper">
  <el-option>
    <div class="select-option-item">
      <div class="option-name">选项名称</div>
      <div class="option-desc">选项描述</div>
    </div>
  </el-option>
</el-select>
```

### 3.2 Tabs 标签页

**全局规则：所有 Tabs 头部默认透明背景**

```scss
// 已全局设置，无需手动添加
.el-tabs__header {
  background: transparent !important;
}

.el-tabs--border-card {
  background: transparent;
  border: none;
  box-shadow: none;
}
```

> ⚠️ **注意**：不要在组件中重复设置 `background: transparent`，全局样式已处理。

**可用样式类**：

```html
<!-- 透明背景标签页（带下划线指示器） -->
<el-tabs class="ad-tabs-transparent">...</el-tabs>

<!-- 卡片式标签页（带背景切换效果） -->
<el-tabs class="ad-tabs-card" type="card">...</el-tabs>

<!-- 详情页全高度标签页 -->
<el-tabs class="ad-detail-tabs">...</el-tabs>

<!-- Border-card 类型详情页标签页 -->
<el-tabs type="border-card" class="ad-detail-tabs-bordered">...</el-tabs>
```

### 3.3 Table 表格

```html
<el-table class="ad-table-simple">...</el-table>
```

### 3.4 Form 表单

```html
<el-form class="ad-form-compact">...</el-form>
```

### 3.5 Input 输入框

```html
<el-input class="ad-input-modern">...</el-input>
```

### 3.6 Dialog 对话框

```html
<el-dialog class="ad-dialog-flex">...</el-dialog>
```

### 3.7 Descriptions 描述列表

```html
<el-descriptions class="ad-descriptions-compact">...</el-descriptions>
```

---

## 4. 使用规范

### 优先使用全局样式
- 先检查本文档是否有可用的样式类
- 如果没有，再考虑自定义样式
- 需要新增通用样式请联系前端负责人

### 组件样式命名
- 全局样式使用 `ad-` 前缀
- 组件内部样式使用语义化命名
- 避免使用过于通用的类名如 `.container`, `.wrapper`

### 颜色使用
- 使用 CSS 变量定义颜色，便于主题切换
- 主色调: `var(--ad-primary)`
- 文本: `var(--ad-text-primary)` / `var(--ad-text-secondary)`
- 边框: `var(--ad-border)`

### 间距使用
- 优先使用变量: `var(--ad-spacing-md)` 等
- 保持间距一致性: 4px, 8px, 16px, 24px, 32px

---

## 5. 示例：业务详情页面

```vue
<template>
  <div class="ad-detail-view">
    <!-- 头部 -->
    <div class="ad-detail-header">
      <el-button link class="header-back-btn" @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
      </el-button>
      <span class="header-title">{{ business.name }}</span>
    </div>

    <!-- 标签页内容 -->
    <el-tabs class="ad-detail-tabs" v-model="activeTab">
      <el-tab-pane label="数据源管理" name="datasources">
        <div class="ad-list-container">
          <div class="ad-list-item" v-for="item in dataSources" :key="item.id">
            <div class="item-icon"><el-icon><Connection /></el-icon></div>
            <div class="item-content">
              <div class="item-name">{{ item.name }}</div>
              <div class="item-desc">{{ item.type }}</div>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane label="业务设置" name="settings">
        <div class="ad-form-section">
          <div class="section-title">基本信息</div>
          <el-form class="ad-form-compact">
            <!-- 表单项 -->
          </el-form>
        </div>

        <div class="ad-danger-zone">
          <div class="danger-title">删除业务</div>
          <div class="danger-desc">删除后将无法恢复</div>
          <div class="danger-action">
            <el-button type="danger">删除</el-button>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
```

---

## 更新日志

- 2025-12-25: Tabs 全局透明背景规则，清理组件中冗余的 background: transparent
- 2025-12-25: 新增详情页布局 (ad-detail-page, ad-detail-tabs, ad-detail-tabs-bordered)
- 2025-12-25: 新增卡片网格布局、创建视图、信息展示区、标签页图标等模式
- 2024-12-25: 初始版本，整合项目中常用样式模式
