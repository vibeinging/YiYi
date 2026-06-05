/**
 * WeixinQrLogin — 微信个人号 iLink 扫码登录。
 * 取二维码 → 显示 → 每 2 秒轮询扫码状态 → confirmed 时把 bot_token + base_url 回调出去。
 * 无 qrcode 库,直接显示后端返回的 qrcode_img_content。
 */
import { useState, useEffect, useRef } from 'react';
import { Loader2, Check, RefreshCw } from 'lucide-react';
import { weixinGetQrcode, weixinPollLogin } from '../../api/bots';

interface Props {
  onConfirmed: (botToken: string, baseUrl: string) => void;
}

export function WeixinQrLogin({ onConfirmed }: Props) {
  const [img, setImg] = useState('');
  const [status, setStatus] = useState<'loading' | 'waiting' | 'confirmed' | 'error'>('loading');
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const qrcodeRef = useRef('');
  const doneRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    doneRef.current = false;
    setStatus('loading');
    setError('');
    setImg('');

    (async () => {
      try {
        const res = await weixinGetQrcode();
        if (cancelled) return;
        qrcodeRef.current = res.qrcode;
        setImg(res.img);
        setStatus('waiting');
        timer = setInterval(async () => {
          if (doneRef.current || cancelled) return;
          try {
            const r = await weixinPollLogin(qrcodeRef.current);
            if (r.confirmed && r.bot_token) {
              doneRef.current = true;
              if (timer) clearInterval(timer);
              setStatus('confirmed');
              onConfirmed(r.bot_token, r.base_url || '');
            }
          } catch {
            /* 轮询失败容忍,下次再来 */
          }
        }, 2000);
      } catch (e) {
        if (!cancelled) {
          setStatus('error');
          setError(String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [reloadKey, onConfirmed]);

  // img 兼容:data URL / http / 裸 base64。
  const imgSrc = !img
    ? ''
    : img.startsWith('data:') || img.startsWith('http')
      ? img
      : `data:image/png;base64,${img}`;

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      {status === 'loading' && (
        <div
          className="w-44 h-44 rounded-xl flex items-center justify-center"
          style={{ background: 'var(--color-bg-muted)' }}
        >
          <Loader2 className="animate-spin" size={28} style={{ color: 'var(--color-text-muted)' }} />
        </div>
      )}

      {status === 'error' && (
        <div className="flex flex-col items-center gap-2 py-6">
          <p className="text-[12.5px] text-center" style={{ color: 'var(--color-error)' }}>取二维码失败</p>
          <p
            className="text-[11px] text-center max-w-[260px] break-words"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {error}
          </p>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium mt-1"
            style={{ background: 'var(--color-bg-muted)', color: 'var(--color-text)' }}
          >
            <RefreshCw size={12} /> 重试
          </button>
        </div>
      )}

      {(status === 'waiting' || status === 'confirmed') && imgSrc && (
        <div className="relative w-44 h-44 rounded-xl overflow-hidden bg-white p-2 shadow-sm">
          <img src={imgSrc} alt="微信登录二维码" className="w-full h-full object-contain" />
          {status === 'confirmed' && (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
              <Check size={48} style={{ color: '#22c55e' }} strokeWidth={3} />
            </div>
          )}
        </div>
      )}

      {status !== 'error' && (
        <p className="text-[12.5px] text-center" style={{ color: 'var(--color-text-muted)' }}>
          {status === 'confirmed'
            ? '已扫码确认,点下方「创建」完成接入'
            : status === 'waiting'
              ? '用微信扫码,在手机上确认登录'
              : '正在获取二维码…'}
        </p>
      )}

      <p
        className="text-[11px] text-center max-w-[280px]"
        style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}
      >
        腾讯官方 iLink 协议 · 注意:bot 只能被动回复(对方先发消息),无法主动推送。
      </p>
    </div>
  );
}
