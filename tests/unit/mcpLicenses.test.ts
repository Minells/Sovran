import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { INTEGRATIONS, INTEGRATION_IDS } from '../../src/core/mcp/catalog';
import { integrationLegal, integrationLegalSummary } from '../../src/core/mcp/legal';
import { webviewMessageSchema } from '../../src/shared/protocol';
import { writeMcpPackageNotices } from '../../src/extension/adapters/McpPackageNotices';

describe('MCP licensing disclosures', () => {
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
