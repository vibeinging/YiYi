/**
 * Setup Wizard - CSS animation styles
 */

export function SetupWizardStyles() {
  return (
    <style>{`
      @keyframes sw-fade-up {
        from { opacity: 0; transform: translateY(16px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes sw-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes sw-scale-in {
        from { opacity: 0; transform: scale(0.9); }
        to { opacity: 1; transform: scale(1); }
      }
      @keyframes sw-logo-enter {
        from { opacity: 0; transform: scale(0.8) translateY(12px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      @keyframes sw-pulse-ring {
        0% { box-shadow: 0 0 0 0 var(--color-primary-subtle); }
        70% { box-shadow: 0 0 0 8px transparent; }
        100% { box-shadow: 0 0 0 0 transparent; }
      }
      @keyframes sw-check-pop {
        0% { transform: scale(0); opacity: 0; }
        50% { transform: scale(1.2); }
        100% { transform: scale(1); opacity: 1; }
      }
      @keyframes sw-line-fill {
        from { background-size: 100% 0%; }
        to { background-size: 100% 100%; }
      }
      @keyframes sw-float {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-4px); }
      }
      .sw-step-dot { transition: all 0.4s cubic-bezier(0.25, 1, 0.5, 1); }
      .sw-step-dot.active { animation: sw-pulse-ring 1.5s ease-out; }
      .sw-check-enter { animation: sw-check-pop 0.35s cubic-bezier(0.25, 1, 0.5, 1) forwards; }
      .sw-card {
        transition: transform 0.2s cubic-bezier(0.25, 1, 0.5, 1), box-shadow 0.2s ease, border-color 0.2s ease;
      }
      .sw-card:hover { transform: translateY(-1px); }
      .sw-card:active { transform: scale(0.98); }
      .sw-stagger-1 { animation: sw-fade-up 0.45s cubic-bezier(0.25, 1, 0.5, 1) 0.05s both; }
      .sw-stagger-2 { animation: sw-fade-up 0.45s cubic-bezier(0.25, 1, 0.5, 1) 0.12s both; }
      .sw-stagger-3 { animation: sw-fade-up 0.45s cubic-bezier(0.25, 1, 0.5, 1) 0.19s both; }
      .sw-stagger-4 { animation: sw-fade-up 0.45s cubic-bezier(0.25, 1, 0.5, 1) 0.26s both; }
      .sw-hero-logo { animation: sw-logo-enter 0.6s cubic-bezier(0.25, 1, 0.5, 1) 0.1s both; }
      .sw-hero-title { animation: sw-fade-up 0.5s cubic-bezier(0.25, 1, 0.5, 1) 0.25s both; }
      .sw-hero-sub { animation: sw-fade-up 0.5s cubic-bezier(0.25, 1, 0.5, 1) 0.35s both; }
      .sw-hero-cards { animation: sw-fade-up 0.5s cubic-bezier(0.25, 1, 0.5, 1) 0.45s both; }
      .sw-sidebar-logo { animation: sw-scale-in 0.5s cubic-bezier(0.25, 1, 0.5, 1) 0.1s both; }
      .sw-btn-next {
        transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.2s ease;
      }
      .sw-btn-next:hover:not(:disabled) { transform: translateX(2px); box-shadow: 0 4px 16px rgba(0,0,0,0.15); }
      .sw-btn-next:active:not(:disabled) { transform: translateX(0) scale(0.97); }
      .sw-btn-back {
        transition: transform 0.15s ease, opacity 0.2s ease;
      }
      .sw-btn-back:hover { transform: translateX(-2px); }
      .sw-float { animation: sw-float 3s ease-in-out infinite; }
      @keyframes sw-glow-hint {
        0%, 100% { border-color: var(--color-border); box-shadow: none; }
        50% { border-color: var(--color-primary); box-shadow: 0 0 0 3px rgba(var(--color-primary-rgb), 0.12); }
      }
      .sw-input-hint {
        animation: sw-glow-hint 2s cubic-bezier(0.4, 0, 0.6, 1) 0.6s 2;
      }
      .sw-input-hint:focus { animation: none; border-color: var(--color-primary) !important; box-shadow: 0 0 0 3px rgba(var(--color-primary-rgb), 0.15); }
      .sw-stagger-5 { animation: sw-fade-up 0.45s cubic-bezier(0.25, 1, 0.5, 1) 0.33s both; }
      .sw-stagger-6 { animation: sw-fade-up 0.45s cubic-bezier(0.25, 1, 0.5, 1) 0.40s both; }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.05ms !important;
        }
      }
    `}</style>
  );
}
