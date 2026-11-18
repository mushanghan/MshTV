import { useState, type ReactNode } from 'react';

export function InlineDeleteButton({ className, disabled, title, label, confirmation = '确认删除', onConfirm, children }: {
  className: string; disabled: boolean; title: string; label: string; confirmation?: string;
  onConfirm: () => void; children: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  return <button type="button" className={`${className} inline-delete`} disabled={disabled} draggable={false} title={title}
    aria-label={confirming ? `确认${label}` : label}
    onBlur={() => setConfirming(false)}
    onKeyDown={event => {
      if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
      if (confirming && event.key === 'Escape') {
        event.stopPropagation();
        setConfirming(false);
      }
    }}
    onClick={event => {
      if (confirming) {
        setConfirming(false);
        onConfirm();
      } else {
        event.currentTarget.focus();
        setConfirming(true);
      }
    }}>
    {children}
    {confirming && <span className="inline-delete-confirm" aria-hidden="true">{confirmation}</span>}
  </button>;
}
