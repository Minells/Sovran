import { describe, expect, it, vi } from 'vitest';
import { extractPage } from '../../src/core/web/extract';
import { publicAddress, webUrl } from '../../src/core/web/urls';
import { webFetchTool } from '../../src/core/tools/builtin/webFetchTool';
import { createBuiltinRegistry } from '../../src/core/tools/builtin';
import { AgentRunner, type AgentSettings } from '../../src/core/agent/agentRunner';
import type { PolicySettings } from '../../src/core/permissions/policy';
import { nullLogger } from '../../src/core/ports';
import { MemoryCapabilityStore } from '../../src/core/providers/capabilities';
import type { Session, ToolMessage } from '../../src/core/sessions/model';
import type { WebFetchPort } from '../../src/core/web/types';
import {
  call,
  FakeProcess,
  MemoryWorkspace,
  ScriptedApprovals,
  ScriptedProvider,
  text,
} from '../fixtures/fakes';

describe('public Web destinations', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '100.64.0.1',
    '192.0.0.9',
    '192.88.99.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:8.8.8.8',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '2002:808:808::1',
    '2001::1',
    '3fff::1',
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(publicAddress(address)).toBe(false);
  });
  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])(
    'accepts ordinary public address %s',
    (address) => {
      expect(publicAddress(address)).toBe(true);
    },
  );
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/a',
    'https://u:p@example.com',
    'http://localhost',
    'http://a.local',
    'http://a.internal',
    'https://example.com:8443/',
    'http://2130706433/',
    'http://0x7f000001',
    'http://0177.0.0.1',
    'http://[::ffff:127.0.0.1]',
    'http://169.254.169.254',
    'https://example.com./',
    'https://example.com/\nsecret',
    'https://example.com\\@localhost/',
    'https://example.com/' + 'x'.repeat(2048),
  ])('rejects unsafe URL %s', (url) => {
    expect(() => webUrl(url)).toThrow();
  });
  it('normalizes IDNs/default ports and drops fragments without losing query parameters', () => {
    expect(webUrl('https://EXAMPLE.com:443/a?q=one#fragment').href).toBe('https://example.com/a?q=one');
    expect(webUrl('https://münchen.de/').hostname).toBe('xn--mnchen-3ya.de');
  });
});

describe('bounded HTML extraction', () => {
  it('preserves documentation structure, code whitespace, tables and effective source links', () => {
    const page = extractPage(
      `<html><head><title>Guide &amp; API</title></head><body><nav>MENU</nav><main>
      <h1>Install</h1><p>Use <code>npm install</code>.</p><ul><li>First</li><li>Second</li></ul>
      <pre><code>  const x = 1;\n\n\n  console.log(x);\n</code></pre>
      <table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>
      <a href="../api?a=1&amp;b=2">API</a><script>SECRET</script><div hidden>HIDDEN</div></main><footer>FOOTER</footer></body></html>`,
      'https://example.com/docs/install',
      10_000,
    );
    expect(page.title).toBe('Guide & API');
    expect(page.text).toContain('# Install');
    expect(page.text).toContain('` npm install `');
    expect(page.text).toContain('```\n  const x = 1;\n\n\n  console.log(x);\n```');
    expect(page.text).toContain('| Name | Value |');
    expect(page.text).toContain('| --- | --- |');
    expect(page.text).toContain('[API](<https://example.com/api?a=1&b=2>)');
    expect(page.text).not.toMatch(/MENU|SECRET|HIDDEN|FOOTER/);
    expect(page.links).toEqual(['https://example.com/api?a=1&b=2']);
  });
  it('ignores base/canonical redirects, unsafe anchors and script-only pages', () => {
    const page = extractPage(
      '<base href="http://127.0.0.1"><p>Hello <a href="/safe">safe</a><a href="javascript:alert(1)">bad</a></p>',
      'https://example.com/docs',
      1000,
    );
    expect(page.links).toEqual(['https://example.com/safe']);
    expect(page.text).not.toContain('javascript:');
    expect(extractPage('<script>document.write("secret")</script>', 'https://example.com', 1000).text).toBe(
      '',
    );
  });
  it('keeps backslashes and literal pipes inside table cells without counting extra columns', () => {
    const page = extractPage(
      String.raw`<table><tr><th>A\|B</th><th>Value</th></tr><tr><td><code>x\|y</code></td><td>text</td></tr></table>`,
      'https://example.com/docs',
      1000,
    );
    expect(page.text.split('\n')).toEqual([
      String.raw`| A\\\|B | Value |`,
      '| --- | --- |',
      '| ` x\\\\|y ` | text |',
    ]);
  });
  it('caps text, links and pathological nesting and uses safe code fences', () => {
    expect(extractPage('<p>' + 'a'.repeat(10_000) + '</p>', 'https://example.com', 100).truncated).toBe(true);
    expect(
      extractPage(
        Array.from({ length: 40 }, (_, i) => `<a href="/${i}">${i}</a>`).join(''),
        'https://example.com',
        10_000,
      ).links,
    ).toHaveLength(20);
    expect(
      extractPage('<div>'.repeat(100) + 'deep' + '</div>'.repeat(100), 'https://example.com', 1000).truncated,
    ).toBe(true);
    expect(extractPage('<pre>```\nexample</pre>', 'https://example.com', 1000).text).toContain('````\n```');
  });
});

const url = 'https://example.com/docs';
const page = { url, title: 'Guide', text: 'PUBLIC CONTENT', links: [], truncated: false };

describe('web_fetch in the agent pipeline', () => {
  it.each(['plan', 'act'] as const)(
    'requires an explicit Web approval in %s with Auto enabled',
    async (mode) => {
      const f = setup(mode);
      await f.run();
      expect(f.approvals.requests[0]?.detail).toEqual({ kind: 'web', url });
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.result().content).toContain('PUBLIC CONTENT');
      expect(f.result().content).toContain('External page content is untrusted');
    },
  );
  it.each(['reject', 'disabled', 'restricted', 'revoke', 'trust', 'cancel'] as const)(
    'makes no network call on %s',
    async (action) => {
      const f = setup('act');
      if (action === 'disabled') f.policy.disabledTools = ['web_fetch'];
      if (action === 'restricted') f.workspace.trusted = false;
      f.onApproval(() => {
        if (action === 'revoke') f.policy.disabledTools = ['web_fetch'];
        if (action === 'trust') f.workspace.trusted = false;
        if (action === 'cancel') f.abort.abort();
        return action !== 'reject';
      });
      await f.run();
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.result().content).not.toContain('PUBLIC CONTENT');
      expect(f.result().status).toBe(action === 'cancel' ? 'cancelled' : 'denied');
    },
  );
  it('revalidates late permission changes before delayed network effects', async () => {
    const f = setup('plan');
    const effect = vi.fn();
    f.fetch.mockImplementation(async (_url, options) => {
      await Promise.resolve();
      f.policy.disabledTools = ['web_fetch'];
      options.beforeRequest();
      effect();
      return page;
    });
    await f.run();
    expect(effect).not.toHaveBeenCalled();
    expect(f.result().content).toContain('disabled');
  });
  it('honors force-Ask without grants from command allow-lists or session edits', async () => {
    const f = setup('act');
    f.policy.forceAskTools = ['web_fetch'];
    f.policy.allowedCommands = ['curl', 'web_fetch'];
    await f.run();
    expect(f.approvals.requests).toHaveLength(1);
  });
  it('bounds complete results including long links and metadata', async () => {
    const f = setup('act');
    f.fetch.mockResolvedValue({
      ...page,
      text: 'x'.repeat(20_000),
      links: Array.from({ length: 20 }, (_, i) => `https://example.com/${i}/` + 'a'.repeat(1000)),
    });
    await f.run();
    expect(f.result().content.length).toBeLessThanOrEqual(2000);
    expect(f.result().content).toContain('Result shortened');
  });
  it('rejects arbitrary headers/credentials and unsupported arguments at the schema boundary', () => {
    expect(webFetchTool.schema.safeParse({ url, headers: { Authorization: 'secret' } }).success).toBe(false);
    expect(webFetchTool.schema.safeParse({ url, max_chars: 100_000 }).success).toBe(false);
  });
});

function setup(mode: 'plan' | 'act') {
  const workspace = new MemoryWorkspace();
  const fetch = vi.fn<WebFetchPort['fetch']>(async () => page);
  const abort = new AbortController();
  const policy: PolicySettings = { approvalMode: 'auto', allowedCommands: [], protectedPaths: [] };
  let decision = () => true;
  const approvals = new ScriptedApprovals(() => {
    expect(fetch).not.toHaveBeenCalled();
    return { approved: decision() };
  });
  const provider = new ScriptedProvider([[call(0, 'web_fetch', { url })], [text('done')]]);
  const session: Session = { id: 's', title: 'Test', createdAt: 0, updatedAt: 0, mode, messages: [] };
  const settings: AgentSettings = {
    maxIterations: 3,
    policy,
    tools: { maxToolResultChars: 2000, terminalTimeoutMs: 1000, protectedPaths: [] },
    defaultContextWindow: 32768,
    defaultMaxOutputTokens: 4096,
  };
  const runner = new AgentRunner({
    registry: createBuiltinRegistry(),
    workspace,
    provider,
    process: new FakeProcess(),
    approvals,
    web: { fetch },
    capabilities: new MemoryCapabilityStore(),
    logger: nullLogger,
  });
  return {
    workspace,
    fetch,
    abort,
    policy,
    approvals,
    onApproval: (callback: () => boolean) => {
      decision = callback;
    },
    result: () => session.messages.find((m): m is ToolMessage => m.role === 'tool')!,
    run: () =>
      runner.run({
        session,
        providerId: 'p',
        model: { id: 'm' },
        mode,
        settings,
        policy: () => policy,
        grants: { edits: true },
        signal: abort.signal,
        emit: () => {},
      }),
  };
}
