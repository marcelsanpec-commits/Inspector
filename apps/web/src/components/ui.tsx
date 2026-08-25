import { useId, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api.js';

/**
 * Password field with a reveal toggle.
 *
 * Typing a long password blind on a phone keyboard, outdoors, in gloves, is how
 * people end up choosing short ones. Being able to check what you typed is a
 * security feature, not a hole in one - the risk is someone reading over your
 * shoulder, which the person holding the phone is best placed to judge.
 */
export function PasswordInput({
  value,
  onChange,
  autoComplete = 'current-password',
  minLength,
  required,
  autoFocus,
  placeholder,
}: {
  value: string;
  onChange(v: string): void;
  autoComplete?: string;
  minLength?: number;
  required?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  const id = useId();

  return (
    <div className="input-affix">
      <input
        id={id}
        className="input"
        // Toggling the type keeps the browser's password manager working,
        // which a custom masked field would break.
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        minLength={minLength}
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        // A revealed password should never be autocorrected or capitalised.
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="affix-btn"
        onClick={() => setVisible((v) => !v)}
        aria-pressed={visible}
        aria-controls={id}
        aria-label={visible ? 'Hide password' : 'Show password'}
        // Keep the field focused so toggling doesn't interrupt typing.
        onMouseDown={(e) => e.preventDefault()}
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const label = status.replace(/_/g, ' ');
  return <span className={`badge badge-${status}`}>{label}</span>;
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="inline muted" style={{ padding: '28px 0' }}>
      <span className="spin" />
      {label}
    </div>
  );
}

export function Skeletons({ count = 4 }: { count?: number }) {
  return (
    <div className="stack">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="small">{children}</div>}
      {action && <div className="mt">{action}</div>}
    </div>
  );
}

/**
 * Surfaces the API's own message rather than a generic failure string. The
 * server writes these deliberately - "That client is not on your roster yet"
 * tells someone what to do; "Something went wrong" does not.
 */
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return <div className="notice notice-error">{message}</div>;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" style={wide ? { maxWidth: 880 } : undefined}>
        <div className="modal-head">
          <h2 style={{ flex: 1 }}>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Chevron() {
  return (
    <svg className="chev" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M6 3.5L10.5 8L6 12.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function roleLabel(role: string): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'inspector':
      return 'Inspector';
    case 'member':
      return 'Member';
    default:
      return role;
  }
}
