import { describe, expect, it } from 'vitest';
import {
  CONFIG_FILE_TEMPLATE,
  mergeProviders,
  parseConfigFile,
  type ConfigProblem,
} from '../../src/core/config/configFile';
import type { ProviderConfig } from '../../src/core/providers/types';

const problems = (text: string, otherModels?: Set<string>): ConfigProblem[] => {
  const r = parseConfigFile(text, { otherModels });
  if (r.ok) throw new Error('expected problems');
  return r.problems;
};

describe('config file', () => {
  it('reads providers in the README format, with shorthands for auth and models', () => {
    const r = parseConfigFile(`
providers:
  - id: ollama
    name: Ollama
    baseUrl: http://localhost:11434/v1/
    auth: none
    models:
      - id: qwen2.5-coder:14b
        contextWindow: 32768
      - devstral:24b
  - id: corp
    name: Company AI Gateway
    baseUrl: https://ai-gateway.example.com/v1
    auth: { type: header, headerName: api-key }
    headers: { X-Team: platform }
    timeoutSeconds: 300
    models: [{ id: coder-large, contextWindow: 128000, toolMode: native }]
defaultModel: ollama/qwen2.5-coder:14b
planModel: corp/coder-large
`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.providers).toEqual([
      {
        id: 'ollama',
        name: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        auth: { type: 'none' },
        models: [{ id: 'qwen2.5-coder:14b', contextWindow: 32768 }, { id: 'devstral:24b' }],
      },
      {
        id: 'corp',
        name: 'Company AI Gateway',
        baseUrl: 'https://ai-gateway.example.com/v1',
        auth: { type: 'header', headerName: 'api-key' },
        headers: { 'X-Team': 'platform' },
        timeoutSeconds: 300,
        models: [{ id: 'coder-large', contextWindow: 128000, toolMode: 'native' }],
      },
    ]);
    expect(r.config.defaultModel).toBe('ollama/qwen2.5-coder:14b');
    expect(r.config.planModel).toBe('corp/coder-large');
  });

  it('treats an empty file and the commented template as valid and empty', () => {
    for (const text of ['', '# nothing yet\n', 'providers:\n', CONFIG_FILE_TEMPLATE]) {
      expect(parseConfigFile(text)).toEqual({ ok: true, config: { providers: [] } });
    }
  });

  it('uses the id as the name when the name is left out', () => {
    const r = parseConfigFile('providers:\n  - id: lab\n    baseUrl: http://10.0.0.5:8000/v1\n');
    expect(r.ok && r.config.providers[0]!.name).toBe('lab');
  });

  it('points YAML syntax errors at their line', () => {
    const [p] = problems('providers:\n  - id: a\n    baseUrl: "http://x/v1\n');
    expect(p!.line).toBeGreaterThanOrEqual(2);
    expect(p!.message).toMatch(/quot|string|scalar/i);
  });

  it('suggests the right spelling for unknown fields and highlights the key itself', () => {
    const text = 'providers:\n  - id: ollama\n    base_url: http://localhost:11434/v1\n';
    const [missing, unknown] = problems(text).sort((a, b) => a.message.localeCompare(b.message));
    expect(unknown).toMatchObject({
      message: 'Unknown field "base_url". Did you mean "baseUrl"?',
      line: 2,
      column: 4,
      endLine: 2,
      endColumn: 12,
    });
    // The required baseUrl is missing: the problem points at the provider entry.
    expect(missing!.message).toMatch(/^providers\.0\.baseUrl:/);
    expect(missing!.line).toBe(1);
  });

  it('never accepts API keys in the file, as a field or as a header', () => {
    const text = [
      'providers:',
      '  - id: corp',
      '    baseUrl: https://gw.example/v1',
      '    apiKey: sk-123',
      '    headers:',
      '      Authorization: Bearer sk-123',
      '      X-Team: platform',
    ].join('\n');
    const found = problems(text);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      line: 3,
      message: expect.stringMatching(/never read from config.yaml/),
    });
    expect(found[1]).toMatchObject({
      line: 5,
      message: expect.stringMatching(/"Authorization" looks like a credential/),
    });
  });

  it('validates values with the same limits as Settings', () => {
    const text = [
      'providers:',
      '  - id: Bad Id',
      '    baseUrl: ftp://x',
      '    auth: { type: header }',
      '    models:',
      '      - id: m',
      '        temperature: 3',
      '        toolMode: maybe',
    ].join('\n');
    const messages = problems(text).map((p) => `${p.line + 1}: ${p.message}`);
    expect(messages).toEqual([
      expect.stringMatching(/^2: providers\.0\.id: Use lowercase/),
      expect.stringMatching(/^3: providers\.0\.baseUrl: Enter a full http\(s\) URL/),
      expect.stringMatching(/^4: providers\.0\.auth\.type: Add auth\.headerName/),
      expect.stringMatching(/^7: providers\.0\.models\.0\.temperature:/),
      expect.stringMatching(/^8: providers\.0\.models\.0\.toolMode:/),
    ]);
  });

  it('reports a model listed twice at its second entry', () => {
    const [p] = problems(
      'providers:\n  - id: a\n    baseUrl: http://x/v1\n    models:\n      - m\n      - id: m\n',
    );
    expect(p).toMatchObject({ line: 5, message: 'providers.0.models.1.id: Model "m" is listed twice.' });
  });

  it('rejects duplicate provider ids and duplicate keys', () => {
    expect(
      problems(
        'providers:\n  - { id: a, baseUrl: "http://x/v1" }\n  - { id: a, baseUrl: "http://y/v1" }\n',
      )[0]!.message,
    ).toMatch(/used twice/);
    expect(problems('providers: []\nproviders: []\n')[0]!.message).toMatch(/unique/i);
  });

  it('requires model choices to name a configured model, in the file or in Settings', () => {
    const base = 'providers:\n  - id: ollama\n    baseUrl: http://localhost:11434/v1\n    models: [coder]\n';
    expect(parseConfigFile(`${base}defaultModel: ollama/coder\n`).ok).toBe(true);
    expect(problems(`${base}defaultModel: ollama/nope\n`)[0]).toMatchObject({
      line: 4,
      message: 'defaultModel: provider "ollama" in this file has no model "nope".',
    });
    const settings = new Set(['corp/big']);
    expect(parseConfigFile(`${base}planModel: corp/big\n`, { otherModels: settings }).ok).toBe(true);
    expect(problems(`${base}titleModel: corp/small\n`, settings)[0]!.message).toBe(
      'titleModel: no provider "corp" with model "small" is configured.',
    );
    expect(problems(`${base}defaultModel: just-a-model\n`)[0]!.message).toMatch(/providerId\/modelId/);
  });

  it('refuses a top level that is not a mapping, oversized files and alias bombs', () => {
    expect(problems('- a\n- b\n')[0]!.message).toMatch(/must be a mapping/);
    expect(problems(`# ${'x'.repeat(300 * 1024)}`)[0]!.message).toMatch(/larger than/);
    const bomb = [
      'a: &a [x, x, x, x, x, x, x, x, x, x]',
      ...Array.from(
        { length: 8 },
        (_, i) =>
          `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [*${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}, *${String.fromCharCode(97 + i)}]`,
      ),
    ].join('\n');
    expect(parseConfigFile(bomb).ok).toBe(false);
  });
});

describe('merging providers', () => {
  const p = (id: string, baseUrl = `http://${id}/v1`): ProviderConfig => ({ id, name: id, baseUrl });

  it('lets a file entry replace the Settings one in place and appends new ones', () => {
    const { providers, overridden } = mergeProviders(
      [p('a'), p('b'), p('c')],
      [p('d'), p('b', 'http://file/v1')],
    );
    expect(providers.map((x) => `${x.id}@${x.baseUrl}`)).toEqual([
      'a@http://a/v1',
      'b@http://file/v1',
      'c@http://c/v1',
      'd@http://d/v1',
    ]);
    expect(overridden).toEqual(['b']);
  });

  it('is the Settings list when there is no file', () => {
    const settings = [p('a')];
    expect(mergeProviders(settings, []).providers).toEqual(settings);
  });
});
