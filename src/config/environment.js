const fs = require('fs');
const path = require('path');

function loadLocalEnvironment(projectRoot) {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return;

  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) return;

    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[match[1]] = value;
  });
}

function parseBooleanEnvironment(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseTrustProxySetting(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  if (['true', 'yes', 'on'].includes(normalized.toLowerCase())) return 1;
  return normalized;
}

module.exports = {
  loadLocalEnvironment,
  parseBooleanEnvironment,
  parseTrustProxySetting
};
