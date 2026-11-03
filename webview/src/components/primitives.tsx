import type { ReactNode } from 'react';

/** The Sovran symbol "[•]": brackets follow the theme's text colour; the dot is the brand accent. */
export function Mark({ size = 16, title }: { size?: number; title?: string }) {
  return (
    <svg className="sv-mark" width={size} height={size} viewBox="0 0 48 48" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <path fill="currentColor" d="M6 6H18V12H12V36H18V42H6Z M42 6H30V12H36V36H30V42H42Z" />
      <circle className="sv-mark__dot" cx="24" cy="24" r="6" />
    </svg>
  );
}

/** Full lockup (symbol, wordmark, motto). Artwork comes from media/brand via media/sovran.css and follows the theme. */
export function Logo({ className }: { className?: string }) {
  return <span className={`sovran-logo${className ? ` ${className}` : ''}`} role="img" aria-label="Sovran. Own your intelligence." />;
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
