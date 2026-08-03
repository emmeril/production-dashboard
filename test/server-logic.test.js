const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { getUserQcMaxQuantity } = require('../src/features/production/routes');

const {
  app,
  buildPublicModelResponse,
  buildMaterialOrderCumulativeOutputs,
  buildMaterialOrderProductionTotals,
  buildDateReportRows,
  calculateDefectSeverityBreakdown,
  classifyLegacySnapshot,
  extractHistoryDate,
  filterProductionDataByDate,
  filterProductionDataByLine,
  filterMaterialOrderReportRows,
  deriveMaterialOrderProgressStatus,
  generateModelId,
  generateMaterialOrderReportExcel,
  generateStyledDateReportExcel,
  hasDateReportAccess,
  hashPassword,
  isValidDateInput,
  isValidDateRange,
  isModelActiveInManagement,
  isValidProductionSnapshot,
  restoreProductionSnapshot,
  isBlankInputValue,
  applyImportedQcData,
  buildImportedProductionModel,
  buildImportedSewingModel,
  mergeProductionSnapshotsByDate,
  parseQcImportWorkbook,
  parseSewingImportWorkbook,
  parseProductionImportRows,
  parseProductionImportWorkbook,
  parseNonNegativeInteger,
  normalizeLabelWeek,
  normalizeLineName,
  normalizeModelName,
  normalizeUserRecord,
  normalizeProductionLineName,
  normalizeProductionModel,
  resolveActiveDefectCategories,
  productionImportTemplateWorkbook,
  qcImportTemplateWorkbook,
  recalculateModelTotals,
  sewingImportTemplateWorkbook,
  summarizeProductionSnapshot,
  summarizeProductionSnapshotByLine,
  summarizeMaterialOrderReport,
  validateMaterialOrderInput,
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

test('QC quick-entry quantity updates totals, hourly data, and public response', () => {
  const model = {
    hourly_data: [{ hour: '07:00 - 08:00', targetManual: 10, output: 8, qcChecked: 0, defect: 0 }],
    qcChecks: [
      { id: 1, result: 'good', quantity: 5, hourIndex: 0, hour: '07:00 - 08:00' },
      { id: 2, result: 'defect', quantity: 5, hourIndex: 0, hour: '07:00 - 08:00', type: 'Kotor', area: 'Badan' },
      { id: 3, result: 'good', hourIndex: 0, hour: '07:00 - 08:00' }
    ]
  };

  const totals = recalculateModelTotals(model);
  const publicModel = buildPublicModelResponse(model);
  const defectBreakdown = calculateDefectSeverityBreakdown(model, {
    defectTypes: [{ name: 'Kotor', severity: 'minor', active: true }],
    defectAreas: [{ name: 'Badan', active: true }]
  });

  assert.equal(totals.totalQCChecked, 11);
  assert.equal(totals.totalDefect, 5);
  assert.equal(model.hourly_data[0].qcChecked, 11);
  assert.equal(model.hourly_data[0].defect, 5);
  assert.equal(model.defectRatePercentage, 45.45);
  assert.equal(defectBreakdown.all.count, 5);
  assert.equal(defectBreakdown.minor.count, 5);
  assert.deepEqual(Array.from(publicModel.qcChecks, check => check.quantity), [5, 5, 1]);
});

test('dashboard keeps separate Good and Defect quantities within the operator limit', () => {
  const context = { console, Date, Intl, Map, Math, Set, parseInt };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);
  const dashboard = context.dashboard();

  dashboard.currentUser = { role: 'operator', qcMaxQuantity: 3 };
  dashboard.adjustQcQuantity('good', 1);
  dashboard.adjustQcQuantity('good', 1);
  dashboard.adjustQcQuantity('good', 1);
  dashboard.adjustQcQuantity('defect', 1);
  assert.equal(dashboard.qcGoodQuantity, 3);
  assert.equal(dashboard.qcDefectQuantity, 2);
  dashboard.adjustQcQuantity('good', -1);
  assert.equal(dashboard.qcGoodQuantity, 2);
  assert.equal(dashboard.qcDefectQuantity, 2);
  assert.equal(dashboard.qcQuantityLimit(), 3);
});

test('backend returns a distinct maximum QC quantity for each operator', () => {
  assert.equal(getUserQcMaxQuantity({ role: 'operator', qcMaxQuantity: 1 }), 1);
  assert.equal(getUserQcMaxQuantity({ role: 'operator', qcMaxQuantity: 12 }), 12);
  assert.equal(getUserQcMaxQuantity({ role: 'operator' }), 5);
  assert.equal(getUserQcMaxQuantity({ role: 'operator', qcMaxQuantity: 5000 }), 1000);
  assert.equal(getUserQcMaxQuantity({ role: 'admin' }), 1000);
  assert.equal(getUserQcMaxQuantity({ role: 'ppic', qcMaxQuantity: 10 }), 1);
});

test('operator maximum QC quantity defaults to five while preserving custom values', () => {
  assert.equal(normalizeUserRecord({ role: 'operator', quickQcEnabled: true }).qcMaxQuantity, 5);
  assert.equal(normalizeUserRecord({ role: 'operator', quickQcEnabled: false }).qcMaxQuantity, 5);
  assert.equal(normalizeUserRecord({ role: 'operator' }).qcMaxQuantity, 5);
  assert.equal(normalizeUserRecord({ role: 'operator', qcMaxQuantity: 12 }).qcMaxQuantity, 12);
});

test('static middleware does not expose project root files', async t => {
  const server = app.listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;

  const sourceResponse = await fetch(baseUrl + '/server.js');
  const assetResponse = await fetch(baseUrl + '/public/assets/js/alpine.js');
  const dashboardResponse = await fetch(baseUrl + '/');
  const publicDisplayResponse = await fetch(baseUrl + '/public-display');
  const publicDisplayAssetResponse = await fetch(baseUrl + '/public/assets/js/public-display.js');

  assert.equal(sourceResponse.status, 404);
  assert.equal(assetResponse.status, 200);
  assert.equal(dashboardResponse.status, 200);
  assert.match(await dashboardResponse.text(), /\/public\/assets\/js\/alpine\.js/);
  assert.equal(publicDisplayResponse.status, 200);
  assert.match(await publicDisplayResponse.text(), /\/public\/assets\/css\/public-display\.css/);
  assert.equal(publicDisplayAssetResponse.status, 200);
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
  assert.equal(parseNonNegativeInteger('1invalid', 0), null);
});

test('defect selection only resolves active configured categories', () => {
  const config = {
    defectTypes: [
      { name: 'Jahitan lepas', active: true },
      { name: 'Kotor', active: false }
    ],
    defectAreas: [
      { name: 'Badan', active: true },
      { name: 'Kaki', active: false }
    ]
  };

  assert.deepEqual(resolveActiveDefectCategories(' jahitan lepas ', 'badan', config), {
    type: 'Jahitan lepas',
    area: 'Badan',
    isValid: true
  });
  assert.equal(resolveActiveDefectCategories('Kotor', 'Kaki', config).isValid, false);
});

test('blank production output values are distinguishable from an explicit zero', () => {
  assert.equal(isBlankInputValue(undefined), true);
  assert.equal(isBlankInputValue(null), true);
  assert.equal(isBlankInputValue(''), true);
  assert.equal(isBlankInputValue('   '), true);
  assert.equal(isBlankInputValue(0), false);
  assert.equal(isBlankInputValue('0'), false);
});

test('material order input must link to an existing production model', () => {
  const productionData = {
    lines: {
      'Line 1': {
        models: {
          model1: { model: 'Model A', outputDay: 120 }
        }
      },
      'Line 2': {
        models: {
          model2: { model: 'Model B', outputDay: 80 }
        }
      }
    }
  };
  const valid = validateMaterialOrderInput({
    poMaterial: 'PO-MAT-001',
    orderMaterial: 'Kain Cotton',
    qtyOrder: 500,
    productions: [
      { lineName: 'Line 1', modelId: 'model1', status: 'in_production' },
      { lineName: 'Line 2', modelId: 'model2', status: 'completed' }
    ],
    orderDate: '2026-07-26'
  }, productionData);
  const invalid = validateMaterialOrderInput({
    poMaterial: 'PO-MAT-002',
    orderMaterial: 'Benang',
    qtyOrder: 0,
    productions: [
      { lineName: 'Line 1', modelId: 'model99', status: 'running', qtyResult: -1 },
      { lineName: 'Line 1', modelId: 'model99', status: 'planned', qtyResult: 0 }
    ],
    orderDate: '26-07-2026'
  }, productionData);

  assert.deepEqual(valid.errors, []);
  assert.equal(valid.order.productions.length, 2);
  assert.equal(valid.order.qtyResult, 200);
  assert.equal(valid.order.status, 'in_production');
  assert.ok(invalid.errors.some(error => /Qty Order/.test(error)));
  assert.ok(invalid.errors.some(error => /Status produksi/.test(error)));
  assert.ok(invalid.errors.some(error => /tidak ditemukan/.test(error)));
  assert.ok(invalid.errors.some(error => /duplikat/.test(error)));
});

test('material order production totals accumulate daily snapshots and current output', () => {
  const current = {
    lines: {
      'Line 1': { models: { model1: { labelWeek: 'W30', model: 'Model A', outputDay: 5 } } },
      'Line 2': { models: { model7: { labelWeek: 'W30', model: 'Model A', outputDay: 7 } } }
    }
  };
  const history = [
    {
      lines: {
        'Line 1': { models: { old1: { labelWeek: 'W30', model: 'Model A', outputDay: 40 } } },
        'Line 2': { models: { old7: { labelWeek: 'W30', model: 'Model A', outputDay: 60 } } }
      }
    },
    {
      lines: {
        'Line 1': { models: { archived1: { labelWeek: 'W30', model: 'Model A', outputDay: 20 } } }
      }
    }
  ];

  const cumulative = buildMaterialOrderCumulativeOutputs(current, history);
  const totals = buildMaterialOrderProductionTotals(current, cumulative);

  assert.deepEqual(totals, { 'Line 1::model1': 65, 'Line 2::model7': 67 });
});

test('material order status follows quantity progress with three automatic states', () => {
  assert.equal(deriveMaterialOrderProgressStatus(100, 0, []), 'planned');
  assert.equal(deriveMaterialOrderProgressStatus(100, 40, [{ status: 'planned' }]), 'in_production');
  assert.equal(deriveMaterialOrderProgressStatus(100, 40, [{ status: 'paused' }]), 'in_production');
  assert.equal(deriveMaterialOrderProgressStatus(100, 100, [{ status: 'paused' }]), 'completed');
  assert.equal(deriveMaterialOrderProgressStatus(100, 120, []), 'completed');
});

test('material order totals retain production history after label/week and model renames', () => {
  const oldIdentity = 'line 1::EU 2628-1::model lama';
  const current = {
    lines: {
      'Line 1': {
        models: {
          model1: {
            labelWeek: 'W30',
            model: 'Model Baru',
            outputDay: 5,
            materialOrderIdentityAliases: [oldIdentity]
          }
        }
      }
    }
  };
  const history = [{
    lines: {
      'Line 1': { models: { model1: { labelWeek: 'EU/2628-1', model: 'Model Lama', outputDay: 40 } } }
    }
  }];

  const cumulative = buildMaterialOrderCumulativeOutputs(current, history);
  const totals = buildMaterialOrderProductionTotals(current, cumulative);

  assert.equal(totals['Line 1::model1'], 45);
});

test('material order report keeps one PO row with readable per-model results and a PO total', () => {
  const productionData = {
    lines: {
      'Line 1': {
        activeModel: 'model1',
        activeModels: ['model1'],
        models: { model1: { model: 'Model A', labelWeek: 'W30', outputDay: 80 } }
      },
      'Line 2': {
        activeModel: 'model2',
        activeModels: ['model2'],
        models: { model2: { model: 'Model B', labelWeek: 'W31', outputDay: 40 } }
      }
    }
  };
  const orders = [
    {
      id: 1,
      orderDate: '2026-07-25',
      poMaterial: 'PO-1',
      orderMaterial: 'Kain',
      qtyOrder: 100,
      productions: [
        { lineName: 'Line 1', modelId: 'model1', status: 'in_production', qtyResult: 80 },
        { lineName: 'Line 2', modelId: 'model2', status: 'completed', qtyResult: 20 }
      ]
    },
    { id: 2, orderDate: '2026-07-20', poMaterial: 'PO-2', orderMaterial: 'Benang', qtyOrder: 50, qtyResult: 50, lineName: 'Line 2', modelId: 'model2', status: 'completed' }
  ];
  const rows = filterMaterialOrderReportRows(orders, {
    startDate: '2026-07-24',
    endDate: '2026-07-26',
    status: 'completed'
  }, productionData);
  const summary = summarizeMaterialOrderReport(rows);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowId, '1');
  assert.equal(rows[0].currentProductionOutput, 120);
  assert.equal(rows[0].qtyResult, 120);
  assert.equal(rows[0].orderQtyResult, 120);
  assert.equal(rows[0].labelWeek, '1. W30\n2. W31');
  assert.equal(rows[0].modelName, '1. Model A\n2. Model B');
  assert.equal(rows[0].modelResult, '1. 80\n2. 40');
  assert.deepEqual(rows[0].allocations.map(allocation => allocation.qtyResult), [80, 40]);
  assert.equal(rows[0].productionActive, true);
  assert.equal(rows[0].status, 'completed');
  assert.deepEqual(summary, { total: 1, qtyOrder: 100, qtyResult: 120, inProduction: 0, completed: 1 });

  const allRows = filterMaterialOrderReportRows(orders, {
    startDate: '2026-07-24',
    endDate: '2026-07-26'
  }, productionData);
  assert.equal(allRows.length, 1);
  assert.deepEqual(allRows.map(row => row.qtyResult), [120]);
  assert.deepEqual(summarizeMaterialOrderReport(allRows), { total: 1, qtyOrder: 100, qtyResult: 120, inProduction: 0, completed: 1 });

  const selectedPoRows = filterMaterialOrderReportRows(orders, { poMaterial: 'po-1' }, productionData);
  assert.equal(selectedPoRows.length, 1);
  assert.equal(selectedPoRows[0].poMaterial, 'PO-1');
});

test('material order Excel export includes summary and report columns', async () => {
  const rows = [{
    id: 1,
    orderDate: '2026-07-25',
    poMaterial: 'PO-1',
    orderMaterial: 'Kain',
    qtyOrder: 100,
    qtyResult: 80,
    orderQtyResult: 80,
    rowId: '1',
    labelWeek: 'W30',
    modelName: 'Model A',
    productions: [
      { lineName: 'Line 1', modelId: 'model1', labelWeek: 'W30', modelName: 'Model A', qtyResult: 50 },
      { lineName: 'Line 2', modelId: 'model2', labelWeek: 'W31', modelName: 'Model B', qtyResult: 30 }
    ],
    status: 'in_production',
    orderStatus: 'in_production',
    currentProductionOutput: 85,
    notes: 'Prioritas'
  }];
  const summary = summarizeMaterialOrderReport(rows);
  const workbook = await generateMaterialOrderReportExcel(rows, summary, {
    poMaterial: 'PO-1'
  });
  const detail = workbook.getWorksheet('ORDER MATERIAL');
  const allocations = workbook.getWorksheet('DETAIL ALOKASI');

  assert.equal(workbook.getWorksheet('SUMMARY').getCell('A1').value, 'REPORT ORDER MATERIAL');
  assert.equal(workbook.getWorksheet('SUMMARY').getCell('B4').value, 'PO-1');
  assert.equal(detail.getCell('C1').value, 'PO Material');
  assert.equal(detail.getCell('C2').value, 'PO-1');
  assert.equal(detail.getCell('F1').value, 'Total Hasil Produksi');
  assert.equal(detail.getCell('F2').value, 80);
  assert.equal(detail.getCell('H2').value, 0.8);
  assert.equal(detail.getCell('H2').numFmt, '0%');
  assert.equal(detail.rowCount, 2);
  assert.equal(allocations.getCell('B1').value, 'PO Material');
  assert.equal(allocations.getCell('B2').value, 'PO-1');
  assert.equal(allocations.getCell('D1').value, 'Alokasi Produksi');
  assert.equal(allocations.getCell('D2').value, 'Model 1');
  assert.equal(allocations.getCell('D3').value, 'Model 2');
  assert.equal(allocations.getCell('F2').value, 'Model A');
  assert.equal(allocations.getCell('F3').value, 'Model B');
  assert.equal(allocations.getCell('H1').value, 'Hasil Produksi');
  assert.equal(allocations.getCell('H2').value, 50);
  assert.equal(allocations.getCell('H3').value, 30);
  assert.equal(allocations.rowCount, 3);
  assert.equal(detail.getRow(1).values.includes('Line'), false);
  assert.equal(detail.getRow(1).values.includes('Model ID'), false);
});

test('historical production import validates rows before creating a review token', () => {
  const parsed = parseProductionImportRows([
    ['Tanggal', 'Line', 'Label/Week', 'Model', 'Target', 'Output', 'QC Diperiksa', 'Total Defect', 'Defect Critical', 'Defect Major', 'Defect Minor', 'Catatan'],
    ['2026-07-20', 'F1-5A', 'W29', 'Model Lama', 180, 165, 40, 2, '', '', '', 'Catatan manual']
  ], {
    today: '2026-07-26',
    getSnapshot: () => null
  });

  assert.equal(parsed.summary.total, 1);
  assert.equal(parsed.summary.valid, 1);
  assert.equal(parsed.summary.invalid, 0);
  assert.equal(parsed.summary.newRecords, 1);
  assert.equal(parsed.rows[0].minorDefect, 2);
  assert.match(parsed.rows[0].warnings[0], /Minor/);
});

test('label/week uses one canonical separator format', () => {
  assert.equal(normalizeLabelWeek(' EU 2628 - 1 '), 'EU/2628-1');
  assert.equal(normalizeLabelWeek('EU / 2628-1'), 'EU/2628-1');
  assert.equal(normalizeLabelWeek('EU | 2628-1'), 'EU/2628-1');
  assert.equal(normalizeLabelWeek('EU|2628'), 'EU/2628');
  assert.notEqual(normalizeLabelWeek('EU|2628'), normalizeLabelWeek('EU|2628-1'));
  assert.equal(normalizeLabelWeek('ACC/N/W'), 'ACC/N/W');
  assert.equal(normalizeLabelWeek('ACC|N|W'), 'ACC/N/W');
  assert.equal(normalizeLabelWeek('ACC N W'), 'ACC/N/W');
  assert.equal(normalizeLabelWeek('N/L/N/W'), 'N/L/N/W');
  assert.equal(normalizeLabelWeek('N / L / N / W'), 'N/L/N/W');
});

test('line, label/week, and model use uppercase canonical formatting', () => {
  assert.equal(normalizeProductionLineName(' Line-1 '), 'LINE-1');
  assert.equal(normalizeLabelWeek('eu|2628-1'), 'EU/2628-1');
  assert.equal(normalizeProductionModel('Alptall 27 asiatic black bear'), 'ALPTALL 27 ASIATIC BLACK BEAR');
  assert.deepEqual(normalizeLineName(' line-1 '), { value: 'LINE-1', error: '' });
  assert.deepEqual(normalizeModelName(' Model A '), { value: 'MODEL A', error: '' });
});

test('historical production import treats label/week separator variants as duplicates', () => {
  const parsed = parseProductionImportRows([
    ['Tanggal', 'Line', 'Label/Week', 'Model', 'Target', 'Output', 'QC Diperiksa', 'Total Defect'],
    ['2026-07-20', 'Line 1', 'EU/2628-1', 'Model A', 100, 90, 10, 1],
    ['2026-07-20', 'Line 1', 'EU 2628-1', 'Model A', 100, 90, 10, 1]
  ], {
    today: '2026-07-26',
    getSnapshot: () => null
  });

  assert.equal(parsed.summary.invalid, 2);
  assert.equal(parsed.rows[1].labelWeek, 'EU/2628-1');
  assert.ok(parsed.rows.every(row => row.errors.some(error => /terduplikasi/.test(error))));
});

test('historical production import rejects duplicate rows and invalid QC totals', () => {
  const parsed = parseProductionImportRows([
    ['Tanggal', 'Line', 'Model', 'Target', 'Output', 'QC Diperiksa', 'Total Defect'],
    ['2026-07-20', 'Line 1', 'Model A', 100, 90, 2, 3],
    ['2026-07-20', 'Line 1', 'Model A', 100, 90, 10, 1]
  ], {
    today: '2026-07-26',
    getSnapshot: () => null
  });

  assert.equal(parsed.summary.invalid, 2);
  assert.ok(parsed.rows[0].errors.some(error => /tidak boleh lebih besar/.test(error)));
  assert.ok(parsed.rows.every(row => row.errors.some(error => /terduplikasi/.test(error))));
});

test('historical production review marks matching date-line-label-model as replacement', () => {
  const snapshot = {
    lines: {
      'Line 1': {
        activeModels: ['model3'],
        models: {
          model3: { date: '2026-07-20', labelWeek: 'W29', model: 'Model A' }
        }
      }
    }
  };
  const parsed = parseProductionImportRows([
    ['Tanggal', 'Line', 'Label/Week', 'Model', 'Target', 'Output', 'QC Diperiksa', 'Total Defect'],
    ['2026-07-20', 'Line 1', 'W29', 'Model A', 100, 95, 20, 1]
  ], {
    today: '2026-07-26',
    getSnapshot: () => snapshot
  });

  assert.equal(parsed.summary.replacements, 1);
  assert.equal(parsed.rows[0].action, 'replace');
  assert.equal(parsed.rows[0].existingModelId, 'model3');
});

test('historical production model preserves imported daily totals and severity', () => {
  const model = buildImportedProductionModel({
    date: '2026-07-20',
    labelWeek: 'W29',
    model: 'Model A',
    target: 101,
    output: 87,
    qcChecked: 20,
    defect: 6,
    criticalDefect: 1,
    majorDefect: 2,
    minorDefect: 3,
    notes: 'Data manual'
  }, 'model2');
  const breakdown = calculateDefectSeverityBreakdown(model);

  assert.equal(model.hourly_data.reduce((total, hour) => total + hour.targetManual, 0), 101);
  assert.equal(model.hourly_data.reduce((total, hour) => total + hour.output, 0), 87);
  assert.equal(model.hourly_data.reduce((total, hour) => total + hour.qcChecked, 0), 20);
  assert.equal(model.hourly_data.reduce((total, hour) => total + hour.defect, 0), 6);
  assert.equal(breakdown.critical.count, 1);
  assert.equal(breakdown.major.count, 2);
  assert.equal(breakdown.minor.count, 3);
});

test('historical production import accepts report columns and validates defect category totals', () => {
  const parsed = parseProductionImportRows([
    ['Tanggal', 'Line', 'Model ID', 'Label/Week', 'Model', 'Target', 'Output', 'Achievement', 'QC Checked', 'Good', 'Total Defect', 'Critical', 'Major', 'Minor', 'Defect Rate', 'Defect Area', 'Jenis Defect', 'Catatan'],
    ['2026-07-20', 'Line 1', 'model1', 'W29', 'Model A', 100, 90, '90%', 20, 17, 3, 1, 1, 1, '15%', 'Badan (2), Kepala (1)', 'Jahitan Terbuka (2), Kotor (1)', 'Salinan report']
  ], {
    today: '2026-07-26',
    getSnapshot: () => null
  });

  assert.equal(parsed.summary.valid, 1);
  assert.equal(parsed.rows[0].defectAreaSummary, 'Badan (2), Kepala (1)');
  assert.equal(parsed.rows[0].defectTypeSummary, 'Jahitan Terbuka (2), Kotor (1)');

  const invalid = parseProductionImportRows([
    ['Tanggal', 'Line', 'Model', 'Target', 'Output', 'QC Checked', 'Total Defect', 'Defect Area', 'Jenis Defect'],
    ['2026-07-20', 'Line 1', 'Model A', 100, 90, 20, 3, 'Badan (2)', 'Kotor (3)']
  ], {
    today: '2026-07-26',
    getSnapshot: () => null
  });
  assert.ok(invalid.rows[0].errors.some(error => /Defect Area/.test(error)));
});

test('historical production model preserves imported defect area and type summaries', () => {
  const model = buildImportedProductionModel({
    date: '2026-07-20',
    labelWeek: 'W29',
    model: 'Model A',
    target: 100,
    output: 90,
    qcChecked: 20,
    defect: 3,
    criticalDefect: 1,
    majorDefect: 1,
    minorDefect: 1,
    defectAreas: [{ name: 'Badan', quantity: 2 }, { name: 'Kepala', quantity: 1 }],
    defectTypes: [{ name: 'Jahitan Terbuka', quantity: 2 }, { name: 'Kotor', quantity: 1 }],
    notes: 'Data report'
  }, 'model2');
  const report = buildDateReportRows({ lines: { 'Line 1': { models: { model2: model } } } }, '2026-07-20')[0];
  const breakdown = calculateDefectSeverityBreakdown(model);

  assert.equal(report.defectAreas, 'Badan (2), Kepala (1)');
  assert.equal(report.defectTypes, 'Jahitan Terbuka (2), Kotor (1)');
  assert.equal(breakdown.critical.count, 1);
  assert.equal(breakdown.major.count, 1);
  assert.equal(breakdown.minor.count, 1);
});

test('historical production Excel template is readable without phantom data rows', async () => {
  const workbook = productionImportTemplateWorkbook({ sampleRows: [], defectConfig: { defectTypes: [], defectAreas: [] } });
  workbook.getWorksheet('Data Produksi').addRow([
    '2026-07-20', 'Line 1', 'model1', 'W29', 'Model A', 100, 90, '90%', 20, 18, 2,
    0, 1, 1, '10%', 'Badan (1), Kepala (1)', 'Kotor (1), Bentuk tidak sesuai (1)', 'Migrasi'
  ]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await parseProductionImportWorkbook(buffer, {
    today: '2026-07-26',
    getSnapshot: () => null
  });

  assert.equal(parsed.summary.total, 1);
  assert.equal(parsed.rows[0].rowNumber, 2);
  assert.equal(parsed.rows[0].action, 'new');
  assert.equal(workbook.getWorksheet('Contoh Data Riil').getCell('A2').value, 'Belum ada data report historis yang dapat dijadikan contoh.');
  assert.ok(workbook.getWorksheet('Referensi Defect'));
});

test('historical production import preserves calendar dates from Excel date cells', async () => {
  const workbook = productionImportTemplateWorkbook({ sampleRows: [], defectConfig: { defectTypes: [], defectAreas: [] } });
  const sheet = workbook.getWorksheet('Data Produksi');
  sheet.addRow([
    46230, 'Line 1', 'model1', 'W31', 'Model A', 100, 90, '90%', 20, 18, 2,
    0, 1, 1, '10%', '-', '-', 'Tanggal Excel asli'
  ]);
  sheet.getCell('A2').numFmt = 'yyyy-mm-dd';

  const parsed = await parseProductionImportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), {
    today: '2026-07-28',
    getSnapshot: () => null
  });

  assert.equal(parsed.summary.invalid, 0);
  assert.equal(parsed.rows[0].date, '2026-07-27');
});

test('historical production import preserves validated hourly production results', async () => {
  const workbook = productionImportTemplateWorkbook({ sampleRows: [], defectConfig: { defectTypes: [], defectAreas: [] } });
  workbook.getWorksheet('Data Produksi').addRow([
    '2026-07-20', 'Line 1', 'model1', 'W29', 'Model A', 100, 90, '90%', 20, 18, 2,
    0, 1, 1, '10%', 'Badan (1), Kepala (1)', 'Kotor (1), Bentuk tidak sesuai (1)', 'Migrasi'
  ]);
  const hourlyValues = [
    ['07:00 - 08:00', 13, 12, 3, 1],
    ['08:00 - 09:00', 13, 12, 3, 0],
    ['09:00 - 10:00', 13, 12, 3, 0],
    ['10:00 - 11:00', 13, 12, 3, 0],
    ['13:00 - 14:00', 12, 11, 2, 1],
    ['14:00 - 15:00', 12, 11, 2, 0],
    ['15:00 - 16:00', 12, 10, 2, 0],
    ['16:00 - 17:00', 12, 10, 2, 0]
  ];
  hourlyValues.forEach(([hour, target, output, qcChecked, defect]) => {
    workbook.getWorksheet('Detail Per Jam').addRow([
      '2026-07-20', 'Line 1', 'model1', 'W29', 'Model A', hour, target, output,
      output - target, qcChecked, defect, qcChecked - defect, qcChecked ? `${((defect / qcChecked) * 100).toFixed(2)}%` : '0%'
    ]);
  });
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await parseProductionImportWorkbook(buffer, {
    today: '2026-07-26',
    getSnapshot: () => null
  });

  assert.equal(parsed.summary.invalid, 0);
  assert.equal(parsed.rows[0].hourlyData.length, 9);
  assert.equal(parsed.rows[0].hourlyData[0].output, 12);
  assert.equal(parsed.rows[0].hourlyData[4].hour, '11:00 - 13:00');
  const model = buildImportedProductionModel(parsed.rows[0], 'model1');
  assert.deepEqual(model.hourly_data.map(hour => hour.output), [12, 12, 12, 12, 0, 11, 11, 10, 10]);
  assert.equal(model.hourly_data[0].defectDetails.reduce((total, detail) => total + detail.quantity, 0), 1);
  assert.equal(model.hourly_data[5].defectDetails.reduce((total, detail) => total + detail.quantity, 0), 1);
});

test('hourly import rejects incomplete hours and totals that differ from summary', async () => {
  const workbook = productionImportTemplateWorkbook({ sampleRows: [], defectConfig: { defectTypes: [], defectAreas: [] } });
  workbook.getWorksheet('Data Produksi').addRow([
    '2026-07-20', 'Line 1', 'model1', 'W29', 'Model A', 100, 90, '90%', 20, 18, 2,
    0, 1, 1, '10%', '-', '-', 'Migrasi'
  ]);
  workbook.getWorksheet('Detail Per Jam').addRow([
    '2026-07-20', 'Line 1', 'model1', 'W29', 'Model A', '07:00 - 08:00', 10, 10, 0, 2, 0, 2, '0%'
  ]);
  const parsed = await parseProductionImportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), {
    today: '2026-07-26',
    getSnapshot: () => null
  });

  assert.equal(parsed.summary.invalid, 1);
  assert.ok(parsed.rows[0].errors.some(error => /belum lengkap/.test(error)));
});

test('Excel import instructions list the active defect areas from application config', () => {
  const workbook = productionImportTemplateWorkbook({
    sampleRows: [],
    defectConfig: {
      defectTypes: [],
      defectAreas: [
        { id: 1, name: 'Badan', active: true },
        { id: 2, name: 'Kepala', active: true },
        { id: 3, name: 'Area Lama', active: false }
      ]
    }
  });
  const instructions = workbook.getWorksheet('Petunjuk');
  const areaRow = instructions.getRows(1, instructions.rowCount)
    .find(row => row.getCell(1).value === 'Defect Area aktif saat ini');

  assert.equal(areaRow.getCell(2).value, 'Badan, Kepala');
  assert.ok(workbook.getWorksheet('Detail Per Jam'));
  assert.ok(workbook.getWorksheet('Contoh Per Jam Riil'));
});

test('sewing import uses a simple one-row-per-hour template', async () => {
  const workbook = sewingImportTemplateWorkbook({ sampleRows: [] });
  const rows = [
    ['07:00 - 08:00', 10, 9], ['08:00 - 09:00', 10, 9], ['09:00 - 10:00', 10, 9], ['10:00 - 11:00', 10, 9],
    ['13:00 - 14:00', 10, 9], ['14:00 - 15:00', 10, 9], ['15:00 - 16:00', 10, 9], ['16:00 - 17:00', 10, 9]
  ];
  rows.forEach(([hour, target, output]) => workbook.getWorksheet('Data Produksi').addRow([
    46223, 'Line 1', 'W29', 'Model A', hour, target, output, 'Sewing lama'
  ]));
  for (let rowNumber = 2; rowNumber <= 9; rowNumber += 1) {
    workbook.getWorksheet('Data Produksi').getCell(`A${rowNumber}`).numFmt = 'yyyy-mm-dd';
  }
  const parsed = await parseSewingImportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), {
    today: '2026-07-26',
    getSnapshot: () => null
  });

  assert.equal(parsed.summary.valid, 1);
  assert.equal(parsed.rows[0].date, '2026-07-20');
  assert.equal(parsed.rows[0].target, 80);
  assert.equal(parsed.rows[0].output, 72);
  assert.equal(parsed.rows[0].hourlyData.length, 9);
  assert.equal(workbook.getWorksheet('Data Produksi').getCell('E2').dataValidation.formulae[0], "'Referensi Jam'!$A$2:$A$9");

  const model = buildImportedSewingModel(parsed.rows[0], 'model1');
  assert.equal(model.outputDay, 72);
  assert.equal(model.hourly_data[0].output, 9);
  assert.equal(model.qcChecking, 0);
});

test('reimporting Sewing preserves existing QC data', () => {
  const existing = {
    hourly_data: [
      { hour: '07:00 - 08:00', targetManual: 10, output: 8, qcChecked: 5, defect: 1, defectDetails: [{ type: 'Kotor', area: 'Badan', quantity: 1, severity: 'minor' }] },
      { hour: '11:00 - 13:00', targetManual: 0, output: 0, qcChecked: 0, defect: 0, defectDetails: [] }
    ],
    operators: []
  };
  const row = {
    date: '2026-07-20', labelWeek: 'W29', model: 'Model A', target: 20, output: 18,
    hourlyData: [
      { hour: '07:00 - 08:00', targetManual: 20, output: 18 },
      { hour: '11:00 - 13:00', targetManual: 0, output: 0 }
    ]
  };
  const model = buildImportedSewingModel(row, 'model1', existing);

  assert.equal(model.outputDay, 18);
  assert.equal(model.qcChecking, 5);
  assert.equal(model.actualDefect, 1);
  assert.equal(model.hourly_data[0].defectDetails[0].type, 'Kotor');
});

test('QC import uses Good/Defect rows and defect category dropdowns', async () => {
  const sewingModel = buildImportedSewingModel({
    date: '2026-07-20', labelWeek: 'W29', model: 'Model A', target: 80, output: 72,
    hourlyData: [
      { hour: '07:00 - 08:00', targetManual: 10, output: 9, qcChecked: 0, defect: 0 },
      { hour: '08:00 - 09:00', targetManual: 10, output: 9, qcChecked: 0, defect: 0 },
      { hour: '09:00 - 10:00', targetManual: 10, output: 9, qcChecked: 0, defect: 0 },
      { hour: '10:00 - 11:00', targetManual: 10, output: 9, qcChecked: 0, defect: 0 },
      { hour: '11:00 - 13:00', targetManual: 0, output: 0, qcChecked: 0, defect: 0 },
      { hour: '13:00 - 14:00', targetManual: 10, output: 9, qcChecked: 0, defect: 0 },
      { hour: '14:00 - 15:00', targetManual: 10, output: 9, qcChecked: 0, defect: 0 },
      { hour: '15:00 - 16:00', targetManual: 10, output: 9, qcChecked: 0, defect: 0 },
      { hour: '16:00 - 17:00', targetManual: 10, output: 9, qcChecked: 0, defect: 0 }
    ]
  }, 'model1');
  const snapshot = { lines: { 'Line 1': { models: { model1: sewingModel } } } };
  const workbook = qcImportTemplateWorkbook({
    sampleRows: [],
    defectConfig: {
      defectTypes: [{ id: 1, name: 'Kotor', severity: 'minor', active: true }],
      defectAreas: [{ id: 1, name: 'Badan', active: true }]
    }
  });
  const qcSheet = workbook.getWorksheet('Data QC');
  qcSheet.addRow(['2026-07-20', 'Line 1', 'W29', 'Model A', '07:00 - 08:00', 'Good', 7, '', '', '']);
  qcSheet.addRow(['2026-07-20', 'Line 1', 'W29', 'Model A', '07:00 - 08:00', 'Defect', 2, 'Kotor', 'Badan', '']);
  const parsed = await parseQcImportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), {
    today: '2026-07-26',
    defectConfig: {
      defectTypes: [{ id: 1, name: 'Kotor', severity: 'minor', active: true }],
      defectAreas: [{ id: 1, name: 'Badan', active: true }]
    },
    getSnapshot: () => snapshot
  });

  assert.equal(parsed.summary.valid, 1);
  assert.equal(parsed.rows[0].qcChecked, 9);
  assert.equal(parsed.rows[0].defect, 2);
  assert.equal(parsed.rows[0].defectTypeSummary, 'Kotor (2)');
  assert.equal(qcSheet.getCell('F2').dataValidation.formulae[0], '"Good,Defect"');
  assert.match(qcSheet.getCell('H2').dataValidation.formulae[0], /Referensi Defect/);

  applyImportedQcData(sewingModel, parsed.rows[0]);
  assert.equal(sewingModel.outputDay, 72);
  assert.equal(sewingModel.hourly_data[0].qcChecked, 9);
  assert.equal(sewingModel.hourly_data[0].defect, 2);
  assert.equal(sewingModel.qcChecking, 9);
  assert.equal(sewingModel.actualDefect, 2);
});

test('QC import rejects rows when sewing model has not been imported', async () => {
  const workbook = qcImportTemplateWorkbook({ sampleRows: [], defectConfig: { defectTypes: [], defectAreas: [] } });
  workbook.getWorksheet('Data QC').addRow([
    '2026-07-20', 'Line 1', 'W29', 'Model A', '07:00 - 08:00', 'Good', 5, '', '', ''
  ]);
  const parsed = await parseQcImportWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()), {
    today: '2026-07-26',
    defectConfig: { defectTypes: [], defectAreas: [] },
    getSnapshot: () => null
  });
  assert.equal(parsed.summary.invalid, 1);
  assert.ok(parsed.rows[0].errors.some(error => /Input data produksi terlebih dahulu/.test(error)));
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

test('material order model selection synchronizes lines sharing the same label/week and model', () => {
  const context = { console, Date, Intl, Map, Math, Set, parseInt };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  dashboard.linesWithModels = [
    { lineName: 'Line 1', modelId: 'model1', data: { labelWeek: 'EU/2628-1', model: 'Model A', outputDay: 40 } },
    { lineName: 'Line 2', modelId: 'model7', data: { labelWeek: 'EU 2628-1', model: 'Model A', outputDay: 60 } },
    { lineName: 'Line 3', modelId: 'model2', data: { labelWeek: 'W30', model: 'Model B', outputDay: 25 } }
  ];
  dashboard.materialOrderProductionTotals = {
    'LINE 1::model1': 140,
    'LINE 2::model7': 160,
    'LINE 3::model2': 25
  };
  dashboard.materialOrderModal.data = dashboard.emptyMaterialOrderData();
  const groupedModel = dashboard.materialOrderProductionModelOptions().find(option => option.data.model === 'MODEL A');
  dashboard.materialOrderModal.data.productions[0].modelKey = groupedModel.materialOrderKey;

  dashboard.applyMaterialOrderModelSelection(0);

  assert.equal(groupedModel.materialOrderKey, 'eu/2628-1::model a');
  assert.equal(groupedModel.data.labelWeek, 'EU/2628-1');
  assert.equal(dashboard.materialOrderModal.data.productions.length, 1);
  assert.equal(dashboard.materialOrderModal.data.productions[0].lineName, 'LINE 1, LINE 2');
  assert.equal(dashboard.materialOrderModal.data.productions[0].qtyResult, 300);

  dashboard.materialOrderModal.data.productions[0].status = 'in_production';
  const expanded = dashboard.expandMaterialOrderProductions(dashboard.materialOrderModal.data.productions);
  assert.deepEqual(Array.from(expanded, item => item.lineName), ['LINE 1', 'LINE 2']);
  assert.deepEqual(Array.from(expanded, item => item.modelId), ['model1', 'model7']);
  assert.deepEqual(Array.from(expanded, item => item.qtyResult), [140, 160]);
  assert.deepEqual(Array.from(expanded, item => item.status), ['in_production', 'in_production']);
});

test('material order keeps saved model selections visible while rejecting a duplicate replacement', () => {
  const context = { console, Date, Intl, Map, Math, Set, parseInt };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  dashboard.linesWithModels = [
    { lineName: 'Line 1', modelId: 'model1', data: { labelWeek: 'W30', model: 'Model A', outputDay: 10 } },
    { lineName: 'Line 1', modelId: 'model2', data: { labelWeek: 'W31', model: 'Model B', outputDay: 20 } }
  ];
  dashboard.materialOrderModal.data = dashboard.materialOrderFormData({
    productions: [
      { lineName: 'Line 1', modelId: 'model1', qtyResult: 10 },
      { lineName: 'Line 1', modelId: 'model2', qtyResult: 20 }
    ]
  });

  assert.deepEqual(
    Array.from(dashboard.materialOrderModal.data.productions, production => production.modelKey),
    ['w30::model a', 'w31::model b']
  );

  const notifications = [];
  dashboard.showToast = (...args) => notifications.push(args);
  dashboard.materialOrderModal.data.productions[1].modelKey = 'w30::model a';
  dashboard.applyMaterialOrderModelSelection(1);

  assert.equal(dashboard.materialOrderModal.data.productions[1].modelKey, '');
  assert.equal(dashboard.materialOrderModal.data.productions[1].qtyResult, 0);
  assert.match(notifications[0][0], /sudah dipilih/);
});

test('PPIC can view the dashboard and manage material orders, lines, and reports', () => {
  const context = { console, Date, Intl, Map, Math, Set, parseInt };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  dashboard.currentUser = { role: 'ppic' };
  dashboard.setupNavigation();

  assert.equal(dashboard.canViewDashboard(), true);
  assert.equal(dashboard.canViewMaterialOrders(), true);
  assert.equal(dashboard.canManageMaterialOrders(), true);
  assert.equal(dashboard.canManageLines(), true);
  assert.equal(dashboard.hasTargetOnlyLineAccess(), true);
  assert.equal(dashboard.canViewReport(), true);
  assert.equal(dashboard.canViewLineSummary(), false);
  assert.deepEqual(
    Array.from(dashboard.navigation, item => item.page),
    ['dashboard', 'material-orders', 'admin-management', 'report']
  );
});

test('PPIC line edits send only model identity and daily target fields', async () => {
  const requests = [];
  const context = {
    console,
    Date,
    Intl,
    Map,
    Math,
    Set,
    parseInt,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true };
    }
  };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  dashboard.currentUser = { role: 'ppic' };
  dashboard.lineModal = {
    open: true,
    isEdit: true,
    data: {
      lineName: 'LINE 1',
      modelId: 'model1',
      labelWeek: 'W31',
      model: 'MODEL BARU',
      target: 200,
      date: '2026-08-01'
    }
  };
  dashboard.showToast = () => {};
  dashboard.loadLines = async () => {};
  dashboard.loadDashboardData = async () => {};

  await dashboard.saveLine();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/lines/LINE 1');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    lineName: 'LINE 1',
    modelId: 'model1',
    target: 200
  });
});

test('PPIC follows the work schedule while Admin remains exempt', () => {
  const context = { console, Date, Intl, Map, Math, Set, parseInt };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  dashboard.isAuthenticated = true;
  dashboard.workScheduleSettings = { enabled: true, workDays: [], startTime: '08:00', endTime: '17:00' };
  dashboard.currentUser = { role: 'ppic' };
  assert.equal(dashboard.isWorkScheduleLocked(), true);

  dashboard.currentUser = { role: 'admin' };
  assert.equal(dashboard.isWorkScheduleLocked(), false);
});

test('material order report uses PO Material as its only filter', () => {
  const context = { console, Date, Intl, Map, Math, Set, parseInt, URLSearchParams };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  dashboard.materialOrders = [
    { poMaterial: 'PO-100', orderMaterial: 'Kain', status: 'planned', productions: [] },
    { poMaterial: 'PO-200', orderMaterial: 'Benang', status: 'in_production', productions: [] }
  ];
  dashboard.materialOrderPoFilter = 'PO-200';
  dashboard.materialOrderStatusFilter = 'in_production';
  dashboard.materialOrderReport.poMaterial = 'PO-200';

  assert.deepEqual(Array.from(dashboard.materialOrderPoOptions), ['PO-100', 'PO-200']);
  assert.deepEqual(Array.from(dashboard.filteredMaterialOrders, order => order.poMaterial), ['PO-200']);
  const reportParams = dashboard.materialOrderReportParams();
  assert.equal(reportParams.get('poMaterial'), 'PO-200');
  assert.equal([...reportParams.keys()].length, 1);
});

test('material order auto sync refreshes production totals on the active material page', async () => {
  const context = { console, Date, Intl, Map, Math, Set, parseInt };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  const calls = [];
  dashboard.isAuthenticated = true;
  dashboard.currentUser.role = 'admin';
  dashboard.currentPage = 'material-orders';
  dashboard.loadLines = async () => calls.push('lines');
  dashboard.loadMaterialOrders = async options => calls.push(options?.silent ? 'orders-silent' : 'orders');

  await dashboard.syncMaterialOrderData();

  assert.deepEqual(calls, ['lines', 'orders-silent']);
  assert.equal(dashboard.materialOrderSyncing, false);
});

test('material order table groups the same label/week and model across multiple lines', () => {
  const context = { console, Date, Intl, Map, Math, Set, parseInt };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  const groups = dashboard.materialOrderProductionGroups({
    productions: [
      { lineName: 'Line 1', modelId: 'model1', labelWeek: 'EU/2628-1', modelName: 'Model A', qtyResult: 12, productionActive: true },
      { lineName: 'Line 2', modelId: 'model7', labelWeek: 'EU 2628-1', modelName: 'Model A', qtyResult: 8 },
      { lineName: 'Line 4', modelId: 'model3', labelWeek: 'EU / 2628-1', modelName: 'Model A', qtyResult: 10 },
      { lineName: 'Line 5', modelId: 'model8', labelWeek: 'EU/2628 - 1', modelName: 'Model A', qtyResult: 5 },
      { lineName: 'Line 3', modelId: 'model2', labelWeek: 'W31', modelName: 'Model B', qtyResult: 14 }
    ]
  });

  assert.equal(groups.length, 2);
  assert.equal(groups[0].modelName, 'MODEL A');
  assert.equal(groups[0].labelWeek, 'EU/2628-1');
  assert.equal(groups[0].allocationIndex, 1);
  assert.equal(groups[0].qtyResult, 35);
  assert.equal(groups[0].lineNames.length, 4);
  assert.equal(groups[0].productionActive, true);
  assert.equal(groups[1].allocationIndex, 2);
  assert.equal(groups[1].qtyResult, 14);
  assert.equal(dashboard.compactMaterialOrderLines(groups[0].lineNames), 'LINE 1, LINE 2, LINE 4 +1 lainnya');
});

test('opening a material order edit form refreshes models before resolving its selected groups', async () => {
  const context = { console, Date, Intl, Map, Math, Set, parseInt };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  const calls = [];
  dashboard.loadLines = async () => {
    calls.push('lines');
    dashboard.linesWithModels = [
      { lineName: 'Line 1', modelId: 'model2', data: { labelWeek: 'W30', model: 'Model A', outputDay: 10 } }
    ];
  };
  dashboard.loadMaterialOrders = async options => {
    calls.push(options?.silent ? 'orders-silent' : 'orders');
    dashboard.materialOrders = [{
      id: 1,
      productions: [{ lineName: 'Line 1', modelId: 'model2', status: 'planned', qtyResult: 0 }]
    }];
  };

  await dashboard.openMaterialOrderModal({ id: 1 });

  assert.deepEqual(calls, ['lines', 'orders-silent']);
  assert.equal(dashboard.materialOrderModal.data.productions[0].modelKey, 'w30::model a');
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
  assert.equal(isValidProductionSnapshot({ lines: { 'Line 1': { models: { model1: null } } } }), false);
});

test('restored historical JSON remains active after the daily date check', () => {
  const currentData = {
    activeLine: 'Line 1',
    lines: {
      'Line 1': {
        activeModel: 'model1',
        activeModels: ['model1'],
        models: {
          model1: { id: 'model1', date: '2026-07-27', model: 'Current', outputDay: 0 },
          model2: { id: 'model2', date: '2026-07-27', model: 'Keep', outputDay: 5 }
        }
      }
    }
  };
  const backupData = {
    activeLine: 'Line 1',
    lines: {
      'Line 1': {
        activeModel: 'model1',
        activeModels: ['model1'],
        models: {
          model1: { id: 'model1', date: '2026-07-22', model: 'Restored', outputDay: 80 }
        }
      },
      'Line 2': {
        activeModel: 'model1',
        activeModels: ['model1'],
        models: {
          model1: { id: 'model1', date: '2026-07-22', model: 'Added', outputDay: 40 }
        }
      }
    }
  };

  const result = restoreProductionSnapshot(currentData, backupData, '2026-07-27');

  assert.equal(result.data.lines['Line 1'].models.model1.outputDay, 80);
  assert.equal(result.data.lines['Line 1'].models.model1.date, '2026-07-27');
  assert.equal(result.data.lines['Line 1'].models.model2.outputDay, 5);
  assert.equal(result.data.lines['Line 2'].models.model1.date, '2026-07-27');
  assert.equal(result.restoredLines, 1);
  assert.equal(result.restoredModels, 1);
  assert.equal(result.replacedModels, 1);
  assert.equal(result.normalizedDateModels, 2);
  assert.equal(currentData.lines['Line 1'].models.model1.outputDay, 0);
  assert.equal(backupData.lines['Line 1'].models.model1.date, '2026-07-22');
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
    { date: '2026-07-22', lineName: 'Line 1', modelId: 'model1', model: 'Model A', target: 15, output: 10, qcChecked: 8, defect: 1 },
    { date: '2026-07-22', lineName: 'Line 1', modelId: 'model2', model: 'Model B', target: 25, output: 20, qcChecked: 15, defect: 2 },
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
    Array.from(dashboard.allDashboardChartData, item => item.good),
    [7, 13]
  );
  assert.deepEqual(
    Array.from(dashboard.filteredDashboardLines, item => item.modelId),
    ['model1', 'model2']
  );
});

test('backup page creates, downloads, and confirms database restore actions', async () => {
  const fetchCalls = [];
  const downloadLink = {
    href: '',
    download: '',
    clicked: false,
    removed: false,
    click() { this.clicked = true; },
    remove() { this.removed = true; }
  };
  const context = {
    console,
    Date,
    Intl,
    Map,
    Math,
    Set,
    AbortController,
    parseInt,
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, method: options.method || 'GET' });
      if (url === '/api/backup/now') {
        return {
          ok: true,
          json: async () => ({ filename: 'production-dashboard_2026-07-23_manual_3_abcd1236.sqlite' })
        };
      }
      return {
        ok: true,
        json: async () => [{
          filename: 'production-dashboard_2026-07-23_manual_3_abcd1236.sqlite',
          type: 'database',
          storage: 'database'
        }]
      };
    },
    document: {
      createElement: () => downloadLink,
      body: { appendChild() {} }
    }
  };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  dashboard.backupHistory = [
    { filename: 'data_2026-07-22_1.json', date: '2026-07-22', type: 'daily' },
    { filename: 'production-dashboard_2026-07-23_manual_2_abcd1235.sqlite', date: '2026-07-23', type: 'database', storage: 'database' },
    { filename: 'production-dashboard_2026-07-22_manual_1_abcd1234.sqlite', date: '2026-07-22', type: 'database', storage: 'database' }
  ];

  assert.deepEqual(
    Array.from(dashboard.databaseBackupHistory, item => item.filename),
    [
      'production-dashboard_2026-07-23_manual_2_abcd1235.sqlite',
      'production-dashboard_2026-07-22_manual_1_abcd1234.sqlite'
    ]
  );
  assert.equal(dashboard.latestDatabaseBackup.filename, 'production-dashboard_2026-07-23_manual_2_abcd1235.sqlite');

  dashboard.backupHistory = Array.from({ length: 12 }, (_, index) => ({
    filename: `production-dashboard_2026-07-${String(23 - index).padStart(2, '0')}_manual_${index}.sqlite`,
    type: 'database',
    storage: 'database'
  }));
  assert.equal(dashboard.totalDatabaseBackupPages, 2);
  assert.equal(dashboard.paginatedDatabaseBackupHistory.length, 10);
  assert.deepEqual(Array.from(dashboard.databaseBackupPages), [1, 2]);
  dashboard.backupCurrentPage = 2;
  assert.equal(dashboard.paginatedDatabaseBackupHistory.length, 2);
  dashboard.backupItemsPerPage = 5;
  dashboard.backupCurrentPage = 1;
  assert.equal(dashboard.totalDatabaseBackupPages, 3);
  assert.equal(dashboard.paginatedDatabaseBackupHistory.length, 5);

  assert.equal(dashboard.formatFileSize(2048), '2.0 KB');
  assert.equal(
    dashboard.displayBackupFilename('production-dashboard_2026-07-22_manual_1_abcd1234.sqlite'),
    'production-dashboard_2026-07-22_manual_1_abcd1234'
  );

  dashboard.downloadDatabaseBackup('production dashboard.sqlite');
  assert.equal(downloadLink.href, '/api/download-database-backup/production%20dashboard.sqlite');
  assert.equal(downloadLink.download, 'production dashboard.sqlite');
  assert.equal(downloadLink.clicked, true);
  assert.equal(downloadLink.removed, true);

  downloadLink.clicked = false;
  downloadLink.removed = false;
  await dashboard.createBackup();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fetchCalls, [
    { url: '/api/backup/now', method: 'POST' },
    { url: '/api/backup-history', method: 'GET' }
  ]);
  assert.equal(dashboard.backupAction, '');
  assert.equal(dashboard.databaseBackupHistory.length, 1);
  assert.equal(downloadLink.download, 'production-dashboard_2026-07-23_manual_3_abcd1236.sqlite');
  assert.equal(downloadLink.clicked, true);
  assert.equal(downloadLink.removed, true);
  assert.equal(dashboard.toast.type, 'success');

  context.fetch = async () => {
    const error = new Error('Request aborted');
    error.name = 'AbortError';
    throw error;
  };
  await dashboard.createBackup();
  assert.equal(dashboard.backupAction, '');
  assert.equal(dashboard.toast.type, 'error');
  assert.match(dashboard.toast.message, /timeout/i);

  const restoreCalls = [];
  context.fetch = async (url, options = {}) => {
    restoreCalls.push({ url, method: options.method, body: options.body });
    return {
      ok: true,
      json: async () => ({ message: 'Database berhasil dipulihkan' })
    };
  };
  const restoreBackup = {
    filename: 'production-dashboard_2026-07-23_manual_3_abcd1236.sqlite',
    type: 'database',
    storage: 'database'
  };
  dashboard.openDatabaseRestoreModal(restoreBackup);
  assert.equal(dashboard.restoreDatabaseModal.open, true);
  assert.equal(dashboard.restoreDatabaseModal.confirmation, '');
  dashboard.restoreDatabaseModal.confirmation = 'RESTORE';
  await dashboard.restoreDatabaseBackup();
  assert.deepEqual(restoreCalls, [{
    url: '/api/restore-database-backup/production-dashboard_2026-07-23_manual_3_abcd1236.sqlite',
    method: 'POST',
    body: JSON.stringify({ confirmation: 'RESTORE' })
  }]);
  assert.equal(dashboard.backupAction, '');
  assert.equal(dashboard.restoreDatabaseModal.open, false);
  assert.equal(dashboard.toast.type, 'success');
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

test('report line filter combines current and historical line options', () => {
  const context = { console, Date, Intl, Map, Math, Set, parseInt };
  const alpineSource = fs.readFileSync(path.join(__dirname, '..', 'public/assets/js/alpine.js'), 'utf8');
  vm.runInNewContext(alpineSource, context);

  const dashboard = context.dashboard();
  dashboard.lines = [{ name: 'Line 10' }, { name: 'Line 2' }];
  dashboard.dateReport = [{ line: 'Line Lama' }, { line: 'Line 2' }];

  assert.deepEqual(Array.from(dashboard.availableReportLines), ['Line 2', 'Line 10', 'Line Lama']);
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

test('line filtering scopes reports without mutating production data', () => {
  const data = {
    activeLine: 'Line 1',
    lines: {
      'Line 1': { models: { model1: { outputDay: 10 } } },
      'Line 2': { models: { model2: { outputDay: 20 } } }
    }
  };

  const filtered = filterProductionDataByLine(data, 'Line 2');

  assert.deepEqual(Object.keys(filtered.lines), ['Line 2']);
  assert.equal(filtered.activeLine, 'Line 2');
  assert.deepEqual(Object.keys(data.lines), ['Line 1', 'Line 2']);
  assert.deepEqual(Object.keys(filterProductionDataByLine(data, '').lines), ['Line 1', 'Line 2']);
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

test('report access allows admin roles and PPIC while rejecting operators', () => {
  assert.equal(hasDateReportAccess({ role: 'admin' }), true);
  assert.equal(hasDateReportAccess({ role: 'admin_operator_sewing' }), true);
  assert.equal(hasDateReportAccess({ role: 'admin_operator_qc' }), true);
  assert.equal(hasDateReportAccess({ role: 'ppic' }), true);
  assert.equal(hasDateReportAccess({ role: 'operator' }), false);
});
