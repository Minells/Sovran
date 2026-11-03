import { useState, type ReactNode } from 'react';
import type { AgentMode, EditorContextView } from '../../../src/shared/protocol';
import { endpointLocation } from '../../../src/shared/endpoints';
import { approvalOption } from '../lib/approvals';
import { relativeTime } from '../lib/format';
import { altLabel, globalShortcut } from '../lib/keys';
import { useStore } from '../state/store';
import { post } from '../vscode';
import { SetupWizard } from './Onboarding';
import { useSetupActive } from './Panels';
import { Button, Icon } from './primitives';

/**
 * The start of every chat: the brand mark, what Sovran is connected to, starters built from the editor context, the
 * latest chats and one tip. Motion is limited to an entrance and the "ready" dot, and stops with reduced motion.
 */

/** Stable pick from a list, so a chat keeps its headline and tip while it stays open. FNV-1a over the seed. */
export function seeded(seed: string, n: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0) % n;
}

const HEADLINES: Record<AgentMode, readonly string[]> = {
  act: ['What should we build?', 'What are we shipping today?', 'Ready when you are.'],
  plan: ['What should we figure out?', 'What do you want to understand?', 'Let’s map it out first.'],
};

/** The "[•]" symbol, animated: the brackets close in, then the dot lands and breathes while a model is ready. */
function HeroMark({ ready }: { ready: boolean }) {
  return (
    <svg
      className="sv-hero__mark"
      data-ready={ready}
      viewBox="0 0 48 48"
      width="44"
      height="44"
      aria-hidden="true"
    >
      <path className="sv-hero__bracket sv-hero__bracket--left" d="M6 6H18V12H12V36H18V42H6Z" />
      <path className="sv-hero__bracket sv-hero__bracket--right" d="M42 6H30V12H36V36H30V42H42Z" />
      <circle className="sv-hero__dot" cx="24" cy="24" r={ready ? 6 : 5} />
    </svg>
  );
}

interface Starter {
  id: string;
  icon: string;
  title: ReactNode;
  detail: string;
  /** Sent as the message. A starter without a prompt fills the composer with `draft` instead. */
  prompt?: string;
  draft?: string;
}

const fileTitle = (verb: string, file: string) => (
  <>
    {verb} <code>{file}</code>
  </>
);

/** Starters follow the mode and what is open: the active file, or the selection in it. */
export function startersFor(mode: AgentMode, editor: EditorContextView | null): Starter[] {
  const file = editor ? editor.label.replace(/:\d+-\d+$/, '') : null;
  const selection = !!editor?.startLine;
  if (mode === 'plan') {
    return [
      {
        id: 'map',
        icon: 'list-tree',
        title: 'Map this workspace',
        detail: 'Structure, entry points and conventions',
        prompt: 'Explain how this workspace is structured',
      },
      {
        id: 'errors',
        icon: 'telescope',
        title: 'Trace error handling',
        detail: 'Where errors are caught and reported',
        prompt: 'Find where errors are handled and how',
      },
      file
        ? {
            id: 'tests',
            icon: 'beaker',
            title: fileTitle('Plan tests for', file),
            detail: 'What to cover, and in what order',
            prompt: 'Plan unit tests for the active file',
          }
        : {
            id: 'tests',
            icon: 'beaker',
            title: 'Plan tests',
            detail: 'What to cover first, and how',
            prompt: 'Plan unit tests for the most important untested code in this workspace',
          },
      {
        id: 'change',
        icon: 'checklist',
        title: 'Plan a change',
        detail: 'Describe it, get a step-by-step plan',
        draft: 'Plan how to ',
      },
    ];
  }
  return [
    selection
      ? {
          id: 'explain',
          icon: 'comment-discussion',
          title: 'Explain the selection',
          detail: editor!.label,
          prompt: 'Explain the selected code',
        }
      : file
        ? {
            id: 'explain',
            icon: 'comment-discussion',
            title: fileTitle('Explain', file),
            detail: 'What it does and how it fits in',
            prompt: 'Explain the active file',
          }
        : {
            id: 'explain',
            icon: 'comment-discussion',
            title: 'Explain this workspace',
            detail: 'Structure, entry points and conventions',
            prompt: 'Explain how this workspace is structured',
          },
    file
      ? {
          id: 'fix',
          icon: 'wrench',
          title: 'Fix problems',
          detail: `Diagnostics in ${file}`,
          prompt: 'Fix the problems reported in the active file',
        }
      : {
          id: 'fix',
          icon: 'wrench',
          title: 'Fix failing tests',
          detail: 'Run the tests, fix what breaks',
          prompt: 'Run the test suite and fix the failing tests',
        },
    {
      id: 'tests',
      icon: 'beaker',
      title: 'Write tests',
      detail: selection ? 'For the selected code' : file ? `For ${file}` : 'For the code that matters most',
      prompt: selection
        ? 'Write unit tests for the selected code'
        : file
          ? 'Write unit tests for the active file'
          : 'Find important code without tests and write unit tests for it',
    },
    {
      id: 'review',
      icon: 'git-compare',
      title: 'Review my changes',
      detail: 'Bugs and risks before you commit',
      prompt: 'Review my uncommitted changes for bugs and risks. Do not modify any file.',
    },
  ];
}

function Hero() {
  const { app } = useStore();
  const provider = app.providers.find((p) => p.id === app.selected?.providerId);
  const model = provider?.models.find((m) => m.id === app.selected?.modelId);
  const ready = !!(provider && app.selected);
  const where = endpointLocation(provider?.baseUrl);
  const headlines = HEADLINES[app.mode];
  const headline = headlines[seeded(app.session?.id ?? '', headlines.length)];
  const approval = approvalOption(app.approvalMode);
  return (
    <section className="sv-hero" aria-labelledby="sv-hero-title">
      <HeroMark ready={ready} />
      <h1 id="sv-hero-title" className="sv-hero__title">
        {headline}
      </h1>
      {ready ? (
        <p className="sv-hero__meta">
          {app.workspace.name ? (
            <span className="sv-hero__fact" title="Workspace">
              <Icon name="root-folder" />
              {app.workspace.name}
            </span>
          ) : null}
          <button
            type="button"
            className="sv-hero__fact sv-hero__model"
            title={`${provider.name} · ${app.selected!.modelId}. Click to change the model.`}
            onClick={() => post({ type: 'pickModel' })}
          >
            <span className="sv-dot sv-dot--live" aria-hidden="true" />
            {model?.name ?? app.selected!.modelId}
          </button>
          {where ? (
            <span className="sv-hero__fact" title={provider.baseUrl}>
              <Icon name={where === 'local' ? 'device-desktop' : 'globe'} />
              {where === 'local' ? 'on this machine' : where}
            </span>
          ) : null}
        </p>
      ) : (
        <p className="sv-hero__meta">
          <span className="sv-hero__fact">
            <span className="sv-dot sv-dot--warn" aria-hidden="true" />
            No model selected.
          </span>
          <Button variant="ghost" onClick={() => post({ type: 'pickModel' })}>
            Choose a model
          </Button>
        </p>
      )}
      <button
        type="button"
        className="sv-hero__mode"
        data-tone={app.mode === 'act' ? approval.tone : undefined}
        title="Models & approvals"
        onClick={() => post({ type: 'setView', view: 'settings' })}
      >
        <Icon name={app.mode === 'plan' ? 'eye' : approval.icon} />
        <span>{app.mode === 'plan' ? 'Plan mode · read-only' : `Act mode · ${approval.summary}`}</span>
      </button>
    </section>
  );
}

function Starters() {
  const { app, dispatch } = useStore();
  const editor = app.context.editor;
  // A file Sovran will not send (outside the workspace, protected or excluded) is not offered as a subject.
  const subject = editor && !editor.blocked && app.context.includeEditor ? editor : null;
  return (
    <ul className="sv-starter-grid" aria-label="Suggestions">
      {startersFor(app.mode, subject).map((s) => (
        <li key={s.id}>
          <button
            type="button"
            className="sv-starter-card"
            disabled={!app.selected}
            onClick={() =>
              s.prompt
                ? post({ type: 'send', text: s.prompt })
                : dispatch({ type: 'focusComposer', text: s.draft })
            }
          >
            <Icon name={s.icon} className="sv-starter-card__icon" />
            <span className="sv-starter-card__title">{s.title}</span>
            <span className="sv-starter-card__detail">{s.detail}</span>
            <Icon name={s.prompt ? 'arrow-right' : 'edit'} className="sv-starter-card__go" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function RecentChats() {
  const { app } = useStore();
  const recent = app.sessions
    .filter((s) => s.id !== app.session?.id && s.messageCount > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3);
  if (!recent.length) return null;
  return (
    <nav className="sv-recent" aria-label="Recent chats">
      <div className="sv-recent__head">
        <span className="sv-section-label">Recent</span>
        <button
          type="button"
          className="sv-recent__all"
          onClick={() => post({ type: 'setView', view: 'history' })}
        >
          All chats
          <Icon name="chevron-right" />
        </button>
      </div>
      <ul>
        {recent.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className="sv-recent__item"
              onClick={() => post({ type: 'openSession', id: s.id })}
            >
              <span className="sv-recent__title">{s.title}</span>
              <span className="sv-recent__time">{relativeTime(s.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const TIPS: ReadonlyArray<() => ReactNode> = [
  () => (
    <>
      Select code in the editor and press <kbd>{globalShortcut('U')}</kbd> to ask about it.
    </>
  ),
  () => (
    <>
      Press <kbd>{globalShortcut('Y')}</kbd> from anywhere to jump back to Sovran.
    </>
  ),
  () => (
    <>
      Add an <code>AGENTS.md</code> to the repository to teach Sovran your conventions.
    </>
  ),
  () => (
    <>
      Save a prompt as <code>.sovran/commands/name.md</code> to get your own <code>/name</code> command.
    </>
  ),
  () => (
    <>
      Plan mode is read-only: explore first, then switch to Act with <kbd>{altLabel()}M</kbd>.
    </>
  ),
  () => (
    <>
      Changes Sovran makes can be undone, response by response, with <strong>Undo changes</strong>.
    </>
  ),
  () => <>When the context fills up, click the meter in the composer to summarize older messages.</>,
];

function Tip({ seed }: { seed: string }) {
  const [offset, setOffset] = useState(0);
  const index = (seeded(seed, TIPS.length) + offset) % TIPS.length;
  return (
    <div className="sv-tip">
      <span className="sv-tip__label">Tip</span>
      <p className="sv-tip__text" aria-live="polite">
        {TIPS[index]!()}
      </p>
      <button
        type="button"
        className="sv-icon-btn sv-tip__next"
        title="Next tip"
        aria-label="Next tip"
        onClick={() => setOffset(offset + 1)}
      >
        <Icon name="chevron-right" />
      </button>
    </div>
  );
}

/** What a new chat shows: the guided setup until a model is connected, then the home screen. */
export function EmptyState() {
  const { app } = useStore();
  const setup = useSetupActive();
  if (setup) return <SetupWizard />;
  return (
    <div className="sv-home">
      <Hero />
      <Starters />
      <RecentChats />
      <Tip seed={app.session?.id ?? ''} />
      {!app.workspace.hasFolder ? (
        <p className="sv-fineprint">
          <Icon name="folder" />
          Open a folder so Sovran can read and edit your project.
        </p>
      ) : null}
    </div>
  );
}
