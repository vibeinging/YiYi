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
  Zap,
  Star,
  Heart,
  Code,
  Globe,
  Mail,
  Search,
  BookOpen,
  Lightbulb,
  Wrench,
  Sparkles,
  Rocket,
  PenTool,
  Music,
  Camera,
  Shield,
} from 'lucide-react';
import type { CustomQuickAction } from '../../api/system';

export interface QuickAction {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: ComponentType<any>;
  label: string;
  desc: string;
  examples: string[];
  color: string;
  /** If set, this is a custom action with this id */
  customId?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ICON_MAP: Record<string, ComponentType<any>> = {
  Zap,
  Star,
  Heart,
  Code,
  Globe,
  Mail,
  Search,
  BookOpen,
  Lightbulb,
  Wrench,
  Sparkles,
  Rocket,
  PenTool,
  Music,
  Camera,
  Shield,
  MessageSquare,
  Puzzle,
  Terminal,
  FileText,
  Clock,
  BarChart3,
};

export function getIconNames(): string[] {
  return Object.keys(ICON_MAP);
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

/**
 * Merge built-in actions with custom user actions.
 * Custom actions are appended after builtins.
 */
export function mergeWithCustomActions(
  builtins: QuickAction[],
  customs: CustomQuickAction[],
): QuickAction[] {
  const customActions: QuickAction[] = customs.map((c) => ({
    icon: ICON_MAP[c.icon] || Zap,
    label: c.label,
    desc: c.description,
    examples: [c.prompt],
    color: c.color,
    customId: c.id,
  }));
  return [...builtins, ...customActions];
}
