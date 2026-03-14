/**
 * chatActions — Shared quick action data for ChatWelcome and QuickActionsOverlay.
 */

import type { ComponentType } from 'react';
import {
  MessageSquare,
  Puzzle,
  Terminal,
  FileText,
  Clock,
  BarChart3,
} from 'lucide-react';

export interface QuickAction {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: ComponentType<any>;
  label: string;
  desc: string;
  examples: string[];
  color: string;
}

export function getQuickActions(t: (key: string) => string): QuickAction[] {
  return [
    {
      icon: MessageSquare,
      label: t('chat.quick.askAnything'),
      desc: t('chat.quick.askAnythingDesc'),
      examples: [t('chat.quick.askAnythingEx1'), t('chat.quick.askAnythingEx2'), t('chat.quick.askAnythingEx3')],
      color: 'var(--color-primary)',
    },
    {
      icon: Puzzle,
      label: t('chat.quick.skills'),
      desc: t('chat.quick.skillsDesc'),
      examples: [t('chat.quick.skillsEx1'), t('chat.quick.skillsEx2'), t('chat.quick.skillsEx3')],
      color: '#8b5cf6',
    },
    {
      icon: Terminal,
      label: t('chat.quick.command'),
      desc: t('chat.quick.commandDesc'),
      examples: [t('chat.quick.commandEx1'), t('chat.quick.commandEx2'), t('chat.quick.commandEx3')],
      color: '#059669',
    },
    {
      icon: Clock,
      label: t('chat.quick.schedule'),
      desc: t('chat.quick.scheduleDesc'),
      examples: [t('chat.quick.scheduleEx1'), t('chat.quick.scheduleEx2'), t('chat.quick.scheduleEx3')],
      color: '#d97706',
    },
    {
      icon: FileText,
      label: t('chat.quick.writing'),
      desc: t('chat.quick.writingDesc'),
      examples: [t('chat.quick.writingEx1'), t('chat.quick.writingEx2'), t('chat.quick.writingEx3')],
      color: '#e11d48',
    },
    {
      icon: BarChart3,
      label: t('chat.quick.analysis'),
      desc: t('chat.quick.analysisDesc'),
      examples: [t('chat.quick.analysisEx1'), t('chat.quick.analysisEx2'), t('chat.quick.analysisEx3')],
      color: '#0891b2',
    },
  ];
}
