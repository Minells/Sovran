import { useMemo, useState, type FormEvent } from 'react';
import type { ProviderInput } from '../../../src/shared/protocol';
import { sendsKeyInsecurely } from '../../../src/shared/endpoints';
import { useStore } from '../state/store';
import { post } from '../vscode';
import { Button, Icon, Logo } from './primitives';

interface Preset {
  name: string;
  baseUrl: string;
  authType: ProviderInput['authType'];
  note: string;
  icon: string;
  hint: string;
}

export const PRESETS: readonly Preset[] = [
  {
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    authType: 'none',
    note: 'Local · no key',
    icon: 'vm',
    hint: 'Start it with "ollama serve" and pull a coding model, for example "ollama pull qwen2.5-coder:14b".',
  },
  {
    name: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    authType: 'none',
    note: 'Local · no key',
    icon: 'device-desktop',
    hint: 'Load a model, then start the local server from the Developer tab.',
  },
  {
    name: 'vLLM',
    baseUrl: 'http://localhost:8000/v1',
    authType: 'bearer',
    note: 'Self-hosted',
    icon: 'server',
    hint: 'For tool calling, start vLLM with --enable-auto-tool-choice and a --tool-call-parser.',
  },
  { name: 'LiteLLM', baseUrl: 'http://localhost:4000/v1', authType: 'bearer', note: 'Gateway', icon: 'cloud', hint: 'Use a LiteLLM virtual key if the proxy requires one.' },
  {
    name: 'Custom endpoint',
    baseUrl: '',
    authType: 'bearer',
    note: 'Company gateway or any OpenAI-compatible API',
    icon: 'plug',
    hint: 'Any server that implements /chat/completions, such as an internal AI gateway.',
  },
];

type Step = 'choose' | 'connect' | 'model';
const STEPS: Array<[Step, string]> = [
  ['choose', 'Choose'],
  ['connect', 'Connect'],
  ['model', 'Model'],
];

function Stepper({ step }: { step: Step }) {
  const current = STEPS.findIndex(([s]) => s === step);
  return (
    <ol className="sv-steps" aria-label={`Setup, step ${current + 1} of ${STEPS.length}`}>
      {STEPS.map(([s, label], i) => (
        <li key={s} data-state={i < current ? 'done' : i === current ? 'current' : 'todo'} aria-current={i === current ? 'step' : undefined}>
          <span className="sv-steps__n">{i < current ? <Icon name="check" /> : i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

let seq = 0;
const nextRequestId = () => `setup-${Date.now()}-${++seq}`;

/**
 * Guided first-run setup: choose where the model runs, connect (the host stores the provider, asks for a key in a
 * native secure input when needed and tests the connection), then pick one of the models the server reports.
 */
export function SetupWizard() {
  const { state, dispatch } = useStore();
  const [step, setStep] = useState<Step>('choose');
  const [preset, setPreset] = useState<Preset | null>(null);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [authType, setAuthType] = useState<ProviderInput['authType']>('none');
  const [headerName, setHeaderName] = useState('api-key');
  const [touched, setTouched] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [chosen, setChosen] = useState('');
  const [manual, setManual] = useState('');
  const [filter, setFilter] = useState('');

  const providerId = requestId ? state.savedProviders[requestId] : undefined;
  const test = providerId ? state.providerTests[providerId] : undefined;
  const result = test && test.requestId === requestId ? test : undefined;
  const connecting = requestId !== null && !result;

  // A successful connection moves straight on to choosing a model (state adjusted during render, not in an effect).
  const [seen, setSeen] = useState<string | null>(null);
  if (result && result.requestId !== seen) {
    setSeen(result.requestId);
    if (result.ok) {
      setStep('model');
      setChosen(result.models?.[0] ?? '');
    }
  }

  const urlError = useMemo(() => {
    try {
      const p = new URL(baseUrl).protocol;
      return p === 'http:' || p === 'https:' ? '' : 'Use an http:// or https:// URL.';
    } catch {
      return 'Enter the full base URL, for example http://localhost:11434/v1';
    }
  }, [baseUrl]);
  const insecure = !urlError && sendsKeyInsecurely(baseUrl, authType);

  const pick = (p: Preset) => {
    dispatch({ type: 'setup', active: true });
    setPreset(p);
    setName(p.name === 'Custom endpoint' ? '' : p.name);
    setBaseUrl(p.baseUrl);
    setAuthType(p.authType);
    setTouched(false);
    setRequestId(null);
    setStep('connect');
  };

  const connect = (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (urlError || !name.trim()) return;
    const id = nextRequestId();
    setRequestId(id);
    post({
      type: 'saveProvider',
      requestId: id,
      provider: {
        id: providerId,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        authType,
        headerName: authType === 'header' ? headerName.trim() : undefined,
        models: [],
      },
    });
  };

  const finish = () => {
    const model = (manual.trim() || chosen).trim();
    if (!providerId || !model) return;
    post({ type: 'addModels', providerId, modelIds: [model], select: model });
    dispatch({ type: 'setup', active: false });
  };

  const discovered = result?.models ?? [];
  const visible = filter.trim() ? discovered.filter((m) => m.toLowerCase().includes(filter.trim().toLowerCase())) : discovered;

  return (
    <div className="sv-empty sv-setup">
      <Logo className="sv-hero-logo" />
      <Stepper step={step} />

      {step === 'choose' ? (
        <>
          <div>
            <h2 className="sv-setup__title">Connect a model you control</h2>
            <p className="sv-tagline sv-setup__lead">
              Sovran talks directly to OpenAI-compatible endpoints on your machine or your network. There is no Sovran server in between.
            </p>
          </div>
          <ul className="sv-presets" aria-label="Where your model runs">
            {PRESETS.map((p) => (
              <li key={p.name}>
                <button type="button" className="sv-preset" onClick={() => pick(p)}>
                  <Icon name={p.icon} className="sv-preset__icon" />
                  <span className="sv-preset__name">
                    {p.name} <span className="sv-tagline">· {p.note}</span>
                  </span>
                  <span className="sv-preset__url">{p.baseUrl || 'Your endpoint URL'}</span>
                  <Icon name="chevron-right" className="sv-preset__chevron" />
                </button>
              </li>
            ))}
          </ul>
          <p className="sv-fineprint">
            <Icon name="shield" />
            API keys are stored in VS Code Secret Storage on this machine and are never sent to this panel.
          </p>
          <p className="sv-fineprint">
            <Icon name="file-code" />
            <span>
              Prefer a file?{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  post({ type: 'openConfigFile' });
                }}
              >
                Describe your models in config.yaml
              </a>
              . Sovran connects when you save it.
            </span>
          </p>
        </>
      ) : null}

      {step === 'connect' ? (
        <form className="sv-form" onSubmit={connect} noValidate aria-label={`Connect ${preset?.name ?? 'a provider'}`}>
          <div>
            <h2 className="sv-setup__title">Connect {preset?.name === 'Custom endpoint' ? 'your endpoint' : preset?.name}</h2>
            {preset?.hint ? <p className="sv-tagline sv-setup__lead">{preset.hint}</p> : null}
          </div>
          <div className="sv-field">
            <label htmlFor="sv-s-name">Name</label>
            <input id="sv-s-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Company AI Gateway" autoFocus={!name} />
            {touched && !name.trim() ? <span className="sv-field__error">Give this provider a name.</span> : null}
          </div>
          <div className="sv-field">
            <label htmlFor="sv-s-url">Base URL</label>
            <input id="sv-s-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://llm.internal.example/v1" spellCheck={false} />
            {touched && urlError ? (
              <span className="sv-field__error">{urlError}</span>
            ) : (
              <span className="sv-field__help">Usually ends in /v1. Sovran calls /chat/completions and /models.</span>
            )}
          </div>
          <AuthField authType={authType} setAuthType={setAuthType} headerName={headerName} setHeaderName={setHeaderName} insecure={insecure} />

          {result && !result.ok ? (
            <div className="sv-test sv-test--err" role="alert">
              <Icon name="error" />
              <div>
                <div>{result.message}</div>
                {result.hint ? <div className="sv-test__hint">{result.hint}</div> : null}
              </div>
            </div>
          ) : null}
          {connecting ? (
            <div className="sv-test" role="status">
              <Icon name="loading" spin />
              <div>
                <div>Connecting…</div>
                {authType !== 'none' ? <div className="sv-test__hint">If the endpoint needs a key, VS Code asks for it in a secure input.</div> : null}
              </div>
            </div>
          ) : null}

          <div className="sv-approval__actions">
            <Button type="submit" variant="primary" icon="plug" disabled={connecting}>
              {result && !result.ok ? 'Try again' : 'Connect'}
            </Button>
            {result && !result.ok && providerId ? (
              <Button variant="ghost" onClick={() => setStep('model')}>
                Enter a model ID instead
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setStep('choose')} disabled={connecting}>
              Back
            </Button>
          </div>
        </form>
      ) : null}

      {step === 'model' ? (
        <div className="sv-form">
          <div>
            <h2 className="sv-setup__title">Choose a model</h2>
            <p className="sv-tagline sv-setup__lead">
              {discovered.length
                ? `${preset?.name ?? 'The server'} offers ${discovered.length} model${discovered.length === 1 ? '' : 's'}. Coding models with tool calling work best.`
                : 'This server does not list its models. Type the model ID you want to use.'}
            </p>
          </div>
          {discovered.length > 8 ? (
            <input className="sv-search" placeholder="Filter models" aria-label="Filter models" value={filter} onChange={(e) => setFilter(e.target.value)} />
          ) : null}
          {discovered.length ? (
            <div className="sv-model-picker" role="radiogroup" aria-label="Models on the server">
              {visible.map((m) => (
                <label key={m} className="sv-model-option" data-checked={!manual.trim() && chosen === m}>
                  <input
                    type="radio"
                    name="sv-setup-model"
                    checked={!manual.trim() && chosen === m}
                    onChange={() => {
                      setChosen(m);
                      setManual('');
                    }}
                  />
                  <code>{m}</code>
                </label>
              ))}
              {!visible.length ? <span className="sv-field__help">No model matches “{filter}”.</span> : null}
            </div>
          ) : null}
          <div className="sv-field">
            <label htmlFor="sv-s-model">{discovered.length ? 'Or type a model ID' : 'Model ID'}</label>
            <input id="sv-s-model" value={manual} placeholder="qwen2.5-coder:14b" spellCheck={false} onChange={(e) => setManual(e.target.value)} />
            <span className="sv-field__help">You can add more models and a separate Plan model later in Settings.</span>
          </div>
          <div className="sv-approval__actions">
            <Button variant="primary" icon="arrow-right" disabled={!providerId || !(manual.trim() || chosen)} onClick={finish}>
              Start chatting
            </Button>
            <Button variant="ghost" onClick={() => setStep('connect')}>
              Back
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AuthField({
  authType,
  setAuthType,
  headerName,
  setHeaderName,
  insecure,
}: {
  authType: ProviderInput['authType'];
  setAuthType: (v: ProviderInput['authType']) => void;
  headerName: string;
  setHeaderName: (v: string) => void;
  insecure: boolean;
}) {
  const options: Array<[ProviderInput['authType'], string]> = [
    ['none', 'None'],
    ['bearer', 'Bearer token'],
    ['header', 'Custom header'],
  ];
  return (
    <div className="sv-field">
      <fieldset>
        <legend>Authentication</legend>
        <div className="sv-segment sv-segment--block" role="radiogroup" aria-label="Authentication">
          {options.map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={authType === v} onClick={() => setAuthType(v)}>
              {l}
            </button>
          ))}
        </div>
      </fieldset>
      {authType === 'header' ? <input aria-label="Header name" value={headerName} onChange={(e) => setHeaderName(e.target.value)} placeholder="api-key" /> : null}
      {authType !== 'none' ? <span className="sv-field__help">VS Code asks for the key in a secure input and stores it in Secret Storage.</span> : null}
      {insecure ? (
        <span className="sv-field__note" role="note">
          This URL uses http, so the key would travel unencrypted. Use https for anything that is not on this machine.
        </span>
      ) : null}
    </div>
  );
}
