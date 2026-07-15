import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import settings from '@/settings'
import i18n, { langTitle } from '@/lang'
import { toggleHtmlClass } from '@/theme/utils'

export interface ConfigState {
  language: 'zh' | 'en'
  theme: string
  size: 'large' | 'default' | 'small'
  setTheme: (data: string) => void
  setSize: (data: 'large' | 'default' | 'small') => void
  setLanguage: (lang: 'zh' | 'en') => void
}

export const useConfigStore = create<ConfigState>()(
  persist(
    (set) => ({
      language: settings.defaultLanguage,
      theme: settings.defaultTheme,
      size: settings.defaultSize,
      setTheme: (data) => {
        set({ theme: data })
        toggleHtmlClass(data)
      },
      setSize: (data) => set({ size: data }),
      setLanguage: (lang) => {
        set({ language: lang })
        i18n.changeLanguage(lang)
        document.title = langTitle(undefined)
      }
    }),
    {
      name: 'config',
      partialize: (s) => ({ language: s.language, theme: s.theme })
    }
  )
)
