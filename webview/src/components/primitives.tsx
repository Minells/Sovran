import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEventHandler, type ReactNode } from 'react';

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

export function IconButton({ icon, label, onClick, disabled, title }: { icon: string; label: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className="sv-icon-btn" title={title ?? label} aria-label={label} onClick={onClick} disabled={disabled}>
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
  onClick?: MouseEventHandler<HTMLButtonElement>;
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

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: string;
  tone?: 'warn';
}

/**
 * A button that opens a menu of mutually exclusive options (WAI-ARIA menu button with menuitemradio items).
 * Keyboard: Enter, Space or ArrowUp/Down open it; arrows, Home and End move; Enter or Space choose; Escape closes
 * and returns focus to the button. It opens upwards because it lives in the composer at the bottom of the view.
 */
export function MenuButton<T extends string>({
  value,
  options,
  onSelect,
  label,
  title,
  icon,
  tone,
  heading,
  footer,
  className,
  iconOnly,
}: {
  value: T;
  options: ReadonlyArray<MenuOption<T>>;
  onSelect: (value: T) => void;
  /** Accessible name of the button. */
  label: string;
  title?: string;
  icon?: string;
  tone?: 'warn';
  heading?: string;
  footer?: { label: string; icon?: string; onSelect: () => void };
  className?: string;
  /** Shows only the icon; the accessible name still carries the current option. */
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const current = options.find((o) => o.value === value) ?? options[0]!;
  const count = options.length + (footer ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]')[active]?.focus();
  }, [open, active]);

  // Keep the menu inside the view: in a narrow sidebar it would otherwise run past the right edge.
  // Applied through CSSOM (allowed by the webview CSP), not through an inline style attribute. It moves `left`, not
  // `transform`, because the entry animation animates transform and animations override inline styles.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;
    menu.style.left = '';
    const r = menu.getBoundingClientRect();
    const overflow = r.right - (window.innerWidth - 8);
    if (overflow > 0) menu.style.left = `${-Math.min(overflow, Math.max(0, r.left - 8))}px`;
  }, [open]);

  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const choose = (i: number) => {
    close();
    if (i < options.length) onSelect(options[i]!.value);
    else footer?.onSelect();
  };

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      show();
    }
  };
  const onMenuKey = (e: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((active + 1) % count),
      ArrowUp: () => setActive((active + count - 1) % count),
      Home: () => setActive(0),
      End: () => setActive(count - 1),
      Escape: () => close(),
      Tab: () => close(false),
      Enter: () => choose(active),
      ' ': () => choose(active),
    };
    const action = keys[e.key];
    if (!action) return;
    if (e.key !== 'Tab') e.preventDefault();
    action();
  };

  return (
    <div className={`sv-menu-anchor${className ? ` ${className}` : ''}`}>
      <button
        ref={buttonRef}
        type="button"
        className="sv-pill"
        data-tone={tone}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={title}
        onClick={() => (open ? close() : show())}
        onKeyDown={onButtonKey}
      >
        {icon ? <Icon name={icon} /> : null}
        {iconOnly ? null : <span className="sv-pill__label">{current.label}</span>}
        <Icon name="chevron-down" className="sv-pill__chevron" />
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} className="sv-menu" role="menu" aria-label={heading ?? label} onKeyDown={onMenuKey}>
          {heading ? (
            <div className="sv-menu__heading" aria-hidden="true">
              {heading}
            </div>
          ) : null}
          {options.map((o, i) => (
            <div
              key={o.value}
              role="menuitemradio"
              aria-checked={o.value === value}
              aria-labelledby={`${menuId}-${i}-label`}
              aria-describedby={o.description ? `${menuId}-${i}-description` : undefined}
              tabIndex={i === active ? 0 : -1}
              className="sv-menu__item"
              data-tone={o.tone}
              onClick={() => choose(i)}
              onMouseEnter={() => setActive(i)}
            >
              <Icon name={o.icon ?? 'circle-small'} className="sv-menu__icon" />
              <span className="sv-menu__text">
                <span id={`${menuId}-${i}-label`} className="sv-menu__label">
                  {o.label}
                </span>
                {o.description ? (
                  <span id={`${menuId}-${i}-description`} className="sv-menu__description">
                    {o.description}
                  </span>
                ) : null}
              </span>
              <Icon name="check" className="sv-menu__check" />
            </div>
          ))}
          {footer ? (
            <>
              <div className="sv-menu__separator" role="separator" />
              <div
                role="menuitem"
                tabIndex={active === options.length ? 0 : -1}
                className="sv-menu__item sv-menu__item--action"
                onClick={() => choose(options.length)}
                onMouseEnter={() => setActive(options.length)}
              >
                <Icon name={footer.icon ?? 'settings-gear'} className="sv-menu__icon" />
                <span className="sv-menu__label">{footer.label}</span>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A labelled checkbox row in the style of VS Code's settings editor. */
export function CheckRow({
  checked,
  onChange,
  label,
  description,
  note,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  note?: string;
}) {
  const id = useId();
  return (
    <div className="sv-checkrow">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={description ? `${id}-d` : undefined} />
      <label htmlFor={id}>
        <span className="sv-checkrow__label">{label}</span>
        {description ? (
          <span id={`${id}-d`} className="sv-field__help">
            {description}
          </span>
        ) : null}
        {note ? <span className="sv-field__note">{note}</span> : null}
      </label>
    </div>
  );
}
