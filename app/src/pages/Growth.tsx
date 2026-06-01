/**
 * Growth Page — YiYi's growth visualization and capability profile.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Sprout, TrendingUp, Target, BookOpen,
  RefreshCw, Loader2,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import {
  getGrowthReport,
  type GrowthData, type GrowthReport, type CapabilityDimension, type GrowthMilestone,
} from '../api/system';

export function GrowthPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<GrowthData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const result = await getGrowthReport();
      setData(result);
    } catch (e) {
      console.error('Failed to load growth data:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const report = data?.report;
  const capabilities = data?.capabilities || [];
  const timeline = data?.timeline || [];

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <PageHeader
        title={t('growth.pageTitle', "YiYi's Growth")}
        description={t('growth.pageDesc', 'Track how YiYi learns, improves, and grows with you.')}
        actions={
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all"
            style={{
              background: 'var(--color-bg-elevated)',
              color: 'var(--color-text-secondary)',
            }}
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {t('common.refresh', 'Refresh')}
          </button>
        }
      />

      {loading && !data ? (
        <div className="flex items-center justify-center h-64" style={{ color: 'var(--color-text-tertiary)' }}>
          <Loader2 size={24} className="animate-spin" />
        </div>
      ) : !report && capabilities.length === 0 && timeline.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-6">
          {/* Stats Overview */}
          {report && <StatsCards report={report} />}

          {/* Skill Suggestion */}
          {data?.skill_suggestion && (
            <SkillSuggestion suggestion={data.skill_suggestion} />
          )}

          {/* Capability Radar */}
          {capabilities.length > 0 && (
            <CapabilityProfile capabilities={capabilities} />
          )}

          {/* Lessons */}
          {report && report.top_lessons.length > 0 && (
            <LessonsCard lessons={report.top_lessons} />
          )}

          {/* 成长时间线 */}
          {timeline.length > 0 && (
            <Timeline milestones={timeline} />
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center" style={{ color: 'var(--color-text-tertiary)' }}>
      <Sprout size={48} className="mb-4 opacity-40" />
      <p className="text-lg font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
        {t('growth.emptyTitle', 'YiYi is just getting started')}
      </p>
      <p className="text-[13px] max-w-sm leading-relaxed">
        {t('growth.emptyDesc', 'Try asking YiYi to help with a real task — write code, create a document, or automate something. Growth data appears after your first interaction that involves tool usage.')}
      </p>
    </div>
  );
}

function StatsCards({ report }: { report: GrowthReport }) {
  const cards = [
    {
      label: '完成任务',
      value: report.total_tasks,
      icon: Target,
      color: 'var(--color-primary)',
    },
    {
      label: '成功率',
      value: `${Math.round(report.success_rate * 100)}%`,
      icon: TrendingUp,
      color: report.success_rate >= 0.8 ? 'var(--color-success)' : report.success_rate >= 0.6 ? 'var(--color-warning)' : 'var(--color-error)',
    },
    {
      label: '学到的经验',
      value: report.top_lessons.length,
      icon: BookOpen,
      color: '#AF52DE',
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {cards.map((card, i) => (
        <div
          key={i}
          className="rounded-xl p-4 transition-all"
          style={{
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <card.icon size={16} style={{ color: card.color }} />
            <span className="text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
              {card.label}
            </span>
          </div>
          <div className="text-2xl font-bold" style={{ color: 'var(--color-text)' }}>
            {card.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function CapabilityProfile({ capabilities }: { capabilities: CapabilityDimension[] }) {
  return (
    <div
      className="rounded-xl p-5"
      style={{
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
      }}
    >
      <h3 className="text-[14px] font-semibold mb-4" style={{ color: 'var(--color-text)' }}>
        能力画像
      </h3>
      <div className="space-y-3">
        {capabilities.map((cap, i) => (
          <div key={i}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[13px] font-medium" style={{ color: 'var(--color-text)' }}>
                {cap.name}
              </span>
              <span className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>
                {Math.round(cap.success_rate * 100)}% ({cap.sample_count} 次)
              </span>
            </div>
            <div
              className="h-2 rounded-full overflow-hidden"
              style={{ background: 'var(--color-bg-subtle)' }}
            >
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.round(cap.success_rate * 100)}%`,
                  background: cap.success_rate >= 0.8 ? 'var(--color-success)'
                    : cap.success_rate >= 0.6 ? 'var(--color-warning)'
                    : 'var(--color-error)',
                  opacity: cap.confidence === 'low' ? 0.5 : cap.confidence === 'medium' ? 0.75 : 1,
                }}
              />
            </div>
            {cap.confidence === 'low' && (
              <span className="text-[11px] italic" style={{ color: 'var(--color-text-tertiary)' }}>
                置信度低(样本较少)
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LessonsCard({ lessons }: { lessons: string[] }) {
  return (
    <div
      className="rounded-xl p-5"
      style={{
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
      }}
    >
      <h3 className="text-[14px] font-semibold mb-3" style={{ color: 'var(--color-text)' }}>
        <BookOpen size={15} className="inline mr-2" style={{ color: '#AF52DE' }} />
        学到的经验
      </h3>
      <ul className="space-y-2">
        {lessons.map((lesson, i) => (
          <li
            key={i}
            className="text-[13px] pl-3 relative"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <span className="absolute left-0" style={{ color: 'var(--color-text-tertiary)' }}>-</span>
            {lesson}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SkillSuggestion({ suggestion }: { suggestion: string }) {
  return (
    <div
      className="rounded-xl p-4 flex items-start gap-3"
      style={{
        background: 'linear-gradient(135deg, rgba(175,82,222,0.08), rgba(88,86,214,0.08))',
        border: '1px solid rgba(175,82,222,0.2)',
      }}
    >
      <Sprout size={18} style={{ color: '#AF52DE', flexShrink: 0, marginTop: 2 }} />
      <div>
        <p className="text-[13px] font-medium mb-1" style={{ color: 'var(--color-text)' }}>
          成长机会
        </p>
        <p className="text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
          {suggestion}
        </p>
      </div>
    </div>
  );
}

function Timeline({ milestones }: { milestones: GrowthMilestone[] }) {
  const eventIcons: Record<string, { color: string; label: string }> = {
    lesson_learned: { color: '#AF52DE', label: '经验' },
    correction: { color: 'var(--color-warning)', label: '调整' },
    first_task: { color: 'var(--color-success)', label: '首个任务' },
    skill_created: { color: '#007AFF', label: '新技能' },
    capability_up: { color: 'var(--color-success)', label: '进步' },
  };

  return (
    <div
      className="rounded-xl p-5"
      style={{
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
      }}
    >
      <h3 className="text-[14px] font-semibold mb-4" style={{ color: 'var(--color-text)' }}>
        成长时间线
      </h3>
      <div className="space-y-0">
        {milestones.map((m, i) => {
          const meta = eventIcons[m.event_type] || { color: 'var(--color-text-tertiary)', label: m.event_type };
          return (
            <div key={i} className="flex gap-3 pb-4 relative">
              {/* Vertical line */}
              {i < milestones.length - 1 && (
                <div
                  className="absolute left-[7px] top-[18px] w-[2px]"
                  style={{
                    height: 'calc(100% - 6px)',
                    background: 'var(--color-border)',
                  }}
                />
              )}
              {/* Dot */}
              <div
                className="w-4 h-4 rounded-full shrink-0 mt-0.5 flex items-center justify-center"
                style={{ background: meta.color }}
              >
                <div className="w-1.5 h-1.5 rounded-full bg-white" />
              </div>
              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[12px] font-medium" style={{ color: meta.color }}>
                    {meta.label}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                    {m.date}
                  </span>
                </div>
                <p className="text-[13px] leading-snug" style={{ color: 'var(--color-text-secondary)' }}>
                  {m.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
