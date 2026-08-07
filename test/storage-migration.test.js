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
      console.log('MIGRATION_RESULT=' + JSON.stringify({ output: snapshot.lines['LINE 1'].models.model1.outputDay }));
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

test('legacy archive snapshots are retained without an archive retention limit', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-dashboard-archive-migration-'));
  const historyDir = path.join(tempDir, 'history');
  const backupDir = path.join(tempDir, 'database-backups');
  const databasePath = path.join(tempDir, 'dashboard.sqlite');
  fs.mkdirSync(historyDir, { recursive: true });

  const archiveFiles = [
    'data_2026-07-19_1000_manual_aaaa1111.json',
    'data_2026-07-20_1000_manual_bbbb2222.json',
    'data_2026-07-21_1000_manual_cccc3333.json'
  ];

  archiveFiles.forEach((filename, index) => {
    const date = filename.slice(5, 15);
    fs.writeFileSync(path.join(historyDir, filename), JSON.stringify({
      lines: {
        'Line 1': {
          models: {
            model1: { id: 'model1', date, outputDay: index + 1 }
          }
        }
      },
      activeLine: 'Line 1'
    }));
  });

  const script = `
    const server = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    (async () => {
      await server.initSequelizeStorage();
      const [rows] = await server.sequelize.query(
        \`SELECT filename FROM production_snapshots WHERE type != 'daily' ORDER BY filename\`
      );
      console.log('ARCHIVE_RESULT=' + JSON.stringify(rows.map(row => row.filename)));
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
    ARCHIVE_SNAPSHOT_RETENTION: '1',
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
    assert.match(
      result.stdout,
      /ARCHIVE_RESULT=\["data_2026-07-19_1000_manual_aaaa1111.json","data_2026-07-20_1000_manual_bbbb2222.json","data_2026-07-21_1000_manual_cccc3333.json"\]/
    );
    archiveFiles.forEach(filename => {
      assert.equal(fs.existsSync(path.join(historyDir, filename)), false);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('missing snapshots are recovered from SQLite backups without replacing active records', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-dashboard-recovery-'));
  const historyDir = path.join(tempDir, 'history');
  const backupDir = path.join(tempDir, 'database-backups');
  const databasePath = path.join(tempDir, 'dashboard.sqlite');
  fs.mkdirSync(historyDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  const olderBackupPath = path.join(backupDir, 'production-dashboard_2026-07-22_manual_1_abcdef12.sqlite');
  const newerBackupPath = path.join(backupDir, 'production-dashboard_2026-07-22_manual_2_abcdef13.sqlite');
  const backupWithoutSnapshotsPath = path.join(backupDir, 'production-dashboard_2026-07-22_manual_3_abcdef14.sqlite');
  const script = `
    const sqlite3 = require('sqlite3');
    const crypto = require('crypto');

    function openDatabase(file) {
      return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(file, error => error ? reject(error) : resolve(database));
      });
    }

    function run(database, sql, params = []) {
      return new Promise((resolve, reject) => {
        database.run(sql, params, error => error ? reject(error) : resolve());
      });
    }

    function close(database) {
      return new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
    }

    function snapshotPayload(date, outputDay) {
      return JSON.stringify({
        lines: {
          'Line 1': {
            models: {
              model1: { id: 'model1', date, outputDay }
            }
          }
        },
        activeLine: 'Line 1'
      });
    }

    async function createSnapshotDatabase(file, rows) {
      const database = await openDatabase(file);
      await run(database, \`CREATE TABLE production_snapshots (
        filename VARCHAR(255) PRIMARY KEY,
        snapshotDate DATE NOT NULL,
        type VARCHAR(255) NOT NULL,
        payload TEXT NOT NULL,
        size INTEGER NOT NULL,
        contentHash VARCHAR(255) NOT NULL,
        createdAt DATETIME NOT NULL,
        updatedAt DATETIME NOT NULL
      )\`);

      for (const row of rows) {
        const payload = snapshotPayload(row.date, row.outputDay);
        await run(database, \`INSERT INTO production_snapshots
          (filename, snapshotDate, type, payload, size, contentHash, createdAt, updatedAt)
          VALUES (?, ?, 'daily', ?, ?, ?, ?, ?)\`, [
          \`data_\${row.date}.json\`,
          row.date,
          payload,
          Buffer.byteLength(payload),
          crypto.createHash('sha256').update(payload).digest('hex'),
          row.updatedAt,
          row.updatedAt
        ]);
      }
      await close(database);
    }

    (async () => {
      await createSnapshotDatabase(${JSON.stringify(databasePath)}, [
        { date: '2026-07-23', outputDay: 10, updatedAt: '2026-07-23 01:00:00 +00:00' }
      ]);
      await createSnapshotDatabase(${JSON.stringify(olderBackupPath)}, [
        { date: '2026-07-22', outputDay: 15, updatedAt: '2026-07-22 01:00:00 +00:00' },
        { date: '2026-07-23', outputDay: 999, updatedAt: '2026-07-23 02:00:00 +00:00' }
      ]);
      await createSnapshotDatabase(${JSON.stringify(newerBackupPath)}, [
        { date: '2026-07-22', outputDay: 20, updatedAt: '2026-07-22 02:00:00 +00:00' }
      ]);
      const emptyBackup = await openDatabase(${JSON.stringify(backupWithoutSnapshotsPath)});
      await close(emptyBackup);

      const server = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
      await server.initSequelizeStorage();
      const recovered = server.readProductionSnapshotForDate('2026-07-22');
      const current = server.readProductionSnapshotForDate('2026-07-23');
      const [rows] = await server.sequelize.query(
        \`SELECT filename FROM production_snapshots WHERE type = 'daily' ORDER BY snapshotDate\`
      );
      const secondRecoveryCount = await server.recoverProductionSnapshotsFromDatabaseBackups();
      console.log('RECOVERY_RESULT=' + JSON.stringify({
        recoveredOutput: recovered.lines['LINE 1'].models.model1.outputDay,
        currentOutput: current.lines['LINE 1'].models.model1.outputDay,
        filenames: rows.map(row => row.filename),
        secondRecoveryCount
      }));
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
    assert.match(result.stdout, /RECOVERY_RESULT={"recoveredOutput":20,"currentOutput":10,"filenames":\["data_2026-07-22.json","data_2026-07-23.json"\],"secondRecoveryCount":0}/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('database backups older than seven days are deleted without touching other files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-dashboard-retention-'));
  const backupDir = path.join(tempDir, 'database-backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const expiredBackup = path.join(backupDir, 'production-dashboard_2026-07-15_manual_1_abcdef12.sqlite');
  const boundaryBackup = path.join(backupDir, 'production-dashboard_2026-07-16_manual_2_abcdef13.sqlite');
  const unrelatedFile = path.join(backupDir, 'keep-me.sqlite');
  fs.writeFileSync(expiredBackup, 'expired');
  fs.writeFileSync(boundaryBackup, 'boundary');
  fs.writeFileSync(unrelatedFile, 'unrelated');
  fs.utimesSync(expiredBackup, new Date('2026-07-15T11:59:59.000Z'), new Date('2026-07-15T11:59:59.000Z'));
  fs.utimesSync(boundaryBackup, new Date('2026-07-16T12:00:00.000Z'), new Date('2026-07-16T12:00:00.000Z'));
  fs.utimesSync(unrelatedFile, new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-01T00:00:00.000Z'));

  const script = `
    const fs = require('fs');
    const server = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    (async () => {
      const deletedCount = await server.pruneDatabaseBackups(new Date('2026-07-23T12:00:00.000Z'));
      console.log('RETENTION_RESULT=' + JSON.stringify({
        deletedCount,
        files: fs.readdirSync(${JSON.stringify(backupDir)}).sort()
      }));
      await server.sequelize.close();
    })().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const childEnv = {
    ...process.env,
    DATABASE_PATH: path.join(tempDir, 'dashboard.sqlite'),
    DATABASE_BACKUP_DIR: backupDir,
    DATABASE_BACKUP_RETENTION_DAYS: '7',
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
    assert.match(
      result.stdout,
      /RETENTION_RESULT={"deletedCount":1,"files":\["keep-me.sqlite","production-dashboard_2026-07-16_manual_2_abcdef13.sqlite"\]}/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('database restore replaces active application data and creates a safety backup', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-dashboard-restore-'));
  const backupDir = path.join(tempDir, 'database-backups');
  const databasePath = path.join(tempDir, 'dashboard.sqlite');
  const restorePath = path.join(backupDir, 'production-dashboard_2026-07-27_manual_1_abcdef12.sqlite');
  fs.mkdirSync(backupDir, { recursive: true });

  const script = `
    const fs = require('fs');
    const server = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    (async () => {
      await server.initSequelizeStorage();
      const restoredPayload = {
        lines: {
          'Restored Line': {
            models: {
              model1: { id: 'model1', date: '2026-07-27', model: 'Restored Model', outputDay: 88 }
            },
            activeModels: ['model1'],
            activeModel: 'model1'
          }
        },
        activeLine: 'Restored Line'
      };
      await server.sequelize.query(
        \`UPDATE app_data SET payload = :payload WHERE key = 'production_data'\`,
        { replacements: { payload: JSON.stringify(restoredPayload) } }
      );
      await server.sequelize.query(\`VACUUM INTO '${restorePath.replace(/\\/g, '/').replace(/'/g, "''")}'\`);

      const currentPayload = { lines: {}, activeLine: '' };
      await server.sequelize.query(
        \`UPDATE app_data SET payload = :payload WHERE key = 'production_data'\`,
        { replacements: { payload: JSON.stringify(currentPayload) } }
      );

      const result = await server.restoreDatabaseBackupFile(${JSON.stringify(restorePath)});
      const restored = server.readProductionData();
      const safetyFiles = fs.readdirSync(${JSON.stringify(backupDir)})
        .filter(filename => filename.includes('_pre_restore_'));
      const invalidBackupPath = ${JSON.stringify(path.join(backupDir, 'invalid.sqlite'))};
      fs.writeFileSync(invalidBackupPath, 'not-a-database');
      let invalidBackupCode = '';
      try {
        await server.validateDatabaseBackupForRestore(invalidBackupPath);
      } catch (error) {
        invalidBackupCode = error.code;
      }
      console.log('DATABASE_RESTORE_RESULT=' + JSON.stringify({
        activeLine: restored.activeLine,
        output: restored.lines['RESTORED LINE'].models.model1.outputDay,
        restoredFrom: result.restoredFrom,
        safetyBackupCreated: safetyFiles.includes(result.safetyBackup),
        appDataCount: result.appDataCount,
        invalidBackupCode
      }));
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
    LEGACY_HISTORY_DIR: path.join(tempDir, 'history'),
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
    assert.match(
      result.stdout,
      /DATABASE_RESTORE_RESULT={"activeLine":"RESTORED LINE","output":88,"restoredFrom":"production-dashboard_2026-07-27_manual_1_abcdef12.sqlite","safetyBackupCreated":true,"appDataCount":8,"invalidBackupCode":"INVALID_DATABASE_BACKUP"}/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
