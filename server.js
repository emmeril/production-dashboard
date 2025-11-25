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
      { hour: "17:00 - 18:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 }
    ],
    operators: line.operators ? line.operators.map(operator => ({
      ...operator,
      output: 0,
      defect: 0,
      efficiency: 0
    })) : []
  };
}

// Initialize data files
function initializeDataFiles() {
  if (!fs.existsSync(path.join(__dirname, 'data.json'))) {
    const today = getToday();
    const targetPerHour = Math.round(180 / 8);
    
    const initialData = {
      "lines": {
        "F1-5A": {
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
            { "hour": "17:00 - 18:00", "output": 0, "defect": 0, "qcChecked": 0, "targetManual": targetPerHour, "selisih": 0 }
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
      "activeLine": "F1-5A"
    };
    fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(initialData, null, 2));
    console.log('Data file created successfully with today\'s date:', today);
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

// Middleware untuk Admin dan Admin Operator
function requireAdminOrAdminOperator(req, res, next) {
  if (req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'admin_operator')) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Admin or Admin Operator access required' });
  }
}

// Middleware khusus untuk line management (admin dan admin_operator)
function requireLineManagementAccess(req, res, next) {
  if (req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'admin_operator')) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Line management access required' });
  }
}

// Middleware khusus untuk date reports (admin dan admin_operator)
function requireDateReportAccess(req, res, next) {
  if (req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'admin_operator')) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Date report access required' });
  }
}

// Middleware untuk mengakses line tertentu
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

// Update hourly data
app.post('/api/update-hourly/:lineName', requireLogin, requireLineAccess, (req, res) => {
  const lineName = req.params.lineName;
  const { hourIndex, output, defect, qcChecked, targetManual } = req.body;

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].hourly_data) {
    return res.status(404).json({ error: 'Line or hourly data not found' });
  }

  const selisih = parseInt(output) - parseInt(targetManual);

  data.lines[lineName].hourly_data[hourIndex] = {
    ...data.lines[lineName].hourly_data[hourIndex],
    output: parseInt(output),
    defect: parseInt(defect),
    qcChecked: parseInt(qcChecked),
    targetManual: parseInt(targetManual) || data.lines[lineName].hourly_data[hourIndex].targetManual,
    selisih: selisih
  };

  let totalOutput = 0;
  let totalDefect = 0;
  let totalQCChecked = 0;
  let totalTarget = 0;

  data.lines[lineName].hourly_data.forEach(hour => {
    totalOutput += hour.output || 0;
    totalDefect += hour.defect || 0;
    totalQCChecked += hour.qcChecked || 0;
    totalTarget += hour.targetManual || 0;
  });

  data.lines[lineName].outputDay = totalOutput;
  data.lines[lineName].actualDefect = totalDefect;
  data.lines[lineName].qcChecking = totalQCChecked;
  data.lines[lineName].target = totalTarget;

  const defectRatePercentage = (totalQCChecked > 0) ? (totalDefect / totalQCChecked) * 100 : 0;

  data.lines[lineName].defectRatePercentage = parseFloat(defectRatePercentage.toFixed(2));

  writeProductionData(data);
  res.json({
    message: 'Hourly data updated successfully.',
    data: data.lines[lineName],
    summary: {
      totalOutput: totalOutput,
      totalDefect: totalDefect,
      totalQCChecked: totalQCChecked,
      totalTarget: totalTarget,
      defectRate: defectRatePercentage.toFixed(2) + '%'
    }
  });
});

// Update target manual
app.post('/api/update-target-manual/:lineName', requireLogin, requireLineAccess, (req, res) => {
  const lineName = req.params.lineName;
  const { hourIndex, targetManual } = req.body;

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].hourly_data) {
    return res.status(404).json({ error: 'Line or hourly data not found' });
  }

  data.lines[lineName].hourly_data[hourIndex].targetManual = parseInt(targetManual);
  
  data.lines[lineName].hourly_data[hourIndex].selisih = 
    data.lines[lineName].hourly_data[hourIndex].output - parseInt(targetManual);

  let totalTarget = 0;
  data.lines[lineName].hourly_data.forEach(hour => {
    totalTarget += hour.targetManual || 0;
  });
  data.lines[lineName].target = totalTarget;

  writeProductionData(data);
  res.json({
    message: 'Target manual updated successfully.',
    data: data.lines[lineName].hourly_data[hourIndex],
    totalTarget: totalTarget
  });
});

// Update langsung data per jam dari tabel
app.post('/api/update-hourly-direct/:lineName', requireLogin, requireLineAccess, (req, res) => {
  const lineName = req.params.lineName;
  const { hourIndex, output, defect, qcChecked, targetManual } = req.body;

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].hourly_data) {
    return res.status(404).json({ error: 'Line or hourly data not found' });
  }

  const selisih = parseInt(output) - parseInt(targetManual);

  data.lines[lineName].hourly_data[hourIndex] = {
    ...data.lines[lineName].hourly_data[hourIndex],
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

  data.lines[lineName].hourly_data.forEach(hour => {
    totalOutput += hour.output || 0;
    totalDefect += hour.defect || 0;
    totalQCChecked += hour.qcChecked || 0;
    totalTarget += hour.targetManual || 0;
  });

  data.lines[lineName].outputDay = totalOutput;
  data.lines[lineName].actualDefect = totalDefect;
  data.lines[lineName].qcChecking = totalQCChecked;
  data.lines[lineName].target = totalTarget;

  const defectRatePercentage = (totalQCChecked > 0) ? (totalDefect / totalQCChecked) * 100 : 0;

  data.lines[lineName].defectRatePercentage = parseFloat(defectRatePercentage.toFixed(2));

  writeProductionData(data);
  res.json({
    message: 'Hourly data updated successfully.',
    data: data.lines[lineName],
    summary: {
      totalOutput: totalOutput,
      totalDefect: totalDefect,
      totalQCChecked: totalQCChecked,
      totalTarget: totalTarget,
      defectRate: defectRatePercentage.toFixed(2) + '%'
    }
  });
});

// History Data Routes - Hanya untuk admin
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
      ['Line', 'Label/Week', 'Model', 'Date', 'Target', 'Output', 'QC Checking', 'Actual Defect', 'Defect Rate%']
    ];

    Object.keys(historyData.lines).forEach(lineName => {
      const line = historyData.lines[lineName];
      summaryData.push([
        lineName,
        line.labelWeek,
        line.model,
        line.date,
        line.target,
        line.outputDay,
        line.qcChecking,
        line.actualDefect,
        line.defectRatePercentage
      ]);
    });

    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

    Object.keys(historyData.lines).forEach(lineName => {
      const line = historyData.lines[lineName];
      
      const lineData = [
        [`PRODUCTION REPORT - ${lineName}`],
        [],
        ['Label/Week', line.labelWeek],
        ['Model', line.model],
        ['Date', line.date],
        ['Target', line.target],
        ['Target per Hour', line.targetPerHour],
        ['Output/Hari', line.outputDay],
        ['QC Checking', line.qcChecking],
        ['Actual Defect', line.actualDefect],
        ['Defect Rate (%)', line.defectRatePercentage],
        [],
        ['HOURLY DATA'],
        ['Jam', 'Target Manual', 'Output', 'Selisih (Target - Output)', 'Defect', 'QC Checked', 'Defect Rate (%)']
      ];

      line.hourly_data.forEach(hour => {
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

      if (line.operators && line.operators.length > 0) {
        lineData.push([], ['OPERATOR DATA']);
        lineData.push(['No', 'Nama', 'Posisi', 'Target', 'Output', 'Defect', 'Efisiensi%', 'Status']);
        
        line.operators.forEach((operator, index) => {
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
      XLSX.utils.book_append_sheet(workbook, lineSheet, lineName);
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

// Manual backup endpoint - Hanya untuk admin
app.post('/api/backup/now', requireLogin, requireAdmin, (req, res) => {
  try {
    saveDailyBackup();
    res.json({ message: 'Backup created successfully' });
  } catch (error) {
    console.error('Error creating backup:', error);
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

// Sync dates endpoint - Hanya untuk admin
app.post('/api/sync-dates', requireLogin, requireAdmin, (req, res) => {
  const data = readProductionData();
  const today = getToday();
  let updatedLines = [];

  Object.keys(data.lines).forEach(lineName => {
    const line = data.lines[lineName];
    if (line.date !== today) {
      data.lines[lineName] = resetLineData({
        ...line,
        date: today
      });
      updatedLines.push(lineName);
    }
  });

  writeProductionData(data);
  res.json({ 
    message: `Sinkronisasi tanggal selesai`, 
    updatedLines: updatedLines,
    today: today
  });
});

// Line Management Routes - Untuk admin dan admin_operator
app.get('/api/lines', requireLogin, (req, res) => {
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

app.post('/api/lines', requireLogin, requireLineManagementAccess, (req, res) => {
  const { lineName, labelWeek, model, date, target } = req.body;
  const data = readProductionData();

  if (data.lines[lineName]) {
    return res.status(400).json({ error: 'Line already exists' });
  }

  const lineDate = date || getToday();
  const targetPerHour = Math.round(target / 8);

  data.lines[lineName] = {
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
      { hour: "17:00 - 18:00", output: 0, defect: 0, qcChecked: 0, targetManual: targetPerHour, selisih: 0 }
    ],
    operators: []
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

app.put('/api/lines/:lineName', requireLogin, requireLineManagementAccess, (req, res) => {
  const lineName = req.params.lineName;
  const { labelWeek, model, date } = req.body;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const oldDate = data.lines[lineName].date;
  const newDate = date || getToday();

  if (oldDate !== newDate) {
    data.lines[lineName] = resetLineData({
      ...data.lines[lineName],
      labelWeek,
      model,
      date: newDate
    });
  } else {
    data.lines[lineName].labelWeek = labelWeek;
    data.lines[lineName].model = model;
  }

  writeProductionData(data);
  res.json({ 
    message: `Line ${lineName} updated successfully`, 
    data: data.lines[lineName],
    reset: oldDate !== newDate ? 'Data telah direset karena perubahan tanggal.' : 'Tanggal tidak berubah, data tetap.'
  });
});

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

// Data Routes
app.get('/api/line/:lineName', requireLogin, requireLineAccess, (req, res) => {
  const lineName = req.params.lineName;
  const data = readProductionData();
  const lineData = data.lines[lineName];

  if (lineData) {
    res.json({ line: lineName, ...lineData });
  } else {
    res.status(404).json({ error: 'Line not found' });
  }
});

app.post('/api/update-line/:lineName', requireLogin, requireLineAccess, (req, res) => {
  const lineName = req.params.lineName;
  const newData = req.body;

  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  data.lines[lineName] = { ...data.lines[lineName], ...newData };

  const line = data.lines[lineName];
  const qcChecking = line.qcChecking || 0;
  const actualDefect = line.actualDefect || 0;

  let defectRatePercentage = (qcChecking > 0) ? (actualDefect / qcChecking) * 100 : 0;

  line.defectRatePercentage = parseFloat(defectRatePercentage.toFixed(2));

  writeProductionData(data);
  res.json({ message: `Line ${lineName} updated successfully.`, data: line });
});

// Date-based Report Routes - Untuk admin dan admin_operator
app.get('/api/date-report/:date', requireLogin, requireDateReportAccess, (req, res) => {
  const date = req.params.date;
  
  try {
    const backupFile = path.join(__dirname, 'history', `data_${date}.json`);
    let data;
    
    if (fs.existsSync(backupFile)) {
      data = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    } else {
      data = readProductionData();
      
      const filteredLines = {};
      Object.keys(data.lines).forEach(lineName => {
        if (data.lines[lineName].date === date) {
          filteredLines[lineName] = data.lines[lineName];
        }
      });
      
      data.lines = filteredLines;
    }
    
    const reportData = Object.keys(data.lines).map(lineName => {
      const line = data.lines[lineName];
      return {
        name: lineName,
        labelWeek: line.labelWeek,
        model: line.model,
        date: line.date,
        target: line.target,
        output: line.outputDay,
        defect: line.actualDefect,
        qcChecked: line.qcChecking,
        defectRate: line.defectRatePercentage.toFixed(2)
      };
    });
    
    res.json(reportData);
  } catch (error) {
    console.error('Error generating date report:', error);
    res.status(500).json({ error: 'Failed to generate date report' });
  }
});

app.get('/api/export-date-report/:date', requireLogin, requireDateReportAccess, (req, res) => {
  const date = req.params.date;
  
  try {
    const backupFile = path.join(__dirname, 'history', `data_${date}.json`);
    let data;
    
    if (fs.existsSync(backupFile)) {
      data = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    } else {
      data = readProductionData();
      
      const filteredLines = {};
      Object.keys(data.lines).forEach(lineName => {
        if (data.lines[lineName].date === date) {
          filteredLines[lineName] = data.lines[lineName];
        }
      });
      
      data.lines = filteredLines;
    }
    
    const workbook = XLSX.utils.book_new();
    
    const summaryData = [
      ['PRODUCTION REPORT SUMMARY'],
      ['Tanggal:', date],
      ['Generated at:', new Date().toLocaleString('id-ID')],
      [],
      ['Line', 'Label/Week', 'Model', 'Target', 'Output', 'Defect', 'QC Checked', 'Defect Rate%']
    ];

    Object.keys(data.lines).forEach(lineName => {
      const line = data.lines[lineName];
      summaryData.push([
        lineName,
        line.labelWeek,
        line.model,
        line.target,
        line.outputDay,
        line.actualDefect,
        line.qcChecking,
        line.defectRatePercentage + '%'
      ]);
    });

    const totalTarget = Object.values(data.lines).reduce((sum, line) => sum + line.target, 0);
    const totalOutput = Object.values(data.lines).reduce((sum, line) => sum + line.outputDay, 0);
    const totalDefect = Object.values(data.lines).reduce((sum, line) => sum + line.actualDefect, 0);
    const totalQCChecked = Object.values(data.lines).reduce((sum, line) => sum + line.qcChecking, 0);
    const avgDefectRate = totalQCChecked > 0 ? (totalDefect / totalQCChecked * 100).toFixed(2) : 0;

    summaryData.push([]);
    summaryData.push(['TOTAL', '', '', totalTarget, totalOutput, totalDefect, totalQCChecked, avgDefectRate + '%']);

    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

    Object.keys(data.lines).forEach(lineName => {
      const line = data.lines[lineName];
      
      const lineData = [
        [`PRODUCTION REPORT - ${lineName}`],
        [],
        ['Label/Week', line.labelWeek],
        ['Model', line.model],
        ['Date', line.date],
        ['Target', line.target],
        ['Output/Hari', line.outputDay],
        ['QC Checking', line.qcChecking],
        ['Actual Defect', line.actualDefect],
        ['Defect Rate (%)', line.defectRatePercentage],
        [],
        ['HOURLY DATA'],
        ['Jam', 'Target Manual', 'Output', 'Selisih (Target - Output)', 'Defect', 'QC Checked', 'Defect Rate (%)']
      ];

      line.hourly_data.forEach(hour => {
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

      const lineSheet = XLSX.utils.aoa_to_sheet(lineData);
      XLSX.utils.book_append_sheet(workbook, lineSheet, lineName);
    });

    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    const downloadFilename = `Production_Report_${date}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    res.send(excelBuffer);
  } catch (error) {
    console.error('Export date report error:', error);
    res.status(500).json({ error: 'Failed to export date report' });
  }
});

// User Management Routes - Hanya untuk admin
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
function generateExcelData(lineData, lineName) {
  const workbook = XLSX.utils.book_new();
  
  const summaryData = [
    ['PRODUCTION REPORT SUMMARY'],
    [],
    ['Line', lineName],
    ['Label/Week', lineData.labelWeek],
    ['Model', lineData.model],
    ['Date', lineData.date],
    ['Target', lineData.target],
    ['Target per Hour', lineData.targetPerHour],
    ['Output/Hari', lineData.outputDay],
    ['QC Checking', lineData.qcChecking],
    ['Actual Defect', lineData.actualDefect],
    ['Defect Rate (%)', lineData.defectRatePercentage],
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

  lineData.hourly_data.forEach(hour => {
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
  hourlyData.push(['TOTAL', lineData.target, lineData.outputDay, '', lineData.actualDefect, lineData.qcChecking, lineData.defectRatePercentage + '%']);
  
  const hourlySheet = XLSX.utils.aoa_to_sheet(hourlyData);
  XLSX.utils.book_append_sheet(workbook, hourlySheet, 'Hourly Data');
  
  if (lineData.operators && lineData.operators.length > 0) {
    const operatorData = [
      ['OPERATOR PERFORMANCE'],
      [],
      ['No', 'Nama Operator', 'Posisi', 'Target', 'Output', 'Defect', 'Efisiensi (%)', 'Status']
    ];
    
    lineData.operators.forEach((operator, index) => {
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

// Export Excel Endpoint
app.get('/api/export/:lineName', requireLogin, requireLineAccess, (req, res) => {
  const lineName = req.params.lineName;

  const data = readProductionData();
  const lineData = data.lines[lineName];

  if (!lineData) {
    return res.status(404).json({ error: 'Line not found' });
  }

  try {
    const workbook = generateExcelData(lineData, lineName);
    
    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    const fileName = `Production_Report_${lineName}_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    
    res.send(excelBuffer);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to generate Excel file' });
  }
});

// Page Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Schedule daily backup at midnight
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    saveDailyBackup();
  }
}, 60000);

// Initialize and Start Server
initializeDataFiles();

setTimeout(saveDailyBackup, 5000);

app.listen(port, () => {
  console.log(`=================================`);
  console.log(`Production Dashboard System`);
  console.log(`Server berjalan di http://localhost:${port}`);
  console.log(`=================================`);
  console.log(`Fitur yang tersedia:`);
  console.log(`- Manajemen Line, User, dan Operator`);
  console.log(`- Role: Admin, Admin Operator, Operator`);
  console.log(`- Input langsung di tabel Data Per Jam`);
  console.log(`- Target berdasarkan manual input`);
  console.log(`- Laporan berdasarkan tanggal`);
  console.log(`- Backup dan History System`);
  console.log(`- Export Excel`);
  console.log(`=================================`);
  console.log(`Default Users:`);
  console.log(`- Admin: admin / admin123`);
  console.log(`- Admin Operator: admin_operator / adminop123`);
  console.log(`- Operator: operator1 / password123`);
  console.log(`=================================`);
});