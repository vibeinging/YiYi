import { useState, useEffect } from 'react';
import { getUsageSummary, getUsageBySession, getUsageDaily, type UsageSummary, type SessionUsage, type DailyUsage } from '../api/usage';
import { BarChart3, Clock, Layers, TrendingUp } from 'lucide-react';

type TimeRange = 'all' | 'today' | '7d' | '30d';

function rangeToSince(range: TimeRange): number | undefined {
  if (range === 'all') return undefined;
  const now = Date.now();
  const ms: Record<string, number> = { today: 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
  return now - (ms[range] || 0);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '$' + usd.toFixed(4);
  return '$' + usd.toFixed(2);
}

function StatCard({ label, value, sub, icon: Icon }: { label: string; value: string; sub?: string; icon: any }) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
      <div className="p-2 rounded-lg" style={{ background: 'var(--color-bg-subtle)' }}>
        <Icon size={18} style={{ color: 'var(--color-text-muted)' }} />
      </div>
      <div>
        <div className="text-[22px] font-semibold" style={{ color: 'var(--color-text)' }}>{value}</div>
        <div className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
        {sub && <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>{sub}</div>}
      </div>
    </div>
  );
}

export function UsagePanel() {
  const [range, setRange] = useState<TimeRange>('30d');
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [sessions, setSessions] = useState<SessionUsage[]>([]);
  const [daily, setDaily] = useState<DailyUsage[]>([]);
  const [loading, setLoading] = useState(true);

  // Load per-session breakdown once (not affected by time range)
  useEffect(() => {
    getUsageBySession(15).then(setSessions).catch(console.error);
  }, []);

  useEffect(() => {
    setLoading(true);
    const since = rangeToSince(range);
    Promise.all([
      getUsageSummary(since),
      getUsageDaily(range === 'all' ? 90 : range === '30d' ? 30 : range === '7d' ? 7 : 1),
    ]).then(([s, d]) => {
      setSummary(s);
      setDaily(d);
    }).catch(console.error).finally(() => setLoading(false));
  }, [range]);

  const ranges: { id: TimeRange; label: string }[] = [
    { id: 'today', label: '今天' },
    { id: '7d', label: '7 天' },
    { id: '30d', label: '30 天' },
    { id: 'all', label: '全部' },
  ];

  if (loading && !summary) {
    return <div className="text-center py-12" style={{ color: 'var(--color-text-muted)' }}>加载中...</div>;
  }

  const totalTokens = (summary?.total_input_tokens ?? 0) + (summary?.total_output_tokens ?? 0);
  const cacheHitRate = totalTokens > 0
    ? ((summary?.total_cache_read_tokens ?? 0) / (summary?.total_input_tokens || 1) * 100)
    : 0;

  return (
    <div className="space-y-5">
      {/* Time range selector */}
      <div className="flex gap-1 p-1 rounded-lg bg-[var(--color-bg-subtle)] w-fit">
        {ranges.map((r) => (
          <button
            key={r.id}
            onClick={() => setRange(r.id)}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium transition-all"
            style={{
              background: range === r.id ? 'var(--color-bg-elevated)' : 'transparent',
              color: range === r.id ? 'var(--color-text)' : 'var(--color-text-muted)',
              boxShadow: range === r.id ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={BarChart3} label="总 Tokens" value={formatTokens(totalTokens)} sub={`${summary?.call_count ?? 0} 次调用`} />
        <StatCard icon={TrendingUp} label="总费用" value={formatCost(summary?.total_cost_usd ?? 0)} />
        <StatCard icon={Layers} label="输入 / 输出" value={`${formatTokens(summary?.total_input_tokens ?? 0)} / ${formatTokens(summary?.total_output_tokens ?? 0)}`} />
        <StatCard icon={Clock} label="缓存命中" value={cacheHitRate > 0 ? `${cacheHitRate.toFixed(0)}%` : '—'} sub={cacheHitRate > 0 ? `${formatTokens(summary?.total_cache_read_tokens ?? 0)} tokens` : '无缓存数据'} />
      </div>

      {/* Daily trend */}
      {daily.length > 1 && (
        <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <h3 className="text-[13px] font-semibold mb-3" style={{ color: 'var(--color-text)' }}>每日用量</h3>
          <div className="flex items-end gap-[2px] h-[80px]">
            {(() => {
              const maxCost = Math.max(...daily.map(d => d.summary.total_cost_usd), 0.001);
              return daily.map((d, i) => {
                const h = Math.max((d.summary.total_cost_usd / maxCost) * 100, 2);
                return (
                  <div
                    key={i}
                    title={`${d.date}: ${formatCost(d.summary.total_cost_usd)} (${formatTokens(d.summary.total_input_tokens + d.summary.total_output_tokens)} tokens)`}
                    className="flex-1 rounded-t transition-all hover:opacity-80"
                    style={{
                      height: `${h}%`,
                      background: 'var(--color-primary)',
                      opacity: 0.7,
                      minWidth: 3,
                      maxWidth: 20,
                    }}
                  />
                );
              });
            })()}
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{daily[0]?.date}</span>
            <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{daily[daily.length - 1]?.date}</span>
          </div>
        </div>
      )}

      {/* Per-session breakdown */}
      {sessions.length > 0 && (
        <div className="p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <h3 className="text-[13px] font-semibold mb-3" style={{ color: 'var(--color-text)' }}>按会话</h3>
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {sessions.map((s, i) => (
              <div key={i} className="flex items-center justify-between py-2 px-3 rounded-lg" style={{ background: 'var(--color-bg-subtle)' }}>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-mono truncate" style={{ color: 'var(--color-text)' }}>
                    {s.session_id.length > 20 ? s.session_id.slice(0, 8) + '...' : s.session_id}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                    {s.summary.call_count} 次 · {formatTokens(s.summary.total_input_tokens + s.summary.total_output_tokens)} tokens
                  </div>
                </div>
                <div className="text-[13px] font-semibold ml-3" style={{ color: 'var(--color-text)' }}>
                  {formatCost(s.summary.total_cost_usd)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {totalTokens === 0 && !loading && (
        <div className="text-center py-8" style={{ color: 'var(--color-text-muted)' }}>
          <BarChart3 size={32} className="mx-auto mb-2 opacity-30" />
          <p className="text-[13px]">暂无用量数据</p>
          <p className="text-[11px]">开始对话后，用量数据将在此显示</p>
        </div>
      )}
    </div>
  );
}
