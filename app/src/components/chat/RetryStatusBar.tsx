import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useChatStreamStore, type RetryErrorType } from '../../stores/chatStreamStore';

const ERROR_TYPE_LABELS: Record<RetryErrorType, string> = {
  transient: '服务暂时繁忙',
  rate_limited: '请求过于频繁',
  context_overflow: '对话过长，正在调整',
  auth_error: '认证失败',
  client_error: '请求异常',
};

export function RetryStatusBar() {
  const retryStatus = useChatStreamStore((s) => s.retryStatus);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (!retryStatus) {
      setCountdown(0);
      return;
    }
    const totalSecs = Math.ceil(retryStatus.delay_ms / 1000);
    setCountdown(totalSecs);
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [retryStatus]);

  if (!retryStatus) return null;

  const label = ERROR_TYPE_LABELS[retryStatus.error_type] || '网络波动';

  return (
    <div
      className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-[12px] animate-in fade-in slide-in-from-bottom-1 duration-200"
      style={{
        background: 'rgba(var(--color-warning-rgb, 255,190,60), 0.10)',
        border: '1px solid rgba(var(--color-warning-rgb, 255,190,60), 0.25)',
        color: 'var(--color-text-secondary)',
        maxWidth: 'fit-content',
      }}
    >
      <RefreshCw size={13} className="animate-spin" style={{ opacity: 0.7 }} />
      <span>
        {label}，{countdown > 0 ? `${countdown}秒后` : '即将'}重试
        <span style={{ opacity: 0.6 }}> ({retryStatus.attempt}/{retryStatus.max_retries})</span>
      </span>
    </div>
  );
}
