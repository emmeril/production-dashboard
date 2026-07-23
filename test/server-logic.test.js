const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const {
  app,
  buildPublicModelResponse,
  buildDateReportRows,
  calculateDefectSeverityBreakdown,
  classifyLegacySnapshot,
  extractHistoryDate,
  filterProductionDataByDate,
  generateModelId,
  generateStyledDateReportExcel,
  hasDateReportAccess,
  hashPassword,
  isValidDateInput,
  isValidDateRange,
  isModelActiveInManagement,
  isValidProductionSnapshot,
  isBlankInputValue,
  mergeProductionSnapshotsByDate,
  parseNonNegativeInteger,
  summarizeProductionSnapshot,
  summarizeProductionSnapshotByLine,
  verifyPassword
} = require('../server');

test('password hashing uses bcrypt while accepting legacy SHA-256 hashes', () => {
  const hash = hashPassword('secret-password');
  assert.match(hash, /^\$2[aby]\$/);
  assert.equal(verifyPassword('secret-password', hash), true);
  assert.equal(verifyPassword('wrong-password', hash), false);

  const legacyHash = crypto.createHash('sha256').update('legacy-password').digest('hex');
  assert.equal(verifyPassword('legacy-password', legacyHash), true);
});

test('public model response omits internal user and lock fields', () => {
  const publicModel = buildPublicModelResponse({
    id: 'model1',
    labelWeek: 'W30',
    model: 'Model A',
    date: '2026-07-23',
    target: 100,
    outputDay: 80,
    actualDefect: 1,
    qcChecking: 20,
    defectRatePercentage: 5,
    productionLockedBy: 'operator1',
    notes: 'internal note',
    hourly_data: [{
      hour: '07:00 - 08:00',
      targetManual: 10,
      output: 8,
      defect: 1,
      qcChecked: 5,
      productionLockedBy: 'operator1',
      defectDetails: [{ type: 'Open seam', area: 'Body', quantity: 1, notes: 'internal detail' }]
    }],
    qcChecks: [{
      id: 1,
      result: 'defect',
      type: 'Open seam',
      area: 'Body',
      notes: 'operator note',
      checkedAt: '2026-07-23T01:00:00.000Z'
    }],
    operators: [{ id: 1, name: 'Operator Name', position: 'Sewing', target: 10, output: 8, defect: 1, efficiency: 80, status: 'active' }]
  });

  assert.equal(publicModel.productionLockedBy, undefined);
  assert.equal(publicModel.notes, undefined);
  assert.equal(publicModel.hourly_data[0].productionLockedBy, undefined);
  assert.equal(publicModel.hourly_data[0].defectDetails[0].notes, undefined);
  assert.equal(publicModel.qcChecks[0].notes, undefined);
  assert.equal(publicModel.qcChecks[0].checkedAt, undefined);
  assert.equal(publicModel.operators[0].name, undefined);
});

test('static middleware does not expose project root files', async t => {
  const server = app.listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;

  const sourceResponse = await fetch(baseUrl + '/server.js');
  const assetResponse = await fetch(baseUrl + '/public/assets/js/alpine.js');

  assert.equal(sourceResponse.status, 404);
  assert.equal(assetResponse.status, 200);
});

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

test('blank production output values are distinguishable from an explicit zero', () => {
  assert.equal(isBlankInputValue(undefined), true);
  assert.equal(isBlankInputValue(null), true);
  assert.equal(isBlankInputValue(''), true);
  assert.equal(isBlankInputValue('   '), true);
  assert.equal(isBlankInputValue(0), false);
  assert.equal(isBlankInputValue('0'), false);
});

test('operator production form keeps an unsaved zero output visibly empty', () => {
  const context = { console, Date, Intl, Map, Math, Set, parseInt };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  dashboard.currentUser.role = 'operator';
  dashboard.inputForm.hourIndex = 0;
  dashboard.lineDetail.hourly_data = [{ output: 0, targetManual: 25, productionLocked: false }];

  dashboard.syncInputFormFromSelectedHour();
  assert.equal(dashboard.inputForm.output, '');
  assert.equal(dashboard.isProductionOutputBlank(), true);

  dashboard.lineDetail.hourly_data[0].productionLocked = true;
  dashboard.syncInputFormFromSelectedHour();
  assert.equal(dashboard.inputForm.output, 0);
  assert.equal(dashboard.isProductionOutputBlank(), false);
});

test('history dates are recognized for canonical and archived backup names', () => {
  assert.equal(extractHistoryDate('data_2026-07-21.json'), '2026-07-21');
  assert.equal(extractHistoryDate('data_2026-07-21_1234_abcd.json'), '2026-07-21');
  assert.equal(extractHistoryDate('backup_pre_reset_2026-07-21_1234.json'), '');
});

test('legacy JSON backups are classified before database migration', () => {
  assert.deepEqual(classifyLegacySnapshot('data_2026-07-21.json'), { date: '2026-07-21', type: 'daily' });
  assert.deepEqual(classifyLegacySnapshot('data_2026-07-21_1234_abcd.json'), { date: '2026-07-21', type: 'archive' });
  assert.deepEqual(classifyLegacySnapshot('data_2026-07-21_1234_pre_restore_abcd.json'), { date: '2026-07-21', type: 'pre_restore' });
  assert.deepEqual(classifyLegacySnapshot('backup_pre_reset_2026-07-21_1234.json'), { date: '2026-07-21', type: 'pre_reset' });
  assert.equal(classifyLegacySnapshot('unrelated.json'), null);
});

test('date input only accepts the API date shape', () => {
  assert.equal(isValidDateInput('2026-07-21'), true);
  assert.equal(isValidDateInput('21-07-2026'), false);
  assert.equal(isValidDateInput(''), false);
});

test('date range requires two valid dates in chronological order', () => {
  assert.equal(isValidDateRange('2026-07-20', '2026-07-22'), true);
  assert.equal(isValidDateRange('2026-07-22', '2026-07-22'), true);
  assert.equal(isValidDateRange('2026-07-23', '2026-07-22'), false);
  assert.equal(isValidDateRange('20-07-2026', '2026-07-22'), false);
});

test('production snapshot validation rejects malformed restore payloads', () => {
  assert.equal(isValidProductionSnapshot({ lines: {} }), true);
  assert.equal(isValidProductionSnapshot({ lines: { 'Line 1': { models: {} } } }), true);
  assert.equal(isValidProductionSnapshot(null), false);
  assert.equal(isValidProductionSnapshot({}), false);
  assert.equal(isValidProductionSnapshot({ lines: [] }), false);
  assert.equal(isValidProductionSnapshot({ lines: { 'Line 1': { models: [] } } }), false);
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

test('daily line summary includes every active management-line model only', () => {
  const data = {
    lines: {
      'Line 1': {
        activeModels: ['model1', 'model2'],
        models: {
          model1: { date: '2026-07-21', model: 'Model A', outputDay: 10 },
          model2: { date: '2026-07-21', model: 'Model B', outputDay: 20 },
          model3: { date: '2026-07-21', model: 'Model C', outputDay: 30 }
        }
      }
    }
  };

  const summaries = summarizeProductionSnapshotByLine(data, '2026-07-21');

  assert.deepEqual(summaries.map(summary => summary.modelId), ['model1', 'model2']);
  assert.deepEqual(summaries.map(summary => summary.model), ['Model A', 'Model B']);
  assert.equal(summaries.reduce((total, summary) => total + summary.output, 0), 30);
});

test('dashboard summary totals only models marked active in Management Line', () => {
  const data = {
    lines: {
      'Line 1': {
        activeModels: ['model1', 'model2'],
        models: {
          model1: { date: '2026-07-21', target: 100, outputDay: 80, actualDefect: 2, qcChecking: 40 },
          model2: { date: '2026-07-21', target: 120, outputDay: 110, actualDefect: 1, qcChecking: 50 },
          model3: { date: '2026-07-21', target: 999, outputDay: 999, actualDefect: 99, qcChecking: 99 }
        }
      }
    }
  };

  const summary = summarizeProductionSnapshot(data, '2026-07-21');

  assert.equal(summary.modelCount, 2);
  assert.equal(summary.lineCount, 1);
  assert.equal(summary.target, 220);
  assert.equal(summary.output, 190);
  assert.equal(summary.defect, 3);
  assert.equal(summary.qcChecked, 90);
});

test('operator model guard recognizes only models active in Management Line', () => {
  const data = {
    lines: {
      'Line 1': {
        activeModels: ['model1', 'model2'],
        models: { model1: {}, model2: {}, model3: {} }
      }
    }
  };

  assert.equal(isModelActiveInManagement(data, 'Line 1', 'model1'), true);
  assert.equal(isModelActiveInManagement(data, 'Line 1', 'model2'), true);
  assert.equal(isModelActiveInManagement(data, 'Line 1', 'model3'), false);
  assert.equal(isModelActiveInManagement(data, 'Line 2', 'model1'), false);
});

test('dashboard chart includes only models active in Management Line', () => {
  const context = { console, Date, Intl, Map, Math, Set, parseInt };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  dashboard.linesWithModels = [
    { lineName: 'Line 1', modelId: 'model1', data: { lineActiveModels: ['model1', 'model2'], labelWeek: '', model: 'Model A', target: 15, outputDay: 10 } },
    { lineName: 'Line 1', modelId: 'model2', data: { lineActiveModels: ['model1', 'model2'], labelWeek: '', model: 'Model B', target: 25, outputDay: 20 } },
    { lineName: 'Line 1', modelId: 'model3', data: { lineActiveModels: ['model1', 'model2'], labelWeek: '', model: 'Model C', target: 35, outputDay: 30 } }
  ];
  dashboard.dashboardData.lineDaily = [
    { date: '2026-07-22', lineName: 'Line 1', modelId: 'model1', model: 'Model A', target: 15, output: 10 },
    { date: '2026-07-22', lineName: 'Line 1', modelId: 'model2', model: 'Model B', target: 25, output: 20 },
    { date: '2026-07-22', lineName: 'Line 1', modelId: 'model3', model: 'Model C', target: 35, output: 30 }
  ];

  assert.deepEqual(
    Array.from(dashboard.allDashboardChartData, item => item.modelId),
    ['model1', 'model2']
  );
  assert.equal(dashboard.selectedDashboardSummary.modelCount, 2);
  assert.equal(dashboard.selectedDashboardSummary.target, 40);
  assert.equal(dashboard.selectedDashboardSummary.output, 30);
  assert.deepEqual(
    Array.from(dashboard.filteredDashboardLines, item => item.modelId),
    ['model1', 'model2']
  );
});

test('maintenance backup history supports type filtering and pagination', () => {
  const context = { console, Date, Intl, Map, Math, Set, parseInt };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  dashboard.backupsPerPage = 1;
  dashboard.backupHistory = [
    { filename: 'data_2026-07-22_1.json', date: '2026-07-22', type: 'daily' },
    { filename: 'data_2026-07-22_2_pre_restore_a.json', date: '2026-07-22', type: 'pre_restore' },
    { filename: 'production-dashboard_2026-07-22_manual_1_abcd1234.sqlite', date: '2026-07-22', type: 'database' }
  ];
  dashboard.backupTypeFilter = 'pre_restore';

  assert.deepEqual(Array.from(dashboard.filteredBackupHistory, item => item.type), ['pre_restore']);
  assert.equal(dashboard.totalBackupPages, 1);
  assert.equal(dashboard.paginatedBackupHistory[0].filename, 'data_2026-07-22_2_pre_restore_a.json');
  assert.equal(dashboard.formatFileSize(2048), '2.0 KB');
  assert.equal(dashboard.backupTypeLabel('database'), 'Backup SQLite');
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
    ['Tanggal', 'Line', 'Model ID', 'Label/Week', 'Model', 'Target', 'Output', 'Achievement', 'QC Checked', 'Good', 'Total Defect', 'Critical', 'Major', 'Minor', 'Defect Rate', 'Defect Area', 'Jenis Defect']
  );
  assert.equal(summary.getCell('A1').value, 'LAPORAN PRODUKSI DAN QC - 2026-07-21');
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

test('date range merge keeps models with the same ID on different dates', () => {
  const snapshots = [
    {
      date: '2026-07-20',
      data: {
        lines: {
          'Line 1': {
            models: { model1: { date: '2026-07-20', outputDay: 10 } }
          }
        }
      }
    },
    {
      date: '2026-07-21',
      data: {
        lines: {
          'Line 1': {
            models: { model1: { date: '2026-07-21', outputDay: 20 } }
          }
        }
      }
    }
  ];

  const merged = mergeProductionSnapshotsByDate(snapshots);
  const models = Object.values(merged.lines['Line 1'].models);

  assert.equal(models.length, 2);
  assert.deepEqual(models.map(model => model.date), ['2026-07-20', '2026-07-21']);
  assert.deepEqual(models.map(model => model.reportModelId), ['model1', 'model1']);
});

test('Excel range export keeps duplicate daily model IDs as separate rows', async () => {
  const merged = mergeProductionSnapshotsByDate([
    {
      date: '2026-07-20',
      data: { lines: { 'Line 1': { models: { model1: { date: '2026-07-20', model: 'Model A', outputDay: 10 } } } } }
    },
    {
      date: '2026-07-21',
      data: { lines: { 'Line 1': { models: { model1: { date: '2026-07-21', model: 'Model A', outputDay: 20 } } } } }
    }
  ]);

  const workbook = await generateStyledDateReportExcel(merged, '2026-07-20 s.d. 2026-07-21');
  const summary = workbook.getWorksheet('SUMMARY');

  assert.equal(summary.getRow(8).getCell(1).value, '2026-07-20');
  assert.equal(summary.getRow(9).getCell(1).value, '2026-07-21');
  assert.equal(summary.getRow(8).getCell(3).value, 'model1');
  assert.equal(summary.getRow(9).getCell(3).value, 'model1');
});

test('report access allows admin roles and rejects operators', () => {
  assert.equal(hasDateReportAccess({ role: 'admin' }), true);
  assert.equal(hasDateReportAccess({ role: 'admin_operator_sewing' }), true);
  assert.equal(hasDateReportAccess({ role: 'admin_operator_qc' }), true);
  assert.equal(hasDateReportAccess({ role: 'operator' }), false);
});
