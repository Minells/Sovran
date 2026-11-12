import { useId, useState, type ReactNode } from 'react';
import { Icon } from './primitives';

export function SettingsDisclosure({
  title,
  status,
  description,
  warning = false,
  children,
}: {
  title: string;
  status?: string;
  description?: string;
  warning?: boolean;
  children: ReactNode;
}) {
  const [expansion, setExpansion] = useState<'initial' | 'open' | 'closed'>('initial');
  const open = expansion === 'open';
  const id = useId();

  return (
    <div className="sv-disclosure">
      <button
        type="button"
        className="sv-disclosure__trigger"
        aria-expanded={open}
        aria-controls={id}
        aria-labelledby={status ? `${id}-title ${id}-status` : `${id}-title`}
        aria-describedby={description ? `${id}-description` : undefined}
        onClick={() => setExpansion(open ? 'closed' : 'open')}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <span className="sv-disclosure__label">
          <span className="sv-disclosure__title" id={`${id}-title`}>
            {title}
          </span>
          {status ? (
            <span
              id={`${id}-status`}
              className={`sv-disclosure__status${warning && !description ? ' sv-disclosure__warning' : ''}`}
            >
              {status}
            </span>
          ) : null}
          {description ? (
            <span
              id={`${id}-description`}
              className={`sv-disclosure__description${warning ? ' sv-disclosure__warning' : ''}`}
            >
              {description}
            </span>
          ) : null}
        </span>
      </button>
      <div id={id} hidden={!open}>
        {expansion !== 'initial' ? <div className="sv-disclosure__body">{children}</div> : null}
      </div>
    </div>
  );
}
