// npm packages downloaded on explicit user request, separately from the VSIX dependency tree.
import { readFileSync, writeFileSync } from 'node:fs';

const sections = [];
for (const id of ['playwright', 'devtools']) {
  const lock = JSON.parse(
    readFileSync(new URL(`../resources/mcp/${id}/package-lock.json`, import.meta.url), 'utf8'),
  );
  const rows = Object.entries(lock.packages)
    .filter(([location]) => location)
    .map(([location, pkg]) => {
      const name = location.split('node_modules/').at(-1);
      if (!pkg.version || !pkg.license || !pkg.resolved || !pkg.integrity)
        throw new Error(`Missing provenance/license metadata: ${id}/${location}`);
      return `| ${name} | ${pkg.version} | ${pkg.license} |\n\nSource artifact: ${pkg.resolved}\n\nIntegrity: \`${pkg.integrity}\``;
    });
  sections.push(
    `## ${id}\n\n${rows.map((row) => `| Package | Version | Declared license |\n|---|---|---|\n${row}`).join('\n\n')}`,
  );
}
const content = `# Optional MCP Package Notices

Generated from Sovran's locked MCP manifests by \`scripts/mcp-third-party-notices.mjs\`. These servers and their dependencies are **not bundled in the VSIX**. They are downloaded from npm only after the user chooses Install.

The table records declared licenses and immutable artifact provenance. It is not a complete license clearance: dependencies embedded inside a published bundle may have additional notices and licenses absent from npm dependency metadata.

Sovran preserves original legal files. Each new installation also contains \`third-party-inventory.json\` (locked packages, provenance and legal-file paths) and \`THIRD_PARTY_NOTICES.txt\` (the actual LICENSE, COPYING, NOTICE and third-party notices found in the downloaded files, including nested bundled directories). Both are saved in the versioned installation directory under VS Code extension global storage, alongside \`node_modules\`. Existing installations can be explicitly reinstalled to generate these files.

Apache-2.0 permits commercial use and distribution subject to its conditions, including supplying the license and applicable notices. See https://www.apache.org/licenses/LICENSE-2.0. The MIT license for Sovran does not replace these terms. Website/account terms also apply to browser interactions. Chrome itself is installed separately and is not downloaded by this installer.

${sections.join('\n\n')}

## Remote integrations

GitHub, GitLab and Context7 use external services. Grafana, Terraform and OpenSearch use operator-managed MCP endpoints. Sovran does not download or redistribute these servers. Their reference licenses, sources, service terms and required permissions are available in Browse Catalog. Operators remain responsible for their deployment, licenses, authentication, service agreements and data handling. Remote access does not waive those obligations.
`;
const file = new URL('../MCP_THIRD_PARTY_NOTICES.md', import.meta.url);
if (process.argv.includes('--check')) {
  // Git may check out Markdown with CRLF on Windows. Compare content, not checkout line endings.
  if (readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== content)
    throw new Error('MCP notices are stale. Run npm run notices:mcp.');
} else writeFileSync(file, content);
