const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDateReportRows,
  calculateDefectSeverityBreakdown,
  extractHistoryDate,
  filterProductionDataByDate,
  generateModelId,
  generateStyledDateReportExcel,
  hasDateReportAccess,
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

test('date report exposes the same complete production and QC fields for every viewer', () => {
  const data = {
    lines: {
      'Line 1': {
        models: {
          model1: {
            date: '2026-07-21',
            labelWeek: 'W30',
            model: 'Model A',
            target: 100,
            outputDay: 90,
            actualDefect: 2,
            qcChecking: 50,
            defectRatePercentage: 4,
            qcChecks: [
              { result: 'defect', type: 'Open seam', area: 'Body' },
              { result: 'defect', type: 'Loose thread', area: 'Head' }
            ]
          }
        }
      }
    }
  };

  const [row] = buildDateReportRows(data, '2026-07-21');

  assert.deepEqual(
    Object.keys(row),
    ['line', 'modelId', 'labelWeek', 'model', 'date', 'target', 'output', 'achievement', 'defect', 'criticalDefect', 'majorDefect', 'minorDefect', 'qcChecked', 'good', 'defectRate', 'defectAreas', 'defectTypes']
  );
  assert.equal(row.target, 100);
  assert.equal(row.output, 90);
  assert.equal(row.achievement, 90);
  assert.equal(row.qcChecked, 50);
  assert.equal(row.good, 48);
  assert.equal(row.defect, 2);
  assert.equal(row.defectAreas, 'Body (1), Head (1)');
  assert.equal(row.defectTypes, 'Loose thread (1), Open seam (1)');
});

test('Excel summary matches the complete daily report structure', async () => {
  const data = {
    lines: {
      'Line 1': {
        models: {
          model1: {
            date: '2026-07-21',
            labelWeek: 'W30',
            model: 'Model A',
            target: 100,
            outputDay: 90,
            actualDefect: 2,
            qcChecking: 50,
            defectRatePercentage: 4,
            hourly_data: [],
            qcChecks: [
              { result: 'defect', type: 'Open seam', area: 'Body' },
              { result: 'defect', type: 'Loose thread', area: 'Head' }
            ]
          }
        }
      }
    }
  };

  const workbook = await generateStyledDateReportExcel(data, '2026-07-21');
  const summary = workbook.getWorksheet('SUMMARY');

  assert.deepEqual(
    summary.getRow(7).values.slice(1),
    ['Tanggal', 'Line', 'Model ID', 'Label/Week', 'Model', 'Target', 'Output', 'Achievement %', 'QC Checked', 'Good', 'Defect', 'Critical', 'Major', 'Minor', 'Defect Rate %', 'Defect Area', 'Jenis Defect']
  );
  assert.equal(summary.getRow(8).getCell(9).value, 50);
  assert.equal(summary.getRow(8).getCell(10).value, 48);
  assert.equal(summary.getRow(8).getCell(16).value, 'Body (1), Head (1)');
  assert.equal(summary.getRow(8).getCell(17).value, 'Loose thread (1), Open seam (1)');
});

test('date filtering keeps report exports scoped without mutating live data', () => {
  const data = {
    activeLine: 'Line 1',
    lines: {
      'Line 1': {
        models: {
          current: { date: '2026-07-21', outputDay: 10 },
          historical: { date: '2026-07-20', outputDay: 20 }
        }
      }
    }
  };

  const filtered = filterProductionDataByDate(data, '2026-07-21');

  assert.deepEqual(Object.keys(filtered.lines['Line 1'].models), ['current']);
  assert.deepEqual(Object.keys(data.lines['Line 1'].models), ['current', 'historical']);
});

test('report access allows admin roles and rejects operators', () => {
  assert.equal(hasDateReportAccess({ role: 'admin' }), true);
  assert.equal(hasDateReportAccess({ role: 'admin_operator_sewing' }), true);
  assert.equal(hasDateReportAccess({ role: 'admin_operator_qc' }), true);
  assert.equal(hasDateReportAccess({ role: 'operator' }), false);
});
