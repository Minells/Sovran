// Writes the body of a GitHub Release to stdout.
//
//   node scripts/release-notes.mjs <version> <path/to/sovran-<version>.vsix>
//
// The body is the curated announcement in docs/releases/v<version>.md when it exists, else the version's section of
// CHANGELOG.md. Either way it ends with installation steps and the SHA-256 of the exact VSIX attached to the release,
// so a downloaded file can be checked against the page it came from. A version with neither source is an error:
// a release must never go out without notes.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [version, vsix] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !vsix) {
  console.error('Usage: node scripts/release-notes.mjs <major.minor.patch> <path/to/vsix>');
  process.exit(2);
}

const root = new URL('../', import.meta.url);
const repository = 'https://github.com/Minells/sovran';
const curated = new URL(`docs/releases/v${version}.md`, root);

function changelogSection() {
  const lines = readFileSync(new URL('CHANGELOG.md', root), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) =>
    new RegExp(`^## \\[?${version.replaceAll('.', '\\.')}\\]?(?:\\s|$)`).test(line),
  );
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((line) => !/^\[[^\]]+\]: https?:\/\//.test(line)) // link reference definitions belong to the file
    .join('\n')
    .trim();
}

const notes = existsSync(curated) ? readFileSync(curated, 'utf8').trim() : changelogSection();
if (!notes) {
  console.error(
    `No release notes for ${version}: add docs/releases/v${version}.md or a "## [${version}]" CHANGELOG section.`,
  );
  process.exit(1);
}

const file = basename(vsix);
const sha256 = createHash('sha256').update(readFileSync(vsix)).digest('hex');

process.stdout.write(`${notes}

## Install

Download **\`${file}\`** from the assets below, then run:

\`\`\`bash
code --install-extension ${file}
\`\`\`

or choose **Extensions → … → Install from VSIX…** in VS Code 1.95 or later. Check the download first:

\`\`\`bash
sha256sum -c ${file}.sha256          # Linux
shasum -a 256 -c ${file}.sha256      # macOS
\`\`\`

\`\`\`text
SHA-256  ${sha256}
\`\`\`

On Windows, compare the value above with \`Get-FileHash ${file} -Algorithm SHA256\` in PowerShell.

Full changelog: [CHANGELOG.md](${repository}/blob/v${version}/CHANGELOG.md)
`);
