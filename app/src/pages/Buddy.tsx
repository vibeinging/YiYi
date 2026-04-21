/**
 * Buddy Page — The soul of YiYi.
 * Hero zone: companion orb with personality at a glance.
 * Below: three-column grid for Growth, Memory, and System.
 */

import { useTranslation } from 'react-i18next';
import { BuddyPanel } from '../components/BuddyPanel';

export function BuddyPage() {
  const { t } = useTranslation();

  return (
    <div className="h-full overflow-y-auto buddy-page">
      <div className="w-full px-6 py-6">
        <BuddyPanel />
      </div>
    </div>
  );
}
