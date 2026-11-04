/**
 * The optional `config.yaml` file: providers and model choices as text, kept in sync with Sovran Settings.
 *
 * Parsing is pure (no VS Code API) so it can be unit tested and reused. Every problem carries a source range, so the
 * host can show it in the editor exactly where it is, the way a compiler would.
 */
import {
  LineCounter,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  type Document,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import { z } from 'zod';
import type { ProviderConfig } from '../providers/types';

/** Larger files are refused: a model list is a few kilobytes, anything bigger is a mistake. */
export const CONFIG_FILE_MAX_BYTES = 256 * 1024;

/** Zero-based range in the file, like VS Code positions. */
export interface ConfigProblem {
  message: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface FileConfig {
  providers: ProviderConfig[];
  /** `providerId/modelId` to select as the Act model when the file is applied. */
  defaultModel?: string;
  /** `providerId/modelId` for Plan mode when the file is applied. */
  planModel?: string;
  /** `providerId/modelId` that names new chats when the file is applied. */
  titleModel?: string;
}

export type ConfigParseResult = { ok: true; config: FileConfig } | { ok: false; problems: ConfigProblem[] };

export interface ConfigParseOptions {
  /**
   * Models configured outside the file (in Settings), as `providerId/modelId`, so a model choice may point at them.
   * When omitted, choices naming a provider that is not in the file are not checked.
   */
  otherModels?: ReadonlySet<string>;
}

// ------------------------------------------------------------------------------------------- schema

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/** Header names that carry credentials. Keys belong in Secret Storage, never in a plain file. */
const SECRET_HEADER = /(authorization|api[-_]?key|token|secret|password|cookie)/i;
/** Field names people use for keys; they get a specific explanation instead of "unknown field". */
const SECRET_FIELD = /^(api[-_]?key|key|token|secret|password|bearer)$/i;
const KEYS_LIVE_ELSEWHERE =
  'API keys are never read from config.yaml. Use "Set key" in Sovran: keys are kept in VS Code Secret Storage.';

const modelRef = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,47}\/.+$/,
    'Write the model as providerId/modelId, for example ollama/qwen2.5-coder:14b.',
  );

const modelSchema = z.strictObject({
  id: z.string().trim().min(1, 'A model needs an id.').max(200),
  name: z.string().trim().min(1).max(120).optional(),
  contextWindow: z.number().int().min(1024).max(10_000_000).optional(),
  maxOutputTokens: z.number().int().min(64).max(1_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  toolMode: z.enum(['auto', 'native', 'prompted', 'none']).optional(),
});

// Cross-field checks live on the smallest schema that owns the fields: Zod skips an object's refinements when any of
// its fields is invalid, and checks placed here still run when a sibling field has a problem.
const authSchema = z
  .strictObject({
    type: z.enum(['none', 'bearer', 'header']),
    headerName: z
      .string()
      .trim()
      .max(100)
      .regex(/^[A-Za-z0-9-]+$/, 'Use letters, digits and - only.')
      .optional(),
  })
  .superRefine((a, ctx) => {
    if (a.type === 'header' && !a.headerName) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'Add auth.headerName, the header that carries the key (for example api-key).',
      });
    }
  });

const headersSchema = z.record(z.string(), z.string()).superRefine((headers, ctx) => {
  for (const name of Object.keys(headers)) {
    if (SECRET_HEADER.test(name)) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: `"${name}" looks like a credential. ${KEYS_LIVE_ELSEWHERE} For a custom key header use auth.type: header.`,
      });
    }
  }
});

/** Reports the second use of a key in a list (`what` names it in the message). */
const unique =
  <T>(key: (item: T) => string, message: (value: string) => string, field: string) =>
  (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      const value = key(item);
      if (seen.has(value)) ctx.addIssue({ code: 'custom', path: [i, field], message: message(value) });
      seen.add(value);
    });
  };

const providerSchema = z.strictObject({
  id: z
    .string()
    .regex(
      PROVIDER_ID,
      'Use lowercase letters, digits, - and _ (up to 48), starting with a letter or digit.',
    ),
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((u) => {
      try {
        const p = new URL(u).protocol;
        return p === 'http:' || p === 'https:';
      } catch {
        return false;
      }
    }, 'Enter a full http(s) URL, for example http://localhost:11434/v1'),
  // Shorthand: `auth: none` means `auth: { type: none }`.
  auth: z.preprocess((v) => (typeof v === 'string' ? { type: v } : v), authSchema).optional(),
  headers: headersSchema.optional(),
  timeoutSeconds: z.number().int().min(5).max(1800).optional(),
  // Shorthand: a plain string is a model id.
  models: z
    .preprocess(
      (v) => (v === null ? [] : v),
      z
        .array(z.preprocess((m) => (typeof m === 'string' ? { id: m } : m), modelSchema))
        .max(200)
        .superRefine(
          unique(
            (m) => m.id,
            (id) => `Model "${id}" is listed twice.`,
            'id',
          ),
        ),
    )
    .optional(),
});

const fileSchema = z.strictObject({
  providers: z.preprocess(
    (v) => (v === null || v === undefined ? [] : v),
    z
      .array(providerSchema)
      .max(50)
      .superRefine(
        unique(
          (p) => p.id,
          (id) => `Provider id "${id}" is used twice.`,
          'id',
        ),
      ),
  ),
  defaultModel: modelRef.optional(),
  planModel: modelRef.optional(),
  titleModel: modelRef.optional(),
});

/** Known fields at each level, to suggest the right spelling of an unknown one (`base_url` → `baseUrl`). */
const KNOWN_FIELDS = {
  file: ['providers', 'defaultModel', 'planModel', 'titleModel'],
  provider: ['id', 'name', 'baseUrl', 'auth', 'headers', 'timeoutSeconds', 'models'],
  auth: ['type', 'headerName'],
  model: ['id', 'name', 'contextWindow', 'maxOutputTokens', 'temperature', 'toolMode'],
};

function knownFieldsAt(path: readonly PropertyKey[]): string[] {
  if (path.length === 0) return KNOWN_FIELDS.file;
  if (path[0] !== 'providers') return [];
  if (path.length === 2) return KNOWN_FIELDS.provider;
  if (path.length === 3 && path[2] === 'auth') return KNOWN_FIELDS.auth;
  if (path.length === 4 && path[2] === 'models') return KNOWN_FIELDS.model;
  return [];
}

const normalize = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '');

function unknownFieldMessage(key: string, path: readonly PropertyKey[]): string {
  if (SECRET_FIELD.test(key)) return KEYS_LIVE_ELSEWHERE;
  const match = knownFieldsAt(path).find((k) => normalize(k) === normalize(key));
  return match ? `Unknown field "${key}". Did you mean "${match}"?` : `Unknown field "${key}".`;
}

// ------------------------------------------------------------------------------------------- positions

type Range = readonly [number, number];

/** The source range of the node at `path`, or of its closest existing ancestor (a missing field points at its parent). */
function rangeAt(doc: Document, path: readonly PropertyKey[]): Range {
  for (let n = path.length; n >= 0; n--) {
    const node = n === 0 ? doc.contents : doc.getIn(path.slice(0, n) as Array<string | number>, true);
    const range = (node as { range?: [number, number, number] } | undefined)?.range;
    if (range) return [range[0], range[1]];
  }
  return [0, 0];
}

/** The range of a key inside the mapping at `path` (for unknown fields, highlight the key itself). */
function keyRange(doc: Document, path: readonly PropertyKey[], key: string): Range {
  const node = path.length ? doc.getIn(path as Array<string | number>, true) : doc.contents;
  if (isMap(node)) {
    const pair = node.items.find((p) => isScalar(p.key) && p.key.value === key);
    const range = isScalar(pair?.key) ? pair.key.range : undefined;
    if (range) return [range[0], range[1]];
  }
  return rangeAt(doc, path);
}

function toProblem(lines: LineCounter, [start, end]: Range, message: string): ConfigProblem {
  const a = lines.linePos(start);
  const b = lines.linePos(Math.max(start, end));
  return { message, line: a.line - 1, column: a.col - 1, endLine: b.line - 1, endColumn: b.col - 1 };
}

// ------------------------------------------------------------------------------------------- parse

/**
 * Parses and validates the text of `config.yaml`. Returns every problem found, each with its position, or the
 * validated configuration. An empty file (or one with only comments) is valid and configures nothing.
 */
export function parseConfigFile(text: string, options: ConfigParseOptions = {}): ConfigParseResult {
  const lines = new LineCounter();
  if (text.length > CONFIG_FILE_MAX_BYTES) {
    return {
      ok: false,
      problems: [
        {
          message: `The file is larger than ${CONFIG_FILE_MAX_BYTES / 1024} KB.`,
          line: 0,
          column: 0,
          endLine: 0,
          endColumn: 0,
        },
      ],
    };
  }
  // YAML 1.2 core schema: no custom tags, so parsing never instantiates anything but plain data.
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length) {
    return {
      ok: false,
      problems: doc.errors.map((e) => toProblem(lines, [e.pos[0], e.pos[1]], e.message.split('\n')[0]!)),
    };
  }

  let data: unknown;
  try {
    // maxAliasCount guards against "billion laughs" alias expansion.
    data = doc.toJS({ maxAliasCount: 100 }) ?? {};
  } catch (e) {
    return { ok: false, problems: [toProblem(lines, [0, 0], e instanceof Error ? e.message : String(e))] };
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    return {
      ok: false,
      problems: [toProblem(lines, rangeAt(doc, []), 'The file must be a mapping with a "providers" list.')],
    };
  }

  const parsed = fileSchema.safeParse(data);
  if (!parsed.success) {
    const problems: ConfigProblem[] = [];
    for (const issue of parsed.error.issues) {
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys)
          problems.push(
            toProblem(lines, keyRange(doc, issue.path, key), unknownFieldMessage(key, issue.path)),
          );
      } else {
        const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
        problems.push(toProblem(lines, rangeAt(doc, issue.path), `${where}${issue.message}`));
      }
    }
    problems.sort((a, b) => a.line - b.line || a.column - b.column);
    return { ok: false, problems };
  }

  const f = parsed.data;
  // A model choice must name a configured model. A provider defined in the file replaces the Settings one, so its
  // models are the only ones that count.
  const refProblems: ConfigProblem[] = [];
  for (const key of ['defaultModel', 'planModel', 'titleModel'] as const) {
    const ref = f[key];
    if (!ref) continue;
    const [providerId, ...rest] = ref.split('/');
    const modelId = rest.join('/');
    const inFile = f.providers.find((p) => p.id === providerId);
    const known = inFile
      ? (inFile.models ?? []).some((m) => m.id === modelId)
      : (options.otherModels?.has(ref) ?? true);
    if (!known) {
      const where = inFile
        ? `provider "${providerId}" in this file has no model "${modelId}"`
        : `no provider "${providerId}" with model "${modelId}" is configured`;
      refProblems.push(toProblem(lines, rangeAt(doc, [key]), `${key}: ${where}.`));
    }
  }
  if (refProblems.length) return { ok: false, problems: refProblems };

  return {
    ok: true,
    config: {
      providers: f.providers.map((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        baseUrl: p.baseUrl.replace(/\/+$/, ''),
        ...(p.auth
          ? {
              auth: p.auth.headerName
                ? { type: p.auth.type, headerName: p.auth.headerName }
                : { type: p.auth.type },
            }
          : {}),
        ...(p.headers ? { headers: p.headers } : {}),
        ...(p.timeoutSeconds ? { timeoutSeconds: p.timeoutSeconds } : {}),
        models: p.models ?? [],
      })),
      ...(f.defaultModel ? { defaultModel: f.defaultModel } : {}),
      ...(f.planModel ? { planModel: f.planModel } : {}),
      ...(f.titleModel ? { titleModel: f.titleModel } : {}),
    },
  };
}

/**
 * Two provider lists as one: an `overlay` entry replaces the `base` entry with the same id (in place, so the order stays
 * stable) and new overlay entries follow. `overridden` lists the replaced ids. Used when Settings and the file start to
 * sync, so that nothing on either side is lost.
 */
export function mergeProviders(
  base: readonly ProviderConfig[],
  overlay: readonly ProviderConfig[],
): { providers: ProviderConfig[]; overridden: string[] } {
  const byId = new Map(overlay.map((p) => [p.id, p]));
  const overridden: string[] = [];
  const providers = base.map((p) => {
    const replacement = byId.get(p.id);
    if (!replacement) return p;
    overridden.push(p.id);
    byId.delete(p.id);
    return replacement;
  });
  return { providers: [...providers, ...byId.values()], overridden };
}

// ------------------------------------------------------------------------------------------- sync with Settings

export type ModelChoiceKey = 'defaultModel' | 'planModel' | 'titleModel';

/**
 * A provider with every default made explicit, so the same configuration compares equal whichever side wrote it
 * (Settings writes `auth: { type }` and omits `toolMode: auto`; the file may say `auth: none` or list model ids as
 * plain strings).
 */
export function canonicalProvider(p: ProviderConfig): ProviderConfig {
  const auth = p.auth?.type ?? 'bearer';
  const headers = Object.keys(p.headers ?? {}).sort();
  return {
    id: p.id,
    name: p.name || p.id,
    baseUrl: p.baseUrl.trim().replace(/\/+$/, ''),
    auth:
      auth === 'header'
        ? { type: 'header', headerName: p.auth?.headerName?.trim() || 'api-key' }
        : { type: auth },
    ...(headers.length ? { headers: Object.fromEntries(headers.map((k) => [k, p.headers![k]!])) } : {}),
    ...(p.timeoutSeconds ? { timeoutSeconds: p.timeoutSeconds } : {}),
    models: (p.models ?? []).map((m) => ({
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
      ...(m.temperature !== undefined ? { temperature: m.temperature } : {}),
      ...(m.toolMode && m.toolMode !== 'auto' ? { toolMode: m.toolMode } : {}),
    })),
  };
}

/** Whether two lists configure the same providers, in the same order. */
export function sameProviders(a: readonly ProviderConfig[], b: readonly ProviderConfig[]): boolean {
  return JSON.stringify(a.map(canonicalProvider)) === JSON.stringify(b.map(canonicalProvider));
}

/** How a provider is written in the file: shorthands where they read better (`auth: none`, a model id alone). */
function toYamlValue(p: ProviderConfig): Record<string, unknown> {
  const c = canonicalProvider(p);
  return {
    id: c.id,
    name: c.name,
    baseUrl: c.baseUrl,
    auth: c.auth!.type === 'header' ? { type: 'header', headerName: c.auth!.headerName } : c.auth!.type,
    ...(c.headers ? { headers: c.headers } : {}),
    ...(c.timeoutSeconds ? { timeoutSeconds: c.timeoutSeconds } : {}),
    models: c.models!.map((m) => (Object.keys(m).length === 1 ? m.id : m)),
  };
}

/** Reads a provider entry as written in the file (already validated) back into a configuration. */
function fromYamlValue(raw: unknown): ProviderConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return undefined;
  const auth = typeof r.auth === 'string' ? { type: r.auth } : r.auth;
  const models = Array.isArray(r.models) ? r.models.map((m) => (typeof m === 'string' ? { id: m } : m)) : [];
  return {
    ...(r as unknown as ProviderConfig),
    ...(auth ? { auth: auth as ProviderConfig['auth'] } : {}),
    models: models as ProviderConfig['models'],
  };
}

/**
 * Writes `providers` (and the model choices the file already declares) into the text of a valid config file, editing
 * the YAML document in place: unchanged entries, comments and formatting stay as they are; changed fields are
 * replaced one by one; removed providers disappear and new ones are appended, in the order of `providers`.
 * Throws when the text is not valid YAML (never overwrite a file the user is still fixing).
 */
export function updateConfigText(
  text: string,
  providers: readonly ProviderConfig[],
  choices: Partial<Record<ModelChoiceKey, string>> = {},
): string {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error('The config file has YAML syntax errors.');
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;

  const current = doc.get('providers', true);
  let seq: YAMLSeq;
  if (isSeq(current)) {
    seq = current;
  } else {
    seq = doc.createNode([]) as YAMLSeq;
    // `providers:` with nothing after it carries the commented examples; keep them under the list.
    if (isScalar(current)) {
      seq.commentBefore = current.commentBefore;
      seq.comment = current.comment;
    }
    doc.set('providers', seq);
  }

  const existing = new Map<string, YAMLMap>();
  for (const item of seq.items) {
    const id = isMap(item) ? item.get('id') : undefined;
    if (typeof id === 'string') existing.set(id, item as YAMLMap);
  }
  seq.items = providers.map((p) => {
    const node = existing.get(p.id);
    if (!node) return doc.createNode(toYamlValue(p));
    const before = fromYamlValue(node.toJSON());
    if (before && sameProviders([before], [p])) return node;
    // Replace only the fields that differ, so comments on the others survive.
    const next = toYamlValue(p);
    const was = before ? canonicalProvider(before) : undefined;
    const now = canonicalProvider(p);
    for (const [key, value] of Object.entries(next)) {
      const k = key as keyof ProviderConfig;
      if (!node.has(key) || JSON.stringify(was?.[k]) !== JSON.stringify(now[k]))
        node.set(key, doc.createNode(value));
    }
    for (const pair of [...node.items]) {
      const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
      if (key && !(key in next)) node.delete(key);
    }
    return node;
  });

  for (const [key, value] of Object.entries(choices) as Array<[ModelChoiceKey, string | undefined]>) {
    if (value === undefined || !doc.has(key)) continue;
    if (value) doc.set(key, value);
    else doc.delete(key);
  }
  return doc.toString();
}

const CONFIG_FILE_HEADER = `# Sovran model configuration
#
# This file and Sovran Settings stay in sync: save it and Sovran applies it (and connects to new or
# changed providers); change providers in Settings and Sovran writes them here, keeping your comments.
# If the file has a mistake, Sovran underlines it and keeps the last valid version.
# To go back to Settings only: Settings > Models > Stop using config.yaml.
#
# API keys never go in this file: use "Set key" in Sovran (VS Code Secret Storage).
# auth: bearer (the default) sends the key as "Authorization: Bearer <key>", the OpenAI standard.
#
# Models to select when this file changes, as providerId/modelId (optional):
# defaultModel: ollama/qwen2.5-coder:14b
# planModel: corp/coder-large
# titleModel: ollama/qwen2.5-coder:14b

`;

const CONFIG_FILE_EXAMPLES = `  # Examples (uncomment and adapt):
  #
  # Local Ollama
  # - id: ollama
  #   name: Ollama
  #   baseUrl: http://localhost:11434/v1
  #   auth: none
  #   models:
  #     - id: qwen2.5-coder:14b
  #       contextWindow: 32768
  #
  # LM Studio (a plain string is a model id)
  # - id: lmstudio
  #   name: LM Studio
  #   baseUrl: http://localhost:1234/v1
  #   auth: none
  #   models: [your-loaded-model]
  #
  # Company gateway with an API key (asked for once, kept in Secret Storage).
  # contextWindow and maxOutputTokens are optional: without them Sovran uses what the server
  # reports, else 32768 and 4096. Models that always reason share maxOutputTokens with their
  # reasoning: keep it generous.
  # - id: gateway
  #   name: Company AI Gateway
  #   baseUrl: https://ai-gateway.example.com/v1
  #   auth: bearer
  #   timeoutSeconds: 300
  #   models:
  #     - id: glm-5.3-flash
  #       maxOutputTokens: 8192
  #       temperature: 0.4
  #       toolMode: native
  #
  # Gateway that reads the key from its own header, plus extra non-secret headers
  # - id: corp
  #   name: Corp gateway
  #   baseUrl: https://llm.corp.example/v1
  #   auth:
  #     type: header
  #     headerName: api-key
  #   headers:
  #     X-Team: platform
  #   models: [coder-large]
`;

/** Starter content for a new file: the providers configured in Settings, then commented examples. */
export function configFileTemplate(providers: readonly ProviderConfig[] = []): string {
  const list = providers.length ? stringify({ providers: providers.map(toYamlValue) }) : 'providers:\n';
  return CONFIG_FILE_HEADER + list + CONFIG_FILE_EXAMPLES;
}
