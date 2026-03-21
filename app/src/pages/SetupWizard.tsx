/**
 * Setup Wizard - AI-guided onboarding flow
 * Steps: Language → Model → Workspace → Persona → Meditation
 * Layout: vertical progress rail on left + content area on right
 */

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import {
  ChevronRight,
  ChevronLeft,
  Loader2,
  Sparkles,
} from 'lucide-react';
import {
  configureProvider,
  testProvider,
  setActiveLlm,
  createCustomProvider,
  type TestConnectionResponse,
} from '../api/models';
import {
  getWorkspacePath,
  pickFolder,
  listAuthorizedFolders,
  addAuthorizedFolder,
  removeAuthorizedFolder,
  type AuthorizedFolder,
} from '../api/workspace';
import { completeSetup } from '../api/system';
import {
  QUICK_PROVIDERS,
  BUILTIN_PROVIDER_IDS,
  STEPS,
  buildSoulContent,
  type Step,
} from './setup/setupWizardData';
import { StepLanguage } from './setup/StepLanguage';
import { StepModel } from './setup/StepModel';
import { StepWorkspace } from './setup/StepWorkspace';
import { StepPersona } from './setup/StepPersona';
import { StepMeditation } from './setup/StepMeditation';
import { SetupWizardStyles } from './setup/SetupWizardStyles';
import { ProgressRail } from './setup/ProgressRail';

interface SetupWizardProps {
  onComplete: () => void;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const { t } = useTranslation();
  const [currentStep, setCurrentStep] = useState<Step>('language');
  const [slideDir, setSlideDir] = useState<'up' | 'down' | null>(null);
  const [animating, setAnimating] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Language step
  const [selectedLang, setSelectedLang] = useState(
    localStorage.getItem('language') || 'zh'
  );

  // Model step
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [customModelId, setCustomModelId] = useState('');
  const [useCustomModel, setUseCustomModel] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [showBaseUrl, setShowBaseUrl] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);
  const [modelSaving, setModelSaving] = useState(false);

  // Workspace step
  const [workspacePath, setWorkspacePath] = useState('');
  const [authorizedFolders, setAuthorizedFolders] = useState<AuthorizedFolder[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);

  // Persona step
  const [aiName, setAiName] = useState('YiYi');
  const [ownerName, setOwnerName] = useState('');
  const [toneStyle, setToneStyle] = useState('balanced');
  const [selectedRole, setSelectedRole] = useState('assistant');
  const [customSoul, setCustomSoul] = useState('');
  const [finishing, setFinishing] = useState(false);

  // Meditation step
  const [meditationEnabled, setMeditationEnabled] = useState(true);
  const [meditationStart, setMeditationStart] = useState('23:00');
  const [meditationNotify, setMeditationNotify] = useState(true);

  const lang = selectedLang.startsWith('zh') ? 'zh' : 'en';
  const stepIndex = STEPS.indexOf(currentStep);

  // Animate step transition
  const transitionTo = (target: Step) => {
    const targetIndex = STEPS.indexOf(target);
    const dir = targetIndex > stepIndex ? 'up' : 'down';
    setSlideDir(dir);
    setAnimating(true);

    // After exit animation, switch step and enter
    setTimeout(() => {
      setCurrentStep(target);
      setSlideDir(dir === 'up' ? 'down' : 'up'); // enter from opposite
      setTimeout(() => {
        setSlideDir(null);
        setAnimating(false);
      }, 30);
    }, 250);
  };

  // Reset scroll on step change
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [currentStep]);

  // Load workspace info when entering workspace step
  useEffect(() => {
    if (currentStep === 'workspace' && !workspacePath) {
      getWorkspacePath().then(setWorkspacePath).catch(() => {});
      listAuthorizedFolders().then(setAuthorizedFolders).catch(() => {});
    }
  }, [currentStep]);

  const handlePickFolder = async () => {
    const path = await pickFolder();
    if (path) {
      // Check if already in list
      if (authorizedFolders.some(f => f.path === path)) return;
      setWorkspaceLoading(true);
      try {
        const folder = await addAuthorizedFolder(path, undefined, 'read_write');
        setAuthorizedFolders(prev => [...prev, folder]);
      } catch (e) {
        console.error('Failed to add folder:', e);
      } finally {
        setWorkspaceLoading(false);
      }
    }
  };

  const handleRemoveFolder = async (id: string) => {
    try {
      await removeAuthorizedFolder(id);
      setAuthorizedFolders(prev => prev.filter(f => f.id !== id));
    } catch (e) {
      console.error('Failed to remove folder:', e);
    }
  };

  const handleLangSelect = (lng: string) => {
    setSelectedLang(lng);
    i18n.changeLanguage(lng);
    localStorage.setItem('language', lng);
  };

  const handleTestConnection = async (): Promise<boolean> => {
    const provider = QUICK_PROVIDERS.find(p => p.id === selectedProvider);
    if (!provider || !apiKey.trim()) return false;

    setTesting(true);
    setTestResult(null);
    try {
      const modelId = useCustomModel ? customModelId.trim() : (selectedModel || provider.models[0]?.id);
      const result = await testProvider(provider.id, apiKey.trim(), baseUrl || provider.baseUrl, modelId);
      setTestResult(result);
      return result.success;
    } catch (e: any) {
      setTestResult({ success: false, message: e.toString() });
      return false;
    } finally {
      setTesting(false);
    }
  };

  const handleModelSave = async () => {
    const provider = QUICK_PROVIDERS.find(p => p.id === selectedProvider);
    if (!provider || !apiKey.trim()) return;

    // If already tested successfully, skip re-test; otherwise test first
    const alreadyPassed = testResult?.success === true;
    if (!alreadyPassed) {
      const ok = await handleTestConnection();
      if (!ok) return; // Test failed — stay on this step
    }

    const modelId = useCustomModel ? customModelId.trim() : (selectedModel || provider.models[0].id);
    setModelSaving(true);
    try {
      // For non-builtin providers, create as custom provider first
      if (!BUILTIN_PROVIDER_IDS.includes(provider.id)) {
        await createCustomProvider(
          provider.id,
          provider.name,
          baseUrl || provider.baseUrl,
          provider.id.toUpperCase().replace(/-/g, '_') + '_API_KEY',
          provider.models.map(m => ({ id: m.id, name: m.name })),
        );
      }
      // Configure API key (needed for both custom and builtin)
      await configureProvider(provider.id, apiKey.trim(), baseUrl || provider.baseUrl);
      await setActiveLlm(provider.id, modelId);
      transitionTo('workspace');
    } catch (e: any) {
      setTestResult({ success: false, message: e.toString() });
    } finally {
      setModelSaving(false);
    }
  };

  const handleFinish = async () => {
    setFinishing(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');

      // Save meditation config
      await invoke('save_meditation_config', {
        enabled: meditationEnabled,
        startTime: meditationStart,
        notifyOnComplete: meditationNotify,
      });

      // Build and write SOUL.md
      const soulContent = buildSoulContent(aiName, ownerName, toneStyle, selectedRole, customSoul, lang);

      if (soulContent.trim()) {
        await invoke('save_workspace_file', {
          filename: 'SOUL.md',
          content: `---\nname: ${aiName.trim() || 'YiYi'}\n---\n\n${soulContent}`,
        });
      }

      // Write language config
      await invoke('save_agents_config', { language: selectedLang });

      await completeSetup();
      onComplete();
    } catch (e) {
      console.error('Failed to finish setup:', e);
      // Still complete even if persona write fails
      await completeSetup().catch(() => {});
      onComplete();
    } finally {
      setFinishing(false);
    }
  };

  const canProceed = () => {
    switch (currentStep) {
      case 'language': return true;
      case 'model': return !!selectedProvider && !!apiKey.trim() && (useCustomModel ? !!customModelId.trim() : !!selectedModel);
      case 'workspace': return true; // workspace has defaults, always can proceed
      case 'persona': return selectedRole !== 'custom' || customSoul.trim().length > 0;
      case 'meditation': return true;
    }
  };

  const goNext = () => {
    if (currentStep === 'language') transitionTo('model');
    else if (currentStep === 'model') handleModelSave();
    else if (currentStep === 'workspace') transitionTo('persona');
    else if (currentStep === 'persona') transitionTo('meditation');
    else if (currentStep === 'meditation') handleFinish();
  };

  const goBack = () => {
    if (currentStep === 'model') transitionTo('language');
    else if (currentStep === 'workspace') transitionTo('model');
    else if (currentStep === 'persona') transitionTo('workspace');
    else if (currentStep === 'meditation') transitionTo('persona');
  };

  // Slide animation style — uses quart easing for natural deceleration
  const contentStyle: React.CSSProperties = {
    transition: slideDir ? 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.25s ease' : 'none',
    transform: slideDir === 'up' ? 'translateY(-24px)' : slideDir === 'down' ? 'translateY(24px)' : 'translateY(0)',
    opacity: slideDir ? 0 : 1,
  };

  return (
    <div
      className="h-screen flex"
      style={{ background: 'var(--color-bg)' }}
    >
      {/* Setup Wizard animations */}
      <SetupWizardStyles />
      {/* Left: Vertical progress rail */}
      <ProgressRail lang={lang} currentStep={currentStep} />

      {/* Right: Content area */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Content */}
        <div
          ref={contentRef}
          className="flex-1 overflow-hidden"
        >
          <div className="h-full mx-auto px-12 py-10 flex flex-col" style={{ ...contentStyle, maxWidth: '1100px' }}>
            {currentStep === 'language' && (
              <StepLanguage
                lang={lang}
                selectedLang={selectedLang}
                onLangSelect={handleLangSelect}
              />
            )}

            {currentStep === 'model' && (
              <StepModel
                lang={lang}
                selectedProvider={selectedProvider}
                selectedModel={selectedModel}
                customModelId={customModelId}
                useCustomModel={useCustomModel}
                apiKey={apiKey}
                baseUrl={baseUrl}
                showBaseUrl={showBaseUrl}
                testing={testing}
                testResult={testResult}
                onSelectProvider={setSelectedProvider}
                onSelectModel={setSelectedModel}
                onCustomModelIdChange={setCustomModelId}
                onUseCustomModelChange={setUseCustomModel}
                onApiKeyChange={setApiKey}
                onBaseUrlChange={setBaseUrl}
                onShowBaseUrlChange={setShowBaseUrl}
                onTestConnection={handleTestConnection}
                onTestResultClear={() => setTestResult(null)}
              />
            )}

            {currentStep === 'workspace' && (
              <StepWorkspace
                lang={lang}
                workspacePath={workspacePath}
                authorizedFolders={authorizedFolders}
                workspaceLoading={workspaceLoading}
                onPickFolder={handlePickFolder}
                onRemoveFolder={handleRemoveFolder}
              />
            )}

            {currentStep === 'persona' && (
              <StepPersona
                lang={lang}
                currentStep={currentStep}
                aiName={aiName}
                ownerName={ownerName}
                toneStyle={toneStyle}
                selectedRole={selectedRole}
                customSoul={customSoul}
                onAiNameChange={setAiName}
                onOwnerNameChange={setOwnerName}
                onToneStyleChange={setToneStyle}
                onSelectedRoleChange={setSelectedRole}
                onCustomSoulChange={setCustomSoul}
              />
            )}

            {currentStep === 'meditation' && (
              <StepMeditation
                lang={lang}
                meditationEnabled={meditationEnabled}
                meditationStart={meditationStart}
                meditationNotify={meditationNotify}
                onMeditationEnabledChange={setMeditationEnabled}
                onMeditationStartChange={setMeditationStart}
                onMeditationNotifyChange={setMeditationNotify}
              />
            )}
          </div>
        </div>

        {/* Bottom navigation bar */}
        <div
          className="shrink-0 px-8 py-5 flex items-center justify-between"
          style={{ borderTop: '1px solid var(--color-border)' }}
        >
          <div>
            {stepIndex > 0 && (
              <button
                onClick={goBack}
                disabled={animating}
                className="flex items-center gap-2.5 px-6 py-3 rounded-xl text-[14px] font-medium disabled:opacity-40 sw-btn-back"
                style={{ color: 'var(--color-text-secondary)' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-subtle)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <ChevronLeft size={18} />
                {t('common.back')}
              </button>
            )}
          </div>

          <div className="flex items-center gap-4">
            {(currentStep === 'model' || currentStep === 'workspace') && (
              <button
                onClick={() => transitionTo(currentStep === 'model' ? 'workspace' : 'persona')}
                disabled={animating}
                className="px-6 py-3 rounded-xl text-[14px] font-medium disabled:opacity-40"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {lang === 'zh' ? '跳过' : 'Skip'}
              </button>
            )}
            <button
              onClick={goNext}
              disabled={!canProceed() || modelSaving || finishing || testing || animating}
              className="flex items-center gap-2.5 px-8 py-3 rounded-xl text-[14px] font-bold text-white disabled:opacity-40 sw-btn-next"
              style={{ background: 'var(--color-primary)', boxShadow: '0 4px 16px rgba(var(--color-primary-rgb), 0.3)' }}
            >
              {(modelSaving || finishing || testing) && <Loader2 size={16} className="animate-spin" />}
              {currentStep === 'meditation' ? (
                <>
                  <Sparkles size={16} />
                  {lang === 'zh' ? '开始使用' : 'Get Started'}
                </>
              ) : (
                <>
                  {t('common.next')}
                  <ChevronRight size={18} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
