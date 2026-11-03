import type { ReactNode } from 'react';

/** The SOVRAN mark: a squared "S" drawn on a 3-unit grid, like a segment display on an instrument. */
export function Mark({ size = 16, title }: { size?: number; title?: string }) {
  return (
    <svg className="sv-mark" width={size} height={size} viewBox="0 0 24 24" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <path fill="currentColor" d="M5 3h14v5h-3V6H8v4h11v11H5v-5h3v2h8v-5H5z" />
    </svg>
  );
}

export function Icon({ name, spin, label, className }: { name: string; spin?: boolean; label?: string; className?: string }) {
  return (
    <i
      className={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  );
}

export function IconButton({ icon, label, onClick, disabled }: { icon: string; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="sv-icon-btn" title={label} aria-label={label} onClick={onClick} disabled={disabled}>
      <Icon name={icon} />
    </button>
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  icon,
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const cls = variant === 'secondary' ? 'sv-btn' : variant === 'danger' ? 'sv-btn sv-btn--ghost sv-btn--danger' : `sv-btn sv-btn--${variant}`;
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled} title={title}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}
