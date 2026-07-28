const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function collectJavaScriptFiles(target) {
  const absoluteTarget = path.resolve(target);
  const stats = fs.statSync(absoluteTarget);
  if (stats.isFile()) return absoluteTarget.endsWith('.js') ? [absoluteTarget] : [];

  return fs.readdirSync(absoluteTarget, { withFileTypes: true })
    .flatMap(entry => collectJavaScriptFiles(path.join(absoluteTarget, entry.name)));
}

const files = process.argv.slice(2).flatMap(collectJavaScriptFiles).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Syntax check passed: ${files.length} JavaScript files`);
