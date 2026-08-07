const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-dashboard-routes-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(tempDir, 'dashboard.sqlite');
process.env.DATABASE_BACKUP_DIR = path.join(tempDir, 'database-backups');
process.env.LEGACY_HISTORY_DIR = path.join(tempDir, 'history');
process.env.SESSION_SECRET = 'route-test-session-secret';
process.env.SESSION_COOKIE_SECURE = 'false';
process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS = '2';
process.env.LOGIN_RATE_LIMIT_WINDOW_MS = '60000';

const {
  app,
  getToday,
  hashPassword,
  initSequelizeStorage,
  productionImportTemplateWorkbook,
  readProductionData,
  sequelize,
  sessionStore,
  updateTodayBackup,
  writeProductionData,
  writeUsersData,
  writeWorkScheduleSettings
} = require('../server');

let httpServer;
let baseUrl;

function listen() {
  return new Promise(resolve => {
    httpServer = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
      resolve();
    });
  });
}

function closeHttpServer() {
  if (!httpServer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    httpServer.close(error => error ? reject(error) : resolve());
  });
}

function closeSessionStore() {
  return new Promise((resolve, reject) => {
    sessionStore.close(error => error ? reject(error) : resolve());
  });
}

async function login(username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const setCookie = response.headers.get('set-cookie') || '';
  return { response, cookie: setCookie.split(';')[0] };
}

test.before(async () => {
  await initSequelizeStorage();
  await writeUsersData({
    users: [
      {
        id: 1,
        username: 'admin',
        password: hashPassword('admin-password'),
        name: 'Administrator',
        line: 'all',
        role: 'admin',
        sessionVersion: 1
      },
      {
        id: 2,
        username: 'ppic',
        password: hashPassword('ppic-password'),
        name: 'PPIC User',
        line: 'all',
        role: 'ppic',
        sessionVersion: 1
      },
      {
        id: 3,
        username: 'qc-admin',
        password: hashPassword('qc-password'),
        name: 'QC Administrator',
        line: 'all',
        role: 'admin_operator_qc',
        sessionVersion: 1
      }
    ]
  });

  const today = getToday();
  await writeProductionData({
    activeLine: 'Line 1',
    lines: {
      'Line 1': {
        activeModel: 'model1',
        activeModels: ['model1'],
        models: {
          model1: {
            id: 'model1',
            labelWeek: 'W30',
            model: 'Model A',
            date: today,
            target: 80,
            targetPerHour: 10,
            outputDay: 8,
            qcChecking: 1,
            actualDefect: 0,
            defectRatePercentage: 0,
            hourly_data: [{
              hour: '07:00 - 08:00',
              targetManual: 10,
              output: 8,
              qcChecked: 1,
              defect: 0,
              selisih: -2
            }],
            operators: []
          }
        }
      }
    }
  });
  await writeWorkScheduleSettings({ enabled: false });
  updateTodayBackup();
  await listen();
});

test.after(async () => {
  await closeHttpServer();
  await closeSessionStore();
  await sequelize.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('PPIC can load production models required by material orders', async () => {
  const { response: loginResponse, cookie } = await login('ppic', 'ppic-password');
  assert.equal(loginResponse.status, 200);
  assert.ok(cookie);

  const response = await fetch(`${baseUrl}/api/lines`, { headers: { Cookie: cookie } });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data['LINE 1'].models.model1.model, 'MODEL A');
});

test('responses include baseline security headers without exposing Express', async () => {
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.match(html, /\/public\/assets\/css\/tailwind\.css/);
  assert.match(html, /\/public\/assets\/css\/fonts\.css/);
  assert.match(html, /\/public\/assets\/js\/vendor\/alpine\.min\.js/);
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/);
});

test('branding settings are public to read but only admin can update them', async () => {
  const publicResponse = await fetch(`${baseUrl}/api/branding-settings`);
  const defaults = await publicResponse.json();
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get('cache-control'), 'no-store');
  assert.equal(defaults.appName, 'Production Dashboard');

  const { cookie: ppicCookie } = await login('ppic', 'ppic-password');
  const forbiddenResponse = await fetch(`${baseUrl}/api/branding-settings`, {
    method: 'PUT',
    headers: { Cookie: ppicCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appName: 'Tidak Diizinkan', copyrightText: 'Tidak Diizinkan' })
  });
  assert.equal(forbiddenResponse.status, 403);

  const { cookie: adminCookie } = await login('admin', 'admin-password');
  const updateResponse = await fetch(`${baseUrl}/api/branding-settings`, {
    method: 'PUT',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ appName: '  Dashboard Pabrik  ', copyrightText: '  Copyright 2026 Pabrik  ' })
  });
  const updateResult = await updateResponse.json();
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(updateResult.settings, {
    appName: 'Dashboard Pabrik',
    copyrightText: 'Copyright 2026 Pabrik'
  });

  const savedResponse = await fetch(`${baseUrl}/api/branding-settings`);
  assert.deepEqual(await savedResponse.json(), updateResult.settings);
});

test('layout-critical browser assets are served locally', async () => {
  const assetPaths = [
    '/public/assets/css/tailwind.css',
    '/public/assets/css/fonts.css',
    '/public/assets/css/fontawesome.min.css',
    '/public/assets/js/vendor/alpine.min.js',
    '/public/assets/js/vendor/chart.umd.min.js',
    '/public/assets/webfonts/fa-solid-900.woff2',
    '/public/assets/fonts/dm-sans-latin-400-normal.woff2'
  ];

  const responses = await Promise.all(assetPaths.map(assetPath => fetch(`${baseUrl}${assetPath}`)));
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    assert.equal(response.status, 200, `${assetPaths[index]} tidak tersedia`);
    assert.ok((await response.arrayBuffer()).byteLength > 1000, `${assetPaths[index]} tidak lengkap`);
  }

  const publicDisplayResponse = await fetch(`${baseUrl}/public-display`);
  const publicDisplayHtml = await publicDisplayResponse.text();
  assert.match(publicDisplayHtml, /\/public\/assets\/js\/public-display-legacy\.js/);
  assert.doesNotMatch(publicDisplayHtml, /cdn\.jsdelivr\.net|fonts\.googleapis\.com/);
  assert.doesNotMatch(publicDisplayHtml, /alpine\.min\.js|x-data|x-show|x-if/);

  const modernDisplayResponse = await fetch(`${baseUrl}/public-display-modern`);
  const modernDisplayHtml = await modernDisplayResponse.text();
  assert.equal(modernDisplayResponse.status, 200);
  assert.match(modernDisplayHtml, /\/public\/assets\/js\/vendor\/alpine\.min\.js/);
});

test('admin operator QC can publish marked product photos to selected public display lines', async () => {
  const { cookie: ppicCookie } = await login('ppic', 'ppic-password');
  const forbiddenResponse = await fetch(`${baseUrl}/api/qc-product-evaluations`, {
    headers: { Cookie: ppicCookie }
  });
  assert.equal(forbiddenResponse.status, 403);

  const { cookie: qcCookie } = await login('qc-admin', 'qc-password');
  const createResponse = await fetch(`${baseUrl}/api/qc-product-evaluations`, {
    method: 'POST',
    headers: { Cookie: qcCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Evaluasi Body Depan',
      modelId: 'model1',
      modelLine: 'LINE 1',
      productName: 'Model A',
      targetMode: 'selected',
      lines: ['line 1', 'Line Tidak Ada'],
      active: true,
      photoDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      markers: [{
        id: 'point-1',
        x: 42.12345,
        y: 67.98765,
        label: 'Broken Stitch',
        area: 'Body Depan',
        severity: 'major',
        notes: 'Periksa tension benang'
      }]
    })
  });
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201);
  assert.deepEqual(created.evaluation.lines, ['LINE 1']);
  assert.equal(created.evaluation.productName, 'MODEL A');
  assert.equal(created.evaluation.markers[0].x, 42.123);

  const matchingResponse = await fetch(`${baseUrl}/api/public/qc-product-evaluations?line=LINE%201`);
  const matching = await matchingResponse.json();
  assert.equal(matchingResponse.status, 200);
  assert.equal(matchingResponse.headers.get('cache-control'), 'no-store');
  assert.equal(matching.evaluations.length, 1);
  assert.equal(matching.evaluations[0].title, 'Evaluasi Body Depan');

  const otherLineResponse = await fetch(`${baseUrl}/api/public/qc-product-evaluations?line=LINE%202`);
  assert.deepEqual(await otherLineResponse.json(), { evaluations: [] });

  const invalidResponse = await fetch(`${baseUrl}/api/qc-product-evaluations`, {
    method: 'POST',
    headers: { Cookie: qcCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Tanpa titik',
      modelId: 'model1',
      modelLine: 'LINE 1',
      targetMode: 'all',
      photoDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      markers: []
    })
  });
  assert.equal(invalidResponse.status, 400);
  assert.match((await invalidResponse.json()).error, /minimal satu titik/i);
});

test('PPIC can manage lines with the same target-only edit restriction as Admin Operator Sewing', async () => {
  const lineName = 'LINE PPIC TEST';
  const { response: ppicLoginResponse, cookie: ppicCookie } = await login('ppic', 'ppic-password');
  const { response: adminLoginResponse, cookie: adminCookie } = await login('admin', 'admin-password');
  assert.equal(ppicLoginResponse.status, 200);
  assert.equal(adminLoginResponse.status, 200);
  assert.ok(ppicCookie);
  assert.ok(adminCookie);

  try {
    const createLineResponse = await fetch(`${baseUrl}/api/lines`, {
      method: 'POST',
      headers: { Cookie: ppicCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineName,
        labelWeek: 'W31',
        model: 'Model PPIC A',
        target: 160,
        date: getToday()
      })
    });
    assert.equal(createLineResponse.status, 200);

    const addModelResponse = await fetch(`${baseUrl}/api/lines/${encodeURIComponent(lineName)}/models`, {
      method: 'POST',
      headers: { Cookie: ppicCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        labelWeek: 'W32',
        model: 'Model PPIC B',
        target: 180,
        date: getToday()
      })
    });
    const addedModel = await addModelResponse.json();
    assert.equal(addModelResponse.status, 200);
    assert.equal(addedModel.modelId, 'model2');

    const updateTargetResponse = await fetch(`${baseUrl}/api/lines/${encodeURIComponent(lineName)}`, {
      method: 'PUT',
      headers: { Cookie: ppicCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineName, modelId: 'model1', target: 200 })
    });
    const updatedModel = await updateTargetResponse.json();
    assert.equal(updateTargetResponse.status, 200);
    assert.equal(updatedModel.data.target, 200);

    const updateIdentityResponse = await fetch(`${baseUrl}/api/lines/${encodeURIComponent(lineName)}`, {
      method: 'PUT',
      headers: { Cookie: ppicCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineName, modelId: 'model1', labelWeek: 'W99', target: 200 })
    });
    const updateIdentityError = await updateIdentityResponse.json();
    assert.equal(updateIdentityResponse.status, 403);
    assert.match(updateIdentityError.error, /hanya dapat mengubah Target Harian/);

    const activateModelResponse = await fetch(
      `${baseUrl}/api/lines/${encodeURIComponent(lineName)}/active-model`,
      {
        method: 'POST',
        headers: { Cookie: ppicCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'model2' })
      }
    );
    const activeModels = await activateModelResponse.json();
    assert.equal(activateModelResponse.status, 200);
    assert.deepEqual(activeModels.activeModels, ['model1', 'model2']);

    const deleteModelResponse = await fetch(
      `${baseUrl}/api/lines/${encodeURIComponent(lineName)}/models/model2`,
      { method: 'DELETE', headers: { Cookie: ppicCookie } }
    );
    assert.equal(deleteModelResponse.status, 403);
  } finally {
    await fetch(`${baseUrl}/api/lines/${encodeURIComponent(lineName)}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie }
    });
  }
});

test('material report filters by PO Material only and exports without a PO filter', async () => {
  const { cookie } = await login('ppic', 'ppic-password');
  const reportResponse = await fetch(
    `${baseUrl}/api/material-orders/report?poMaterial=PO-ROUTE-TEST`,
    { headers: { Cookie: cookie } }
  );
  const report = await reportResponse.json();

  assert.equal(reportResponse.status, 200);
  assert.deepEqual(report.filters, {
    poMaterial: 'PO-ROUTE-TEST'
  });
  assert.ok(Array.isArray(report.rows));

  const exportResponse = await fetch(`${baseUrl}/api/material-orders/report/export`, {
    headers: { Cookie: cookie }
  });
  const pdf = Buffer.from(await exportResponse.arrayBuffer());

  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('content-type') || '', /application\/pdf/);
  assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4');
  assert.ok(pdf.byteLength > 1000);
  assert.match(pdf.toString('binary'), /Dashboard Pabrik/);
  assert.match(pdf.toString('binary'), /Copyright 2026 Pabrik/);
});

test('single-date report export returns a PDF document', async () => {
  const { cookie } = await login('ppic', 'ppic-password');
  const response = await fetch(`${baseUrl}/api/export-date-report/${getToday()}`, {
    headers: { Cookie: cookie }
  });
  const pdf = Buffer.from(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/pdf/);
  assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4');
  assert.ok(pdf.byteLength > 1000);
  assert.match(pdf.toString('binary'), /Dashboard Pabrik/);
  assert.match(pdf.toString('binary'), /Copyright 2026 Pabrik/);

  const detailResponse = await fetch(`${baseUrl}/api/export-date-report/${getToday()}/LINE%201/model1`, {
    headers: { Cookie: cookie }
  });
  const detailPdf = Buffer.from(await detailResponse.arrayBuffer());
  assert.equal(detailResponse.status, 200);
  assert.match(detailPdf.toString('binary'), /Dashboard Pabrik/);
  assert.match(detailPdf.toString('binary'), /Copyright 2026 Pabrik/);
});

test('historical Excel import completes preview, confirmation, and date report flow', async () => {
  const { cookie } = await login('admin', 'admin-password');
  const importDate = '2024-01-15';
  const workbook = productionImportTemplateWorkbook({
    sampleRows: [],
    defectConfig: { defectTypes: [], defectAreas: [] }
  });
  workbook.getWorksheet('Data Produksi').addRow([
    importDate,
    'Line Import',
    'model-old',
    'W03',
    'Model Historis',
    100,
    90,
    '90%',
    20,
    18,
    2,
    0,
    1,
    1,
    '10%',
    '-',
    '-',
    'Integration test'
  ]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const previewResponse = await fetch(`${baseUrl}/api/production-import/preview`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'X-File-Name': 'historical-import.xlsx'
    },
    body: buffer
  });
  const preview = await previewResponse.json();

  assert.equal(previewResponse.status, 200);
  assert.equal(preview.canImport, true);
  assert.equal(preview.summary.invalid, 0);
  assert.ok(preview.token);

  const confirmResponse = await fetch(`${baseUrl}/api/production-import/confirm`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: preview.token })
  });
  const confirmation = await confirmResponse.json();

  assert.equal(confirmResponse.status, 200);
  assert.equal(confirmation.created, 1);
  assert.equal(confirmation.dates, 1);

  const reportResponse = await fetch(`${baseUrl}/api/date-report/${importDate}`, {
    headers: { Cookie: cookie }
  });
  const report = await reportResponse.json();

  assert.equal(reportResponse.status, 200);
  assert.equal(report.length, 1);
  assert.equal(report[0].date, importDate);
  assert.equal(report[0].line, 'LINE IMPORT');
  assert.equal(report[0].model, 'MODEL HISTORIS');
  assert.equal(report[0].output, 90);
});

test('admin can organize legacy backups without an internal server error', async () => {
  const { cookie } = await login('admin', 'admin-password');
  const response = await fetch(`${baseUrl}/api/organize-backups`, {
    method: 'POST',
    headers: { Cookie: cookie }
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.movedCount, 0);
  assert.equal(result.recoveredCount, 0);
  assert.equal(result.backupDir, process.env.DATABASE_BACKUP_DIR);
});

test('line and model creation reject blank names', async () => {
  const { cookie } = await login('admin', 'admin-password');
  const blankLineResponse = await fetch(`${baseUrl}/api/lines`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lineName: '  ', model: 'Model B', target: 80, date: getToday() })
  });
  const blankModelResponse = await fetch(`${baseUrl}/api/lines/Line%201/models`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: '', target: 80, date: getToday() })
  });

  assert.equal(blankLineResponse.status, 400);
  assert.equal(blankModelResponse.status, 400);
});

test('admin can assign a maximum QC quantity to an operator', async () => {
  const { cookie } = await login('admin', 'admin-password');
  const createResponse = await fetch(`${baseUrl}/api/users`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'quick-qc-operator',
      password: 'operator-password',
      name: 'Quick QC Operator',
      line: 'LINE 1',
      role: 'operator',
      qcMaxQuantity: 12
    })
  });
  const created = await createResponse.json();

  assert.equal(createResponse.status, 200);
  assert.equal(created.user.line, 'LINE 1');
  assert.equal(created.user.qcMaxQuantity, 12);

  const { response: operatorLoginResponse } = await login('quick-qc-operator', 'operator-password');
  const operatorLogin = await operatorLoginResponse.json();
  assert.equal(operatorLoginResponse.status, 200);
  assert.equal(operatorLogin.user.qcMaxQuantity, 12);
});

test('admin QC action records an arbitrary quantity batch', async () => {
  const { cookie } = await login('admin', 'admin-password');
  const response = await fetch(`${baseUrl}/api/qc-check/LINE%201/model1`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: 'good', quantity: 7, hourIndex: 0 })
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.qcCheck.quantity, 7);
  assert.equal(result.summary.totalQCChecked, 7);
  assert.equal(result.data.hourly_data[0].qcChecked, 7);
});

test('production update endpoints reject QC fields without changing QC state', async () => {
  const { cookie } = await login('admin', 'admin-password');
  const before = readProductionData().lines['LINE 1'].models.model1.hourly_data[0];
  const endpoints = [
    '/api/update-hourly/LINE%201',
    '/api/update-hourly-direct/LINE%201',
    '/api/update-hourly/LINE%201/model1',
    '/api/update-hourly-direct/LINE%201/model1'
  ];

  for (const endpoint of endpoints) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hourIndex: 0,
        output: 99,
        targetManual: 10,
        defect: 99,
        qcChecked: 99,
        defectDetails: [{ type: 'Invalid bypass', quantity: 99 }]
      })
    });
    const result = await response.json();

    assert.equal(response.status, 400);
    assert.match(result.error, /endpoint QC khusus/i);
  }

  const after = readProductionData().lines['LINE 1'].models.model1.hourly_data[0];
  assert.equal(after.output, before.output);
  assert.equal(after.defect, before.defect);
  assert.equal(after.qcChecked, before.qcChecked);
  assert.deepEqual(after.defectDetails, before.defectDetails);
});

test('linked material-order models and lines cannot be hard deleted', async () => {
  const { cookie } = await login('admin', 'admin-password');
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };

  const createLineResponse = await fetch(`${baseUrl}/api/lines`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      lineName: 'Line Protected',
      labelWeek: 'W40',
      model: 'Model Utama',
      target: 80,
      date: getToday()
    })
  });
  assert.equal(createLineResponse.status, 200);

  const createModelResponse = await fetch(`${baseUrl}/api/lines/LINE%20PROTECTED/models`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      labelWeek: 'W40',
      model: 'Model Tertaut',
      target: 80,
      date: getToday()
    })
  });
  const createdModel = await createModelResponse.json();
  assert.equal(createModelResponse.status, 200);

  const createOrderResponse = await fetch(`${baseUrl}/api/material-orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      poMaterial: 'PO-PROTECTED-DELETE',
      orderMaterial: 'Material History',
      qtyOrder: 100,
      orderDate: getToday(),
      productions: [{
        lineName: 'LINE PROTECTED',
        modelId: createdModel.modelId,
        status: 'planned'
      }]
    })
  });
  assert.equal(createOrderResponse.status, 201);

  const deleteModelResponse = await fetch(
    `${baseUrl}/api/lines/LINE%20PROTECTED/models/${createdModel.modelId}`,
    { method: 'DELETE', headers: { Cookie: cookie } }
  );
  const deleteModelResult = await deleteModelResponse.json();
  assert.equal(deleteModelResponse.status, 409);
  assert.match(deleteModelResult.error, /Order Material.*PO-PROTECTED-DELETE/i);

  const deleteLineResponse = await fetch(`${baseUrl}/api/lines/LINE%20PROTECTED`, {
    method: 'DELETE',
    headers: { Cookie: cookie }
  });
  const deleteLineResult = await deleteLineResponse.json();
  assert.equal(deleteLineResponse.status, 409);
  assert.match(deleteLineResult.error, /Order Material.*PO-PROTECTED-DELETE/i);
});

test('login endpoint throttles repeated invalid attempts', async () => {
  const first = await login('throttled-user', 'wrong-password');
  const second = await login('throttled-user', 'wrong-password');
  const third = await login('throttled-user', 'wrong-password');

  assert.equal(first.response.status, 401);
  assert.equal(second.response.status, 401);
  assert.equal(third.response.status, 429);
  assert.ok(Number(third.response.headers.get('retry-after')) >= 1);
});

test('SQLite sessions survive reopening the HTTP server and session store', async () => {
  const { cookie } = await login('ppic', 'ppic-password');
  await closeHttpServer();
  await closeSessionStore();
  await listen();

  const response = await fetch(`${baseUrl}/api/current-user`, { headers: { Cookie: cookie } });
  const user = await response.json();

  assert.equal(response.status, 200);
  assert.equal(user.username, 'ppic');
});
