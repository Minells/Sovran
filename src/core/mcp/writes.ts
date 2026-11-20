/** Reviewed mutation contracts for the optional service integrations. No transport or credentials here. */
import type { IntegrationId, IntegrationProfile, ManagedIntegration } from './catalog';

export const GRAFANA_WRITE_TOOLS = [
  'update_dashboard',
  'create_annotation',
  'update_annotation',
  'delete_annotation',
] as const;
export const TERRAFORM_WRITE_TOOLS = [
  'create_workspace',
  'update_workspace',
  'create_run',
  'action_run',
] as const;
export const OPENSEARCH_WRITE_TOOLS = ['GenericOpenSearchApiTool'] as const;

export function integrationWriteTools(id: IntegrationId, profile: IntegrationProfile): readonly string[] {
  if (id === 'grafana' && profile === 'collaboration') return GRAFANA_WRITE_TOOLS;
  if (id === 'terraform' && profile === 'hcp-operations') return TERRAFORM_WRITE_TOOLS;
  if (id === 'opensearch' && profile === 'operations') return OPENSEARCH_WRITE_TOOLS;
  return [];
}

export function isIntegrationWrite(managed: ManagedIntegration | undefined, tool: string): boolean {
  return !!managed && integrationWriteTools(managed.id, managed.profile).includes(tool);
}

/** Put the mutation target before potentially large payloads in the bounded approval preview. */
export function reviewedWriteApprovalArguments(
  managed: ManagedIntegration | undefined,
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!isIntegrationWrite(managed, tool)) return args;
  const first = [
    'method',
    'path',
    'opensearch_cluster_name',
    'run_action',
    'run_id',
    'terraform_org_name',
    'workspace_name',
    'run_type',
    'auto_apply',
    'uid',
    'id',
    'dashboardUid',
  ];
  const target = Object.fromEntries(
    first.filter((key) => Object.hasOwn(args, key)).map((key) => [key, args[key]]),
  );
  const dashboard = args.dashboard;
  if (tool === 'update_dashboard' && object(dashboard)) {
    const dashboardTarget = Object.fromEntries(
      ['uid', 'title', 'version']
        .filter((key) => Object.hasOwn(dashboard, key))
        .map((key) => [key, dashboard[key]]),
    );
    return {
      ...target,
      dashboard: { ...dashboardTarget, ...dashboard },
      ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'dashboard')),
    };
  }
  return { ...target, ...args };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const positiveInteger = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function integrationWriteProblem(
  managed: ManagedIntegration | undefined,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!isIntegrationWrite(managed, tool)) return;
  if (managed?.id === 'grafana') {
    if (tool === 'update_dashboard' && args.overwrite !== undefined && args.overwrite !== false)
      return 'Forced dashboard overwrite is unavailable. Read the current dashboard and use patches or its current version with overwrite=false.';
    if (['update_annotation', 'delete_annotation'].includes(tool) && !positiveInteger(args.id))
      return 'Provide the positive integer ID of one annotation.';
  }
  if (managed?.id === 'terraform') {
    if (tool === 'create_run') {
      if (typeof args.run_type !== 'string' || !['plan_only', 'plan_and_apply'].includes(args.run_type))
        return 'Choose an explicit run_type: plan_only or plan_and_apply. Automatic apply, destroy and refresh runs are unavailable.';
      if (
        Object.keys(args).some(
          (key) => !['terraform_org_name', 'workspace_name', 'run_type', 'message'].includes(key),
        )
      )
        return 'Only organization, workspace, explicit run_type and message are supported for create_run.';
    }
    if (['create_workspace', 'update_workspace'].includes(tool) && args.auto_apply !== 'false')
      return 'Set auto_apply to the string "false". Managed workspace operations cannot enable automatic apply.';
    if (tool === 'action_run') {
      if (
        typeof args.run_action !== 'string' ||
        !['apply', 'cancel', 'discard'].includes(args.run_action) ||
        typeof args.run_id !== 'string' ||
        !/^run-[a-zA-Z0-9]+$/.test(args.run_id)
      )
        return 'Choose apply, cancel or discard and provide one run_id. Read the run and review its plan before applying.';
      if (Object.keys(args).some((key) => !['run_action', 'run_id', 'comment'].includes(key)))
        return 'Only run_action, run_id and comment are supported for action_run.';
    }
  }
  if (managed?.id === 'opensearch') return openSearchWriteProblem(args);
}

/** The generic upstream API is bounded to concrete, non-system index/document targets. */
function openSearchWriteProblem(args: Record<string, unknown>): string | undefined {
  if (
    Object.keys(args).some(
      (key) => !['method', 'path', 'body', 'query_params', 'opensearch_cluster_name'].includes(key),
    )
  )
    return 'OpenSearch operations do not accept custom headers, credentials or unknown options.';
  const match =
    typeof args.path === 'string'
      ? /^\/([a-z0-9][a-z0-9._-]{0,254})(?:\/(_mapping|_doc|_update)(?:\/([a-zA-Z0-9_~-][a-zA-Z0-9._~-]{0,511}))?)?$/.exec(
          args.path,
        )
      : null;
  if (!match)
    return 'Use one concrete non-system index and an optional document ID. Wildcards, encoded paths, URLs and arbitrary API endpoints are unavailable.';
  const [, , route, id] = match;
  const method = args.method;
  const createIndex = !route && method === 'PUT';
  const mapping = route === '_mapping' && !id && method === 'PUT';
  const document =
    route === '_doc' && ((!!id && (method === 'PUT' || method === 'DELETE')) || (!id && method === 'POST'));
  const update = route === '_update' && !!id && method === 'POST';
  if (!createIndex && !mapping && !document && !update)
    return 'Allowed OpenSearch operations: PUT /index, PUT /index/_mapping, PUT /index/_doc/id, POST /index/_doc, POST /index/_update/id, DELETE /index/_doc/id.';
  if (args.opensearch_cluster_name !== undefined && !nonempty(args.opensearch_cluster_name))
    return 'Choose a nonempty cluster name registered on the external server, or omit it for single-cluster mode.';
  if (method === 'DELETE') {
    if (args.body !== undefined) return 'Single-document deletion does not accept a body.';
  } else {
    if (!(createIndex && args.body === undefined) && !object(args.body))
      return 'Provide a JSON object body. Raw strings, scripts and bulk request bodies are unavailable.';
    if (
      createIndex &&
      object(args.body) &&
      Object.keys(args.body).some((key) => !['settings', 'mappings'].includes(key))
    )
      return 'Index creation accepts only settings and mappings.';
    if (
      update &&
      (!object(args.body) ||
        !object(args.body.doc) ||
        Object.keys(args.body).some((key) => !['doc', 'doc_as_upsert'].includes(key)) ||
        (args.body.doc_as_upsert !== undefined && typeof args.body.doc_as_upsert !== 'boolean'))
    )
      return 'Partial updates require a doc object and optional boolean doc_as_upsert. Scripts are unavailable.';
  }
  if (args.query_params !== undefined) {
    if (!object(args.query_params)) return 'query_params must be an object.';
    const query = args.query_params;
    if (
      Object.keys(query).some(
        (key) => !['refresh', 'op_type', 'if_seq_no', 'if_primary_term'].includes(key),
      ) ||
      ((createIndex || mapping) && Object.keys(query).length)
    )
      return 'Only document refresh, op_type=create and optimistic-concurrency parameters are supported.';
    if (
      query.refresh !== undefined &&
      (typeof query.refresh !== 'string' || !['true', 'false', 'wait_for'].includes(query.refresh))
    )
      return 'refresh must be true, false or wait_for.';
    if (
      query.op_type !== undefined &&
      (query.op_type !== 'create' || route !== '_doc' || method === 'DELETE')
    )
      return 'op_type=create applies only to document creation.';
    if (query.if_seq_no !== undefined || query.if_primary_term !== undefined) {
      if (
        !id ||
        typeof query.if_seq_no !== 'number' ||
        !Number.isSafeInteger(query.if_seq_no) ||
        query.if_seq_no < 0 ||
        !positiveInteger(query.if_primary_term) ||
        query.op_type !== undefined
      )
        return 'Provide paired integer if_seq_no (>=0) and if_primary_term (>0) for one document, without op_type.';
    }
  }
}

export function reviewedWriteDescription(
  managed: ManagedIntegration | undefined,
  tool: string,
): string | undefined {
  if (!isIntegrationWrite(managed, tool)) return;
  if (managed?.id === 'opensearch')
    return 'Perform one approved OpenSearch operation on a concrete non-system index: PUT /index (settings/mappings), PUT /index/_mapping, PUT /index/_doc/id, POST /index/_doc, POST /index/_update/id (doc, optional doc_as_upsert), DELETE /index/_doc/id. No custom headers, arbitrary endpoints, scripted updates, bulk or index deletion. Cluster credentials stay on the server. Each call requires approval.';
  if (tool === 'create_run')
    return 'Create an HCP/TFE run for an explicit organization and workspace with run_type=plan_only or plan_and_apply. The latter queues a plan that needs a separate approved action_run apply. No automatic apply or destroy runs. Each call requires approval.';
  if (tool === 'action_run')
    return 'Apply, cancel or discard one HCP/TFE run by run_id. Read get_run_details and get_plan_details first and explain the plan before requesting apply approval. Apply can create, change or delete infrastructure; success means the action was requested, so follow up with get_run_details. Each call requires approval.';
  if (tool === 'update_dashboard')
    return 'Create or update a Grafana dashboard. Read get_dashboard_by_uid before editing. Prefer uid + operations for targeted patches; full dashboard JSON must preserve the current schema/version. overwrite=true is unavailable. Each call requires approval.';
}

/** Narrow the generic server schema while keeping the actual upstream tool name and argument contract. */
export function reviewedWriteParameters(
  managed: ManagedIntegration | undefined,
  tool: string,
  upstream: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!isIntegrationWrite(managed, tool)) return;
  if (managed?.id === 'opensearch')
    return {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'path'],
      properties: {
        method: { type: 'string', enum: ['PUT', 'POST', 'DELETE'] },
        path: {
          type: 'string',
          description:
            'One approved /index, /index/_mapping, /index/_doc[/id] or /index/_update/id path. No wildcard, system or encoded targets.',
        },
        body: {
          type: 'object',
          additionalProperties: true,
          description: 'JSON body; partial updates use {doc: {...}, doc_as_upsert?: boolean}.',
        },
        query_params: {
          type: 'object',
          additionalProperties: false,
          properties: {
            refresh: { type: 'string', enum: ['true', 'false', 'wait_for'] },
            op_type: { type: 'string', enum: ['create'] },
            if_seq_no: { type: 'integer', minimum: 0 },
            if_primary_term: { type: 'integer', minimum: 1 },
          },
        },
        opensearch_cluster_name: {
          type: 'string',
          minLength: 1,
          description: 'Optional operator-registered cluster name.',
        },
      },
    };
  const properties = object(upstream.properties) ? upstream.properties : {};
  const required = Array.isArray(upstream.required) ? upstream.required : [];
  if (tool === 'create_run')
    return {
      ...upstream,
      properties: { ...properties, run_type: { type: 'string', enum: ['plan_only', 'plan_and_apply'] } },
      required: [...new Set([...required, 'run_type'])],
    };
  if (['create_workspace', 'update_workspace'].includes(tool))
    return {
      ...upstream,
      properties: { ...properties, auto_apply: { type: 'string', enum: ['false'] } },
      required: [...new Set([...required, 'auto_apply'])],
    };
  if (tool === 'update_dashboard')
    return { ...upstream, properties: { ...properties, overwrite: { type: 'boolean', enum: [false] } } };
}
