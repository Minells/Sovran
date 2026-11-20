import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Capture the locked dependency inventory and the legal files actually supplied by npm, without executing code. */
export async function writeMcpPackageNotices(directory: string, lockText: string): Promise<void> {
  const lock = JSON.parse(lockText) as {
    packages: Record<string, { version?: string; license?: string; resolved?: string; integrity?: string }>;
  };
  const packages = Object.entries(lock.packages)
    .filter(([location]) => location !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([location, info]) => ({ location, ...info }));
  const notices: { file: string; text: string }[] = [];
  const bundledInventories: { file: string; packages: unknown }[] = [];
  const legalName =
    /^(?:licen[sc]e|notice|copying)(?:$|[._-])|^third[._-]?party[._-]?(?:notices|licenses)|\.LEGAL\.txt$/i;
  async function walk(folder: string, legalFolder = false): Promise<void> {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      // Never follow links outside the installation (including executable shims in .bin).
      if (entry.isDirectory()) await walk(file, legalFolder || /^(licen[sc]es?|notices?)$/i.test(entry.name));
      else if (entry.isFile() && (legalFolder || legalName.test(entry.name)))
        notices.push({
          file: path.relative(directory, file).split(path.sep).join('/'),
          text: await fs.readFile(file, 'utf8'),
        });
      else if (entry.isFile() && entry.name === 'bundled-packages.json')
        bundledInventories.push({
          file: path.relative(directory, file).split(path.sep).join('/'),
          packages: JSON.parse(await fs.readFile(file, 'utf8')),
        });
    }
  }
  await walk(path.join(directory, 'node_modules'));
  const inventory = {
    description:
      'Locked npm packages and legal files shipped in this installation. Bundled dependencies may appear only in the supplied legal files; this inventory is not a legal clearance.',
    packages,
    bundledInventories,
    legalFiles: notices.map(({ file }) => file),
  };
  await fs.writeFile(
    path.join(directory, 'third-party-inventory.json'),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(directory, 'THIRD_PARTY_NOTICES.txt'),
    [
      inventory.description,
      'Original license and NOTICE files remain in node_modules at the paths below.',
      ...notices.map(({ file, text }) => `\n===== ${file} =====\n${text}`),
      notices.length
        ? ''
        : 'No legal files were found in the downloaded artifact. Consult the upstream license before redistribution.',
    ].join('\n'),
  );
}
