import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { DirectoryEntryView, FileSuggestionView } from '../../../src/shared/protocol';
import { useStore } from '../state/store';
import { post } from '../vscode';
import { Icon } from './primitives';

type Row =
  | { kind: 'up'; key: string; path: string }
  | { kind: 'dir'; key: string; entry: DirectoryEntryView }
  | {
      kind: 'file';
      key: string;
      path: string;
      label: string;
      detail: string;
      hint?: FileSuggestionView['hint'];
      protected?: boolean;
    };

interface Group {
  key: string;
  label: string;
  rows: Row[];
}

let seq = 0;
const parentOf = (dir: string) => (dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');
const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const HINT_LABEL = { active: 'active editor', open: 'open' } as const;

/**
 * The attach menu: search the workspace, pick a suggested file (active editor, open tabs), browse folders from the
 * workspace root, or upload from the computer through the system dialog. Files toggle, so several can be picked in a
 * row; the chips above the message show the result. Combobox + multi-select listbox, driven from the search field.
 */
export function AttachMenu({
  trigger,
  onClose,
}: {
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: (refocus: boolean) => void;
}) {
  const { app, state } = useStore();
  const [query, setQuery] = useState('');
  const [dir, setDir] = useState('');
  const [suggestId, setSuggestId] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const searching = query.trim().length > 0;

  // The folder being browsed. Responses are matched by path, which the host echoes back normalized.
  useEffect(() => {
    post({ type: 'listDirectory', requestId: `attach-dir-${++seq}`, path: dir });
  }, [dir]);

  // Suggestions without a query (open editors first), search results with one.
  useEffect(() => {
    const t = setTimeout(
      () => {
        const id = `attach-q-${++seq}`;
        setSuggestId(id);
        post({ type: 'suggestFiles', requestId: id, query: query.trim() });
      },
      query ? 80 : 0,
    );
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !trigger.current?.contains(target)) onClose(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [onClose, trigger]);

  const listing = state.directoryListing?.listing.path === dir ? state.directoryListing.listing : null;
  const suggestions =
    suggestId && state.fileSuggestions?.requestId === suggestId ? state.fileSuggestions.items : null;
  const attached = new Map(app.context.attachments.map((a) => [a.path, a.id]));

  const groups: Group[] = [];
  if (searching) {
    groups.push({
      key: 'results',
      label: 'Results',
      rows: (suggestions ?? []).map((s) => ({
        kind: 'file',
        key: `q:${s.path}`,
        path: s.path,
        label: s.label,
        detail: folderOf(s.path),
      })),
    });
  } else {
    const suggested = (suggestions ?? []).filter((s) => s.hint).slice(0, 4);
    if (suggested.length) {
      groups.push({
        key: 'suggested',
        label: 'Suggested',
        rows: suggested.map((s) => ({
          kind: 'file',
          key: `s:${s.path}`,
          path: s.path,
          label: s.label,
          detail: folderOf(s.path),
          hint: s.hint,
        })),
      });
    }
    const rows: Row[] = dir ? [{ kind: 'up', key: 'up', path: parentOf(dir) }] : [];
    for (const e of listing?.entries ?? []) {
      rows.push(
        e.type === 'directory'
          ? { kind: 'dir', key: `d:${e.path}`, entry: e }
          : {
              kind: 'file',
              key: `f:${e.path}`,
              path: e.path,
              label: e.name,
              detail: '',
              protected: e.protected,
            },
      );
    }
    const root = app.workspace.name ?? 'Workspace';
    groups.push({ key: 'browse', label: dir ? `${root} / ${dir.split('/').join(' / ')}` : root, rows });
  }
  const rows = groups.flatMap((g) => g.rows);
  // Index of each group's first row in `rows`, so options get stable flat ids.
  const offsets = groups.map((_, gi) => groups.slice(0, gi).reduce((n, g) => n + g.rows.length, 0));
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));
  const optionId = (i: number) => `${listId}-${i}`;

  // Keyboard moves keep the active option in view; pointer hovering never scrolls the list.
  const reveal = useRef(false);
  // Only a pointer that really moves takes over the active row. When the list re-renders under a still pointer, the
  // browser reports a synthetic move at the same coordinates, which must not steal the row from the keyboard.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const pointerMoved = (e: { screenX: number; screenY: number }) => {
    const prev = pointer.current;
    pointer.current = { x: e.screenX, y: e.screenY };
    return !prev || prev.x !== e.screenX || prev.y !== e.screenY;
  };
  useLayoutEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, listId]);

  // Opening a folder moves the keyboard to its first row (".."), past the suggestions above it.
  const browseStart = searching ? 0 : (offsets[groups.length - 1] ?? 0);
  const navigate = (path: string) => {
    setDir(path);
    setActive(browseStart);
  };
  const activate = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'up') return navigate(row.path);
    if (row.kind === 'dir') return navigate(row.entry.path);
    const id = attached.get(row.path);
    post(id ? { type: 'removeAttachment', id } : { type: 'attachPath', path: row.path });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const row = rows[activeIndex];
    const key = e.key;
    if ((key === 'ArrowDown' || key === 'ArrowUp') && rows.length) {
      e.preventDefault();
      reveal.current = true;
      setActive((activeIndex + (key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (key === 'Enter') {
      e.preventDefault();
      activate(row);
    } else if (key === 'ArrowRight' && !searching && row?.kind === 'dir') {
      e.preventDefault();
      navigate(row.entry.path);
    } else if ((key === 'Backspace' || key === 'ArrowLeft') && !query && dir) {
      e.preventDefault();
      navigate(parentOf(dir));
    } else if (key === 'Escape') {
      e.preventDefault();
      if (query) setQuery('');
      else onClose(true);
    }
  };

  const status = searching
    ? suggestions === null
      ? 'Searching…'
      : rows.length === 0
        ? `No files match “${query.trim()}”.`
        : null
    : listing === null
      ? 'Loading…'
      : listing.error
        ? listing.error
        : listing.entries.length === 0
          ? 'This folder is empty.'
          : null;

  return (
    <div ref={rootRef} className="sv-attach" role="dialog" aria-label="Attach files">
      <div className="sv-attach__search">
        <Icon name="search" />
        <input
          autoFocus
          value={query}
          placeholder="Search files in the workspace"
          aria-label="Search files"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={rows.length ? optionId(activeIndex) : undefined}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div
        className="sv-attach__list"
        id={listId}
        role="listbox"
        aria-label="Files"
        aria-multiselectable="true"
      >
        {groups.map((g, gi) => (
          <div key={g.key} role="group" aria-label={g.label} className="sv-attach__group">
            <div className="sv-attach__label" aria-hidden="true">
              {g.key === 'browse' ? <Icon name="root-folder" /> : null}
              <span>{g.label}</span>
            </div>
            {g.rows.map((row, ri) => {
              const i = offsets[gi]! + ri;
              const isAttached = row.kind === 'file' && attached.has(row.path);
              const name = row.kind === 'up' ? '..' : row.kind === 'dir' ? row.entry.name : row.label;
              const detail =
                row.kind === 'file'
                  ? [row.detail, row.hint ? HINT_LABEL[row.hint] : ''].filter(Boolean).join(' · ')
                  : '';
              return (
                <div
                  key={row.key}
                  id={optionId(i)}
                  role="option"
                  aria-selected={isAttached}
                  aria-label={
                    row.kind === 'up'
                      ? 'Up one folder'
                      : row.kind === 'dir'
                        ? `${name}, folder`
                        : `${name}${row.detail ? `, ${row.detail}` : ''}`
                  }
                  data-active={i === activeIndex}
                  data-kind={row.kind}
                  className="sv-attach__item"
                  title={
                    row.kind === 'file'
                      ? row.protected
                        ? `${row.path} · protected: asks before attaching`
                        : row.path
                      : undefined
                  }
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={(e) => {
                    if (pointerMoved(e) && i !== activeIndex) setActive(i);
                  }}
                  onClick={() => activate(row)}
                >
                  <Icon
                    name={
                      row.kind === 'up'
                        ? 'arrow-left'
                        : row.kind === 'dir'
                          ? 'folder'
                          : row.protected
                            ? 'lock'
                            : 'file'
                    }
                    className="sv-attach__icon"
                  />
                  <span className="sv-attach__name">{name}</span>
                  <span className="sv-attach__detail">{detail}</span>
                  <Icon name={row.kind === 'dir' ? 'chevron-right' : 'check'} className="sv-attach__trail" />
                </div>
              );
            })}
          </div>
        ))}
        {status ? (
          <div className="sv-attach__status" role="status">
            {status}
          </div>
        ) : null}
        {!searching && listing?.truncated ? (
          <div className="sv-attach__status">
            Showing the first {listing.entries.length} entries. Search to find the rest.
          </div>
        ) : null}
      </div>
      <div className="sv-attach__foot">
        <button
          type="button"
          className="sv-attach__upload"
          onClick={() => {
            post({ type: 'uploadFiles' });
            onClose(false);
          }}
        >
          <Icon name="cloud-upload" />
          Upload from computer…
        </button>
        <span className="sv-attach__keys" aria-hidden="true">
          <kbd>↵</kbd> attach
          {!searching && dir ? (
            <>
              {' '}
              <kbd>⌫</kbd> back
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}
