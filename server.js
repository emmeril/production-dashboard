const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const XLSX = require('xlsx');

const app = express();
const port = 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));

// Session middleware
app.use(session({
  secret: 'production-board-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Utility Functions
function getToday() {
  return new Date().toISOString().split('T')[0];
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

// PERBAIKAN: Fungsi untuk mengecek dan mereset data jika tanggal berubah
function checkAndResetDataForNewDay() {
  const data = readProductionData();
  const today = getToday();
  let resetCount = 0;

  Object.keys(data.lines).forEach(lineName => {
    const line = data.lines[lineName];
    Object.keys(line.models).forEach(modelId => {
      const model = line.models[modelId];
      if (model.date !== today) {
        console.log(`Reset data untuk line ${lineName}, model ${modelId} dari ${model.date} ke ${today}`);
        data.lines[lineName].models[modelId] = resetLineData({
          ...model,
          date: today
        });
        resetCount++;
      }
    });
  });

  if (resetCount > 0) {
    writeProductionData(data);
    console.log(`Auto-reset selesai: ${resetCount} model direset ke tanggal ${today}`);
  }

  return resetCount;
}

// Initialize data files
function initializeDataFiles() {
  if (!fs.existsSync(path.join(__dirname, 'data.json'))) {
    const today = getToday();
    const targetPerHour = Math.round(180 / 8);
    
    const initialData = {
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
                { "hour": "07:00 - 08:00", "output": 0, "defect": 0, "qcChecked": 0, "targetManual": targetPerHour, "selisih": 0 },
                { "hour": "08:00 - 09:00", "output": 0, "defect": 0, "qcChecked": 0, "targetManual": targetPerHour, "selisih": 0 },
                { "hour": "09:00 - 10:00", "output": 0, "defect": 0, "qcChecked": 0, "targetManual": targetPerHour, "selisih": 0 },
                { "hour": "10:00 - 11:00", "output": 0, "defect": 0, "qcChecked": 0, "targetManual": targetPerHour, "selisih": 0 },
                { "hour": "11:00 - 13:00", "output": 0, "defect": 0, "qcChecked": 0, "targetManual": 0, "selisih": 0 },
                { "hour": "13:00 - 14:00", "output": 0, "defect": 0, "qcChecked": 0, "targetManual": targetPerHour, "selisih": 0 },
                { "hour": "14:00 - 15:00", "output": 0, "defect": 0, "qcChecked": 0, "targetManual": targetPerHour, "selisih": 0 },
                { "hour": "15:00 - 16:00", "output": 0, "defect": 0, "qcChecked": 0, "targetManual": targetPerHour, "selisih": 0 },
                { "hour": "16:00 - 17:00", "output": 0, "defect": 0, "qcChecked": 0, "targetManual": targetPerHour, "selisih": 0 },
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
    fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(initialData, null, 2));
    console.log('Data file created successfully with multi-model support');
  }

  if (!fs.existsSync(path.join(__dirname, 'users.json'))) {
    const initialUsers = {
      "users": [
        {
          "id": 1,
          "username": "operator1",
          "password": "password123",
          "name": "Ahmad Susanto",
          "line": "F1-5A",
          "role": "operator"
        },
        {
          "id": 2,
          "username": "admin_operator",
          "password": "adminop123",
          "name": "Admin Operator",
          "line": "all",
          "role": "admin_operator"
        },
        {
          "id": 3,
          "username": "admin",
          "password": "admin123",
          "name": "Administrator",
          "line": "all",
          "role": "admin"
        }
      ]
    };
    fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(initialUsers, null, 2));
    console.log('Users file created successfully');
  }

  const historyDir = path.join(__dirname, 'history');
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir);
    console.log('History directory created successfully');
  }
}

function readProductionData() {
  try {
    const data = fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('ERROR: Gagal membaca data.json:', error.message);
    return { lines: {}, activeLine: '' };
  }
}

function writeProductionData(data) {
  try {
    fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('ERROR: Gagal menulis ke data.json:', error.message);
  }
}

function readUsersData() {
  try {
    const data = fs.readFileSync(path.join(__dirname, 'users.json'), 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('ERROR: Gagal membaca users.json:', error.message);
    return { users: [] };
  }
}

// History Functions
function saveDailyBackup() {
  try {
    const data = readProductionData();
    const today = new Date().toISOString().split('T')[0];
    const backupFile = path.join(__dirname, 'history', `data_${today}.json`);
    
    fs.writeFileSync(backupFile, JSON.stringify(data, null, 2));
    console.log(`Daily backup saved: data_${today}.json`);
  } catch (error) {
    console.error('Error saving daily backup:', error);
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
    console.error('Error reading history files:', error);
    return [];
  }
}

function readHistoryData(filename) {
  try {
    const filePath = path.join(__dirname, 'history', filename);
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading history file:', error);
    return null;
  }
}

// Authentication Middleware
function requireLogin(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized - Please login' });
  }
}

function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Admin access required' });
  }
}

function requireAdminOrAdminOperator(req, res, next) {
  if (req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'admin_operator')) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Admin or Admin Operator access required' });
  }
}

function requireLineManagementAccess(req, res, next) {
  if (req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'admin_operator')) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Line management access required' });
  }
}

function requireDateReportAccess(req, res, next) {
  if (req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'admin_operator')) {
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

// PERBAIKAN: Middleware untuk auto-check dan reset data setiap kali ada request ke data lines
function autoCheckDateReset(req, res, next) {
  // Jalankan pengecekan dan reset data untuk tanggal baru
  checkAndResetDataForNewDay();
  next();
}

// Authentication Routes
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const usersData = readUsersData();
  const user = usersData.users.find(u => u.username === username && u.password === password);

  if (user) {
    req.session.user = user;
    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        line: user.line,
        role: user.role
      }
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

// Update hourly data - DITAMBAHKAN autoCheckDateReset
app.post('/api/update-hourly/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName, modelId } = req.params;
  const { hourIndex, output, defect, qcChecked, targetManual } = req.body;

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
    return res.status(404).json({ error: 'Line, model or hourly data not found' });
  }

  const selisih = parseInt(output) - parseInt(targetManual);

  data.lines[lineName].models[modelId].hourly_data[hourIndex] = {
    ...data.lines[lineName].models[modelId].hourly_data[hourIndex],
    output: parseInt(output),
    defect: parseInt(defect),
    qcChecked: parseInt(qcChecked),
    targetManual: parseInt(targetManual) || data.lines[lineName].models[modelId].hourly_data[hourIndex].targetManual,
    selisih: selisih
  };

  let totalOutput = 0;
  let totalDefect = 0;
  let totalQCChecked = 0;
  let totalTarget = 0;

  data.lines[lineName].models[modelId].hourly_data.forEach(hour => {
    totalOutput += hour.output || 0;
    totalDefect += hour.defect || 0;
    totalQCChecked += hour.qcChecked || 0;
    totalTarget += hour.targetManual || 0;
  });

  data.lines[lineName].models[modelId].outputDay = totalOutput;
  data.lines[lineName].models[modelId].actualDefect = totalDefect;
  data.lines[lineName].models[modelId].qcChecking = totalQCChecked;
  data.lines[lineName].models[modelId].target = totalTarget;

  const defectRatePercentage = (totalQCChecked > 0) ? (totalDefect / totalQCChecked) * 100 : 0;

  data.lines[lineName].models[modelId].defectRatePercentage = parseFloat(defectRatePercentage.toFixed(2));

  writeProductionData(data);
  res.json({
    message: 'Hourly data updated successfully.',
    data: data.lines[lineName].models[modelId],
    summary: {
      totalOutput: totalOutput,
      totalDefect: totalDefect,
      totalQCChecked: totalQCChecked,
      totalTarget: totalTarget,
      defectRate: defectRatePercentage.toFixed(2) + '%'
    }
  });
});

// Update target manual - DITAMBAHKAN autoCheckDateReset
app.post('/api/update-target-manual/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName, modelId } = req.params;
  const { hourIndex, targetManual } = req.body;

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
    return res.status(404).json({ error: 'Line, model or hourly data not found' });
  }

  data.lines[lineName].models[modelId].hourly_data[hourIndex].targetManual = parseInt(targetManual);
  
  data.lines[lineName].models[modelId].hourly_data[hourIndex].selisih = 
    data.lines[lineName].models[modelId].hourly_data[hourIndex].output - parseInt(targetManual);

  let totalTarget = 0;
  data.lines[lineName].models[modelId].hourly_data.forEach(hour => {
    totalTarget += hour.targetManual || 0;
  });
  data.lines[lineName].models[modelId].target = totalTarget;

  writeProductionData(data);
  res.json({
    message: 'Target manual updated successfully.',
    data: data.lines[lineName].models[modelId].hourly_data[hourIndex],
    totalTarget: totalTarget
  });
});

// Update langsung data per jam dari tabel - DITAMBAHKAN autoCheckDateReset
app.post('/api/update-hourly-direct/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName, modelId } = req.params;
  const { hourIndex, output, defect, qcChecked, targetManual } = req.body;

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
    return res.status(404).json({ error: 'Line, model or hourly data not found' });
  }

  const selisih = parseInt(output) - parseInt(targetManual);

  data.lines[lineName].models[modelId].hourly_data[hourIndex] = {
    ...data.lines[lineName].models[modelId].hourly_data[hourIndex],
    output: parseInt(output),
    defect: parseInt(defect),
    qcChecked: parseInt(qcChecked),
    targetManual: parseInt(targetManual),
    selisih: selisih
  };

  let totalOutput = 0;
  let totalDefect = 0;
  let totalQCChecked = 0;
  let totalTarget = 0;

  data.lines[lineName].models[modelId].hourly_data.forEach(hour => {
    totalOutput += hour.output || 0;
    totalDefect += hour.defect || 0;
    totalQCChecked += hour.qcChecked || 0;
    totalTarget += hour.targetManual || 0;
  });

  data.lines[lineName].models[modelId].outputDay = totalOutput;
  data.lines[lineName].models[modelId].actualDefect = totalDefect;
  data.lines[lineName].models[modelId].qcChecking = totalQCChecked;
  data.lines[lineName].models[modelId].target = totalTarget;

  const defectRatePercentage = (totalQCChecked > 0) ? (totalDefect / totalQCChecked) * 100 : 0;

  data.lines[lineName].models[modelId].defectRatePercentage = parseFloat(defectRatePercentage.toFixed(2));

  writeProductionData(data);
  res.json({
    message: 'Hourly data updated successfully.',
    data: data.lines[lineName].models[modelId],
    summary: {
      totalOutput: totalOutput,
      totalDefect: totalDefect,
      totalQCChecked: totalQCChecked,
      totalTarget: totalTarget,
      defectRate: defectRatePercentage.toFixed(2) + '%'
    }
  });
});

// History Data Routes
app.get('/api/history/files', requireLogin, requireAdmin, (req, res) => {
  try {
    const historyFiles = getHistoryFiles();
    res.json(historyFiles);
  } catch (error) {
    console.error('Error getting history files:', error);
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
    console.error('Error reading history file:', error);
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
    console.error('Export history error:', error);
    res.status(500).json({ error: 'Failed to export history data' });
  }
});

// Manual backup endpoint
app.post('/api/backup/now', requireLogin, requireAdmin, (req, res) => {
  try {
    saveDailyBackup();
    res.json({ message: 'Backup created successfully' });
  } catch (error) {
    console.error('Error creating backup:', error);
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

// Sync dates endpoint - DIPERBAIKI untuk auto reset data
app.post('/api/sync-dates', requireLogin, requireAdmin, (req, res) => {
  const resetCount = checkAndResetDataForNewDay();
  const today = getToday();
  
  res.json({ 
    message: `Sinkronisasi tanggal selesai. ${resetCount} model direset ke tanggal ${today}`,
    resetCount: resetCount,
    today: today
  });
});

// Line Management Routes - DITAMBAHKAN autoCheckDateReset
app.get('/api/lines', requireLogin, autoCheckDateReset, (req, res) => {
  const user = req.session.user;
  const data = readProductionData();
  
  if (user.role === 'admin' || user.role === 'admin_operator') {
    return res.json(data.lines || {});
  }
  
  if (user.role === 'operator') {
    const operatorLine = {};
    if (data.lines[user.line]) {
      operatorLine[user.line] = data.lines[user.line];
    }
    return res.json(operatorLine);
  }
  
  res.status(403).json({ error: 'Access denied' });
});

// Get models for a specific line - DITAMBAHKAN autoCheckDateReset
app.get('/api/lines/:lineName/models', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName } = req.params;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  res.json(data.lines[lineName].models || {});
});

// Create new line - PERBAIKAN: Selalu gunakan tanggal sekarang
app.post('/api/lines', requireLogin, requireLineManagementAccess, (req, res) => {
  const { lineName, labelWeek, model, target } = req.body;
  const data = readProductionData();

  if (data.lines[lineName]) {
    return res.status(400).json({ error: 'Line already exists' });
  }

  const lineDate = getToday(); // SELALU gunakan tanggal sekarang
  const targetPerHour = Math.round(target / 8);
  const modelId = 'model1'; // Default first model

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
  res.json({ 
    message: `Line ${lineName} created successfully`, 
    data: data.lines[lineName],
    calculated: {
      targetPerHour: targetPerHour,
      message: `Target per jam: ${targetPerHour} unit (Target: ${target} ÷ 8 jam efektif)`
    }
  });
});

// Add new model to existing line - PERBAIKAN: Selalu gunakan tanggal sekarang
app.post('/api/lines/:lineName/models', requireLogin, requireLineManagementAccess, (req, res) => {
  const { lineName } = req.params;
  const { labelWeek, model, target } = req.body;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const lineDate = getToday(); // SELALU gunakan tanggal sekarang
  const targetPerHour = Math.round(target / 8);
  
  // Generate new model ID
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
  res.json({ 
    message: `Model ${modelId} added to line ${lineName} successfully`, 
    data: data.lines[lineName].models[modelId],
    modelId: modelId
  });
});

// Update line or model - PERBAIKAN: Tidak bisa mengedit tanggal
app.put('/api/lines/:lineName', requireLogin, requireLineManagementAccess, autoCheckDateReset, (req, res) => {
  const lineName = req.params.lineName;
  const { labelWeek, model, target, modelId } = req.body;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const targetModelId = modelId || data.lines[lineName].activeModel;
  if (!data.lines[lineName].models[targetModelId]) {
    return res.status(404).json({ error: 'Model not found' });
  }

  const newTarget = parseInt(target);

  // Update tanpa mengubah tanggal (tanggal tidak bisa diubah)
  data.lines[lineName].models[targetModelId].labelWeek = labelWeek;
  data.lines[lineName].models[targetModelId].model = model;
  data.lines[lineName].models[targetModelId].target = newTarget;
  data.lines[lineName].models[targetModelId].targetPerHour = Math.round(newTarget / 8);

  // Update targetManual untuk semua jam (kecuali jam istirahat)
  data.lines[lineName].models[targetModelId].hourly_data.forEach(hour => {
    if (hour.hour !== "11:00 - 13:00") {
      hour.targetManual = data.lines[lineName].models[targetModelId].targetPerHour;
      hour.selisih = hour.output - hour.targetManual;
    }
  });

  // Hitung ulang total target dari targetManual
  let totalTarget = 0;
  data.lines[lineName].models[targetModelId].hourly_data.forEach(hour => {
    totalTarget += hour.targetManual || 0;
  });
  data.lines[lineName].models[targetModelId].target = totalTarget;

  writeProductionData(data);
  res.json({ 
    message: `Model ${targetModelId} in line ${lineName} updated successfully`, 
    data: data.lines[lineName].models[targetModelId]
  });
});

// Delete model from line
app.delete('/api/lines/:lineName/models/:modelId', requireLogin, requireLineManagementAccess, (req, res) => {
  const { lineName, modelId } = req.params;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  if (!data.lines[lineName].models[modelId]) {
    return res.status(404).json({ error: 'Model not found' });
  }

  // Cannot delete the last model
  if (Object.keys(data.lines[lineName].models).length === 1) {
    return res.status(400).json({ error: 'Cannot delete the last model in a line' });
  }

  delete data.lines[lineName].models[modelId];

  // If deleted model was active, set another model as active
  if (data.lines[lineName].activeModel === modelId) {
    const remainingModels = Object.keys(data.lines[lineName].models);
    data.lines[lineName].activeModel = remainingModels[0];
  }

  writeProductionData(data);
  res.json({ message: `Model ${modelId} deleted from line ${lineName} successfully` });
});

// Delete entire line
app.delete('/api/lines/:lineName', requireLogin, requireLineManagementAccess, (req, res) => {
  const lineName = req.params.lineName;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  delete data.lines[lineName];
  writeProductionData(data);
  res.json({ message: `Line ${lineName} deleted successfully` });
});

// Set active model for a line - DITAMBAHKAN autoCheckDateReset
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
  res.json({ 
    message: `Active model for line ${lineName} set to ${modelId}`,
    activeModel: modelId
  });
});

// Data Routes - DITAMBAHKAN autoCheckDateReset
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

// Get active model for a line - DITAMBAHKAN autoCheckDateReset
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
  res.json({ message: `Model ${modelId} in line ${lineName} updated successfully.`, data: model });
});

// Date-based Report Routes - DITAMBAHKAN autoCheckDateReset
app.get('/api/date-report/:date', requireLogin, requireDateReportAccess, autoCheckDateReset, (req, res) => {
  const date = req.params.date;
  
  // Validasi format tanggal
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Format tanggal tidak valid. Gunakan format: YYYY-MM-DD' });
  }
  
  try {
    // Coba baca dari backup terlebih dahulu
    const backupFile = path.join(__dirname, 'history', `data_${date}.json`);
    let data;
    
    if (fs.existsSync(backupFile)) {
      console.log(`Mengambil data dari backup: ${backupFile}`);
      data = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    } else {
      console.log(`Backup tidak ditemukan, menggunakan data.json untuk tanggal: ${date}`);
      data = readProductionData();
      
      // Filter data berdasarkan tanggal
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
    
    // Format data untuk response
    const reportData = [];
    Object.keys(data.lines).forEach(lineName => {
      const line = data.lines[lineName];
      Object.keys(line.models).forEach(modelId => {
        const model = line.models[modelId];
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
      });
    });
    
    console.log(`Laporan tanggal ${date} berhasil dibuat. Jumlah data: ${reportData.length}`);
    res.json(reportData);
  } catch (error) {
    console.error('Error generating date report:', error);
    res.status(500).json({ error: 'Failed to generate date report: ' + error.message });
  }
});

// Export Date Report - DITAMBAHKAN autoCheckDateReset
app.get('/api/export-date-report/:date', requireLogin, requireDateReportAccess, autoCheckDateReset, (req, res) => {
  const date = req.params.date;
  
  // Validasi format tanggal
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Format tanggal tidak valid. Gunakan format: YYYY-MM-DD' });
  }
  
  try {
    // Coba baca dari backup terlebih dahulu
    const backupFile = path.join(__dirname, 'history', `data_${date}.json`);
    let data;
    
    if (fs.existsSync(backupFile)) {
      console.log(`Mengambil data dari backup untuk export: ${backupFile}`);
      data = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    } else {
      console.log(`Backup tidak ditemukan, menggunakan data.json untuk export tanggal: ${date}`);
      data = readProductionData();
      
      // Filter data berdasarkan tanggal
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
    
    // Buat workbook Excel
    const workbook = XLSX.utils.book_new();
    
    // Sheet Summary
    const summaryData = [
      ['PRODUCTION REPORT SUMMARY'],
      ['Tanggal:', date],
      ['Generated at:', new Date().toLocaleString('id-ID')],
      [],
      ['Line', 'Model ID', 'Label/Week', 'Model', 'Target', 'Output', 'Defect', 'QC Checked', 'Defect Rate%']
    ];

    let totalTarget = 0;
    let totalOutput = 0;
    let totalDefect = 0;
    let totalQCChecked = 0;

    Object.keys(data.lines).forEach(lineName => {
      const line = data.lines[lineName];
      Object.keys(line.models).forEach(modelId => {
        const model = line.models[modelId];
        const target = model.target || 0;
        const output = model.outputDay || 0;
        const defect = model.actualDefect || 0;
        const qcChecked = model.qcChecking || 0;
        const defectRate = model.defectRatePercentage || 0;
        
        summaryData.push([
          lineName,
          modelId,
          model.labelWeek || '',
          model.model || '',
          target,
          output,
          defect,
          qcChecked,
          defectRate + '%'
        ]);
        
        totalTarget += target;
        totalOutput += output;
        totalDefect += defect;
        totalQCChecked += qcChecked;
      });
    });

    // Tambahkan total
    summaryData.push([]);
    summaryData.push(['TOTAL', '', '', '', totalTarget, totalOutput, totalDefect, totalQCChecked, '']);
    
    const totalDefectRate = totalQCChecked > 0 ? ((totalDefect / totalQCChecked) * 100).toFixed(2) : 0;
    summaryData.push(['', '', '', '', '', '', '', 'Defect Rate Total:', totalDefectRate + '%']);

    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

    // Sheet untuk setiap line dan model
    Object.keys(data.lines).forEach(lineName => {
      const line = data.lines[lineName];
      
      Object.keys(line.models).forEach(modelId => {
        const model = line.models[modelId];
        
        const lineData = [
          [`PRODUCTION REPORT - ${lineName} - ${modelId}`],
          [],
          ['Label/Week', model.labelWeek || ''],
          ['Model', model.model || ''],
          ['Date', model.date || ''],
          ['Target', model.target || 0],
          ['Output/Hari', model.outputDay || 0],
          ['QC Checking', model.qcChecking || 0],
          ['Actual Defect', model.actualDefect || 0],
          ['Defect Rate (%)', (model.defectRatePercentage || 0) + '%'],
          [],
          ['HOURLY DATA'],
          ['Jam', 'Target Manual', 'Output', 'Selisih (Target - Output)', 'Defect', 'QC Checked', 'Defect Rate (%)']
        ];

        if (model.hourly_data && model.hourly_data.length > 0) {
          model.hourly_data.forEach(hour => {
            const defectRate = hour.qcChecked > 0 ? ((hour.defect / hour.qcChecked) * 100).toFixed(2) : '0.00';
            const selisih = (hour.targetManual || 0) - (hour.output || 0);
            lineData.push([
              hour.hour, 
              hour.targetManual || 0,
              hour.output || 0, 
              selisih,
              hour.defect || 0, 
              hour.qcChecked || 0, 
              defectRate + '%'
            ]);
          });
        } else {
          lineData.push(['Tidak ada data hourly']);
        }

        // Batasi panjang nama sheet (max 31 karakter untuk Excel)
        const sheetName = `${lineName}_${modelId}`.substring(0, 31);
        const lineSheet = XLSX.utils.aoa_to_sheet(lineData);
        XLSX.utils.book_append_sheet(workbook, lineSheet, sheetName);
      });
    });

    // Kirim file Excel
    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    const downloadFilename = `Production_Report_${date}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    res.send(excelBuffer);
    console.log(`Export Excel untuk tanggal ${date} berhasil`);
  } catch (error) {
    console.error('Export date report error:', error);
    res.status(500).json({ error: 'Failed to export date report: ' + error.message });
  }
});

// User Management Routes
app.get('/api/users', requireLogin, requireAdmin, (req, res) => {
  const usersData = readUsersData();
  res.json(usersData.users || []);
});

app.post('/api/users', requireLogin, requireAdmin, (req, res) => {
  const { username, password, name, line, role } = req.body;
  const usersData = readUsersData();

  if (usersData.users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  const newUser = {
    id: usersData.users.length + 1,
    username,
    password,
    name,
    line,
    role
  };

  usersData.users.push(newUser);
  fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(usersData, null, 2));

  res.json({ 
    message: 'User created successfully',
    user: newUser
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
    ...(password && { password }),
    name,
    line,
    role
  };

  fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(usersData, null, 2));

  res.json({ 
    message: 'User updated successfully',
    user: usersData.users[userIndex]
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
  fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(usersData, null, 2));

  res.json({ 
    message: 'User deleted successfully',
    user: deletedUser
  });
});

// Export Excel Function
function generateExcelData(modelData, lineName, modelId) {
  const workbook = XLSX.utils.book_new();
  
  const summaryData = [
    ['PRODUCTION REPORT SUMMARY'],
    [],
    ['Line', lineName],
    ['Model ID', modelId],
    ['Label/Week', modelData.labelWeek],
    ['Model', modelData.model],
    ['Date', modelData.date],
    ['Target', modelData.target],
    ['Target per Hour', modelData.targetPerHour],
    ['Output/Hari', modelData.outputDay],
    ['QC Checking', modelData.qcChecking],
    ['Actual Defect', modelData.actualDefect],
    ['Defect Rate (%)', modelData.defectRatePercentage],
    [],
    ['Generated at', new Date().toLocaleString('id-ID')]
  ];
  
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');
  
  const hourlyData = [
    ['HOURLY PRODUCTION DATA'],
    [],
    ['Jam', 'Target Manual', 'Output', 'Selisih (Target - Output)', 'Defect', 'QC Checked', 'Defect Rate (%)']
  ];

  modelData.hourly_data.forEach(hour => {
    const defectRate = hour.qcChecked > 0 ? ((hour.defect / hour.qcChecked) * 100).toFixed(2) : '0.00';
    const selisih = hour.targetManual - hour.output;
    hourlyData.push([
      hour.hour, 
      hour.targetManual,
      hour.output, 
      selisih,
      hour.defect, 
      hour.qcChecked, 
      defectRate
    ]);
  });
  
  hourlyData.push([]);
  hourlyData.push(['TOTAL', modelData.target, modelData.outputDay, '', modelData.actualDefect, modelData.qcChecking, modelData.defectRatePercentage + '%']);
  
  const hourlySheet = XLSX.utils.aoa_to_sheet(hourlyData);
  XLSX.utils.book_append_sheet(workbook, hourlySheet, 'Hourly Data');
  
  if (modelData.operators && modelData.operators.length > 0) {
    const operatorData = [
      ['OPERATOR PERFORMANCE'],
      [],
      ['No', 'Nama Operator', 'Posisi', 'Target', 'Output', 'Defect', 'Efisiensi (%)', 'Status']
    ];
    
    modelData.operators.forEach((operator, index) => {
      operatorData.push([
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
    
    const operatorSheet = XLSX.utils.aoa_to_sheet(operatorData);
    XLSX.utils.book_append_sheet(workbook, operatorSheet, 'Operator Data');
  }
  
  return workbook;
}

// Export Excel Endpoint - DITAMBAHKAN autoCheckDateReset
app.get('/api/export/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, (req, res) => {
  const { lineName, modelId } = req.params;

  const data = readProductionData();
  
  if (!data.lines[lineName] || !data.lines[lineName].models[modelId]) {
    return res.status(404).json({ error: 'Line or model not found' });
  }

  const modelData = data.lines[lineName].models[modelId];

  try {
    const workbook = generateExcelData(modelData, lineName, modelId);
    
    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    const fileName = `Production_Report_${lineName}_${modelId}_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    res.send(excelBuffer);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to generate Excel file' });
  }
});

// Public API Routes (No authentication required) - DITAMBAHKAN autoCheckDateReset
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
  
  // Hitung target per jam jika belum ada
  if (!modelData.targetPerHour) {
    modelData.targetPerHour = Math.round(modelData.target / 8);
  }
  
  res.json(modelData);
});

app.get('/api/public/line/:lineName/:modelId', autoCheckDateReset, (req, res) => {
  const { lineName, modelId } = req.params;
  const data = readProductionData();
  
  if (!data.lines[lineName] || !data.lines[lineName].models[modelId]) {
    return res.status(404).json({ error: 'Line or model not found' });
  }

  const modelData = data.lines[lineName].models[modelId];
  
  // Hitung target per jam jika belum ada
  if (!modelData.targetPerHour) {
    modelData.targetPerHour = Math.round(modelData.target / 8);
  }
  
  res.json(modelData);
});

// Route untuk halaman public display
app.get('/public-display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public-display.html'));
});

// Page Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// PERBAIKAN: Schedule daily backup dan auto reset data
setInterval(() => {
  const now = new Date();
  
  // Backup setiap jam 23:59
  if (now.getHours() === 23 && now.getMinutes() === 59) {
    saveDailyBackup();
    console.log('Auto backup dijalankan');
  }
  
  // Auto reset data setiap hari jam 00:01
  if (now.getHours() === 0 && now.getMinutes() === 1) {
    const resetCount = checkAndResetDataForNewDay();
    if (resetCount > 0) {
      console.log(`Auto reset data selesai: ${resetCount} model direset`);
    }
  }
}, 60000); // Cek setiap menit

// Initialize and Start Server
initializeDataFiles();

// Jalankan pengecekan dan reset data saat server start
setTimeout(() => {
  const resetCount = checkAndResetDataForNewDay();
  if (resetCount > 0) {
    console.log(`Auto reset saat startup: ${resetCount} model direset`);
  }
}, 2000);

setTimeout(saveDailyBackup, 5000);

app.listen(port, () => {
  console.log(`=================================`);
  console.log(`Production Dashboard System`);
  console.log(`Server berjalan di http://localhost:${port}`);
  console.log(`=================================`);
  console.log(`Fitur yang tersedia:`);
  console.log(`- Multi-Model Support per Line`);
  console.log(`- Manajemen Line, User, dan Operator`);
  console.log(`- Role: Admin, Admin Operator, Operator`);
  console.log(`- Input langsung di tabel Data Per Jam`);
  console.log(`- Target berdasarkan manual input`);
  console.log(`- AUTO RESET DATA SETIAP HARI BARU`);
  console.log(`- Laporan berdasarkan tanggal (FIXED)`);
  console.log(`- Backup dan History System`);
  console.log(`- Export Excel`);
  console.log(`=================================`);
  console.log(`Default Users:`);
  console.log(`- Admin: admin / admin123`);
  console.log(`- Admin Operator: admin_operator / adminop123`);
  console.log(`- Operator: operator1 / password123`);
  console.log(`=================================`);
});