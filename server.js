const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const { Sequelize, DataTypes } = require('sequelize');

const app = express();
const port = process.env.PORT || 3000;
const databasePath = path.join(__dirname, 'production-dashboard.sqlite');
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
const PRODUCTION_DATA_KEY = 'production_data';
const USERS_DATA_KEY = 'users_data';
const DEFECT_CONFIG_KEY = 'defect_config';
const PUBLIC_DISPLAY_SETTINGS_KEY = 'public_display_settings';
let productionDataCache = { lines: {}, activeLine: '' };
let usersDataCache = { users: [] };
let defectConfigCache = { defectTypes: [], defectAreas: [] };
let publicDisplaySettingsCache = {};
let databaseInitialized = false;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

app.use(session({
  secret: 'production-board-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function verifyPassword(password, hashedPassword) {
  return hashPassword(password) === hashedPassword;
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

function resetLineData(line) {
  const targetPerHour = Math.round(line.target / 8);
  
  return {
    ...line,
    outputDay: 0,
    qcChecking: 0,
    actualDefect: 0,
    defectRatePercentage: 0,
    hourly_data: [
      { hour: "07:00 - 08:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "08:00 - 09:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "09:00 - 10:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "10:00 - 11:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "11:00 - 13:00", output: 0, defect: 0, qcChecked: 0, targetManual: 0, selisih: 0 },
      { hour: "13:00 - 14:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "14:00 - 15:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "15:00 - 16:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "16:00 - 17:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
    ],
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
  const targetPerHour = Math.round(180 / 8);

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
            "hourly_data": [
              { hour: "07:00 - 08:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
              { hour: "08:00 - 09:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
              { hour: "09:00 - 10:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
              { hour: "10:00 - 11:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
              { hour: "11:00 - 13:00", output: 0, defect: 0, qcChecked: 0, targetManual: 0, selisih: 0 },
              { hour: "13:00 - 14:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
              { hour: "14:00 - 15:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
              { hour: "15:00 - 16:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
              { hour: "16:00 - 17:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
            ],
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
        "activeModel": "model1"
      }
    },
    "activeLine": "F1-5A"
  };
}

function buildInitialUsersData() {
  return {
    "users": [
      {
        "id": 1,
        "username": "operator1",
        "password": hashPassword("password123"),
        "name": "Ahmad Susanto",
        "line": "F1-5A",
        "role": "operator"
      },
      {
        "id": 2,
        "username": "admin_operator",
        "password": hashPassword("adminop123"),
        "name": "Admin Operator",
        "line": "all",
        "role": "admin_operator"
      },
      {
        "id": 3,
        "username": "admin",
        "password": hashPassword("admin123"),
        "name": "Administrator",
        "line": "all",
        "role": "admin"
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
      { id: 1, name: 'Kepala', severity: 'major', active: true },
      { id: 2, name: 'Badan', severity: 'minor', active: true },
      { id: 3, name: 'Kaki', severity: 'minor', active: true }
    ]
  };
}

function normalizeDefectSeverity(value) {
  return value === 'major' ? 'major' : 'minor';
}

function normalizeDefectConfig(config = {}) {
  return {
    defectTypes: (config.defectTypes || []).map(type => ({
      ...type,
      severity: normalizeDefectSeverity(type.severity)
    })),
    defectAreas: (config.defectAreas || []).map(area => ({
      ...area,
      severity: normalizeDefectSeverity(area.severity)
    }))
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

function normalizeDefectKey(value) {
  return String(value || '').trim().toLowerCase();
}

function buildDefectSeverityMaps(config = readDefectConfig()) {
  const typeMap = new Map();
  const areaMap = new Map();

  (config.defectTypes || []).forEach(type => {
    const key = normalizeDefectKey(type.name);
    if (key) typeMap.set(key, normalizeDefectSeverity(type.severity));
  });

  (config.defectAreas || []).forEach(area => {
    const key = normalizeDefectKey(area.name);
    if (key) areaMap.set(key, normalizeDefectSeverity(area.severity));
  });

  return { typeMap, areaMap };
}

function getDefectSeverity(type, area, severityMaps) {
  const typeSeverity = severityMaps.typeMap.get(normalizeDefectKey(type));
  const areaSeverity = severityMaps.areaMap.get(normalizeDefectKey(area));

  return typeSeverity === 'major' || areaSeverity === 'major' ? 'major' : 'minor';
}

function buildEmptyDefectBreakdown(qcChecking) {
  return {
    all: { count: 0, rate: 0 },
    major: { count: 0, rate: 0 },
    minor: { count: 0, rate: 0 },
    qcChecking: parseInt(qcChecking) || 0
  };
}

function calculateDefectSeverityBreakdown(model, config = readDefectConfig()) {
  const qcChecking = parseInt(model.qcChecking) || 0;
  const breakdown = buildEmptyDefectBreakdown(qcChecking);
  const severityMaps = buildDefectSeverityMaps(config);

  const addDefect = (type, area, quantity = 1) => {
    const count = Math.max(parseInt(quantity) || 1, 0);
    const severity = getDefectSeverity(type, area, severityMaps);

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
        addDefect(detail.type, detail.area, detail.quantity);
      });
    });
  }

  ['all', 'major', 'minor'].forEach(key => {
    breakdown[key].rate = qcChecking > 0
      ? parseFloat(((breakdown[key].count / qcChecking) * 100).toFixed(2))
      : 0;
  });

  return breakdown;
}

function buildPublicModelResponse(model) {
  const defectConfig = readDefectConfig();
  const severityMaps = buildDefectSeverityMaps(defectConfig);
  const response = { ...model };

  if (!response.targetPerHour) {
    response.targetPerHour = Math.round((response.target || 0) / 8);
  }

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
    types: Object.fromEntries(severityMaps.typeMap),
    areas: Object.fromEntries(severityMaps.areaMap)
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
  try {
    await AppData.upsert({
      key,
      payload: JSON.stringify(data)
    });
  } catch (error) {
    console.error(`❌ ERROR: Gagal menyimpan ${key} ke database:`, error.message);
  }
}

async function initSequelizeStorage() {
  try {
    await sequelize.authenticate();
    await AppData.sync();

    const legacyDataPath = path.join(__dirname, 'data.json');
    const legacyUsersPath = path.join(__dirname, 'users.json');

    let productionRow = await AppData.findByPk(PRODUCTION_DATA_KEY);
    let usersRow = await AppData.findByPk(USERS_DATA_KEY);
    let defectConfigRow = await AppData.findByPk(DEFECT_CONFIG_KEY);
    let publicDisplaySettingsRow = await AppData.findByPk(PUBLIC_DISPLAY_SETTINGS_KEY);

    if (!productionRow) {
      let initialProductionData = buildInitialProductionData();
      if (fs.existsSync(legacyDataPath)) {
        try {
          initialProductionData = JSON.parse(fs.readFileSync(legacyDataPath, 'utf8'));
          console.log('✅ Migrasi data produksi dari data.json ke Sequelize berhasil');
        } catch (error) {
          console.error('❌ ERROR: Gagal migrasi data.json, memakai data default:', error.message);
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
          console.log('✅ Migrasi data user dari users.json ke Sequelize berhasil');
        } catch (error) {
          console.error('❌ ERROR: Gagal migrasi users.json, memakai user default:', error.message);
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

    productionDataCache = parsePayload(
      productionRow ? productionRow.payload : '',
      buildInitialProductionData()
    );
    usersDataCache = parsePayload(
      usersRow ? usersRow.payload : '',
      buildInitialUsersData()
    );
	    defectConfigCache = normalizeDefectConfig(parsePayload(
	      defectConfigRow ? defectConfigRow.payload : '',
	      buildInitialDefectConfig()
	    ));
    publicDisplaySettingsCache = normalizePublicDisplaySettings(parsePayload(
      publicDisplaySettingsRow ? publicDisplaySettingsRow.payload : '',
      buildInitialPublicDisplaySettings()
    ));

    databaseInitialized = true;
    console.log(`✅ Sequelize database siap: ${databasePath}`);
  } catch (error) {
    console.error('❌ ERROR: Inisialisasi Sequelize gagal:', error.message);
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
        activeModel: line.activeModel
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
    
    // Jika ada data yang dibackup, simpan ke file
    if (Object.keys(backupData.lines).length > 0) {
      const timestamp = new Date().getTime();
      const backupFileName = `backup_pre_reset_${today}_${timestamp}.json`;
      const backupFile = path.join(__dirname, 'history', backupFileName);
      
      // Simpan backup tanpa overwrite
      fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
      console.log(`✅ Backup data sebelum reset disimpan: ${backupFileName}`);
      
      // Hitung jumlah model yang dibackup
      let modelCount = 0;
      Object.keys(backupData.lines).forEach(lineName => {
        modelCount += Object.keys(backupData.lines[lineName].models).length;
      });
      
      console.log(`   Jumlah line yang dibackup: ${Object.keys(backupData.lines).length}`);
      console.log(`   Jumlah model yang dibackup: ${modelCount}`);
      
      return backupData;
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error dalam backup data sebelum reset:', error);
    return null;
  }
}

function checkAndResetDataForNewDay() {
  const data = readProductionData();
  const today = getToday();
  let resetCount = 0;

  console.log(`\n📊 Memulai reset data untuk tanggal baru: ${today}`);

  // Backup data sebelum reset untuk tanggal yang berbeda
  const backupData = backupDataBeforeReset(data, today);
  
  // Tampilkan info backup
  if (backupData && Object.keys(backupData.lines).length > 0) {
    let backupModelCount = 0;
    Object.keys(backupData.lines).forEach(lineName => {
      backupModelCount += Object.keys(backupData.lines[lineName].models).length;
    });
    console.log(`✅ Total ${backupModelCount} model dari ${Object.keys(backupData.lines).length} line telah dibackup sebelum reset`);
  } else {
    console.log(`ℹ️  Tidak ada data yang perlu dibackup (semua model sudah menggunakan tanggal ${today})`);
  }

  Object.keys(data.lines).forEach(lineName => {
    const line = data.lines[lineName];
    Object.keys(line.models).forEach(modelId => {
      const model = line.models[modelId];
      
      // Reset hanya jika tanggal model berbeda dengan hari ini
      if (model.date !== today) {
        console.log(`🔄 Reset data untuk line ${lineName}, model ${modelId} dari ${model.date} ke ${today}`);
        
        const masterData = {
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
    writeProductionData(data);
    console.log(`✅ Auto-reset selesai: ${resetCount} model direset ke tanggal ${today}`);
    
    // Update backup untuk hari ini setelah reset
    updateTodayBackup();
    
    // Buat arsip backup dengan timestamp
    createArchiveBackup();
  } else {
    console.log(`ℹ️  Tidak ada data yang perlu direset (semua model sudah menggunakan tanggal ${today})`);
  }

  return resetCount;
}

function initializeDataFiles() {
  if (!databaseInitialized) {
    productionDataCache = buildInitialProductionData();
    usersDataCache = buildInitialUsersData();
    defectConfigCache = buildInitialDefectConfig();
    publicDisplaySettingsCache = buildInitialPublicDisplaySettings();
  }

  const historyDir = path.join(__dirname, 'history');
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir);
    console.log('History directory created successfully');
  }
  
  // Buat subfolder untuk backup arsip
  const backupDir = path.join(__dirname, 'history', 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
    console.log('Backup directory created successfully');
  }
}

function readProductionData() {
  try {
    return productionDataCache;
  } catch (error) {
    console.error('ERROR: Gagal membaca production data cache:', error.message);
    return { lines: {}, activeLine: '' };
  }
}

function writeProductionData(data) {
  try {
    productionDataCache = data;
    void upsertAppData(PRODUCTION_DATA_KEY, data);
  } catch (error) {
    console.error('ERROR: Gagal menulis production data ke cache:', error.message);
  }
}

function readUsersData() {
  try {
    return usersDataCache;
  } catch (error) {
    console.error('ERROR: Gagal membaca users data cache:', error.message);
    return { users: [] };
  }
}

function writeUsersData(data) {
  try {
    usersDataCache = data;
    void upsertAppData(USERS_DATA_KEY, data);
  } catch (error) {
    console.error('ERROR: Gagal menulis users data ke cache:', error.message);
  }
}

function readDefectConfig() {
  try {
    defectConfigCache = normalizeDefectConfig(defectConfigCache);
    return defectConfigCache;
  } catch (error) {
    console.error('ERROR: Gagal membaca defect config cache:', error.message);
    return buildInitialDefectConfig();
  }
}

function writeDefectConfig(data) {
  try {
    defectConfigCache = normalizeDefectConfig(data);
    void upsertAppData(DEFECT_CONFIG_KEY, defectConfigCache);
  } catch (error) {
    console.error('ERROR: Gagal menulis defect config ke cache:', error.message);
  }
}

function readPublicDisplaySettings() {
  try {
    publicDisplaySettingsCache = normalizePublicDisplaySettings(publicDisplaySettingsCache);
    return publicDisplaySettingsCache;
  } catch (error) {
    console.error('ERROR: Gagal membaca public display settings cache:', error.message);
    return buildInitialPublicDisplaySettings();
  }
}

function writePublicDisplaySettings(data) {
  try {
    publicDisplaySettingsCache = normalizePublicDisplaySettings(data);
    void upsertAppData(PUBLIC_DISPLAY_SETTINGS_KEY, publicDisplaySettingsCache);
    return publicDisplaySettingsCache;
  } catch (error) {
    console.error('ERROR: Gagal menulis public display settings ke cache:', error.message);
    return readPublicDisplaySettings();
  }
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

function getActiveModel(data, lineName) {
  const line = data.lines[lineName];
  if (!line) return null;

  const activeModelId = line.activeModel || Object.keys(line.models || {})[0];
  if (!activeModelId || !line.models[activeModelId]) return null;

  return {
    line,
    modelId: activeModelId,
    model: line.models[activeModelId]
  };
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
    const line = lines[lineName];
    const activeModelId = line.activeModel || Object.keys(line.models || {})[0];
    const activeModel = activeModelId ? line.models[activeModelId] : null;

    response[lineName] = {
      ...line,
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
    const backupFile = path.join(__dirname, 'history', `data_${today}.json`);
    
    // Update file backup untuk tanggal hari ini
    fs.writeFileSync(backupFile, JSON.stringify(data, null, 2));
    console.log(`💾 Backup hari ini di-update: data_${today}.json`);
    
    return backupFile;
  } catch (error) {
    console.error('❌ Error updating today backup:', error);
    return null;
  }
}

// FUNGSI BACKUP BARU: Buat arsip backup dengan timestamp
function createArchiveBackup() {
  try {
    const data = readProductionData();
    const today = getToday();
    const timestamp = new Date().getTime();
    const archiveFile = path.join(__dirname, 'history', 'backups', `data_${today}_${timestamp}.json`);
    
    // Buat arsip dengan timestamp
    fs.writeFileSync(archiveFile, JSON.stringify(data, null, 2));
    console.log(`💾 Arsip backup dibuat: data_${today}_${timestamp}.json`);
    
    return archiveFile;
  } catch (error) {
    console.error('❌ Error creating archive backup:', error);
    return null;
  }
}

function getHistoryFiles() {
  try {
    const historyDir = path.join(__dirname, 'history');
    const files = fs.readdirSync(historyDir)
      .filter(file => file.startsWith('data_') && file.endsWith('.json'))
      .map(file => {
        const filePath = path.join(historyDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          date: file.replace('data_', '').replace('.json', ''),
          size: stats.size,
          created: stats.birthtime
        };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    
    return files;
  } catch (error) {
    console.error('❌ Error reading history files:', error);
    return [];
  }
}

function readHistoryData(filename) {
  try {
    const filePath = path.join(__dirname, 'history', filename);
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('❌ Error reading history file:', error);
    return null;
  }
}

function requireLogin(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized - Please login' });
  }
}

function hasAnyRole(user, allowedRoles) {
  return Boolean(user && allowedRoles.includes(user.role));
}

function requireAdmin(req, res, next) {
  if (hasAnyRole(req.session.user, ['admin'])) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Admin access required' });
  }
}

function requireAdminOrAdminOperator(req, res, next) {
  if (hasAnyRole(req.session.user, ['admin', 'admin_operator'])) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Admin or Admin Operator access required' });
  }
}

function requireLineManagementAccess(req, res, next) {
  if (hasAnyRole(req.session.user, ['admin', 'admin_operator'])) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Line management access required' });
  }
}

function requireDateReportAccess(req, res, next) {
  if (hasAnyRole(req.session.user, ['admin', 'admin_operator'])) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Date report access required' });
  }
}

function requireLineAccess(req, res, next) {
  const user = req.session.user;
  const lineName = req.params.lineName;
  
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized - Please login' });
  }

  if (user.role === 'admin' || user.role === 'admin_operator') {
    return next();
  }

  if (user.role === 'operator' && user.line === lineName) {
    return next();
  }

  res.status(403).json({ error: 'Access denied to this line' });
}

function isOperatorProductionLocked(req, hour) {
  return req.session.user?.role === 'operator' && Boolean(hour?.productionLocked);
}

function autoCheckDateReset(req, res, next) {
  checkAndResetDataForNewDay();
  next();
}

// ENDPOINT UNTUK MENDAPATKAN DAFTAR BACKUP DATA
app.get('/api/backup-history', requireLogin, requireAdmin, (req, res) => {
  try {
    const backupDir = path.join(__dirname, 'history', 'backups');
    let backupFiles = [];
    
    if (fs.existsSync(backupDir)) {
      backupFiles = fs.readdirSync(backupDir)
        .filter(file => (file.startsWith('backup_pre_reset_') || file.startsWith('data_')) && file.endsWith('.json'))
        .map(file => {
          const filePath = path.join(backupDir, file);
          const stats = fs.statSync(filePath);
          let date = '';
          let type = 'daily';
          
          if (file.startsWith('backup_pre_reset_')) {
            date = file.replace('backup_pre_reset_', '').replace(/_\d+\.json$/, '');
            type = 'pre_reset';
          } else if (file.startsWith('data_')) {
            date = file.replace('data_', '').replace(/_\d+\.json$/, '');
            type = 'daily';
          }
          
          return {
            filename: file,
            date: date,
            type: type,
            size: stats.size,
            created: stats.birthtime,
            displayDate: new Date(date + 'T00:00:00+07:00').toLocaleDateString('id-ID'),
            fullPath: filePath
          };
        })
        .sort((a, b) => new Date(b.created) - new Date(a.created));
    }
    
    res.json(backupFiles);
  } catch (error) {
    console.error('❌ Error reading backup history:', error);
    res.status(500).json({ error: 'Failed to read backup history' });
  }
});

// ENDPOINT UNTUK MEMULIHKAN DATA DARI BACKUP
app.post('/api/restore-backup/:filename', requireLogin, requireAdmin, (req, res) => {
  const { filename } = req.params;
  
  if (!filename.endsWith('.json')) {
    return res.status(400).json({ error: 'Invalid backup filename' });
  }

  try {
    let backupFile;
    
    // Cari file backup di berbagai lokasi
    if (fs.existsSync(path.join(__dirname, 'history', 'backups', filename))) {
      backupFile = path.join(__dirname, 'history', 'backups', filename);
    } else if (fs.existsSync(path.join(__dirname, 'history', filename))) {
      backupFile = path.join(__dirname, 'history', filename);
    } else {
      return res.status(404).json({ error: 'Backup file not found' });
    }
    
    const backupData = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    const currentData = readProductionData();
    
    console.log(`🔄 Memulihkan backup dari: ${filename}`);
    
    // Gabungkan data backup dengan data saat ini
    let restoredLines = 0;
    let restoredModels = 0;
    
    Object.keys(backupData.lines).forEach(lineName => {
      if (!currentData.lines[lineName]) {
        currentData.lines[lineName] = backupData.lines[lineName];
        restoredLines++;
      } else {
        Object.keys(backupData.lines[lineName].models).forEach(modelId => {
          if (!currentData.lines[lineName].models[modelId]) {
            currentData.lines[lineName].models[modelId] = backupData.lines[lineName].models[modelId];
            restoredModels++;
          } else {
            // Jika model sudah ada, kita bisa skip atau overwrite
            // Untuk sekarang kita skip
            console.log(`   Model ${modelId} di line ${lineName} sudah ada, skip...`);
          }
        });
      }
    });
    
    writeProductionData(currentData);
    
    // Update backup hari ini setelah restore
    updateTodayBackup();
    
    res.json({
      message: '✅ Backup restored successfully',
      restoredLines: restoredLines,
      restoredModels: restoredModels,
      totalLines: Object.keys(currentData.lines).length,
      totalModels: Object.keys(currentData.lines).reduce((total, lineName) => {
        return total + Object.keys(currentData.lines[lineName].models).length;
      }, 0)
    });
  } catch (error) {
    console.error('❌ Error restoring backup:', error);
    res.status(500).json({ error: 'Failed to restore backup: ' + error.message });
  }
});

// ENDPOINT UNTUK EXPORT BACKUP KE EXCEL
app.get('/api/export-backup/:filename', requireLogin, requireAdmin, async (req, res) => {
  const { filename } = req.params;
  
  if (!filename.endsWith('.json')) {
    return res.status(400).json({ error: 'Invalid backup filename' });
  }

  try {
    let backupFile;
    
    // Cari file backup di berbagai lokasi
    if (fs.existsSync(path.join(__dirname, 'history', 'backups', filename))) {
      backupFile = path.join(__dirname, 'history', 'backups', filename);
    } else if (fs.existsSync(path.join(__dirname, 'history', filename))) {
      backupFile = path.join(__dirname, 'history', filename);
    } else {
      return res.status(404).json({ error: 'Backup file not found' });
    }
    
    const backupData = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    let date = '';
    
    if (filename.startsWith('backup_pre_reset_')) {
      date = filename.replace('backup_pre_reset_', '').replace(/_\d+\.json$/, '');
    } else if (filename.startsWith('data_')) {
      date = filename.replace('data_', '').replace(/_\d+\.json$/, '');
    } else {
      date = new Date().toISOString().split('T')[0];
    }
    
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
        
        lineSheet.getCell(`A${currentRow}`).value = 'Date';
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
    console.log(`✅ Backup exported: ${filename}`);
  } catch (error) {
    console.error('❌ Error exporting backup:', error);
    res.status(500).json({ error: 'Failed to export backup: ' + error.message });
  }
});

// ENDPOINT UNTUK MENGORGANISIR FILE BACKUP
app.post('/api/organize-backups', requireLogin, requireAdmin, (req, res) => {
  try {
    const historyDir = path.join(__dirname, 'history');
    const backupDir = path.join(__dirname, 'history', 'backups');
    
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir);
    }
    
    // Pindahkan semua file backup ke folder backups
    const files = fs.readdirSync(historyDir)
      .filter(file => (file.startsWith('backup_pre_reset_') || file.startsWith('data_')) && 
                      file.endsWith('.json') && 
                      !file.includes('backups'));
    
    let movedCount = 0;
    files.forEach(file => {
      const oldPath = path.join(historyDir, file);
      const newPath = path.join(backupDir, file);
      
      // Jika file sudah ada di backupDir, tambahkan timestamp
      if (fs.existsSync(newPath)) {
        const timestamp = new Date().getTime();
        const newName = file.replace('.json', `_${timestamp}.json`);
        const newPathWithTimestamp = path.join(backupDir, newName);
        fs.renameSync(oldPath, newPathWithTimestamp);
        console.log(`Moved backup file with timestamp: ${newName}`);
      } else {
        fs.renameSync(oldPath, newPath);
        console.log(`Moved backup file: ${file}`);
      }
      
      movedCount++;
    });
    
    res.json({
      message: `✅ Backup files organized successfully`,
      movedCount: movedCount,
      backupDir: backupDir
    });
  } catch (error) {
    console.error('❌ Error organizing backups:', error);
    res.status(500).json({ error: 'Failed to organize backups: ' + error.message });
  }
});

// ENDPOINT UNTUK CEK STATUS SISTEM
app.get('/api/system-status', requireLogin, requireAdmin, (req, res) => {
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
  
  // Cek jumlah backup files
  const backupDir = path.join(__dirname, 'history', 'backups');
  let backupCount = 0;
  if (fs.existsSync(backupDir)) {
    backupCount = fs.readdirSync(backupDir)
      .filter(file => file.endsWith('.json')).length;
  }
  
  res.json({
    systemTime: now.toLocaleString('id-ID'),
    systemTimeUTC: now.toISOString(),
    today: today,
    modelCount: modelCount,
    todayModelCount: todayModelCount,
    otherDateModelCount: otherDateModelCount,
    modelDates: modelDates,
    backupCount: backupCount,
    needsSync: otherDateModelCount > 0
  });
});

// ENDPOINT UNTUK MENDAPATKAN DAFTAR TANGGAL YANG TERSEDIA
app.get('/api/available-dates', requireLogin, requireDateReportAccess, (req, res) => {
  try {
    const historyDir = path.join(__dirname, 'history');
    let dates = [];
    
    if (fs.existsSync(historyDir)) {
      dates = fs.readdirSync(historyDir)
        .filter(file => file.startsWith('data_') && file.endsWith('.json'))
        .map(file => file.replace('data_', '').replace('.json', ''))
        .sort((a, b) => new Date(b) - new Date(a));
    }
    
    // Tambahkan tanggal hari ini jika belum ada
    const today = getToday();
    if (!dates.includes(today)) {
      dates.unshift(today);
    }
    
    res.json(dates);
  } catch (error) {
    console.error('❌ Error getting available dates:', error);
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

function getQcCheckHourLabel(model = {}, check = {}) {
  const index = parseInt(check.hourIndex);
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
    qcChecked: 0,
    defectRate: 0,
    areaCounts: {},
    typeCounts: {}
  };
}

function addModelToProductionSummary(summary, model) {
  summary.modelCount += 1;
  summary.target += parseInt(model.target) || 0;
  summary.output += parseInt(model.outputDay) || 0;
  summary.defect += parseInt(model.actualDefect) || 0;
  summary.qcChecked += parseInt(model.qcChecking) || 0;

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

function summarizeProductionSnapshot(data, date) {
  const summary = {
    date,
    lineCount: 0,
    modelCount: 0,
    target: 0,
    output: 0,
    defect: 0,
    qcChecked: 0,
    defectRate: 0,
    areaCounts: {},
    typeCounts: {}
  };

  Object.keys(data.lines || {}).forEach(lineName => {
    const line = data.lines[lineName];
    let hasModelForDate = false;

    Object.keys(line.models || {}).forEach(modelId => {
      const model = line.models[modelId];
      if (model.date && model.date !== date) return;

      hasModelForDate = true;
      summary.modelCount += 1;
      summary.target += parseInt(model.target) || 0;
      summary.output += parseInt(model.outputDay) || 0;
      summary.defect += parseInt(model.actualDefect) || 0;
      summary.qcChecked += parseInt(model.qcChecking) || 0;

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

function summarizeProductionSnapshotByLine(data, date) {
  const summaries = [];

  Object.keys(data.lines || {}).forEach(lineName => {
    const line = data.lines[lineName];
    const summary = createProductionSummary(date, lineName);

    Object.keys(line.models || {}).forEach(modelId => {
      const model = line.models[modelId];
      if (model.date && model.date !== date) return;
      addModelToProductionSummary(summary, model);
    });

    if (summary.modelCount > 0) {
      summary.lineCount = 1;
      summaries.push(finalizeProductionSummary(summary));
    }
  });

  return summaries;
}

function topCounterItems(counter, limit = 5) {
  return Object.entries(counter)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

app.get('/api/dashboard-summary', requireLogin, requireAdminOrAdminOperator, autoCheckDateReset, (req, res) => {
  try {
    const snapshotsByDate = new Map();
    const historyDir = path.join(__dirname, 'history');

    if (fs.existsSync(historyDir)) {
      fs.readdirSync(historyDir)
        .filter(file => /^data_\d{4}-\d{2}-\d{2}\.json$/.test(file))
        .forEach(file => {
          const date = file.replace('data_', '').replace('.json', '');
          const filePath = path.join(historyDir, file);
          try {
            snapshotsByDate.set(date, JSON.parse(fs.readFileSync(filePath, 'utf8')));
          } catch (error) {
            console.error(`Failed to read dashboard history ${file}:`, error.message);
          }
        });
    }

    snapshotsByDate.set(getToday(), readProductionData());

    const totalAreaCounts = {};
    const totalTypeCounts = {};
    const lineNames = new Set();
    const daily = Array.from(snapshotsByDate.entries())
      .map(([date, data]) => summarizeProductionSnapshot(data, date))
      .filter(item => item.modelCount > 0)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const lineDaily = [];
    Array.from(snapshotsByDate.entries()).forEach(([date, data]) => {
      summarizeProductionSnapshotByLine(data, date).forEach(item => {
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
    console.error('Error building dashboard summary:', error);
    res.status(500).json({ error: 'Failed to build dashboard summary' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const usersData = readUsersData();
  const user = usersData.users.find(u => u.username === username);

  if (user && verifyPassword(password, user.password)) {
    req.session.user = {
      id: user.id,
      name: user.name,
      username: user.username,
      line: user.line,
      role: user.role
    };
    res.json({
      message: 'Login successful',
      user: req.session.user
    });
  } else {
    res.status(401).json({ error: 'Invalid username or password' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logout successful' });
});

app.get('/api/current-user', (req, res) => {
  if (req.session.user) {
    res.json(req.session.user);
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

app.post('/api/update-hourly/:lineName', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName } = req.params;
  const { hourIndex, output, defect, qcChecked, targetManual, defectDetails } = req.body;
  const data = readProductionData();
  const active = getActiveModel(data, lineName);

  if (!active || !active.model.hourly_data) {
    return res.status(404).json({ error: 'Line, active model or hourly data not found' });
  }

  const index = parseInt(hourIndex);
  if (!Number.isInteger(index) || index < 0 || index >= active.model.hourly_data.length) {
    return res.status(400).json({ error: 'Invalid hour index' });
  }

	  const currentHour = active.model.hourly_data[index];
	  if (isOperatorProductionLocked(req, currentHour)) {
	    return res.status(403).json({ error: 'Data produksi jam ini sudah disimpan dan tidak bisa diubah' });
	  }

	  const nextTargetManual = targetManual !== undefined
	    ? parseInt(targetManual) || 0
	    : parseInt(currentHour.targetManual) || 0;
  const nextOutput = parseInt(output) || 0;

  active.model.hourly_data[index] = {
    ...currentHour,
	    output: nextOutput,
	    defect: parseInt(defect) || 0,
	    qcChecked: parseInt(qcChecked) || 0,
	    targetManual: nextTargetManual,
	    defectDetails: Array.isArray(defectDetails) ? defectDetails : (currentHour.defectDetails || []),
	    productionLocked: req.session.user?.role === 'operator' ? true : Boolean(currentHour.productionLocked),
	    productionLockedAt: req.session.user?.role === 'operator' ? new Date().toISOString() : currentHour.productionLockedAt,
	    productionLockedBy: req.session.user?.role === 'operator' ? req.session.user.username : currentHour.productionLockedBy,
	    selisih: nextOutput - nextTargetManual
	  };

  const summary = recalculateModelTotals(active.model);

  writeProductionData(data);
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

app.post('/api/update-target-manual/:lineName', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName } = req.params;
  const { hourIndex, targetManual } = req.body;
  const data = readProductionData();
  const active = getActiveModel(data, lineName);

  if (!active || !active.model.hourly_data) {
    return res.status(404).json({ error: 'Line, active model or hourly data not found' });
  }

  const index = parseInt(hourIndex);
  if (!Number.isInteger(index) || index < 0 || index >= active.model.hourly_data.length) {
    return res.status(400).json({ error: 'Invalid hour index' });
  }

	  if (isOperatorProductionLocked(req, active.model.hourly_data[index])) {
	    return res.status(403).json({ error: 'Data produksi jam ini sudah disimpan dan tidak bisa diubah' });
	  }

	  const nextTargetManual = parseInt(targetManual) || 0;
  active.model.hourly_data[index].targetManual = nextTargetManual;
  active.model.hourly_data[index].selisih = (parseInt(active.model.hourly_data[index].output) || 0) - nextTargetManual;
  const summary = recalculateModelTotals(active.model);

  writeProductionData(data);
  updateTodayBackup();

  res.json({
    message: 'Target manual updated successfully.',
    data: active.model.hourly_data[index],
    modelId: active.modelId,
    totalTarget: summary.totalTarget
  });
});

app.post('/api/update-hourly-direct/:lineName', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName } = req.params;
  const { hourIndex, output, defect, qcChecked, targetManual } = req.body;
  const data = readProductionData();
  const active = getActiveModel(data, lineName);

  if (!active || !active.model.hourly_data) {
    return res.status(404).json({ error: 'Line, active model or hourly data not found' });
  }

  const index = parseInt(hourIndex);
  if (!Number.isInteger(index) || index < 0 || index >= active.model.hourly_data.length) {
    return res.status(400).json({ error: 'Invalid hour index' });
  }

	  const nextOutput = parseInt(output) || 0;
	  const nextTargetManual = parseInt(targetManual) || 0;
	  if (isOperatorProductionLocked(req, active.model.hourly_data[index])) {
	    return res.status(403).json({ error: 'Data produksi jam ini sudah disimpan dan tidak bisa diubah' });
	  }

	  active.model.hourly_data[index] = {
	    ...active.model.hourly_data[index],
	    output: nextOutput,
	    defect: parseInt(defect) || 0,
	    qcChecked: parseInt(qcChecked) || 0,
	    targetManual: nextTargetManual,
	    productionLocked: req.session.user?.role === 'operator' ? true : Boolean(active.model.hourly_data[index].productionLocked),
	    productionLockedAt: req.session.user?.role === 'operator' ? new Date().toISOString() : active.model.hourly_data[index].productionLockedAt,
	    productionLockedBy: req.session.user?.role === 'operator' ? req.session.user.username : active.model.hourly_data[index].productionLockedBy,
	    selisih: nextOutput - nextTargetManual
	  };

  const summary = recalculateModelTotals(active.model);

  writeProductionData(data);
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

app.post('/api/update-hourly/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName, modelId } = req.params;
  const { hourIndex, output, defect, qcChecked, targetManual, defectDetails } = req.body;

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
    return res.status(404).json({ error: 'Line, model or hourly data not found' });
  }

  const index = parseInt(hourIndex);
  if (!Number.isInteger(index) || index < 0 || index >= data.lines[lineName].models[modelId].hourly_data.length) {
    return res.status(400).json({ error: 'Invalid hour index' });
  }

  const currentHour = data.lines[lineName].models[modelId].hourly_data[index];
  const nextTargetManual = parseInt(targetManual) || currentHour.targetManual || 0;
  const nextOutput = parseInt(output) || 0;
  const nextDefect = parseInt(defect) || 0;
  const selisih = nextOutput - nextTargetManual;

  data.lines[lineName].models[modelId].hourly_data[index] = {
    ...currentHour,
    output: nextOutput,
    defect: nextDefect,
    qcChecked: parseInt(qcChecked) || 0,
    targetManual: nextTargetManual,
    defectDetails: Array.isArray(defectDetails) ? defectDetails : (currentHour.defectDetails || []),
    selisih: selisih
  };

  const summary = recalculateModelTotals(data.lines[lineName].models[modelId]);

  writeProductionData(data);
  
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

app.post('/api/update-production/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName, modelId } = req.params;
  const { hourIndex, output, targetManual } = req.body;
  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
    return res.status(404).json({ error: 'Line, model or hourly data not found' });
  }

  const index = parseInt(hourIndex);
  const model = data.lines[lineName].models[modelId];
  if (!Number.isInteger(index) || index < 0 || index >= model.hourly_data.length) {
    return res.status(400).json({ error: 'Invalid hour index' });
  }

	  const currentHour = model.hourly_data[index];
	  if (isOperatorProductionLocked(req, currentHour)) {
	    return res.status(403).json({ error: 'Data produksi jam ini sudah disimpan dan tidak bisa diubah' });
	  }

	  const nextOutput = parseInt(output) || 0;
	  const nextTargetManual = parseInt(targetManual) || currentHour.targetManual || 0;

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
  writeProductionData(data);
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

app.post('/api/qc-check/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
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

	  const model = data.lines[lineName].models[modelId];
	  model.qcChecks = Array.isArray(model.qcChecks) ? model.qcChecks : [];
	  const parsedHourIndex = parseInt(hourIndex);
	  const validHourIndex = Number.isInteger(parsedHourIndex) && model.hourly_data && model.hourly_data[parsedHourIndex]
	    ? parsedHourIndex
	    : null;

	  const qcCheck = {
	    id: generateNumericId(model.qcChecks),
	    result,
	    hourIndex: validHourIndex,
	    hour: validHourIndex !== null ? model.hourly_data[validHourIndex].hour : '',
	    type: result === 'defect' ? String(type).trim() : '',
	    area: result === 'defect' ? String(area).trim() : '',
    notes: notes ? String(notes).trim() : '',
    checkedAt: new Date().toISOString()
  };

  model.qcChecks.push(qcCheck);

  const summary = recalculateModelTotals(model);
  writeProductionData(data);
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

app.post('/api/update-target-manual/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName, modelId } = req.params;
  const { hourIndex, targetManual } = req.body;

  const data = readProductionData();

	  if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
	    return res.status(404).json({ error: 'Line, model or hourly data not found' });
	  }

	  const index = parseInt(hourIndex);
	  const model = data.lines[lineName].models[modelId];
	  if (!Number.isInteger(index) || index < 0 || index >= model.hourly_data.length) {
	    return res.status(400).json({ error: 'Invalid hour index' });
	  }

	  const currentHour = model.hourly_data[index];
	  if (isOperatorProductionLocked(req, currentHour)) {
	    return res.status(403).json({ error: 'Data produksi jam ini sudah disimpan dan tidak bisa diubah' });
	  }

	  model.hourly_data[index].targetManual = parseInt(targetManual);
	  
	  model.hourly_data[index].selisih = model.hourly_data[index].output - parseInt(targetManual);

	  let totalTarget = 0;
	  model.hourly_data.forEach(hour => {
	    totalTarget += hour.targetManual || 0;
	  });
	  model.target = totalTarget;

  writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
	  res.json({
	    message: 'Target manual updated successfully.',
	    data: model.hourly_data[index],
	    totalTarget: totalTarget
	  });
});

app.post('/api/update-hourly-direct/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName, modelId } = req.params;
  const { hourIndex, output, defect, qcChecked, targetManual, defectDetails } = req.body;

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
    return res.status(404).json({ error: 'Line, model or hourly data not found' });
  }

  const selisih = parseInt(output) - parseInt(targetManual);

	  const currentHour = data.lines[lineName].models[modelId].hourly_data[hourIndex];
	  if (isOperatorProductionLocked(req, currentHour)) {
	    return res.status(403).json({ error: 'Data produksi jam ini sudah disimpan dan tidak bisa diubah' });
	  }

	  data.lines[lineName].models[modelId].hourly_data[hourIndex] = {
	    ...currentHour,
	    output: parseInt(output),
	    defect: parseInt(defect),
	    qcChecked: parseInt(qcChecked),
	    targetManual: parseInt(targetManual),
	    defectDetails: Array.isArray(defectDetails) ? defectDetails : (currentHour.defectDetails || []),
	    productionLocked: req.session.user?.role === 'operator' ? true : Boolean(currentHour.productionLocked),
	    productionLockedAt: req.session.user?.role === 'operator' ? new Date().toISOString() : currentHour.productionLockedAt,
	    productionLockedBy: req.session.user?.role === 'operator' ? req.session.user.username : currentHour.productionLockedBy,
	    selisih: selisih
	  };

  const summary = recalculateModelTotals(data.lines[lineName].models[modelId]);

  writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
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

app.get('/api/history/files', requireLogin, requireAdmin, (req, res) => {
  try {
    const historyFiles = getHistoryFiles();
    res.json(historyFiles);
  } catch (error) {
    console.error('❌ Error getting history files:', error);
    res.status(500).json({ error: 'Failed to get history files' });
  }
});

app.get('/api/history/:filename', requireLogin, requireAdmin, (req, res) => {
  const { filename } = req.params;
  
  if (!filename.startsWith('data_') || !filename.endsWith('.json')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  try {
    const historyData = readHistoryData(filename);
    if (!historyData) {
      return res.status(404).json({ error: 'History file not found' });
    }
    res.json(historyData);
  } catch (error) {
    console.error('❌ Error reading history file:', error);
    res.status(500).json({ error: 'Failed to read history data' });
  }
});

app.get('/api/history/:filename/export', requireLogin, requireAdmin, (req, res) => {
  const { filename } = req.params;
  
  if (!filename.startsWith('data_') || !filename.endsWith('.json')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  try {
    const historyData = readHistoryData(filename);
    if (!historyData) {
      return res.status(404).json({ error: 'History file not found' });
    }

    const date = filename.replace('data_', '').replace('.json', '');
    
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
    console.error('❌ Export history error:', error);
    res.status(500).json({ error: 'Failed to export history data' });
  }
});

app.post('/api/backup/now', requireLogin, requireAdmin, (req, res) => {
  try {
    // Buat arsip backup
    createArchiveBackup();
    res.json({ message: '✅ Archive backup created successfully' });
  } catch (error) {
    console.error('❌ Error creating backup:', error);
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

app.post('/api/sync-dates', requireLogin, requireAdmin, (req, res) => {
  console.log('🔄 Manual sync-dates endpoint called');
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

app.get('/api/lines', requireLogin, autoCheckDateReset, (req, res) => {
  const user = req.session.user;
  const data = readProductionData();
  
  if (user.role === 'admin' || user.role === 'admin_operator') {
    return res.json(buildLinesResponse(data.lines || {}));
  }
  
  if (user.role === 'operator') {
    const operatorLine = {};
    if (data.lines[user.line]) {
      operatorLine[user.line] = data.lines[user.line];
    }
    return res.json(buildLinesResponse(operatorLine));
  }
  
  res.status(403).json({ error: 'Access denied' });
});

app.get('/api/lines/:lineName/models', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName } = req.params;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  res.json(data.lines[lineName].models || {});
});

app.post('/api/lines', requireLogin, requireLineManagementAccess, (req, res) => {
  const { lineName, labelWeek, model, target, date } = req.body;
  const data = readProductionData();

  if (data.lines[lineName]) {
    return res.status(400).json({ error: 'Line already exists' });
  }

  const lineDate = date || getToday();
  const targetPerHour = Math.round(target / 8);
  const modelId = 'model1';

  data.lines[lineName] = {
    models: {
      [modelId]: {
        id: modelId,
        labelWeek,
        model,
        date: lineDate,
        target: parseInt(target),
        targetPerHour: targetPerHour,
        outputDay: 0,
        qcChecking: 0,
        actualDefect: 0,
        defectRatePercentage: 0,
        hourly_data: [
          { hour: "07:00 - 08:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
          { hour: "08:00 - 09:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
          { hour: "09:00 - 10:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
          { hour: "10:00 - 11:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
          { hour: "11:00 - 13:00", output: 0, defect: 0, qcChecked: 0, targetManual: 0, selisih: 0 },
          { hour: "13:00 - 14:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
          { hour: "14:00 - 15:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
          { hour: "15:00 - 16:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
          { hour: "16:00 - 17:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
        ],
        operators: []
      }
    },
    activeModel: modelId
  };

  writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ 
    message: `Line ${lineName} created successfully`, 
    data: data.lines[lineName],
    calculated: {
      targetPerHour: targetPerHour,
      message: `Target per jam: ${targetPerHour} unit (Target: ${target} ÷ 8 jam efektif)`
    }
  });
});

app.post('/api/lines/:lineName/models', requireLogin, requireLineManagementAccess, (req, res) => {
  const { lineName } = req.params;
  const { labelWeek, model, target, date } = req.body;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const lineDate = date || getToday();
  const targetPerHour = Math.round(target / 8);
  
  const modelCount = Object.keys(data.lines[lineName].models).length;
  const modelId = `model${modelCount + 1}`;

  data.lines[lineName].models[modelId] = {
    id: modelId,
    labelWeek,
    model,
    date: lineDate,
    target: parseInt(target),
    targetPerHour: targetPerHour,
    outputDay: 0,
    qcChecking: 0,
    actualDefect: 0,
    defectRatePercentage: 0,
    hourly_data: [
      { hour: "07:00 - 08:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "08:00 - 09:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "09:00 - 10:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "10:00 - 11:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "11:00 - 13:00", output: 0, defect: 0, qcChecked: 0, targetManual: 0, selisih: 0 },
      { hour: "13:00 - 14:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "14:00 - 15:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "15:00 - 16:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
      { hour: "16:00 - 17:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 },
    ],
    operators: []
  };

  writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ 
    message: `Model ${modelId} added to line ${lineName} successfully`, 
    data: data.lines[lineName].models[modelId],
    modelId: modelId
  });
});

app.put('/api/lines/:lineName', requireLogin, requireLineManagementAccess, autoCheckDateReset, (req, res) => {
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

  const newTarget = parseInt(target);

  data.lines[lineName].models[targetModelId].labelWeek = labelWeek;
  data.lines[lineName].models[targetModelId].model = model;
  data.lines[lineName].models[targetModelId].target = newTarget;
  data.lines[lineName].models[targetModelId].targetPerHour = Math.round(newTarget / 8);
  
  if (date) {
    data.lines[lineName].models[targetModelId].date = date;
  }

  data.lines[lineName].models[targetModelId].hourly_data.forEach(hour => {
    if (hour.hour !== "11:00 - 13:00") {
      hour.targetManual = data.lines[lineName].models[targetModelId].targetPerHour;
      hour.selisih = hour.output - hour.targetManual;
    }
  });

  let totalTarget = 0;
  data.lines[lineName].models[targetModelId].hourly_data.forEach(hour => {
    totalTarget += hour.targetManual || 0;
  });
  data.lines[lineName].models[targetModelId].target = totalTarget;

  writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ 
    message: `Model ${targetModelId} in line ${lineName} updated successfully`, 
    data: data.lines[lineName].models[targetModelId]
  });
});

app.delete('/api/lines/:lineName/models/:modelId', requireLogin, requireLineManagementAccess, (req, res) => {
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

  if (data.lines[lineName].activeModel === modelId) {
    const remainingModels = Object.keys(data.lines[lineName].models);
    data.lines[lineName].activeModel = remainingModels[0];
  }

  writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ message: `Model ${modelId} deleted from line ${lineName} successfully` });
});

app.delete('/api/lines/:lineName', requireLogin, requireAdmin, (req, res) => {
  const lineName = req.params.lineName;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  delete data.lines[lineName];
  writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ message: `Line ${lineName} deleted successfully` });
});

app.post('/api/lines/:lineName/active-model', requireLogin, requireLineManagementAccess, autoCheckDateReset, (req, res) => {
  const { lineName } = req.params;
  const { modelId } = req.body;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  if (!data.lines[lineName].models[modelId]) {
    return res.status(404).json({ error: 'Model not found' });
  }

  data.lines[lineName].activeModel = modelId;
  writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ 
    message: `Active model for line ${lineName} set to ${modelId}`,
    activeModel: modelId
  });
});

app.get('/api/line/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
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

app.get('/api/line/:lineName', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName } = req.params;
  const data = readProductionData();
  
  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const activeModelId = data.lines[lineName].activeModel;
  if (!activeModelId || !data.lines[lineName].models[activeModelId]) {
    return res.status(404).json({ error: 'Active model not found' });
  }

  const modelData = data.lines[lineName].models[activeModelId];
  res.json({ 
    line: lineName,
    modelId: activeModelId,
    ...modelData 
  });
});

app.post('/api/update-line/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName, modelId } = req.params;
  const newData = req.body;

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].models[modelId]) {
    return res.status(404).json({ error: 'Line or model not found' });
  }

  data.lines[lineName].models[modelId] = { ...data.lines[lineName].models[modelId], ...newData };

  const model = data.lines[lineName].models[modelId];
  const qcChecking = model.qcChecking || 0;
  const actualDefect = model.actualDefect || 0;

  let defectRatePercentage = (qcChecking > 0) ? (actualDefect / qcChecking) * 100 : 0;

  model.defectRatePercentage = parseFloat(defectRatePercentage.toFixed(2));

  writeProductionData(data);
  
  // ✅ UPDATE BACKUP HARI INI
  updateTodayBackup();
  
  res.json({ message: `Model ${modelId} in line ${lineName} updated successfully.`, data: model });
});

app.get('/api/date-report/:date', requireLogin, requireDateReportAccess, autoCheckDateReset, (req, res) => {
  const date = req.params.date;
  
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Format tanggal tidak valid. Gunakan format: YYYY-MM-DD' });
  }
  
  try {
    const backupFile = path.join(__dirname, 'history', `data_${date}.json`);
    let data;
    
    if (fs.existsSync(backupFile)) {
      console.log(`📂 Mengambil data dari backup: ${backupFile}`);
      data = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    } else {
      console.log(`⚠️  Backup untuk tanggal ${date} tidak ditemukan`);
      
      // Jika tidak ada backup, coba ambil dari data.json dan filter berdasarkan tanggal
      const allData = readProductionData();
      const today = getToday();
      
      if (date === today) {
        console.log(`ℹ️  Tanggal ${date} sama dengan hari ini, menggunakan data.json langsung`);
        data = allData;
      } else {
        console.log(`⚠️  Tidak ada data untuk tanggal ${date}`);
        return res.json([]); // Kembalikan array kosong jika tidak ada data
      }
    }
    
    const reportData = [];
    Object.keys(data.lines).forEach(lineName => {
      const line = data.lines[lineName];
      Object.keys(line.models).forEach(modelId => {
        const model = line.models[modelId];
        
        // Filter berdasarkan tanggal yang diminta
        if (model.date === date) {
          reportData.push({
            line: lineName,
            modelId: modelId,
            labelWeek: model.labelWeek,
            model: model.model,
            date: model.date,
            target: model.target || 0,
            output: model.outputDay || 0,
            defect: model.actualDefect || 0,
            qcChecked: model.qcChecking || 0,
            defectRate: model.defectRatePercentage || 0
          });
        }
      });
    });
    
    console.log(`✅ Laporan tanggal ${date} berhasil dibuat. Jumlah data: ${reportData.length}`);
    res.json(reportData);
  } catch (error) {
    console.error('❌ Error generating date report:', error);
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
  
	  summarySheet.mergeCells('A1:L1');
  const titleCell = summarySheet.getCell('A1');
  titleCell.value = 'PRODUCTION REPORT SUMMARY - ' + date;
  titleCell.style = titleStyle;
  
  summarySheet.getCell('A3').value = 'Generated Date';
  summarySheet.getCell('B3').value = new Date().toLocaleString('id-ID');
  summarySheet.getCell('A4').value = 'Report Date';
  summarySheet.getCell('B4').value = date;
  summarySheet.getCell('A5').value = 'Total Lines';
  summarySheet.getCell('B5').value = Object.keys(data.lines).length;
  
	  const headers = ['Line', 'Model ID', 'Label/Week', 'Model', 'Target', 'Output', 'Achievement %', 'Defect', 'Jenis Defect', 'Defect Area', 'QC Checked', 'Defect Rate %'];
  summarySheet.getRow(7).values = headers;
  summarySheet.getRow(7).eachCell((cell) => {
    cell.style = headerStyle;
  });
  
  let rowIndex = 8;
  let totalTarget = 0;
  let totalOutput = 0;
  let totalDefect = 0;
  let totalQCChecked = 0;
  
  Object.keys(data.lines).forEach(lineName => {
    const line = data.lines[lineName];
	    Object.keys(line.models).forEach(modelId => {
	      const model = line.models[modelId];
	      const achievement = model.target > 0 ? ((model.outputDay || 0) / model.target * 100).toFixed(2) + '%' : '0%';
	      const defectCategories = summarizeModelDefectCategories(model);
	      
	      const row = summarySheet.getRow(rowIndex);
	      row.values = [
        lineName,
        modelId,
        model.labelWeek || '',
        model.model || '',
        model.target || 0,
	        model.outputDay || 0,
	        achievement,
	        model.actualDefect || 0,
	        defectCategories.types,
	        defectCategories.areas,
	        model.qcChecking || 0,
	        (model.defectRatePercentage || 0) + '%'
	      ];
      
      const achievementCell = row.getCell(7);
      const achievementValue = parseFloat(achievement);
      if (achievementValue >= 100) {
        achievementCell.font = { color: { argb: '00B050' }, bold: true };
      } else if (achievementValue >= 80) {
        achievementCell.font = { color: { argb: 'FFC000' }, bold: true };
      } else {
        achievementCell.font = { color: { argb: 'FF0000' }, bold: true };
      }
      
	      const defectRateCell = row.getCell(12);
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
    totalTarget,
	    totalOutput,
	    totalAchievement,
	    totalDefect,
	    '',
	    '',
	    totalQCChecked,
	    totalDefectRate
	  ];
  totalRow.eachCell((cell) => {
    cell.style = totalStyle;
  });
  
  summarySheet.columns = [
    { width: 15 },
    { width: 12 },
    { width: 15 },
    { width: 30 },
    { width: 12 },
    { width: 12 },
	    { width: 15 },
	    { width: 12 },
	    { width: 32 },
	    { width: 32 },
	    { width: 15 },
	    { width: 15 }
	  ];

  Object.keys(data.lines).forEach(lineName => {
    const line = data.lines[lineName];
    const lineSheet = workbook.addWorksheet(lineName.substring(0, 31));
    
    let currentRow = 1;
    
	    lineSheet.mergeCells(`A${currentRow}:G${currentRow}`);
    const lineTitle = lineSheet.getCell(`A${currentRow}`);
    lineTitle.value = `PRODUCTION DETAIL - ${lineName} - ${date}`;
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
      
      lineSheet.getCell(`A${currentRow}`).value = 'Date';
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
          
          const selisihCell = row.getCell(4);
          if (selisih >= 0) {
            selisihCell.font = { color: { argb: '00B050' }, bold: true };
          } else {
            selisihCell.font = { color: { argb: 'FF0000' }, bold: true };
          }
          
	          const defectRateCell = row.getCell(7);
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

	      const defectDetailHeaders = ['Jam', 'Jenis Defect', 'Defect Area', 'Qty', 'Notes'];
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
	        row.values = ['-', '-', '-', 0, 'Tidak ada detail defect'];
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
	      { width: 18 }
	    ];
  });

  const performanceSheet = workbook.addWorksheet('PERFORMANCE');
  
  performanceSheet.mergeCells('A1:E1');
  const performanceTitle = performanceSheet.getCell('A1');
  performanceTitle.value = 'PERFORMANCE OVERVIEW - ' + date;
  performanceTitle.style = titleStyle;
  
  const performanceHeaders = ['Line', 'Total Target', 'Total Output', 'Achievement %', 'Overall Status'];
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
    const status = lineOutput >= lineTarget ? 'ON TARGET' : 'BELOW TARGET';
    
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
    if (status === 'ON TARGET') {
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
  const overallStatus = totalOutput >= totalTarget ? 'ON TARGET' : 'BELOW TARGET';
  
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

app.get('/api/export-date-report/:date', requireLogin, requireDateReportAccess, autoCheckDateReset, async (req, res) => {
  const date = req.params.date;
  
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Format tanggal tidak valid. Gunakan format: YYYY-MM-DD' });
  }
  
  try {
    const backupFile = path.join(__dirname, 'history', `data_${date}.json`);
    let data;
    
    if (fs.existsSync(backupFile)) {
      console.log(`📂 Mengambil data dari backup untuk export: ${backupFile}`);
      data = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    } else {
      console.log(`ℹ️ Backup tidak ditemukan, menggunakan data.json untuk export tanggal: ${date}`);
      data = readProductionData();
      
      const filteredLines = {};
      Object.keys(data.lines).forEach(lineName => {
        const line = data.lines[lineName];
        const filteredModels = {};
        
        Object.keys(line.models).forEach(modelId => {
          const model = line.models[modelId];
          if (model.date === date) {
            filteredModels[modelId] = model;
          }
        });
        
        if (Object.keys(filteredModels).length > 0) {
          filteredLines[lineName] = {
            ...line,
            models: filteredModels
          };
        }
      });
      
      data.lines = filteredLines;
    }
    
    const workbook = await generateStyledDateReportExcel(data, date);
    
    const downloadFilename = `Production_Report_${date}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    await workbook.xlsx.write(res);
    console.log(`✅ Export Excel dengan styling untuk tanggal ${date} berhasil`);
  } catch (error) {
    console.error('❌ Export date report error:', error);
    res.status(500).json({ error: 'Failed to export date report: ' + error.message });
  }
});

app.get('/api/users', requireLogin, requireAdmin, (req, res) => {
  const usersData = readUsersData();
  const usersWithoutPasswords = usersData.users.map(user => {
    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  });
  res.json(usersWithoutPasswords || []);
});

app.get('/api/operators/:lineName', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName } = req.params;
  const data = readProductionData();
  const active = getActiveModel(data, lineName);

  if (!active) {
    return res.status(404).json({ error: 'Line or active model not found' });
  }

  res.json(active.model.operators || []);
});

app.post('/api/operators/:lineName', requireLogin, requireLineManagementAccess, autoCheckDateReset, (req, res) => {
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
  writeProductionData(data);
  updateTodayBackup();

  res.json({ message: 'Operator created successfully', operator });
});

app.put('/api/operators/:lineName/:operatorId', requireLogin, requireLineManagementAccess, autoCheckDateReset, (req, res) => {
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
  writeProductionData(data);
  updateTodayBackup();

  res.json({ message: 'Operator updated successfully', operator: operators[operatorIndex] });
});

app.delete('/api/operators/:lineName/:operatorId', requireLogin, requireLineManagementAccess, autoCheckDateReset, (req, res) => {
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
  writeProductionData(data);
  updateTodayBackup();

  res.json({ message: 'Operator deleted successfully', operator });
});

app.get('/api/defect-config', requireLogin, (req, res) => {
  res.json(readDefectConfig());
});

app.get('/api/public-display-settings', (req, res) => {
  res.json(readPublicDisplaySettings());
});

app.put('/api/public-display-settings', requireLogin, requireAdmin, (req, res) => {
  const settings = writePublicDisplaySettings(req.body || {});
  res.json({ message: 'Public display settings updated successfully', settings });
});

app.get('/api/defect-types', requireLogin, (req, res) => {
  const config = readDefectConfig();
  res.json((config.defectTypes || []).filter(type => type.active !== false));
});

app.post('/api/defect-types', requireLogin, requireAdmin, (req, res) => {
  const { name, severity = 'minor', active = true } = req.body;
  const config = readDefectConfig();
  config.defectTypes = config.defectTypes || [];

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Defect type name is required' });
  }

  const defectType = { id: generateNumericId(config.defectTypes), name: name.trim(), severity: normalizeDefectSeverity(severity), active: Boolean(active) };
  config.defectTypes.push(defectType);
  writeDefectConfig(config);

  res.json({ message: 'Defect type created successfully', defectType });
});

app.put('/api/defect-types/:id', requireLogin, requireAdmin, (req, res) => {
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
  writeDefectConfig(config);

  res.json({ message: 'Defect type updated successfully', defectType });
});

app.delete('/api/defect-types/:id', requireLogin, requireAdmin, (req, res) => {
  const { id } = req.params;
  const config = readDefectConfig();
  const index = (config.defectTypes || []).findIndex(type => String(type.id) === String(id));

  if (index === -1) {
    return res.status(404).json({ error: 'Defect type not found' });
  }

  const [defectType] = config.defectTypes.splice(index, 1);
  writeDefectConfig(config);

  res.json({ message: 'Defect type deleted successfully', defectType });
});

app.get('/api/defect-areas', requireLogin, (req, res) => {
  const config = readDefectConfig();
  res.json((config.defectAreas || []).filter(area => area.active !== false));
});

app.post('/api/defect-areas', requireLogin, requireAdmin, (req, res) => {
  const { name, severity = 'minor', active = true } = req.body;
  const config = readDefectConfig();
  config.defectAreas = config.defectAreas || [];

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Defect area name is required' });
  }

  const defectArea = { id: generateNumericId(config.defectAreas), name: name.trim(), severity: normalizeDefectSeverity(severity), active: Boolean(active) };
  config.defectAreas.push(defectArea);
  writeDefectConfig(config);

  res.json({ message: 'Defect area created successfully', defectArea });
});

app.put('/api/defect-areas/:id', requireLogin, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { name, severity = 'minor', active = true } = req.body;
  const config = readDefectConfig();
  const defectArea = (config.defectAreas || []).find(area => String(area.id) === String(id));

  if (!defectArea) {
    return res.status(404).json({ error: 'Defect area not found' });
  }

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Defect area name is required' });
  }

  defectArea.name = name.trim();
  defectArea.severity = normalizeDefectSeverity(severity);
  defectArea.active = Boolean(active);
  writeDefectConfig(config);

  res.json({ message: 'Defect area updated successfully', defectArea });
});

app.delete('/api/defect-areas/:id', requireLogin, requireAdmin, (req, res) => {
  const { id } = req.params;
  const config = readDefectConfig();
  const index = (config.defectAreas || []).findIndex(area => String(area.id) === String(id));

  if (index === -1) {
    return res.status(404).json({ error: 'Defect area not found' });
  }

  const [defectArea] = config.defectAreas.splice(index, 1);
  writeDefectConfig(config);

  res.json({ message: 'Defect area deleted successfully', defectArea });
});

app.post('/api/users', requireLogin, requireAdmin, (req, res) => {
  const { username, password, name, line, role } = req.body;
  const usersData = readUsersData();

  if (usersData.users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  const newId = generateUserId(usersData.users);

  const newUser = {
    id: newId,
    username,
    password: hashPassword(password),
    name,
    line,
    role
  };

  usersData.users.push(newUser);
  writeUsersData(usersData);

  const { password: _, ...userWithoutPassword } = newUser;
  
  res.json({ 
    message: 'User created successfully',
    user: userWithoutPassword
  });
});

app.put('/api/users/:id', requireLogin, requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const { username, password, name, line, role } = req.body;
  const usersData = readUsersData();

  const userIndex = usersData.users.findIndex(u => u.id === userId);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (usersData.users.find(u => u.username === username && u.id !== userId)) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  usersData.users[userIndex] = {
    ...usersData.users[userIndex],
    username,
    name,
    line,
    role
  };

  if (password && password.trim() !== '') {
    usersData.users[userIndex].password = hashPassword(password);
  }

  writeUsersData(usersData);

  const { password: _, ...userWithoutPassword } = usersData.users[userIndex];
  
  res.json({ 
    message: 'User updated successfully',
    user: userWithoutPassword
  });
});

app.delete('/api/users/:id', requireLogin, requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const usersData = readUsersData();

  const userIndex = usersData.users.findIndex(u => u.id === userId);
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (req.session.user.id === userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  const deletedUser = usersData.users.splice(userIndex, 1)[0];
  writeUsersData(usersData);

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
  
	  summarySheet.mergeCells('A1:I1');
  const titleCell = summarySheet.getCell('A1');
  titleCell.value = 'PRODUCTION REPORT SUMMARY';
  titleCell.style = titleStyle;
  
  summarySheet.getCell('A3').value = 'Line';
  summarySheet.getCell('B3').value = lineName;
  summarySheet.getCell('A4').value = 'Model ID';
  summarySheet.getCell('B4').value = modelId;
  summarySheet.getCell('A5').value = 'Label/Week';
  summarySheet.getCell('B5').value = modelData.labelWeek || '';
  summarySheet.getCell('A6').value = 'Model';
  summarySheet.getCell('B6').value = modelData.model || '';
  summarySheet.getCell('A7').value = 'Date';
  summarySheet.getCell('B7').value = modelData.date || '';
  
	  const headers = ['Metric', 'Value', 'Target per Hour', 'Output/Hari', 'QC Checking', 'Actual Defect', 'Jenis Defect', 'Defect Area', 'Defect Rate (%)'];
	  summarySheet.getRow(9).values = headers;
  summarySheet.getRow(9).eachCell((cell) => {
    cell.style = headerStyle;
  });
  
	  const modelDefectCategories = summarizeModelDefectCategories(modelData);
	  
	  const dataRow1 = summarySheet.getRow(10);
	  dataRow1.values = [
	    'Production Data',
    modelData.target || 0,
    modelData.targetPerHour || 0,
	    modelData.outputDay || 0,
	    modelData.qcChecking || 0,
	    modelData.actualDefect || 0,
	    modelDefectCategories.types,
	    modelDefectCategories.areas,
	    (modelData.defectRatePercentage || 0) + '%'
	  ];
  dataRow1.eachCell((cell) => {
    cell.style = dataStyle;
  });
  
  const achievement = modelData.target > 0 ? ((modelData.outputDay || 0) / modelData.target * 100).toFixed(2) + '%' : '0%';
  
  const dataRow2 = summarySheet.getRow(11);
  dataRow2.values = [
    'Performance',
    achievement,
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
	    { width: 32 },
	    { width: 32 },
	    { width: 15 }
	  ];
  
  const hourlySheet = workbook.addWorksheet('HOURLY DATA');
  
	  hourlySheet.mergeCells('A1:I1');
  const hourlyTitle = hourlySheet.getCell('A1');
  hourlyTitle.value = 'HOURLY PRODUCTION DATA';
  hourlyTitle.style = titleStyle;
  
	  const hourlyHeaders = ['Jam', 'Target Manual', 'Output', 'Selisih (Output - Target)', 'Defect', 'Jenis Defect', 'Defect Area', 'QC Checked', 'Defect Rate (%)'];
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
	        defectRate + '%'
	      ];
      
      const selisihCell = row.getCell(4);
      if (selisih >= 0) {
        selisihCell.font = { color: { argb: '00B050' }, bold: true };
      } else {
        selisihCell.font = { color: { argb: 'FF0000' }, bold: true };
      }
      
	      const defectRateCell = row.getCell(9);
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

app.get('/api/export/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, async (req, res) => {
  const { lineName, modelId } = req.params;

  const data = readProductionData();
  
  if (!data.lines[lineName] || !data.lines[lineName].models[modelId]) {
    return res.status(404).json({ error: 'Line or model not found' });
  }

  const modelData = data.lines[lineName].models[modelId];

  try {
    const workbook = await generateStyledExcelData(modelData, lineName, modelId);
    
    const fileName = `Production_Report_${lineName}_${modelId}_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    await workbook.xlsx.write(res);
    console.log(`✅ Export Excel dengan styling untuk ${lineName}-${modelId} berhasil`);
  } catch (error) {
    console.error('❌ Export error:', error);
    res.status(500).json({ error: 'Failed to generate Excel file' });
  }
});

app.get('/api/export/:lineName', requireLogin, requireLineAccess, autoCheckDateReset, async (req, res) => {
  const { lineName } = req.params;
  const data = readProductionData();
  const active = getActiveModel(data, lineName);

  if (!active) {
    return res.status(404).json({ error: 'Line or active model not found' });
  }

  try {
    const workbook = await generateStyledExcelData(active.model, lineName, active.modelId);
    const fileName = `Production_Report_${lineName}_${active.modelId}_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to export data: ' + error.message });
  }
});

app.get('/api/public/line/:lineName', autoCheckDateReset, (req, res) => {
  const lineName = req.params.lineName;
  const data = readProductionData();
  
  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const activeModelId = data.lines[lineName].activeModel;
  if (!activeModelId || !data.lines[lineName].models[activeModelId]) {
    return res.status(404).json({ error: 'Active model not found' });
  }

  const modelData = data.lines[lineName].models[activeModelId];

  res.json(buildPublicModelResponse(modelData));
});

app.get('/api/public/line/:lineName/:modelId', autoCheckDateReset, (req, res) => {
  const { lineName, modelId } = req.params;
  const data = readProductionData();
  
  if (!data.lines[lineName] || !data.lines[lineName].models[modelId]) {
    return res.status(404).json({ error: 'Line or model not found' });
  }

  const modelData = data.lines[lineName].models[modelId];

  res.json(buildPublicModelResponse(modelData));
});

app.get('/public-display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public-display.html'));
});

// Frontend SPA routes. Legacy pages such as /admin, /leader, /line/:line,
// and /input/:line now use the Alpine/Tailwind dashboard entry point.
app.get(['/admin', '/leader', '/line/:lineName', '/input/:lineName'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function startServer() {
  await initSequelizeStorage();
  initializeDataFiles();

  // PERBAIKAN INTERVAL DAN STARTUP LOGIC
  setInterval(() => {
    const now = new Date();
    const today = getToday();
    console.log(`\nSystem check at: ${now.toLocaleString('id-ID')}, Date: ${today}`);
    
    // Cek dan reset data untuk hari baru
    const resetCount = checkAndResetDataForNewDay();
    if (resetCount > 0) {
      console.log(`Auto reset data selesai: ${resetCount} model direset`);
    }
    
    // Buat arsip backup setiap hari pada jam 00:01 WIB (17:01 UTC)
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    if (utcHours === 17 && utcMinutes === 1) { // 00:01 WIB = 17:01 UTC
      createArchiveBackup();
      console.log('Midnight archive backup executed');
    }
  }, 60000); // Check every minute

  // Check for date reset on startup dengan delay
  setTimeout(() => {
    const resetCount = checkAndResetDataForNewDay();
    if (resetCount > 0) {
      console.log(`Auto reset saat startup: ${resetCount} model direset`);
    }
  }, 10000); // Increase delay to 10 seconds

  // Initial backup dengan delay
  setTimeout(() => {
    // Update backup untuk hari ini
    updateTodayBackup();
    console.log('Today backup initialized');
    
    // Buat arsip backup awal
    createArchiveBackup();
    console.log('Initial archive backup completed');
  }, 15000);

  app.listen(port, () => {
  console.log(`=================================`);
  console.log(`🚀 Production Dashboard System`);
  console.log(`✅ Server berjalan di http://localhost:${port}`);
  console.log(`=================================`);
  console.log(`📋 FITUR UTAMA:`);
  console.log(`✅ Multi-Model Support per Line`);
  console.log(`✅ Manajemen Line, User, dan Operator`);
  console.log(`✅ Role: Admin, Admin Operator, Operator`);
  console.log(`✅ Input langsung di tabel Data Per Jam`);
  console.log(`✅ Target berdasarkan manual input`);
  console.log(`✅ AUTO RESET DATA SETIAP HARI BARU`);
  console.log(`✅ BACKUP REAL-TIME PER TANGGAL`);
  console.log(`✅ Satu file JSON per tanggal (data_YYYY-MM-DD.json)`);
  console.log(`✅ Arsip backup dengan timestamp di folder backups`);
  console.log(`✅ Laporan berdasarkan tanggal`);
  console.log(`✅ Backup dan History System`);
  console.log(`✅ Export Excel dengan styling`);
  console.log(`✅ Password encryption dengan SHA-256`);
  console.log(`✅ Unique user ID management`);
  console.log(`✅ Fitur pilih tanggal aktif`);
  console.log(`✅ Reset data operator setiap ganti hari`);
  console.log(`✅ Daily backup dan auto-sync tanggal`);
  console.log(`=================================`);
  console.log(`🌍 Timezone: Indonesia (WIB - UTC+7)`);
  console.log(`📅 Tanggal Hari Ini: ${getToday()}`);
  console.log(`=================================`);
  console.log(`👤 Default Users:`);
  console.log(`- Admin: admin / admin123`);
  console.log(`- Admin Operator: admin_operator / adminop123`);
  console.log(`- Operator: operator1 / password123`);
  console.log(`=================================`);
  });
}

startServer();
