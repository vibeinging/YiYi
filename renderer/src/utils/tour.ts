const TOUR_OPTIONS_KEY = 'tour-options';
const WEBSITE_FIRST_SHOW_KEY = 'website-first-show';
const KNOWLEDGE_FIRST_SHOW_KEY = 'knowledge-first-show';

function getLocalStorageOptions(): any {
  const raw = localStorage.getItem(TOUR_OPTIONS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveLocalStorageOptions(options: any) {
  localStorage.setItem(TOUR_OPTIONS_KEY, JSON.stringify(options));
}

// 检查是否是首次访问
export const hasWebsiteBeenShownFirstTime = () => {
  const tourOptions = getLocalStorageOptions();
  return !!tourOptions[WEBSITE_FIRST_SHOW_KEY];
}

// 设置首次访问状态
export const setWebsiteFirstShowStatus = (status: any) => {
  const tourOptions = getLocalStorageOptions();
  tourOptions[WEBSITE_FIRST_SHOW_KEY] = status;
  saveLocalStorageOptions(tourOptions);
}

export const hasKnowledgeBeenShownFirstTime = () => {
  const tourOptions = getLocalStorageOptions();
  return !!tourOptions[KNOWLEDGE_FIRST_SHOW_KEY];
}

export const setKnowledgeFirstShowStatus = (status: any) => {
  const tourOptions = getLocalStorageOptions();
  tourOptions[KNOWLEDGE_FIRST_SHOW_KEY] = status;
  saveLocalStorageOptions(tourOptions);
}

/** 管理员统一引导（el-tour，按 userId） */
const ADMIN_PROJECT_MODE_ONBOARDING_KEY = 'admin-project-mode-onboarding';

const getAdminProjectModeOnboardingMap = () => {
  const tourOptions = getLocalStorageOptions();
  return tourOptions[ADMIN_PROJECT_MODE_ONBOARDING_KEY] || {};
};

export const hasAdminProjectModeOnboardingBeenShown = (userId: any) => {
  if (!userId) return true;
  const map = getAdminProjectModeOnboardingMap();
  return !!map[String(userId)];
};

export const setAdminProjectModeOnboardingShownStatus = (userId: any, status: any) => {
  if (!userId) return;
  const tourOptions = getLocalStorageOptions();
  const map = tourOptions[ADMIN_PROJECT_MODE_ONBOARDING_KEY] || {};
  map[String(userId)] = status;
  tourOptions[ADMIN_PROJECT_MODE_ONBOARDING_KEY] = map;
  saveLocalStorageOptions(tourOptions);
};

function clearAdminProjectModeOnboardingDisk({ reload = true }: any = {}) {
  const tourOptions = getLocalStorageOptions();
  delete tourOptions[ADMIN_PROJECT_MODE_ONBOARDING_KEY];
  if (Object.keys(tourOptions).length === 0) {
    localStorage.removeItem(TOUR_OPTIONS_KEY);
  } else {
    saveLocalStorageOptions(tourOptions);
  }
  console.info('[YiW] Cleared admin-project-mode-onboarding.');
  if (reload) {
    console.info('[YiW] Reloading page to re-trigger the onboarding tour…');
    window.location.reload();
  }
}

function clearAllOnboardingDisk() {
  localStorage.removeItem(TOUR_OPTIONS_KEY);
  console.info('[YiW] Cleared all onboarding / tour flags. Reloading…');
  window.location.reload();
}

if (typeof window !== 'undefined') {
  // eslint-disable-next-line no-underscore-dangle
  (window as any).__AD_CLEAR_PROJECT_ADMIN_ONBOARDING__ = clearAdminProjectModeOnboardingDisk;
  // eslint-disable-next-line no-underscore-dangle
  (window as any).__AD_CLEAR_SYS_ADMIN_ONBOARDING__ = clearAdminProjectModeOnboardingDisk;
  // eslint-disable-next-line no-underscore-dangle
  (window as any).__AD_CLEAR_ALL_ONBOARDING__ = clearAllOnboardingDisk;
}
