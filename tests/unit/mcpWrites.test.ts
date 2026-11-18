import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AgentRunner, type AgentSettings } from '../../src/core/agent/agentRunner';
import type { AgentEvent } from '../../src/core/agent/events';
import {
  integrationArguments,
  integrationCallProblem,
  integrationConnection,
  integrationDiscoveryProblem,
  integrationToolAllowed,
  integrationToolRequiresApproval,
  type ManagedIntegration,
} from '../../src/core/mcp/catalog';
import {
  integrationWriteTools,
  reviewedWriteApprovalArguments,
  reviewedWriteParameters,
} from '../../src/core/mcp/writes';
import { fromEntry, parseMcpServers, toEntry, toolPolicy } from '../../src/core/mcp/config';
import { McpHub } from '../../src/core/mcp/hub';
import { nullLogger } from '../../src/core/ports';
import { MemoryCapabilityStore } from '../../src/core/providers/capabilities';
import type { Session, ToolMessage } from '../../src/core/sessions/model';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import {
  FakeProcess,
  MemoryWorkspace,
  ScriptedApprovals,
  ScriptedProvider,
  call,
  text,
} from '../fixtures/fakes';
import { MemoryTransports, until } from '../fixtures/mcp';

const profiles: ManagedIntegration[] = [
  {
    id: 'sentry',
    profile: 'collaboration',
    version: '0.49.0',
    executable: 'sentry-mcp',
    instanceUrl: 'https://sentry.io',
  },
  {
    id: 'grafana',
    profile: 'collaboration',
    version: '2.3.0',
    executable: 'mcp-grafana',
    instanceUrl: 'https://grafana.example.test',
  },
  {
    id: 'terraform',
    profile: 'hcp-operations',
    version: '1.4.1',
    executable: 'terraform-mcp-server',
    instanceUrl: 'https://tfe.example.test',
  },
  {
    id: 'opensearch',
    profile: 'operations',
    version: 'external-v1',
    endpoint: 'https://search.example.test/mcp',
  },
];
const configured = (managed: ManagedIntegration) =>
  fromEntry({ id: managed.id, managed, ...integrationConnection(managed) });
const readProfile = (managed: ManagedIntegration): ManagedIntegration => ({
  ...managed,
  profile: managed.id === 'terraform' ? 'hcp-readonly' : 'readonly',
});
const hubs: McpHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.dispose()));
});

describe('managed write contracts', () => {
  it.each(profiles)('requires approval for every $id write and leaves read profiles unchanged', (managed) => {
    const config = configured(managed);
    expect(parseMcpServers([toEntry(config)]).servers).toEqual([config]);
    for (const tool of integrationWriteTools(managed.id, managed.profile)) {
      expect(integrationToolAllowed(managed, tool)).toBe(true);
      expect(integrationToolAllowed(readProfile(managed), tool)).toBe(false);
      expect(integrationToolRequiresApproval(managed, tool)).toBe(true);
      expect(toolPolicy({ ...config, allowedTools: [tool] }, tool)).toBe('ask');
      expect(toolPolicy({ ...config, allowedTools: [tool], disabledTools: [tool] }, tool)).toBe('off');
    }
    expect(integrationDiscoveryProblem(managed, [])).toMatch(/does not offer all writes/);
    expect(
      integrationToolAllowed(
        { ...managed, version: 'old' },
        integrationWriteTools(managed.id, managed.profile)[0]!,
      ),
    ).toBe(false);
  });

  it('uses the upstream opt-ins without broadening the original launch flags', () => {
    expect(integrationArguments(profiles[0]!)).toEqual(['mcp', '--skills', 'inspect,triage']);
    const grafana = integrationArguments(profiles[1]!);
    expect(grafana).toContain('--disable-write=false');
    expect(grafana).toContain('--usage-stats=disabled');
    expect(grafana).not.toContain('--disable-write');
    expect(grafana.at(-1)).toContain(',annotations');
    expect(integrationArguments(readProfile(profiles[1]!))).toContain('--disable-write');
    const terraform = integrationConnection(profiles[2]!);
    expect(terraform.env).toMatchObject({
      TFE_ADDRESS: 'https://tfe.example.test',
      ENABLE_TF_OPERATIONS: 'true',
      OTEL_METRICS_ENABLED: 'false',
    });
    expect(terraform.auth).toEqual({ type: 'env', envName: 'TFE_TOKEN' });
    expect(terraform.args?.join(' ')).toContain('action_run');
    expect(integrationConnection(readProfile(profiles[2]!)).env?.ENABLE_TF_OPERATIONS).toBe('false');
  });

  it('narrows broader upstream schemas and hides headers and credential overrides', () => {
    const schema = reviewedWriteParameters(profiles[3], 'GenericOpenSearchApiTool', {
      properties: { headers: {}, opensearch_password: {} },
    })!;
    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ['method', 'path'],
      properties: { method: { enum: ['PUT', 'POST', 'DELETE'] } },
    });
    expect(schema.properties).not.toHaveProperty('headers');
    expect(schema.properties).not.toHaveProperty('opensearch_password');
    expect(
      reviewedWriteParameters(profiles[2], 'create_run', { required: ['workspace_name'] }),
    ).toMatchObject({
      required: ['workspace_name', 'run_type'],
      properties: { run_type: { enum: ['plan_only', 'plan_and_apply'] } },
    });
    expect(
      reviewedWriteParameters(readProfile(profiles[3]!), 'GenericOpenSearchApiTool', {}),
    ).toBeUndefined();
  });
  it('puts the full dashboard identity before large JSON without changing the actual arguments', () => {
    const args = {
      message: 'Save',
      dashboard: { panels: [{ payload: 'x'.repeat(10000) }], uid: 'dash-one', title: 'Payments', version: 5 },
    };
    const original = structuredClone(args);
    const display = reviewedWriteApprovalArguments(profiles[1], 'update_dashboard', args);
    expect(
      JSON.stringify(display).startsWith('{"dashboard":{"uid":"dash-one","title":"Payments","version":5,'),
    ).toBe(true);
    expect(args).toEqual(original);
    expect(display).toEqual(args);
  });
});

describe('OpenSearch operation boundaries', () => {
  const managed = profiles[3]!;
  const check = (args: Record<string, unknown>) =>
    integrationCallProblem(managed, 'GenericOpenSearchApiTool', args);
  it.each([
    { method: 'PUT', path: '/orders' },
    {
      method: 'PUT',
      path: '/orders',
      body: { settings: { number_of_shards: 1 }, mappings: { properties: { name: { type: 'keyword' } } } },
    },
    { method: 'PUT', path: '/orders/_mapping', body: { properties: { name: { type: 'keyword' } } } },
    { method: 'POST', path: '/orders/_doc', body: { name: 'sample' }, query_params: { refresh: 'wait_for' } },
    {
      method: 'PUT',
      path: '/orders/_doc/one',
      body: { name: 'sample' },
      query_params: { op_type: 'create' },
    },
    {
      method: 'PUT',
      path: '/orders/_doc/one',
      body: { name: 'updated' },
      query_params: { if_seq_no: 0, if_primary_term: 1 },
    },
    { method: 'POST', path: '/orders/_update/one', body: { doc: { name: 'updated' }, doc_as_upsert: true } },
    {
      method: 'DELETE',
      path: '/orders/_doc/one',
      opensearch_cluster_name: 'registered-prod',
      query_params: { if_seq_no: 2, if_primary_term: 1 },
    },
  ])('accepts a bounded $method $path operation', (args) => {
    expect(check(args)).toBeUndefined();
  });

  it.each([
    '/_cluster/settings',
    '/_plugins/_security/api/internalusers/root',
    '/_bulk',
    '/orders/_delete_by_query',
    '/orders/_update_by_query',
    '/.system/_doc/one',
    '/_all/_doc/one',
    '/orders*/_doc/one',
    '/orders,other/_doc/one',
    '/orders/../_cluster/settings',
    '/orders/%2e%2e/_settings',
    '/orders/_doc/%2f',
    '/orders/_doc/one?refresh=true',
    '/orders/_doc/one#fragment',
    '//evil.test/orders',
    'https://evil.test/orders',
    '/orders/_doc/..',
  ])('rejects an arbitrary or ambiguous target %s', (path) => {
    expect(check({ method: 'PUT', path, body: {} })).toBeTruthy();
  });

  it.each([
    { method: 'DELETE', path: '/orders' },
    { method: 'GET', path: '/orders' },
    { method: 'POST', path: '/orders/_doc', body: 'raw ndjson\n' },
    { method: 'PUT', path: '/orders/_doc/one', body: [] },
    { method: 'PUT', path: '/orders', body: { aliases: { other: {} } } },
    { method: 'POST', path: '/orders/_update/one', body: { script: { source: 'ctx._source.x=1' } } },
    { method: 'POST', path: '/orders/_update/one', body: { doc: {}, doc_as_upsert: 'true' } },
    { method: 'PUT', path: '/orders/_doc/one', body: {}, headers: { Authorization: 'other' } },
    { method: 'PUT', path: '/orders/_doc/one', body: {}, opensearch_url: 'https://evil.test' },
    { method: 'PUT', path: '/orders/_doc/one', body: {}, aws_profile: 'other' },
    { method: 'PUT', path: '/orders/_doc/one', body: {}, query_params: { if_seq_no: 1 } },
    {
      method: 'PUT',
      path: '/orders/_doc/one',
      body: {},
      query_params: { if_seq_no: '1', if_primary_term: 1 },
    },
    { method: 'PUT', path: '/orders/_doc/one', body: {}, query_params: { refresh: ['true'] } },
    {
      method: 'PUT',
      path: '/orders/_doc/one',
      body: {},
      query_params: { if_seq_no: 0, if_primary_term: 1, op_type: 'create' },
    },
    { method: 'DELETE', path: '/orders/_doc/one', body: {} },
  ])('rejects unsafe options for $method $path', (args) => {
    expect(check(args)).toBeTruthy();
  });
});

describe('Terraform and Grafana operation arguments', () => {
  it.each([undefined, 'auto_approve', 'is_destroy', 'refresh_state', ['plan_only'], null])(
    'rejects implicit or unsupported Terraform run type %s',
    (run_type) => {
      expect(
        integrationCallProblem(profiles[2], 'create_run', {
          terraform_org_name: 'org',
          workspace_name: 'test',
          run_type,
        }),
      ).toMatch(/explicit run_type/);
    },
  );
  it('requires manual apply and an explicit run target', () => {
    expect(
      integrationCallProblem(profiles[2], 'create_run', {
        terraform_org_name: 'org',
        workspace_name: 'test',
        run_type: 'plan_only',
      }),
    ).toBeUndefined();
    expect(
      integrationCallProblem(profiles[2], 'create_run', {
        terraform_org_name: 'org',
        workspace_name: 'test',
        run_type: 'plan_and_apply',
        auto_approve: true,
      }),
    ).toBeTruthy();
    for (const tool of ['create_workspace', 'update_workspace']) {
      for (const auto_apply of [undefined, true, 'true', 'FALSE', ['false']])
        expect(integrationCallProblem(profiles[2], tool, { auto_apply })).toBeTruthy();
      expect(integrationCallProblem(profiles[2], tool, { auto_apply: 'false' })).toBeUndefined();
    }
    for (const run_action of ['apply', 'cancel', 'discard'])
      expect(
        integrationCallProblem(profiles[2], 'action_run', { run_action, run_id: 'run-abc123' }),
      ).toBeUndefined();
    expect(
      integrationCallProblem(profiles[2], 'action_run', { run_action: ['apply'], run_id: 'run-abc123' }),
    ).toBeTruthy();
    expect(
      integrationCallProblem(profiles[2], 'action_run', { run_action: 'apply', run_id: '/runs/one' }),
    ).toBeTruthy();
    expect(integrationCallProblem(profiles[1], 'update_dashboard', { overwrite: true })).toMatch(/overwrite/);
    expect(
      integrationCallProblem(profiles[1], 'update_dashboard', {
        uid: 'one',
        operations: [],
        overwrite: false,
      }),
    ).toBeUndefined();
  });
});

const settings: AgentSettings = {
  maxIterations: 4,
  policy: { approvalMode: 'auto', allowedCommands: [], protectedPaths: [] },
  tools: { terminalTimeoutMs: 1000, maxToolResultChars: 20000, protectedPaths: [] },
  defaultContextWindow: 32768,
  defaultMaxOutputTokens: 4096,
};
const examples: Array<[ManagedIntegration, string, Record<string, unknown>]> = [
  [profiles[0]!, 'add_issue_note', { organizationSlug: 'org', issueId: 'APP-1', text: 'Investigating' }],
  [profiles[1]!, 'create_annotation', { dashboardUid: 'one', text: 'Release deployed' }],
  [profiles[2]!, 'create_run', { terraform_org_name: 'org', workspace_name: 'test', run_type: 'plan_only' }],
  [
    profiles[3]!,
    'GenericOpenSearchApiTool',
    { method: 'PUT', path: '/orders/_doc/one', body: { name: 'sample' } },
  ],
];

async function agentRun(
  managed: ManagedIntegration,
  tool: string,
  args: Record<string, unknown>,
  approve: boolean,
  change?: 'off' | 'downgrade' | 'trust' | 'stop' | 'refresh',
) {
  const calls = vi.fn();
  let withdraw: (() => void) | undefined;
  const transports = new MemoryTransports({
    [managed.id]: () => {
      const srv = new McpServer({ name: 'operations', version: managed.version });
      for (const name of [
        ...integrationWriteTools(managed.id, managed.profile),
        ...(managed.id === 'terraform' ? ['get_workspace_details'] : []),
      ]) {
        const registered = srv.registerTool(
          name,
          {
            inputSchema: z.object({}).passthrough(),
            annotations: { readOnlyHint: true, destructiveHint: false },
          },
          async (input) => {
            calls(input);
            return { content: [{ type: 'text', text: 'changed' }] };
          },
        );
        if (name === tool)
          withdraw = () => {
            registered.remove();
            srv.sendToolListChanged();
          };
      }
      return srv;
    },
  });
  const hub = new McpHub({ transports, logger: nullLogger, client: { name: 'sovran', version: '0' } });
  hubs.push(hub);
  const config = {
    ...configured(managed),
    allowedTools: [...integrationWriteTools(managed.id, managed.profile)],
  };
  hub.update([config], true);
  await until(() => hub.states()[0]?.status === 'connected');
  const abort = new AbortController();
  const approvals = new ScriptedApprovals(async () => {
    if (change === 'off') hub.update([{ ...config, disabledTools: [tool] }], true);
    if (change === 'downgrade') hub.update([configured(readProfile(managed))], true);
    if (change === 'trust') hub.update([config], false);
    if (change === 'stop') abort.abort();
    if (change === 'refresh') {
      withdraw?.();
      await until(() => hub.states()[0]?.status === 'error');
    }
    return { approved: approve };
  });
  const provider = new ScriptedProvider([[call(0, `mcp__${managed.id}__${tool}`, args)], [text('done')]]);
  const session: Session = {
    id: 'ops',
    title: 'ops',
    mode: 'act',
    createdAt: 0,
    updatedAt: 0,
    messages: [{ role: 'user', id: 'u', content: 'Perform the selected operation', createdAt: 0 }],
  };
  const events: AgentEvent[] = [];
  const runner = new AgentRunner({
    provider,
    registry: createBuiltinRegistry().addSource(hub),
    workspace: new MemoryWorkspace({}),
    process: new FakeProcess(),
    approvals,
    capabilities: new MemoryCapabilityStore(),
    logger: nullLogger,
  });
  await runner.run({
    session,
    providerId: 'p',
    model: { id: 'm', toolMode: 'native' },
    mode: 'act',
    settings,
    grants: { edits: false },
    signal: abort.signal,
    emit: (event) => {
      events.push(event);
    },
  });
  return {
    hub,
    calls,
    approvals,
    provider,
    events,
    result: session.messages.find((message): message is ToolMessage => message.role === 'tool'),
  };
}

describe('managed mutations in the agent loop', () => {
  it.each(examples)(
    'asks for $0.id writes despite Auto, Allow settings and false server annotations',
    async (managed, tool, args) => {
      const run = await agentRun(managed, tool, args, true);
      expect(run.approvals.requests).toHaveLength(1);
      expect(run.approvals.requests[0]?.detail).toMatchObject({
        kind: 'mcp',
        tool,
        requiresApproval: true,
        hints: ['managed-write'],
      });
      expect(run.calls).toHaveBeenCalledExactlyOnceWith(args);
      expect(run.result).toMatchObject({ status: 'success', content: 'changed' });
      expect(run.result?.autoApproved).toBeUndefined();
    },
  );
  it.each(examples)('sends no $0.id mutation after rejection', async (managed, tool, args) => {
    const run = await agentRun(managed, tool, args, false);
    expect(run.calls).not.toHaveBeenCalled();
    expect(run.result?.status).toBe('denied');
  });
  it.each(['off', 'downgrade', 'trust', 'stop', 'refresh'] as const)(
    'rechecks %s changes after approval',
    async (change) => {
      const [managed, tool, args] = examples[0]!;
      const run = await agentRun(managed, tool, args, true, change);
      expect(run.calls).not.toHaveBeenCalled();
      expect(run.result?.status).not.toBe('success');
    },
  );
  it('rejects OpenSearch connection overrides before asking or dispatching', async () => {
    const [managed, tool, args] = examples[3]!;
    const run = await agentRun(managed, tool, { ...args, headers: { Authorization: 'other' } }, true);
    expect(run.approvals.requests).toHaveLength(0);
    expect(run.calls).not.toHaveBeenCalled();
    expect(run.result?.status).toBe('error');
  });
  it('keeps the exact OpenSearch target visible before a truncated large body', async () => {
    const [managed, tool] = examples[3]!;
    const args = { body: { payload: 'x'.repeat(10000) }, path: '/orders/_doc/one', method: 'PUT' };
    const run = await agentRun(managed, tool, args, true);
    const detail = run.approvals.requests[0]?.detail;
    expect(detail?.kind).toBe('mcp');
    if (detail?.kind !== 'mcp') throw new Error('Missing MCP approval');
    expect(detail.arguments.startsWith('{\n  "method": "PUT",\n  "path": "/orders/_doc/one",')).toBe(true);
    expect(detail.arguments).toContain('…');
    expect(run.calls).toHaveBeenCalledExactlyOnceWith(args);
  });
});
