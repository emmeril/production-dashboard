const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { Sequelize, DataTypes } = require('sequelize');
const {
  loadLocalEnvironment,
  parseBooleanEnvironment,
  parseTrustProxySetting
} = require('./config/environment');
const { createAppPaths, projectRoot } = require('./config/paths');
const { SQLiteSessionStore } = require('./infrastructure/sqlite-session-store');
const {
  hashPassword,
  hashPasswordAsync,
  verifyPassword,
  verifyPasswordAsync
} = require('./security/passwords');
const {
  ADMIN_OPERATOR_ROLES,
  DASHBOARD_VIEWER_ROLES,
  PPIC_ROLE,
  REPORT_VIEWER_ROLES,
  hasAnyRole,
  normalizeRole
} = require('./security/roles');
const { logger } = require('./shared/logger');
const {
  isBlankInputValue,
  isValidDateInput,
  normalizeLabelWeek,
  normalizeLabelWeekKey,
  normalizeLineName,
  normalizeModelName,
  normalizeProductionLabelWeeks,
  parseNonNegativeInteger
} = require('./shared/validation');

const { createProductionImportService } = require('./features/imports/production-import-service');
const { createImportWorkbookService } = require('./features/imports/workbook-service');

const { createMaterialOrderService } = require('./features/material-orders/service');
const { createReportService } = require('./features/reports/service');
const { registerImportRoutes } = require('./features/imports/routes');
const { registerMaterialOrderRoutes } = require('./features/material-orders/routes');
const { registerBackupRoutes, registerHistoryRoutes } = require('./features/backups/routes');
const { registerProductionRoutes } = require('./features/production/routes');
const { createStorageService } = require('./infrastructure/storage/service');
loadLocalEnvironment(projectRoot);

const app = express();
const port = process.env.PORT || 3000;
const {
  bootstrapCredentialsPath,
  databaseBackupDir,
  databasePath,
  legacyHistoryDir,
  publicDir,
  viewsDir
} = createAppPaths();
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: databasePath,
  logging: false
});
const productionImportPreviewCache = new Map();
const PRODUCTION_IMPORT_PREVIEW_TTL_MS = 30 * 60 * 1000;
const PRODUCTION_IMPORT_MAX_ROWS = 2000;
const LOGIN_RATE_LIMIT_WINDOW_MS = Math.max(60 * 1000, Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000);
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = Math.max(1, Number(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS) || 10);
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS_PER_IP = Math.max(
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  Number(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS_PER_IP) || 50
);
const LOGIN_RATE_LIMIT_MAX_KEYS = 10000;
const DUMMY_LOGIN_PASSWORD_HASH = '$2b$12$a/7OiB7tI8XcFXs7Uh/Nf.4ZTMJq1yxVox7HjwvKusghIreR7P46a';
let lastScheduledDatabaseBackupDate = '';
const loginRateLimitEntries = new Map();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const requestPath = decodeURIComponent(req.path).replace(/\\/g, '/');
  if (!requestPath.startsWith('/api/')
    && (requestPath.endsWith('.sqlite') || requestPath.startsWith('/database-backups/') || requestPath.startsWith('/history/'))) {
    return res.status(404).end();
  }
  return next();
});
app.use('/public', express.static(publicDir));

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  logger.warn('SESSION_SECRET is not set; using an ephemeral session secret. Set SESSION_SECRET in production.');
}

const trustProxySetting = parseTrustProxySetting(process.env.TRUST_PROXY);
if (trustProxySetting !== null) app.set('trust proxy', trustProxySetting);

const sessionCookieSecure = parseBooleanEnvironment(
  process.env.SESSION_COOKIE_SECURE,
  process.env.NODE_ENV === 'production'
);
const sessionStore = new SQLiteSessionStore(databasePath);

app.use(session({
  store: sessionStore,
  secret: sessionSecret || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: sessionCookieSecure,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use('/api', (req, res, next) => {
  if (isDatabaseRestoreInProgress() && req.method !== 'GET') {
    return res.status(503).json({ error: 'Database sedang dipulihkan. Tunggu beberapa saat lalu coba lagi.' });
  }
  return next();
});

function clearSessionsAfterDatabaseRestore(req) {
  return new Promise((resolve, reject) => {
    sessionStore.clear(clearError => {
      if (clearError) return reject(clearError);
      if (!req.session) return resolve();
      return req.session.destroy(destroyError => destroyError ? reject(destroyError) : resolve());
    });
  });
}

function loginRateLimitKeys(req, username) {
  const address = req.ip || req.socket?.remoteAddress || 'unknown';
  return [
    { key: `ip:${address}`, limit: LOGIN_RATE_LIMIT_MAX_ATTEMPTS_PER_IP },
    { key: `account:${address}:${String(username || '').trim().toLowerCase()}`, limit: LOGIN_RATE_LIMIT_MAX_ATTEMPTS }
  ];
}

function checkLoginRateLimit(req, username) {
  const now = Date.now();
  loginRateLimitEntries.forEach((entry, key) => {
    if (entry.resetAt <= now) loginRateLimitEntries.delete(key);
  });

  const keys = loginRateLimitKeys(req, username);
  const entries = keys.map(({ key, limit }) => {
    let entry = loginRateLimitEntries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (loginRateLimitEntries.size >= LOGIN_RATE_LIMIT_MAX_KEYS) {
        const oldestKey = loginRateLimitEntries.keys().next().value;
        if (oldestKey) loginRateLimitEntries.delete(oldestKey);
      }
      entry = { attempts: 0, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS };
      loginRateLimitEntries.set(key, entry);
    }
    return { key, limit, entry };
  });

  const blockedEntry = entries.find(({ entry, limit }) => entry.attempts >= limit);
  if (blockedEntry) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((blockedEntry.entry.resetAt - now) / 1000))
    };
  }

  entries.forEach(({ entry }) => { entry.attempts += 1; });
  return { allowed: true, keys: entries.map(({ key }) => key) };
}

function clearLoginRateLimit(keys) {
  (keys || []).forEach(key => loginRateLimitEntries.delete(key));
}

function establishAuthenticatedSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(regenerateError => {
      if (regenerateError) return reject(regenerateError);
      req.session.user = buildSessionUser(user);
      return req.session.save(saveError => saveError ? reject(saveError) : resolve(req.session.user));
    });
  });
}

function isLegacySha256PasswordHash(hashedPassword) {
  return typeof hashedPassword === 'string' && /^[a-f0-9]{64}$/i.test(hashedPassword);
}

function normalizeUserRecord(user) {
  if (!user || typeof user !== 'object') return user;

  return {
    ...user,
    role: normalizeRole(user.role),
    sessionVersion: Number.isInteger(user.sessionVersion) && user.sessionVersion > 0
      ? user.sessionVersion
      : 1
  };
}

function buildSessionUser(user) {
  if (!user) return null;

  const normalizedUser = normalizeUserRecord(user);
  return {
    id: normalizedUser.id,
    name: normalizedUser.name,
    username: normalizedUser.username,
    line: normalizedUser.line,
    role: normalizedUser.role,
    sessionVersion: normalizedUser.sessionVersion
  };
}

const LEGACY_DEFAULT_PASSWORD_HASHES_BY_USERNAME = {
  operator1: 'ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f',
  admin_operator: '40cc70c95776bb2d926894c02448c65b15421bcec8cd86d9193a488193932fbc',
  admin: '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9'
};

let bootstrapCredentialsCache = null;

function readBootstrapCredentials() {
  if (bootstrapCredentialsCache) return bootstrapCredentialsCache;

  fs.mkdirSync(databaseBackupDir, { recursive: true });

  if (fs.existsSync(bootstrapCredentialsPath)) {
    try {
      bootstrapCredentialsCache = JSON.parse(fs.readFileSync(bootstrapCredentialsPath, 'utf8'));
      return bootstrapCredentialsCache;
    } catch (error) {
      logger.error('Gagal membaca bootstrap credentials, membuat ulang', error.message);
    }
  }

  bootstrapCredentialsCache = {
    operator: process.env.DEFAULT_OPERATOR_PASSWORD || crypto.randomBytes(12).toString('base64url'),
    adminOperator: process.env.DEFAULT_ADMIN_OPERATOR_PASSWORD || crypto.randomBytes(12).toString('base64url'),
    admin: process.env.DEFAULT_ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url')
  };

  try {
    fs.writeFileSync(bootstrapCredentialsPath, JSON.stringify(bootstrapCredentialsCache, null, 2), { mode: 0o600 });
  } catch (error) {
    logger.error('Gagal menyimpan bootstrap credentials', error.message);
  }

  return bootstrapCredentialsCache;
}

function getToday() {
  // Pastikan selalu konsisten ke timezone Asia/Jakarta
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

const PRODUCTION_HOURS = [
  "07:00 - 08:00",
  "08:00 - 09:00",
  "09:00 - 10:00",
  "10:00 - 11:00",
  "13:00 - 14:00",
  "14:00 - 15:00",
  "15:00 - 16:00",
  "16:00 - 17:00"
];

function distributeDailyTarget(target) {
  const dailyTarget = Math.max(0, parseInt(target) || 0);
  const baseTarget = Math.floor(dailyTarget / PRODUCTION_HOURS.length);
  const remainder = dailyTarget % PRODUCTION_HOURS.length;

  return PRODUCTION_HOURS.map((hour, index) => ({
    hour,
    target: baseTarget + (index < remainder ? 1 : 0)
  }));
}

function createHourlyData(target) {
  const distributedTargets = distributeDailyTarget(target);
  const hourlyData = distributedTargets.slice(0, 4).map(({ hour, target: targetManual }) => ({
    hour, output: 0, defect: 0, qcChecked: 0, targetManual, selisih: 0
  }));

  hourlyData.push({ hour: "11:00 - 13:00", output: 0, defect: 0, qcChecked: 0, targetManual: 0, selisih: 0 });
  distributedTargets.slice(4).forEach(({ hour, target: targetManual }) => {
    hourlyData.push({ hour, output: 0, defect: 0, qcChecked: 0, targetManual, selisih: 0 });
  });

  return hourlyData;
}

const {
  classifyLegacySnapshot,
  createDatabaseBackup,
  flushPendingDatabaseWrites,
  getLegacyHistoryJsonFiles,
  getLatestSnapshotForDate,
  getSnapshotByFilename,
  initSequelizeStorage,
  initializeDataFiles,
  isDatabaseRestoreInProgress,
  listDatabaseBackupFiles,
  migrateLegacyHistoryToDatabase,
  productionSnapshotCache,
  pruneDatabaseBackups,
  readDefectConfig,
  readMaterialOrders,
  readProductionData,
  readPublicDisplaySettings,
  readSnapshotData,
  readUsersData,
  readWorkScheduleSettings,
  recoverProductionSnapshotsFromDatabaseBackups,
  restoreDatabaseBackupFile,
  setDatabaseRestoreInProgress,
  startDatabaseBackupCleanupWorker,
  storeProductionSnapshot,
  validateDatabaseBackupForRestore,
  writeDefectConfig,
  writeMaterialOrders,
  writeProductionData,
  writePublicDisplaySettings,
  writeUsersData,
  writeWorkScheduleSettings
} = createStorageService({
  DataTypes,
  buildInitialDefectConfig,
  buildInitialMaterialOrders: (...args) => buildInitialMaterialOrders(...args),
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
  legacyDefaultPasswordHashes: LEGACY_DEFAULT_PASSWORD_HASHES_BY_USERNAME,
  legacyHistoryDir,
  logger,
  normalizeDefectConfig,
  normalizeMaterialOrders: (...args) => normalizeMaterialOrders(...args),
  normalizeProductionLabelWeeks,
  normalizePublicDisplaySettings,
  normalizeUserRecord,
  normalizeWorkScheduleSettings,
  path,
  projectRoot,
  readBootstrapCredentials,
  sequelize,
  sqlite3
});

const {
  addToCounter,
  buildDateRangeProductionData,
  buildDateReportRows,
  buildProductionReportRows,
  filterProductionDataByDate,
  filterProductionDataByLine,
  generateScopedDateReportExcel,
  generateScopedLineReportExcel,
  generateDateReportPdf,
  generateLineDetailPdf,
  generateStyledDateReportExcel,
  generateStyledExcelData,
  isValidDateRange,
  mergeProductionSnapshotsByDate,
  readProductionSnapshotForDate,
  summarizeProductionSnapshot,
  summarizeProductionSnapshotByLine,
  topCounterItems
} = createReportService({
  ExcelJS,
  buildDefectSeverityMaps,
  calculateDefectSeverityBreakdown,
  ensureLineActiveModels,
  getAvailableHistoryDates,
  getDefectSeverity,
  getLatestSnapshotForDate,
  getToday,
  isValidDateInput,
  parseNonNegativeInteger,
  readDefectConfig,
  readProductionData,
  readSnapshotData
});

const {
  QC_IMPORT_HOURS,
  applyImportedQcData,
  buildImportedProductionModel,
  buildImportedSewingModel,
  parseProductionImportRows,
  parseProductionImportWorkbook,
  parseQcImportWorkbook,
  parseSewingImportWorkbook
} = createProductionImportService({
  PRODUCTION_HOURS,
  PRODUCTION_IMPORT_MAX_ROWS,
  XLSX,
  buildDefectSeverityMaps,
  createHourlyData,
  getDefectSeverity,
  getToday,
  normalizeLabelWeek,
  normalizeLabelWeekKey,
  normalizeDefectKey,
  readDefectConfig,
  readProductionSnapshotForDate,
  recalculateModelTotals
});

function applyDailyTarget(model, target) {
  const distributedTargets = distributeDailyTarget(target);
  const targetsByHour = new Map(distributedTargets.map(item => [item.hour, item.target]));

  model.targetPerHour = Math.round((parseInt(target) || 0) / PRODUCTION_HOURS.length);
  (model.hourly_data || []).forEach(hour => {
    const targetManual = targetsByHour.get(hour.hour) || 0;
    hour.targetManual = targetManual;
    hour.selisih = (parseInt(hour.output) || 0) - targetManual;
  });
}

function resetLineData(line) {
  return {
    ...line,
    targetPerHour: Math.round(line.target / PRODUCTION_HOURS.length),
    outputDay: 0,
    qcChecking: 0,
    actualDefect: 0,
    defectRatePercentage: 0,
    hourly_data: createHourlyData(line.target),
    operators: line.operators ? line.operators.map(operator => ({
      ...operator,
      output: 0,
      defect: 0,
      efficiency: 0
    })) : []
  };
}

function buildInitialProductionData() {
  const today = getToday();
  const targetPerHour = Math.round(180 / PRODUCTION_HOURS.length);

  return {
    "lines": {
      "F1-5A": {
        "models": {
          "model1": {
            "id": "model1",
            "labelWeek": "AP/14-2550",
            "model": "GOSIG GOLDEN SOFT TOY 40 PDS/GOLDEN RETRIEVER",
            "date": today,
            "target": 180,
            "targetPerHour": targetPerHour,
            "outputDay": 0,
            "qcChecking": 0,
            "actualDefect": 0,
            "defectRatePercentage": 0,
            "hourly_data": createHourlyData(180),
            "operators": [
              {
                "id": 1,
                "name": "Ahmad Susanto",
                "position": "Operator Mesin",
                "target": 100,
                "output": 0,
                "defect": 0,
                "efficiency": 0,
                "status": "active"
              }
            ]
          }
        },
        "activeModel": "model1",
        "activeModels": ["model1"]
      }
    },
    "activeLine": "F1-5A"
  };
}

function buildInitialUsersData() {
  const bootstrapCredentials = readBootstrapCredentials();

  return {
    "users": [
      {
        "id": 1,
        "username": "operator1",
        "password": hashPassword(bootstrapCredentials.operator),
        "name": "Ahmad Susanto",
        "line": "F1-5A",
        "role": "operator",
        "sessionVersion": 1
      },
      {
        "id": 2,
        "username": "admin_operator",
        "password": hashPassword(bootstrapCredentials.adminOperator),
        "name": "Admin Operator",
        "line": "all",
        "role": "admin_operator_sewing",
        "sessionVersion": 1
      },
      {
        "id": 3,
        "username": "admin",
        "password": hashPassword(bootstrapCredentials.admin),
        "name": "Administrator",
        "line": "all",
        "role": "admin",
        "sessionVersion": 1
      }
    ]
  };
}

function buildInitialDefectConfig() {
  return {
    defectTypes: [
      { id: 1, name: 'Jahitan lepas', severity: 'major', active: true },
      { id: 2, name: 'Kotor', severity: 'minor', active: true },
      { id: 3, name: 'Bentuk tidak sesuai', severity: 'major', active: true }
    ],
    defectAreas: [
      { id: 1, name: 'Kepala', active: true },
      { id: 2, name: 'Badan', active: true },
      { id: 3, name: 'Kaki', active: true }
    ]
  };
}

function normalizeDefectSeverity(value) {
  return ['minor', 'major', 'critical'].includes(value) ? value : 'minor';
}

function normalizeDefectConfig(config = {}) {
  return {
    defectTypes: (config.defectTypes || []).map(type => ({
      ...type,
      severity: normalizeDefectSeverity(type.severity)
    })),
    defectAreas: (config.defectAreas || []).map(({ severity, ...area }) => area)
  };
}

function buildInitialPublicDisplaySettings() {
  return {
    layoutWidth: 98,
    marginLeft: 30,
    marginTop: 12,
    cellFontSize: 16,
    sideFontSize: 14,
    metricFontSize: 66,
    percentFontSize: 40,
    refreshInterval: 10000
  };
}

function buildInitialWorkScheduleSettings() {
  return {
    enabled: true,
    workDays: [1, 2, 3, 4, 5, 6],
    startTime: '07:00',
    endTime: '17:00'
  };
}

function normalizeTimeSetting(value, fallback) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')) ? String(value) : fallback;
}

function normalizeWorkScheduleSettings(settings = {}) {
  const defaults = buildInitialWorkScheduleSettings();
  const workDays = Array.isArray(settings.workDays)
    ? [...new Set(settings.workDays.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))]
    : defaults.workDays;

  return {
    enabled: settings.enabled !== false,
    workDays,
    startTime: normalizeTimeSetting(settings.startTime, defaults.startTime),
    endTime: normalizeTimeSetting(settings.endTime, defaults.endTime)
  };
}

function normalizeNumberSetting(value, fallback, min, max) {
  const number = Number(value);
  if (Number.isNaN(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function normalizePublicDisplaySettings(settings = {}) {
  const defaults = buildInitialPublicDisplaySettings();

  return {
    layoutWidth: normalizeNumberSetting(settings.layoutWidth, defaults.layoutWidth, 60, 100),
    marginLeft: normalizeNumberSetting(settings.marginLeft, defaults.marginLeft, 0, 120),
    marginTop: normalizeNumberSetting(settings.marginTop, defaults.marginTop, 0, 80),
    cellFontSize: normalizeNumberSetting(settings.cellFontSize, defaults.cellFontSize, 10, 28),
    sideFontSize: normalizeNumberSetting(settings.sideFontSize, defaults.sideFontSize, 10, 24),
    metricFontSize: normalizeNumberSetting(settings.metricFontSize, defaults.metricFontSize, 32, 110),
    percentFontSize: normalizeNumberSetting(settings.percentFontSize, defaults.percentFontSize, 20, 72),
    refreshInterval: normalizeNumberSetting(settings.refreshInterval, defaults.refreshInterval, 0, 60000)
  };
}

const {
  MATERIAL_ORDER_STATUSES,
  buildInitialMaterialOrders,
  buildMaterialOrderCumulativeOutputs,
  buildMaterialOrderProductionTotals,
  buildMaterialOrderResponse,
  deriveMaterialOrderProgressStatus,
  filterMaterialOrderReportRows,
  generateMaterialOrderReportExcel,
  generateMaterialOrderReportPdf,
  normalizeMaterialOrderRecord,
  normalizeMaterialOrders,
  preserveMaterialOrderProductionIdentity,
  summarizeMaterialOrderReport,
  validateMaterialOrderInput
} = createMaterialOrderService({
  ExcelJS,
  getToday,
  isValidDateInput,
  normalizeLabelWeek,
  normalizeLabelWeekKey,
  productionSnapshotCache,
  readProductionData,
  readProductionSnapshotForDate
});

function normalizeDefectKey(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveActiveDefectCategories(type, area, config = readDefectConfig()) {
  const activeTypes = new Map((config.defectTypes || [])
    .filter(item => item.active !== false)
    .map(item => [normalizeDefectKey(item.name), item]));
  const activeAreas = new Map((config.defectAreas || [])
    .filter(item => item.active !== false)
    .map(item => [normalizeDefectKey(item.name), item]));
  const defectType = activeTypes.get(normalizeDefectKey(type));
  const defectArea = activeAreas.get(normalizeDefectKey(area));

  return {
    type: defectType?.name || '',
    area: defectArea?.name || '',
    isValid: Boolean(defectType && defectArea)
  };
}

function buildDefectSeverityMaps(config = readDefectConfig()) {
  const typeMap = new Map();

  (config.defectTypes || []).forEach(type => {
    const key = normalizeDefectKey(type.name);
    if (key) typeMap.set(key, normalizeDefectSeverity(type.severity));
  });

  return { typeMap };
}

function getDefectSeverity(type, severityMaps) {
  const typeSeverity = severityMaps.typeMap.get(normalizeDefectKey(type));
  return ['major', 'critical'].includes(typeSeverity) ? typeSeverity : 'minor';
}

function buildEmptyDefectBreakdown(qcChecking) {
  return {
    all: { count: 0, rate: 0 },
    critical: { count: 0, rate: 0 },
    major: { count: 0, rate: 0 },
    minor: { count: 0, rate: 0 },
    qcChecking: parseInt(qcChecking) || 0
  };
}

function calculateDefectSeverityBreakdown(model, config = readDefectConfig()) {
  const qcChecking = parseInt(model.qcChecking) || 0;
  const breakdown = buildEmptyDefectBreakdown(qcChecking);
  const severityMaps = buildDefectSeverityMaps(config);

  const addDefect = (type, area, quantity = 1, explicitSeverity = '') => {
    const count = Math.max(parseInt(quantity) || 1, 0);
    const severity = ['minor', 'major', 'critical'].includes(explicitSeverity)
      ? explicitSeverity
      : getDefectSeverity(type, severityMaps);

    breakdown.all.count += count;
    breakdown[severity].count += count;
  };

  if (Array.isArray(model.qcChecks)) {
    model.qcChecks
      .filter(check => check.result === 'defect')
      .forEach(check => addDefect(check.type, check.area, 1));
  } else {
    (model.hourly_data || []).forEach(hour => {
      (hour.defectDetails || []).forEach(detail => {
        addDefect(detail.type, detail.area, detail.quantity, detail.severity);
      });
    });
  }

  ['all', 'critical', 'major', 'minor'].forEach(key => {
    breakdown[key].rate = qcChecking > 0
      ? parseFloat(((breakdown[key].count / qcChecking) * 100).toFixed(2))
      : 0;
  });

  return breakdown;
}

function buildPublicModelResponse(model) {
  const defectConfig = readDefectConfig();
  const severityMaps = buildDefectSeverityMaps(defectConfig);
  const target = Number(model?.target) || 0;
  const targetPerHour = Number(model?.targetPerHour) || Math.round(target / PRODUCTION_HOURS.length);
  const hourlyData = Array.isArray(model?.hourly_data) ? model.hourly_data : [];
  const qcChecks = Array.isArray(model?.qcChecks) ? model.qcChecks : [];
  const response = {
    id: model?.id,
    labelWeek: model?.labelWeek || '',
    model: model?.model || '',
    date: model?.date || '',
    target,
    targetPerHour,
    outputDay: Number(model?.outputDay) || 0,
    qcChecking: Number(model?.qcChecking) || 0,
    actualDefect: Number(model?.actualDefect) || 0,
    defectRatePercentage: Number(model?.defectRatePercentage) || 0,
    hourly_data: hourlyData.map(hour => ({
      hour: hour?.hour || '',
      targetManual: Number(hour?.targetManual) || 0,
      output: Number(hour?.output) || 0,
      defect: Number(hour?.defect) || 0,
      qcChecked: Number(hour?.qcChecked) || 0,
      selisih: Number(hour?.selisih) || 0,
      defectDetails: Array.isArray(hour?.defectDetails)
        ? hour.defectDetails.map(detail => ({
          type: detail?.type || '',
          area: detail?.area || '',
          quantity: Number(detail?.quantity) || 0,
          severity: normalizeDefectSeverity(detail?.severity)
        }))
        : []
    })),
    operators: Array.isArray(model?.operators)
      ? model.operators.map(operator => ({
        id: operator?.id,
        position: operator?.position || '',
        target: Number(operator?.target) || 0,
        output: Number(operator?.output) || 0,
        defect: Number(operator?.defect) || 0,
        efficiency: Number(operator?.efficiency) || 0,
        status: operator?.status || ''
      }))
      : [],
    qcChecks: qcChecks.map(check => ({
      id: check?.id,
      result: check?.result || '',
      hourIndex: Number.isInteger(check?.hourIndex) ? check.hourIndex : null,
      hour: check?.hour || '',
      type: check?.type || '',
      area: check?.area || ''
    }))
  };

  response.defectBreakdown = calculateDefectSeverityBreakdown(response, defectConfig);
  const actualDefect = parseInt(response.actualDefect);
  const defectRatePercentage = parseFloat(response.defectRatePercentage);

  if (!Number.isNaN(actualDefect)) {
    response.defectBreakdown.all.count = actualDefect;
  }

  if (!Number.isNaN(defectRatePercentage)) {
    response.defectBreakdown.all.rate = defectRatePercentage;
  }

  response.defectSeverityLookups = {
    types: Object.fromEntries(severityMaps.typeMap)
  };

  return response;
}

function backupDataBeforeReset(data, today) {
  try {
    const backupData = {
      lines: {},
      activeLine: data.activeLine,
      backupDate: new Date().toISOString(),
      originalDate: today
    };
    
    Object.keys(data.lines).forEach(lineName => {
      const line = data.lines[lineName];
      backupData.lines[lineName] = {
        models: {},
        activeModel: line.activeModel,
        activeModels: Array.isArray(line.activeModels) ? [...line.activeModels] : (line.activeModel ? [line.activeModel] : [])
      };
      
      Object.keys(line.models).forEach(modelId => {
        const model = line.models[modelId];
        
        // Hanya backup data yang tanggalnya berbeda dari hari ini
        if (model.date !== today) {
          backupData.lines[lineName].models[modelId] = { ...model };
        }
      });
      
      // Jika tidak ada model yang dibackup, hapus line dari backup
      if (Object.keys(backupData.lines[lineName].models).length === 0) {
        delete backupData.lines[lineName];
      }
    });
    
    // Simpan snapshot sebelum reset ke database, bukan ke file JSON.
    if (Object.keys(backupData.lines).length > 0) {
      const timestamp = new Date().getTime();
      const backupFileName = `backup_pre_reset_${today}_${timestamp}.json`;
      storeProductionSnapshot(backupFileName, today, 'pre_reset', backupData);

      const historicalDates = new Set();
      Object.values(backupData.lines).forEach(line => {
        Object.values(line.models).forEach(model => {
          if (isValidDateInput(model.date)) historicalDates.add(model.date);
        });
      });
      historicalDates.forEach(date => {
        storeProductionSnapshot(`data_${date}.json`, date, 'daily', filterProductionDataByDate(data, date));
      });

      
      // Hitung jumlah model yang dibackup
      let modelCount = 0;
      Object.keys(backupData.lines).forEach(lineName => {
        modelCount += Object.keys(backupData.lines[lineName].models).length;
      });
      
      logger.info(`Backup data sebelum reset disimpan: ${backupFileName} (${Object.keys(backupData.lines).length} line, ${modelCount} model)`);
      
      return backupData;
    }
    
    return null;
  } catch (error) {
    logger.error('Gagal membuat backup data sebelum reset', error);
    return null;
  }
}

function checkAndResetDataForNewDay() {
  const data = readProductionData();
  const today = getToday();
  let resetCount = 0;


  // Backup data sebelum reset untuk tanggal yang berbeda
  backupDataBeforeReset(data, today);

  Object.keys(data.lines).forEach(lineName => {
    const line = data.lines[lineName];
    Object.keys(line.models).forEach(modelId => {
      const model = line.models[modelId];
      
      // Reset hanya jika tanggal model berbeda dengan hari ini
      if (model.date !== today) {
        
        const masterData = {
          id: model.id || modelId,
          labelWeek: model.labelWeek,
          model: model.model,
          target: model.target,
          operators: model.operators || []
        };
        
        const resetData = resetLineData({
          ...masterData,
          date: today
        });
        
        if (masterData.operators && masterData.operators.length > 0) {
          resetData.operators = masterData.operators.map(operator => ({
            ...operator,
            output: 0,
            defect: 0,
            efficiency: 0
          }));
        }
        
        data.lines[lineName].models[modelId] = {
          ...resetData,
          labelWeek: masterData.labelWeek,
          model: masterData.model,
          operators: resetData.operators
        };
        
        resetCount++;
      }
    });
  });

  if (resetCount > 0) {
    void writeProductionData(data).catch(error => {
      logger.error('Gagal menyimpan data reset harian', error.message);
    });
    logger.info(`Auto-reset selesai: ${resetCount} model direset ke tanggal ${today}`);
    
    // Simpan snapshot hari ini setelah reset.
    updateTodayBackup();
  }

  return resetCount;
}

function generateUserId(users) {
  if (users.length === 0) return 1;
  const maxId = Math.max(...users.map(user => user.id));
  return maxId + 1;
}

function generateNumericId(items) {
  if (!items || items.length === 0) return 1;
  return Math.max(...items.map(item => parseInt(item.id) || 0)) + 1;
}

function generateModelId(models) {
  let next = 1;
  while (models && Object.prototype.hasOwnProperty.call(models, `model${next}`)) {
    next += 1;
  }
  return `model${next}`;
}

function getActiveModel(data, lineName) {
  const line = data.lines[lineName];
  if (!line) return null;

  const normalizedLine = ensureLineActiveModels(line);
  const activeModelId = normalizedLine.activeModels[0] || normalizedLine.activeModel || Object.keys(normalizedLine.models || {})[0];
  if (!activeModelId || !normalizedLine.models[activeModelId]) return null;

  return {
    line: normalizedLine,
    modelId: activeModelId,
    model: normalizedLine.models[activeModelId]
  };
}

function ensureLineActiveModels(line) {
  if (!line || typeof line !== 'object') return line;

  const models = line.models || {};
  const modelIds = Object.keys(models);
  const currentActiveModels = Array.isArray(line.activeModels)
    ? line.activeModels.map(String).filter(modelId => models[modelId])
    : [];
  const legacyActiveModel = line.activeModel && models[line.activeModel] ? [String(line.activeModel)] : [];
  const fallbackModel = modelIds.length > 0 ? [modelIds[0]] : [];
  const activeModels = currentActiveModels.length > 0 ? currentActiveModels : (legacyActiveModel.length > 0 ? legacyActiveModel : fallbackModel);

  line.activeModels = [...new Set(activeModels)];
  line.activeModel = line.activeModels[0] || null;

  return line;
}

function isModelActiveInManagement(data, lineName, modelId) {
  const line = data?.lines?.[lineName];
  if (!line || !modelId) return false;
  const normalizedLine = ensureLineActiveModels(line);
  return (normalizedLine.activeModels || []).includes(String(modelId));
}

function recalculateModelTotals(model) {
  let totalOutput = 0;
  let totalDefect = 0;
  let totalQCChecked = 0;
  let totalTarget = 0;

  (model.hourly_data || []).forEach(hour => {
    totalOutput += parseInt(hour.output) || 0;
    totalTarget += parseInt(hour.targetManual) || 0;
  });

  if (Array.isArray(model.qcChecks)) {
    totalQCChecked = model.qcChecks.length;
    totalDefect = model.qcChecks.filter(check => check.result === 'defect').length;
    // Keep hourly QC columns aligned with the individual QC records.
    (model.hourly_data || []).forEach(hour => {
      hour.qcChecked = 0;
      hour.defect = 0;
    });
    model.qcChecks.forEach(check => {
      const index = parseNonNegativeInteger(check.hourIndex);
      if (Number.isInteger(index) && model.hourly_data[index]) {
        model.hourly_data[index].qcChecked = (parseInt(model.hourly_data[index].qcChecked) || 0) + 1;
        if (check.result === 'defect') model.hourly_data[index].defect = (parseInt(model.hourly_data[index].defect) || 0) + 1;
      }
    });
  } else {
    (model.hourly_data || []).forEach(hour => {
      totalDefect += parseInt(hour.defect) || 0;
      totalQCChecked += parseInt(hour.qcChecked) || 0;
    });
  }

  model.outputDay = totalOutput;
  model.actualDefect = totalDefect;
  model.qcChecking = totalQCChecked;
  model.target = totalTarget;
  model.defectRatePercentage = totalQCChecked > 0
    ? parseFloat(((totalDefect / totalQCChecked) * 100).toFixed(2))
    : 0;

  return { totalOutput, totalDefect, totalQCChecked, totalTarget };
}

function buildLinesResponse(lines) {
  const response = {};

  Object.keys(lines || {}).forEach(lineName => {
    const line = ensureLineActiveModels(lines[lineName]);
    const activeModelId = line.activeModels[0] || line.activeModel || Object.keys(line.models || {})[0];
    const activeModel = activeModelId ? line.models[activeModelId] : null;

    response[lineName] = {
      ...line,
      activeModels: line.activeModels || [],
      activeModel: activeModelId,
      target: activeModel ? activeModel.target : 0,
      targetPerHour: activeModel ? activeModel.targetPerHour : 0,
      productivity: activeModel ? activeModel.outputDay || 0 : 0,
      labelWeek: activeModel ? activeModel.labelWeek : '',
      model: activeModel ? activeModel.model : '',
      date: activeModel ? activeModel.date : ''
    };
  });

  return response;
}

// FUNGSI BACKUP BARU: Update backup untuk hari ini (real-time)
function updateTodayBackup() {
  try {
    const data = readProductionData();
    const today = getToday();
    const filename = `data_${today}.json`;
    storeProductionSnapshot(filename, today, 'daily', data);
    return filename;
  } catch (error) {
    logger.error('Gagal memperbarui snapshot hari ini', error);
    return null;
  }
}

// FUNGSI BACKUP BARU: Buat arsip backup dengan timestamp
function createArchiveBackup(label = '') {
  try {
    const data = readProductionData();
    const today = getToday();
    const timestamp = new Date().getTime();
    const safeLabel = String(label || '').replace(/[^A-Za-z0-9_-]/g, '');
    const labelPart = safeLabel ? `_${safeLabel}` : '';
    const filename = `data_${today}_${timestamp}${labelPart}_${crypto.randomBytes(4).toString('hex')}.json`;
    const type = safeLabel === 'pre_restore'
      ? 'pre_restore'
      : (safeLabel === 'pre_reset' ? 'pre_reset' : (safeLabel === 'manual' ? 'manual' : 'archive'));
    storeProductionSnapshot(filename, today, type, data);
    return filename;
  } catch (error) {
    logger.error('Gagal membuat snapshot arsip', error);
    return null;
  }
}

function extractHistoryDate(filename) {
  const match = String(filename || '').match(/^data_(\d{4}-\d{2}-\d{2})(?:_.*)?\.json$/);
  return match ? match[1] : '';
}

function getAvailableHistoryDates() {
  return Array.from(new Set(
    Array.from(productionSnapshotCache.values())
      .map(snapshot => snapshot.snapshotDate)
      .filter(isValidDateInput)
  )).sort((a, b) => b.localeCompare(a));
}

function getHistoryFiles() {
  return Array.from(productionSnapshotCache.values())
    .filter(snapshot => snapshot.filename.startsWith('data_'))
    .map(snapshot => ({
      filename: snapshot.filename,
      date: snapshot.snapshotDate,
      size: snapshot.size,
      created: snapshot.createdAt
    }))
    .sort((a, b) => new Date(b.created) - new Date(a.created));
}

function readHistoryData(filename) {
  return readSnapshotData(getSnapshotByFilename(filename));
}

function isSafeBackupFilename(filename) {
  return typeof filename === 'string'
    && path.basename(filename) === filename
    && /^(?:data_|backup_pre_reset_)[A-Za-z0-9_.-]+\.json$/.test(filename);
}

function isValidProductionSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  if (!snapshot.lines || typeof snapshot.lines !== 'object' || Array.isArray(snapshot.lines)) return false;

  return Object.values(snapshot.lines).every(line => {
    return line
      && typeof line === 'object'
      && !Array.isArray(line)
      && line.models
      && typeof line.models === 'object'
      && !Array.isArray(line.models)
      && Object.values(line.models).every(model => model && typeof model === 'object' && !Array.isArray(model));
  });
}

function restoreProductionSnapshot(currentData, backupData, operationalDate = getToday()) {
  if (!isValidProductionSnapshot(backupData)) {
    throw new Error('Backup tidak memiliki struktur data produksi yang valid');
  }
  if (!isValidDateInput(operationalDate)) {
    throw new Error('Tanggal operasional restore tidak valid');
  }

  const restoredData = JSON.parse(JSON.stringify(currentData || { lines: {}, activeLine: '' }));
  restoredData.lines = restoredData.lines || {};

  let restoredLines = 0;
  let restoredModels = 0;
  let replacedModels = 0;
  let normalizedDateModels = 0;

  Object.entries(backupData.lines).forEach(([lineName, backupLine]) => {
    const backupLineCopy = JSON.parse(JSON.stringify(backupLine));
    const lineExists = Boolean(restoredData.lines[lineName]);

    if (!lineExists) {
      restoredData.lines[lineName] = { ...backupLineCopy, models: {} };
      restoredLines += 1;
    }

    const targetLine = restoredData.lines[lineName];
    targetLine.models = targetLine.models || {};

    Object.entries(backupLineCopy.models || {}).forEach(([modelId, backupModel]) => {
      if (targetLine.models[modelId]) replacedModels += 1;
      else restoredModels += 1;

      if (backupModel.date !== operationalDate) normalizedDateModels += 1;
      targetLine.models[modelId] = { ...backupModel, date: operationalDate };
    });

    if (Array.isArray(backupLineCopy.activeModels)) {
      targetLine.activeModels = backupLineCopy.activeModels.filter(modelId => targetLine.models[modelId]);
    }
    targetLine.activeModel = backupLineCopy.activeModel && targetLine.models[backupLineCopy.activeModel]
      ? backupLineCopy.activeModel
      : targetLine.activeModels?.[0];
    ensureLineActiveModels(targetLine);
  });

  if (backupData.activeLine && restoredData.lines[backupData.activeLine]) {
    restoredData.activeLine = backupData.activeLine;
  }

  return {
    data: restoredData,
    restoredLines,
    restoredModels,
    replacedModels,
    normalizedDateModels
  };
}

function isSafeHistoryFilename(filename) {
  return typeof filename === 'string'
    && path.basename(filename) === filename
    && /^data_[A-Za-z0-9_.-]+\.json$/.test(filename);
}

function getAuthenticatedSessionUser(req) {
  const sessionUser = req.session?.user;
  if (!sessionUser) return null;

  const usersData = readUsersData();
  const currentUser = usersData.users.find(user => user.id === sessionUser.id);
  if (!currentUser) {
    delete req.session.user;
    return null;
  }

  const normalizedCurrentUser = normalizeUserRecord(currentUser);
  const sessionVersion = Number.isInteger(sessionUser.sessionVersion) && sessionUser.sessionVersion > 0
    ? sessionUser.sessionVersion
    : 1;

  if (sessionVersion !== normalizedCurrentUser.sessionVersion) {
    delete req.session.user;
    return null;
  }

  req.session.user = buildSessionUser(normalizedCurrentUser);
  return req.session.user;
}

function requireLogin(req, res, next) {
  if (getAuthenticatedSessionUser(req)) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized - Please login' });
  }
}

function hasDashboardAccess(user) {
  return hasAnyRole(user, DASHBOARD_VIEWER_ROLES);
}

function hasDateReportAccess(user) {
  return hasAnyRole(user, REPORT_VIEWER_ROLES);
}

function requireMaterialOrderViewAccess(req, res, next) {
  if (hasAnyRole(getAuthenticatedSessionUser(req), ['admin', PPIC_ROLE])) return next();
  return res.status(403).json({ error: 'Akses lihat Order Material diperlukan' });
}

function requireMaterialOrderManageAccess(req, res, next) {
  if (hasAnyRole(getAuthenticatedSessionUser(req), ['admin', PPIC_ROLE])) return next();
  return res.status(403).json({ error: 'Akses kelola Order Material diperlukan' });
}

function requireAdmin(req, res, next) {
  if (hasAnyRole(getAuthenticatedSessionUser(req), ['admin'])) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Admin access required' });
  }
}

function requireAdminOrAdminOperator(req, res, next) {
  if (hasDashboardAccess(getAuthenticatedSessionUser(req))) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Dashboard access required' });
  }
}

function requireLineManagementAccess(req, res, next) {
  if (hasAnyRole(getAuthenticatedSessionUser(req), ['admin', 'admin_operator_sewing'])) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Line management access required' });
  }
}

function requireDateReportAccess(req, res, next) {
  if (hasDateReportAccess(getAuthenticatedSessionUser(req))) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Date report access required' });
  }
}

function requireLineAccess(req, res, next) {
  const user = getAuthenticatedSessionUser(req);
  const lineName = req.params.lineName;
  const role = normalizeRole(user?.role);

  if (!user) {
    return res.status(401).json({ error: 'Unauthorized - Please login' });
  }

  if (hasDashboardAccess(user)) {
    return next();
  }

  if (role === 'operator' && user.line === lineName) {
    return next();
  }

  res.status(403).json({ error: 'Access denied to this line' });
}

function requireActiveModelForOperator(req, res, next) {
  const user = getAuthenticatedSessionUser(req);
  if (normalizeRole(user?.role) !== 'operator') return next();

  const data = readProductionData();
  if (isModelActiveInManagement(data, req.params.lineName, req.params.modelId)) return next();

  return res.status(403).json({
    error: 'Model tidak berstatus Active di Management Line. Pilih model aktif untuk input.'
  });
}

function requireProductionWriteAccess(req, res, next) {
  if (!hasAnyRole(getAuthenticatedSessionUser(req), ['admin', 'admin_operator_sewing', 'operator'])) {
    return res.status(403).json({ error: 'Akses input hasil produksi diperlukan' });
  }
  return next();
}

function requireQcWriteAccess(req, res, next) {
  if (hasAnyRole(getAuthenticatedSessionUser(req), ['admin', 'operator'])) return next();
  res.status(403).json({ error: 'Akses input hasil QC diperlukan' });
}

function requireQcManageAccess(req, res, next) {
  if (hasAnyRole(getAuthenticatedSessionUser(req), ['admin', 'admin_operator_qc'])) return next();
  res.status(403).json({ error: 'Akses kelola hasil QC diperlukan' });
}

function requireDefectCategoryAccess(req, res, next) {
  if (hasAnyRole(getAuthenticatedSessionUser(req), ['admin', 'admin_operator_qc'])) return next();
  res.status(403).json({ error: 'Akses kelola kategori defect diperlukan' });
}

function isOperatorProductionLocked(req, hour) {
  return req.session.user?.role === 'operator' && Boolean(hour?.productionLocked);
}

function getJakartaMinutesNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return (parseInt(values.hour, 10) * 60) + parseInt(values.minute, 10);
}

function isOperatorProductionHourTooEarly(req, hour) {
  if (req.session.user?.role !== 'operator') return false;

  const match = String(hour?.hour || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return false;

  const startMinutes = (parseInt(match[1], 10) * 60) + parseInt(match[2], 10);
  return getJakartaMinutesNow() < startMinutes;
}

function isProductionBreakHour(hour) {
  return String(hour?.hour || '').trim() === '11:00 - 13:00';
}

function isOperatorProductionBreakTime(req) {
  if (req.session.user?.role !== 'operator') return false;
  const currentMinutes = getJakartaMinutesNow();
  return currentMinutes >= 11 * 60 && currentMinutes < 13 * 60;
}

function rejectUnavailableOperatorProductionHour(req, res, hour) {
  if (req.session.user?.role === 'operator' && (isProductionBreakHour(hour) || isOperatorProductionBreakTime(req))) {
    res.status(403).json({ error: 'Jam istirahat. Input produksi dibuka kembali pukul 13:00' });
    return true;
  }

  if (isOperatorProductionLocked(req, hour)) {
    res.status(403).json({ error: 'Data produksi jam ini sudah disimpan dan tidak bisa diubah' });
    return true;
  }

  if (isOperatorProductionHourTooEarly(req, hour)) {
    res.status(403).json({ error: 'Jam produksi ini belum dimulai. Silakan input saat jamnya sudah sesuai' });
    return true;
  }

  return false;
}

function rejectBlankOperatorProductionOutput(req, res, output) {
  if (req.session.user?.role !== 'operator' || !isBlankInputValue(output)) return false;

  res.status(400).json({ error: 'Output produksi wajib diisi sebelum menyimpan' });
  return true;
}

function autoCheckDateReset(req, res, next) {
  checkAndResetDataForNewDay();
  next();
}

function isWithinWorkSchedule() {
  const schedule = readWorkScheduleSettings();
  if (!schedule.enabled) return true;
  const now = new Date();
  const dayParts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', weekday: 'short' }).format(now);
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[dayParts];
  if (!schedule.workDays.includes(day)) return false;
  const toMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const current = getJakartaMinutesNow();
  const start = toMinutes(schedule.startTime);
  const end = toMinutes(schedule.endTime);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

function requireWorkScheduleForWrite(req, res, next) {
  if (!req.session.user || hasAnyRole(req.session.user, ['admin']) || isWithinWorkSchedule()) return next();
  return res.status(403).json({ error: 'Perubahan data hanya dapat dilakukan pada hari dan jam kerja yang ditentukan' });
}

// Enforce the schedule for every non-admin mutation, including direct API calls.
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (['/login', '/logout'].includes(req.path)) return next();
  return requireWorkScheduleForWrite(req, res, next);
});

const {
  productionImportTemplateWorkbook,
  qcImportTemplateWorkbook,
  sewingImportTemplateWorkbook
} = createImportWorkbookService({
  ExcelJS,
  PRODUCTION_HOURS,
  QC_IMPORT_HOURS,
  buildDateReportRows,
  getAvailableHistoryDates,
  getToday,
  readDefectConfig,
  readProductionSnapshotForDate
});

registerImportRoutes(app, {
  PRODUCTION_IMPORT_PREVIEW_TTL_MS,
  applyImportedQcData,
  buildImportedProductionModel,
  buildImportedSewingModel,
  crypto,
  ensureLineActiveModels,
  express,
  flushPendingDatabaseWrites,
  generateModelId,
  getAuthenticatedSessionUser,
  getLatestSnapshotForDate,
  logger,
  parseProductionImportWorkbook,
  parseQcImportWorkbook,
  parseSewingImportWorkbook,
  productionImportPreviewCache,
  productionImportTemplateWorkbook,
  qcImportTemplateWorkbook,
  readProductionSnapshotForDate,
  requireAdmin,
  requireLogin,
  sewingImportTemplateWorkbook,
  storeProductionSnapshot
});

registerBackupRoutes(app, {
  ExcelJS,
  clearSessionsAfterDatabaseRestore,
  createArchiveBackup,
  createDatabaseBackup,
  databaseBackupDir,
  databasePath,
  databaseRestoreState: {
    get value() { return isDatabaseRestoreInProgress(); },
    set value(value) { setDatabaseRestoreInProgress(value); }
  },
  flushPendingDatabaseWrites,
  fs,
  getLegacyHistoryJsonFiles,
  getSnapshotByFilename,
  getToday,
  isSafeBackupFilename,
  isValidProductionSnapshot,
  listDatabaseBackupFiles,
  logger,
  migrateLegacyHistoryToDatabase,
  path,
  productionSnapshotCache,
  readProductionData,
  readSnapshotData,
  recoverProductionSnapshotsFromDatabaseBackups,
  requireAdmin,
  requireLogin,
  restoreDatabaseBackupFile,
  restoreProductionSnapshot,
  updateTodayBackup,
  writeProductionData
});

app.get('/api/available-dates', requireLogin, requireDateReportAccess, async (req, res) => {
  try {
    const dates = getAvailableHistoryDates();

    // Tambahkan tanggal hari ini jika belum ada
    const today = getToday();
    if (!dates.includes(today)) {
      dates.unshift(today);
    }

    res.json(dates);
  } catch (error) {
    logger.error('Gagal mengambil tanggal yang tersedia', error);
    res.status(500).json({ error: 'Failed to get available dates' });
  }
});

app.get('/api/dashboard-summary', requireLogin, requireAdminOrAdminOperator, autoCheckDateReset, async (req, res) => {
  try {
    const snapshotsByDate = new Map();
    const currentData = readProductionData();
    const defectConfig = readDefectConfig();
    const managedLineNames = new Set(Object.keys(currentData.lines || {}));

    productionSnapshotCache.forEach(snapshot => {
      if (snapshot.type !== 'daily' || snapshotsByDate.has(snapshot.snapshotDate)) return;
      const snapshotData = readSnapshotData(snapshot);
      if (snapshotData) snapshotsByDate.set(snapshot.snapshotDate, snapshotData);
    });

    snapshotsByDate.set(getToday(), currentData);

    const totalAreaCounts = {};
    const totalTypeCounts = {};
    const lineNames = new Set();
    const daily = Array.from(snapshotsByDate.entries())
      .map(([date, data]) => summarizeProductionSnapshot(data, date, defectConfig))
      .filter(item => item.modelCount > 0)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const lineDaily = [];
    Array.from(snapshotsByDate.entries()).forEach(([date, data]) => {
      summarizeProductionSnapshotByLine(data, date, defectConfig).forEach(item => {
        if (!managedLineNames.has(item.lineName)) return;

        lineNames.add(item.lineName);
        lineDaily.push(item);
      });
    });

    lineDaily.sort((a, b) => new Date(a.date) - new Date(b.date) || a.lineName.localeCompare(b.lineName));

    daily.forEach(item => {
      Object.entries(item.areaCounts).forEach(([name, count]) => addToCounter(totalAreaCounts, name, count));
      Object.entries(item.typeCounts).forEach(([name, count]) => addToCounter(totalTypeCounts, name, count));
      delete item.areaCounts;
      delete item.typeCounts;
    });

    res.json({
      daily,
      lineDaily,
      lines: Array.from(lineNames).sort((a, b) => a.localeCompare(b)),
      topDefectAreas: topCounterItems(totalAreaCounts, 5),
      topDefectTypes: topCounterItems(totalTypeCounts, 5)
    });
  } catch (error) {
    logger.error('Error building dashboard summary:', error);
    res.status(500).json({ error: 'Failed to build dashboard summary' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (username.trim().length > 100 || password.length > 500) {
    return res.status(400).json({ error: 'Username atau password terlalu panjang' });
  }

  const rateLimit = checkLoginRateLimit(req, username);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return res.status(429).json({ error: 'Terlalu banyak percobaan login. Coba lagi nanti.' });
  }

  try {
    const usersData = readUsersData();
    const user = usersData.users.find(u => u.username === username.trim());

    const passwordMatches = await verifyPasswordAsync(password, user?.password || DUMMY_LOGIN_PASSWORD_HASH);
    if (user && passwordMatches) {
      if (isLegacySha256PasswordHash(user.password)) {
        user.password = await hashPasswordAsync(password);
        user.sessionVersion = (Number(user.sessionVersion) || 1) + 1;
        await writeUsersData(usersData);
      }

      clearLoginRateLimit(rateLimit.keys);
      const sessionUser = await establishAuthenticatedSession(req, user);
      return res.json({
        message: 'Login successful',
        user: sessionUser
      });
    }

    return res.status(401).json({ error: 'Invalid username or password' });
  } catch (error) {
    logger.error('Error during login:', error);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', async (req, res) => {
  req.session.destroy(error => {
    if (error) return res.status(500).json({ error: 'Logout failed' });
    return res.json({ message: 'Logout successful' });
  });
});

app.get('/api/current-user', async (req, res) => {
  const user = getAuthenticatedSessionUser(req);
  if (user) {
    res.json(user);
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

registerProductionRoutes(app, {
  ADMIN_OPERATOR_ROLES,
  PPIC_ROLE,
  PRODUCTION_HOURS,
  applyDailyTarget,
  autoCheckDateReset,
  buildLinesResponse,
  buildPublicModelResponse,
  createHourlyData,
  ensureLineActiveModels,
  generateModelId,
  generateNumericId,
  getActiveModel,
  getToday,
  hasAnyRole,
  isValidDateInput,
  isWithinWorkSchedule,
  normalizeLabelWeek,
  normalizeLineName,
  normalizeModelName,
  parseNonNegativeInteger,
  preserveMaterialOrderProductionIdentity,
  readProductionData,
  recalculateModelTotals,
  rejectBlankOperatorProductionOutput,
  rejectUnavailableOperatorProductionHour,
  requireActiveModelForOperator,
  requireAdmin,
  requireLineAccess,
  requireLineManagementAccess,
  requireLogin,
  requireProductionWriteAccess,
  requireQcWriteAccess,
  resolveActiveDefectCategories,
  updateTodayBackup,
  writeProductionData
});

registerHistoryRoutes(app, {
  XLSX,
  checkAndResetDataForNewDay,
  createDatabaseBackup,
  extractHistoryDate,
  fs,
  getHistoryFiles,
  getSnapshotByFilename,
  getToday,
  isSafeHistoryFilename,
  logger,
  path,
  readHistoryData,
  requireAdmin,
  requireLogin
});

app.get('/api/date-report', requireLogin, requireDateReportAccess, autoCheckDateReset, async (req, res) => {
  const { startDate, endDate, line } = req.query;

  if (!isValidDateRange(startDate, endDate)) {
    return res.status(400).json({ error: 'Rentang tanggal tidak valid. Gunakan tanggal mulai dan tanggal selesai dengan format YYYY-MM-DD.' });
  }

  try {
    const data = filterProductionDataByLine(buildDateRangeProductionData(startDate, endDate), line);
    const reportData = buildProductionReportRows(data);
    res.json(reportData);
  } catch (error) {
    logger.error('Gagal membuat laporan rentang tanggal', error);
    res.status(500).json({ error: 'Failed to generate date range report: ' + error.message });
  }
});

app.get('/api/date-report/:date', requireLogin, requireDateReportAccess, autoCheckDateReset, async (req, res) => {
  const date = req.params.date;
  
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Format tanggal tidak valid. Gunakan format: YYYY-MM-DD' });
  }
  
  try {
    const data = readProductionSnapshotForDate(date);
    if (!data) return res.json([]);
    
    const reportData = buildDateReportRows(data, date);
    
    res.json(reportData);
  } catch (error) {
    logger.error('Gagal membuat laporan tanggal', error);
    res.status(500).json({ error: 'Failed to generate date report: ' + error.message });
  }
});

app.get('/api/export-date-report', requireLogin, requireDateReportAccess, autoCheckDateReset, async (req, res) => {
  const { startDate, endDate, line } = req.query;

  if (!isValidDateRange(startDate, endDate)) {
    return res.status(400).json({ error: 'Rentang tanggal tidak valid. Gunakan tanggal mulai dan tanggal selesai dengan format YYYY-MM-DD.' });
  }

  try {
    const selectedLine = String(line || '').trim();
    const data = filterProductionDataByLine(buildDateRangeProductionData(startDate, endDate), selectedLine);
    const reportLabel = startDate === endDate ? startDate : `${startDate} s.d. ${endDate}`;
    const pdf = generateDateReportPdf(data, reportLabel, selectedLine);
    const safeLineSuffix = selectedLine
      ? `_${selectedLine.replace(/[^a-zA-Z0-9_-]+/g, '_')}`
      : '';
    const downloadFilename = startDate === endDate
      ? `Production_Report${safeLineSuffix}_${startDate}.pdf`
      : `Production_Report${safeLineSuffix}_${startDate}_to_${endDate}.pdf`;

    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.setHeader('Content-Type', 'application/pdf');
    return res.send(pdf);
  } catch (error) {
    logger.error('Gagal mengekspor laporan rentang tanggal', error);
    res.status(500).json({ error: 'Failed to export date range report: ' + error.message });
  }
});

app.get('/api/export-date-report/:date', requireLogin, requireDateReportAccess, autoCheckDateReset, async (req, res) => {
  const date = req.params.date;
  
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Format tanggal tidak valid. Gunakan format: YYYY-MM-DD' });
  }
  
  try {
    const data = readProductionSnapshotForDate(date);
    if (!data) return res.status(404).json({ error: 'Data untuk tanggal tersebut tidak ditemukan' });
    
    const filteredData = filterProductionDataByDate(data, date);
    const pdf = generateDateReportPdf(filteredData, date);
    const downloadFilename = `Production_Report_${date}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.setHeader('Content-Type', 'application/pdf');
    return res.send(pdf);
  } catch (error) {
    logger.error('Gagal mengekspor laporan tanggal', error);
    res.status(500).json({ error: 'Failed to export date report: ' + error.message });
  }
});

app.get('/api/export-date-report/:date/:lineName/:modelId', requireLogin, requireDateReportAccess, autoCheckDateReset, async (req, res) => {
  const { date, lineName, modelId } = req.params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Format tanggal tidak valid. Gunakan format: YYYY-MM-DD' });
  }

  try {
    const data = readProductionSnapshotForDate(date);
    if (!data) return res.status(404).json({ error: 'Data untuk tanggal tersebut tidak ditemukan' });
    const modelData = data.lines?.[lineName]?.models?.[modelId];

    if (!modelData || modelData.date !== date) {
      return res.status(404).json({ error: 'Detail line/model untuk tanggal tersebut tidak ditemukan' });
    }

    const pdf = generateLineDetailPdf(modelData, lineName, modelId);
    const safeLineName = lineName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeModelId = modelId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `Production_QC_Detail_${safeLineName}_${safeModelId}_${date}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/pdf');
    return res.send(pdf);
  } catch (error) {
    logger.error('Export detail date report error:', error);
    res.status(500).json({ error: 'Failed to export line detail: ' + error.message });
  }
});

app.get('/api/operator-count', requireLogin, requireAdminOrAdminOperator, async (req, res) => {
  const operatorCount = readUsersData().users.filter(user => user.role === 'operator').length;
  res.json({ operatorCount });
});

app.get('/api/users', requireLogin, requireAdmin, async (req, res) => {
  const usersData = readUsersData();
  const usersWithoutPasswords = usersData.users.map(user => {
    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  });
  res.json(usersWithoutPasswords || []);
});

app.get('/api/operators/:lineName', requireLogin, requireLineAccess, autoCheckDateReset, async (req, res) => {
  const { lineName } = req.params;
  const data = readProductionData();
  const active = getActiveModel(data, lineName);

  if (!active) {
    return res.status(404).json({ error: 'Line or active model not found' });
  }

  res.json(active.model.operators || []);
});

app.post('/api/operators/:lineName', requireLogin, requireLineManagementAccess, autoCheckDateReset, async (req, res) => {
  const { lineName } = req.params;
  const { name, position, target, output, defect, status } = req.body;
  const data = readProductionData();
  const active = getActiveModel(data, lineName);

  if (!active) {
    return res.status(404).json({ error: 'Line or active model not found' });
  }

  const operators = active.model.operators || [];
  const nextOutput = parseInt(output) || 0;
  const nextTarget = parseInt(target) || 0;
  const operator = {
    id: generateNumericId(operators),
    name,
    position,
    target: nextTarget,
    output: nextOutput,
    defect: parseInt(defect) || 0,
    efficiency: nextTarget > 0 ? parseFloat(((nextOutput / nextTarget) * 100).toFixed(2)) : 0,
    status: status || 'active'
  };

  operators.push(operator);
  active.model.operators = operators;
  await writeProductionData(data);
  updateTodayBackup();

  res.json({ message: 'Operator created successfully', operator });
});

app.put('/api/operators/:lineName/:operatorId', requireLogin, requireLineManagementAccess, autoCheckDateReset, async (req, res) => {
  const { lineName, operatorId } = req.params;
  const { name, position, target, output, defect, status } = req.body;
  const data = readProductionData();
  const active = getActiveModel(data, lineName);

  if (!active) {
    return res.status(404).json({ error: 'Line or active model not found' });
  }

  const operators = active.model.operators || [];
  const operatorIndex = operators.findIndex(operator => String(operator.id) === String(operatorId));
  if (operatorIndex === -1) {
    return res.status(404).json({ error: 'Operator not found' });
  }

  const nextOutput = parseInt(output) || 0;
  const nextTarget = parseInt(target) || 0;
  operators[operatorIndex] = {
    ...operators[operatorIndex],
    name,
    position,
    target: nextTarget,
    output: nextOutput,
    defect: parseInt(defect) || 0,
    efficiency: nextTarget > 0 ? parseFloat(((nextOutput / nextTarget) * 100).toFixed(2)) : 0,
    status: status || operators[operatorIndex].status || 'active'
  };

  active.model.operators = operators;
  await writeProductionData(data);
  updateTodayBackup();

  res.json({ message: 'Operator updated successfully', operator: operators[operatorIndex] });
});

app.delete('/api/operators/:lineName/:operatorId', requireLogin, requireAdmin, autoCheckDateReset, async (req, res) => {
  const { lineName, operatorId } = req.params;
  const data = readProductionData();
  const active = getActiveModel(data, lineName);

  if (!active) {
    return res.status(404).json({ error: 'Line or active model not found' });
  }

  const operators = active.model.operators || [];
  const operatorIndex = operators.findIndex(operator => String(operator.id) === String(operatorId));
  if (operatorIndex === -1) {
    return res.status(404).json({ error: 'Operator not found' });
  }

  const [operator] = operators.splice(operatorIndex, 1);
  active.model.operators = operators;
  await writeProductionData(data);
  updateTodayBackup();

  res.json({ message: 'Operator deleted successfully', operator });
});

app.get('/api/defect-config', requireLogin, async (req, res) => {
  res.json(readDefectConfig());
});

app.delete('/api/production/:lineName/:modelId/:hourIndex', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, requireActiveModelForOperator, async (req, res) => {
  const { lineName, modelId } = req.params;
  const index = parseInt(req.params.hourIndex);
  const data = readProductionData();
  const model = data.lines?.[lineName]?.models?.[modelId];

  if (!model?.hourly_data || !Number.isInteger(index) || !model.hourly_data[index]) {
    return res.status(404).json({ error: 'Data produksi per jam tidak ditemukan' });
  }

  if (req.session.user.role === 'operator') {
    return res.status(403).json({ error: 'Hanya admin atau petugas produksi yang dapat menghapus hasil produksi' });
  }

  const currentHour = model.hourly_data[index];
  model.hourly_data[index] = {
    ...currentHour,
    output: 0,
    selisih: -(parseInt(currentHour.targetManual) || 0),
    productionLocked: false,
    productionLockedAt: null,
    productionLockedBy: null
  };

  const summary = recalculateModelTotals(model);
  await writeProductionData(data);
  updateTodayBackup();
  res.json({ message: 'Hasil sewing berhasil dihapus', data: model, summary });
});

app.delete('/api/qc-check/:lineName/:modelId/:checkId', requireLogin, requireLineAccess, requireQcManageAccess, autoCheckDateReset, async (req, res) => {
  const { lineName, modelId, checkId } = req.params;
  const data = readProductionData();
  const model = data.lines?.[lineName]?.models?.[modelId];

  if (!model) return res.status(404).json({ error: 'Line atau model tidak ditemukan' });

  model.qcChecks = Array.isArray(model.qcChecks) ? model.qcChecks : [];
  const checkIndex = model.qcChecks.findIndex(check => String(check.id) === String(checkId));
  if (checkIndex === -1) return res.status(404).json({ error: 'Data QC tidak ditemukan' });

  const [deletedCheck] = model.qcChecks.splice(checkIndex, 1);
  const summary = recalculateModelTotals(model);
  await writeProductionData(data);
  updateTodayBackup();

  res.json({ message: 'Data QC berhasil dihapus', deletedCheck, data: model, summary });
});

app.put('/api/qc-check/:lineName/:modelId/:checkId', requireLogin, requireLineAccess, requireQcManageAccess, autoCheckDateReset, async (req, res) => {
  const { lineName, modelId, checkId } = req.params;
  const { type, area, notes } = req.body;
  const data = readProductionData();
  const model = data.lines?.[lineName]?.models?.[modelId];

  if (!model) return res.status(404).json({ error: 'Line atau model tidak ditemukan' });

  model.qcChecks = Array.isArray(model.qcChecks) ? model.qcChecks : [];
  const check = model.qcChecks.find(item => String(item.id) === String(checkId));
  if (!check || check.result !== 'defect') return res.status(404).json({ error: 'Data defect tidak ditemukan' });
  if (!String(type || '').trim() || !String(area || '').trim()) {
    return res.status(400).json({ error: 'Jenis defect dan area defect wajib diisi' });
  }

  const defectCategory = resolveActiveDefectCategories(type, area);
  if (!defectCategory.isValid) {
    return res.status(400).json({ error: 'Jenis defect dan area defect harus dipilih dari kategori aktif' });
  }

  check.type = defectCategory.type;
  check.area = defectCategory.area;
  check.notes = String(notes || '').trim();
  check.updatedAt = new Date().toISOString();

  const summary = recalculateModelTotals(model);
  await writeProductionData(data);
  updateTodayBackup();
  res.json({ message: 'Data defect berhasil diperbarui', check, data: model, summary });
});

app.get('/api/public-display-settings', async (req, res) => {
  res.json(readPublicDisplaySettings());
});

app.put('/api/public-display-settings', requireLogin, requireAdmin, async (req, res) => {
  const settings = await writePublicDisplaySettings(req.body || {});
  res.json({ message: 'Public display settings updated successfully', settings });
});

app.get('/api/work-schedule-settings', requireLogin, async (req, res) => {
  res.json(readWorkScheduleSettings());
});

app.get('/api/public/work-schedule-status', async (req, res) => {
  const settings = readWorkScheduleSettings();
  res.json({ settings, withinWorkSchedule: isWithinWorkSchedule() });
});

app.put('/api/work-schedule-settings', requireLogin, requireAdmin, async (req, res) => {
  const settings = await writeWorkScheduleSettings(req.body || {});
  res.json({ message: 'Pengaturan hari kerja berhasil disimpan', settings });
});

registerMaterialOrderRoutes(app, {
  MATERIAL_ORDER_STATUSES,
  buildMaterialOrderCumulativeOutputs,
  buildMaterialOrderProductionTotals,
  buildMaterialOrderResponse,
  filterMaterialOrderReportRows,
  generateMaterialOrderReportExcel,
  generateMaterialOrderReportPdf,
  generateNumericId,
  getToday,
  isValidDateInput,
  logger,
  parseNonNegativeInteger,
  readMaterialOrders,
  readProductionData,
  requireMaterialOrderManageAccess,
  requireMaterialOrderViewAccess,
  requireLogin,
  summarizeMaterialOrderReport,
  validateMaterialOrderInput,
  writeMaterialOrders
});

app.get('/api/defect-types', requireLogin, async (req, res) => {
  const config = readDefectConfig();
  res.json((config.defectTypes || []).filter(type => type.active !== false));
});

app.post('/api/defect-types', requireLogin, requireDefectCategoryAccess, async (req, res) => {
  const { name, severity = 'minor', active = true } = req.body;
  const config = readDefectConfig();
  config.defectTypes = config.defectTypes || [];

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Defect type name is required' });
  }

  const defectType = { id: generateNumericId(config.defectTypes), name: name.trim(), severity: normalizeDefectSeverity(severity), active: Boolean(active) };
  config.defectTypes.push(defectType);
  await writeDefectConfig(config);

  res.json({ message: 'Defect type created successfully', defectType });
});

app.put('/api/defect-types/:id', requireLogin, requireDefectCategoryAccess, async (req, res) => {
  const { id } = req.params;
  const { name, severity = 'minor', active = true } = req.body;
  const config = readDefectConfig();
  const defectType = (config.defectTypes || []).find(type => String(type.id) === String(id));

  if (!defectType) {
    return res.status(404).json({ error: 'Defect type not found' });
  }

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Defect type name is required' });
  }

  defectType.name = name.trim();
  defectType.severity = normalizeDefectSeverity(severity);
  defectType.active = Boolean(active);
  await writeDefectConfig(config);

  res.json({ message: 'Defect type updated successfully', defectType });
});

app.delete('/api/defect-types/:id', requireLogin, requireDefectCategoryAccess, async (req, res) => {
  const { id } = req.params;
  const config = readDefectConfig();
  const index = (config.defectTypes || []).findIndex(type => String(type.id) === String(id));

  if (index === -1) {
    return res.status(404).json({ error: 'Defect type not found' });
  }

  const [defectType] = config.defectTypes.splice(index, 1);
  await writeDefectConfig(config);

  res.json({ message: 'Defect type deleted successfully', defectType });
});

app.get('/api/defect-areas', requireLogin, async (req, res) => {
  const config = readDefectConfig();
  res.json((config.defectAreas || []).filter(area => area.active !== false));
});

app.post('/api/defect-areas', requireLogin, requireDefectCategoryAccess, async (req, res) => {
  const { name, active = true } = req.body;
  const config = readDefectConfig();
  config.defectAreas = config.defectAreas || [];

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Defect area name is required' });
  }

  const defectArea = { id: generateNumericId(config.defectAreas), name: name.trim(), active: Boolean(active) };
  config.defectAreas.push(defectArea);
  await writeDefectConfig(config);

  res.json({ message: 'Defect area created successfully', defectArea });
});

app.put('/api/defect-areas/:id', requireLogin, requireDefectCategoryAccess, async (req, res) => {
  const { id } = req.params;
  const { name, active = true } = req.body;
  const config = readDefectConfig();
  const defectArea = (config.defectAreas || []).find(area => String(area.id) === String(id));

  if (!defectArea) {
    return res.status(404).json({ error: 'Defect area not found' });
  }

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Defect area name is required' });
  }

  defectArea.name = name.trim();
  delete defectArea.severity;
  defectArea.active = Boolean(active);
  await writeDefectConfig(config);

  res.json({ message: 'Defect area updated successfully', defectArea });
});

app.delete('/api/defect-areas/:id', requireLogin, requireDefectCategoryAccess, async (req, res) => {
  const { id } = req.params;
  const config = readDefectConfig();
  const index = (config.defectAreas || []).findIndex(area => String(area.id) === String(id));

  if (index === -1) {
    return res.status(404).json({ error: 'Defect area not found' });
  }

  const [defectArea] = config.defectAreas.splice(index, 1);
  await writeDefectConfig(config);

  res.json({ message: 'Defect area deleted successfully', defectArea });
});

app.post('/api/users', requireLogin, requireAdmin, async (req, res) => {
  const { username, password, name, line, role } = req.body;
  const usersData = readUsersData();
  const allowedRoles = ['admin', 'admin_operator_sewing', 'admin_operator_qc', 'ppic', 'operator'];

  if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'Role tidak valid' });
  if (typeof username !== 'string' || !username.trim()) return res.status(400).json({ error: 'Username is required' });
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Password is required' });
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const normalizedUsername = username.trim();

  if (usersData.users.find(u => u.username === normalizedUsername)) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  const newId = generateUserId(usersData.users);

  const newUser = {
    id: newId,
    username: normalizedUsername,
    password: hashPassword(password),
    name: name.trim(),
    line,
    role,
    sessionVersion: 1
  };

  usersData.users.push(newUser);
  await writeUsersData(usersData);

  const { password: _, ...userWithoutPassword } = newUser;
  
  res.json({ 
    message: 'User created successfully',
    user: userWithoutPassword
  });
});

app.put('/api/users/:id', requireLogin, requireAdmin, async (req, res) => {
  const userId = parseNonNegativeInteger(req.params.id);
  const { username, password, name, line, role } = req.body;
  const usersData = readUsersData();
  const allowedRoles = ['admin', 'admin_operator_sewing', 'admin_operator_qc', 'ppic', 'operator'];

  if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'Role tidak valid' });
  if (typeof username !== 'string' || !username.trim()) return res.status(400).json({ error: 'Username is required' });
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const normalizedUsername = username.trim();

  const userIndex = usersData.users.findIndex(u => u.id === userId);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (usersData.users.find(u => u.username === normalizedUsername && u.id !== userId)) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  usersData.users[userIndex] = {
    ...usersData.users[userIndex],
    username: normalizedUsername,
    name: name.trim(),
    line,
    role,
    sessionVersion: (Number(usersData.users[userIndex].sessionVersion) || 1) + 1
  };

  if (password && password.trim() !== '') {
    usersData.users[userIndex].password = hashPassword(password);
  }

  await writeUsersData(usersData);
  if (req.session.user?.id === userId) {
    req.session.user = buildSessionUser(usersData.users[userIndex]);
  }

  const { password: _, ...userWithoutPassword } = usersData.users[userIndex];
  
  res.json({ 
    message: 'User updated successfully',
    user: userWithoutPassword
  });
});

app.delete('/api/users/:id', requireLogin, requireAdmin, async (req, res) => {
  const userId = parseNonNegativeInteger(req.params.id);
  const usersData = readUsersData();

  const userIndex = usersData.users.findIndex(u => u.id === userId);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (req.session.user.id === userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  const deletedUser = usersData.users.splice(userIndex, 1)[0];
  await writeUsersData(usersData);

  const { password: _, ...userWithoutPassword } = deletedUser;
  
  res.json({ 
    message: 'User deleted successfully',
    user: userWithoutPassword
  });
});

app.get('/public-display', async (req, res) => {
  res.sendFile(path.join(viewsDir, 'public-display.html'));
});

// Frontend SPA routes. Legacy pages such as /admin, /leader, /line/:line,
// and /input/:line now use the Alpine/Tailwind dashboard entry point.
app.get(['/admin', '/leader', '/line/:lineName', '/input/:lineName'], async (req, res) => {
  res.sendFile(path.join(viewsDir, 'index.html'));
});

app.get('/', async (req, res) => {
  res.sendFile(path.join(viewsDir, 'index.html'));
});

app.use((error, req, res, next) => {
  logger.error('Unhandled request error:', error);
  if (res.headersSent) return next(error);

  if (req.path.startsWith('/api/')) {
    if (error?.status === 413 || error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'File terlalu besar. Maksimal 10 MB.' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(500).send('Internal server error');
});

async function startServer() {
  await initSequelizeStorage();
  await sessionStore.ensureReady();
  initializeDataFiles();
  startDatabaseBackupCleanupWorker();
  lastScheduledDatabaseBackupDate = listDatabaseBackupFiles()
    .find(backup => backup.label === 'daily')?.date || '';

  setInterval(async () => {
    if (isDatabaseRestoreInProgress()) return;

    const now = new Date();
    const today = getToday();
    
    // Cek dan reset data untuk hari baru
    checkAndResetDataForNewDay();
    
    // Satu backup database konsisten per hari pada 00:01 WIB.
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    if (utcHours === 17 && utcMinutes === 1 && lastScheduledDatabaseBackupDate !== today) {
      try {
        await createDatabaseBackup('daily');
        lastScheduledDatabaseBackupDate = today;
      } catch (error) {
        logger.error('Daily database backup failed', error);
      }
    }
  }, 60000); // Check every minute

  // Check for date reset on startup dengan delay
  setTimeout(() => {
    checkAndResetDataForNewDay();
  }, 10000); // Increase delay to 10 seconds

  // Sinkronkan snapshot harian saat startup tanpa membuat arsip baru.
  setTimeout(() => {
    updateTodayBackup();
  }, 15000);

  app.listen(port, () => {
    logger.info(`Server berjalan di http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  buildPublicModelResponse,
  calculateDefectSeverityBreakdown,
  buildDateReportRows,
  buildProductionReportRows,
  classifyLegacySnapshot,
  extractHistoryDate,
  filterProductionDataByDate,
  filterProductionDataByLine,
  generateModelId,
  generateDateReportPdf,
  generateLineDetailPdf,
  generateStyledDateReportExcel,
  getToday,
  hasDateReportAccess,
  hashPassword,
  hashPasswordAsync,
  initSequelizeStorage,
  isValidDateInput,
  isValidDateRange,
  isModelActiveInManagement,
  restoreProductionSnapshot,
  mergeProductionSnapshotsByDate,
  filterMaterialOrderReportRows,
  buildMaterialOrderCumulativeOutputs,
  buildMaterialOrderProductionTotals,
  deriveMaterialOrderProgressStatus,
  summarizeMaterialOrderReport,
  generateMaterialOrderReportExcel,
  generateMaterialOrderReportPdf,
  normalizeMaterialOrderRecord,
  validateMaterialOrderInput,
  isValidProductionSnapshot,
  isBlankInputValue,
  parseNonNegativeInteger,
  normalizeLineName,
  normalizeLabelWeek,
  normalizeLabelWeekKey,
  normalizeModelName,
  resolveActiveDefectCategories,
  parseProductionImportRows,
  parseProductionImportWorkbook,
  parseSewingImportWorkbook,
  parseQcImportWorkbook,
  buildImportedProductionModel,
  buildImportedSewingModel,
  applyImportedQcData,
  productionImportTemplateWorkbook,
  sewingImportTemplateWorkbook,
  qcImportTemplateWorkbook,
  pruneDatabaseBackups,
  readProductionData,
  readProductionSnapshotForDate,
  recoverProductionSnapshotsFromDatabaseBackups,
  restoreDatabaseBackupFile,
  validateDatabaseBackupForRestore,
  sequelize,
  summarizeProductionSnapshot,
  summarizeProductionSnapshotByLine,
  sessionStore,
  startServer,
  updateTodayBackup,
  verifyPassword,
  verifyPasswordAsync,
  writeProductionData,
  writeUsersData,
  writeWorkScheduleSettings
};
