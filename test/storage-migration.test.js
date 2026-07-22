const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('legacy history is migrated into SQLite before JSON files are removed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-dashboard-migration-'));
  const historyDir = path.join(tempDir, 'history');
  const backupDir = path.join(tempDir, 'database-backups');
  const databasePath = path.join(tempDir, 'dashboard.sqlite');
  fs.mkdirSync(historyDir, { recursive: true });

  const legacyFile = path.join(historyDir, 'data_2026-07-21.json');
  fs.writeFileSync(legacyFile, JSON.stringify({
    lines: {
      'Line 1': {
        models: {
          model1: { id: 'model1', date: '2026-07-21', outputDay: 10 }
        }
      }
    },
    activeLine: 'Line 1'
  }));

  const script = `
    const server = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    (async () => {
      await server.initSequelizeStorage();
      const snapshot = server.readProductionSnapshotForDate('2026-07-21');
      console.log('MIGRATION_RESULT=' + JSON.stringify({ output: snapshot.lines['Line 1'].models.model1.outputDay }));
      await server.sequelize.close();
    })().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const childEnv = {
    ...process.env,
    DATABASE_PATH: databasePath,
    DATABASE_BACKUP_DIR: backupDir,
    LEGACY_HISTORY_DIR: historyDir,
    SESSION_SECRET: 'test-secret'
  };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_CHANNEL_FD;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: childEnv,
    encoding: 'utf8'
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /MIGRATION_RESULT={"output":10}/);
    assert.equal(fs.existsSync(legacyFile), false);
    assert.equal(
      fs.readdirSync(backupDir).filter(filename => filename.endsWith('.sqlite')).length,
      1
    );
    assert.equal(fs.existsSync(databasePath), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
