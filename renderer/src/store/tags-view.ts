import { create } from 'zustand'
import settings from '@/settings'

export interface TagView {
  path: string
  title?: string
  meta: { title?: string; affix?: boolean; [k: string]: any }
  [k: string]: any
}

export interface TagsViewState {
  visitedViews: TagView[]
  addVisitedView: (view: TagView) => void
  delVisitedView: (view: TagView) => Promise<TagView[]>
  delOthersVisitedViews: (view: TagView) => Promise<TagView[]>
  delAllVisitedViews: () => Promise<TagView[]>
}

export const useTagsViewStore = create<TagsViewState>((set, get) => ({
  visitedViews: [],
  addVisitedView: (view) =>
    set((s) => {
      if (s.visitedViews.some((v) => v.path === view.path)) return s
      const tag = { ...view, title: view.meta.title || 'no-name' }
      const next =
        s.visitedViews.length >= settings.tagsViewNum
          ? [...s.visitedViews.slice(0, -1), tag]
          : [...s.visitedViews, tag]
      return { visitedViews: next }
    }),
  delVisitedView: (view) => {
    set((s) => ({ visitedViews: s.visitedViews.filter((v) => v.path !== view.path) }))
    return Promise.resolve([...get().visitedViews])
  },
  delOthersVisitedViews: (view) => {
    set((s) => ({ visitedViews: s.visitedViews.filter((v) => v.meta.affix || v.path === view.path) }))
    return Promise.resolve([...get().visitedViews])
  },
  delAllVisitedViews: () => {
    set((s) => ({ visitedViews: s.visitedViews.filter((tag) => tag.meta?.affix) }))
    return Promise.resolve([...get().visitedViews])
  }
}))
