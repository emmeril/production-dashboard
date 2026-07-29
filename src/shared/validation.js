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
  return { value: normalizeProductionLineName(result.value), error: '' };
}

function normalizeModelName(value) {
  const result = normalizeRequiredText(value, 'Nama model', 300);
  if (result.error) return result;
  return { value: normalizeProductionModel(result.value), error: '' };
}

function normalizeProductionLineName(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeProductionModel(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeLabelWeek(value) {
  return String(value || '')
    .trim()
    .replace(/\s*\|\s*/g, '/')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, '/')
    .replace(/\/{2,}/g, '/')
    .toUpperCase();
}

function normalizeLabelWeekKey(value) {
  return normalizeLabelWeek(value).toLowerCase();
}

function normalizeProductionDataIdentities(data = {}) {
  const normalizedLines = {};
  Object.entries(data.lines || {}).forEach(([lineName, line]) => {
    const normalizedLineName = normalizeProductionLineName(lineName);
    Object.values(line?.models || {}).forEach(model => {
      if (!model) return;
      model.labelWeek = normalizeLabelWeek(model.labelWeek);
      model.model = normalizeProductionModel(model.model);
    });
    if (!normalizedLines[normalizedLineName]) {
      normalizedLines[normalizedLineName] = line;
      return;
    }

    const existing = normalizedLines[normalizedLineName];
    existing.models = { ...(line?.models || {}), ...(existing.models || {}) };
    existing.activeModels = [...new Set([
      ...(existing.activeModels || []),
      ...(line?.activeModels || [])
    ])];
    existing.activeModel = existing.activeModel || line?.activeModel || existing.activeModels[0] || null;
  });
  data.lines = normalizedLines;
  data.activeLine = normalizeProductionLineName(data.activeLine);
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
  normalizeProductionDataIdentities,
  normalizeProductionLineName,
  normalizeProductionModel,
  normalizeRequiredText,
  parseNonNegativeInteger
};
