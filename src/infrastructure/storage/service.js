function createStorageService(dependencies) {
  const {
    DataTypes,
    buildInitialDefectConfig,
    buildInitialMaterialOrders,
    buildInitialProductionData,
    buildInitialPublicDisplaySettings,
    buildInitialUsersData,
    buildInitialWorkScheduleSettings,
    crypto,
    databaseBackupDir,
    databasePath,
    extractHistoryDate,
    fs,
    getToday,
    hashPassword,
    isSafeBackupFilename,
    isValidDateInput,
    isValidProductionSnapshot,
    legacyDefaultPasswordHashes,
    legacyHistoryDir,
    logger,
    normalizeDefectConfig,
    normalizeMaterialOrders,
    normalizeProductionDataIdentities,
    normalizePublicDisplaySettings,
    normalizeUserRecord,
    normalizeWorkScheduleSettings,
    path,
    projectRoot,
    readBootstrapCredentials,
    sequelize,
    sqlite3,
    zlib
  } = dependencies;

  const AppData = sequelize.define('AppData', {
    key: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    payload: {
      type: DataTypes.TEXT('long'),
      allowNull: false
    }
  }, {
    tableName: 'app_data',
    timestamps: true
  });
  const ProductionSnapshot = sequelize.define('ProductionSnapshot', {
    filename: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    snapshotDate: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false
    },
    payload: {
      type: DataTypes.TEXT('long'),
      allowNull: false
    },
    size: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    contentHash: {
      type: DataTypes.STRING,
      allowNull: false
    }
  }, {
    tableName: 'production_snapshots',
    timestamps: true
  });

  const PRODUCTION_DATA_KEY = 'production_data';
  const USERS_DATA_KEY = 'users_data';
  const DEFECT_CONFIG_KEY = 'defect_config';
  const PUBLIC_DISPLAY_SETTINGS_KEY = 'public_display_settings';
  const WORK_SCHEDULE_SETTINGS_KEY = 'work_schedule_settings';
  const MATERIAL_ORDERS_KEY = 'material_orders';
  const DATABASE_BACKUP_RETENTION_DAYS = Math.max(
    1,
    Number(process.env.DATABASE_BACKUP_RETENTION_DAYS || process.env.DATABASE_BACKUP_RETENTION) || 7
  );
  const DATABASE_BACKUP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
  let productionDataCache = { lines: {}, activeLine: '' };
  let usersDataCache = { users: [] };
  let defectConfigCache = { defectTypes: [], defectAreas: [] };
  let publicDisplaySettingsCache = {};
  let workScheduleSettingsCache = {};
  let materialOrdersCache = { orders: [] };
  const productionSnapshotCache = new Map();
  let databaseInitialized = false;
  const appDataWriteQueues = new Map();
  let snapshotWriteQueue = Promise.resolve();
  let snapshotWriteFailure = null;
  let databaseBackupCleanupRunning = false;
  let databaseRestoreInProgress = false;
  const LEGACY_DEFAULT_PASSWORD_HASHES_BY_USERNAME = legacyDefaultPasswordHashes;

  function parsePayload(payload, fallback) {
    try {
      return JSON.parse(payload);
    } catch (error) {
      return fallback;
    }
  }

  async function upsertAppData(key, data) {
    if (databaseRestoreInProgress) {
      const error = new Error('Database sedang dipulihkan');
      error.code = 'DATABASE_RESTORE_IN_PROGRESS';
      throw error;
    }

    const payload = JSON.stringify(data);
    const previousWrite = appDataWriteQueues.get(key) || Promise.resolve();

    const nextWrite = previousWrite
      .catch(() => {})
      .then(async () => {
        try {
          await AppData.upsert({ key, payload });
        } catch (error) {
          logger.error(`Gagal menyimpan ${key} ke database`, error.message);
          throw error;
        }
      });

    appDataWriteQueues.set(key, nextWrite);
    nextWrite.finally(() => {
      if (appDataWriteQueues.get(key) === nextWrite) {
        appDataWriteQueues.delete(key);
      }
    }).catch(() => {});

    return nextWrite;
  }

  function buildSnapshotRecord(filename, snapshotDate, type, data, timestamps = {}) {
    const payload = JSON.stringify(data);
    const now = new Date();

    return {
      filename,
      snapshotDate,
      type,
      payload,
      size: Buffer.byteLength(payload, 'utf8'),
      contentHash: crypto.createHash('sha256').update(payload).digest('hex'),
      createdAt: timestamps.createdAt || now,
      updatedAt: timestamps.updatedAt || now
    };
  }

  function cacheSnapshot(record) {
    const { payload, ...metadata } = record;
    productionSnapshotCache.set(record.filename, {
      ...metadata,
      compressedPayload: zlib.gzipSync(Buffer.from(payload, 'utf8')),
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt)
    });
  }

  async function loadProductionSnapshotCache() {
    const rows = await ProductionSnapshot.findAll({ raw: true });
    productionSnapshotCache.clear();
    rows.forEach(cacheSnapshot);
  }

  function readSnapshotPayload(snapshot) {
    if (!snapshot) return '';
    if (typeof snapshot.payload === 'string') return snapshot.payload;
    if (snapshot.compressedPayload) {
      try {
        return zlib.gunzipSync(snapshot.compressedPayload).toString('utf8');
      } catch (error) {
        logger.warn(`Gagal membuka payload snapshot ${snapshot.filename}: ${error.message}`);
      }
    }
    return '';
  }

  function readSnapshotData(snapshot) {
    if (!snapshot) return null;
    const data = parsePayload(readSnapshotPayload(snapshot), null);
    return data ? normalizeProductionDataIdentities(data) : null;
  }

  function getSnapshotByFilename(filename) {
    return productionSnapshotCache.get(filename) || null;
  }

  function getLatestSnapshotForDate(date) {
    const dailySnapshot = getSnapshotByFilename(`data_${date}.json`);
    if (dailySnapshot) return dailySnapshot;

    return Array.from(productionSnapshotCache.values())
      .filter(snapshot => snapshot.snapshotDate === date)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] || null;
  }

  function storeProductionSnapshot(filename, snapshotDate, type, data, timestamps = {}) {
    if (databaseRestoreInProgress) {
      logger.warn(`Snapshot dilewati selama restore database: ${filename}`);
      return null;
    }

    const existing = getSnapshotByFilename(filename);
    const record = buildSnapshotRecord(filename, snapshotDate, type, data, {
      createdAt: existing?.createdAt || timestamps.createdAt,
      updatedAt: timestamps.updatedAt
    });

    snapshotWriteQueue = snapshotWriteQueue
      .catch(() => {})
      .then(async () => {
        await ProductionSnapshot.upsert(record);
        cacheSnapshot(record);
      })
      .catch(error => {
        snapshotWriteFailure ||= error;
        logger.error(`Gagal menyimpan snapshot ${filename} ke database`, error.message);
      });

    return record;
  }

  async function flushPendingDatabaseWrites() {
    await Promise.all(Array.from(appDataWriteQueues.values()));
    await snapshotWriteQueue;
    if (snapshotWriteFailure) {
      const error = snapshotWriteFailure;
      snapshotWriteFailure = null;
      throw error;
    }
  }

  function listDatabaseBackupFiles() {
    if (!fs.existsSync(databaseBackupDir)) return [];

    return fs.readdirSync(databaseBackupDir)
      .filter(filename => /^production-dashboard_\d{4}-\d{2}-\d{2}_[A-Za-z0-9_-]+_\d+_[a-f0-9]{8}\.sqlite$/.test(filename))
      .map(filename => {
        const filePath = path.join(databaseBackupDir, filename);
        const stats = fs.statSync(filePath);
        const match = filename.match(/^production-dashboard_(\d{4}-\d{2}-\d{2})_([A-Za-z0-9_-]+)_\d+_[a-f0-9]{8}\.sqlite$/);
        return {
          filename,
          path: filePath,
          date: match?.[1] || '',
          label: match?.[2] || 'database',
          size: stats.size,
          created: stats.mtime
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
  }

  function queryReadOnlySqlite(databaseFile, sql, params = []) {
    return new Promise((resolve, reject) => {
      const backupDatabase = new sqlite3.Database(databaseFile, sqlite3.OPEN_READONLY, openError => {
        if (openError) {
          reject(openError);
          return;
        }

        backupDatabase.all(sql, params, (queryError, rows) => {
          backupDatabase.close(closeError => {
            if (queryError) reject(queryError);
            else if (closeError) reject(closeError);
            else resolve(rows || []);
          });
        });
      });
    });
  }

  async function readSnapshotMetadataFromDatabaseBackup(backupPath) {
    try {
      return await queryReadOnlySqlite(
        backupPath,
        `SELECT filename, snapshotDate, type, size, contentHash, createdAt, updatedAt
         FROM production_snapshots`
      );
    } catch (error) {
      if (error.code === 'SQLITE_ERROR' && /no such table/i.test(error.message)) return [];
      throw error;
    }
  }

  async function recoverProductionSnapshotsFromDatabaseBackups() {
    const existingFilenames = new Set(productionSnapshotCache.keys());
    const candidates = new Map();

    for (const backup of listDatabaseBackupFiles()) {
      let rows;
      try {
        rows = await readSnapshotMetadataFromDatabaseBackup(backup.path);
      } catch (error) {
        logger.warn(`Backup SQLite dilewati (${backup.filename}): ${error.message}`);
        continue;
      }

      rows.forEach(row => {
        if (existingFilenames.has(row.filename)
          || !isSafeBackupFilename(row.filename)
          || !isValidDateInput(row.snapshotDate)) return;

        const currentCandidate = candidates.get(row.filename);
        if (!currentCandidate || new Date(row.updatedAt) > new Date(currentCandidate.updatedAt)) {
          candidates.set(row.filename, { ...row, backupPath: backup.path });
        }
      });
    }

    if (!candidates.size) return 0;

    const filenamesByBackup = new Map();
    candidates.forEach(candidate => {
      const filenames = filenamesByBackup.get(candidate.backupPath) || [];
      filenames.push(candidate.filename);
      filenamesByBackup.set(candidate.backupPath, filenames);
    });

    const recoveredRecords = [];
    for (const [backupPath, filenames] of filenamesByBackup.entries()) {
      for (let offset = 0; offset < filenames.length; offset += 500) {
        const batch = filenames.slice(offset, offset + 500);
        const placeholders = batch.map(() => '?').join(', ');
        let rows;
        try {
          rows = await queryReadOnlySqlite(
            backupPath,
            `SELECT filename, snapshotDate, type, payload, createdAt, updatedAt
             FROM production_snapshots
             WHERE filename IN (${placeholders})`,
            batch
          );
        } catch (error) {
          logger.warn(`Payload snapshot dari ${path.basename(backupPath)} dilewati: ${error.message}`);
          continue;
        }

        rows.forEach(row => {
          const candidate = candidates.get(row.filename);
          if (!candidate || candidate.backupPath !== backupPath) return;

          const data = parsePayload(row.payload, null);
          if (!isValidProductionSnapshot(data)) {
            logger.warn(`Snapshot tidak valid dilewati: ${row.filename}`);
            return;
          }

          recoveredRecords.push(buildSnapshotRecord(
            row.filename,
            row.snapshotDate,
            row.type || 'archive',
            data,
            { createdAt: row.createdAt, updatedAt: row.updatedAt }
          ));
        });
      }
    }

    if (!recoveredRecords.length) return 0;

    await ProductionSnapshot.bulkCreate(recoveredRecords, { ignoreDuplicates: true });
    await loadProductionSnapshotCache();
    logger.info(`Snapshot dipulihkan dari backup SQLite: ${recoveredRecords.length}`);
    return recoveredRecords.length;
  }

  async function pruneDatabaseBackups(now = new Date()) {
    const cutoff = new Date(now).getTime() - (DATABASE_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const expiredBackups = listDatabaseBackupFiles()
      .filter(backup => backup.created.getTime() < cutoff);
    let deletedCount = 0;

    for (const backup of expiredBackups) {
      try {
        await fs.promises.unlink(backup.path);
        deletedCount += 1;
        logger.info(`Backup database kedaluwarsa dihapus: ${backup.filename}`);
      } catch (error) {
        // Another cleanup worker may have removed the file between listing and unlinking.
        if (error.code !== 'ENOENT') {
          logger.warn(`Backup database gagal dihapus (${backup.filename}): ${error.message}`);
        }
      }
    }

    return deletedCount;
  }

  async function runDatabaseBackupCleanup() {
    if (databaseBackupCleanupRunning || databaseRestoreInProgress) return 0;
    databaseBackupCleanupRunning = true;

    try {
      const deletedCount = await pruneDatabaseBackups();
      if (deletedCount > 0) {
        logger.info(`Pembersihan backup database selesai: ${deletedCount} file lebih lama dari ${DATABASE_BACKUP_RETENTION_DAYS} hari dihapus`);
      }
      return deletedCount;
    } catch (error) {
      logger.error('Pembersihan backup database gagal', error.message);
      return 0;
    } finally {
      databaseBackupCleanupRunning = false;
    }
  }

  function startDatabaseBackupCleanupWorker() {
    // Run once immediately, then keep retention enforcement independent of backup creation.
    void runDatabaseBackupCleanup();
    const cleanupTimer = setInterval(() => {
      void runDatabaseBackupCleanup();
    }, DATABASE_BACKUP_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();
    return cleanupTimer;
  }

  async function createDatabaseBackup(label = 'manual') {
    await flushPendingDatabaseWrites();
    fs.mkdirSync(databaseBackupDir, { recursive: true });

    const safeLabel = String(label || 'manual').replace(/[^A-Za-z0-9_-]/g, '') || 'manual';
    const timestamp = Date.now();
    const filename = `production-dashboard_${getToday()}_${safeLabel}_${timestamp}_${crypto.randomBytes(4).toString('hex')}.sqlite`;
    const backupPath = path.join(databaseBackupDir, filename);
    const escapedPath = backupPath.replace(/'/g, "''");

    await sequelize.query(`VACUUM INTO '${escapedPath}'`);
    logger.info(`Backup database dibuat: ${filename}`);
    if (databaseInitialized && !databaseRestoreInProgress) void runDatabaseBackupCleanup();
    return backupPath;
  }

  function databaseBackupValidationError(message) {
    const error = new Error(message);
    error.code = 'INVALID_DATABASE_BACKUP';
    return error;
  }

  async function validateDatabaseBackupForRestore(backupPath) {
    let integrityRows;
    try {
      integrityRows = await queryReadOnlySqlite(backupPath, 'PRAGMA integrity_check');
    } catch (error) {
      throw databaseBackupValidationError(`File backup bukan database SQLite yang valid: ${error.message}`);
    }
    if (!integrityRows.length || integrityRows[0].integrity_check !== 'ok') {
      throw databaseBackupValidationError('File backup SQLite rusak atau gagal melewati integrity check');
    }

    const tableRows = await queryReadOnlySqlite(
      backupPath,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('app_data', 'production_snapshots')`
    );
    const tableNames = new Set(tableRows.map(row => row.name));
    if (!tableNames.has('app_data') || !tableNames.has('production_snapshots')) {
      throw databaseBackupValidationError('File backup tidak memiliki struktur database aplikasi yang lengkap');
    }

    const requiredAppColumns = ['key', 'payload', 'createdAt', 'updatedAt'];
    const requiredSnapshotColumns = ['filename', 'snapshotDate', 'type', 'payload', 'size', 'contentHash', 'createdAt', 'updatedAt'];
    const appColumns = new Set((await queryReadOnlySqlite(backupPath, 'PRAGMA table_info(app_data)')).map(row => row.name));
    const snapshotColumns = new Set((await queryReadOnlySqlite(backupPath, 'PRAGMA table_info(production_snapshots)')).map(row => row.name));
    if (requiredAppColumns.some(column => !appColumns.has(column))
      || requiredSnapshotColumns.some(column => !snapshotColumns.has(column))) {
      throw databaseBackupValidationError('Versi struktur file backup tidak kompatibel dengan aplikasi');
    }

    const appRows = await queryReadOnlySqlite(backupPath, 'SELECT key, payload FROM app_data');
    const requiredKeys = [
      PRODUCTION_DATA_KEY,
      USERS_DATA_KEY,
      DEFECT_CONFIG_KEY,
      PUBLIC_DISPLAY_SETTINGS_KEY,
      WORK_SCHEDULE_SETTINGS_KEY,
      MATERIAL_ORDERS_KEY
    ];
    const payloadsByKey = new Map(appRows.map(row => [row.key, row.payload]));
    if (requiredKeys.some(key => !payloadsByKey.has(key))) {
      throw databaseBackupValidationError('File backup tidak memiliki seluruh data aplikasi yang diperlukan');
    }

    requiredKeys.forEach(key => {
      const parsed = parsePayload(payloadsByKey.get(key), null);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw databaseBackupValidationError(`Payload backup tidak valid: ${key}`);
      }
    });

    return {
      appDataCount: appRows.length,
      snapshotCount: (await queryReadOnlySqlite(backupPath, 'SELECT COUNT(*) AS count FROM production_snapshots'))[0]?.count || 0
    };
  }

  function runSqliteStatement(database, sql) {
    return new Promise((resolve, reject) => {
      database.run(sql, error => error ? reject(error) : resolve());
    });
  }

  function closeSqliteDatabase(database) {
    return new Promise((resolve, reject) => {
      database.close(error => error ? reject(error) : resolve());
    });
  }

  async function replaceActiveDatabaseContentsFromBackup(backupPath) {
    const activeDatabase = await new Promise((resolve, reject) => {
      const database = new sqlite3.Database(databasePath, sqlite3.OPEN_READWRITE, error => {
        if (error) reject(error);
        else resolve(database);
      });
    });
    activeDatabase.configure('busyTimeout', 15000);

    const escapedBackupPath = backupPath.replace(/'/g, "''");
    let attached = false;
    let transactionStarted = false;
    try {
      await runSqliteStatement(activeDatabase, `ATTACH DATABASE '${escapedBackupPath}' AS restore_source`);
      attached = true;
      await runSqliteStatement(activeDatabase, 'BEGIN IMMEDIATE');
      transactionStarted = true;
      await runSqliteStatement(activeDatabase, 'DELETE FROM app_data');
      await runSqliteStatement(
        activeDatabase,
        `INSERT INTO app_data ("key", "payload", "createdAt", "updatedAt")
         SELECT "key", "payload", "createdAt", "updatedAt" FROM restore_source.app_data`
      );
      await runSqliteStatement(activeDatabase, 'DELETE FROM production_snapshots');
      await runSqliteStatement(
        activeDatabase,
        `INSERT INTO production_snapshots ("filename", "snapshotDate", "type", "payload", "size", "contentHash", "createdAt", "updatedAt")
         SELECT "filename", "snapshotDate", "type", "payload", "size", "contentHash", "createdAt", "updatedAt"
         FROM restore_source.production_snapshots`
      );
      await runSqliteStatement(activeDatabase, 'COMMIT');
      transactionStarted = false;
      await runSqliteStatement(activeDatabase, 'DETACH DATABASE restore_source');
      attached = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          await runSqliteStatement(activeDatabase, 'ROLLBACK');
        } catch (rollbackError) {
          logger.error('Rollback restore database gagal', rollbackError.message);
        }
      }
      if (attached) {
        try {
          await runSqliteStatement(activeDatabase, 'DETACH DATABASE restore_source');
        } catch (detachError) {
          logger.error('Detach database restore gagal', detachError.message);
        }
      }
      throw error;
    } finally {
      await closeSqliteDatabase(activeDatabase);
    }
  }

  async function restoreDatabaseBackupFile(backupPath) {
    const validation = await validateDatabaseBackupForRestore(backupPath);
    await flushPendingDatabaseWrites();
    const safetyBackupPath = await createDatabaseBackup('pre_restore');
    await replaceActiveDatabaseContentsFromBackup(backupPath);
    await reloadApplicationCaches();
    logger.info(`Restore database selesai dari ${path.basename(backupPath)}; pengaman ${path.basename(safetyBackupPath)}`);

    return {
      restoredFrom: path.basename(backupPath),
      safetyBackup: path.basename(safetyBackupPath),
      appDataCount: validation.appDataCount,
      snapshotCount: validation.snapshotCount
    };
  }

  function getLegacyHistoryJsonFiles() {
    const directories = [
      legacyHistoryDir,
      path.join(legacyHistoryDir, 'backups')
    ];

    return directories.flatMap(directory => {
      if (!fs.existsSync(directory)) return [];
      return fs.readdirSync(directory)
        .filter(filename => filename.endsWith('.json'))
        .map(filename => {
          const filePath = path.join(directory, filename);
          const stats = fs.statSync(filePath);
          return { filename, path: filePath, modified: stats.mtime };
        });
    });
  }

  function classifyLegacySnapshot(filename) {
    const preResetDate = filename.match(/^backup_pre_reset_(\d{4}-\d{2}-\d{2})_/i)?.[1];
    if (preResetDate) return { date: preResetDate, type: 'pre_reset' };

    const date = extractHistoryDate(filename);
    if (!date) return null;
    if (filename.includes('_pre_restore_')) return { date, type: 'pre_restore' };
    return { date, type: filename === `data_${date}.json` ? 'daily' : 'archive' };
  }

  async function migrateLegacyHistoryToDatabase() {
    const legacyFiles = getLegacyHistoryJsonFiles();
    if (!legacyFiles.length) return;

    const newestByFilename = new Map();
    legacyFiles.forEach(file => {
      const current = newestByFilename.get(file.filename);
      if (!current || file.modified > current.modified) newestByFilename.set(file.filename, file);
    });

    const uniqueFiles = Array.from(newestByFilename.values());
    for (const file of uniqueFiles) {
      const classification = classifyLegacySnapshot(file.filename);
      if (!classification) continue;

      const data = JSON.parse(fs.readFileSync(file.path, 'utf8'));
      if (!isValidProductionSnapshot(data)) {
        throw new Error(`Snapshot lama tidak valid: ${file.filename}`);
      }

      const record = buildSnapshotRecord(
        file.filename,
        classification.date,
        classification.type,
        data,
        { createdAt: file.modified, updatedAt: file.modified }
      );
      await ProductionSnapshot.upsert(record);
    }

    await loadProductionSnapshotCache();
    const migrationBackup = await createDatabaseBackup('json_migration');

    legacyFiles.forEach(file => fs.unlinkSync(file.path));
    logger.info(`Migrasi file JSON lama selesai: ${legacyFiles.length} file, backup ${path.basename(migrationBackup)}`);
  }

  async function reloadApplicationCaches() {
    const rows = await AppData.findAll({ raw: true });
    const rowsByKey = new Map(rows.map(row => [row.key, row]));

    productionDataCache = normalizeProductionDataIdentities(parsePayload(
      rowsByKey.get(PRODUCTION_DATA_KEY)?.payload || '',
      buildInitialProductionData()
    ));
    usersDataCache = parsePayload(
      rowsByKey.get(USERS_DATA_KEY)?.payload || '',
      buildInitialUsersData()
    );
    defectConfigCache = normalizeDefectConfig(parsePayload(
      rowsByKey.get(DEFECT_CONFIG_KEY)?.payload || '',
      buildInitialDefectConfig()
    ));
    publicDisplaySettingsCache = normalizePublicDisplaySettings(parsePayload(
      rowsByKey.get(PUBLIC_DISPLAY_SETTINGS_KEY)?.payload || '',
      buildInitialPublicDisplaySettings()
    ));
    workScheduleSettingsCache = normalizeWorkScheduleSettings(parsePayload(
      rowsByKey.get(WORK_SCHEDULE_SETTINGS_KEY)?.payload || '',
      buildInitialWorkScheduleSettings()
    ));
    materialOrdersCache = normalizeMaterialOrders(parsePayload(
      rowsByKey.get(MATERIAL_ORDERS_KEY)?.payload || '',
      buildInitialMaterialOrders()
    ));
    await loadProductionSnapshotCache();
  }

  async function initSequelizeStorage() {
    try {
      await sequelize.authenticate();
      await sequelize.query('PRAGMA journal_mode = WAL');
      await sequelize.query('PRAGMA synchronous = NORMAL');
      await sequelize.query('PRAGMA busy_timeout = 15000');
      await AppData.sync();
      await ProductionSnapshot.sync();

      const legacyDataPath = path.join(projectRoot, 'data.json');
      const legacyUsersPath = path.join(projectRoot, 'users.json');

      let productionRow = await AppData.findByPk(PRODUCTION_DATA_KEY);
      let usersRow = await AppData.findByPk(USERS_DATA_KEY);
      let defectConfigRow = await AppData.findByPk(DEFECT_CONFIG_KEY);
      let publicDisplaySettingsRow = await AppData.findByPk(PUBLIC_DISPLAY_SETTINGS_KEY);
      let workScheduleSettingsRow = await AppData.findByPk(WORK_SCHEDULE_SETTINGS_KEY);
      let materialOrdersRow = await AppData.findByPk(MATERIAL_ORDERS_KEY);

      if (!productionRow) {
        let initialProductionData = buildInitialProductionData();
        if (fs.existsSync(legacyDataPath)) {
          try {
            initialProductionData = JSON.parse(fs.readFileSync(legacyDataPath, 'utf8'));
          } catch (error) {
            logger.error('Gagal migrasi data.json, memakai data default', error.message);
          }
        }

        await upsertAppData(PRODUCTION_DATA_KEY, initialProductionData);
        productionRow = await AppData.findByPk(PRODUCTION_DATA_KEY);
      }

      if (!usersRow) {
        let initialUsersData = buildInitialUsersData();
        if (fs.existsSync(legacyUsersPath)) {
          try {
            initialUsersData = JSON.parse(fs.readFileSync(legacyUsersPath, 'utf8'));
          } catch (error) {
            logger.error('Gagal migrasi users.json, memakai user default', error.message);
          }
        }

        await upsertAppData(USERS_DATA_KEY, initialUsersData);
        usersRow = await AppData.findByPk(USERS_DATA_KEY);
      }

      if (!defectConfigRow) {
        await upsertAppData(DEFECT_CONFIG_KEY, buildInitialDefectConfig());
        defectConfigRow = await AppData.findByPk(DEFECT_CONFIG_KEY);
      }

      if (!publicDisplaySettingsRow) {
        await upsertAppData(PUBLIC_DISPLAY_SETTINGS_KEY, buildInitialPublicDisplaySettings());
        publicDisplaySettingsRow = await AppData.findByPk(PUBLIC_DISPLAY_SETTINGS_KEY);
      }

      if (!workScheduleSettingsRow) {
        await upsertAppData(WORK_SCHEDULE_SETTINGS_KEY, buildInitialWorkScheduleSettings());
        workScheduleSettingsRow = await AppData.findByPk(WORK_SCHEDULE_SETTINGS_KEY);
      }

      if (!materialOrdersRow) {
        await upsertAppData(MATERIAL_ORDERS_KEY, buildInitialMaterialOrders());
        materialOrdersRow = await AppData.findByPk(MATERIAL_ORDERS_KEY);
      }

      await reloadApplicationCaches();
      try {
        await migrateLegacyHistoryToDatabase();
      } catch (error) {
        logger.error('Migrasi histori JSON dibatalkan; file lama dipertahankan', error.message);
      }
      await recoverProductionSnapshotsFromDatabaseBackups();

      databaseInitialized = true;
      logger.info(`Sequelize database siap: ${databasePath}`);
    } catch (error) {
      logger.error('Inisialisasi Sequelize gagal', error.message);
      databaseInitialized = false;
      throw error;
    }
  }

  // FUNGSI BACKUP DATA SEBELUM RESET (PERBAIKAN UTAMA)

  function initializeDataFiles() {
    if (!databaseInitialized) {
      productionDataCache = buildInitialProductionData();
      usersDataCache = buildInitialUsersData();
      defectConfigCache = buildInitialDefectConfig();
      publicDisplaySettingsCache = buildInitialPublicDisplaySettings();
      workScheduleSettingsCache = buildInitialWorkScheduleSettings();
      materialOrdersCache = buildInitialMaterialOrders();
    }

    fs.mkdirSync(databaseBackupDir, { recursive: true });
  }

  function readProductionData() {
    try {
      return normalizeProductionDataIdentities(productionDataCache);
    } catch (error) {
      logger.error('Gagal membaca production data cache', error.message);
      return { lines: {}, activeLine: '' };
    }
  }

  function writeProductionData(data) {
    productionDataCache = normalizeProductionDataIdentities(data);
    return upsertAppData(PRODUCTION_DATA_KEY, productionDataCache);
  }

  function readUsersData() {
    try {
      let migrated = false;
      const users = Array.isArray(usersDataCache.users) ? usersDataCache.users : [];
      usersDataCache.users = users.map(user => {
        let normalizedUser = normalizeUserRecord(user);
        const legacyDefaultHash = LEGACY_DEFAULT_PASSWORD_HASHES_BY_USERNAME[normalizedUser.username];
        if (legacyDefaultHash && normalizedUser.password === legacyDefaultHash) {
          const bootstrapCredentials = readBootstrapCredentials();
          const bootstrapPassword = normalizedUser.username === 'admin'
            ? bootstrapCredentials.admin
            : (normalizedUser.username === 'admin_operator' ? bootstrapCredentials.adminOperator : bootstrapCredentials.operator);
          normalizedUser = {
            ...normalizedUser,
            password: hashPassword(bootstrapPassword),
            sessionVersion: normalizedUser.sessionVersion + 1
          };
          migrated = true;
        }

        if (normalizedUser.role !== user.role
          || normalizedUser.quickQcEnabled !== user.quickQcEnabled
          || normalizedUser.qcMaxQuantity !== user.qcMaxQuantity
          || normalizedUser.sessionVersion !== user.sessionVersion
          || normalizedUser.password !== user.password) {
          migrated = true;
        }
        return normalizedUser;
      });

      if (migrated) {
        void upsertAppData(USERS_DATA_KEY, usersDataCache).catch(error => {
          logger.error('Gagal menyimpan migrasi user', error.message);
        });
      }
      return usersDataCache;
    } catch (error) {
      logger.error('Gagal membaca users data cache', error.message);
      return { users: [] };
    }
  }

  function writeUsersData(data) {
    usersDataCache = {
      users: Array.isArray(data?.users) ? data.users.map(normalizeUserRecord) : []
    };
    return upsertAppData(USERS_DATA_KEY, usersDataCache);
  }

  function readDefectConfig() {
    try {
      defectConfigCache = normalizeDefectConfig(defectConfigCache);
      return defectConfigCache;
    } catch (error) {
      logger.error('Gagal membaca defect config cache', error.message);
      return buildInitialDefectConfig();
    }
  }

  function writeDefectConfig(data) {
    defectConfigCache = normalizeDefectConfig(data);
    return upsertAppData(DEFECT_CONFIG_KEY, defectConfigCache);
  }

  function readPublicDisplaySettings() {
    try {
      publicDisplaySettingsCache = normalizePublicDisplaySettings(publicDisplaySettingsCache);
      return publicDisplaySettingsCache;
    } catch (error) {
      logger.error('Gagal membaca public display settings cache', error.message);
      return buildInitialPublicDisplaySettings();
    }
  }

  function writePublicDisplaySettings(data) {
    publicDisplaySettingsCache = normalizePublicDisplaySettings(data);
    return upsertAppData(PUBLIC_DISPLAY_SETTINGS_KEY, publicDisplaySettingsCache)
      .then(() => publicDisplaySettingsCache);
  }

  function readWorkScheduleSettings() {
    workScheduleSettingsCache = normalizeWorkScheduleSettings(workScheduleSettingsCache);
    return workScheduleSettingsCache;
  }

  function writeWorkScheduleSettings(data) {
    workScheduleSettingsCache = normalizeWorkScheduleSettings(data);
    return upsertAppData(WORK_SCHEDULE_SETTINGS_KEY, workScheduleSettingsCache)
      .then(() => workScheduleSettingsCache);
  }

  function readMaterialOrders() {
    materialOrdersCache = normalizeMaterialOrders(materialOrdersCache);
    return materialOrdersCache;
  }

  function writeMaterialOrders(data) {
    materialOrdersCache = normalizeMaterialOrders(data);
    return upsertAppData(MATERIAL_ORDERS_KEY, materialOrdersCache)
      .then(() => materialOrdersCache);
  }

  return {
    classifyLegacySnapshot,
    createDatabaseBackup,
    flushPendingDatabaseWrites,
    getLegacyHistoryJsonFiles,
    getLatestSnapshotForDate,
    getSnapshotByFilename,
    initSequelizeStorage,
    initializeDataFiles,
    isDatabaseRestoreInProgress: () => databaseRestoreInProgress,
    listDatabaseBackupFiles,
    migrateLegacyHistoryToDatabase,
    productionSnapshotCache,
    pruneDatabaseBackups,
    readDefectConfig,
    readMaterialOrders,
    readProductionData,
    readPublicDisplaySettings,
    readSnapshotPayload,
    readSnapshotData,
    readUsersData,
    readWorkScheduleSettings,
    recoverProductionSnapshotsFromDatabaseBackups,
    restoreDatabaseBackupFile,
    setDatabaseRestoreInProgress: value => { databaseRestoreInProgress = Boolean(value); },
    startDatabaseBackupCleanupWorker,
    storeProductionSnapshot,
    validateDatabaseBackupForRestore,
    writeDefectConfig,
    writeMaterialOrders,
    writeProductionData,
    writePublicDisplaySettings,
    writeUsersData,
    writeWorkScheduleSettings
  };
}

module.exports = { createStorageService };
