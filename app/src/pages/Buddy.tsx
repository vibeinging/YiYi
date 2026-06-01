/**
 * Buddy Page — 微信式两栏:左 = 伙伴列表(YiYi + 各 companion),右 = 详情。
 * YiYi 详情 = BuddyPanel(隐藏其内嵌的伙伴网格,交给左列表)。
 * 伙伴详情 = CompanionDetail(人设 / 独立记忆 / 一起做过 / 归隐;性格·冥想 B/C 期)。
 */

import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { BuddyPanel } from '../components/BuddyPanel';
import { CompanionDetail } from '../components/buddy/CompanionDetail';
import { AdoptModal } from '../components/companions/AdoptModal';
import { listCompanions, type Companion } from '../api/companions';
import logoFaceRight from '../assets/yiyi-logo-face-right.png';

export function BuddyPage() {
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [selected, setSelected] = useState<'yiyi' | number>('yiyi');
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    listCompanions(false).then(setCompanions).catch(() => {});
  }, [reload]);

  // 选中的伙伴若被归隐/删除 → 回落 YiYi。
  useEffect(() => {
    if (typeof selected === 'number' && !companions.some(c => c.id === selected)) {
      setSelected('yiyi');
    }
  }, [companions, selected]);

  const selectedCompanion =
    typeof selected === 'number' ? companions.find(c => c.id === selected) : undefined;

  const itemCls = () =>
    `w-full flex items-center gap-2.5 px-2.5 py-2 mx-1.5 rounded-xl cursor-pointer transition-colors`;

  return (
    <div className="h-full flex">
      {/* ── 左栏:伙伴列表 ── */}
      <div
        className="w-[208px] shrink-0 overflow-y-auto py-2"
        style={{ background: 'var(--color-bg-elevated)', borderRight: '1px solid var(--color-border)' }}
      >
        <div className="text-[10px] font-semibold tracking-[0.08em] uppercase px-3.5 pt-2 pb-1.5" style={{ color: 'var(--color-text-muted)' }}>
          伙伴
        </div>

        {/* YiYi 置顶 */}
        <div
          onClick={() => setSelected('yiyi')}
          className={itemCls()}
          style={{ background: selected === 'yiyi' ? 'var(--color-bg-subtle)' : 'transparent' }}
          onMouseEnter={(e) => { if (selected !== 'yiyi') e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
          onMouseLeave={(e) => { if (selected !== 'yiyi') e.currentTarget.style.background = 'transparent'; }}
        >
          <div className="shrink-0 w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center" style={{ background: 'var(--color-bg-subtle)' }}>
            <img src={logoFaceRight} alt="YiYi" style={{ width: '82%', height: '82%', objectFit: 'contain' }} />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-medium truncate" style={{ color: 'var(--color-text)' }}>YiYi</div>
            <div className="text-[11px] truncate" style={{ color: 'var(--color-text-muted)' }}>主精灵</div>
          </div>
        </div>

        {companions.map(c => {
          const active = selected === c.id;
          return (
            <div
              key={c.id}
              onClick={() => setSelected(c.id)}
              className={itemCls()}
              style={{ background: active ? 'var(--color-bg-subtle)' : 'transparent' }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
            >
              <div
                className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-[18px]"
                style={{ background: c.color_hex ? `${c.color_hex}26` : 'var(--color-bg-subtle)' }}
              >
                {c.avatar_emoji || '🤖'}
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-medium truncate" style={{ color: 'var(--color-text)' }}>{c.name}</div>
                <div className="text-[11px] truncate" style={{ color: 'var(--color-text-muted)' }}>{c.role_label || '伙伴'}</div>
              </div>
            </div>
          );
        })}

        {/* 收养新伙伴 */}
        <button
          onClick={() => setAdoptOpen(true)}
          className="w-full flex items-center gap-2.5 px-2.5 py-2 mx-1.5 mt-1 rounded-xl cursor-pointer transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-muted)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <div className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center" style={{ border: '1.5px dashed var(--color-border-strong)' }}>
            <Plus size={16} />
          </div>
          <span className="text-[13px]">收养新伙伴</span>
        </button>
      </div>

      {/* ── 右栏:详情 ── */}
      <div className="flex-1 min-w-0">
        {selectedCompanion ? (
          <CompanionDetail companion={selectedCompanion} onChanged={() => setReload(r => r + 1)} />
        ) : (
          <div className="h-full overflow-y-auto buddy-page">
            <div className="w-full px-6 py-6">
              <BuddyPanel hideCompanions />
            </div>
          </div>
        )}
      </div>

      {adoptOpen && (
        <AdoptModal
          onClose={() => setAdoptOpen(false)}
          onAdopted={() => { setAdoptOpen(false); setReload(r => r + 1); }}
        />
      )}
    </div>
  );
}
