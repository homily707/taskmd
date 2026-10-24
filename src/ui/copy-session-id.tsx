import { useEffect, useRef, useState } from 'react';

/**
 * Copies one Session ID to the clipboard.
 *
 * The clipboard API only exists in a secure context, so a page served over
 * plain HTTP from anything but `localhost` has none at all. There the button
 * falls back to selecting the ID's text so the user can copy it manually, and
 * says so; a rejection (permission denied, no focused document) is reported the
 * same way instead of failing silently.
 */
export function CopySessionId({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState('');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // A different Session means the previous confirmation no longer applies.
  useEffect(() => { setCopied(false); setStatus(''); }, [sessionId]);
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current); }, []);

  const copy = async () => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(sessionId);
        setCopied(true);
        setStatus('已复制会话 ID');
        if (timer.current !== undefined) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
        return;
      } catch {
        // Fall through to the manual instruction below.
      }
    }
    setCopied(false);
    setStatus('此环境不允许写入剪贴板（需要 https 或 localhost），请手动选中会话 ID 复制。');
  };

  return <>
    <button type="button" disabled={!sessionId} aria-label={`复制会话 ID ${sessionId}`}
      onClick={() => { void copy(); }}>{copied ? '已复制' : '复制 ID'}</button>
    {status && <span className="taskmd-muted" role="status">{status}</span>}
  </>;
}
