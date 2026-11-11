import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { FsSessionRepository } from '../../src/extension/adapters/FsSessionRepository';
import type { Session } from '../../src/core/sessions/model';
import { normalizeExcludedGroups } from '../../src/core/tools/groups';
import { webviewMessageSchema } from '../../src/shared/protocol';

it('round-trips per-chat exclusions, keeps old sessions compatible and bounds malformed stored groups', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sovran-groups-'));
  try {
    const repo = new FsSessionRepository(dir);
    const session: Session = {
      id: 's',
      title: 'Groups',
      createdAt: 0,
      updatedAt: 0,
      mode: 'act',
      messages: [],
      excludedToolGroups: ['git', 'mcp:browser'],
    };
    await repo.save(session);
    expect((await new FsSessionRepository(dir).load('s'))?.excludedToolGroups).toEqual([
      'git',
      'mcp:browser',
    ]);
    delete session.excludedToolGroups;
    await repo.save(session);
    expect((await repo.load('s'))?.excludedToolGroups).toBeUndefined();
    expect(normalizeExcludedGroups(['git', 'git', null, {}, 'mcp:../x', 'mcp:browser'])).toEqual([
      'git',
      'mcp:browser',
    ]);
    expect(
      webviewMessageSchema.safeParse({
        type: 'setToolGroup',
        sessionId: 's',
        group: 'mcp:../x',
        selected: false,
      }).success,
    ).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
