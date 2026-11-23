import { followsSnapshot, type FileSnapshot } from './checkpoints';
import { redact } from '../security/redact';
import type { TaskChange } from '../sessions/task';
import { makeDiff, truncateMiddle } from '../tools/edits';

/** A bounded historical diff for the transcript. Raw file contents remain in the existing checkpoint service. */
export class TaskChanges {
  private readonly baseline: ReadonlyMap<string, FileSnapshot>;
  private readonly current = new Map<string, { patch?: TaskChange; replaces: boolean }>();

  constructor(
    private readonly previous: readonly TaskChange[],
    snapshots: readonly FileSnapshot[],
    private readonly preserveExternalEdits: boolean,
  ) {
    this.baseline = new Map(snapshots.map((file) => [file.absolutePath, file]));
  }

  record(
    file: FileSnapshot,
    after: string,
    shown: string,
    protectedFile: boolean,
    secrets: readonly (string | undefined)[],
  ): TaskChange[] {
    const earlier = this.baseline.get(file.absolutePath);
    const replaces = !!earlier && (!this.preserveExternalEdits || followsSnapshot(earlier, file));
    const before = replaces ? earlier.before : file.before;
    const path = redact(shown, secrets);
    const delta = before !== after ? makeDiff(path, before, after) : undefined;
    const patch = delta
      ? {
          ...delta,
          path,
          diff: protectedFile ? '' : truncateMiddle(redact(delta.diff, secrets), 12_000),
        }
      : undefined;
    this.current.set(path, { patch, replaces });
    const changes = [...this.previous];
    for (const [changedPath, change] of this.current) {
      const index = change.replaces ? changes.findLastIndex((p) => p.path === changedPath) : -1;
      if (index >= 0) changes.splice(index, 1);
      if (change.patch) changes.push(change.patch);
    }
    return changes;
  }
}
