// Inspect the actual distributable, not the source tree. No server code/browser binaries may ship accidentally.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

const file = process.argv[2];
assert.ok(file, 'Usage: npm run verify:vsix -- /path/to/sovran.vsix');
const files = unzipSync(readFileSync(file));
const names = Object.keys(files).filter((name) => !name.endsWith('/'));
for (const required of [
  'dist/extension.js',
  'dist/documentWorker.js',
  'dist/webWorker.js',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'package.json',
]) {
  assert.ok(files[`extension/${required}`]?.length, `Missing runtime asset: ${required}`);
}
assert.ok(
  names.some((name) => /^extension\/dist\/webview\/assets\/.*\.js$/.test(name)),
  'Missing webview bundle',
);
for (const name of names) {
  assert.ok(
    !/(?:^|\/)(?:node_modules|tests|src|\.git|\.env|\.npmrc)(?:\/|$)|\.(?:pem|key|map|exe|dmg|zip|vsix)$/i.test(
      name,
    ),
    `Unexpected distributable entry: ${name}`,
  );
  if (name.startsWith('extension/resources/'))
    assert.match(name, /^extension\/resources\/mcp\/(?:playwright|devtools)\/package(?:-lock)?\.json$/);
}
for (const id of ['playwright', 'devtools']) {
  for (const manifest of ['package.json', 'package-lock.json']) {
    const relative = `resources/mcp/${id}/${manifest}`;
    assert.equal(
      strFromU8(files[`extension/${relative}`]),
      readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'),
      `Changed managed manifest: ${relative}`,
    );
  }
}
const manifest = JSON.parse(strFromU8(files['extension/package.json']));
assert.equal(manifest.extensionKind[0], 'workspace');
for (const dependency of ['@playwright/mcp', 'chrome-devtools-mcp', 'crawlee', 'playwright', 'puppeteer'])
  assert.ok(
    !manifest.dependencies[dependency],
    `Unexpected bundled server/browser dependency: ${dependency}`,
  );
console.log(
  `Verified ${names.length} VSIX files: runtime workers, webview, notices and exact managed locks; no server/browser bundle.`,
);
