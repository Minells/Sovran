const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');

const [, , role] = process.argv;
if (role === 'parent') {
  spawn(process.execPath, [__filename, 'descendant'], { stdio: 'inherit' });
  process.exit(0);
}

if (role === 'descendant') {
  process.stdout.write('ready');
  setTimeout(() => writeFileSync('descendant-finished', 'bad'), 1000);
}
