/**
 * The optional `config.yaml` file: providers and model choices written by hand instead of through the UI.
 *
 * Parsing is pure (no VS Code API) so it can be unit tested and reused. Every problem carries a source range, so the
 * host can show it in the editor exactly where it is, the way a compiler would.
 */
import { LineCounter, isMap, isScalar, parseDocument, type Document } from 'yaml';
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
 * Providers from Settings and from the file, as one list. A file entry replaces the Settings entry with the same id
 * (in place, so the order stays stable); new file entries follow. `overridden` lists the replaced ids.
 */
export function mergeProviders(
  fromSettings: readonly ProviderConfig[],
  fromFile: readonly ProviderConfig[],
): { providers: ProviderConfig[]; overridden: string[] } {
  const byId = new Map(fromFile.map((p) => [p.id, p]));
  const overridden: string[] = [];
  const providers = fromSettings.map((p) => {
    const replacement = byId.get(p.id);
    if (!replacement) return p;
    overridden.push(p.id);
    byId.delete(p.id);
    return replacement;
  });
  return { providers: [...providers, ...byId.values()], overridden };
}

/** Commented starter content for a new file. It configures nothing until the user uncomments an entry. */
export const CONFIG_FILE_TEMPLATE = `# Sovran model configuration
#
# Save this file and Sovran applies it right away: it loads the providers below and connects to the
# ones that are new or changed. If the file has a mistake, Sovran underlines it and keeps using the
# last valid version.
#
# Providers here are added to the ones you configured in Settings. An entry with the same id replaces
# the Settings one. API keys never go in this file: use "Set key" in Sovran (VS Code Secret Storage).

providers:
  # Local Ollama
  # - id: ollama
  #   name: Ollama
  #   baseUrl: http://localhost:11434/v1
  #   auth: none
  #   models:
  #     - id: qwen2.5-coder:14b
  #       contextWindow: 32768

  # LM Studio (a plain string is a model id)
  # - id: lmstudio
  #   name: LM Studio
  #   baseUrl: http://localhost:1234/v1
  #   auth: none
  #   models: [your-loaded-model]

  # vLLM on a GPU server (the key is asked for once and kept in Secret Storage)
  # - id: vllm
  #   name: GPU cluster
  #   baseUrl: https://vllm.internal.example/v1
  #   auth: bearer
  #   timeoutSeconds: 300
  #   models:
  #     - id: my-coder
  #       contextWindow: 131072
  #       toolMode: native

  # Company gateway with a custom auth header and extra non-secret headers
  # - id: corp
  #   name: Company AI Gateway
  #   baseUrl: https://ai-gateway.example.com/v1
  #   auth:
  #     type: header
  #     headerName: api-key
  #   headers:
  #     X-Team: platform
  #   models:
  #     - id: coder-large
  #       contextWindow: 128000

# Models to select when this file is applied, as providerId/modelId (all optional).
# defaultModel: ollama/qwen2.5-coder:14b
# planModel: corp/coder-large
# titleModel: ollama/qwen2.5-coder:14b
`;
