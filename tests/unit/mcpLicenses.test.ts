import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { INTEGRATIONS, INTEGRATION_IDS } from '../../src/core/mcp/catalog';
import { integrationLegal, integrationLegalSummary } from '../../src/core/mcp/legal';
import { webviewMessageSchema } from '../../src/shared/protocol';
import { writeMcpPackageNotices } from '../../src/extension/adapters/McpPackageNotices';

describe('MCP licensing disclosures', () => {
  it('accepts LF and Windows CRLF notices while rejecting stale license content', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-mcp-license-check-'));
    try {
      await fs.mkdir(path.join(directory, 'scripts'));
      const script = path.join(directory, 'scripts/mcp-third-party-notices.mjs');
      const source = await fs.readFile(path.resolve('scripts/mcp-third-party-notices.mjs'), 'utf8');
      await fs.writeFile(script, source.replace(/\r?\n/g, '\r\n'));
      for (const id of ['playwright', 'devtools']) {
        const destination = path.join(directory, 'resources/mcp', id);
        await fs.mkdir(destination, { recursive: true });
        await fs.copyFile(
          path.resolve('resources/mcp', id, 'package-lock.json'),
          path.join(destination, 'package-lock.json'),
        );
      }
      const file = path.join(directory, 'MCP_THIRD_PARTY_NOTICES.md');
      const content = (await fs.readFile(path.resolve('MCP_THIRD_PARTY_NOTICES.md'), 'utf8')).replace(
        /\r\n/g,
        '\n',
      );
      const check = () =>
        execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe', timeout: 10000 });
      await fs.writeFile(file, content);
      expect(check).not.toThrow();
      await fs.writeFile(file, content.replace(/\n/g, '\r\n'));
      expect(check).not.toThrow();
      await fs.writeFile(file, content.replace('Apache-2.0', 'CHANGED-LICENSE').replace(/\n/g, '\r\n'));
      expect(check).toThrow(/MCP notices are stale/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('covers each active integration and rejects new Sentry catalog messages', () => {
    expect(INTEGRATION_IDS).not.toContain('sentry');
    for (const item of INTEGRATIONS) {
      const legal = integrationLegal(item.id)!;
      expect(legal.permissions.length).toBeGreaterThan(20);
      for (const url of [legal.source, legal.license?.url, ...legal.terms.map((term) => term.url)].filter(
        Boolean,
      ))
        expect(new URL(url!).protocol).toBe('https:');
      expect(integrationLegalSummary(item.id)).toContain(legal.permissions);
      if (item.package) expect(legal.license?.name).toBe('Apache-2.0');
    }
    for (const type of ['addMcpIntegration', 'installMcpIntegration'])
      expect(
        webviewMessageSchema.safeParse({ type, integration: 'sentry', profile: 'readonly' }).success,
      ).toBe(false);
    expect(integrationLegal('terraform')?.license?.name).toBe('MPL-2.0');
    expect(integrationLegal('context7')?.terms).toHaveLength(2);
  });

  it('inventories locked and embedded dependencies, copies all supplied notices and preserves originals', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-mcp-notices-'));
    try {
      const root = path.join(directory, 'node_modules/server');
      await fs.mkdir(path.join(root, 'build/third_party'), { recursive: true });
      await fs.mkdir(path.join(root, 'licenses'), { recursive: true });
      const files = {
        LICENSE: 'Apache license\r\nCopyright fixture\r\n',
        NOTICE: 'Separate upstream attribution\n',
        'build/third_party/THIRD_PARTY_NOTICES': 'Embedded library MIT license\n',
        'licenses/BSD.txt': 'Additional dependency license\n',
        'build/third_party/bundled-packages.json': '{"embedded-library":"2.0.0"}',
      };
      for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(root, file), text);
      await writeMcpPackageNotices(
        directory,
        JSON.stringify({
          packages: {
            '': {},
            'node_modules/server': {
              version: '1.0.0',
              license: 'Apache-2.0',
              resolved: 'https://registry.npmjs.org/server/-/server-1.0.0.tgz',
              integrity: 'sha512-fixture',
            },
          },
        }),
      );
      const inventory = JSON.parse(
        await fs.readFile(path.join(directory, 'third-party-inventory.json'), 'utf8'),
      );
      expect(inventory.packages).toMatchObject([
        { location: 'node_modules/server', version: '1.0.0', integrity: 'sha512-fixture' },
      ]);
      expect(inventory.bundledInventories[0].packages).toEqual({ 'embedded-library': '2.0.0' });
      expect(inventory.legalFiles).toHaveLength(4);
      const notices = await fs.readFile(path.join(directory, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
      for (const [file, text] of Object.entries(files)) {
        expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(text);
        if (!file.endsWith('.json')) expect(notices).toContain(text);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
