function normalizeRequiredText(value, label, maxLength) {
  if (typeof value !== 'string') return { value: '', error: `${label} wajib diisi` };
  const normalized = value.trim();
  if (!normalized) return { value: '', error: `${label} wajib diisi` };
  if (normalized.length > maxLength) return { value: '', error: `${label} terlalu panjang` };
  return { value: normalized, error: '' };
}

function normalizeLineName(value) {
  const result = normalizeRequiredText(value, 'Nama line', 100);
  if (result.error) return result;
  if (/[\\/\0]/.test(result.value) || ['__proto__', 'constructor', 'prototype'].includes(result.value.toLowerCase())) {
    return { value: '', error: 'Nama line tidak valid' };
  }
  return result;
}

function normalizeModelName(value) {
  return normalizeRequiredText(value, 'Nama model', 300);
}

function normalizeLabelWeek(value) {
  return String(value || '')
    .trim()
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, '/')
    .replace(/\/{2,}/g, '/');
}

function normalizeLabelWeekKey(value) {
  return normalizeLabelWeek(value).toLowerCase();
}

function normalizeProductionLabelWeeks(data = {}) {
  Object.values(data.lines || {}).forEach(line => {
    Object.values(line?.models || {}).forEach(model => {
      if (model) model.labelWeek = normalizeLabelWeek(model.labelWeek);
    });
  });
  return data;
}

function parseNonNegativeInteger(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function isBlankInputValue(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function isValidDateInput(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

module.exports = {
  isBlankInputValue,
  isValidDateInput,
  normalizeLabelWeek,
  normalizeLabelWeekKey,
  normalizeLineName,
  normalizeModelName,
  normalizeProductionLabelWeeks,
  normalizeRequiredText,
  parseNonNegativeInteger
};
