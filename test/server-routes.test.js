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
process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS = '2';
process.env.LOGIN_RATE_LIMIT_WINDOW_MS = '60000';

const {
  app,
  getToday,
  hashPassword,
  initSequelizeStorage,
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
  assert.equal(data['Line 1'].models.model1.model, 'Model A');
});

test('single-date Excel export returns a workbook', async () => {
  const { cookie } = await login('ppic', 'ppic-password');
  const response = await fetch(`${baseUrl}/api/export-date-report/${getToday()}`, {
    headers: { Cookie: cookie }
  });
  const workbook = await response.arrayBuffer();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /spreadsheetml/);
  assert.ok(workbook.byteLength > 1000);
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
