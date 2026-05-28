/**
 * AvatarGrid — IM 式的"群头像 / 单聊头像"统一渲染。
 *
 * - `groupId == null` → 单聊,渲染 YiYi logo
 * - `groupId == N`    → 群聊,拉群成员 emoji,2×2 / 3×3 拼图(微信群头像)
 *
 * 成员从 `groupsStore.ensureMembers(groupId)` 拉,自带懒加载 + 缓存,所以即使
 * session 列表里 N 个 item 同绑一个 group 也只拉一次。
 *
 * 布局:
 * - 1 个成员:满格
 * - 2 个:左右平分
 * - 3 个:上 1 大 + 下 2(微信式)
 * - 4 个及以上:2×2,4+ 取前 4 个
 */

import { useEffect, useState } from 'react'
import { useGroupsStore } from '../stores/groupsStore'
import type { Companion } from '../api/companions'
import logoFaceRight from '../assets/yiyi-logo-face-right.png'

interface Props {
  /** null/undefined = 单聊;number = 群聊家族 id */
  groupId: number | null | undefined
  /** 整体外径,px。默认 36(session list 项常用尺寸)。 */
  size?: number
  /** 圆角半径,默认 sm(IM 风,不是完全圆)。 */
  radius?: 'sm' | 'md' | 'full'
}

export function AvatarGrid({ groupId, size = 36, radius = 'md' }: Props) {
  const radiusClass = radius === 'full' ? 'rounded-full' : radius === 'sm' ? 'rounded-md' : 'rounded-lg'

  // 单聊:直接 YiYi logo
  if (groupId == null) {
    return (
      <div
        className={`shrink-0 ${radiusClass} flex items-center justify-center overflow-hidden`}
        style={{ width: size, height: size, background: 'var(--color-bg-subtle)' }}
      >
        <img src={logoFaceRight} alt="YiYi" width={size - 4} height={size - 4} />
      </div>
    )
  }

  return <GroupAvatarGrid groupId={groupId} size={size} radiusClass={radiusClass} />
}

function GroupAvatarGrid({
  groupId,
  size,
  radiusClass,
}: {
  groupId: number
  size: number
  radiusClass: string
}) {
  const ensureMembers = useGroupsStore(s => s.ensureMembers)
  const cached = useGroupsStore(s => s.membersByGroup.get(groupId))
  const [members, setMembers] = useState<Companion[] | undefined>(cached)

  useEffect(() => {
    if (members) return
    let cancelled = false
    ensureMembers(groupId).then(m => {
      if (!cancelled) setMembers(m)
    })
    return () => {
      cancelled = true
    }
  }, [groupId, members, ensureMembers])

  // 加载中 / 空成员:用一个占位框 + 群字样,而不是闪空白。
  if (!members || members.length === 0) {
    return (
      <div
        className={`shrink-0 ${radiusClass} flex items-center justify-center`}
        style={{
          width: size,
          height: size,
          background: 'var(--color-bg-subtle)',
          color: 'var(--color-text-muted)',
          fontSize: Math.floor(size * 0.4),
        }}
      >
        👪
      </div>
    )
  }

  const cells = members.slice(0, 4)
  return (
    <div
      className={`shrink-0 ${radiusClass} overflow-hidden grid`}
      style={{
        width: size,
        height: size,
        gridTemplateColumns: cells.length === 1 ? '1fr' : '1fr 1fr',
        gridTemplateRows:
          cells.length <= 2 ? '1fr' : cells.length === 3 ? '1fr 1fr' : '1fr 1fr',
        background: 'var(--color-bg-subtle)',
        gap: '1px',
      }}
    >
      {cells.length === 3 ? (
        <>
          {/* 3 人布局:上方 1 大格 + 下方 2 小格(微信式) */}
          <AvatarCell c={cells[0]} fontSize={size * 0.4} style={{ gridColumn: 'span 2' }} />
          <AvatarCell c={cells[1]} fontSize={size * 0.35} />
          <AvatarCell c={cells[2]} fontSize={size * 0.35} />
        </>
      ) : (
        cells.map((c, i) => (
          <AvatarCell
            key={`${c.id}-${i}`}
            c={c}
            fontSize={cells.length === 1 ? size * 0.5 : size * 0.35}
          />
        ))
      )}
    </div>
  )
}

function AvatarCell({
  c,
  fontSize,
  style,
}: {
  c: Companion
  fontSize: number
  style?: React.CSSProperties
}) {
  const bg = c.color_hex ? `${c.color_hex}22` : 'var(--color-bg-subtle)'
  return (
    <div
      className="flex items-center justify-center"
      style={{ background: bg, fontSize: `${Math.floor(fontSize)}px`, lineHeight: 1, ...style }}
    >
      {c.avatar_emoji || '🤖'}
    </div>
  )
}
