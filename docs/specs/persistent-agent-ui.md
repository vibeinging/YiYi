# 长任务模式 UI 设计

> Phase 0.5 — Sequential ReAct with Auto-Continue
> 日期：2026-03-12

---

## 1. 组件结构

### 1.1 组件树

```
Chat.tsx
├── ... (existing message list)
│
├── LongTaskProgressPanel          // 嵌入消息流，显示长任务实时进度
│   ├── ProgressHeader             // 轮次 + 状态 + 费用概览
│   ├── ProgressBar                // 进度条（轮次维度）
│   ├── RoundDivider               // 轮次间分隔线（嵌入消息流）
│   └── StopReasonBadge            // 停止原因展示
│
├── ... (existing SpawnAgentPanel, ToolCallPanel)
│
└── InputArea (existing)
    ├── LongTaskToggle             // 长任务模式开关
    ├── LongTaskConfig             // 展开的配置面板（max rounds, budget）
    ├── MentionInput (existing)
    └── SendButton / StopButton (existing)
        └── PauseResumeButton      // 长任务模式下新增的暂停/继续按钮
```

### 1.2 新增 TypeScript 类型

```typescript
// ── 长任务状态（新增到 chatStreamStore） ──

export type LongTaskStatus =
  | 'idle'          // 未启用长任务模式
  | 'running'       // 执行中
  | 'paused'        // 用户暂停
  | 'completed'     // 任务完成（Agent 返回无 [CONTINUE]）
  | 'stopped';      // 被终止（达到上限或用户取消）

export type StopReason =
  | 'task_complete'       // 任务完成
  | 'max_rounds'          // 达到最大轮次
  | 'budget_exhausted'    // 预算耗尽
  | 'user_cancelled'      // 用户取消
  | 'error';              // 执行出错

export interface LongTaskState {
  enabled: boolean;              // 是否开启长任务模式
  status: LongTaskStatus;
  currentRound: number;          // 当前轮次（从 1 开始）
  maxRounds: number;             // 最大轮次上限
  tokensUsed: number;            // 已用 token
  tokenBudget: number;           // token 预算上限
  estimatedCostUsd: number;      // 预估已花费 $
  budgetCostUsd: number;         // 预算上限 $
  stopReason: StopReason | null; // 停止原因
  startedAt: number | null;      // 开始时间戳
}

// ── 长任务配置（用户可调） ──

export interface LongTaskConfig {
  maxRounds: number;      // 默认 10
  tokenBudget: number;    // 默认 1_000_000（约 $3）
}
```

### 1.3 Store 扩展

在 `chatStreamStore` 中新增以下字段和 actions：

```typescript
interface ChatStreamState {
  // ... existing fields ...

  // Long task
  longTask: LongTaskState;

  // Long task actions
  setLongTaskEnabled: (enabled: boolean) => void;
  setLongTaskConfig: (config: Partial<LongTaskConfig>) => void;
  longTaskRoundStart: (round: number) => void;
  longTaskProgress: (tokensUsed: number, estimatedCostUsd: number) => void;
  longTaskPause: () => void;
  longTaskResume: () => void;
  longTaskComplete: (reason: StopReason) => void;
}
```

初始状态：

```typescript
longTask: {
  enabled: false,
  status: 'idle',
  currentRound: 0,
  maxRounds: 10,
  tokensUsed: 0,
  tokenBudget: 1_000_000,
  estimatedCostUsd: 0,
  budgetCostUsd: 3.0,
  stopReason: null,
  startedAt: null,
},
```

---

## 2. 长任务开关

### 2.1 位置

在输入框内部、左侧附件按钮（Paperclip）旁边新增一个 toggle 按钮。开启后，在输入框上方展开配置区域。

### 2.2 视觉效果

- 关闭状态：半透明图标按钮，与附件按钮风格一致
- 开启状态：按钮带 primary 色背景高亮，输入框上方滑出配置面板
- 图标：`lucide-react` 的 `Infinity`（表示持续执行）

### 2.3 JSX 示例

```tsx
import { Infinity, ChevronDown } from 'lucide-react';
import { useChatStreamStore } from '../stores/chatStreamStore';

function LongTaskToggle() {
  const { longTask, setLongTaskEnabled } = useChatStreamStore();
  const active = longTask.enabled;

  return (
    <button
      type="button"
      onClick={() => setLongTaskEnabled(!active)}
      className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all"
      style={{
        background: active ? 'var(--color-primary-subtle)' : 'transparent',
        color: active ? 'var(--color-primary)' : 'var(--color-text-muted)',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--color-bg-muted)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
      title={active ? '关闭长任务模式' : '开启长任务模式'}
    >
      <Infinity size={18} />
    </button>
  );
}
```

### 2.4 配置面板（展开区域）

开启长任务模式后，在输入框容器（`rounded-2xl` 的 div）内部顶部展开一个配置条：

```tsx
function LongTaskConfig() {
  const { longTask, setLongTaskConfig } = useChatStreamStore();

  if (!longTask.enabled || longTask.status === 'running') return null;

  return (
    <div
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        animation: 'fadeSlideIn 0.2s ease-out',
      }}
    >
      {/* 最大轮次 */}
      <div className="flex items-center gap-2">
        <label
          style={{
            fontSize: '11px',
            fontWeight: 500,
            color: 'var(--color-text-tertiary)',
            fontFamily: 'var(--font-text)',
            whiteSpace: 'nowrap',
          }}
        >
          Max Rounds
        </label>
        <select
          value={longTask.maxRounds}
          onChange={(e) => setLongTaskConfig({ maxRounds: Number(e.target.value) })}
          style={{
            fontSize: '11px',
            padding: '3px 24px 3px 8px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-bg-subtle)',
            color: 'var(--color-text)',
            minWidth: '56px',
          }}
        >
          {[5, 10, 20, 50].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>

      {/* 预算上限 */}
      <div className="flex items-center gap-2">
        <label
          style={{
            fontSize: '11px',
            fontWeight: 500,
            color: 'var(--color-text-tertiary)',
            fontFamily: 'var(--font-text)',
            whiteSpace: 'nowrap',
          }}
        >
          Budget
        </label>
        <select
          value={longTask.budgetCostUsd}
          onChange={(e) => {
            const usd = Number(e.target.value);
            // 粗略换算：$1 ≈ 330K tokens (Claude Sonnet 4 混合)
            setLongTaskConfig({
              tokenBudget: Math.round(usd * 330_000),
            });
          }}
          style={{
            fontSize: '11px',
            padding: '3px 24px 3px 8px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-bg-subtle)',
            color: 'var(--color-text)',
            minWidth: '56px',
          }}
        >
          {[1, 3, 5, 10, 20].map((n) => (
            <option key={n} value={n}>${n}</option>
          ))}
        </select>
      </div>

      {/* 模式标签 */}
      <div className="flex-1" />
      <span
        style={{
          fontSize: '10px',
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: 'var(--color-primary)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        Long Task Mode
      </span>
    </div>
  );
}
```

### 2.5 在 InputArea 中的集成位置

```tsx
{/* 在 existing 输入框容器内 */}
<div className="relative rounded-2xl transition-all" style={{ ... }}>
  {/* slash / mention pickers (existing) ... */}

  {/* 新增：长任务配置面板 */}
  <LongTaskConfig />

  {/* 图片预览 (existing) ... */}

  <div className="flex items-end gap-2 p-2">
    {/* 附件按钮 (existing) */}
    <button>...</button>

    {/* 新增：长任务模式开关 */}
    <LongTaskToggle />

    {/* MentionInput (existing) */}
    <MentionInput ... />

    {/* 发送/停止按钮 (existing) + 新增暂停按钮 */}
    {/* 详见第 4 节 */}
  </div>
</div>
```

---

## 3. 进度面板

### 3.1 设计原则

- 嵌入消息流中（与 ToolCallPanel、SpawnAgentPanel 同级），而非独立弹窗
- 沿用现有 elevated card 风格（`borderRadius: 12px`、`var(--color-bg-elevated)`）
- Progressive disclosure：默认展开关键指标，点击可展开详细日志
- 紧凑布局：一行展示核心信息，避免占据过多对话空间

### 3.2 布局

```
┌──────────────────────────────────────────────────────────┐
│ ∞  Long Task                          Running  Round 3/10│
│                                                          │
│ [████████████░░░░░░░░░░░░░░░░░░░░░░]  30%               │
│                                                          │
│ Tokens: 312K / 1M     Cost: $0.95 / $3.00     2m 34s    │
└──────────────────────────────────────────────────────────┘
```

完成态：

```
┌──────────────────────────────────────────────────────────┐
│ ✓  Long Task Completed                   7 rounds  $2.10│
│    Task completed successfully                           │
└──────────────────────────────────────────────────────────┘
```

### 3.3 JSX + CSS 实现

```tsx
import { memo, useState } from 'react';
import {
  Infinity,
  Loader2,
  CheckCircle2,
  PauseCircle,
  XCircle,
  ChevronRight,
  Coins,
  Timer,
  Hash,
} from 'lucide-react';
import { useChatStreamStore, type LongTaskState, type StopReason } from '../stores/chatStreamStore';

/* ── 辅助函数 ── */

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function formatElapsed(startedAt: number | null): string {
  if (!startedAt) return '';
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return `${mins}m ${rem}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const STATUS_CONFIG: Record<string, {
  label: string;
  color: string;
  icon: typeof Loader2;
  animate?: boolean;
}> = {
  running:   { label: 'Running',   color: 'var(--color-primary)', icon: Loader2, animate: true },
  paused:    { label: 'Paused',    color: 'var(--color-warning)', icon: PauseCircle },
  completed: { label: 'Completed', color: 'var(--color-success)', icon: CheckCircle2 },
  stopped:   { label: 'Stopped',   color: 'var(--color-error)',   icon: XCircle },
};

const STOP_REASON_LABELS: Record<StopReason, string> = {
  task_complete:   'Task completed successfully',
  max_rounds:      'Reached maximum rounds limit',
  budget_exhausted: 'Token budget exhausted',
  user_cancelled:  'Cancelled by user',
  error:           'Stopped due to error',
};

/* ── 进度面板主体 ── */

export const LongTaskProgressPanel = memo(function LongTaskProgressPanel() {
  const longTask = useChatStreamStore((s) => s.longTask);
  const [collapsed, setCollapsed] = useState(false);

  // 仅在长任务活跃时显示（running/paused/completed/stopped）
  if (longTask.status === 'idle') return null;

  const cfg = STATUS_CONFIG[longTask.status] || STATUS_CONFIG.running;
  const StatusIcon = cfg.icon;
  const progress = longTask.maxRounds > 0
    ? Math.round((longTask.currentRound / longTask.maxRounds) * 100)
    : 0;
  const isTerminal = longTask.status === 'completed' || longTask.status === 'stopped';

  return (
    <div
      className="animate-slide-up"
      style={{
        borderRadius: '12px',
        background: 'var(--color-bg-elevated)',
        border: `1px solid ${
          longTask.status === 'running'
            ? 'color-mix(in srgb, var(--color-primary) 25%, var(--color-border))'
            : 'var(--color-border)'
        }`,
        overflow: 'hidden',
        transition: 'border-color 0.3s ease',
      }}
    >
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-bg-muted)]"
        onClick={() => setCollapsed((p) => !p)}
        style={{ background: 'transparent', transition: 'background 0.15s' }}
      >
        <ChevronRight
          size={11}
          style={{
            transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            transition: 'transform 0.2s',
            color: 'var(--color-text-muted)',
          }}
        />

        {/* 图标 */}
        {isTerminal ? (
          <StatusIcon size={13} style={{ color: cfg.color }} />
        ) : (
          <Infinity size={13} style={{ color: cfg.color }} />
        )}

        {/* 标题 */}
        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            color: 'var(--color-text)',
            fontFamily: 'var(--font-text)',
          }}
        >
          Long Task
        </span>

        {/* 状态 badge */}
        <span
          style={{
            fontSize: '10px',
            fontWeight: 600,
            padding: '1px 6px',
            borderRadius: 'var(--radius-full)',
            background: `color-mix(in srgb, ${cfg.color} 12%, transparent)`,
            color: cfg.color,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {cfg.label}
        </span>

        <div className="flex-1" />

        {/* 右侧概览 */}
        <div className="flex items-center gap-2 shrink-0">
          {!isTerminal && (
            <span
              style={{
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-muted)',
                fontWeight: 500,
              }}
            >
              Round {longTask.currentRound}/{longTask.maxRounds}
            </span>
          )}
          {isTerminal && (
            <span
              style={{
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-muted)',
                fontWeight: 500,
              }}
            >
              {longTask.currentRound} rounds
            </span>
          )}
          <span
            style={{
              fontSize: '10px',
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-text-muted)',
              fontWeight: 500,
            }}
          >
            {formatCost(longTask.estimatedCostUsd)}
          </span>
          {cfg.animate ? (
            <Loader2
              size={12}
              className="animate-spin"
              style={{ color: cfg.color }}
            />
          ) : (
            <StatusIcon size={12} style={{ color: cfg.color }} />
          )}
        </div>
      </button>

      {/* Body — 展开后的详细信息 */}
      <div
        style={{
          maxHeight: collapsed ? '0px' : '200px',
          opacity: collapsed ? 0 : 1,
          overflow: 'hidden',
          transition: 'max-height 0.25s ease, opacity 0.2s ease',
        }}
      >
        <div style={{ padding: '0 12px 10px', borderTop: '1px solid var(--color-border)' }}>

          {/* 进度条 */}
          {!isTerminal && (
            <div style={{ padding: '8px 0 6px' }}>
              <div
                style={{
                  height: '4px',
                  borderRadius: '2px',
                  background: 'var(--color-bg-muted)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${progress}%`,
                    borderRadius: '2px',
                    background: `linear-gradient(90deg, var(--color-primary), var(--color-accent))`,
                    transition: 'width 0.5s ease',
                  }}
                />
              </div>
            </div>
          )}

          {/* 统计指标行 */}
          <div
            className="flex items-center gap-4 flex-wrap"
            style={{ paddingTop: isTerminal ? '8px' : '0' }}
          >
            {/* 轮次 */}
            <div className="flex items-center gap-1.5">
              <Hash size={11} style={{ color: 'var(--color-text-muted)' }} />
              <span
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {longTask.currentRound} / {longTask.maxRounds} rounds
              </span>
            </div>

            {/* Tokens */}
            <div className="flex items-center gap-1.5">
              <Coins size={11} style={{ color: 'var(--color-text-muted)' }} />
              <span
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {formatTokens(longTask.tokensUsed)} / {formatTokens(longTask.tokenBudget)} tokens
              </span>
            </div>

            {/* 费用 */}
            <div className="flex items-center gap-1.5">
              <span
                style={{
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  color:
                    longTask.estimatedCostUsd / longTask.budgetCostUsd > 0.8
                      ? 'var(--color-warning)'
                      : 'var(--color-text-secondary)',
                  fontWeight:
                    longTask.estimatedCostUsd / longTask.budgetCostUsd > 0.8
                      ? 600
                      : 400,
                }}
              >
                {formatCost(longTask.estimatedCostUsd)} / {formatCost(longTask.budgetCostUsd)}
              </span>
            </div>

            {/* 耗时 */}
            {longTask.startedAt && (
              <div className="flex items-center gap-1.5">
                <Timer size={11} style={{ color: 'var(--color-text-muted)' }} />
                <span
                  style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {formatElapsed(longTask.startedAt)}
                </span>
              </div>
            )}
          </div>

          {/* 停止原因 */}
          {isTerminal && longTask.stopReason && (
            <StopReasonBadge reason={longTask.stopReason} />
          )}
        </div>
      </div>
    </div>
  );
});

/* ── 停止原因 Badge ── */

function StopReasonBadge({ reason }: { reason: StopReason }) {
  const isSuccess = reason === 'task_complete';
  return (
    <div
      style={{
        marginTop: '6px',
        padding: '4px 8px',
        borderRadius: 'var(--radius-sm)',
        background: isSuccess
          ? 'color-mix(in srgb, var(--color-success) 8%, transparent)'
          : 'color-mix(in srgb, var(--color-warning) 8%, transparent)',
        fontSize: '11px',
        color: isSuccess ? 'var(--color-success)' : 'var(--color-text-secondary)',
        fontFamily: 'var(--font-text)',
      }}
    >
      {STOP_REASON_LABELS[reason]}
    </div>
  );
}
```

### 3.4 轮次分隔线（嵌入消息流）

每轮 auto-continue 开始时，在消息流中插入一个轻量分隔标记：

```tsx
export function RoundDivider({ round, maxRounds }: { round: number; maxRounds: number }) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-2"
      style={{ animation: 'fadeSlideIn 0.2s ease-out' }}
    >
      <div
        className="flex-1"
        style={{ height: '1px', background: 'var(--color-border)' }}
      />
      <span
        style={{
          fontSize: '10px',
          fontWeight: 600,
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-text-muted)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      >
        Round {round} / {maxRounds}
      </span>
      <div
        className="flex-1"
        style={{ height: '1px', background: 'var(--color-border)' }}
      />
    </div>
  );
}
```

在 `Chat.tsx` 消息流渲染中，当检测到新一轮 auto-continue 开始时（通过 `chat://long_task_round` 事件），在对应位置插入 `<RoundDivider />`。

### 3.5 在消息流中的集成位置

```tsx
{/* 在 streaming content 区域下方、SpawnAgentPanel 同级 */}

{/* 长任务进度面板 */}
{longTask.status !== 'idle' && (
  <div className="flex gap-3 justify-start px-2">
    {/* Avatar 占位（与 assistant 消息对齐） */}
    <div className="shrink-0" style={{ width: '32px' }} />
    {/* Panel */}
    <div className="flex-1 min-w-0">
      <LongTaskProgressPanel />
    </div>
  </div>
)}
```

---

## 4. 控制按钮

### 4.1 设计思路

长任务模式下，输入框右侧的按钮区域根据状态切换：

| 状态 | 按钮组 |
|------|--------|
| `idle` + 长任务已开启 | `[Send]`（正常发送，触发长任务） |
| `running` | `[Pause]` `[Cancel]` |
| `paused` | `[Resume]` `[Cancel]` |
| `completed` / `stopped` | `[Send]`（回归正常） |

### 4.2 JSX 实现

```tsx
import { Send, Square, Pause, Play, X } from 'lucide-react';

function ChatInputButtons({
  loading,
  hasContent,
  longTask,
  onSend,
  onStop,
  onPause,
  onResume,
  onCancel,
}: {
  loading: boolean;
  hasContent: boolean;
  longTask: LongTaskState;
  onSend: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  const isLongTaskActive = longTask.status === 'running' || longTask.status === 'paused';

  // 长任务执行中：暂停 + 取消
  if (isLongTaskActive) {
    return (
      <div className="flex items-center gap-1">
        {/* 暂停 / 继续 */}
        {longTask.status === 'running' ? (
          <button
            type="button"
            onClick={onPause}
            className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all"
            style={{
              background: 'var(--color-warning)',
              color: '#FFFFFF',
            }}
            title="Pause"
          >
            <Pause size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onResume}
            className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all"
            style={{
              background: 'var(--color-primary)',
              color: '#FFFFFF',
            }}
            title="Resume"
          >
            <Play size={14} fill="currentColor" />
          </button>
        )}

        {/* 取消 */}
        <button
          type="button"
          onClick={onCancel}
          className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all"
          style={{
            background: 'var(--color-error)',
            color: '#FFFFFF',
          }}
          title="Cancel"
        >
          <Square size={14} fill="currentColor" />
        </button>
      </div>
    );
  }

  // 普通 loading（非长任务模式，或长任务单轮执行中）
  if (loading) {
    return (
      <button
        type="button"
        onClick={onStop}
        className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all"
        style={{
          background: 'var(--color-error)',
          color: '#FFFFFF',
        }}
        title="Stop"
      >
        <Square size={14} fill="currentColor" />
      </button>
    );
  }

  // 空闲态：发送按钮
  return (
    <button
      type="submit"
      disabled={!hasContent}
      className="w-9 h-9 flex items-center justify-center rounded-xl shrink-0 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
      style={{
        background: hasContent ? 'var(--color-primary)' : 'transparent',
        color: hasContent ? '#FFFFFF' : 'var(--color-text-muted)',
      }}
    >
      <Send size={16} />
    </button>
  );
}
```

### 4.3 按钮样式规范

| 按钮 | 背景色 | 图标 | 尺寸 |
|------|--------|------|------|
| Send | `--color-primary` | `Send` 16px | 36x36 rounded-xl |
| Stop | `--color-error` | `Square` 14px filled | 36x36 rounded-xl |
| Pause | `--color-warning` | `Pause` 14px filled | 36x36 rounded-xl |
| Resume | `--color-primary` | `Play` 14px filled | 36x36 rounded-xl |
| Cancel | `--color-error` | `Square` 14px filled | 36x36 rounded-xl |

所有按钮统一 `transition-all`，hover 时 `opacity: 0.9`，active 时 `transform: scale(0.95)`。

---

## 5. 状态流转

### 5.1 状态机

```
                    用户发送消息 (长任务模式开启)
                              │
                              ▼
  idle ──────────────────► running
                              │
              ┌───────────────┼───────────────┐
              │               │               │
         用户暂停         轮次结束         用户取消
              │          检测到[CONTINUE]       │
              ▼               │               │
           paused             │               │
              │               ▼               │
         用户继续         自动开始下一轮        │
              │               │               │
              └───────► running ◄─────────────┘
                              │                     │
                    ┌─────────┼─────────┐           │
                    │         │         │           │
              无[CONTINUE]  超最大轮次  超预算      取消
                    │         │         │           │
                    ▼         ▼         ▼           ▼
                completed   stopped   stopped    stopped
              (task_complete) (max_rounds) (budget_exhausted) (user_cancelled)
```

### 5.2 各状态下的 UI 展示

| 状态 | 进度面板 | 输入框 | 控制按钮 | 进度条 |
|------|----------|--------|----------|--------|
| `idle` + enabled | 不显示 | 正常 + 配置面板 | Send | 无 |
| `running` | 展开，实时更新 | 禁用输入 | Pause + Cancel | 动画前进 |
| `paused` | 展开，暂停状态 | 可输入反馈 | Resume + Cancel | 静止 |
| `completed` | 折叠，成功色 | 恢复正常 | Send | 完整填满 |
| `stopped` | 折叠，提示原因 | 恢复正常 | Send | 停在中止位置 |

### 5.3 暂停态细节

用户暂停后：
- 进度面板状态 badge 变为黄色 "Paused"
- 输入框解除禁用，用户可以输入反馈文字
- 点击 Resume 时，如果输入框有内容，将内容作为"中途反馈"一并发送给 Agent
- 反馈消息以普通 user 消息形式插入消息流

---

## 6. 事件对接

### 6.1 新增 Tauri 事件

后端需要 emit 以下事件，前端在 `useChatEventBridge` 中监听：

```typescript
// 在 useChatEventBridge.ts 中新增监听

// 长任务新一轮开始
listen<{
  session_id: string;
  round: number;
  max_rounds: number;
}>('chat://long_task_round', (event) => {
  if (event.payload.session_id !== store().sessionId) return;
  store().longTaskRoundStart(event.payload.round);
}),

// 长任务进度更新（token/费用），每轮结束或周期性更新
listen<{
  session_id: string;
  tokens_used: number;
  estimated_cost_usd: number;
}>('chat://long_task_progress', (event) => {
  if (event.payload.session_id !== store().sessionId) return;
  store().longTaskProgress(
    event.payload.tokens_used,
    event.payload.estimated_cost_usd,
  );
}),

// 长任务结束
listen<{
  session_id: string;
  reason: StopReason;
}>('chat://long_task_complete', (event) => {
  if (event.payload.session_id !== store().sessionId) return;
  store().longTaskComplete(event.payload.reason);
}),
```

### 6.2 前端调用后端命令

```typescript
// 在 api/agent.ts 中新增

/** 启动长任务模式的 chat（附带配置） */
export async function chatStreamStartLongTask(
  sessionId: string,
  message: string,
  config: LongTaskConfig,
  attachments?: Attachment[],
) {
  return invoke('chat_stream_start', {
    sessionId,
    message,
    attachments: attachments ?? [],
    longTask: config,  // 后端据此开启 auto-continue loop
  });
}

/** 暂停长任务 */
export async function longTaskPause(sessionId: string) {
  return invoke('long_task_pause', { sessionId });
}

/** 继续长任务 */
export async function longTaskResume(sessionId: string, feedback?: string) {
  return invoke('long_task_resume', { sessionId, feedback });
}

/** 取消长任务 */
export async function longTaskCancel(sessionId: string) {
  return invoke('long_task_cancel', { sessionId });
}
```

### 6.3 Store actions 实现

```typescript
// chatStreamStore 中新增的 action 实现

setLongTaskEnabled: (enabled) => set((state) => ({
  longTask: {
    ...state.longTask,
    enabled,
    // 关闭时重置状态
    ...(enabled ? {} : {
      status: 'idle' as const,
      currentRound: 0,
      tokensUsed: 0,
      estimatedCostUsd: 0,
      stopReason: null,
      startedAt: null,
    }),
  },
})),

setLongTaskConfig: (config) => set((state) => ({
  longTask: {
    ...state.longTask,
    ...(config.maxRounds !== undefined && { maxRounds: config.maxRounds }),
    ...(config.tokenBudget !== undefined && {
      tokenBudget: config.tokenBudget,
      budgetCostUsd: config.tokenBudget / 330_000,
    }),
  },
})),

longTaskRoundStart: (round) => set((state) => ({
  longTask: {
    ...state.longTask,
    status: 'running',
    currentRound: round,
    startedAt: state.longTask.startedAt || Date.now(),
  },
})),

longTaskProgress: (tokensUsed, estimatedCostUsd) => set((state) => ({
  longTask: {
    ...state.longTask,
    tokensUsed,
    estimatedCostUsd,
  },
})),

longTaskPause: () => set((state) => ({
  longTask: { ...state.longTask, status: 'paused' },
})),

longTaskResume: () => set((state) => ({
  longTask: { ...state.longTask, status: 'running' },
})),

longTaskComplete: (reason) => set((state) => ({
  longTask: {
    ...state.longTask,
    status: reason === 'task_complete' ? 'completed' : 'stopped',
    stopReason: reason,
  },
  loading: false,
})),
```

### 6.4 Chat.tsx 集成要点

在 `handleSend` 函数中判断长任务模式：

```typescript
const handleSend = async () => {
  // ... existing validation ...

  if (longTask.enabled && longTask.status === 'idle') {
    // 启动长任务
    await chatStreamStartLongTask(
      currentSessionId,
      message,
      { maxRounds: longTask.maxRounds, tokenBudget: longTask.tokenBudget },
      pendingImages,
    );
  } else {
    // 正常发送
    await chatStreamStart(currentSessionId, message, pendingImages);
  }
};
```

暂停态下用户输入反馈并点击 Resume：

```typescript
const handleResume = async () => {
  const feedback = inputRef.current?.getText()?.trim();
  await longTaskResume(currentSessionId, feedback || undefined);
  useChatStreamStore.getState().longTaskResume();
  if (feedback) inputRef.current?.clear();
};
```

---

## 附录：文件清单

实现 Phase 0.5 长任务 UI 需要修改和新增的文件：

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/stores/chatStreamStore.ts` | 修改 | 新增 `longTask` state 和 actions |
| `src/hooks/useChatEventBridge.ts` | 修改 | 新增 3 个长任务事件监听 |
| `src/api/agent.ts` | 修改 | 新增 4 个长任务 API 函数 |
| `src/components/LongTaskProgressPanel.tsx` | 新增 | 进度面板 + 停止原因 Badge |
| `src/components/RoundDivider.tsx` | 新增 | 轮次分隔线 |
| `src/pages/Chat.tsx` | 修改 | 集成 Toggle、Config、控制按钮、进度面板 |
