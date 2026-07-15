# Vue 3 → React 迁移规范(webui → app/renderer)

本工程是把 `webui/`(Vue 3 + Element Plus + Pinia + Vue Router + vue-i18n)**逐文件**迁移成
React。技术选型(已锁定)：

| 维度 | 源(Vue) | 目标(React) |
|---|---|---|
| 框架 | Vue 3 `<script setup>` | React 18 函数组件 |
| 语言 | JS / 部分 TS | **TypeScript (.tsx/.ts)** |
| UI 库 | Element Plus | **Mantine v7**(`@mantine/core` 等) |
| 状态 | Pinia | **Zustand**(`@/store/*` 已转好) |
| 路由 | Vue Router | **React Router v6**(`@/router` 已转好) |
| i18n | vue-i18n | **react-i18next**(字典零改动复用，key 不变) |
| 图表 | vue-echarts | **echarts-for-react** |
| 流程图 | @vue-flow/core | **@xyflow/react**(reactflow) |
| 拖拽网格 | @noction/vue-draggable-grid | **react-grid-layout** |
| 代码编辑器 | codemirror(裸) | **@uiw/react-codemirror** |
| 图标 | @element-plus/icons-vue | `@/components/ElSvgIcon`(EP 名→Tabler) 或 `@tabler/icons-react` |
| svg sprite | vite-plugin-svg-icons | 同(`@/icons/SvgIcon`) |
| 事件总线 | mitt / eventBus | `@/utils/bus`、`@/utils/eventBus`(已转) |
| 日期 | moment-mini | dayjs |

## 硬性约定(务必遵守)

1. **路径不变**：`webui/src/views/login/index.vue` → `app/renderer/src/views/login/index.tsx`。
   目标文件已存在「stub」，**直接覆盖**它(`Write`)。
2. **default export 组件**：路由用 `import.meta.glob` + `m.default` 加载，必须默认导出。
3. **保持行为/文案/i18n key 完全一致**。不要新增/改写后端接口路径。
4. TypeScript：源里没类型的地方用 `any` 即可,**不要过度设计类型**,优先把功能搬过去。
5. 复用已转好的基础设施(见下),不要重复造轮子。
6. `<style scoped>` → 同目录建 `Xxx.module.scss` 并 `import styles from './Xxx.module.scss'`,
   类名 `class="foo"` → `className={styles.foo}`。非 scoped 的全局 `<style>` → 建普通 `.scss` 顶部 import 一次。
   `--el-*` CSS 变量仍可用(主题 SCSS 已保留)。
7. 中文注释保留;新加注释也用中文,风格与周边一致。

## 已转好的基础设施(直接 import)

- 状态：`@/store/basic` `@/store/config` `@/store/project` `@/store/tags-view` `@/store/permission` `@/store/database`
- 权限：`@/permission`(permissionManager / hasPermission / isAdmin …)
- 请求：`@/utils/axios-req`(default `axiosReq`)
- i18n：组件内 `const { t } = useTranslation()`;非组件用 `import { t } from '@/lang'`
- 路由跳转：组件内 `const navigate = useNavigate()`;非组件 `import { navigate } from '@/router/navigation'`
- 图标：`<ElSvgIcon name="Message" />`(EP 名) 或直接 `import { IconX } from '@tabler/icons-react'`
- settings：`import settings from '@/settings'`

## Zustand store 用法(对应 Pinia)

```tsx
// 组件内(响应式,按字段选择,避免整对象选择导致多余 rerender)
const token = useBasicStore((s) => s.token)
const setToken = useBasicStore((s) => s.setToken)
// storeToRefs(useBasicStore()) → 逐字段 selector
// 非组件(util/guard)：useBasicStore.getState().token
```
Pinia getter 已转成 `projectGetters`/`permissionGetters` 选择器，或 store 内的函数(如 database 的 `currentSchemaConfig()`)。

## 模板语法映射

| Vue | React |
|---|---|
| `v-if / v-else-if / v-else` | `{cond && <X/>}` / 三元 |
| `v-for="i in list" :key` | `{list.map(i => <X key={...}/>)}` |
| `v-model="x"`(输入) | `value={x} onChange={e => setX(e.currentTarget.value)}`;Mantine 表单用 `form.getInputProps('x')` |
| `v-show` | `style={{ display: cond ? undefined : 'none' }}` |
| `:prop` / `v-bind` | `prop={...}` |
| `@click` / `v-on` | `onClick={...}` |
| `v-html="h"` | `dangerouslySetInnerHTML={{ __html: h }}` |
| 具名 slot | 作为 `ReactNode` prop 传入 |
| 作用域 slot | render-prop 函数 prop |
| `ref`(模板) | `useRef` |
| `computed` | `useMemo` 或派生常量 |
| `watch` / `watchEffect` | `useEffect` |
| `ref()/reactive()` | `useState`(对象用 `useState<T>()`) |
| `onMounted` | `useEffect(() => {...}, [])` |
| `onBeforeUnmount/onUnmounted` | `useEffect` 的 cleanup |
| `nextTick` | `queueMicrotask` / `requestAnimationFrame` |
| `provide/inject` | React Context |
| `defineProps` | 组件 props + `interface XxxProps` |
| `defineEmits('update')` | 回调 props `onUpdate?: (v)=>void` |
| `defineExpose` | `forwardRef` + `useImperativeHandle` |
| `useRoute()` | `useLocation` / `useParams` / `useSearchParams` |
| `useRouter().push` | `useNavigate()` |
| `useI18n().t` / `$t` | `useTranslation().t` |

## Element Plus → Mantine 组件映射

| Element Plus | Mantine |
|---|---|
| `el-button` | `Button`(`variant`/`color`/`loading`) |
| `el-input` | `TextInput`;`type=textarea`→`Textarea`;`type=password`→`PasswordInput` |
| `el-input-number` | `NumberInput` |
| `el-select`+`el-option` | `Select` / `MultiSelect`(`data={[{value,label}]}`) |
| `el-form`/`el-form-item` | `@mantine/form` `useForm()` + `form.getInputProps`;label/error 用各 Input 的 `label`/`error` |
| `el-table`/`el-table-column` | `Table`(`Table.Thead/Tbody/Tr/Th/Td`,手动 map);复杂表保留列定义循环 |
| `el-dialog` | `Modal`(`opened`/`onClose`) |
| `el-drawer` | `Drawer` |
| `ElMessage.xxx` | `notifications.show({ color, message })`(`@mantine/notifications`) |
| `ElMessageBox.confirm` | `modals.openConfirmModal({...})`(`@mantine/modals`) |
| `ElNotification` | `notifications.show` |
| `el-tabs`/`el-tab-pane` | `Tabs`/`Tabs.Panel`(`value`/`onChange`) |
| `el-tag` | `Badge` |
| `el-tooltip` | `Tooltip` |
| `el-popover` | `Popover` |
| `el-popconfirm` | `Popover` 内放确认 或 `modals.openConfirmModal` |
| `el-dropdown` | `Menu` |
| `el-switch` | `Switch` |
| `el-checkbox(-group)` | `Checkbox`/`Checkbox.Group` |
| `el-radio(-group)` | `Radio`/`Radio.Group` |
| `el-pagination` | `Pagination` |
| `el-card` | `Card` / `Paper` |
| `el-icon` | 直接渲染 Tabler 图标 |
| `el-empty` | `Center`+`Text`(或自建) |
| `el-skeleton` | `Skeleton` |
| `v-loading` / `el-loading` | `LoadingOverlay` 或 `Loader` |
| `el-collapse` | `Accordion` |
| `el-date-picker` | `DatePickerInput`/`DateTimePicker`(`@mantine/dates`,dayjs) |
| `el-upload` | `Dropzone`(`@mantine/dropzone`) 或 `FileInput` |
| `el-row`/`el-col` | `Grid`/`Grid.Col`(或 `Flex`/`Group`/`Stack`) |
| `el-divider` | `Divider` |
| `el-avatar` | `Avatar` |
| `el-progress` | `Progress` / `RingProgress` |
| `el-steps`/`el-step` | `Stepper` |
| `el-scrollbar` | `ScrollArea` |
| `el-segmented` | `SegmentedControl` |
| `el-text` | `Text` |
| `el-link` | `Anchor` |
| `el-image` | `Image` |
| `el-tree` | Mantine 无 Tree → 自建递归或用现成 list;**遇到请在文件顶部 `// TODO(migration): el-tree`** |
| `el-tour` | Mantine 无 Tour(仅 layout 的 onboarding 用) → 用 Popover/自建,标 TODO |
| `el-config-provider` | 已由全局 `MantineProvider` 提供,删除即可 |

## 其它库

- **ECharts**：`<v-chart :option>` → `import ReactECharts from 'echarts-for-react'`;`<ReactECharts option={option} style={{height}} />`。
- **Vue Flow**：`@vue-flow/core` → `import { ReactFlow, Background, Controls } from '@xyflow/react'`;节点/边 state 用 `useNodesState/useEdgesState`;dagre 布局逻辑可直接搬。
- **draggable grid**：`@noction/vue-draggable-grid` → `react-grid-layout` 的 `Responsive`/`GridLayout`(layout 数组 + `onLayoutChange`)。
- **CodeMirror**：裸 codemirror → `import CodeMirror from '@uiw/react-codemirror'` + `@codemirror/lang-sql`。
- **markdown/katex/mermaid/highlight.js/sql-formatter/xlsx/crypto-js/js-yaml/html2canvas/html2pdf.js**：框架无关,逻辑直接搬(util 文件复用 `@/utils/*`)。
- **clipboard**：`vue-clipboard3` → `navigator.clipboard.writeText` + `notifications.show`。

## 遇到不确定/缺失依赖时

- 在文件顶部加 `// TODO(migration): <原因>`,用最接近的 Mantine 实现先跑通,**不要卡住**。
- 不要改 i18n key、接口路径、业务逻辑。
