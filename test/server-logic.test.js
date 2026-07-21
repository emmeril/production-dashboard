const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateDefectSeverityBreakdown,
  extractHistoryDate,
  generateModelId,
  isValidDateInput,
  parseNonNegativeInteger,
  summarizeProductionSnapshotByLine
} = require('../server');

test('generateModelId fills a gap without overwriting a later model', () => {
  const models = { model1: {}, model3: {} };
  assert.equal(generateModelId(models), 'model2');
  assert.ok(models.model3);
});

test('parseNonNegativeInteger preserves zero and rejects invalid production values', () => {
  assert.equal(parseNonNegativeInteger(0, 99), 0);
  assert.equal(parseNonNegativeInteger('12', 0), 12);
  assert.equal(parseNonNegativeInteger(undefined, 7), 7);
  assert.equal(parseNonNegativeInteger(-1, 0), null);
  assert.equal(parseNonNegativeInteger(1.5, 0), null);
});

test('history dates are recognized for canonical and archived backup names', () => {
  assert.equal(extractHistoryDate('data_2026-07-21.json'), '2026-07-21');
  assert.equal(extractHistoryDate('data_2026-07-21_1234_abcd.json'), '2026-07-21');
  assert.equal(extractHistoryDate('backup_pre_reset_2026-07-21_1234.json'), '');
});

test('date input only accepts the API date shape', () => {
  assert.equal(isValidDateInput('2026-07-21'), true);
  assert.equal(isValidDateInput('21-07-2026'), false);
  assert.equal(isValidDateInput(''), false);
});

test('daily line summary separates critical, major, and minor defects', () => {
  const defectConfig = {
    defectTypes: [
      { name: 'Broken needle', severity: 'critical' },
      { name: 'Open seam', severity: 'major' },
      { name: 'Loose thread', severity: 'minor' }
    ]
  };
  const model = {
    date: '2026-07-21',
    target: 100,
    outputDay: 80,
    actualDefect: 3,
    qcChecking: 20,
    qcChecks: [
      { result: 'defect', type: 'Broken needle' },
      { result: 'defect', type: 'Open seam' },
      { result: 'defect', type: 'Loose thread' }
    ]
  };
  const data = {
    lines: {
      'Line 1': {
        activeModels: ['model1'],
        models: { model1: model }
      }
    }
  };

  const [summary] = summarizeProductionSnapshotByLine(data, '2026-07-21', defectConfig);
  const breakdown = calculateDefectSeverityBreakdown(model, defectConfig);

  assert.equal(summary.defect, 3);
  assert.equal(summary.criticalDefect, 1);
  assert.equal(summary.majorDefect, 1);
  assert.equal(summary.minorDefect, 1);
  assert.equal(breakdown.all.count, 3);
});
