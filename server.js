const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3');
const { Sequelize, DataTypes } = require('sequelize');

function loadLocalEnvironment() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) return;

    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[match[1]] = value;
  });
}

loadLocalEnvironment();

const app = express();
const port = process.env.PORT || 3000;
const databasePath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'production-dashboard.sqlite'));
const databaseBackupDir = path.resolve(process.env.DATABASE_BACKUP_DIR || path.join(__dirname, 'database-backups'));
const legacyHistoryDir = path.resolve(process.env.LEGACY_HISTORY_DIR || path.join(__dirname, 'history'));
const bootstrapCredentialsPath = path.join(databaseBackupDir, 'bootstrap-credentials.json');
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: databasePath,
  logging: false
});
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
let productionDataCache = { lines: {}, activeLine: '' };
let usersDataCache = { users: [] };
let defectConfigCache = { defectTypes: [], defectAreas: [] };
let publicDisplaySettingsCache = {};
let workScheduleSettingsCache = {};
let materialOrdersCache = { orders: [] };
const productionSnapshotCache = new Map();
const productionImportPreviewCache = new Map();
let databaseInitialized = false;
const appDataWriteQueues = new Map();
let snapshotWriteQueue = Promise.resolve();
const DATABASE_BACKUP_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.DATABASE_BACKUP_RETENTION_DAYS || process.env.DATABASE_BACKUP_RETENTION) || 7
);
const DATABASE_BACKUP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
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
let databaseBackupCleanupRunning = false;
let databaseRestoreInProgress = false;
const loginRateLimitEntries = new Map();

function normalizeLogMessage(message) {
  return String(message || '')
    .replace(/[^\x20-\x7E]+/g, '')
    .replace(/^\s*(ERROR|WARNING)\s*:?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function logMessage(level, message) {
  return `[${new Date().toISOString()}] [${level}] ${normalizeLogMessage(message)}`;
}

const logger = {
  info(message, ...details) {
    console.log(logMessage('INFO', message), ...details);
  },
  warn(message, ...details) {
    console.warn(logMessage('WARN', message), ...details);
  },
  error(message, error) {
    if (typeof error === 'undefined') {
      console.error(logMessage('ERROR', message));
      return;
    }

    console.error(logMessage('ERROR', message), error instanceof Error ? (error.stack || error.message) : error);
  }
};

function parseBooleanEnvironment(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseTrustProxySetting(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  if (['true', 'yes', 'on'].includes(normalized.toLowerCase())) return 1;
  return normalized;
}

function sessionExpiryTimestamp(sessionData) {
  const expires = sessionData?.cookie?.expires;
  if (expires) {
    const timestamp = new Date(expires).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }

  const maxAge = Number(sessionData?.cookie?.maxAge);
  return Date.now() + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 24 * 60 * 60 * 1000);
}

// Keep sessions in the application database without restoring stale sessions from backups.
class SQLiteSessionStore extends session.Store {
  constructor(databaseFile) {
    super();
    this.databaseFile = databaseFile;
    this.database = null;
    this.readyPromise = null;
    this.cleanupTimer = setInterval(() => this.pruneExpired(() => {}), 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  ensureReady() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(this.databaseFile), { recursive: true });
      const database = new sqlite3.Database(this.databaseFile, error => {
        if (error) return reject(error);
        database.configure('busyTimeout', 15000);
        return database.run(
          `CREATE TABLE IF NOT EXISTS sessions (
             sid TEXT PRIMARY KEY,
             sess TEXT NOT NULL,
             expires INTEGER NOT NULL
           )`,
          createError => {
            if (createError) return reject(createError);
            this.database = database;
            return database.run(
              'CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires)',
              indexError => indexError ? reject(indexError) : resolve(database)
            );
          }
        );
      });
    }).catch(error => {
      this.readyPromise = null;
      throw error;
    });
    return this.readyPromise;
  }

  get(sid, callback) {
    this.ensureReady().then(database => {
      database.get('SELECT sess, expires FROM sessions WHERE sid = ?', [sid], (error, row) => {
        if (error) return callback(error);
        if (!row) return callback(null, null);
        if (Number(row.expires) <= Date.now()) {
          return database.run('DELETE FROM sessions WHERE sid = ?', [sid], deleteError => callback(deleteError || null, null));
        }
        try {
          return callback(null, JSON.parse(row.sess));
        } catch (parseError) {
          return database.run('DELETE FROM sessions WHERE sid = ?', [sid], () => callback(parseError));
        }
      });
    }).catch(callback);
  }

  set(sid, sessionData, callback = () => {}) {
    let payload;
    try {
      payload = JSON.stringify(sessionData);
    } catch (error) {
      callback(error);
      return;
    }
    const expires = sessionExpiryTimestamp(sessionData);
    this.ensureReady().then(database => {
      database.run(
        `INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
        [sid, payload, expires],
        callback
      );
    }).catch(callback);
  }

  touch(sid, sessionData, callback = () => {}) {
    const expires = sessionExpiryTimestamp(sessionData);
    this.ensureReady().then(database => {
      database.run('UPDATE sessions SET expires = ? WHERE sid = ?', [expires, sid], callback);
    }).catch(callback);
  }

  destroy(sid, callback = () => {}) {
    this.ensureReady().then(database => {
      database.run('DELETE FROM sessions WHERE sid = ?', [sid], callback);
    }).catch(callback);
  }

  clear(callback = () => {}) {
    this.ensureReady().then(database => {
      database.run('DELETE FROM sessions', callback);
    }).catch(callback);
  }

  length(callback) {
    this.ensureReady().then(database => {
      database.get('SELECT COUNT(*) AS count FROM sessions WHERE expires > ?', [Date.now()], (error, row) => {
        callback(error, row?.count || 0);
      });
    }).catch(callback);
  }

  pruneExpired(callback = () => {}) {
    this.ensureReady().then(database => {
      database.run('DELETE FROM sessions WHERE expires <= ?', [Date.now()], callback);
    }).catch(callback);
  }

  close(callback = () => {}) {
    clearInterval(this.cleanupTimer);
    if (!this.database) {
      callback();
      return;
    }
    const database = this.database;
    this.database = null;
    this.readyPromise = null;
    database.close(callback);
  }
}

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
app.use('/public', express.static(path.join(__dirname, 'public')));

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
  if (databaseRestoreInProgress && req.method !== 'GET') {
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

function hashPassword(password) {
  return bcrypt.hashSync(String(password), 12);
}

function verifyPassword(password, hashedPassword) {
  if (typeof hashedPassword !== 'string') return false;
  if (hashedPassword.startsWith('$2')) {
    return bcrypt.compareSync(String(password), hashedPassword);
  }

  if (/^[a-f0-9]{64}$/i.test(hashedPassword)) {
    return crypto.createHash('sha256').update(String(password)).digest('hex') === hashedPassword;
  }

  return false;
}

function verifyPasswordAsync(password, hashedPassword) {
  if (typeof hashedPassword !== 'string' || !hashedPassword.startsWith('$2')) {
    return Promise.resolve(verifyPassword(password, hashedPassword));
  }

  return new Promise((resolve, reject) => {
    bcrypt.compare(String(password), hashedPassword, (error, matches) => {
      if (error) return reject(error);
      return resolve(matches);
    });
  });
}

function hashPasswordAsync(password) {
  return new Promise((resolve, reject) => {
    bcrypt.hash(String(password), 12, (error, hash) => {
      if (error) return reject(error);
      return resolve(hash);
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

function normalizeRequiredText(value, label, maxLength) {
  if (typeof value !== 'string') return { value: '', error: `${label} wajib diisi` };
  const normalized = value.trim();
  if (!normalized) return { value: '', error: `${label} wajib diisi` };
  if (normalized.length > maxLength) return { value: '', error: `${label} terlalu panjang` };
  return { value: normalized, error: '' };
}

function normalizeLineName(value) {
  const result = normalizeRequiredText(value, 'Nama line', 100);
  if (result.error) return result;
  if (/[\\/\0]/.test(result.value) || ['__proto__', 'constructor', 'prototype'].includes(result.value.toLowerCase())) {
    return { value: '', error: 'Nama line tidak valid' };
  }
  return result;
}

function normalizeModelName(value) {
  return normalizeRequiredText(value, 'Nama model', 300);
}

function isLegacySha256PasswordHash(hashedPassword) {
  return typeof hashedPassword === 'string' && /^[a-f0-9]{64}$/i.test(hashedPassword);
}

function normalizeRole(role) {
  return role === 'admin_operator' ? 'admin_operator_sewing' : role;
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

function parseNonNegativeInteger(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function isBlankInputValue(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function isValidDateInput(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
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

const QC_IMPORT_HOURS = createHourlyData(0).map(hour => hour.hour);

function distributeImportTotal(total) {
  const value = Math.max(0, parseInt(total) || 0);
  const base = Math.floor(value / PRODUCTION_HOURS.length);
  const remainder = value % PRODUCTION_HOURS.length;
  return PRODUCTION_HOURS.map((hour, index) => ({ hour, value: base + (index < remainder ? 1 : 0) }));
}

function normalizeProductionImportDate(value) {
  let parts = null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    parts = {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate()
    };
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) parts = { year: parsed.y, month: parsed.m, day: parsed.d };
  } else {
    const text = String(value || '').trim();
    let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    } else {
      match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
      if (match) parts = { year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) };
    }
  }

  if (!parts) return '';
  const normalized = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  const candidate = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(candidate.getTime())
    || candidate.getUTCFullYear() !== parts.year
    || candidate.getUTCMonth() + 1 !== parts.month
    || candidate.getUTCDate() !== parts.day) return '';
  return normalized;
}

function normalizeProductionImportHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const PRODUCTION_IMPORT_HEADER_ALIASES = {
  date: ['tanggal', 'date'], line: ['line', 'linename', 'namaline'], labelWeek: ['labelweek', 'label', 'week'],
  model: ['model', 'namamodel'], target: ['target'], output: ['output', 'hasilproduksi', 'totaloutput'],
  qcChecked: ['qcdiperiksa', 'qcchecked', 'qcchecking', 'totalqc'], defect: ['totaldefect', 'defect', 'actualdefect'],
  criticalDefect: ['defectcritical', 'criticaldefect', 'critical'], majorDefect: ['defectmajor', 'majordefect', 'major'],
  minorDefect: ['defectminor', 'minordefect', 'minor'], defectAreas: ['defectarea', 'areadefect'],
  defectTypes: ['jenisdefect', 'defecttype', 'defecttypes'], notes: ['catatan', 'notes', 'keterangan']
};

function findProductionImportHeaderIndexes(headerRow) {
  const normalizedHeaders = headerRow.map(normalizeProductionImportHeader);
  return Object.fromEntries(Object.entries(PRODUCTION_IMPORT_HEADER_ALIASES).map(([field, aliases]) => [
    field, normalizedHeaders.findIndex(header => aliases.includes(header))
  ]));
}

function parseProductionImportInteger(value, label, errors, options = {}) {
  const blank = value === undefined || value === null || String(value).trim() === '';
  if (blank && options.optional) return null;
  if (blank) {
    errors.push(`${label} wajib diisi`);
    return 0;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    errors.push(`${label} harus berupa bilangan bulat tidak negatif`);
    return 0;
  }
  return number;
}

function normalizeProductionImportText(value, label, errors, options = {}) {
  const text = String(value || '').trim();
  if (!text && options.required) errors.push(`${label} wajib diisi`);
  if (text.length > (options.maxLength || 300)) errors.push(`${label} terlalu panjang`);
  return text;
}

function parseProductionImportCategories(value, label, errors) {
  const text = String(value ?? '').trim();
  if (!text || text === '-') return [];
  if (text.length > 2000) {
    errors.push(`${label} terlalu panjang`);
    return [];
  }
  const entries = [];
  text.replace(/[;\n]+/g, ',').split(',').map(item => item.trim()).filter(Boolean).forEach(item => {
    const countedMatch = item.match(/^(.*?)\s*\(\s*(\d+)\s*\)$/);
    if (!countedMatch && /[()]/.test(item)) {
      errors.push(`${label} tidak valid: "${item}". Gunakan format Nama (Qty)`);
      return;
    }
    const alternateMatch = countedMatch ? null : item.match(/^(.*?)\s*[:=xX]\s*(\d+)$/);
    const name = String(countedMatch?.[1] ?? alternateMatch?.[1] ?? item).trim();
    const quantity = Number(countedMatch?.[2] ?? alternateMatch?.[2] ?? '1');
    if (!name || name.length > 300 || !Number.isInteger(quantity) || quantity <= 0) {
      errors.push(`${label} tidak valid: "${item}". Gunakan format Nama (Qty)`);
      return;
    }
    const existing = entries.find(entry => normalizeDefectKey(entry.name) === normalizeDefectKey(name));
    if (existing) existing.quantity += quantity;
    else entries.push({ name, quantity });
  });
  return entries;
}

function formatProductionImportCategories(entries = []) {
  return entries.length
    ? entries.map(entry => `${entry.name} (${entry.quantity})`).join(', ')
    : '-';
}

function productionImportCategoryTotal(entries = []) {
  return entries.reduce((total, entry) => total + (parseInt(entry.quantity) || 0), 0);
}

const PRODUCTION_IMPORT_HOURLY_HEADER_ALIASES = {
  date: ['tanggal', 'date'], line: ['line', 'linename', 'namaline'], labelWeek: ['labelweek', 'label', 'week'],
  model: ['model', 'namamodel'], hour: ['jam', 'hour', 'waktu'], targetManual: ['targetmanual', 'targetperjam', 'target'],
  output: ['output', 'hasilproduksi', 'totaloutput'], qcChecked: ['qcdiperiksa', 'qcchecked', 'qcchecking', 'totalqc'],
  defect: ['totaldefect', 'defect', 'actualdefect']
};

function findProductionImportHourlyHeaderIndexes(headerRow) {
  const normalizedHeaders = headerRow.map(normalizeProductionImportHeader);
  return Object.fromEntries(Object.entries(PRODUCTION_IMPORT_HOURLY_HEADER_ALIASES).map(([field, aliases]) => [
    field, normalizedHeaders.findIndex(header => aliases.includes(header))
  ]));
}

function productionImportIdentity(row) {
  return [row.date, row.line, row.labelWeek, row.model]
    .map(value => String(value || '').trim().toLowerCase())
    .join('|');
}

function findExistingProductionImportModel(snapshot, row) {
  const models = snapshot?.lines?.[row.line]?.models || {};
  const rowLabel = String(row.labelWeek || '').trim().toLowerCase();
  const rowModel = String(row.model || '').trim().toLowerCase();
  return Object.entries(models).filter(([, model]) => {
    const modelName = String(model?.model || '').trim().toLowerCase();
    const modelLabel = String(model?.labelWeek || '').trim().toLowerCase();
    return modelName === rowModel && modelLabel === rowLabel;
  });
}

function parseProductionImportRows(sheetRows, options = {}) {
  const today = options.today || getToday();
  const getSnapshot = options.getSnapshot || readProductionSnapshotForDate;
  if (!Array.isArray(sheetRows) || sheetRows.length === 0) {
    return { rows: [], summary: { total: 0, valid: 0, invalid: 0, warnings: 0, newRecords: 0, replacements: 0, dates: 0 } };
  }

  const headerIndexes = findProductionImportHeaderIndexes(sheetRows[0] || []);
  const requiredHeaders = ['date', 'line', 'model', 'target', 'output', 'qcChecked', 'defect'];
  const missingHeaders = requiredHeaders.filter(field => headerIndexes[field] < 0);
  if (missingHeaders.length > 0) {
    const labels = {
      date: 'Tanggal', line: 'Line', model: 'Model', target: 'Target', output: 'Output',
      qcChecked: 'QC Diperiksa', defect: 'Total Defect'
    };
    const error = `Kolom wajib tidak ditemukan: ${missingHeaders.map(field => labels[field]).join(', ')}`;
    return {
      rows: [{ rowNumber: 1, action: 'invalid', errors: [error], warnings: [] }],
      summary: { total: 0, valid: 0, invalid: 1, warnings: 0, newRecords: 0, replacements: 0, dates: 0 }
    };
  }

  const dataRows = sheetRows.slice(1)
    .map((cells, index) => ({ cells, rowNumber: index + 2 }))
    .filter(({ cells }) => Array.isArray(cells) && cells.some(value => String(value ?? '').trim() !== ''));

  if (dataRows.length > PRODUCTION_IMPORT_MAX_ROWS) {
    return {
      rows: [{ rowNumber: 1, action: 'invalid', errors: [`Maksimal ${PRODUCTION_IMPORT_MAX_ROWS} baris data per import`], warnings: [] }],
      summary: { total: dataRows.length, valid: 0, invalid: dataRows.length, warnings: 0, newRecords: 0, replacements: 0, dates: 0 }
    };
  }

  const rows = dataRows.map(({ cells, rowNumber }) => {
    const errors = [];
    const warnings = [];
    const value = field => headerIndexes[field] >= 0 ? cells[headerIndexes[field]] : '';
    const date = normalizeProductionImportDate(value('date'));
    if (!date) errors.push('Tanggal tidak valid. Gunakan format YYYY-MM-DD');
    else if (date >= today) errors.push(`Tanggal harus sebelum tanggal operasional hari ini (${today})`);

    const row = {
      rowNumber,
      date,
      line: normalizeProductionImportText(value('line'), 'Line', errors, { required: true, maxLength: 100 }),
      labelWeek: normalizeProductionImportText(value('labelWeek'), 'Label/Week', errors, { maxLength: 150 }),
      model: normalizeProductionImportText(value('model'), 'Model', errors, { required: true, maxLength: 300 }),
      target: parseProductionImportInteger(value('target'), 'Target', errors),
      output: parseProductionImportInteger(value('output'), 'Output', errors),
      qcChecked: parseProductionImportInteger(value('qcChecked'), 'QC Diperiksa', errors),
      defect: parseProductionImportInteger(value('defect'), 'Total Defect', errors),
      criticalDefect: parseProductionImportInteger(value('criticalDefect'), 'Defect Critical', errors, { optional: true }),
      majorDefect: parseProductionImportInteger(value('majorDefect'), 'Defect Major', errors, { optional: true }),
      minorDefect: parseProductionImportInteger(value('minorDefect'), 'Defect Minor', errors, { optional: true }),
      defectAreas: parseProductionImportCategories(value('defectAreas'), 'Defect Area', errors),
      defectTypes: parseProductionImportCategories(value('defectTypes'), 'Jenis Defect', errors),
      notes: normalizeProductionImportText(value('notes'), 'Catatan', errors, { maxLength: 500 }),
      action: 'new',
      existingModelId: '',
      errors,
      warnings
    };

    if (row.defect > row.qcChecked) errors.push('Total Defect tidak boleh lebih besar dari QC Diperiksa');
    const severityValues = [row.criticalDefect, row.majorDefect, row.minorDefect];
    if (severityValues.some(item => item !== null)) {
      const severityTotal = severityValues.reduce((total, item) => total + (item || 0), 0);
      if (severityTotal !== row.defect) errors.push('Jumlah Defect Critical, Major, dan Minor harus sama dengan Total Defect');
      row.criticalDefect = row.criticalDefect || 0;
      row.majorDefect = row.majorDefect || 0;
      row.minorDefect = row.minorDefect || 0;
    } else {
      row.criticalDefect = 0;
      row.majorDefect = 0;
      row.minorDefect = row.defect;
      if (row.defect > 0) warnings.push('Rincian severity kosong; seluruh defect akan dicatat sebagai Minor');
    }

    const defectAreaTotal = productionImportCategoryTotal(row.defectAreas);
    const defectTypeTotal = productionImportCategoryTotal(row.defectTypes);
    if (row.defectAreas.length > 0 && defectAreaTotal !== row.defect) {
      errors.push('Jumlah Qty pada Defect Area harus sama dengan Total Defect');
    }
    if (row.defectTypes.length > 0 && defectTypeTotal !== row.defect) {
      errors.push('Jumlah Qty pada Jenis Defect harus sama dengan Total Defect');
    }
    if (row.defect > 0 && row.defectAreas.length === 0 && row.defectTypes.length > 0) {
      warnings.push('Defect Area kosong; report area defect akan menampilkan -');
    }
    if (row.defect > 0 && row.defectTypes.length === 0 && row.defectAreas.length > 0) {
      warnings.push('Jenis Defect kosong; report jenis defect akan menampilkan -');
    }
    row.defectAreaSummary = formatProductionImportCategories(row.defectAreas);
    row.defectTypeSummary = formatProductionImportCategories(row.defectTypes);
    return row;
  });

  const rowsByIdentity = new Map();
  rows.forEach(row => {
    if (!row.date || !row.line || !row.model) return;
    const key = productionImportIdentity(row);
    const duplicates = rowsByIdentity.get(key) || [];
    duplicates.push(row);
    rowsByIdentity.set(key, duplicates);
  });
  rowsByIdentity.forEach(duplicates => {
    if (duplicates.length < 2) return;
    duplicates.forEach(row => row.errors.push('Data tanggal, line, label/week, dan model terduplikasi di file'));
  });

  const snapshots = new Map();
  rows.forEach(row => {
    if (row.errors.length > 0 || !row.date) {
      row.action = 'invalid';
      return;
    }
    if (!snapshots.has(row.date)) snapshots.set(row.date, getSnapshot(row.date));
    const matches = findExistingProductionImportModel(snapshots.get(row.date), row);
    if (matches.length > 1) {
      row.errors.push('Ada lebih dari satu data existing dengan identitas yang sama; rapikan data sebelum import');
      row.action = 'invalid';
    } else if (matches.length === 1) {
      row.action = 'replace';
      row.existingModelId = matches[0][0];
      row.warnings.push('Data existing akan diganti setelah konfirmasi');
    }
  });

  return { rows, summary: summarizeProductionImportRows(rows) };
}

function summarizeProductionImportRows(rows = []) {
  return {
    total: rows.length,
    valid: rows.filter(row => row.errors.length === 0).length,
    invalid: rows.filter(row => row.errors.length > 0).length,
    warnings: rows.reduce((total, row) => total + row.warnings.length, 0),
    newRecords: rows.filter(row => row.errors.length === 0 && row.action === 'new').length,
    replacements: rows.filter(row => row.errors.length === 0 && row.action === 'replace').length,
    dates: new Set(rows.filter(row => row.errors.length === 0).map(row => row.date)).size
  };
}

function parseProductionImportHourlySheet(sheetRows, summaryRows) {
  if (!Array.isArray(sheetRows) || sheetRows.length === 0) return { issues: [] };
  const headerIndexes = findProductionImportHourlyHeaderIndexes(sheetRows[0] || []);
  const requiredHeaders = ['date', 'line', 'model', 'hour', 'targetManual', 'output', 'qcChecked', 'defect'];
  const missingHeaders = requiredHeaders.filter(field => headerIndexes[field] < 0);
  if (missingHeaders.length > 0) {
    return {
      issues: [{
        rowNumber: 'Detail Per Jam!1',
        errors: [`Kolom wajib Detail Per Jam tidak ditemukan: ${missingHeaders.join(', ')}`],
        warnings: []
      }]
    };
  }

  const dataRows = sheetRows.slice(1)
    .map((cells, index) => ({ cells, rowNumber: index + 2 }))
    .filter(({ cells }) => Array.isArray(cells) && cells.some(value => String(value ?? '').trim() !== ''));
  if (dataRows.length > PRODUCTION_IMPORT_MAX_ROWS * 9) {
    return {
      issues: [{
        rowNumber: 'Detail Per Jam!1',
        errors: [`Maksimal ${PRODUCTION_IMPORT_MAX_ROWS * 9} baris Detail Per Jam per import`],
        warnings: []
      }]
    };
  }

  const rows = dataRows.map(({ cells, rowNumber }) => {
    const errors = [];
    const value = field => cells[headerIndexes[field]];
    const date = normalizeProductionImportDate(value('date'));
    if (!date) errors.push('Tanggal tidak valid. Gunakan format YYYY-MM-DD');
    const row = {
      rowNumber,
      date,
      line: normalizeProductionImportText(value('line'), 'Line', errors, { required: true, maxLength: 100 }),
      labelWeek: normalizeProductionImportText(value('labelWeek'), 'Label/Week', errors, { maxLength: 150 }),
      model: normalizeProductionImportText(value('model'), 'Model', errors, { required: true, maxLength: 300 }),
      hour: normalizeProductionImportText(value('hour'), 'Jam', errors, { required: true, maxLength: 50 }),
      targetManual: parseProductionImportInteger(value('targetManual'), 'Target Manual', errors),
      output: parseProductionImportInteger(value('output'), 'Output', errors),
      qcChecked: parseProductionImportInteger(value('qcChecked'), 'QC Checked', errors),
      defect: parseProductionImportInteger(value('defect'), 'Total Defect', errors),
      errors,
      warnings: []
    };
    if (!createHourlyData(0).some(hour => hour.hour === row.hour)) {
      errors.push(`Jam tidak dikenal: ${row.hour}`);
    }
    if (row.defect > row.qcChecked) errors.push('Total Defect tidak boleh lebih besar dari QC Checked');
    row.selisih = row.output - row.targetManual;
    return row;
  });

  const summaryByIdentity = new Map(summaryRows.map(row => [productionImportIdentity(row), row]));
  const grouped = new Map();
  rows.forEach(row => {
    const key = productionImportIdentity(row);
    const existing = grouped.get(key) || [];
    existing.push(row);
    grouped.set(key, existing);
  });
  const issues = [];
  rows.forEach(row => {
    const summary = summaryByIdentity.get(productionImportIdentity(row));
    if (!summary) {
      issues.push({
        rowNumber: `Detail Per Jam!${row.rowNumber}`,
        errors: [`Tidak ada baris summary yang cocok untuk tanggal, line, label/week, dan model`].concat(row.errors),
        warnings: []
      });
    }
  });

  grouped.forEach((hourRows, key) => {
    const summary = summaryByIdentity.get(key);
    if (!summary) return;
    if (hourRows.length !== new Set(hourRows.map(row => row.hour)).size) {
      summary.errors.push('Detail Per Jam memiliki jam yang terduplikasi untuk identitas yang sama');
    }
    hourRows.forEach(row => {
      if (row.errors.length > 0) summary.errors.push(`Detail Per Jam baris ${row.rowNumber}: ${row.errors.join('; ')}`);
    });
    if (hourRows.some(row => row.errors.length > 0)) return;

    const expectedHours = PRODUCTION_HOURS;
    const detailByHour = new Map(hourRows.map(row => [row.hour, row]));
    const missingHours = expectedHours.filter(hour => !detailByHour.has(hour));
    if (missingHours.length > 0) {
      summary.errors.push(`Detail Per Jam belum lengkap. Jam yang belum diisi: ${missingHours.join(', ')}`);
      return;
    }
    const hourlyData = createHourlyData(summary.target).map(hour => {
      const detail = detailByHour.get(hour.hour);
      return detail
        ? { hour: detail.hour, targetManual: detail.targetManual, output: detail.output, qcChecked: detail.qcChecked, defect: detail.defect, selisih: detail.selisih }
        : hour;
    });
    const totals = hourlyData.reduce((total, hour) => ({
      target: total.target + hour.targetManual,
      output: total.output + hour.output,
      qcChecked: total.qcChecked + hour.qcChecked,
      defect: total.defect + hour.defect
    }), { target: 0, output: 0, qcChecked: 0, defect: 0 });
    [['target', 'Target'], ['output', 'Output'], ['qcChecked', 'QC Checked'], ['defect', 'Total Defect']].forEach(([field, label]) => {
      if (totals[field] !== summary[field]) summary.errors.push(`Total ${label} pada Detail Per Jam harus sama dengan nilai summary`);
    });
    if (summary.errors.length === 0) summary.hourlyData = hourlyData;
  });

  return { issues };
}

function parseProductionImportWorkbook(buffer, options = {}) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames.find(name => normalizeProductionImportHeader(name) === 'dataproduksi')
    || workbook.SheetNames[0];
  if (!sheetName) throw new Error('Workbook tidak memiliki worksheet');
  const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
  const parsed = parseProductionImportRows(sheetRows, options);
  const hourlySheetName = workbook.SheetNames.find(name => normalizeProductionImportHeader(name) === 'detailperjam');
  if (hourlySheetName) {
    const hourlyRows = XLSX.utils.sheet_to_json(workbook.Sheets[hourlySheetName], { header: 1, defval: '', raw: true });
    const hourlyResult = parseProductionImportHourlySheet(hourlyRows, parsed.rows);
    hourlyResult.issues.forEach(issue => parsed.rows.push({ ...issue, action: 'invalid' }));
    parsed.summary = summarizeProductionImportRows(parsed.rows);
  }
  return parsed;
}

function pairProductionImportCategories(types = [], areas = [], totalDefect = 0) {
  const total = Math.max(parseInt(totalDefect) || 0, 0);
  if (total === 0) return [];

  const remainingTypes = (types.length ? types : [{ name: '', quantity: total }])
    .map(entry => ({ ...entry, quantity: parseInt(entry.quantity) || 0 }));
  const remainingAreas = (areas.length ? areas : [{ name: '', quantity: total }])
    .map(entry => ({ ...entry, quantity: parseInt(entry.quantity) || 0 }));
  const pairs = [];
  let typeIndex = 0;
  let areaIndex = 0;

  while (typeIndex < remainingTypes.length && areaIndex < remainingAreas.length) {
    const type = remainingTypes[typeIndex];
    const area = remainingAreas[areaIndex];
    const quantity = Math.min(type.quantity, area.quantity);
    if (quantity > 0) pairs.push({ type: type.name, area: area.name, quantity });
    type.quantity -= quantity;
    area.quantity -= quantity;
    if (type.quantity === 0) typeIndex += 1;
    if (area.quantity === 0) areaIndex += 1;
  }
  return pairs;
}

function applyProductionImportSeverities(details = [], row = {}) {
  const severityQueue = [
    { severity: 'critical', quantity: parseInt(row.criticalDefect) || 0 },
    { severity: 'major', quantity: parseInt(row.majorDefect) || 0 },
    { severity: 'minor', quantity: parseInt(row.minorDefect) || 0 }
  ];
  const result = [];
  let severityIndex = 0;

  details.forEach(detail => {
    let remaining = parseInt(detail.quantity) || 0;
    while (remaining > 0 && severityIndex < severityQueue.length) {
      const severity = severityQueue[severityIndex];
      if (severity.quantity === 0) {
        severityIndex += 1;
        continue;
      }
      const quantity = Math.min(remaining, severity.quantity);
      result.push({ ...detail, quantity, severity: severity.severity });
      remaining -= quantity;
      severity.quantity -= quantity;
    }
  });
  return result;
}

function distributeProductionImportDefectDetails(hourlyData, details) {
  const remainingDetails = details.map(detail => ({ ...detail, quantity: parseInt(detail.quantity) || 0 }));
  let detailIndex = 0;
  hourlyData.forEach(hour => {
    let remainingHourDefect = parseInt(hour.defect) || 0;
    hour.defectDetails = [];
    while (remainingHourDefect > 0 && detailIndex < remainingDetails.length) {
      const detail = remainingDetails[detailIndex];
      if (detail.quantity === 0) {
        detailIndex += 1;
        continue;
      }
      const quantity = Math.min(remainingHourDefect, detail.quantity);
      hour.defectDetails.push({ ...detail, quantity });
      remainingHourDefect -= quantity;
      detail.quantity -= quantity;
    }
  });
}

function buildImportedProductionModel(row, modelId) {
  const hourlyData = Array.isArray(row.hourlyData)
    ? row.hourlyData.map(hour => ({
      hour: hour.hour,
      output: parseInt(hour.output) || 0,
      defect: parseInt(hour.defect) || 0,
      qcChecked: parseInt(hour.qcChecked) || 0,
      targetManual: parseInt(hour.targetManual) || 0,
      selisih: (parseInt(hour.output) || 0) - (parseInt(hour.targetManual) || 0)
    }))
    : createHourlyData(row.target);
  const productiveIndexes = hourlyData
    .map((hour, index) => ({ hour, index }))
    .filter(item => item.hour.hour !== '11:00 - 13:00');

  if (!Array.isArray(row.hourlyData)) {
    const outputs = distributeImportTotal(row.output);
    const qcChecked = distributeImportTotal(row.qcChecked);
    const defects = distributeImportTotal(row.defect);
    productiveIndexes.forEach((item, productionIndex) => {
      item.hour.output = outputs[productionIndex].value;
      item.hour.qcChecked = qcChecked[productionIndex].value;
      item.hour.defect = defects[productionIndex].value;
      item.hour.selisih = item.hour.output - item.hour.targetManual;
    });
  }

  const categoryDetails = pairProductionImportCategories(row.defectTypes, row.defectAreas, row.defect);
  const defectDetails = categoryDetails.length > 0
    ? applyProductionImportSeverities(categoryDetails, row)
    : [
      { type: 'Import historis - Critical', area: 'Data lama', quantity: row.criticalDefect, severity: 'critical' },
      { type: 'Import historis - Major', area: 'Data lama', quantity: row.majorDefect, severity: 'major' },
      { type: 'Import historis - Minor', area: 'Data lama', quantity: row.minorDefect, severity: 'minor' }
    ].filter(detail => detail.quantity > 0);
  distributeProductionImportDefectDetails(hourlyData, defectDetails);

  return {
    id: modelId,
    labelWeek: row.labelWeek,
    model: row.model,
    date: row.date,
    target: row.target,
    targetPerHour: Math.round(row.target / PRODUCTION_HOURS.length),
    outputDay: row.output,
    qcChecking: row.qcChecked,
    actualDefect: row.defect,
    defectRatePercentage: row.qcChecked > 0 ? parseFloat(((row.defect / row.qcChecked) * 100).toFixed(2)) : 0,
    hourly_data: hourlyData,
    operators: [],
    notes: row.notes,
    importedHistoricalData: true
  };
}

function readImportSheetRows(buffer, normalizedSheetNames) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const acceptedNames = Array.isArray(normalizedSheetNames) ? normalizedSheetNames : [normalizedSheetNames];
  const sheetName = workbook.SheetNames.find(name => acceptedNames.includes(normalizeProductionImportHeader(name)))
    || workbook.SheetNames[0];
  if (!sheetName) throw new Error('Workbook tidak memiliki worksheet');
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
}

function parseSewingImportWorkbook(buffer, options = {}) {
  const today = options.today || getToday();
  const getSnapshot = options.getSnapshot || readProductionSnapshotForDate;
  const sheetRows = readImportSheetRows(buffer, ['dataproduksi', 'datasewing']);
  const aliases = {
    date: ['tanggal', 'date'], line: ['line', 'namaline'], labelWeek: ['labelweek', 'label', 'week'],
    model: ['model', 'namamodel'], hour: ['jam', 'hour'], targetManual: ['targetmanual', 'targetperjam', 'target'],
    output: ['output', 'hasilproduksi'], notes: ['catatan', 'notes', 'keterangan']
  };
  const normalizedHeaders = (sheetRows[0] || []).map(normalizeProductionImportHeader);
  const indexes = Object.fromEntries(Object.entries(aliases).map(([field, values]) => [
    field, normalizedHeaders.findIndex(header => values.includes(header))
  ]));
  const required = ['date', 'line', 'model', 'hour', 'targetManual', 'output'];
  const missing = required.filter(field => indexes[field] < 0);
  if (missing.length > 0) {
    return {
      rows: [{ rowNumber: 1, action: 'invalid', errors: [`Kolom wajib tidak ditemukan: ${missing.join(', ')}`], warnings: [] }],
      summary: summarizeProductionImportRows([{ rowNumber: 1, action: 'invalid', errors: ['Header tidak lengkap'], warnings: [] }])
    };
  }

  const rawRows = sheetRows.slice(1)
    .map((cells, index) => ({ cells, rowNumber: index + 2 }))
    .filter(({ cells }) => cells.some(value => String(value ?? '').trim() !== ''));
  if (rawRows.length > PRODUCTION_IMPORT_MAX_ROWS * PRODUCTION_HOURS.length) {
    const row = { rowNumber: 1, action: 'invalid', errors: ['Jumlah baris Data Produksi melebihi batas'], warnings: [] };
    return { rows: [row], summary: summarizeProductionImportRows([row]) };
  }

  const parsedHours = rawRows.map(({ cells, rowNumber }) => {
    const errors = [];
    const value = field => indexes[field] >= 0 ? cells[indexes[field]] : '';
    const date = normalizeProductionImportDate(value('date'));
    if (!date) errors.push('Tanggal tidak valid. Gunakan format YYYY-MM-DD');
    else if (date >= today) errors.push(`Tanggal harus sebelum tanggal operasional hari ini (${today})`);
    const row = {
      rowNumber,
      date,
      line: normalizeProductionImportText(value('line'), 'Line', errors, { required: true, maxLength: 100 }),
      labelWeek: normalizeProductionImportText(value('labelWeek'), 'Label/Week', errors, { maxLength: 150 }),
      model: normalizeProductionImportText(value('model'), 'Model', errors, { required: true, maxLength: 300 }),
      hour: normalizeProductionImportText(value('hour'), 'Jam', errors, { required: true, maxLength: 50 }),
      targetManual: parseProductionImportInteger(value('targetManual'), 'Target Manual', errors),
      output: parseProductionImportInteger(value('output'), 'Output', errors),
      notes: normalizeProductionImportText(value('notes'), 'Catatan', errors, { maxLength: 500 }),
      errors
    };
    if (!PRODUCTION_HOURS.includes(row.hour)) errors.push(`Jam tidak dikenal: ${row.hour}`);
    return row;
  });

  const grouped = new Map();
  parsedHours.forEach(hour => {
    const key = productionImportIdentity(hour);
    const items = grouped.get(key) || [];
    items.push(hour);
    grouped.set(key, items);
  });
  const snapshots = new Map();
  const rows = Array.from(grouped.values()).map(hours => {
    const first = hours[0];
    const errors = hours.flatMap(hour => hour.errors.map(error => `Baris ${hour.rowNumber}: ${error}`));
    const warnings = [];
    if (hours.length !== new Set(hours.map(hour => hour.hour)).size) errors.push('Jam produksi terduplikasi');
    const missingHours = PRODUCTION_HOURS.filter(hour => !hours.some(item => item.hour === hour));
    if (missingHours.length > 0) errors.push(`Jam produksi belum lengkap: ${missingHours.join(', ')}`);
    const hourlyData = createHourlyData(0).map(hour => {
      const imported = hours.find(item => item.hour === hour.hour);
      return imported
        ? { hour: imported.hour, targetManual: imported.targetManual, output: imported.output, selisih: imported.output - imported.targetManual, qcChecked: 0, defect: 0 }
        : hour;
    });
    const target = hourlyData.reduce((total, hour) => total + hour.targetManual, 0);
    const output = hourlyData.reduce((total, hour) => total + hour.output, 0);
    const row = {
      rowNumber: first.rowNumber,
      date: first.date,
      line: first.line,
      labelWeek: first.labelWeek,
      model: first.model,
      target,
      output,
      qcChecked: null,
      defect: null,
      hourlyData,
      notes: hours.map(hour => hour.notes).find(Boolean) || '',
      action: 'new',
      existingModelId: '',
      errors,
      warnings,
      importKind: 'sewing'
    };
    if (errors.length === 0 && row.date) {
      if (!snapshots.has(row.date)) snapshots.set(row.date, getSnapshot(row.date));
      const matches = findExistingProductionImportModel(snapshots.get(row.date), row);
      if (matches.length > 1) {
        row.errors.push('Ada lebih dari satu model existing dengan identitas yang sama');
      } else if (matches.length === 1) {
        row.action = 'replace';
        row.existingModelId = matches[0][0];
        row.warnings.push('Data produksi existing akan diperbarui; data QC tetap dipertahankan');
      }
    }
    if (row.errors.length > 0) row.action = 'invalid';
    return row;
  });
  if (rows.length > PRODUCTION_IMPORT_MAX_ROWS) {
    const row = { rowNumber: 1, action: 'invalid', errors: [`Maksimal ${PRODUCTION_IMPORT_MAX_ROWS} model per import`], warnings: [], importKind: 'sewing' };
    return { rows: [row], summary: summarizeProductionImportRows([row]) };
  }
  return { rows, summary: summarizeProductionImportRows(rows) };
}

function normalizeQcImportResult(value) {
  const result = String(value || '').trim().toLowerCase();
  if (['good', 'baik', 'ok'].includes(result)) return 'good';
  if (['defect', 'reject', 'ng'].includes(result)) return 'defect';
  return '';
}

function parseQcImportWorkbook(buffer, options = {}) {
  const today = options.today || getToday();
  const getSnapshot = options.getSnapshot || readProductionSnapshotForDate;
  const defectConfig = options.defectConfig || readDefectConfig();
  const severityMaps = buildDefectSeverityMaps(defectConfig);
  const sheetRows = readImportSheetRows(buffer, 'dataqc');
  const aliases = {
    date: ['tanggal', 'date'], line: ['line', 'namaline'], labelWeek: ['labelweek', 'label', 'week'],
    model: ['model', 'namamodel'], hour: ['jam', 'hour'], result: ['hasilqc', 'hasil', 'result'],
    quantity: ['qty', 'quantity', 'jumlah'], type: ['jenisdefect', 'defecttype'], area: ['defectarea', 'areadefect'],
    notes: ['catatan', 'notes', 'keterangan']
  };
  const normalizedHeaders = (sheetRows[0] || []).map(normalizeProductionImportHeader);
  const indexes = Object.fromEntries(Object.entries(aliases).map(([field, values]) => [
    field, normalizedHeaders.findIndex(header => values.includes(header))
  ]));
  const required = ['date', 'line', 'model', 'hour', 'result', 'quantity', 'type', 'area'];
  const missing = required.filter(field => indexes[field] < 0);
  if (missing.length > 0) {
    const row = { rowNumber: 1, action: 'invalid', errors: [`Kolom wajib tidak ditemukan: ${missing.join(', ')}`], warnings: [], importKind: 'qc' };
    return { rows: [row], summary: summarizeProductionImportRows([row]) };
  }

  const validTypes = new Map((defectConfig.defectTypes || [])
    .filter(type => type.active !== false)
    .map(type => [normalizeDefectKey(type.name), type]));
  const validAreas = new Map((defectConfig.defectAreas || [])
    .filter(area => area.active !== false)
    .map(area => [normalizeDefectKey(area.name), area]));
  const rawRows = sheetRows.slice(1)
    .map((cells, index) => ({ cells, rowNumber: index + 2 }))
    .filter(({ cells }) => cells.some(value => String(value ?? '').trim() !== ''));
  if (rawRows.length > PRODUCTION_IMPORT_MAX_ROWS * PRODUCTION_HOURS.length) {
    const row = { rowNumber: 1, action: 'invalid', errors: ['Jumlah baris Data QC melebihi batas'], warnings: [], importKind: 'qc' };
    return { rows: [row], summary: summarizeProductionImportRows([row]) };
  }

  const parsedEntries = rawRows.map(({ cells, rowNumber }) => {
    const errors = [];
    const warnings = [];
    const value = field => indexes[field] >= 0 ? cells[indexes[field]] : '';
    const date = normalizeProductionImportDate(value('date'));
    if (!date) errors.push('Tanggal tidak valid. Gunakan format YYYY-MM-DD');
    else if (date >= today) errors.push(`Tanggal harus sebelum tanggal operasional hari ini (${today})`);
    const result = normalizeQcImportResult(value('result'));
    if (!result) errors.push('Hasil QC harus Good atau Defect');
    const typeText = String(value('type') || '').trim();
    const areaText = String(value('area') || '').trim();
    const typeConfig = validTypes.get(normalizeDefectKey(typeText));
    const areaConfig = validAreas.get(normalizeDefectKey(areaText));
    const entry = {
      rowNumber,
      date,
      line: normalizeProductionImportText(value('line'), 'Line', errors, { required: true, maxLength: 100 }),
      labelWeek: normalizeProductionImportText(value('labelWeek'), 'Label/Week', errors, { maxLength: 150 }),
      model: normalizeProductionImportText(value('model'), 'Model', errors, { required: true, maxLength: 300 }),
      hour: normalizeProductionImportText(value('hour'), 'Jam', errors, { required: true, maxLength: 50 }),
      result,
      quantity: parseProductionImportInteger(value('quantity'), 'Qty', errors),
      type: typeText,
      area: areaText,
      notes: normalizeProductionImportText(value('notes'), 'Catatan', errors, { maxLength: 500 }),
      errors,
      warnings
    };
    if (entry.quantity === 0) errors.push('Qty harus lebih dari 0');
    if (!QC_IMPORT_HOURS.includes(entry.hour)) errors.push(`Jam tidak dikenal: ${entry.hour}`);
    if (result === 'defect') {
      if (!typeText || !typeConfig) errors.push('Jenis Defect wajib dipilih dari daftar aplikasi');
      if (!areaText || !areaConfig) errors.push('Defect Area wajib dipilih dari daftar aplikasi');
      entry.severity = getDefectSeverity(typeText, severityMaps);
    } else {
      entry.type = '';
      entry.area = '';
      entry.severity = '';
      if (typeText || areaText) warnings.push('Jenis dan area defect pada hasil Good diabaikan');
    }
    return entry;
  });

  const grouped = new Map();
  parsedEntries.forEach(entry => {
    const key = productionImportIdentity(entry);
    const items = grouped.get(key) || [];
    items.push(entry);
    grouped.set(key, items);
  });
  const snapshots = new Map();
  const rows = Array.from(grouped.values()).map(entries => {
    const first = entries[0];
    const errors = entries.flatMap(entry => entry.errors.map(error => `Baris ${entry.rowNumber}: ${error}`));
    const warnings = entries.flatMap(entry => entry.warnings.map(warning => `Baris ${entry.rowNumber}: ${warning}`));
    const hourlyQcData = createHourlyData(0).map(hour => {
      const hourEntries = entries.filter(entry => entry.hour === hour.hour && entry.errors.length === 0);
      const qcChecked = hourEntries.reduce((total, entry) => total + entry.quantity, 0);
      const defectEntries = hourEntries.filter(entry => entry.result === 'defect');
      return {
        hour: hour.hour,
        qcChecked,
        defect: defectEntries.reduce((total, entry) => total + entry.quantity, 0),
        defectDetails: defectEntries.map(entry => ({
          type: entry.type,
          area: entry.area,
          quantity: entry.quantity,
          severity: entry.severity,
          notes: entry.notes
        }))
      };
    });
    const defectDetails = hourlyQcData.flatMap(hour => hour.defectDetails);
    const defectTypes = [];
    const defectAreas = [];
    defectDetails.forEach(detail => {
      const type = defectTypes.find(item => normalizeDefectKey(item.name) === normalizeDefectKey(detail.type));
      if (type) type.quantity += detail.quantity;
      else defectTypes.push({ name: detail.type, quantity: detail.quantity });
      const area = defectAreas.find(item => normalizeDefectKey(item.name) === normalizeDefectKey(detail.area));
      if (area) area.quantity += detail.quantity;
      else defectAreas.push({ name: detail.area, quantity: detail.quantity });
    });
    const row = {
      rowNumber: first.rowNumber,
      date: first.date,
      line: first.line,
      labelWeek: first.labelWeek,
      model: first.model,
      target: null,
      output: null,
      qcChecked: hourlyQcData.reduce((total, hour) => total + hour.qcChecked, 0),
      defect: hourlyQcData.reduce((total, hour) => total + hour.defect, 0),
      defectTypeSummary: formatProductionImportCategories(defectTypes),
      defectAreaSummary: formatProductionImportCategories(defectAreas),
      hourlyQcData,
      action: 'replace',
      existingModelId: '',
      errors,
      warnings,
      importKind: 'qc'
    };
    if (errors.length === 0 && row.date) {
      if (!snapshots.has(row.date)) snapshots.set(row.date, getSnapshot(row.date));
      const matches = findExistingProductionImportModel(snapshots.get(row.date), row);
      if (matches.length === 0) {
        row.errors.push('Data produksi belum ditemukan. Input data produksi terlebih dahulu');
      } else if (matches.length > 1) {
        row.errors.push('Ada lebih dari satu model existing dengan identitas yang sama');
      } else {
        row.existingModelId = matches[0][0];
        row.target = matches[0][1].target || 0;
        row.output = matches[0][1].outputDay || 0;
        row.warnings.push('Data QC existing untuk model ini akan diganti');
      }
    }
    if (row.errors.length > 0) row.action = 'invalid';
    return row;
  });
  return { rows, summary: summarizeProductionImportRows(rows) };
}

function buildImportedSewingModel(row, modelId, existingModel = null) {
  const existingHours = new Map((existingModel?.hourly_data || []).map(hour => [hour.hour, hour]));
  const hourlyData = row.hourlyData.map(hour => {
    const existing = existingHours.get(hour.hour) || {};
    return {
      ...existing,
      hour: hour.hour,
      targetManual: hour.targetManual,
      output: hour.output,
      selisih: hour.output - hour.targetManual,
      qcChecked: parseInt(existing.qcChecked) || 0,
      defect: parseInt(existing.defect) || 0,
      defectDetails: existing.defectDetails || []
    };
  });
  const model = {
    ...(existingModel || {}),
    id: modelId,
    labelWeek: row.labelWeek,
    model: row.model,
    date: row.date,
    target: row.target,
    targetPerHour: Math.round(row.target / PRODUCTION_HOURS.length),
    outputDay: row.output,
    hourly_data: hourlyData,
    operators: existingModel?.operators || [],
    notes: row.notes || existingModel?.notes || '',
    importedHistoricalData: true
  };
  recalculateModelTotals(model);
  return model;
}

function applyImportedQcData(model, row) {
  const qcByHour = new Map(row.hourlyQcData.map(hour => [hour.hour, hour]));
  (model.hourly_data || []).forEach(hour => {
    const imported = qcByHour.get(hour.hour) || { qcChecked: 0, defect: 0, defectDetails: [] };
    hour.qcChecked = imported.qcChecked;
    hour.defect = imported.defect;
    hour.defectDetails = imported.defectDetails;
  });
  delete model.qcChecks;
  model.importedHistoricalQcData = true;
  recalculateModelTotals(model);
  return model;
}

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

const MATERIAL_ORDER_STATUSES = ['planned', 'in_production', 'completed'];

function buildInitialMaterialOrders() {
  return { orders: [] };
}

function normalizeMaterialOrderProduction(production = {}) {
  return {
    lineName: String(production.lineName || '').trim(),
    modelId: String(production.modelId || '').trim(),
    status: MATERIAL_ORDER_STATUSES.includes(production.status) ? production.status : 'planned',
    qtyResult: Math.max(0, parseInt(production.qtyResult) || 0)
  };
}

function getMaterialOrderProductions(order = {}) {
  const productions = Array.isArray(order.productions) && order.productions.length > 0
    ? order.productions
    : (order.lineName || order.modelId
      ? [{
          lineName: order.lineName,
          modelId: order.modelId,
          status: order.status,
          qtyResult: order.qtyResult
        }]
      : []);

  return productions
    .map(normalizeMaterialOrderProduction)
    .filter(production => production.lineName || production.modelId || production.qtyResult > 0);
}

function deriveMaterialOrderStatus(productions = []) {
  if (productions.some(production => production.status === 'in_production')) return 'in_production';
  if (productions.length > 0 && productions.every(production => production.status === 'completed')) return 'completed';
  return 'planned';
}

function deriveMaterialOrderProgressStatus(qtyOrder, qtyResult, productions = []) {
  const orderQty = Math.max(0, Number(qtyOrder) || 0);
  const resultQty = Math.max(0, Number(qtyResult) || 0);
  if (orderQty > 0 && resultQty >= orderQty) return 'completed';
  if (resultQty > 0) return 'in_production';
  return 'planned';
}

function summarizeMaterialOrderProductionFields(productions = []) {
  const normalizedProductions = productions.map(normalizeMaterialOrderProduction);
  const uniqueLines = [...new Set(normalizedProductions.map(production => production.lineName).filter(Boolean))];
  const qtyResult = normalizedProductions.reduce((total, production) => total + (Number(production.qtyResult) || 0), 0);

  return {
    lineName: uniqueLines.join(', '),
    modelId: normalizedProductions.length === 1 ? normalizedProductions[0].modelId : '',
    status: deriveMaterialOrderStatus(normalizedProductions),
    qtyResult
  };
}

function normalizeMaterialOrderRecord(order = {}) {
  const productions = getMaterialOrderProductions(order);
  const productionSummary = summarizeMaterialOrderProductionFields(productions);

  return {
    id: parseInt(order.id) || 0,
    poMaterial: String(order.poMaterial || '').trim(),
    orderMaterial: String(order.orderMaterial || '').trim(),
    qtyOrder: Math.max(0, parseInt(order.qtyOrder) || 0),
    productions,
    lineName: productionSummary.lineName,
    modelId: productionSummary.modelId,
    status: productionSummary.status,
    qtyResult: productionSummary.qtyResult,
    orderDate: isValidDateInput(order.orderDate) ? order.orderDate : getToday(),
    notes: String(order.notes || '').trim(),
    createdBy: String(order.createdBy || '').trim(),
    createdAt: String(order.createdAt || ''),
    updatedAt: String(order.updatedAt || '')
  };
}

function normalizeMaterialOrders(data = {}) {
  return {
    orders: Array.isArray(data.orders)
      ? data.orders.map(normalizeMaterialOrderRecord).filter(order => order.id > 0)
      : []
  };
}

function getMaterialOrderActualQty(model, fallback = 0) {
  const value = model ? model.outputDay : fallback;
  return Math.max(0, parseInt(value) || 0);
}

function materialOrderProductionIdentity(lineName, model = {}) {
  const normalize = value => String(value || '').trim().toLowerCase();
  return `${normalize(lineName)}::${normalize(model.labelWeek)}::${normalize(model.model)}`;
}

function preserveMaterialOrderProductionIdentity(lineName, model, nextLabelWeek, nextModelName) {
  if (!model) return;
  const currentIdentity = materialOrderProductionIdentity(lineName, model);
  const nextIdentity = materialOrderProductionIdentity(lineName, {
    labelWeek: nextLabelWeek,
    model: nextModelName
  });
  if (currentIdentity === nextIdentity) return;

  const aliases = Array.isArray(model.materialOrderIdentityAliases)
    ? model.materialOrderIdentityAliases.map(String).filter(Boolean)
    : [];
  model.materialOrderIdentityAliases = [...new Set([...aliases, currentIdentity])];
}

function getMaterialOrderHistoricalProductionData() {
  const today = getToday();
  const dates = new Set();
  productionSnapshotCache.forEach(snapshot => {
    if (snapshot.type === 'daily' && snapshot.snapshotDate !== today) dates.add(snapshot.snapshotDate);
  });

  return [...dates]
    .sort((a, b) => a.localeCompare(b))
    .map(date => readProductionSnapshotForDate(date))
    .filter(Boolean);
}

function buildMaterialOrderCumulativeOutputs(productionData = readProductionData(), historicalData = null) {
  const totals = {};
  const sources = [
    ...(Array.isArray(historicalData) ? historicalData : getMaterialOrderHistoricalProductionData()),
    productionData
  ];

  sources.forEach(data => {
    Object.entries(data?.lines || {}).forEach(([lineName, line]) => {
      Object.values(line.models || {}).forEach(model => {
        const identity = materialOrderProductionIdentity(lineName, model);
        totals[identity] = (totals[identity] || 0) + getMaterialOrderActualQty(model);
      });
    });
  });

  return totals;
}

function getMaterialOrderCumulativeOutput(lineName, model, cumulativeOutputs = {}) {
  if (!model) return 0;
  const identities = [...new Set([
    materialOrderProductionIdentity(lineName, model),
    ...(Array.isArray(model.materialOrderIdentityAliases) ? model.materialOrderIdentityAliases : [])
  ].map(String).filter(Boolean))];
  const matchedOutputs = identities.filter(identity =>
    Object.prototype.hasOwnProperty.call(cumulativeOutputs, identity)
  );
  return matchedOutputs.length > 0
    ? matchedOutputs.reduce((total, identity) => total + getMaterialOrderActualQty(null, cumulativeOutputs[identity]), 0)
    : getMaterialOrderActualQty(model);
}

function buildMaterialOrderProductionTotals(productionData = readProductionData(), cumulativeOutputs = buildMaterialOrderCumulativeOutputs(productionData)) {
  const totals = {};
  Object.entries(productionData.lines || {}).forEach(([lineName, line]) => {
    Object.entries(line.models || {}).forEach(([modelId, model]) => {
      totals[`${lineName}::${modelId}`] = getMaterialOrderCumulativeOutput(lineName, model, cumulativeOutputs);
    });
  });
  return totals;
}

function validateMaterialOrderInput(input = {}, productionData = readProductionData()) {
  const order = normalizeMaterialOrderRecord(input);
  const errors = [];
  const seenProductions = new Set();

  if (!order.poMaterial) errors.push('PO Material wajib diisi');
  if (!order.orderMaterial) errors.push('Order Material wajib diisi');
  if (!Number.isInteger(Number(input.qtyOrder)) || Number(input.qtyOrder) <= 0) {
    errors.push('Qty Order harus berupa angka lebih dari 0');
  }
  if (!isValidDateInput(input.orderDate)) errors.push('Tanggal order tidak valid');

  if (order.productions.length === 0) {
    errors.push('Minimal satu line dan model produksi wajib dipilih');
  }

  order.productions.forEach((production, index) => {
    const rowLabel = `Alokasi produksi ${index + 1}`;
    const rawProduction = Array.isArray(input.productions) && input.productions.length > 0
      ? input.productions[index] || {}
      : input;

    if (!production.lineName || !production.modelId) {
      errors.push(`${rowLabel}: line dan model produksi wajib dipilih`);
      return;
    }
    const model = productionData.lines?.[production.lineName]?.models?.[production.modelId];
    if (!model) {
      errors.push(`${rowLabel}: line atau model produksi tidak ditemukan`);
    } else {
      production.qtyResult = getMaterialOrderActualQty(model);
    }
    if (!MATERIAL_ORDER_STATUSES.includes(rawProduction.status)) {
      errors.push(`${rowLabel}: Status produksi tidak valid`);
    }

    const productionKey = `${production.lineName}::${production.modelId}`;
    if (seenProductions.has(productionKey)) {
      errors.push(`${rowLabel}: line dan model produksi tidak boleh duplikat`);
    }
    seenProductions.add(productionKey);
  });

  const productionSummary = summarizeMaterialOrderProductionFields(order.productions);
  order.lineName = productionSummary.lineName;
  order.modelId = productionSummary.modelId;
  order.status = deriveMaterialOrderProgressStatus(order.qtyOrder, productionSummary.qtyResult, order.productions);
  order.qtyResult = productionSummary.qtyResult;

  return { order, errors };
}

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
  productionSnapshotCache.set(record.filename, {
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt)
  });
}

async function loadProductionSnapshotCache() {
  const rows = await ProductionSnapshot.findAll({ raw: true });
  productionSnapshotCache.clear();
  rows.forEach(cacheSnapshot);
}

function readSnapshotData(snapshot) {
  if (!snapshot) return null;
  return parsePayload(snapshot.payload, null);
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
  cacheSnapshot(record);

  snapshotWriteQueue = snapshotWriteQueue
    .catch(() => {})
    .then(async () => {
      await ProductionSnapshot.upsert(record);
    })
    .catch(error => {
      logger.error(`Gagal menyimpan snapshot ${filename} ke database`, error.message);
    });

  return record;
}

async function flushPendingDatabaseWrites() {
  await Promise.all(Array.from(appDataWriteQueues.values()));
  await snapshotWriteQueue;
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

  productionDataCache = parsePayload(
    rowsByKey.get(PRODUCTION_DATA_KEY)?.payload || '',
    buildInitialProductionData()
  );
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
    await AppData.sync();
    await ProductionSnapshot.sync();

    const legacyDataPath = path.join(__dirname, 'data.json');
    const legacyUsersPath = path.join(__dirname, 'users.json');

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
  }
}

// FUNGSI BACKUP DATA SEBELUM RESET (PERBAIKAN UTAMA)
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
    return productionDataCache;
  } catch (error) {
    logger.error('Gagal membaca production data cache', error.message);
    return { lines: {}, activeLine: '' };
  }
}

function writeProductionData(data) {
  productionDataCache = data;
  return upsertAppData(PRODUCTION_DATA_KEY, data);
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

function buildMaterialOrderResponse(order, productionData = readProductionData(), cumulativeOutputs = buildMaterialOrderCumulativeOutputs(productionData)) {
  const normalizedOrder = normalizeMaterialOrderRecord(order);
  const productions = normalizedOrder.productions.map((production, index) => {
    const model = productionData.lines?.[production.lineName]?.models?.[production.modelId];
    const activeModels = productionData.lines?.[production.lineName]?.activeModels || [];
    const currentProductionOutput = model
      ? getMaterialOrderCumulativeOutput(production.lineName, model, cumulativeOutputs)
      : getMaterialOrderActualQty(null, production.qtyResult);

    return {
      ...production,
      qtyResult: currentProductionOutput,
      allocationIndex: index + 1,
      modelName: model?.model || '',
      labelWeek: model?.labelWeek || '',
      currentProductionOutput,
      productionActive: activeModels.includes(production.modelId)
        || productionData.lines?.[production.lineName]?.activeModel === production.modelId,
      linkedModelExists: Boolean(model)
    };
  });

  const qtyResult = productions.reduce((total, production) => total + (Number(production.qtyResult) || 0), 0);
  const currentProductionOutput = productions.reduce((total, production) => total + (Number(production.currentProductionOutput) || 0), 0);
  const uniqueLines = [...new Set(productions.map(production => production.lineName).filter(Boolean))];
  const firstProduction = productions[0] || {};

  return {
    ...normalizedOrder,
    productions,
    lineName: uniqueLines.join(', '),
    modelId: productions.length === 1 ? firstProduction.modelId : '',
    modelName: productions.length === 1 ? firstProduction.modelName : '',
    labelWeek: productions.length === 1 ? firstProduction.labelWeek : '',
    status: deriveMaterialOrderProgressStatus(normalizedOrder.qtyOrder, qtyResult, productions),
    qtyResult,
    currentProductionOutput,
    productionActive: productions.some(production => production.productionActive),
    linkedModelExists: productions.length > 0 && productions.every(production => production.linkedModelExists),
    productionCount: productions.length
  };
}

function flattenMaterialOrderReportRows(orders, productionData = readProductionData(), cumulativeOutputs = buildMaterialOrderCumulativeOutputs(productionData)) {
  return (orders || []).map(order => {
    const response = buildMaterialOrderResponse(order, productionData, cumulativeOutputs);
    const labelWeeks = [...new Set(response.productions.map(production => production.labelWeek).filter(Boolean))];
    const modelNames = [...new Set(response.productions.map(production => production.modelName).filter(Boolean))];

    return {
      ...response,
      orderId: response.id,
      rowId: String(response.id),
      labelWeek: labelWeeks.join(', '),
      modelName: modelNames.join(', '),
      orderStatus: response.status,
      orderQtyResult: response.qtyResult,
      productionLines: response.productions.map(production => production.lineName)
    };
  });
}

function filterMaterialOrderReportRows(orders, filters = {}, productionData = readProductionData(), cumulativeOutputs = buildMaterialOrderCumulativeOutputs(productionData)) {
  const startDate = filters.startDate || '';
  const endDate = filters.endDate || '';
  const lineName = String(filters.line || '').trim();
  const status = String(filters.status || '').trim();
  const poMaterial = String(filters.poMaterial || '').trim().toLowerCase();

  return flattenMaterialOrderReportRows(orders, productionData, cumulativeOutputs)
    .filter(order => (!startDate || order.orderDate >= startDate)
      && (!endDate || order.orderDate <= endDate)
      && (!lineName || order.productionLines.includes(lineName))
      && (!status || order.status === status)
      && (!poMaterial || String(order.poMaterial || '').trim().toLowerCase() === poMaterial))
    .sort((a, b) => String(b.orderDate).localeCompare(String(a.orderDate))
      || (Number(b.orderId) || 0) - (Number(a.orderId) || 0));
}

function summarizeMaterialOrderReport(rows = []) {
  const countedOrders = new Map();

  return rows.reduce((summary, row) => {
    const orderKey = Number(row.orderId || row.id) || row.poMaterial;
    if (!countedOrders.has(orderKey)) {
      countedOrders.set(orderKey, true);
      summary.total += 1;
      summary.qtyOrder += Number(row.qtyOrder) || 0;
      if (row.orderStatus === 'in_production') summary.inProduction += 1;
      if (row.orderStatus === 'completed') summary.completed += 1;
    }
    summary.qtyResult += Number(row.qtyResult) || 0;
    return summary;
  }, { total: 0, qtyOrder: 0, qtyResult: 0, inProduction: 0, completed: 0 });
}

async function generateMaterialOrderReportExcel(rows, summary, filters = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Production Dashboard System';

  const summarySheet = workbook.addWorksheet('SUMMARY');
  summarySheet.mergeCells('A1:B1');
  summarySheet.getCell('A1').value = 'REPORT ORDER MATERIAL';
  summarySheet.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFF' } };
  summarySheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0F766E' } };
  summarySheet.getCell('A1').alignment = { horizontal: 'center' };
  [
    ['Periode', filters.startDate && filters.endDate ? `${filters.startDate} s/d ${filters.endDate}` : 'Semua tanggal'],
    ['PO Material', filters.poMaterial || 'Semua PO'],
    ['Status', filters.status ? ({ planned: 'Direncanakan', in_production: 'Sedang Produksi', paused: 'Ditunda', completed: 'Selesai' }[filters.status] || filters.status) : 'Semua status'],
    ['Total PO', summary.total],
    ['Total Qty Order', summary.qtyOrder],
    ['Total Hasil Produksi', summary.qtyResult],
    ['Sedang Produksi', summary.inProduction],
    ['Selesai', summary.completed]
  ].forEach((values, index) => {
    const row = summarySheet.getRow(index + 3);
    row.values = values;
    row.getCell(1).font = { bold: true, color: { argb: '334155' } };
  });
  summarySheet.columns = [{ width: 24 }, { width: 36 }];

  const sheet = workbook.addWorksheet('ORDER MATERIAL');
  const headers = ['No', 'Tanggal Order', 'PO Material', 'Order Material', 'Qty Order', 'Label/Week', 'Model Produksi', 'Total Hasil Produksi', 'Status PO', 'Progress PO', 'Catatan'];
  sheet.getRow(1).values = headers;
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'D97706' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  rows.forEach((order, index) => {
    const qtyOrder = Number(order.qtyOrder) || 0;
    const totalQtyResult = Number(order.orderQtyResult ?? order.qtyResult) || 0;
    const progress = qtyOrder > 0 ? Math.min(100, Math.round((totalQtyResult / qtyOrder) * 100)) : 0;
    const row = sheet.addRow([
      index + 1,
      order.orderDate,
      order.poMaterial,
      order.orderMaterial,
      qtyOrder,
      order.labelWeek,
      order.modelName,
      totalQtyResult,
      { planned: 'Direncanakan', in_production: 'Sedang Produksi', paused: 'Ditunda', completed: 'Selesai' }[order.orderStatus] || order.orderStatus || order.status,
      `${progress}%`,
      order.notes || ''
    ]);
    row.eachCell(cell => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'E2E8F0' } },
        left: { style: 'thin', color: { argb: 'E2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'E2E8F0' } },
        right: { style: 'thin', color: { argb: 'E2E8F0' } }
      };
      cell.alignment = { vertical: 'top', wrapText: true };
    });
  });
  sheet.columns = headers.map(header => ({
    width: ['Order Material', 'Model Produksi', 'Catatan'].includes(header) ? 28 : (header === 'PO Material' ? 22 : 16)
  }));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  return workbook;
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

function hasAnyRole(user, allowedRoles) {
  const role = normalizeRole(user?.role);
  return Boolean(role && allowedRoles.includes(role));
}

const ADMIN_OPERATOR_ROLES = ['admin_operator_sewing', 'admin_operator_qc'];
const PPIC_ROLE = 'ppic';
const DASHBOARD_VIEWER_ROLES = ['admin', ...ADMIN_OPERATOR_ROLES, PPIC_ROLE];
const REPORT_VIEWER_ROLES = [...DASHBOARD_VIEWER_ROLES];

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

function getProductionImportTemplateSampleRows(limit = 6) {
  const today = getToday();
  const candidates = getAvailableHistoryDates()
    .filter(date => date < today)
    .flatMap(date => {
      const snapshot = readProductionSnapshotForDate(date);
      if (!snapshot) return [];
      return buildDateReportRows(snapshot, date).map(row => ({
        ...row,
        hourlyData: snapshot.lines?.[row.line]?.models?.[row.modelId]?.hourly_data || [],
        qcChecks: snapshot.lines?.[row.line]?.models?.[row.modelId]?.qcChecks || []
      }));
    })
    .filter(row => row.date && row.line && row.model);

  return candidates
    .sort((a, b) => {
      const defectPriority = Number((b.defect || 0) > 0) - Number((a.defect || 0) > 0);
      return defectPriority
        || String(b.date).localeCompare(String(a.date))
        || (Number(b.defect) || 0) - (Number(a.defect) || 0)
        || String(a.line).localeCompare(String(b.line));
    })
    .slice(0, limit);
}

function styleImportWorksheet(sheet, widths, endColumn) {
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F4E78' } };
  sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  sheet.getRow(1).height = 30;
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.autoFilter = { from: `A1`, to: `${endColumn}1` };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function sewingImportTemplateWorkbook(options = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Production Dashboard System';
  const samples = Array.isArray(options.sampleRows) ? options.sampleRows : getProductionImportTemplateSampleRows(3);
  const headers = ['Tanggal', 'Line', 'Label/Week', 'Model', 'Jam', 'Target Manual', 'Output', 'Catatan'];
  const widths = [14, 18, 18, 38, 20, 16, 14, 32];
  const sheet = workbook.addWorksheet('Data Produksi');
  sheet.addRow(headers);
  styleImportWorksheet(sheet, widths, 'H');
  sheet.getColumn(1).numFmt = 'yyyy-mm-dd';
  [6, 7].forEach(column => { sheet.getColumn(column).numFmt = '0'; });

  const reference = workbook.addWorksheet('Referensi Jam');
  reference.addRow(['Jam Produksi']);
  PRODUCTION_HOURS.forEach(hour => reference.addRow([hour]));
  reference.getColumn(1).width = 22;
  reference.getRow(1).font = { bold: true };
  for (let row = 2; row <= 2001; row += 1) {
    sheet.getCell(row, 5).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: [`'Referensi Jam'!$A$2:$A$${PRODUCTION_HOURS.length + 1}`]
    };
  }

  const instructions = workbook.addWorksheet('Petunjuk');
  instructions.addRow(['Bagian', 'Keterangan']);
  [
    ['Tujuan', 'Input khusus data hasil produksi. Tidak mengubah data QC yang sudah tersimpan.'],
    ['Satu baris', 'Satu jam produksi untuk satu model. Pilih Jam dari dropdown.'],
    ['Jam wajib', `Isi seluruh ${PRODUCTION_HOURS.length} jam produksi untuk setiap model: ${PRODUCTION_HOURS.join(', ')}.`],
    ['Target Manual dan Output', 'Wajib berupa bilangan bulat tidak negatif. Total harian dihitung otomatis dari seluruh baris per jam.'],
    ['Identitas model', 'Tanggal, Line, Label/Week, dan Model harus sama pada seluruh jam untuk model yang sama.'],
    ['Urutan input', 'Input Produksi terlebih dahulu. Setelah berhasil, gunakan template Input QC.']
  ].forEach(row => instructions.addRow(row));
  instructions.getColumn(1).width = 26;
  instructions.getColumn(2).width = 105;
  instructions.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  instructions.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } };
  instructions.eachRow(row => { row.alignment = { vertical: 'top', wrapText: true }; row.height = 34; });

  const example = workbook.addWorksheet('Contoh Riil');
  example.addRow(headers);
  styleImportWorksheet(example, widths, 'H');
  samples.forEach(sample => {
    (sample.hourlyData || []).filter(hour => PRODUCTION_HOURS.includes(hour.hour)).forEach(hour => {
      example.addRow([
        sample.date, sample.line, sample.labelWeek || '', sample.model || '', hour.hour,
        parseInt(hour.targetManual) || 0, parseInt(hour.output) || 0, 'Contoh dari data tersimpan'
      ]);
    });
  });
  if (example.rowCount === 1) example.addRow(['Belum ada contoh data produksi historis.']);
  return workbook;
}

function buildQcImportSampleEntries(samples = []) {
  const rows = [];
  samples.forEach(sample => {
    const defectsByHour = new Map();
    (sample.qcChecks || []).filter(check => check.result === 'defect').forEach(check => {
      const hour = check.hour || sample.hourlyData?.[parseInt(check.hourIndex)]?.hour || '';
      if (!QC_IMPORT_HOURS.includes(hour)) return;
      const key = `${hour}|${check.type}|${check.area}`;
      const current = defectsByHour.get(key) || { hour, type: check.type, area: check.area, quantity: 0, notes: check.notes || '' };
      current.quantity += 1;
      defectsByHour.set(key, current);
    });
    (sample.hourlyData || []).filter(hour => QC_IMPORT_HOURS.includes(hour.hour)).forEach(hour => {
      const good = Math.max((parseInt(hour.qcChecked) || 0) - (parseInt(hour.defect) || 0), 0);
      if (good > 0) rows.push({ sample, hour: hour.hour, result: 'Good', quantity: good, type: '', area: '', notes: '' });
      const details = Array.from(defectsByHour.values()).filter(detail => detail.hour === hour.hour);
      if (details.length > 0) {
        details.forEach(detail => rows.push({ sample, hour: hour.hour, result: 'Defect', ...detail }));
      } else {
        (hour.defectDetails || []).forEach(detail => rows.push({
          sample,
          hour: hour.hour,
          result: 'Defect',
          quantity: parseInt(detail.quantity) || 1,
          type: detail.type || '',
          area: detail.area || '',
          notes: detail.notes || ''
        }));
      }
    });
  });
  return rows;
}

function qcImportTemplateWorkbook(options = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Production Dashboard System';
  const defectConfig = options.defectConfig || readDefectConfig();
  const samples = Array.isArray(options.sampleRows) ? options.sampleRows : getProductionImportTemplateSampleRows(3);
  const headers = ['Tanggal', 'Line', 'Label/Week', 'Model', 'Jam', 'Hasil QC', 'Qty', 'Jenis Defect', 'Defect Area', 'Catatan'];
  const widths = [14, 18, 18, 38, 20, 14, 12, 34, 34, 34];
  const sheet = workbook.addWorksheet('Data QC');
  sheet.addRow(headers);
  styleImportWorksheet(sheet, widths, 'J');
  sheet.getColumn(1).numFmt = 'yyyy-mm-dd';
  sheet.getColumn(7).numFmt = '0';

  const reference = workbook.addWorksheet('Referensi Defect');
  reference.addRow(['Jenis Defect', 'Severity', '', 'Defect Area', '', 'Jam Produksi']);
  const types = defectConfig.defectTypes || [];
  const areas = defectConfig.defectAreas || [];
  const maxRows = Math.max(types.length, areas.length, QC_IMPORT_HOURS.length);
  for (let index = 0; index < maxRows; index += 1) {
    reference.addRow([
      types[index]?.name || '', types[index]?.severity || '', '', areas[index]?.name || '', '', QC_IMPORT_HOURS[index] || ''
    ]);
  }
  [34, 14, 4, 34, 4, 22].forEach((width, index) => { reference.getColumn(index + 1).width = width; });
  reference.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  reference.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } };

  const typeEnd = Math.max(types.length + 1, 2);
  const areaEnd = Math.max(areas.length + 1, 2);
  for (let row = 2; row <= 2001; row += 1) {
    sheet.getCell(row, 5).dataValidation = { type: 'list', allowBlank: false, formulae: [`'Referensi Defect'!$F$2:$F$${QC_IMPORT_HOURS.length + 1}`] };
    sheet.getCell(row, 6).dataValidation = { type: 'list', allowBlank: false, formulae: ['"Good,Defect"'] };
    sheet.getCell(row, 7).dataValidation = { type: 'whole', operator: 'greaterThanOrEqual', allowBlank: false, formulae: [1] };
    sheet.getCell(row, 8).dataValidation = { type: 'list', allowBlank: true, formulae: [`'Referensi Defect'!$A$2:$A$${typeEnd}`] };
    sheet.getCell(row, 9).dataValidation = { type: 'list', allowBlank: true, formulae: [`'Referensi Defect'!$D$2:$D$${areaEnd}`] };
  }

  const instructions = workbook.addWorksheet('Petunjuk');
  instructions.addRow(['Bagian', 'Keterangan']);
  [
    ['Tujuan', 'Import khusus hasil QC. Data target dan output sewing tidak diubah.'],
    ['Satu baris', 'Satu hasil QC untuk satu jam. Gunakan Qty untuk jumlah hasil dengan kategori yang sama.'],
    ['Hasil Good', 'Pilih Good, isi Qty, lalu kosongkan Jenis Defect dan Defect Area.'],
    ['Hasil Defect', 'Pilih Defect, isi Qty, lalu pilih Jenis Defect dan Defect Area dari dropdown.'],
    ['Jam istirahat', 'Pilihan 11:00 - 13:00 tersedia untuk data QC historis yang memang dicatat pada jam istirahat.'],
    ['Perhitungan', 'QC Checked, Total Defect, severity, Good, dan defect rate dihitung otomatis oleh sistem.'],
    ['Pencocokan', 'Tanggal, Line, Label/Week, dan Model harus sama dengan data Sewing yang sudah diimport.'],
    ['Defect Area tersedia', areas.map(area => area.name).join(', ') || 'Belum ada area defect.'],
    ['Jenis Defect tersedia', types.map(type => `${type.name} (${type.severity})`).join(', ') || 'Belum ada jenis defect.']
  ].forEach(row => instructions.addRow(row));
  instructions.getColumn(1).width = 26;
  instructions.getColumn(2).width = 105;
  instructions.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  instructions.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } };
  instructions.eachRow(row => {
    row.alignment = { vertical: 'top', wrapText: true };
    row.height = ['Defect Area tersedia', 'Jenis Defect tersedia'].includes(row.getCell(1).value) ? 90 : 34;
  });

  const example = workbook.addWorksheet('Contoh Riil');
  example.addRow(headers);
  styleImportWorksheet(example, widths, 'J');
  buildQcImportSampleEntries(samples).forEach(entry => {
    example.addRow([
      entry.sample.date, entry.sample.line, entry.sample.labelWeek || '', entry.sample.model || '',
      entry.hour, entry.result, entry.quantity, entry.type || '', entry.area || '', entry.notes || 'Contoh dari data tersimpan'
    ]);
  });
  if (example.rowCount === 1) example.addRow(['Belum ada contoh data QC historis.']);
  return workbook;
}

function productionImportTemplateWorkbook(options = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Production Dashboard System';
  workbook.created = new Date();

  const sampleRows = Array.isArray(options.sampleRows)
    ? options.sampleRows
    : getProductionImportTemplateSampleRows();
  const defectConfig = options.defectConfig || readDefectConfig();

  const sheet = workbook.addWorksheet('Data Produksi');
  const headers = [
    'Tanggal', 'Line', 'Model ID', 'Label/Week', 'Model', 'Target', 'Output', 'Achievement',
    'QC Checked', 'Good', 'Total Defect', 'Critical', 'Major', 'Minor', 'Defect Rate',
    'Defect Area', 'Jenis Defect', 'Catatan'
  ];
  const widths = [14, 18, 14, 18, 36, 14, 14, 14, 16, 14, 16, 12, 12, 12, 14, 42, 42, 32];
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F4E78' } };
  sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  sheet.getRow(1).height = 30;
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  sheet.getColumn(1).numFmt = 'yyyy-mm-dd';
  [6, 7, 9, 11, 12, 13, 14].forEach(column => {
    sheet.getColumn(column).numFmt = '0';
  });
  [3, 8, 10, 15].forEach(column => {
    sheet.getCell(1, column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '7F8C8D' } };
  });
  sheet.autoFilter = { from: 'A1', to: 'R1' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const hourlySheet = workbook.addWorksheet('Detail Per Jam');
  const hourlyHeaders = [
    'Tanggal', 'Line', 'Model ID', 'Label/Week', 'Model', 'Jam', 'Target Manual', 'Output',
    'Selisih', 'QC Checked', 'Total Defect', 'Good', 'Defect Rate'
  ];
  const hourlyWidths = [14, 18, 14, 18, 36, 20, 16, 14, 14, 16, 16, 14, 14];
  hourlySheet.addRow(hourlyHeaders);
  hourlySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  hourlySheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2F75B5' } };
  hourlySheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  hourlySheet.getRow(1).height = 30;
  hourlyWidths.forEach((width, index) => { hourlySheet.getColumn(index + 1).width = width; });
  hourlySheet.getColumn(1).numFmt = 'yyyy-mm-dd';
  [7, 8, 10, 11, 12].forEach(column => { hourlySheet.getColumn(column).numFmt = '0'; });
  [3, 9, 12, 13].forEach(column => {
    hourlySheet.getCell(1, column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '7F8C8D' } };
  });
  hourlySheet.autoFilter = { from: 'A1', to: 'M1' };
  hourlySheet.views = [{ state: 'frozen', ySplit: 1 }];

  const instructions = workbook.addWorksheet('Petunjuk');
  instructions.getColumn(1).width = 24;
  instructions.getColumn(2).width = 100;
  instructions.addRow(['Kolom', 'Keterangan']);
  instructions.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  instructions.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } };
  [
    ['Tanggal', 'Wajib. Gunakan format YYYY-MM-DD dan hanya tanggal sebelum hari ini.'],
    ['Line', 'Wajib. Nama line produksi.'],
    ['Model ID, Achievement, Good, Defect Rate', 'Boleh disalin dari report tetapi tidak dipakai saat import karena nilainya dihitung otomatis oleh sistem.'],
    ['Detail Per Jam', 'Opsional. Isi sheet Detail Per Jam jika ingin mempertahankan hasil aktual per jam. Untuk setiap summary, isi 8 jam produksi (07:00-11:00 dan 13:00-17:00). Jam istirahat 11:00 - 13:00 boleh dikosongkan.'],
    ['Kolom Detail Per Jam', 'Target Manual, Output, QC Checked, dan Total Defect wajib bilangan bulat tidak negatif. Total tiap kolom harus sama dengan nilai summary.'],
    ['Label/Week', 'Opsional. Isi label atau minggu produksi jika tersedia.'],
    ['Model', 'Wajib. Nama model produksi.'],
    ['Target, Output, QC Checked, Total Defect', 'Wajib, bilangan bulat tidak negatif. Total Defect tidak boleh lebih besar dari QC Checked.'],
    ['Critical/Major/Minor', 'Opsional. Jika diisi, jumlah ketiganya harus sama dengan Total Defect. Jika kosong, defect otomatis dianggap Minor.'],
    ['Defect Area', 'Opsional. Gunakan format Nama (Qty), dipisahkan koma. Contoh: Badan (2), Kepala (1). Total Qty harus sama dengan Total Defect.'],
    ['Jenis Defect', 'Opsional. Gunakan format Nama (Qty), dipisahkan koma. Contoh: Jahitan Terbuka (2), Kotor (1). Total Qty harus sama dengan Total Defect. Kedua kolom ini adalah rekap terpisah seperti report.'],
    ['Referensi kategori', 'Lihat sheet Referensi Defect. Daftar tersebut diambil langsung dari master kategori aplikasi saat template diunduh.'],
    ['Defect Area aktif saat ini', (defectConfig.defectAreas || []).filter(area => area.active !== false).map(area => area.name).join(', ') || 'Belum ada area defect aktif.'],
    ['Contoh data', 'Sheet Contoh Data Riil diambil dari report produksi yang sudah tersimpan. Sheet contoh tidak ikut diimport.'],
    ['Catatan', 'Opsional. Keterangan sumber data lama.'],
    ['Alur import', 'Isi sheet Data Produksi, simpan sebagai .xlsx, unggah ke aplikasi, periksa hasil review, lalu ketik IMPORT untuk konfirmasi.']
  ].forEach(row => instructions.addRow(row));
  instructions.eachRow(row => {
    row.alignment = { vertical: 'top', wrapText: true };
    row.height = row.getCell(1).value === 'Defect Area aktif saat ini' ? 90 : 30;
  });

  const example = workbook.addWorksheet('Contoh Data Riil');
  example.addRow(headers);
  example.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  example.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'A5A5A5' } };
  widths.forEach((width, index) => { example.getColumn(index + 1).width = width; });
  sampleRows.forEach(row => {
    example.addRow([
      row.date, row.line, row.modelId || '', row.labelWeek || '', row.model || '', row.target || 0,
      row.output || 0, `${row.achievement || 0}%`, row.qcChecked || 0, row.good || 0,
      row.defect || 0, row.criticalDefect || 0, row.majorDefect || 0, row.minorDefect || 0,
      `${row.defectRate || 0}%`, row.defectAreas || '-', row.defectTypes || '-',
      'Contoh otomatis dari data report tersimpan'
    ]);
  });
  if (sampleRows.length === 0) {
    example.addRow(['Belum ada data report historis yang dapat dijadikan contoh.']);
    example.mergeCells('A2:R2');
  }
  const noticeRow = example.rowCount + 2;
  example.getRow(noticeRow).values = ['Jangan unggah sheet ini. Salin baris yang diperlukan ke sheet Data Produksi.'];
  example.mergeCells(`A${noticeRow}:R${noticeRow}`);
  example.getCell(`A${noticeRow}`).font = { italic: true, color: { argb: 'C00000' } };
  example.views = [{ state: 'frozen', ySplit: 1 }];
  example.autoFilter = { from: 'A1', to: 'R1' };

  const hourlyExample = workbook.addWorksheet('Contoh Per Jam Riil');
  hourlyExample.addRow(hourlyHeaders);
  hourlyExample.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  hourlyExample.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'A5A5A5' } };
  hourlyWidths.forEach((width, index) => { hourlyExample.getColumn(index + 1).width = width; });
  sampleRows.forEach(row => {
    (row.hourlyData || []).forEach(hour => {
      const qcChecked = parseInt(hour.qcChecked) || 0;
      const defect = parseInt(hour.defect) || 0;
      hourlyExample.addRow([
        row.date, row.line, row.modelId || '', row.labelWeek || '', row.model || '', hour.hour || '',
        parseInt(hour.targetManual) || 0, parseInt(hour.output) || 0,
        (parseInt(hour.output) || 0) - (parseInt(hour.targetManual) || 0), qcChecked, defect,
        Math.max(qcChecked - defect, 0), qcChecked > 0 ? `${((defect / qcChecked) * 100).toFixed(2)}%` : '0%'
      ]);
    });
  });
  if (hourlyExample.rowCount === 1) {
    hourlyExample.addRow(['Belum ada detail per jam historis yang dapat dijadikan contoh.']);
    hourlyExample.mergeCells('A2:M2');
  }
  const hourlyNoticeRow = hourlyExample.rowCount + 2;
  hourlyExample.getRow(hourlyNoticeRow).values = ['Jangan unggah sheet ini. Salin baris yang diperlukan ke sheet Detail Per Jam.'];
  hourlyExample.mergeCells(`A${hourlyNoticeRow}:M${hourlyNoticeRow}`);
  hourlyExample.getCell(`A${hourlyNoticeRow}`).font = { italic: true, color: { argb: 'C00000' } };
  hourlyExample.autoFilter = { from: 'A1', to: 'M1' };
  hourlyExample.views = [{ state: 'frozen', ySplit: 1 }];

  const reference = workbook.addWorksheet('Referensi Defect');
  reference.addRow(['Jenis Defect', 'Severity', 'Status', '', 'Defect Area', 'Status']);
  reference.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  reference.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } };
  const types = defectConfig.defectTypes || [];
  const areas = defectConfig.defectAreas || [];
  const referenceRows = Math.max(types.length, areas.length);
  for (let index = 0; index < referenceRows; index += 1) {
    const type = types[index];
    const area = areas[index];
    reference.addRow([
      type?.name || '', type?.severity || '', type ? (type.active !== false ? 'Aktif' : 'Nonaktif') : '', '',
      area?.name || '', area ? (area.active !== false ? 'Aktif' : 'Nonaktif') : ''
    ]);
  }
  [36, 14, 14, 4, 36, 14].forEach((width, index) => { reference.getColumn(index + 1).width = width; });
  reference.views = [{ state: 'frozen', ySplit: 1 }];
  return workbook;
}

function cleanExpiredProductionImportPreviews() {
  const now = Date.now();
  productionImportPreviewCache.forEach((preview, token) => {
    if (now - preview.createdAt > PRODUCTION_IMPORT_PREVIEW_TTL_MS) productionImportPreviewCache.delete(token);
  });
}

app.get('/api/production-import/template', requireLogin, requireAdmin, async (req, res) => {
  try {
    const workbook = productionImportTemplateWorkbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Template_Import_Data_Produksi.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    logger.error('Gagal membuat template import produksi', error);
    res.status(500).json({ error: 'Gagal membuat template Excel' });
  }
});

app.get('/api/production-import/template/:kind', requireLogin, requireAdmin, async (req, res) => {
  const kind = String(req.params.kind || '').toLowerCase();
  if (!['sewing', 'qc'].includes(kind)) return res.status(404).json({ error: 'Jenis template tidak dikenal' });
  try {
    const workbook = kind === 'sewing' ? sewingImportTemplateWorkbook() : qcImportTemplateWorkbook();
    const filename = kind === 'sewing' ? 'Template_Input_Produksi.xlsx' : 'Template_Input_QC.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    logger.error(`Gagal membuat template import ${kind}`, error);
    res.status(500).json({ error: 'Gagal membuat template Excel' });
  }
});

function cacheProductionImportPreview(req, parsed, kind) {
  const token = parsed.summary.invalid === 0 && parsed.summary.total > 0
    ? crypto.randomBytes(24).toString('hex')
    : '';
  if (!token) return '';
  const snapshotHashes = {};
  parsed.rows.filter(row => row.errors.length === 0).forEach(row => {
    if (Object.prototype.hasOwnProperty.call(snapshotHashes, row.date)) return;
    snapshotHashes[row.date] = getLatestSnapshotForDate(row.date)?.contentHash || '';
  });
  productionImportPreviewCache.set(token, {
    token,
    kind,
    userId: getAuthenticatedSessionUser(req).id,
    createdAt: Date.now(),
    rows: parsed.rows.filter(row => row.errors.length === 0),
    summary: parsed.summary,
    snapshotHashes,
    filename: String(req.headers['x-file-name'] || 'import.xlsx').slice(0, 150)
  });
  return token;
}

app.post('/api/production-import/:kind/preview', requireLogin, requireAdmin,
  express.raw({ type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/octet-stream'], limit: '10mb' }),
  async (req, res) => {
    const kind = String(req.params.kind || '').toLowerCase();
    if (!['sewing', 'qc'].includes(kind)) return res.status(404).json({ error: 'Jenis import tidak dikenal' });
    cleanExpiredProductionImportPreviews();
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'File Excel wajib diunggah' });
    try {
      const parsed = kind === 'sewing' ? parseSewingImportWorkbook(req.body) : parseQcImportWorkbook(req.body);
      if (parsed.summary.total === 0) return res.status(400).json({ error: `Sheet Data ${kind === 'sewing' ? 'Produksi' : 'QC'} belum berisi data` });
      const token = cacheProductionImportPreview(req, parsed, kind);
      return res.json({ token, rows: parsed.rows, summary: parsed.summary, canImport: Boolean(token), kind });
    } catch (error) {
      logger.warn(`File import ${kind} tidak dapat dibaca: ${error.message}`);
      return res.status(400).json({ error: 'File Excel tidak valid atau rusak' });
    }
  });

app.post('/api/production-import/:kind/confirm', requireLogin, requireAdmin, async (req, res) => {
  const kind = String(req.params.kind || '').toLowerCase();
  cleanExpiredProductionImportPreviews();
  const token = String(req.body?.token || '');
  const preview = productionImportPreviewCache.get(token);
  const user = getAuthenticatedSessionUser(req);
  if (!preview || preview.userId !== user.id || preview.kind !== kind) {
    return res.status(400).json({ error: 'Review import sudah kedaluwarsa atau jenis import tidak sesuai' });
  }
  for (const [date, expectedHash] of Object.entries(preview.snapshotHashes)) {
    const currentHash = getLatestSnapshotForDate(date)?.contentHash || '';
    if (currentHash !== expectedHash) {
      productionImportPreviewCache.delete(token);
      return res.status(409).json({ error: `Data tanggal ${date} berubah setelah review. Silakan review ulang.` });
    }
  }

  try {
    const snapshots = new Map();
    preview.rows.forEach(row => {
      if (!snapshots.has(row.date)) {
        const source = readProductionSnapshotForDate(row.date);
        snapshots.set(row.date, source ? JSON.parse(JSON.stringify(source)) : { lines: {}, activeLine: '' });
      }
    });
    const safetyFiles = [];
    snapshots.forEach((snapshot, date) => {
      if (getLatestSnapshotForDate(date)) {
        const filename = `data_${date}_${Date.now()}_pre_import_${kind}_${crypto.randomBytes(4).toString('hex')}.json`;
        storeProductionSnapshot(filename, date, 'pre_import', snapshot);
        safetyFiles.push(filename);
      }
    });

    let created = 0;
    let updated = 0;
    preview.rows.forEach(row => {
      const snapshot = snapshots.get(row.date);
      snapshot.lines = snapshot.lines || {};
      const line = ensureLineActiveModels(snapshot.lines[row.line]) || { models: {}, activeModels: [], activeModel: null };
      line.models = line.models || {};
      if (kind === 'sewing') {
        const modelId = row.existingModelId || generateModelId(line.models);
        const existingModel = row.existingModelId ? line.models[row.existingModelId] : null;
        line.models[modelId] = buildImportedSewingModel(row, modelId, existingModel);
        line.activeModels = Array.from(new Set([...(line.activeModels || []), modelId]));
        line.activeModel = line.activeModels[0] || modelId;
        if (existingModel) updated += 1;
        else created += 1;
      } else {
        const model = line.models[row.existingModelId];
        if (!model) throw new Error(`Model QC tidak ditemukan: ${row.line} / ${row.model}`);
        applyImportedQcData(model, row);
        updated += 1;
      }
      snapshot.lines[row.line] = line;
      snapshot.activeLine = snapshot.activeLine || row.line;
    });
    snapshots.forEach((snapshot, date) => storeProductionSnapshot(`data_${date}.json`, date, 'daily', snapshot));
    await flushPendingDatabaseWrites();
    productionImportPreviewCache.delete(token);
    return res.json({
      message: kind === 'sewing'
        ? `Input Produksi berhasil: ${created} model baru, ${updated} model diperbarui`
        : `Input QC berhasil: ${updated} model diperbarui`,
      kind,
      created,
      updated,
      dates: snapshots.size,
      safetyFiles
    });
  } catch (error) {
    logger.error(`Gagal mengonfirmasi import ${kind}`, error);
    return res.status(500).json({ error: `Input ${kind === 'sewing' ? 'Produksi' : 'QC'} gagal disimpan` });
  }
});

app.post('/api/production-import/preview', requireLogin, requireAdmin,
  express.raw({ type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/octet-stream'], limit: '10mb' }),
  async (req, res) => {
    cleanExpiredProductionImportPreviews();
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'File Excel wajib diunggah' });
    }

    try {
      const parsed = parseProductionImportWorkbook(req.body);
      if (parsed.summary.total === 0) {
        return res.status(400).json({ error: 'Sheet Data Produksi belum berisi data' });
      }
      const token = parsed.summary.invalid === 0 && parsed.summary.total > 0
        ? crypto.randomBytes(24).toString('hex')
        : '';
      if (token) {
        const snapshotHashes = {};
        parsed.rows.filter(row => row.errors.length === 0).forEach(row => {
          if (Object.prototype.hasOwnProperty.call(snapshotHashes, row.date)) return;
          snapshotHashes[row.date] = getLatestSnapshotForDate(row.date)?.contentHash || '';
        });
        productionImportPreviewCache.set(token, {
          token,
          userId: getAuthenticatedSessionUser(req).id,
          createdAt: Date.now(),
          rows: parsed.rows.filter(row => row.errors.length === 0),
          summary: parsed.summary,
          snapshotHashes,
          filename: String(req.headers['x-file-name'] || 'import.xlsx').slice(0, 150)
        });
      }
      return res.json({
        token,
        rows: parsed.rows,
        summary: parsed.summary,
        canImport: Boolean(token)
      });
    } catch (error) {
      logger.warn(`File import produksi tidak dapat dibaca: ${error.message}`);
      return res.status(400).json({ error: 'File Excel tidak valid atau rusak' });
    }
  });

app.post('/api/production-import/confirm', requireLogin, requireAdmin, async (req, res) => {
  cleanExpiredProductionImportPreviews();
  const token = String(req.body?.token || '');
  const preview = productionImportPreviewCache.get(token);
  const user = getAuthenticatedSessionUser(req);
  if (!preview || preview.userId !== user.id) {
    return res.status(400).json({ error: 'Review import sudah kedaluwarsa. Unggah ulang file Excel.' });
  }

  for (const [date, expectedHash] of Object.entries(preview.snapshotHashes)) {
    const currentHash = getLatestSnapshotForDate(date)?.contentHash || '';
    if (currentHash !== expectedHash) {
      productionImportPreviewCache.delete(token);
      return res.status(409).json({ error: `Data tanggal ${date} berubah setelah review. Silakan lakukan review ulang.` });
    }
  }

  try {
    const snapshots = new Map();
    preview.rows.forEach(row => {
      if (!snapshots.has(row.date)) {
        const source = readProductionSnapshotForDate(row.date);
        snapshots.set(row.date, source ? JSON.parse(JSON.stringify(source)) : { lines: {}, activeLine: '' });
      }
    });

    const safetyFiles = [];
    snapshots.forEach((snapshot, date) => {
      if (getLatestSnapshotForDate(date)) {
        const filename = `data_${date}_${Date.now()}_pre_import_${crypto.randomBytes(4).toString('hex')}.json`;
        storeProductionSnapshot(filename, date, 'pre_import', snapshot);
        safetyFiles.push(filename);
      }
    });

    let created = 0;
    let replaced = 0;
    preview.rows.forEach(row => {
      const snapshot = snapshots.get(row.date);
      snapshot.lines = snapshot.lines || {};
      const line = ensureLineActiveModels(snapshot.lines[row.line])
        || { models: {}, activeModels: [], activeModel: null };
      line.models = line.models || {};
      const modelId = row.existingModelId || generateModelId(line.models);
      line.models[modelId] = buildImportedProductionModel(row, modelId);
      line.activeModels = Array.from(new Set([...(line.activeModels || []), modelId]));
      line.activeModel = line.activeModels[0] || modelId;
      snapshot.lines[row.line] = line;
      snapshot.activeLine = snapshot.activeLine || row.line;
      if (row.action === 'replace') replaced += 1;
      else created += 1;
    });

    snapshots.forEach((snapshot, date) => {
      storeProductionSnapshot(`data_${date}.json`, date, 'daily', snapshot);
    });
    await flushPendingDatabaseWrites();
    productionImportPreviewCache.delete(token);
    return res.json({
      message: `Import berhasil: ${created} data baru, ${replaced} data diperbarui`,
      created,
      replaced,
      dates: snapshots.size,
      safetyFiles
    });
  } catch (error) {
    logger.error('Gagal mengonfirmasi import produksi', error);
    return res.status(500).json({ error: 'Import gagal disimpan' });
  }
});

// ENDPOINT UNTUK MENDAPATKAN DAFTAR BACKUP DATA
app.get('/api/backup-history', requireLogin, requireAdmin, async (req, res) => {
  try {
    const snapshotBackups = Array.from(productionSnapshotCache.values()).map(snapshot => ({
      filename: snapshot.filename,
      date: snapshot.snapshotDate,
      type: snapshot.type,
      size: snapshot.size,
      created: snapshot.updatedAt,
      storage: 'snapshot',
      restorable: true,
      exportable: true,
      displayDate: new Date(snapshot.snapshotDate + 'T00:00:00+07:00').toLocaleDateString('id-ID')
    }));
    const databaseBackups = listDatabaseBackupFiles().map(backup => ({
      filename: backup.filename,
      date: backup.date,
      type: 'database',
      size: backup.size,
      created: backup.created,
      storage: 'database',
      restorable: false,
      exportable: false,
      displayDate: backup.date ? new Date(backup.date + 'T00:00:00+07:00').toLocaleDateString('id-ID') : '-'
    }));
    const backupFiles = [...snapshotBackups, ...databaseBackups]
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    
    res.json(backupFiles);
  } catch (error) {
    logger.error('Gagal membaca riwayat backup', error);
    res.status(500).json({ error: 'Failed to read backup history' });
  }
});

// ENDPOINT UNTUK MEMULIHKAN DATA DARI BACKUP
app.post('/api/restore-backup/:filename', requireLogin, requireAdmin, async (req, res) => {
  const { filename } = req.params;
  
  if (!isSafeBackupFilename(filename)) {
    return res.status(400).json({ error: 'Invalid backup filename' });
  }

  try {
    const snapshot = getSnapshotByFilename(filename);
    if (!snapshot) {
      return res.status(404).json({ error: 'Backup file not found' });
    }
    const backupData = readSnapshotData(snapshot);
    if (!isValidProductionSnapshot(backupData)) {
      return res.status(400).json({ error: 'Backup tidak memiliki struktur data produksi yang valid' });
    }

    const safetyBackupFile = createArchiveBackup('pre_restore');
    if (!safetyBackupFile) {
      return res.status(500).json({ error: 'Gagal membuat backup pengaman sebelum restore' });
    }
    const safetyDatabaseFile = await createDatabaseBackup('pre_restore');
    
    logger.info(`Restore backup dimulai: ${filename}`);
    const restoreResult = restoreProductionSnapshot(readProductionData(), backupData, getToday());
    const currentData = restoreResult.data;
    
    await writeProductionData(currentData);
    
    // Keep the restored state durable before the browser reloads dashboard data.
    updateTodayBackup();
    await flushPendingDatabaseWrites();
    
    res.json({
      message: '✅ Backup restored successfully',
      restoredLines: restoreResult.restoredLines,
      restoredModels: restoreResult.restoredModels,
      replacedModels: restoreResult.replacedModels,
      normalizedDateModels: restoreResult.normalizedDateModels,
      operationalDate: getToday(),
      safetyBackup: path.basename(safetyBackupFile),
      safetyDatabaseBackup: path.basename(safetyDatabaseFile),
      totalLines: Object.keys(currentData.lines).length,
      totalModels: Object.keys(currentData.lines).reduce((total, lineName) => {
        return total + Object.keys(currentData.lines[lineName].models).length;
      }, 0)
    });
  } catch (error) {
    logger.error('Gagal memulihkan backup', error);
    res.status(500).json({ error: 'Failed to restore backup: ' + error.message });
  }
});

app.get('/api/download-backup/:filename', requireLogin, requireAdmin, async (req, res) => {
  const { filename } = req.params;
  const snapshot = isSafeBackupFilename(filename) ? getSnapshotByFilename(filename) : null;

  if (!snapshot) {
    return res.status(isSafeBackupFilename(filename) ? 404 : 400).json({
      error: isSafeBackupFilename(filename) ? 'Backup file not found' : 'Invalid backup filename'
    });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.type('application/json').send(snapshot.payload);
});

app.get('/api/download-database-backup/:filename', requireLogin, requireAdmin, async (req, res) => {
  const { filename } = req.params;
  const backup = listDatabaseBackupFiles().find(item => item.filename === filename);
  if (!backup) return res.status(404).json({ error: 'Database backup not found' });
  res.download(backup.path, backup.filename);
});

app.post('/api/restore-database-backup/:filename', requireLogin, requireAdmin, async (req, res) => {
  if (req.body?.confirmation !== 'RESTORE') {
    return res.status(400).json({ error: 'Ketik RESTORE untuk mengonfirmasi pemulihan database' });
  }
  if (databaseRestoreInProgress) {
    return res.status(409).json({ error: 'Restore database lain sedang berlangsung' });
  }

  const backup = listDatabaseBackupFiles().find(item => item.filename === req.params.filename);
  if (!backup) return res.status(404).json({ error: 'File backup database tidak ditemukan' });

  databaseRestoreInProgress = true;
  try {
    logger.info(`Restore database dimulai: ${backup.filename}`);
    const result = await restoreDatabaseBackupFile(backup.path);
    try {
      await clearSessionsAfterDatabaseRestore(req);
    } catch (sessionError) {
      logger.warn(`Database pulih tetapi sesi lama gagal dibersihkan: ${sessionError.message}`);
    }
    return res.json({
      message: 'Database berhasil dipulihkan',
      ...result
    });
  } catch (error) {
    logger.error(`Restore database gagal (${backup.filename})`, error);
    return res.status(error.code === 'INVALID_DATABASE_BACKUP' ? 400 : 500).json({
      error: error.code === 'INVALID_DATABASE_BACKUP'
        ? error.message
        : 'Restore database gagal. Database pengaman tetap dipertahankan.'
    });
  } finally {
    databaseRestoreInProgress = false;
  }
});

// ENDPOINT UNTUK EXPORT BACKUP KE EXCEL
app.get('/api/export-backup/:filename', requireLogin, requireAdmin, async (req, res) => {
  const { filename } = req.params;
  
  if (!isSafeBackupFilename(filename)) {
    return res.status(400).json({ error: 'Invalid backup filename' });
  }

  try {
    const snapshot = getSnapshotByFilename(filename);
    if (!snapshot) return res.status(404).json({ error: 'Backup file not found' });
    const backupData = readSnapshotData(snapshot);
    const date = snapshot.snapshotDate;
    
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Production Dashboard System';
    workbook.lastModifiedBy = 'Production Dashboard System';
    workbook.created = new Date();
    workbook.modified = new Date();
    
    const headerStyle = {
      font: { bold: true, color: { argb: 'FFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: '4472C4' } },
      alignment: { horizontal: 'center', vertical: 'middle' },
      border: {
        top: { style: 'thin', color: { argb: '000000' } },
        left: { style: 'thin', color: { argb: '000000' } },
        bottom: { style: 'thin', color: { argb: '000000' } },
        right: { style: 'thin', color: { argb: '000000' } }
      }
    };
    
    const titleStyle = {
      font: { bold: true, size: 16, color: { argb: '1F4E78' } },
      alignment: { horizontal: 'center', vertical: 'middle' }
    };
    
    const dataStyle = {
      font: { size: 11 },
      border: {
        top: { style: 'thin', color: { argb: 'D9D9D9' } },
        left: { style: 'thin', color: { argb: 'D9D9D9' } },
        bottom: { style: 'thin', color: { argb: 'D9D9D9' } },
        right: { style: 'thin', color: { argb: 'D9D9D9' } }
      }
    };
    
    const summarySheet = workbook.addWorksheet('BACKUP SUMMARY');
    
	  summarySheet.mergeCells('A1:H1');
    const titleCell = summarySheet.getCell('A1');
    titleCell.value = `BACKUP DATA - ${date}`;
    titleCell.style = titleStyle;
    
    summarySheet.getCell('A3').value = 'Backup File';
    summarySheet.getCell('B3').value = filename;
    summarySheet.getCell('A4').value = 'Backup Date';
    summarySheet.getCell('B4').value = date;
    summarySheet.getCell('A5').value = 'Generated Date';
    summarySheet.getCell('B5').value = backupData.backupDate || new Date().toISOString();
    summarySheet.getCell('A6').value = 'Total Lines';
    summarySheet.getCell('B6').value = Object.keys(backupData.lines).length;
    
    const headers = ['Line', 'Model ID', 'Label/Week', 'Model', 'Date', 'Target', 'Output', 'Defect Rate %'];
    summarySheet.getRow(8).values = headers;
    summarySheet.getRow(8).eachCell((cell) => {
      cell.style = headerStyle;
    });
    
    let rowIndex = 9;
    Object.keys(backupData.lines).forEach(lineName => {
      const line = backupData.lines[lineName];
      Object.keys(line.models).forEach(modelId => {
        const model = line.models[modelId];
        
        const row = summarySheet.getRow(rowIndex);
        row.values = [
          lineName,
          modelId,
          model.labelWeek || '',
          model.model || '',
          model.date || '',
          model.target || 0,
          model.outputDay || 0,
          (model.defectRatePercentage || 0) + '%'
        ];
        
        row.eachCell((cell) => {
          cell.style = dataStyle;
        });
        
        rowIndex++;
      });
    });
    
    summarySheet.columns = [
      { width: 15 },
      { width: 12 },
      { width: 15 },
      { width: 30 },
      { width: 12 },
      { width: 12 },
      { width: 12 },
      { width: 15 }
    ];
    
    Object.keys(backupData.lines).forEach(lineName => {
      const line = backupData.lines[lineName];
      const lineSheet = workbook.addWorksheet(lineName.substring(0, 31));
      
      let currentRow = 1;
      
      lineSheet.mergeCells(`A${currentRow}:G${currentRow}`);
      const lineTitle = lineSheet.getCell(`A${currentRow}`);
      lineTitle.value = `BACKUP DATA - ${lineName} - ${date}`;
      lineTitle.style = titleStyle;
      currentRow += 2;
      
      Object.keys(line.models).forEach(modelId => {
        const model = line.models[modelId];
        
        lineSheet.getCell(`A${currentRow}`).value = 'Model ID';
        lineSheet.getCell(`B${currentRow}`).value = modelId;
        currentRow++;
        
        lineSheet.getCell(`A${currentRow}`).value = 'Label/Week';
        lineSheet.getCell(`B${currentRow}`).value = model.labelWeek || '';
        currentRow++;
        
        lineSheet.getCell(`A${currentRow}`).value = 'Model';
        lineSheet.getCell(`B${currentRow}`).value = model.model || '';
        currentRow++;
        
	      lineSheet.getCell(`A${currentRow}`).value = 'Tanggal';
        lineSheet.getCell(`B${currentRow}`).value = model.date || '';
        currentRow++;
        
        lineSheet.getCell(`A${currentRow}`).value = 'Target';
        lineSheet.getCell(`B${currentRow}`).value = model.target || 0;
        currentRow++;
        
        lineSheet.getCell(`A${currentRow}`).value = 'Output';
        lineSheet.getCell(`B${currentRow}`).value = model.outputDay || 0;
        currentRow++;
        
        lineSheet.getCell(`A${currentRow}`).value = 'Defect Rate';
        lineSheet.getCell(`B${currentRow}`).value = (model.defectRatePercentage || 0) + '%';
        currentRow += 2;
        
        const hourlyHeaders = ['Jam', 'Target Manual', 'Output', 'Selisih', 'Defect', 'QC Checked', 'Defect Rate %'];
        lineSheet.getRow(currentRow).values = hourlyHeaders;
        lineSheet.getRow(currentRow).eachCell((cell) => {
          cell.style = headerStyle;
        });
        currentRow++;
        
        if (model.hourly_data && model.hourly_data.length > 0) {
          model.hourly_data.forEach(hour => {
            const defectRate = hour.qcChecked > 0 ? ((hour.defect / hour.qcChecked) * 100).toFixed(2) : '0.00';
            const selisih = (hour.output || 0) - (hour.targetManual || 0);
            
            const row = lineSheet.getRow(currentRow);
            row.values = [
              hour.hour,
              hour.targetManual || 0,
              hour.output || 0,
              selisih,
              hour.defect || 0,
              hour.qcChecked || 0,
              defectRate + '%'
            ];
            
            row.eachCell((cell) => {
              cell.style = dataStyle;
            });
            
            currentRow++;
          });
        }
        
        currentRow += 3;
      });
      
      lineSheet.columns = [
        { width: 15 },
        { width: 25 },
        { width: 12 },
        { width: 12 },
        { width: 12 },
        { width: 15 },
        { width: 15 }
      ];
    });
    
    const downloadFilename = `Backup_Data_${date}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    await workbook.xlsx.write(res);
  } catch (error) {
    logger.error('Gagal mengekspor backup', error);
    res.status(500).json({ error: 'Failed to export backup: ' + error.message });
  }
});

// ENDPOINT UNTUK MENGORGANISIR FILE BACKUP
app.post('/api/organize-backups', requireLogin, requireAdmin, async (req, res) => {
  try {
    const legacyCount = getLegacyHistoryJsonFiles().length;
    await migrateLegacyHistoryToDatabase();
    const recoveredCount = await recoverProductionSnapshotsFromDatabaseBackups();
    res.json({
      message: '✅ Snapshot lama sudah dimigrasikan dan dipulihkan ke database',
      movedCount: legacyCount,
      recoveredCount,
      backupDir: databaseBackupDir
    });
  } catch (error) {
    logger.error('Gagal mengatur backup', error);
    res.status(500).json({ error: 'Failed to organize backups: ' + error.message });
  }
});

// ENDPOINT UNTUK CEK STATUS SISTEM
app.get('/api/system-status', requireLogin, requireAdmin, async (req, res) => {
  const data = readProductionData();
  const today = getToday();
  const now = new Date();
  
  let modelCount = 0;
  let todayModelCount = 0;
  let otherDateModelCount = 0;
  const modelDates = {};
  
  Object.keys(data.lines).forEach(lineName => {
    const line = data.lines[lineName];
    Object.keys(line.models).forEach(modelId => {
      const model = line.models[modelId];
      modelCount++;
      
      if (model.date === today) {
        todayModelCount++;
      } else {
        otherDateModelCount++;
        if (!modelDates[model.date]) {
          modelDates[model.date] = 0;
        }
        modelDates[model.date]++;
      }
    });
  });
  
  const databaseBackups = listDatabaseBackupFiles();
  const backupCount = productionSnapshotCache.size + databaseBackups.length;
  const latestSnapshot = Array.from(productionSnapshotCache.values())
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
  const lastBackupCandidates = [
    latestSnapshot ? { filename: latestSnapshot.filename, size: latestSnapshot.size, created: latestSnapshot.updatedAt } : null,
    databaseBackups[0] || null
  ].filter(Boolean).sort((a, b) => new Date(b.created) - new Date(a.created));
  const lastBackup = lastBackupCandidates[0] || null;
  
  res.json({
    systemTime: now.toLocaleString('id-ID'),
    systemTimeUTC: now.toISOString(),
    today: today,
    modelCount: modelCount,
    todayModelCount: todayModelCount,
    otherDateModelCount: otherDateModelCount,
    modelDates: modelDates,
    backupCount: backupCount,
    lastBackup: lastBackup,
    dataSize: fs.existsSync(databasePath) ? fs.statSync(databasePath).size : Buffer.byteLength(JSON.stringify(data), 'utf8'),
    needsSync: otherDateModelCount > 0
  });
});

// ENDPOINT UNTUK MENDAPATKAN DAFTAR TANGGAL YANG TERSEDIA
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

function addToCounter(counter, key, amount = 1) {
  const label = String(key || '').trim();
  if (!label) return;
  counter[label] = (counter[label] || 0) + (parseInt(amount) || 0 || 1);
}

function formatCounter(counter) {
  const items = Object.entries(counter || {})
    .filter(([, count]) => (parseInt(count) || 0) > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return items.length ? items.map(([name, count]) => `${name} (${count})`).join(', ') : '-';
}

function summarizeDefectCategoriesFromDetails(details = []) {
  const typeCounts = {};
  const areaCounts = {};

  (details || []).forEach(detail => {
    const quantity = parseInt(detail.quantity) || 1;
    addToCounter(typeCounts, detail.type, quantity);
    addToCounter(areaCounts, detail.area, quantity);
  });

  return {
    types: formatCounter(typeCounts),
    areas: formatCounter(areaCounts)
  };
}

function getDefectSeverityLabel(type, config = readDefectConfig()) {
  const severity = getDefectSeverity(type, buildDefectSeverityMaps(config));
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

function summarizeModelDefectCategories(model = {}) {
  const typeCounts = {};
  const areaCounts = {};

  (model.hourly_data || []).forEach(hour => {
    (hour.defectDetails || []).forEach(detail => {
      const quantity = parseInt(detail.quantity) || 1;
      addToCounter(typeCounts, detail.type, quantity);
      addToCounter(areaCounts, detail.area, quantity);
    });
  });

  (model.qcChecks || [])
    .filter(check => check.result === 'defect')
    .forEach(check => {
      addToCounter(typeCounts, check.type, 1);
      addToCounter(areaCounts, check.area, 1);
    });

  return {
    types: formatCounter(typeCounts),
    areas: formatCounter(areaCounts)
  };
}

// Keep the browser report and every Excel export on the same dated dataset.
function filterProductionDataByDate(data, date) {
  const lines = {};

  Object.entries(data?.lines || {}).forEach(([lineName, line]) => {
    const models = Object.fromEntries(
      Object.entries(line.models || {}).filter(([, model]) => model?.date === date)
    );

    if (Object.keys(models).length > 0) {
      lines[lineName] = { ...line, models };
    }
  });

  return { ...data, lines };
}

function filterProductionDataByLine(data, lineName) {
  const selectedLine = String(lineName || '').trim();
  if (!selectedLine) return { ...data, lines: { ...(data?.lines || {}) } };

  const line = data?.lines?.[selectedLine];
  return {
    ...data,
    lines: line ? { [selectedLine]: line } : {},
    activeLine: line ? selectedLine : ''
  };
}

function isValidDateRange(startDate, endDate) {
  return isValidDateInput(startDate)
    && isValidDateInput(endDate)
    && startDate <= endDate;
}

function getReportDatesInRange(startDate, endDate) {
  const dates = new Set(getAvailableHistoryDates());
  dates.add(getToday());

  return Array.from(dates)
    .filter(date => date >= startDate && date <= endDate)
    .sort((a, b) => a.localeCompare(b));
}

function readProductionSnapshotForDate(date) {
  const snapshot = getLatestSnapshotForDate(date);
  return readSnapshotData(snapshot) || (date === getToday() ? readProductionData() : null);
}

function mergeProductionSnapshotsByDate(snapshots = []) {
  const mergedData = { lines: {}, activeLine: '' };

  snapshots.forEach(({ date, data }) => {
    const filteredData = filterProductionDataByDate(data, date);

    Object.entries(filteredData.lines || {}).forEach(([lineName, line]) => {
      if (!mergedData.lines[lineName]) {
        mergedData.lines[lineName] = { models: {}, activeModels: [] };
      }

      Object.entries(line.models || {}).forEach(([modelId, model]) => {
        const reportModelKey = `${date}::${modelId}`;
        mergedData.lines[lineName].models[reportModelKey] = {
          ...model,
          reportModelId: modelId
        };
        mergedData.lines[lineName].activeModels.push(reportModelKey);
      });
    });
  });

  return mergedData;
}

function buildDateRangeProductionData(startDate, endDate) {
  const snapshots = getReportDatesInRange(startDate, endDate)
    .map(date => ({ date, data: readProductionSnapshotForDate(date) }))
    .filter(snapshot => snapshot.data);

  return mergeProductionSnapshotsByDate(snapshots);
}

function buildProductionReportRows(data) {
  return Object.entries(data?.lines || {}).flatMap(([lineName, line]) =>
    Object.entries(line.models || {}).map(([modelId, model]) => {
      const defectBreakdown = calculateDefectSeverityBreakdown(model);
      const defectCategories = summarizeModelDefectCategories(model);
      const target = model.target || 0;
      const output = model.outputDay || 0;
      const defect = model.actualDefect || 0;
      const qcChecked = model.qcChecking || 0;
      return {
        line: lineName,
        modelId: model.reportModelId || modelId,
        labelWeek: model.labelWeek,
        model: model.model,
        date: model.date,
        target,
        output,
        achievement: target > 0 ? parseFloat(((output / target) * 100).toFixed(2)) : 0,
        defect,
        criticalDefect: defectBreakdown.critical.count,
        majorDefect: defectBreakdown.major.count,
        minorDefect: defectBreakdown.minor.count,
        qcChecked,
        good: Math.max(qcChecked - defect, 0),
        defectRate: model.defectRatePercentage || 0,
        defectAreas: defectCategories.areas,
        defectTypes: defectCategories.types
      };
    })
  );
}

function buildDateReportRows(data, date) {
  const filteredData = filterProductionDataByDate(data, date);
  return buildProductionReportRows(filteredData);
}

function getQcCheckHourLabel(model = {}, check = {}) {
  const index = parseNonNegativeInteger(check.hourIndex);
  if (Number.isInteger(index) && model.hourly_data && model.hourly_data[index]) {
    return model.hourly_data[index].hour || check.hour || '-';
  }

  if (check.hour) return check.hour;

  if (check.checkedAt) {
    const checkedDate = new Date(check.checkedAt);
    if (!Number.isNaN(checkedDate.getTime())) {
      return checkedDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    }
  }

  return '-';
}

function createProductionSummary(date, lineName = '') {
  return {
    date,
    lineName,
    lineCount: 0,
    modelCount: 0,
    target: 0,
    output: 0,
    defect: 0,
    criticalDefect: 0,
    majorDefect: 0,
    minorDefect: 0,
    qcChecked: 0,
    defectRate: 0,
    areaCounts: {},
    typeCounts: {}
  };
}

function addModelToProductionSummary(summary, model, defectConfig = readDefectConfig()) {
  summary.modelCount += 1;
  summary.target += parseInt(model.target) || 0;
  summary.output += parseInt(model.outputDay) || 0;
  summary.defect += parseInt(model.actualDefect) || 0;
  summary.qcChecked += parseInt(model.qcChecking) || 0;

  const defectBreakdown = calculateDefectSeverityBreakdown(model, defectConfig);
  summary.criticalDefect += defectBreakdown.critical.count;
  summary.majorDefect += defectBreakdown.major.count;
  summary.minorDefect += defectBreakdown.minor.count;

  (model.hourly_data || []).forEach(hour => {
    (hour.defectDetails || []).forEach(detail => {
      const quantity = parseInt(detail.quantity) || 1;
      addToCounter(summary.typeCounts, detail.type, quantity);
      addToCounter(summary.areaCounts, detail.area, quantity);
    });
  });

  (model.qcChecks || [])
    .filter(check => check.result === 'defect')
    .forEach(check => {
      addToCounter(summary.typeCounts, check.type, 1);
      addToCounter(summary.areaCounts, check.area, 1);
    });
}

function finalizeProductionSummary(summary) {
  summary.defectRate = summary.qcChecked > 0
    ? parseFloat(((summary.defect / summary.qcChecked) * 100).toFixed(2))
    : 0;
  return summary;
}

function summarizeProductionSnapshot(data, date, defectConfig = readDefectConfig()) {
  const summary = {
    date,
    lineCount: 0,
    modelCount: 0,
    target: 0,
    output: 0,
    defect: 0,
    criticalDefect: 0,
    majorDefect: 0,
    minorDefect: 0,
    qcChecked: 0,
    defectRate: 0,
    areaCounts: {},
    typeCounts: {}
  };

  Object.keys(data.lines || {}).forEach(lineName => {
    const line = ensureLineActiveModels(data.lines[lineName]);
    let hasModelForDate = false;

    (line.activeModels || []).forEach(modelId => {
      const model = line.models[modelId];
      if (!model) return;
      if (model.date && model.date !== date) return;

      hasModelForDate = true;
      summary.modelCount += 1;
      summary.target += parseInt(model.target) || 0;
      summary.output += parseInt(model.outputDay) || 0;
      summary.defect += parseInt(model.actualDefect) || 0;
      summary.qcChecked += parseInt(model.qcChecking) || 0;

      const defectBreakdown = calculateDefectSeverityBreakdown(model, defectConfig);
      summary.criticalDefect += defectBreakdown.critical.count;
      summary.majorDefect += defectBreakdown.major.count;
      summary.minorDefect += defectBreakdown.minor.count;

      (model.hourly_data || []).forEach(hour => {
        (hour.defectDetails || []).forEach(detail => {
          const quantity = parseInt(detail.quantity) || 1;
          addToCounter(summary.typeCounts, detail.type, quantity);
          addToCounter(summary.areaCounts, detail.area, quantity);
        });
      });

      (model.qcChecks || [])
        .filter(check => check.result === 'defect')
        .forEach(check => {
          addToCounter(summary.typeCounts, check.type, 1);
          addToCounter(summary.areaCounts, check.area, 1);
        });
    });

    if (hasModelForDate) summary.lineCount += 1;
  });

  summary.defectRate = summary.qcChecked > 0
    ? parseFloat(((summary.defect / summary.qcChecked) * 100).toFixed(2))
    : 0;

  return summary;
}

function summarizeProductionSnapshotByLine(data, date, defectConfig = readDefectConfig()) {
  const summaries = [];

  Object.keys(data.lines || {}).forEach(lineName => {
    const line = data.lines[lineName];
    const normalizedLine = ensureLineActiveModels(line);
    const activeModelIds = normalizedLine.activeModels || [];

    activeModelIds.forEach(activeModelId => {
      const activeModel = normalizedLine.models?.[activeModelId];
      if (!activeModel || (activeModel.date && activeModel.date !== date)) return;

      const summary = createProductionSummary(date, lineName);
      addModelToProductionSummary(summary, activeModel, defectConfig);
      if (summary.modelCount > 0) {
        summary.lineCount = 1;
        summary.modelId = activeModelId;
        summary.labelWeek = activeModel.labelWeek || '';
        summary.model = activeModel.model || '';
        summaries.push(finalizeProductionSummary(summary));
      }
    });
  });

  return summaries;
}

function topCounterItems(counter, limit = 5) {
  return Object.entries(counter)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

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

app.post('/api/update-hourly/:lineName', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, async (req, res) => {
  const { lineName } = req.params;
  const { hourIndex, output, defect, qcChecked, targetManual, defectDetails } = req.body;
  const data = readProductionData();
  const active = getActiveModel(data, lineName);

  if (!active || !active.model.hourly_data) {
    return res.status(404).json({ error: 'Line, active model or hourly data not found' });
  }

  const index = parseNonNegativeInteger(hourIndex);
  if (!Number.isInteger(index) || index < 0 || index >= active.model.hourly_data.length) {
    return res.status(400).json({ error: 'Invalid hour index' });
  }

	  const currentHour = active.model.hourly_data[index];
	  if (rejectUnavailableOperatorProductionHour(req, res, currentHour)) return;
	  if (rejectBlankOperatorProductionOutput(req, res, output)) return;
	  if (hasAnyRole(req.session.user, ['admin_operator_sewing']) && (defect !== undefined || qcChecked !== undefined || defectDetails !== undefined)) {
	    return res.status(403).json({ error: 'Admin Operator Sewing tidak dapat mengubah data QC' });
	  }

	  const nextTargetManual = targetManual !== undefined
	    ? parseNonNegativeInteger(targetManual)
	    : parseNonNegativeInteger(currentHour.targetManual, 0);
	  const nextOutput = parseNonNegativeInteger(output, 0);
	  const nextDefect = parseNonNegativeInteger(defect, parseNonNegativeInteger(currentHour.defect, 0));
	  const nextQcChecked = parseNonNegativeInteger(qcChecked, parseNonNegativeInteger(currentHour.qcChecked, 0));
  if ([nextTargetManual, nextOutput, nextDefect, nextQcChecked].includes(null)) {
	    return res.status(400).json({ error: 'Data produksi dan QC harus berupa bilangan bulat tidak negatif' });
	  }

  active.model.hourly_data[index] = {
    ...currentHour,
	    output: nextOutput,
	    defect: nextDefect,
	    qcChecked: nextQcChecked,
	    targetManual: nextTargetManual,
	    defectDetails: Array.isArray(defectDetails) ? defectDetails : (currentHour.defectDetails || []),
	    productionLocked: req.session.user?.role === 'operator' ? true : Boolean(currentHour.productionLocked),
	    productionLockedAt: req.session.user?.role === 'operator' ? new Date().toISOString() : currentHour.productionLockedAt,
	    productionLockedBy: req.session.user?.role === 'operator' ? req.session.user.username : currentHour.productionLockedBy,
	    selisih: nextOutput - nextTargetManual
	  };

  const summary = recalculateModelTotals(active.model);

  await writeProductionData(data);
  updateTodayBackup();

  res.json({
    message: 'Hourly data updated successfully.',
    data: active.model,
    modelId: active.modelId,
    summary: {
      ...summary,
      defectRate: active.model.defectRatePercentage.toFixed(2) + '%'
    }
  });
});

app.post('/api/update-target-manual/:lineName', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, async (req, res) => {
  const { lineName } = req.params;
  const { hourIndex, targetManual } = req.body;
  const data = readProductionData();
  const active = getActiveModel(data, lineName);

  if (!active || !active.model.hourly_data) {
    return res.status(404).json({ error: 'Line, active model or hourly data not found' });
  }

  const index = parseNonNegativeInteger(hourIndex);
  if (!Number.isInteger(index) || index < 0 || index >= active.model.hourly_data.length) {
    return res.status(400).json({ error: 'Invalid hour index' });
  }

	  if (rejectUnavailableOperatorProductionHour(req, res, active.model.hourly_data[index])) return;

	  const nextTargetManual = parseNonNegativeInteger(targetManual);
	  if (nextTargetManual === null) {
	    return res.status(400).json({ error: 'Target harus berupa bilangan bulat tidak negatif' });
	  }
  active.model.hourly_data[index].targetManual = nextTargetManual;
  active.model.hourly_data[index].selisih = (parseInt(active.model.hourly_data[index].output) || 0) - nextTargetManual;
  const summary = recalculateModelTotals(active.model);

  await writeProductionData(data);
  updateTodayBackup();

  res.json({
    message: 'Target manual updated successfully.',
    data: active.model.hourly_data[index],
    modelId: active.modelId,
    totalTarget: summary.totalTarget
  });
});

app.post('/api/update-hourly-direct/:lineName', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, async (req, res) => {
  const { lineName } = req.params;
  const { hourIndex, output, defect, qcChecked, targetManual } = req.body;
  const data = readProductionData();
  const active = getActiveModel(data, lineName);

  if (!active || !active.model.hourly_data) {
    return res.status(404).json({ error: 'Line, active model or hourly data not found' });
  }

  const index = parseNonNegativeInteger(hourIndex);
  if (!Number.isInteger(index) || index < 0 || index >= active.model.hourly_data.length) {
    return res.status(400).json({ error: 'Invalid hour index' });
  }

	  const nextOutput = parseNonNegativeInteger(output, 0);
	  const nextTargetManual = parseNonNegativeInteger(targetManual, 0);
	  const nextDefect = parseNonNegativeInteger(defect, parseNonNegativeInteger(active.model.hourly_data[index].defect, 0));
	  const nextQcChecked = parseNonNegativeInteger(qcChecked, parseNonNegativeInteger(active.model.hourly_data[index].qcChecked, 0));
	  if (hasAnyRole(req.session.user, ['admin_operator_sewing']) && (defect !== undefined || qcChecked !== undefined)) {
	    return res.status(403).json({ error: 'Admin Operator Sewing tidak dapat mengubah data QC' });
	  }
	  if ([nextOutput, nextTargetManual, nextDefect, nextQcChecked].includes(null)) {
	    return res.status(400).json({ error: 'Data produksi dan QC harus berupa bilangan bulat tidak negatif' });
	  }
	  if (rejectUnavailableOperatorProductionHour(req, res, active.model.hourly_data[index])) return;
	  if (rejectBlankOperatorProductionOutput(req, res, output)) return;

	  active.model.hourly_data[index] = {
	    ...active.model.hourly_data[index],
	    output: nextOutput,
	    defect: nextDefect,
	    qcChecked: nextQcChecked,
	    targetManual: nextTargetManual,
	    productionLocked: req.session.user?.role === 'operator' ? true : Boolean(active.model.hourly_data[index].productionLocked),
	    productionLockedAt: req.session.user?.role === 'operator' ? new Date().toISOString() : active.model.hourly_data[index].productionLockedAt,
	    productionLockedBy: req.session.user?.role === 'operator' ? req.session.user.username : active.model.hourly_data[index].productionLockedBy,
	    selisih: nextOutput - nextTargetManual
	  };

  const summary = recalculateModelTotals(active.model);

  await writeProductionData(data);
  updateTodayBackup();

  res.json({
    message: 'Hourly data updated successfully.',
    data: active.model,
    modelId: active.modelId,
    summary: {
      ...summary,
      defectRate: active.model.defectRatePercentage.toFixed(2) + '%'
    }
  });
});

app.post('/api/update-hourly/:lineName/:modelId', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, requireActiveModelForOperator, async (req, res) => {
  const { lineName, modelId } = req.params;
  const { hourIndex, output, defect, qcChecked, targetManual, defectDetails } = req.body;

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
    return res.status(404).json({ error: 'Line, model or hourly data not found' });
  }

  const index = parseNonNegativeInteger(hourIndex);
  if (!Number.isInteger(index) || index < 0 || index >= data.lines[lineName].models[modelId].hourly_data.length) {
    return res.status(400).json({ error: 'Invalid hour index' });
  }

  const currentHour = data.lines[lineName].models[modelId].hourly_data[index];
  if (rejectUnavailableOperatorProductionHour(req, res, currentHour)) return;
  if (rejectBlankOperatorProductionOutput(req, res, output)) return;
  if (hasAnyRole(req.session.user, ['admin_operator_sewing']) && (defect !== undefined || qcChecked !== undefined || defectDetails !== undefined)) {
    return res.status(403).json({ error: 'Admin Operator Sewing tidak dapat mengubah data QC' });
  }
  const nextTargetManual = parseNonNegativeInteger(targetManual, parseNonNegativeInteger(currentHour.targetManual, 0));
  const nextOutput = parseNonNegativeInteger(output, 0);
  const nextDefect = parseNonNegativeInteger(defect, parseNonNegativeInteger(currentHour.defect, 0));
  const nextQcChecked = parseNonNegativeInteger(qcChecked, parseNonNegativeInteger(currentHour.qcChecked, 0));
  if ([nextTargetManual, nextOutput, nextDefect, nextQcChecked].includes(null)) {
    return res.status(400).json({ error: 'Data produksi dan QC harus berupa bilangan bulat tidak negatif' });
  }
  const selisih = nextOutput - nextTargetManual;

  data.lines[lineName].models[modelId].hourly_data[index] = {
    ...currentHour,
    output: nextOutput,
    defect: nextDefect,
    qcChecked: nextQcChecked,
    targetManual: nextTargetManual,
    defectDetails: Array.isArray(defectDetails) ? defectDetails : (currentHour.defectDetails || []),
    productionLocked: req.session.user?.role === 'operator' ? true : Boolean(currentHour.productionLocked),
    productionLockedAt: req.session.user?.role === 'operator' ? new Date().toISOString() : currentHour.productionLockedAt,
    productionLockedBy: req.session.user?.role === 'operator' ? req.session.user.username : currentHour.productionLockedBy,
    selisih: selisih
  };

  const summary = recalculateModelTotals(data.lines[lineName].models[modelId]);

  await writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI SETELAH MENGUPDATE DATA
  updateTodayBackup();
  
  res.json({
    message: 'Hourly data updated successfully.',
    data: data.lines[lineName].models[modelId],
    summary: {
      ...summary,
      defectRate: data.lines[lineName].models[modelId].defectRatePercentage.toFixed(2) + '%'
    }
  });
});

app.post('/api/update-production/:lineName/:modelId', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, requireActiveModelForOperator, async (req, res) => {
  const { lineName, modelId } = req.params;
  const { hourIndex, output, targetManual } = req.body;
  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
    return res.status(404).json({ error: 'Line, model or hourly data not found' });
  }

  const index = parseNonNegativeInteger(hourIndex);
  const model = data.lines[lineName].models[modelId];
  if (!Number.isInteger(index) || index < 0 || index >= model.hourly_data.length) {
    return res.status(400).json({ error: 'Invalid hour index' });
  }

	  const currentHour = model.hourly_data[index];
	  if (rejectUnavailableOperatorProductionHour(req, res, currentHour)) return;
	  if (rejectBlankOperatorProductionOutput(req, res, output)) return;

  const nextOutput = parseNonNegativeInteger(output, 0);
  const nextTargetManual = parseNonNegativeInteger(targetManual, parseNonNegativeInteger(currentHour.targetManual, 0));
  if (nextOutput === null || nextTargetManual === null) {
    return res.status(400).json({ error: 'Output dan target harus berupa bilangan bulat tidak negatif' });
  }

	  model.hourly_data[index] = {
	    ...currentHour,
	    output: nextOutput,
	    targetManual: nextTargetManual,
	    productionLocked: req.session.user?.role === 'operator' ? true : Boolean(currentHour.productionLocked),
	    productionLockedAt: req.session.user?.role === 'operator' ? new Date().toISOString() : currentHour.productionLockedAt,
	    productionLockedBy: req.session.user?.role === 'operator' ? req.session.user.username : currentHour.productionLockedBy,
	    selisih: nextOutput - nextTargetManual
	  };

  const summary = recalculateModelTotals(model);
  await writeProductionData(data);
  updateTodayBackup();

  res.json({
    message: 'Production data updated successfully.',
    data: model,
    summary: {
      ...summary,
      defectRate: model.defectRatePercentage.toFixed(2) + '%'
    }
  });
});

app.post('/api/qc-check/:lineName/:modelId', requireLogin, requireLineAccess, requireQcWriteAccess, autoCheckDateReset, requireActiveModelForOperator, async (req, res) => {
  if (req.session.user?.role === 'operator') {
    const jakartaTimeParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jakarta', hour: 'numeric', minute: 'numeric', hour12: false
    }).formatToParts(new Date());
    const jakartaHour = Number(jakartaTimeParts.find(part => part.type === 'hour')?.value || 0) % 24;
    const jakartaMinute = Number(jakartaTimeParts.find(part => part.type === 'minute')?.value || 0);
    const currentMinutes = jakartaHour * 60 + jakartaMinute;
    if (currentMinutes < 7 * 60 || currentMinutes >= 17 * 60) {
      return res.status(403).json({ error: 'Input QC operator hanya dapat dilakukan pukul 07:00-17:00' });
    }
  }
  const { lineName, modelId } = req.params;
	  const { result, hourIndex, type, area, notes } = req.body;
  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].models[modelId]) {
    return res.status(404).json({ error: 'Line or model not found' });
  }

  if (!['good', 'defect'].includes(result)) {
    return res.status(400).json({ error: 'QC result must be good or defect' });
  }

  if (result === 'defect' && (!type || !area)) {
    return res.status(400).json({ error: 'Jenis defect dan area defect wajib dipilih' });
  }

  const defectCategory = result === 'defect'
    ? resolveActiveDefectCategories(type, area)
    : null;
  if (result === 'defect' && !defectCategory.isValid) {
    return res.status(400).json({ error: 'Jenis defect dan area defect harus dipilih dari kategori aktif' });
  }

	  const model = data.lines[lineName].models[modelId];
	  model.qcChecks = Array.isArray(model.qcChecks) ? model.qcChecks : [];
	  const parsedHourIndex = parseNonNegativeInteger(hourIndex);
	  const validHourIndex = Number.isInteger(parsedHourIndex) && model.hourly_data && model.hourly_data[parsedHourIndex]
	    ? parsedHourIndex
	    : null;

	  const qcCheck = {
	    id: generateNumericId(model.qcChecks),
	    result,
	    hourIndex: validHourIndex,
	    hour: validHourIndex !== null ? model.hourly_data[validHourIndex].hour : '',
	    type: defectCategory?.type || '',
	    area: defectCategory?.area || '',
    notes: notes ? String(notes).trim() : '',
    checkedAt: new Date().toISOString()
  };

  model.qcChecks.push(qcCheck);

  const summary = recalculateModelTotals(model);
  await writeProductionData(data);
  updateTodayBackup();

  res.json({
    message: result === 'defect' ? 'Defect QC recorded successfully.' : 'Good QC recorded successfully.',
    qcCheck,
    data: model,
    summary: {
      ...summary,
      defectRate: model.defectRatePercentage.toFixed(2) + '%'
    }
  });
});

app.post('/api/update-target-manual/:lineName/:modelId', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, requireActiveModelForOperator, async (req, res) => {
  const { lineName, modelId } = req.params;
  const { hourIndex, targetManual } = req.body;

  const data = readProductionData();

	  if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
	    return res.status(404).json({ error: 'Line, model or hourly data not found' });
	  }

	  const index = parseNonNegativeInteger(hourIndex);
	  const model = data.lines[lineName].models[modelId];
	  if (!Number.isInteger(index) || index < 0 || index >= model.hourly_data.length) {
	    return res.status(400).json({ error: 'Invalid hour index' });
	  }

	  const currentHour = model.hourly_data[index];
	  if (rejectUnavailableOperatorProductionHour(req, res, currentHour)) return;

	  const nextTargetManual = parseNonNegativeInteger(targetManual);
	  if (nextTargetManual === null) {
	    return res.status(400).json({ error: 'Target harus berupa bilangan bulat tidak negatif' });
	  }

	  model.hourly_data[index].targetManual = nextTargetManual;
	  model.hourly_data[index].selisih = (parseNonNegativeInteger(model.hourly_data[index].output, 0) || 0) - nextTargetManual;

	  let totalTarget = 0;
	  model.hourly_data.forEach(hour => {
	    totalTarget += hour.targetManual || 0;
	  });
	  model.target = totalTarget;

  await writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
	  res.json({
	    message: 'Target manual updated successfully.',
	    data: model.hourly_data[index],
	    totalTarget: totalTarget
	  });
});

app.post('/api/update-hourly-direct/:lineName/:modelId', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, requireActiveModelForOperator, async (req, res) => {
  const { lineName, modelId } = req.params;
  const { hourIndex, output, defect, qcChecked, targetManual, defectDetails } = req.body;

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
    return res.status(404).json({ error: 'Line, model or hourly data not found' });
  }

  const index = parseNonNegativeInteger(hourIndex);
  const model = data.lines[lineName].models[modelId];
  if (!Number.isInteger(index) || index < 0 || index >= model.hourly_data.length) {
    return res.status(400).json({ error: 'Invalid hour index' });
  }

  const currentHour = model.hourly_data[index];
  if (rejectUnavailableOperatorProductionHour(req, res, currentHour)) return;
  if (rejectBlankOperatorProductionOutput(req, res, output)) return;

  if (hasAnyRole(req.session.user, ['admin_operator_sewing']) && (defect !== undefined || qcChecked !== undefined || defectDetails !== undefined)) {
    return res.status(403).json({ error: 'Admin Operator Sewing tidak dapat mengubah data QC' });
  }
  const nextOutput = parseNonNegativeInteger(output, 0);
  const nextDefect = parseNonNegativeInteger(defect, parseNonNegativeInteger(currentHour.defect, 0));
  const nextQcChecked = parseNonNegativeInteger(qcChecked, parseNonNegativeInteger(currentHour.qcChecked, 0));
  const nextTargetManual = parseNonNegativeInteger(targetManual, 0);
  if ([nextOutput, nextDefect, nextQcChecked, nextTargetManual].includes(null)) {
    return res.status(400).json({ error: 'Data produksi dan QC harus berupa bilangan bulat tidak negatif' });
  }
  const selisih = nextOutput - nextTargetManual;

  model.hourly_data[index] = {
    ...currentHour,
    output: nextOutput,
    defect: nextDefect,
    qcChecked: nextQcChecked,
    targetManual: nextTargetManual,
    defectDetails: Array.isArray(defectDetails) ? defectDetails : (currentHour.defectDetails || []),
    productionLocked: req.session.user?.role === 'operator' ? true : Boolean(currentHour.productionLocked),
    productionLockedAt: req.session.user?.role === 'operator' ? new Date().toISOString() : currentHour.productionLockedAt,
    productionLockedBy: req.session.user?.role === 'operator' ? req.session.user.username : currentHour.productionLockedBy,
    selisih
  };

  const summary = recalculateModelTotals(model);

  await writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({
    message: 'Hourly data updated successfully.',
    data: model,
    summary: {
      ...summary,
      defectRate: model.defectRatePercentage.toFixed(2) + '%'
    }
  });
});

app.get('/api/history/files', requireLogin, requireAdmin, async (req, res) => {
  try {
    const historyFiles = getHistoryFiles();
    res.json(historyFiles);
  } catch (error) {
    logger.error('Gagal mengambil file histori', error);
    res.status(500).json({ error: 'Failed to get history files' });
  }
});

app.get('/api/history/:filename', requireLogin, requireAdmin, async (req, res) => {
  const { filename } = req.params;
  
  if (!isSafeHistoryFilename(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  try {
    const historyData = readHistoryData(filename);
    if (!historyData) {
      return res.status(404).json({ error: 'History file not found' });
    }
    res.json(historyData);
  } catch (error) {
    logger.error('Gagal membaca file histori', error);
    res.status(500).json({ error: 'Failed to read history data' });
  }
});

app.get('/api/history/:filename/export', requireLogin, requireAdmin, async (req, res) => {
  const { filename } = req.params;
  
  if (!isSafeHistoryFilename(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  try {
    const historyData = readHistoryData(filename);
    if (!historyData) {
      return res.status(404).json({ error: 'History file not found' });
    }

    const date = getSnapshotByFilename(filename)?.snapshotDate || extractHistoryDate(filename);
    
    const workbook = XLSX.utils.book_new();
    
    const summaryData = [
      ['HISTORICAL PRODUCTION REPORT SUMMARY'],
      ['Generated from backup:', date],
      [],
      ['Line', 'Model ID', 'Label/Week', 'Model', 'Date', 'Target', 'Output', 'QC Checking', 'Actual Defect', 'Defect Rate%']
    ];

    Object.keys(historyData.lines).forEach(lineName => {
      const line = historyData.lines[lineName];
      Object.keys(line.models).forEach(modelId => {
        const model = line.models[modelId];
        summaryData.push([
          lineName,
          modelId,
          model.labelWeek,
          model.model,
          model.date,
          model.target,
          model.outputDay,
          model.qcChecking,
          model.actualDefect,
          model.defectRatePercentage
        ]);
      });
    });

    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

    Object.keys(historyData.lines).forEach(lineName => {
      const line = historyData.lines[lineName];
      
      Object.keys(line.models).forEach(modelId => {
        const model = line.models[modelId];
        
        const lineData = [
          [`PRODUCTION REPORT - ${lineName} - ${modelId}`],
          [],
          ['Label/Week', model.labelWeek],
          ['Model', model.model],
          ['Date', model.date],
          ['Target', model.target],
          ['Target per Hour', model.targetPerHour],
          ['Output/Hari', model.outputDay],
          ['QC Checking', model.qcChecking],
          ['Actual Defect', model.actualDefect],
          ['Defect Rate (%)', model.defectRatePercentage],
          [],
          ['HOURLY DATA'],
          ['Jam', 'Target Manual', 'Output', 'Selisih (Target - Output)', 'Defect', 'QC Checked', 'Defect Rate (%)']
        ];

        model.hourly_data.forEach(hour => {
          const defectRate = hour.qcChecked > 0 ? ((hour.defect / hour.qcChecked) * 100).toFixed(2) : '0.00';
          const selisih = hour.targetManual - hour.output;
          lineData.push([
            hour.hour, 
            hour.targetManual,
            hour.output, 
            selisih,
            hour.defect, 
            hour.qcChecked, 
            defectRate
          ]);
        });

        if (model.operators && model.operators.length > 0) {
          lineData.push([], ['OPERATOR DATA']);
          lineData.push(['No', 'Nama', 'Posisi', 'Target', 'Output', 'Defect', 'Efisiensi%', 'Status']);
          
          model.operators.forEach((operator, index) => {
            lineData.push([
              index + 1,
              operator.name,
              operator.position,
              operator.target,
              operator.output,
              operator.defect,
              operator.efficiency,
              operator.status === 'active' ? 'Aktif' : operator.status === 'break' ? 'Istirahat' : 'Off'
            ]);
          });
        }

        const lineSheet = XLSX.utils.aoa_to_sheet(lineData);
        XLSX.utils.book_append_sheet(workbook, lineSheet, `${lineName}_${modelId}`);
      });
    });

    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    const downloadFilename = `Historical_Production_Report_${date}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    res.send(excelBuffer);
  } catch (error) {
    logger.error('Gagal mengekspor histori', error);
    res.status(500).json({ error: 'Failed to export history data' });
  }
});

app.post('/api/backup/now', requireLogin, requireAdmin, async (req, res) => {
  try {
    const databaseFile = await createDatabaseBackup('manual');
    res.json({
      message: '✅ Backup database berhasil dibuat',
      filename: path.basename(databaseFile),
      size: fs.statSync(databaseFile).size,
      created: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Gagal membuat backup', error);
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

app.post('/api/sync-dates', requireLogin, requireAdmin, async (req, res) => {
  const resetCount = checkAndResetDataForNewDay();
  const today = getToday();
  
  if (resetCount > 0) {
    res.json({ 
      message: `✅ Sinkronisasi tanggal selesai. ${resetCount} model direset ke tanggal ${today}`,
      resetCount: resetCount,
      today: today,
      status: 'success'
    });
  } else {
    res.json({ 
      message: `ℹ️ Tidak ada data yang perlu direset. Semua model sudah menggunakan tanggal ${today}`,
      resetCount: resetCount,
      today: today,
      status: 'no_changes'
    });
  }
});

app.get('/api/lines', requireLogin, autoCheckDateReset, async (req, res) => {
  const user = req.session.user;
  const role = user.role === 'admin_operator' ? 'admin_operator_sewing' : user.role;
  const data = readProductionData();
  
  if (role === 'admin' || ADMIN_OPERATOR_ROLES.includes(role) || role === PPIC_ROLE) {
    return res.json(buildLinesResponse(data.lines || {}));
  }
  
  if (role === 'operator') {
    const operatorLine = {};
    if (data.lines[user.line]) {
      operatorLine[user.line] = data.lines[user.line];
    }
    return res.json(buildLinesResponse(operatorLine));
  }
  
  res.status(403).json({ error: 'Access denied' });
});

app.get('/api/lines/:lineName/models', requireLogin, requireLineAccess, autoCheckDateReset, async (req, res) => {
  const { lineName } = req.params;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  res.json(data.lines[lineName].models || {});
});

app.post('/api/lines', requireLogin, requireLineManagementAccess, async (req, res) => {
  const { lineName, labelWeek, model, target, date } = req.body;
  const data = readProductionData();
  const normalizedLine = normalizeLineName(lineName);
  const normalizedModel = normalizeModelName(model);
  if (normalizedLine.error) return res.status(400).json({ error: normalizedLine.error });
  if (normalizedModel.error) return res.status(400).json({ error: normalizedModel.error });

  if (data.lines[normalizedLine.value]) {
    return res.status(400).json({ error: 'Line already exists' });
  }

  const lineDate = date || getToday();
  const parsedTarget = parseNonNegativeInteger(target);
  if (parsedTarget === null) {
    return res.status(400).json({ error: 'Target harus berupa bilangan bulat tidak negatif' });
  }
  if (!isValidDateInput(lineDate) || lineDate !== getToday()) {
    return res.status(400).json({ error: 'Tanggal line/model harus menggunakan tanggal operasional hari ini' });
  }
  const targetPerHour = Math.round(parsedTarget / PRODUCTION_HOURS.length);
  const modelId = 'model1';

  data.lines[normalizedLine.value] = {
    models: {
      [modelId]: {
        id: modelId,
        labelWeek,
        model: normalizedModel.value,
        date: lineDate,
        target: parsedTarget,
        targetPerHour: targetPerHour,
        outputDay: 0,
        qcChecking: 0,
        actualDefect: 0,
        defectRatePercentage: 0,
        hourly_data: createHourlyData(parsedTarget),
        operators: []
      }
    },
    activeModel: modelId,
    activeModels: [modelId]
  };

  await writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ 
    message: `Line ${normalizedLine.value} created successfully`,
    data: data.lines[normalizedLine.value],
    calculated: {
      targetPerHour: targetPerHour,
      message: `Target per jam: ${targetPerHour} unit (Target: ${target} ÷ 8 jam efektif)`
    }
  });
});

app.post('/api/lines/:lineName/models', requireLogin, requireLineManagementAccess, async (req, res) => {
  const { lineName } = req.params;
  const { labelWeek, model, target, date } = req.body;
  const data = readProductionData();
  const normalizedModel = normalizeModelName(model);
  if (normalizedModel.error) return res.status(400).json({ error: normalizedModel.error });

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const lineDate = date || getToday();
  const parsedTarget = parseNonNegativeInteger(target);
  if (parsedTarget === null) {
    return res.status(400).json({ error: 'Target harus berupa bilangan bulat tidak negatif' });
  }
  if (!isValidDateInput(lineDate) || lineDate !== getToday()) {
    return res.status(400).json({ error: 'Tanggal line/model harus menggunakan tanggal operasional hari ini' });
  }
  const targetPerHour = Math.round(parsedTarget / PRODUCTION_HOURS.length);
  const modelId = generateModelId(data.lines[lineName].models);

  data.lines[lineName].models[modelId] = {
    id: modelId,
    labelWeek,
    model: normalizedModel.value,
    date: lineDate,
    target: parsedTarget,
    targetPerHour: targetPerHour,
    outputDay: 0,
    qcChecking: 0,
    actualDefect: 0,
    defectRatePercentage: 0,
    hourly_data: createHourlyData(parsedTarget),
    operators: []
  };

  await writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ 
    message: `Model ${modelId} added to line ${lineName} successfully`, 
    data: data.lines[lineName].models[modelId],
    modelId: modelId
  });
});

app.put('/api/lines/:lineName', requireLogin, requireLineManagementAccess, autoCheckDateReset, async (req, res) => {
  const lineName = req.params.lineName;
  const { labelWeek, model, target, modelId, date } = req.body;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const targetModelId = modelId || data.lines[lineName].activeModel;
  if (!data.lines[lineName].models[targetModelId]) {
    return res.status(404).json({ error: 'Model not found' });
  }

  const newTarget = parseNonNegativeInteger(target);
  if (newTarget === null) {
    return res.status(400).json({ error: 'Target harus berupa bilangan bulat tidak negatif' });
  }
  if (date !== undefined && (!isValidDateInput(date) || date !== getToday())) {
    return res.status(400).json({ error: 'Tanggal line/model harus menggunakan tanggal operasional hari ini' });
  }

  const targetModel = data.lines[lineName].models[targetModelId];
  const nextLabelWeek = labelWeek === undefined ? targetModel.labelWeek : String(labelWeek || '').trim();
  const normalizedModel = model === undefined ? { value: targetModel.model, error: '' } : normalizeModelName(model);
  if (normalizedModel.error) return res.status(400).json({ error: normalizedModel.error });
  const nextModelName = normalizedModel.value;
  preserveMaterialOrderProductionIdentity(lineName, targetModel, nextLabelWeek, nextModelName);
  targetModel.labelWeek = nextLabelWeek;
  targetModel.model = nextModelName;
  targetModel.target = newTarget;
  applyDailyTarget(targetModel, newTarget);
  
  if (date) {
    targetModel.date = date;
  }

  let totalTarget = 0;
  targetModel.hourly_data.forEach(hour => {
    totalTarget += hour.targetManual || 0;
  });
  targetModel.target = totalTarget;

  await writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ 
    message: `Model ${targetModelId} in line ${lineName} updated successfully`, 
    data: targetModel
  });
});

app.delete('/api/lines/:lineName/models/:modelId', requireLogin, requireAdmin, async (req, res) => {
  const { lineName, modelId } = req.params;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  if (!data.lines[lineName].models[modelId]) {
    return res.status(404).json({ error: 'Model not found' });
  }

  if (Object.keys(data.lines[lineName].models).length === 1) {
    return res.status(400).json({ error: 'Cannot delete the last model in a line' });
  }

  delete data.lines[lineName].models[modelId];

  if (Array.isArray(data.lines[lineName].activeModels)) {
    data.lines[lineName].activeModels = data.lines[lineName].activeModels.filter(activeId => activeId !== modelId);
  }

  if (data.lines[lineName].activeModel === modelId) {
    const remainingActive = (data.lines[lineName].activeModels || []).filter(activeId => data.lines[lineName].models[activeId]);
    data.lines[lineName].activeModel = remainingActive[0] || Object.keys(data.lines[lineName].models)[0];
  }

  if (!Array.isArray(data.lines[lineName].activeModels) || data.lines[lineName].activeModels.length === 0) {
    data.lines[lineName].activeModels = [data.lines[lineName].activeModel];
  }

  await writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ message: `Model ${modelId} deleted from line ${lineName} successfully` });
});

app.delete('/api/lines/:lineName', requireLogin, requireAdmin, async (req, res) => {
  const lineName = req.params.lineName;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  delete data.lines[lineName];
  await writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ message: `Line ${lineName} deleted successfully` });
});

app.post('/api/lines/:lineName/active-model', requireLogin, requireLineManagementAccess, autoCheckDateReset, async (req, res) => {
  const { lineName } = req.params;
  const { modelId } = req.body;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  if (!data.lines[lineName].models[modelId]) {
    return res.status(404).json({ error: 'Model not found' });
  }

  const line = ensureLineActiveModels(data.lines[lineName]);
  const activeModels = new Set(line.activeModels || []);
  const isActive = activeModels.has(modelId);

  if (isActive) {
    if (activeModels.size <= 1) {
      return res.status(400).json({ error: 'Line harus memiliki minimal 1 model aktif' });
    }
    activeModels.delete(modelId);
  } else {
    activeModels.add(modelId);
  }

  line.activeModels = Array.from(activeModels);
  line.activeModel = line.activeModels[0] || null;
  await writeProductionData(data);
  
  // UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ 
    message: isActive
      ? 'Model ' + modelId + ' dinonaktifkan dari line ' + lineName
      : 'Model ' + modelId + ' diaktifkan pada line ' + lineName,
    activeModel: line.activeModel,
    activeModels: line.activeModels
  });
});

app.get('/api/line/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, requireActiveModelForOperator, async (req, res) => {
  const { lineName, modelId } = req.params;
  const data = readProductionData();
  
  if (!data.lines[lineName] || !data.lines[lineName].models[modelId]) {
    return res.status(404).json({ error: 'Line or model not found' });
  }

  const modelData = data.lines[lineName].models[modelId];
  res.json({ 
    line: lineName,
    modelId: modelId,
    ...modelData 
  });
});

app.get('/api/line/:lineName', requireLogin, requireLineAccess, autoCheckDateReset, async (req, res) => {
  const { lineName } = req.params;
  const data = readProductionData();
  
  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const activeModel = getActiveModel(data, lineName);
  if (!activeModel) {
    return res.status(404).json({ error: 'Active model not found' });
  }

  res.json({ 
    line: lineName,
    modelId: activeModel.modelId,
    ...activeModel.model 
  });
});

app.post('/api/update-line/:lineName/:modelId', requireLogin, requireLineAccess, requireLineManagementAccess, autoCheckDateReset, async (req, res) => {
  const { lineName, modelId } = req.params;
  const newData = req.body;

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].models[modelId]) {
    return res.status(404).json({ error: 'Line or model not found' });
  }

  const model = data.lines[lineName].models[modelId];
  const hasDate = Object.prototype.hasOwnProperty.call(newData, 'date');
  const nextDate = hasDate ? String(newData.date || '').trim() : model.date;
  const hasTarget = Object.prototype.hasOwnProperty.call(newData, 'target');
  const nextTarget = hasTarget ? parseNonNegativeInteger(newData.target) : null;

  if (hasDate && (!isValidDateInput(nextDate) || nextDate !== getToday())) {
    return res.status(400).json({ error: 'Tanggal line/model harus menggunakan tanggal operasional hari ini' });
  }
  if (hasTarget && nextTarget === null) {
    return res.status(400).json({ error: 'Target harus berupa bilangan bulat tidak negatif' });
  }

  if (Object.prototype.hasOwnProperty.call(newData, 'labelWeek')) {
    const nextLabelWeek = String(newData.labelWeek || '').trim();
    const normalizedModel = Object.prototype.hasOwnProperty.call(newData, 'model')
      ? normalizeModelName(newData.model)
      : { value: model.model, error: '' };
    if (normalizedModel.error) return res.status(400).json({ error: normalizedModel.error });
    const nextModelName = normalizedModel.value;
    preserveMaterialOrderProductionIdentity(lineName, model, nextLabelWeek, nextModelName);
    model.labelWeek = nextLabelWeek;
    if (Object.prototype.hasOwnProperty.call(newData, 'model')) model.model = nextModelName;
  } else if (Object.prototype.hasOwnProperty.call(newData, 'model')) {
    const normalizedModel = normalizeModelName(newData.model);
    if (normalizedModel.error) return res.status(400).json({ error: normalizedModel.error });
    const nextModelName = normalizedModel.value;
    preserveMaterialOrderProductionIdentity(lineName, model, model.labelWeek, nextModelName);
    model.model = nextModelName;
  }
  if (hasDate) {
    model.date = nextDate;
  }
  if (hasTarget) {
    applyDailyTarget(model, nextTarget);
  }

  recalculateModelTotals(model);

  await writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ message: `Model ${modelId} in line ${lineName} updated successfully.`, data: model });
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

async function generateStyledDateReportExcel(data, date) {
  const workbook = new ExcelJS.Workbook();
  
  workbook.creator = 'Production Dashboard System';
  workbook.lastModifiedBy = 'Production Dashboard System';
  workbook.created = new Date();
  workbook.modified = new Date();
  
  const headerStyle = {
    font: { bold: true, color: { argb: 'FFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: '4472C4' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: {
      top: { style: 'thin', color: { argb: '000000' } },
      left: { style: 'thin', color: { argb: '000000' } },
      bottom: { style: 'thin', color: { argb: '000000' } },
      right: { style: 'thin', color: { argb: '000000' } }
    }
  };
  
  const titleStyle = {
    font: { bold: true, size: 16, color: { argb: '1F4E78' } },
    alignment: { horizontal: 'center', vertical: 'middle' }
  };
  
  const dataStyle = {
    font: { size: 11 },
    border: {
      top: { style: 'thin', color: { argb: 'D9D9D9' } },
      left: { style: 'thin', color: { argb: 'D9D9D9' } },
      bottom: { style: 'thin', color: { argb: 'D9D9D9' } },
      right: { style: 'thin', color: { argb: 'D9D9D9' } }
    }
  };
  
  const totalStyle = {
    font: { bold: true, color: { argb: 'FFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } },
    border: {
      top: { style: 'thin', color: { argb: '000000' } },
      left: { style: 'thin', color: { argb: '000000' } },
      bottom: { style: 'thin', color: { argb: '000000' } },
      right: { style: 'thin', color: { argb: '000000' } }
    }
  };
  
  const highlightStyle = {
    font: { bold: true, color: { argb: 'FFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC000' } },
    border: {
      top: { style: 'thin', color: { argb: '000000' } },
      left: { style: 'thin', color: { argb: '000000' } },
      bottom: { style: 'thin', color: { argb: '000000' } },
      right: { style: 'thin', color: { argb: '000000' } }
    }
  };

  const summarySheet = workbook.addWorksheet('SUMMARY');
  
	  summarySheet.mergeCells('A1:Q1');
  const titleCell = summarySheet.getCell('A1');
	  titleCell.value = 'LAPORAN PRODUKSI DAN QC - ' + date;
  titleCell.style = titleStyle;
  
	  summarySheet.getCell('A3').value = 'Tanggal Export';
  summarySheet.getCell('B3').value = new Date().toLocaleString('id-ID');
	  summarySheet.getCell('A4').value = 'Tanggal Laporan';
  summarySheet.getCell('B4').value = date;
	  summarySheet.getCell('A5').value = 'Total Line';
  summarySheet.getCell('B5').value = Object.keys(data.lines).length;
  
	  const headers = ['Tanggal', 'Line', 'Model ID', 'Label/Week', 'Model', 'Target', 'Output', 'Achievement', 'QC Checked', 'Good', 'Total Defect', 'Critical', 'Major', 'Minor', 'Defect Rate', 'Defect Area', 'Jenis Defect'];
  summarySheet.getRow(7).values = headers;
  summarySheet.getRow(7).eachCell((cell) => {
    cell.style = headerStyle;
  });
  
  let rowIndex = 8;
  let totalTarget = 0;
  let totalOutput = 0;
  let totalDefect = 0;
  let totalQCChecked = 0;
  let totalGood = 0;
  
  Object.keys(data.lines).forEach(lineName => {
    const line = data.lines[lineName];
	    Object.keys(line.models).forEach(modelId => {
	      const model = line.models[modelId];
	      const displayModelId = model.reportModelId || modelId;
	      const achievement = model.target > 0 ? ((model.outputDay || 0) / model.target * 100).toFixed(2) + '%' : '0%';
	      const defectCategories = summarizeModelDefectCategories(model);
	      const defectBreakdown = calculateDefectSeverityBreakdown(model);
	      
	      const row = summarySheet.getRow(rowIndex);
	      row.values = [
        model.date || date,
        lineName,
	        displayModelId,
        model.labelWeek || '',
        model.model || '',
        model.target || 0,
	        model.outputDay || 0,
	        achievement,
	        model.qcChecking || 0,
	        Math.max((model.qcChecking || 0) - (model.actualDefect || 0), 0),
	        model.actualDefect || 0,
	        defectBreakdown.critical.count,
	        defectBreakdown.major.count,
	        defectBreakdown.minor.count,
	        (model.defectRatePercentage || 0) + '%',
	        defectCategories.areas,
	        defectCategories.types
	      ];
      
      const achievementCell = row.getCell(8);
      const achievementValue = parseFloat(achievement);
      if (achievementValue >= 100) {
        achievementCell.font = { color: { argb: '00B050' }, bold: true };
      } else if (achievementValue >= 80) {
        achievementCell.font = { color: { argb: 'FFC000' }, bold: true };
      } else {
        achievementCell.font = { color: { argb: 'FF0000' }, bold: true };
      }
      
	      const defectRateCell = row.getCell(15);
      const defectRateValue = model.defectRatePercentage || 0;
      if (defectRateValue <= 5) {
        defectRateCell.font = { color: { argb: '00B050' }, bold: true };
      } else if (defectRateValue <= 10) {
        defectRateCell.font = { color: { argb: 'FFC000' }, bold: true };
      } else {
        defectRateCell.font = { color: { argb: 'FF0000' }, bold: true };
      }
      
      row.eachCell((cell) => {
        cell.style = dataStyle;
      });
      
      totalTarget += model.target || 0;
      totalOutput += model.outputDay || 0;
      totalDefect += model.actualDefect || 0;
      totalQCChecked += model.qcChecking || 0;
      totalGood += Math.max((model.qcChecking || 0) - (model.actualDefect || 0), 0);
      
      rowIndex++;
    });
  });
  
  const totalAchievement = totalTarget > 0 ? ((totalOutput / totalTarget) * 100).toFixed(2) + '%' : '0%';
  const totalDefectRate = totalQCChecked > 0 ? ((totalDefect / totalQCChecked) * 100).toFixed(2) + '%' : '0%';
  
  const totalRow = summarySheet.getRow(rowIndex);
  totalRow.values = [
    'TOTAL',
    '',
    '',
    '',
    '',
    totalTarget,
	    totalOutput,
	    totalAchievement,
	    totalQCChecked,
	    totalGood,
	    totalDefect,
	    '',
	    '',
	    '',
	    totalDefectRate,
	    '',
	    ''
	  ];
  totalRow.eachCell((cell) => {
    cell.style = totalStyle;
  });
  
  summarySheet.columns = [
	    { width: 14 },
	    { width: 15 },
	    { width: 12 },
	    { width: 15 },
	    { width: 30 },
	    { width: 12 },
	    { width: 12 },
	    { width: 15 },
	    { width: 12 },
	    { width: 12 },
	    { width: 12 },
	    { width: 12 },
	    { width: 12 },
	    { width: 12 },
	    { width: 15 },
	    { width: 32 },
	    { width: 32 }
	  ];

  Object.keys(data.lines).forEach(lineName => {
    const line = data.lines[lineName];
    const lineSheet = workbook.addWorksheet(lineName.substring(0, 31));
    
    let currentRow = 1;
    
	    lineSheet.mergeCells(`A${currentRow}:H${currentRow}`);
    const lineTitle = lineSheet.getCell(`A${currentRow}`);
	    lineTitle.value = `DETAIL LAPORAN PRODUKSI DAN QC - ${lineName} - ${date}`;
    lineTitle.style = titleStyle;
    currentRow += 2;

    Object.keys(line.models).forEach(modelId => {
      const model = line.models[modelId];
      const displayModelId = model.reportModelId || modelId;
      
      lineSheet.getCell(`A${currentRow}`).value = 'Model ID';
      lineSheet.getCell(`B${currentRow}`).value = displayModelId;
      currentRow++;
      
      lineSheet.getCell(`A${currentRow}`).value = 'Label/Week';
      lineSheet.getCell(`B${currentRow}`).value = model.labelWeek || '';
      currentRow++;
      
      lineSheet.getCell(`A${currentRow}`).value = 'Model';
      lineSheet.getCell(`B${currentRow}`).value = model.model || '';
      currentRow++;
      
      lineSheet.getCell(`A${currentRow}`).value = 'Date';
      lineSheet.getCell(`B${currentRow}`).value = model.date || '';
      currentRow++;
      
      lineSheet.getCell(`A${currentRow}`).value = 'Target';
      lineSheet.getCell(`B${currentRow}`).value = model.target || 0;
      currentRow++;
      
      lineSheet.getCell(`A${currentRow}`).value = 'Output';
      lineSheet.getCell(`B${currentRow}`).value = model.outputDay || 0;
      currentRow++;

      lineSheet.getCell(`A${currentRow}`).value = 'QC Checked';
      lineSheet.getCell(`B${currentRow}`).value = model.qcChecking || 0;
      currentRow++;

      lineSheet.getCell(`A${currentRow}`).value = 'Good';
      lineSheet.getCell(`B${currentRow}`).value = Math.max((model.qcChecking || 0) - (model.actualDefect || 0), 0);
      currentRow++;

      lineSheet.getCell(`A${currentRow}`).value = 'Total Defect';
      lineSheet.getCell(`B${currentRow}`).value = model.actualDefect || 0;
      currentRow++;
      
      lineSheet.getCell(`A${currentRow}`).value = 'Defect Rate';
      lineSheet.getCell(`B${currentRow}`).value = (model.defectRatePercentage || 0) + '%';
      currentRow += 2;
      
	      const hourlyHeaders = ['Jam', 'Target Manual', 'Output', 'Selisih', 'Total Defect', 'QC Checked', 'Good', 'Defect Rate'];
      lineSheet.getRow(currentRow).values = hourlyHeaders;
      lineSheet.getRow(currentRow).eachCell((cell) => {
        cell.style = headerStyle;
      });
      currentRow++;
      
	      if (model.hourly_data && model.hourly_data.length > 0) {
	        model.hourly_data.forEach(hour => {
	          const defectRate = hour.qcChecked > 0 ? ((hour.defect / hour.qcChecked) * 100).toFixed(2) : '0.00';
	          const selisih = (hour.output || 0) - (hour.targetManual || 0);
	          const row = lineSheet.getRow(currentRow);
	          row.values = [
	            hour.hour,
	            hour.targetManual || 0,
	            hour.output || 0,
	            selisih,
	            hour.defect || 0,
	            hour.qcChecked || 0,
	            Math.max((hour.qcChecked || 0) - (hour.defect || 0), 0),
	            defectRate + '%'
	          ];
          
          const selisihCell = row.getCell(4);
          if (selisih >= 0) {
            selisihCell.font = { color: { argb: '00B050' }, bold: true };
          } else {
            selisihCell.font = { color: { argb: 'FF0000' }, bold: true };
          }
          
	          const defectRateCell = row.getCell(8);
          const defectRateValue = parseFloat(defectRate);
          if (defectRateValue <= 5) {
            defectRateCell.font = { color: { argb: '00B050' }, bold: true };
          } else if (defectRateValue <= 10) {
            defectRateCell.font = { color: { argb: 'FFC000' }, bold: true };
          } else {
            defectRateCell.font = { color: { argb: 'FF0000' }, bold: true };
          }
          
          row.eachCell((cell) => {
            cell.style = dataStyle;
          });
          
          currentRow++;
        });
      }
      
	      currentRow += 2;

	      const defectDetailHeaders = ['Jam', 'Jenis Defect', 'Kategori', 'Defect Area', 'Qty', 'Notes'];
	      lineSheet.getRow(currentRow).values = defectDetailHeaders;
	      lineSheet.getRow(currentRow).eachCell((cell) => {
	        cell.style = headerStyle;
	      });
	      currentRow++;

	      let hasDefectDetail = false;
	      (model.hourly_data || []).forEach(hour => {
	        (hour.defectDetails || []).forEach(detail => {
	          hasDefectDetail = true;
	          const row = lineSheet.getRow(currentRow);
	          row.values = [
	            hour.hour,
	            detail.type || '-',
	            getDefectSeverityLabel(detail.type),
	            detail.area || '-',
	            parseInt(detail.quantity) || 0,
	            detail.notes || ''
	          ];
	          row.eachCell((cell) => {
	            cell.style = dataStyle;
	          });
	          currentRow++;
	        });
	      });

	      (model.qcChecks || [])
	        .filter(check => check.result === 'defect')
	        .forEach(check => {
	          hasDefectDetail = true;
	          const row = lineSheet.getRow(currentRow);
	          row.values = [
	            getQcCheckHourLabel(model, check),
	            check.type || '-',
	            getDefectSeverityLabel(check.type),
	            check.area || '-',
	            1,
	            check.notes || ''
	          ];
	          row.eachCell((cell) => {
	            cell.style = dataStyle;
	          });
	          currentRow++;
	        });

	      if (!hasDefectDetail) {
	        const row = lineSheet.getRow(currentRow);
	        row.values = ['-', '-', '-', '-', 0, 'Tidak ada detail defect'];
	        row.eachCell((cell) => {
	          cell.style = dataStyle;
	        });
	        currentRow++;
	      }

	      currentRow += 3;
	    });
    
	    lineSheet.columns = [
	      { width: 15 },
	      { width: 32 },
	      { width: 32 },
	      { width: 12 },
	      { width: 32 },
	      { width: 15 },
	      { width: 12 },
	      { width: 18 }
	    ];
  });

  const performanceSheet = workbook.addWorksheet('PERFORMANCE');
  
  performanceSheet.mergeCells('A1:E1');
  const performanceTitle = performanceSheet.getCell('A1');
	  performanceTitle.value = 'RINGKASAN PERFORMA - ' + date;
  performanceTitle.style = titleStyle;
  
	  const performanceHeaders = ['Line', 'Total Target', 'Total Output', 'Achievement', 'Status'];
  performanceSheet.getRow(3).values = performanceHeaders;
  performanceSheet.getRow(3).eachCell((cell) => {
    cell.style = headerStyle;
  });
  
  let perfRowIndex = 4;
  Object.keys(data.lines).forEach(lineName => {
    const line = data.lines[lineName];
    let lineTarget = 0;
    let lineOutput = 0;
    
    Object.keys(line.models).forEach(modelId => {
      const model = line.models[modelId];
      lineTarget += model.target || 0;
      lineOutput += model.outputDay || 0;
    });
    
    const achievement = lineTarget > 0 ? ((lineOutput / lineTarget) * 100).toFixed(2) + '%' : '0%';
	    const status = lineOutput >= lineTarget ? 'SESUAI TARGET' : 'DI BAWAH TARGET';
    
    const row = performanceSheet.getRow(perfRowIndex);
    row.values = [
      lineName,
      lineTarget,
      lineOutput,
      achievement,
      status
    ];
    
    const achievementCell = row.getCell(4);
    const achievementValue = parseFloat(achievement);
    if (achievementValue >= 100) {
      achievementCell.font = { color: { argb: '00B050' }, bold: true };
    } else if (achievementValue >= 80) {
      achievementCell.font = { color: { argb: 'FFC000' }, bold: true };
    } else {
      achievementCell.font = { color: { argb: 'FF0000' }, bold: true };
    }
    
    const statusCell = row.getCell(5);
	    if (status === 'SESUAI TARGET') {
      statusCell.font = { color: { argb: '00B050' }, bold: true };
      statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'C6EFCE' } };
    } else {
      statusCell.font = { color: { argb: 'FF0000' }, bold: true };
      statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC7CE' } };
    }
    
    row.eachCell((cell) => {
      if (cell.value !== status) {
        cell.style = dataStyle;
      }
    });
    
    perfRowIndex++;
  });
  
  const totalAchievementPerf = totalTarget > 0 ? ((totalOutput / totalTarget) * 100).toFixed(2) + '%' : '0%';
	  const overallStatus = totalOutput >= totalTarget ? 'SESUAI TARGET' : 'DI BAWAH TARGET';
  
  const totalPerfRow = performanceSheet.getRow(perfRowIndex);
  totalPerfRow.values = [
    'TOTAL',
    totalTarget,
    totalOutput,
    totalAchievementPerf,
    overallStatus
  ];
  totalPerfRow.eachCell((cell) => {
    cell.style = totalStyle;
  });
  
  performanceSheet.columns = [
    { width: 15 },
    { width: 15 },
    { width: 15 },
    { width: 15 },
    { width: 20 }
  ];
  
  return workbook;
}

async function generateScopedDateReportExcel(data, date, role) {
  const isSewing = role === 'admin_operator_sewing';
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(isSewing ? 'SUMMARY SEWING' : 'SUMMARY QC');
  const headers = isSewing
    ? ['Line', 'Model ID', 'Label/Week', 'Model', 'Target', 'Output', 'Achievement %']
    : ['Line', 'Model ID', 'Label/Week', 'Model', 'QC Checked', 'Defect', 'Critical', 'Major', 'Minor', 'Jenis Defect', 'Area Defect', 'Defect Rate %'];

  sheet.mergeCells(1, 1, 1, headers.length);
  const title = sheet.getCell(1, 1);
  title.value = `${isSewing ? 'SUMMARY HASIL SEWING' : 'SUMMARY HASIL QC'} - ${date}`;
  title.font = { bold: true, size: 16, color: { argb: '1F4E78' } };
  title.alignment = { horizontal: 'center' };

  sheet.getRow(3).values = headers;
  sheet.getRow(3).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isSewing ? '4472C4' : '00A6A6' } };
    cell.alignment = { horizontal: 'center' };
  });

  let rowIndex = 4;
  Object.entries(data.lines || {}).forEach(([lineName, line]) => {
    Object.entries(line.models || {}).forEach(([modelId, model]) => {
      if (model.date && model.date !== date) return;

      const achievement = model.target > 0 ? (((model.outputDay || 0) / model.target) * 100).toFixed(2) : '0.00';
      const defectCategories = summarizeModelDefectCategories(model);
      const defectBreakdown = calculateDefectSeverityBreakdown(model);
      const values = isSewing
        ? [lineName, modelId, model.labelWeek || '', model.model || '', model.target || 0, model.outputDay || 0, `${achievement}%`]
        : [lineName, modelId, model.labelWeek || '', model.model || '', model.qcChecking || 0, model.actualDefect || 0, defectBreakdown.critical.count, defectBreakdown.major.count, defectBreakdown.minor.count, defectCategories.types, defectCategories.areas, `${model.defectRatePercentage || 0}%`];

      const row = sheet.getRow(rowIndex++);
      row.values = values;
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'D9D9D9' } },
          left: { style: 'thin', color: { argb: 'D9D9D9' } },
          bottom: { style: 'thin', color: { argb: 'D9D9D9' } },
          right: { style: 'thin', color: { argb: 'D9D9D9' } }
        };
      });
    });
  });

  sheet.columns = headers.map(header => ({ width: ['Model', 'Jenis Defect', 'Area Defect'].includes(header) ? 28 : 16 }));
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: headers.length } };
  return workbook;
}

async function generateScopedLineReportExcel(modelData, lineName, modelId, role) {
  const isSewing = role === 'admin_operator_sewing' || role === 'admin_operator';
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Production Dashboard System';

  const summary = workbook.addWorksheet(isSewing ? 'SUMMARY SEWING' : 'SUMMARY QC');
  const title = isSewing ? 'DETAIL HASIL SEWING' : 'DETAIL HASIL QC';
  const headerColor = isSewing ? '4472C4' : '00A6A6';
  const defectBreakdown = calculateDefectSeverityBreakdown(modelData);
  const summaryRows = isSewing
    ? [
        ['Line', lineName],
        ['Model ID', modelId],
        ['Label/Week', modelData.labelWeek || ''],
        ['Model', modelData.model || ''],
        ['Tanggal', modelData.date || ''],
        ['Target', modelData.target || 0],
        ['Output', modelData.outputDay || 0],
        ['Achievement', `${modelData.target > 0 ? (((modelData.outputDay || 0) / modelData.target) * 100).toFixed(2) : '0.00'}%`]
      ]
    : [
        ['Line', lineName],
        ['Model ID', modelId],
        ['Label/Week', modelData.labelWeek || ''],
        ['Model', modelData.model || ''],
        ['Tanggal', modelData.date || ''],
        ['QC Checked', modelData.qcChecking || 0],
        ['Good', Math.max(0, (modelData.qcChecking || 0) - (modelData.actualDefect || 0))],
        ['Defect', modelData.actualDefect || 0],
        ['Critical Defect', defectBreakdown.critical.count],
        ['Major Defect', defectBreakdown.major.count],
        ['Minor Defect', defectBreakdown.minor.count],
        ['Defect Rate', `${modelData.defectRatePercentage || 0}%`]
      ];

  summary.mergeCells('A1:B1');
  summary.getCell('A1').value = `${title} - ${lineName}`;
  summary.getCell('A1').font = { bold: true, size: 16, color: { argb: '1F4E78' } };
  summary.getCell('A1').alignment = { horizontal: 'center' };
  summaryRows.forEach((values, index) => {
    const row = summary.getRow(index + 3);
    row.values = values;
    row.getCell(1).font = { bold: true };
  });
  summary.columns = [{ width: 22 }, { width: 32 }];

  const detail = workbook.addWorksheet(isSewing ? 'DETAIL PER JAM' : 'DETAIL PEMERIKSAAN');
  const headers = isSewing
    ? ['Jam', 'Target Manual', 'Output', 'Selisih', 'Achievement %']
    : ['No', 'Jam', 'Hasil', 'Jenis Defect', 'Kategori', 'Area Defect', 'Catatan', 'Waktu Pemeriksaan'];
  detail.getRow(1).values = headers;
  detail.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerColor } };
    cell.alignment = { horizontal: 'center' };
  });

  if (isSewing) {
    (modelData.hourly_data || []).forEach((hour, index) => {
      const target = hour.targetManual || 0;
      const output = hour.output || 0;
      detail.addRow([hour.hour || '', target, output, output - target, `${target > 0 ? ((output / target) * 100).toFixed(2) : '0.00'}%`]);
    });
  } else {
    const qcChecks = modelData.qcChecks || [];
    if (qcChecks.length > 0) {
      qcChecks.forEach((check, index) => {
        detail.addRow([
          index + 1,
          check.hour || '',
          check.result === 'defect' ? 'Defect' : 'Good',
          check.type || '',
          check.result === 'defect' ? getDefectSeverityLabel(check.type) : '',
          check.area || '',
          check.notes || '',
          check.checkedAt ? new Date(check.checkedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : ''
        ]);
      });
    } else {
      // Arsip lama menyimpan rekap QC per jam sebelum pencatatan per pemeriksaan tersedia.
      (modelData.hourly_data || []).filter(hour => (hour.qcChecked || 0) > 0).forEach((hour, index) => {
        const categories = summarizeDefectCategoriesFromDetails(hour.defectDetails || []);
        detail.addRow([
          index + 1,
          hour.hour || '',
          `Rekap: ${hour.qcChecked || 0} checked / ${hour.defect || 0} defect`,
          categories.types,
          '-',
          categories.areas,
          '',
          ''
        ]);
      });
    }
  }

  detail.columns = headers.map((header, index) => ({ width: index >= 3 ? 24 : 16 }));
  detail.views = [{ state: 'frozen', ySplit: 1 }];
  detail.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  return workbook;
}

app.get('/api/export-date-report', requireLogin, requireDateReportAccess, autoCheckDateReset, async (req, res) => {
  const { startDate, endDate, line } = req.query;

  if (!isValidDateRange(startDate, endDate)) {
    return res.status(400).json({ error: 'Rentang tanggal tidak valid. Gunakan tanggal mulai dan tanggal selesai dengan format YYYY-MM-DD.' });
  }

  try {
    const selectedLine = String(line || '').trim();
    const data = filterProductionDataByLine(buildDateRangeProductionData(startDate, endDate), selectedLine);
    const reportLabel = startDate === endDate ? startDate : `${startDate} s.d. ${endDate}`;
    const workbook = await generateStyledDateReportExcel(data, reportLabel);
    const safeLineSuffix = selectedLine
      ? `_${selectedLine.replace(/[^a-zA-Z0-9_-]+/g, '_')}`
      : '';
    const downloadFilename = startDate === endDate
      ? `Production_Report${safeLineSuffix}_${startDate}.xlsx`
      : `Production_Report${safeLineSuffix}_${startDate}_to_${endDate}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
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
    const workbook = await generateStyledDateReportExcel(filteredData, date);
    const downloadFilename = `Production_Report_${date}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    await workbook.xlsx.write(res);
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

    const workbook = await generateStyledExcelData(modelData, lineName, modelId);
    const safeLineName = lineName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeModelId = modelId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `Production_QC_Detail_${safeLineName}_${safeModelId}_${date}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
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

app.get('/api/material-orders', requireLogin, requireMaterialOrderViewAccess, async (req, res) => {
  const productionData = readProductionData();
  const cumulativeOutputs = buildMaterialOrderCumulativeOutputs(productionData);
  const orders = readMaterialOrders().orders
    .map(order => buildMaterialOrderResponse(order, productionData, cumulativeOutputs))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  res.json(orders);
});

app.get('/api/material-orders/production-totals', requireLogin, requireMaterialOrderViewAccess, async (req, res) => {
  const productionData = readProductionData();
  const cumulativeOutputs = buildMaterialOrderCumulativeOutputs(productionData);
  res.json(buildMaterialOrderProductionTotals(productionData, cumulativeOutputs));
});

app.get('/api/material-orders/report', requireLogin, requireMaterialOrderViewAccess, async (req, res) => {
  const { startDate = '', endDate = '', line = '', status = '', poMaterial = '' } = req.query;
  if ((startDate && !isValidDateInput(startDate)) || (endDate && !isValidDateInput(endDate))) {
    return res.status(400).json({ error: 'Tanggal report tidak valid' });
  }
  if (startDate && endDate && startDate > endDate) {
    return res.status(400).json({ error: 'Tanggal mulai tidak boleh lebih besar dari tanggal selesai' });
  }
  if (status && !MATERIAL_ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Status report tidak valid' });
  }

  const filters = { startDate, endDate, line, status, poMaterial };
  const rows = filterMaterialOrderReportRows(readMaterialOrders().orders, filters);
  return res.json({ rows, summary: summarizeMaterialOrderReport(rows), filters });
});

app.get('/api/material-orders/report/export', requireLogin, requireMaterialOrderViewAccess, async (req, res) => {
  const { startDate = '', endDate = '', line = '', status = '', poMaterial = '' } = req.query;
  if ((startDate && !isValidDateInput(startDate)) || (endDate && !isValidDateInput(endDate))) {
    return res.status(400).json({ error: 'Tanggal report tidak valid' });
  }
  if (startDate && endDate && startDate > endDate) {
    return res.status(400).json({ error: 'Tanggal mulai tidak boleh lebih besar dari tanggal selesai' });
  }
  if (status && !MATERIAL_ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Status report tidak valid' });
  }

  try {
    const filters = { startDate, endDate, line, status, poMaterial };
    const rows = filterMaterialOrderReportRows(readMaterialOrders().orders, filters);
    const workbook = await generateMaterialOrderReportExcel(rows, summarizeMaterialOrderReport(rows), filters);
    const buffer = await workbook.xlsx.writeBuffer();
    const dateSuffix = startDate && endDate ? `${startDate}_to_${endDate}` : getToday();
    const lineSuffix = line ? `_${line.replace(/[^a-zA-Z0-9_-]+/g, '_')}` : '';
    const poSuffix = poMaterial ? `_${poMaterial.replace(/[^a-zA-Z0-9_-]+/g, '_')}` : '';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Report_Order_Material${poSuffix}${lineSuffix}_${dateSuffix}.xlsx"`);
    return res.send(buffer);
  } catch (error) {
    logger.error('Gagal export report order material:', error);
    return res.status(500).json({ error: 'Gagal membuat export report order material' });
  }
});

app.post('/api/material-orders', requireLogin, requireMaterialOrderManageAccess, async (req, res) => {
  const { order, errors } = validateMaterialOrderInput(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join('. ') });

  const data = readMaterialOrders();
  const now = new Date().toISOString();
  const savedOrder = {
    ...order,
    id: generateNumericId(data.orders),
    createdBy: req.session.user.name || req.session.user.username,
    createdAt: now,
    updatedAt: now
  };
  data.orders.push(savedOrder);
  await writeMaterialOrders(data);
  return res.status(201).json({
    message: 'Order material berhasil ditambahkan',
    order: buildMaterialOrderResponse(savedOrder)
  });
});

app.put('/api/material-orders/:id', requireLogin, requireMaterialOrderManageAccess, async (req, res) => {
  const id = parseNonNegativeInteger(req.params.id);
  const data = readMaterialOrders();
  const index = data.orders.findIndex(order => order.id === id);
  if (index === -1) return res.status(404).json({ error: 'Order material tidak ditemukan' });

  const { order, errors } = validateMaterialOrderInput(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join('. ') });

  const savedOrder = {
    ...data.orders[index],
    ...order,
    id,
    updatedAt: new Date().toISOString()
  };
  data.orders[index] = savedOrder;
  await writeMaterialOrders(data);
  return res.json({
    message: 'Order material berhasil diperbarui',
    order: buildMaterialOrderResponse(savedOrder)
  });
});

app.delete('/api/material-orders/:id', requireLogin, requireMaterialOrderManageAccess, async (req, res) => {
  const id = parseNonNegativeInteger(req.params.id);
  const data = readMaterialOrders();
  const index = data.orders.findIndex(order => order.id === id);
  if (index === -1) return res.status(404).json({ error: 'Order material tidak ditemukan' });

  data.orders.splice(index, 1);
  await writeMaterialOrders(data);
  return res.json({ message: 'Order material berhasil dihapus' });
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

async function generateStyledExcelData(modelData, lineName, modelId) {
  const workbook = new ExcelJS.Workbook();
  
  workbook.creator = 'Production Dashboard System';
  workbook.lastModifiedBy = 'Production Dashboard System';
  workbook.created = new Date();
  workbook.modified = new Date();
  
  const headerStyle = {
    font: { bold: true, color: { argb: 'FFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: '4472C4' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
    border: {
      top: { style: 'thin', color: { argb: '000000' } },
      left: { style: 'thin', color: { argb: '000000' } },
      bottom: { style: 'thin', color: { argb: '000000' } },
      right: { style: 'thin', color: { argb: '000000' } }
    }
  };
  
  const titleStyle = {
    font: { bold: true, size: 16, color: { argb: '1F4E78' } },
    alignment: { horizontal: 'center', vertical: 'middle' }
  };
  
  const dataStyle = {
    font: { size: 11 },
    border: {
      top: { style: 'thin', color: { argb: 'D9D9D9' } },
      left: { style: 'thin', color: { argb: 'D9D9D9' } },
      bottom: { style: 'thin', color: { argb: 'D9D9D9' } },
      right: { style: 'thin', color: { argb: 'D9D9D9' } }
    }
  };
  
  const totalStyle = {
    font: { bold: true, color: { argb: 'FFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } },
    border: {
      top: { style: 'thin', color: { argb: '000000' } },
      left: { style: 'thin', color: { argb: '000000' } },
      bottom: { style: 'thin', color: { argb: '000000' } },
      right: { style: 'thin', color: { argb: '000000' } }
    }
  };
  
  const summarySheet = workbook.addWorksheet('SUMMARY');
  
	  summarySheet.mergeCells('A1:M1');
  const titleCell = summarySheet.getCell('A1');
	  titleCell.value = 'DETAIL LAPORAN PRODUKSI DAN QC';
  titleCell.style = titleStyle;
  
  summarySheet.getCell('A3').value = 'Line';
  summarySheet.getCell('B3').value = lineName;
  summarySheet.getCell('A4').value = 'Model ID';
  summarySheet.getCell('B4').value = modelId;
  summarySheet.getCell('A5').value = 'Label/Week';
  summarySheet.getCell('B5').value = modelData.labelWeek || '';
  summarySheet.getCell('A6').value = 'Model';
  summarySheet.getCell('B6').value = modelData.model || '';
	  summarySheet.getCell('A7').value = 'Tanggal';
  summarySheet.getCell('B7').value = modelData.date || '';
  
	  const headers = ['Metrik', 'Nilai', 'Target per Hour', 'Output/Hari', 'QC Checked', 'Good', 'Total Defect', 'Critical', 'Major', 'Minor', 'Defect Area', 'Jenis Defect', 'Defect Rate'];
	  summarySheet.getRow(9).values = headers;
  summarySheet.getRow(9).eachCell((cell) => {
    cell.style = headerStyle;
  });
  
	  const modelDefectCategories = summarizeModelDefectCategories(modelData);
	  const modelDefectBreakdown = calculateDefectSeverityBreakdown(modelData);
	  
	  const dataRow1 = summarySheet.getRow(10);
	  dataRow1.values = [
	    'Data Produksi',
    modelData.target || 0,
    modelData.targetPerHour || 0,
	    modelData.outputDay || 0,
	    modelData.qcChecking || 0,
	    Math.max((modelData.qcChecking || 0) - (modelData.actualDefect || 0), 0),
	    modelData.actualDefect || 0,
	    modelDefectBreakdown.critical.count,
	    modelDefectBreakdown.major.count,
	    modelDefectBreakdown.minor.count,
	    modelDefectCategories.areas,
	    modelDefectCategories.types,
	    (modelData.defectRatePercentage || 0) + '%'
	  ];
  dataRow1.eachCell((cell) => {
    cell.style = dataStyle;
  });
  
  const achievement = modelData.target > 0 ? ((modelData.outputDay || 0) / modelData.target * 100).toFixed(2) + '%' : '0%';
  
  const dataRow2 = summarySheet.getRow(11);
  dataRow2.values = [
	    'Performa',
    achievement,
    '',
    '',
	    '',
	    '',
	    '',
	    '',
	    '',
	    '',
	    '',
	    '',
	    ''
	  ];
  dataRow2.eachCell((cell) => {
    cell.style = dataStyle;
  });
  
  summarySheet.columns = [
    { width: 20 },
    { width: 15 },
    { width: 15 },
    { width: 15 },
	    { width: 15 },
	    { width: 15 },
	    { width: 12 },
	    { width: 12 },
	    { width: 12 },
	    { width: 12 },
	    { width: 32 },
	    { width: 32 },
	    { width: 15 }
	  ];
  
  const hourlySheet = workbook.addWorksheet('HOURLY DATA');
  
	  hourlySheet.mergeCells('A1:J1');
  const hourlyTitle = hourlySheet.getCell('A1');
  hourlyTitle.value = 'HOURLY PRODUCTION DATA';
  hourlyTitle.style = titleStyle;
  
	  const hourlyHeaders = ['Jam', 'Target Manual', 'Output', 'Selisih (Output - Target)', 'Total Defect', 'Jenis Defect', 'Defect Area', 'QC Checked', 'Good', 'Defect Rate'];
  hourlySheet.getRow(3).values = hourlyHeaders;
  hourlySheet.getRow(3).eachCell((cell) => {
    cell.style = headerStyle;
  });
  
  let rowIndex = 4;
  let totalTargetManual = 0;
  let totalOutput = 0;
  let totalDefect = 0;
  let totalQCChecked = 0;
  
  if (modelData.hourly_data && modelData.hourly_data.length > 0) {
	    modelData.hourly_data.forEach(hour => {
	      const defectRate = hour.qcChecked > 0 ? ((hour.defect / hour.qcChecked) * 100).toFixed(2) : '0.00';
	      const selisih = (hour.output || 0) - (hour.targetManual || 0);
	      const defectCategories = summarizeDefectCategoriesFromDetails(hour.defectDetails || []);
	      
	      const row = hourlySheet.getRow(rowIndex);
      row.values = [
        hour.hour,
        hour.targetManual || 0,
        hour.output || 0,
	        selisih,
	        hour.defect || 0,
	        defectCategories.types,
	        defectCategories.areas,
	        hour.qcChecked || 0,
	        Math.max((hour.qcChecked || 0) - (hour.defect || 0), 0),
	        defectRate + '%'
	      ];
      
      const selisihCell = row.getCell(4);
      if (selisih >= 0) {
        selisihCell.font = { color: { argb: '00B050' }, bold: true };
      } else {
        selisihCell.font = { color: { argb: 'FF0000' }, bold: true };
      }
      
	      const defectRateCell = row.getCell(10);
      const defectRateValue = parseFloat(defectRate);
      if (defectRateValue <= 5) {
        defectRateCell.font = { color: { argb: '00B050' }, bold: true };
      } else if (defectRateValue <= 10) {
        defectRateCell.font = { color: { argb: 'FFC000' }, bold: true };
      } else {
        defectRateCell.font = { color: { argb: 'FF0000' }, bold: true };
      }
      
      row.eachCell((cell) => {
        cell.style = dataStyle;
      });
      
      totalTargetManual += hour.targetManual || 0;
      totalOutput += hour.output || 0;
      totalDefect += hour.defect || 0;
      totalQCChecked += hour.qcChecked || 0;
      
      rowIndex++;
    });
  }
  
  const totalDefectRate = totalQCChecked > 0 ? ((totalDefect / totalQCChecked) * 100).toFixed(2) : '0.00';
  const totalSelisih = totalOutput - totalTargetManual;
  
  const totalRow = hourlySheet.getRow(rowIndex);
  totalRow.values = [
    'TOTAL',
    totalTargetManual,
    totalOutput,
	    totalSelisih,
	    totalDefect,
	    '',
	    '',
	    totalQCChecked,
	    Math.max(totalQCChecked - totalDefect, 0),
	    totalDefectRate + '%'
	  ];
  totalRow.eachCell((cell) => {
    cell.style = totalStyle;
  });
  
  hourlySheet.columns = [
    { width: 15 },
    { width: 15 },
    { width: 12 },
	    { width: 20 },
	    { width: 12 },
	    { width: 32 },
	    { width: 32 },
	    { width: 15 },
	    { width: 12 },
	    { width: 15 }
	  ];
  
  if (modelData.operators && modelData.operators.length > 0) {
    const operatorSheet = workbook.addWorksheet('OPERATOR DATA');
    
    operatorSheet.mergeCells('A1:H1');
    const operatorTitle = operatorSheet.getCell('A1');
    operatorTitle.value = 'OPERATOR PERFORMANCE';
    operatorTitle.style = titleStyle;
    
    const operatorHeaders = ['No', 'Nama Operator', 'Posisi', 'Target', 'Output', 'Defect', 'Efisiensi (%)', 'Status'];
    operatorSheet.getRow(3).values = operatorHeaders;
    operatorSheet.getRow(3).eachCell((cell) => {
      cell.style = headerStyle;
    });
    
    let opRowIndex = 4;
    modelData.operators.forEach((operator, index) => {
      const statusText = operator.status === 'active' ? 'Aktif' : 
                        operator.status === 'break' ? 'Istirahat' : 'Off';
      
      const row = operatorSheet.getRow(opRowIndex);
      row.values = [
        index + 1,
        operator.name,
        operator.position,
        operator.target,
        operator.output,
        operator.defect,
        operator.efficiency,
        statusText
      ];
      
      const statusCell = row.getCell(8);
      if (operator.status === 'active') {
        statusCell.font = { color: { argb: '00B050' }, bold: true };
      } else if (operator.status === 'break') {
        statusCell.font = { color: { argb: 'FFC000' }, bold: true };
      } else {
        statusCell.font = { color: { argb: 'FF0000' }, bold: true };
      }
      
      const efficiencyCell = row.getCell(7);
      if (operator.efficiency >= 100) {
        efficiencyCell.font = { color: { argb: '00B050' }, bold: true };
      } else if (operator.efficiency >= 80) {
        efficiencyCell.font = { color: { argb: 'FFC000' }, bold: true };
      } else {
        efficiencyCell.font = { color: { argb: 'FF0000' }, bold: true };
      }
      
      row.eachCell((cell) => {
        cell.style = dataStyle;
      });
      
      opRowIndex++;
    });
    
    operatorSheet.columns = [
      { width: 8 },
      { width: 25 },
      { width: 20 },
      { width: 12 },
      { width: 12 },
      { width: 12 },
      { width: 15 },
      { width: 12 }
    ];
  }
  
  return workbook;
}

app.get('/api/public/line/:lineName', autoCheckDateReset, async (req, res) => {
  if (!isWithinWorkSchedule()) {
    return res.status(403).json({ error: 'Public display hanya tersedia pada hari dan jam kerja' });
  }

  const lineName = req.params.lineName;
  const data = readProductionData();
  
  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const activeModel = getActiveModel(data, lineName);
  if (!activeModel) {
    return res.status(404).json({ error: 'Active model not found' });
  }

  res.json(buildPublicModelResponse(activeModel.model));
});

app.get('/api/public/line/:lineName/active-models', autoCheckDateReset, async (req, res) => {
  if (!isWithinWorkSchedule()) {
    return res.status(403).json({ error: 'Public display hanya tersedia pada hari dan jam kerja' });
  }

  const { lineName } = req.params;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const line = ensureLineActiveModels(data.lines[lineName]);
  const activeModels = (line.activeModels || []).filter(modelId => line.models?.[modelId]);

  if (activeModels.length === 0) {
    return res.status(404).json({ error: 'Active model not found' });
  }

  res.json({
    lineName,
    activeModels: activeModels.map(modelId => ({
      modelId,
      data: buildPublicModelResponse(line.models[modelId])
    }))
  });
});

app.get('/api/public/line/:lineName/:modelId', autoCheckDateReset, async (req, res) => {
  if (!isWithinWorkSchedule()) {
    return res.status(403).json({ error: 'Public display hanya tersedia pada hari dan jam kerja' });
  }

  const { lineName, modelId } = req.params;
  const data = readProductionData();
  
  if (!data.lines[lineName] || !data.lines[lineName].models[modelId]) {
    return res.status(404).json({ error: 'Line or model not found' });
  }

  const modelData = data.lines[lineName].models[modelId];

  res.json(buildPublicModelResponse(modelData));
});

app.get('/public-display', async (req, res) => {
  res.sendFile(path.join(__dirname, 'public-display.html'));
});

// Frontend SPA routes. Legacy pages such as /admin, /leader, /line/:line,
// and /input/:line now use the Alpine/Tailwind dashboard entry point.
app.get(['/admin', '/leader', '/line/:lineName', '/input/:lineName'], async (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/', async (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
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
    if (databaseRestoreInProgress) return;

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
  normalizeMaterialOrderRecord,
  validateMaterialOrderInput,
  isValidProductionSnapshot,
  isBlankInputValue,
  parseNonNegativeInteger,
  normalizeLineName,
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
  updateTodayBackup,
  verifyPassword,
  verifyPasswordAsync,
  writeProductionData,
  writeUsersData,
  writeWorkScheduleSettings
};
