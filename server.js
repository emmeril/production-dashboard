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
app.use(express.static('public'));

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
  const targetPerHour = Math.round(line.target / 8); // 8 jam kerja efektif
  
  return {
    ...line,
    outputDay: 0,
    qcChecking: 0,
    actualDefect: 0,
    defectRatePercentage: 0,
    hourly_data: [
      // Jam kerja pagi (4 jam)
      { hour: "07:00 - 08:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 1 },
      { hour: "08:00 - 09:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 2 },
      { hour: "09:00 - 10:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 3 },
      { hour: "10:00 - 11:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 4 },
      
      // Istirahat panjang 11:00-13:00 (2 jam) - cumulative target tetap sama
      { hour: "11:00 - 13:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 4 },
      
      // Jam kerja siang (4 jam)
      { hour: "13:00 - 14:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 5 },
      { hour: "14:00 - 15:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 6 },
      { hour: "15:00 - 16:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 7 },
      { hour: "16:00 - 17:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 8 },
      
      // Overtime atau jam tambahan - cumulative target tetap maksimal
      { hour: "17:00 - 18:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 8 }
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
  // Initialize data.json if doesn't exist
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
            { "hour": "07:00 - 08:00", "output": 0, "defect": 0, "qcChecked": 0, "cumulativeTarget": targetPerHour * 1 },
            { "hour": "08:00 - 09:00", "output": 0, "defect": 0, "qcChecked": 0, "cumulativeTarget": targetPerHour * 2 },
            { "hour": "09:00 - 10:00", "output": 0, "defect": 0, "qcChecked": 0, "cumulativeTarget": targetPerHour * 3 },
            { "hour": "10:00 - 11:00", "output": 0, "defect": 0, "qcChecked": 0, "cumulativeTarget": targetPerHour * 4 },
            { "hour": "11:00 - 12:00", "output": 0, "defect": 0, "qcChecked": 0, "cumulativeTarget": targetPerHour * 5 },
            { "hour": "12:00 - 13:00", "output": 0, "defect": 0, "qcChecked": 0, "cumulativeTarget": targetPerHour * 6 },
            { "hour": "13:00 - 14:00", "output": 0, "defect": 0, "qcChecked": 0, "cumulativeTarget": targetPerHour * 7 },
            { "hour": "14:00 - 15:00", "output": 0, "defect": 0, "qcChecked": 0, "cumulativeTarget": targetPerHour * 8 },
            { "hour": "15:00 - 16:00", "output": 0, "defect": 0, "qcChecked": 0, "cumulativeTarget": targetPerHour * 8 },
            { "hour": "16:00 - 17:00", "output": 0, "defect": 0, "qcChecked": 0, "cumulativeTarget": targetPerHour * 8 }
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

  // Initialize users.json if doesn't exist
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
          "id": 4,
          "username": "admin",
          "password": "admin123",
          "name": "Administrator",
          "line": "all",
          "role": "admin"
        },
        {
          "id": 5,
          "username": "leader1",
          "password": "leader123",
          "name": "Team Leader A",
          "line": "F1-5A,F1-5B",
          "role": "leader"
        }
      ]
    };
    fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(initialUsers, null, 2));
    console.log('Users file created successfully');
  }

  // Initialize defect types and areas if doesn't exist
  if (!fs.existsSync(path.join(__dirname, 'defect-config.json'))) {
    const initialDefectConfig = {
      "defectTypes": [
        { "id": 1, "name": "Cacat Penampilan", "active": true },
        { "id": 2, "name": "Cacat Dimensi", "active": true },
        { "id": 3, "name": "Cacat Fungsi", "active": true },
        { "id": 4, "name": "Cacat Material", "active": true }
      ],
      "defectAreas": [
        { "id": 1, "name": "Area A - Assembly", "active": true },
        { "id": 2, "name": "Area B - Quality Control", "active": true },
        { "id": 3, "name": "Area C - Packaging", "active": true },
        { "id": 4, "name": "Area D - Finishing", "active": true }
      ]
    };
    fs.writeFileSync(path.join(__dirname, 'defect-config.json'), JSON.stringify(initialDefectConfig, null, 2));
    console.log('Defect config file created successfully');
  }

  // Create history directory if doesn't exist
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

function readDefectConfig() {
  try {
    const data = fs.readFileSync(path.join(__dirname, 'defect-config.json'), 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('ERROR: Gagal membaca defect-config.json:', error.message);
    return { defectTypes: [], defectAreas: [] };
  }
}

function writeDefectConfig(data) {
  try {
    fs.writeFileSync(path.join(__dirname, 'defect-config.json'), JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('ERROR: Gagal menulis ke defect-config.json:', error.message);
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

// Middleware untuk Leader
function requireLeader(req, res, next) {
  if (req.session.user && (req.session.user.role === 'leader' || req.session.user.role === 'admin')) {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden - Leader or Admin access required' });
  }
}

// Middleware untuk mengakses line tertentu
function requireLineAccess(req, res, next) {
  const user = req.session.user;
  const lineName = req.params.lineName;
  
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized - Please login' });
  }

  // Admin bisa akses semua line
  if (user.role === 'admin') {
    return next();
  }

  // Leader bisa akses line yang ditugaskan
  if (user.role === 'leader') {
    const assignedLines = user.line.split(',');
    if (assignedLines.includes(lineName)) {
      return next();
    } else {
      return res.status(403).json({ error: 'Access denied to this line' });
    }
  }

  // Operator hanya bisa akses line-nya sendiri
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

// Defect Configuration Routes
app.get('/api/defect-config', requireLogin, (req, res) => {
  const defectConfig = readDefectConfig();
  res.json(defectConfig);
});

app.get('/api/defect-types', requireLogin, (req, res) => {
  const defectConfig = readDefectConfig();
  res.json(defectConfig.defectTypes.filter(type => type.active));
});

app.get('/api/defect-areas', requireLogin, (req, res) => {
  const defectConfig = readDefectConfig();
  res.json(defectConfig.defectAreas.filter(area => area.active));
});

app.post('/api/defect-types', requireLogin, requireAdmin, (req, res) => {
  const { name } = req.body;
  const defectConfig = readDefectConfig();
  
  const newType = {
    id: defectConfig.defectTypes.length > 0 ? Math.max(...defectConfig.defectTypes.map(t => t.id)) + 1 : 1,
    name,
    active: true
  };
  
  defectConfig.defectTypes.push(newType);
  writeDefectConfig(defectConfig);
  
  res.json({ message: 'Jenis defect berhasil ditambahkan', defectType: newType });
});

app.post('/api/defect-areas', requireLogin, requireAdmin, (req, res) => {
  const { name } = req.body;
  const defectConfig = readDefectConfig();
  
  const newArea = {
    id: defectConfig.defectAreas.length > 0 ? Math.max(...defectConfig.defectAreas.map(a => a.id)) + 1 : 1,
    name,
    active: true
  };
  
  defectConfig.defectAreas.push(newArea);
  writeDefectConfig(defectConfig);
  
  res.json({ message: 'Area defect berhasil ditambahkan', defectArea: newArea });
});

app.put('/api/defect-types/:id', requireLogin, requireAdmin, (req, res) => {
  const typeId = parseInt(req.params.id);
  const { name, active } = req.body;
  const defectConfig = readDefectConfig();
  
  const typeIndex = defectConfig.defectTypes.findIndex(t => t.id === typeId);
  if (typeIndex === -1) {
    return res.status(404).json({ error: 'Jenis defect tidak ditemukan' });
  }
  
  defectConfig.defectTypes[typeIndex] = {
    ...defectConfig.defectTypes[typeIndex],
    name,
    active: active !== undefined ? active : defectConfig.defectTypes[typeIndex].active
  };
  
  writeDefectConfig(defectConfig);
  res.json({ message: 'Jenis defect berhasil diupdate', defectType: defectConfig.defectTypes[typeIndex] });
});

app.put('/api/defect-areas/:id', requireLogin, requireAdmin, (req, res) => {
  const areaId = parseInt(req.params.id);
  const { name, active } = req.body;
  const defectConfig = readDefectConfig();
  
  const areaIndex = defectConfig.defectAreas.findIndex(a => a.id === areaId);
  if (areaIndex === -1) {
    return res.status(404).json({ error: 'Area defect tidak ditemukan' });
  }
  
  defectConfig.defectAreas[areaIndex] = {
    ...defectConfig.defectAreas[areaIndex],
    name,
    active: active !== undefined ? active : defectConfig.defectAreas[areaIndex].active
  };
  
  writeDefectConfig(defectConfig);
  res.json({ message: 'Area defect berhasil diupdate', defectArea: defectConfig.defectAreas[areaIndex] });
});

app.delete('/api/defect-types/:id', requireLogin, requireAdmin, (req, res) => {
  const typeId = parseInt(req.params.id);
  const defectConfig = readDefectConfig();
  
  const typeIndex = defectConfig.defectTypes.findIndex(t => t.id === typeId);
  if (typeIndex === -1) {
    return res.status(404).json({ error: 'Jenis defect tidak ditemukan' });
  }
  
  // Soft delete - set active to false
  defectConfig.defectTypes[typeIndex].active = false;
  writeDefectConfig(defectConfig);
  
  res.json({ message: 'Jenis defect berhasil dihapus' });
});

app.delete('/api/defect-areas/:id', requireLogin, requireAdmin, (req, res) => {
  const areaId = parseInt(req.params.id);
  const defectConfig = readDefectConfig();
  
  const areaIndex = defectConfig.defectAreas.findIndex(a => a.id === areaId);
  if (areaIndex === -1) {
    return res.status(404).json({ error: 'Area defect tidak ditemukan' });
  }
  
  // Soft delete - set active to false
  defectConfig.defectAreas[areaIndex].active = false;
  writeDefectConfig(defectConfig);
  
  res.json({ message: 'Area defect berhasil dihapus' });
});

// Update hourly data dengan defect details
app.post('/api/update-hourly/:lineName', requireLogin, requireLineAccess, (req, res) => {
  const lineName = req.params.lineName;
  const { hourIndex, output, defect, qcChecked, defectType, defectArea, defectNotes } = req.body;

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].hourly_data) {
    return res.status(404).json({ error: 'Line or hourly data not found' });
  }

  // Update data per jam
  data.lines[lineName].hourly_data[hourIndex] = {
    ...data.lines[lineName].hourly_data[hourIndex],
    output: parseInt(output),
    defect: parseInt(defect),
    qcChecked: parseInt(qcChecked),
    defectType: defectType || '',
    defectArea: defectArea || '',
    defectNotes: defectNotes || ''
  };

  // Hitung ulang total harian
  let totalOutput = 0;
  let totalDefect = 0;
  let totalQCChecked = 0;

  data.lines[lineName].hourly_data.forEach(hour => {
    totalOutput += hour.output || 0;
    totalDefect += hour.defect || 0;
    totalQCChecked += hour.qcChecked || 0;
  });

  data.lines[lineName].outputDay = totalOutput;
  data.lines[lineName].actualDefect = totalDefect;
  data.lines[lineName].qcChecking = totalQCChecked;

  // Hitung ulang persentase defect rate
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
  
  // Security check to prevent directory traversal
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
  
  // Security check
  if (!filename.startsWith('data_') || !filename.endsWith('.json')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  try {
    const historyData = readHistoryData(filename);
    if (!historyData) {
      return res.status(404).json({ error: 'History file not found' });
    }

    const date = filename.replace('data_', '').replace('.json', '');
    
    // Create Excel workbook
    const workbook = XLSX.utils.book_new();
    
    // Add summary sheet for all lines
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

    // Add sheets for each line
    Object.keys(historyData.lines).forEach(lineName => {
      const line = historyData.lines[lineName];
      
      // Line details
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
        ['Jam', 'Target Kumulatif', 'Output', 'Defect', 'QC Checked', 'Defect Rate (%)', 'Jenis Defect', 'Area Defect', 'Keterangan']
      ];

      line.hourly_data.forEach(hour => {
        const defectRate = hour.qcChecked > 0 ? ((hour.defect / hour.qcChecked) * 100).toFixed(2) : '0.00';
        lineData.push([
          hour.hour, 
          hour.cumulativeTarget, 
          hour.output, 
          hour.defect, 
          hour.qcChecked, 
          defectRate,
          hour.defectType || '',
          hour.defectArea || '',
          hour.defectNotes || ''
        ]);
      });

      // Operator data
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

    // Generate buffer
    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    // Set headers
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

// Sync dates endpoint
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

// Line Management Routes
app.get('/api/lines', requireLogin, (req, res) => {
  const user = req.session.user;
  const data = readProductionData();
  
  // Admin bisa melihat semua line
  if (user.role === 'admin') {
    return res.json(data.lines || {});
  }
  
  // Leader hanya bisa melihat line yang ditugaskan
  if (user.role === 'leader') {
    const assignedLines = user.line.split(',');
    const leaderLines = {};
    assignedLines.forEach(lineName => {
      if (data.lines[lineName]) {
        leaderLines[lineName] = data.lines[lineName];
      }
    });
    return res.json(leaderLines);
  }
  
  // Operator hanya bisa melihat line-nya sendiri
  if (user.role === 'operator') {
    const operatorLine = {};
    if (data.lines[user.line]) {
      operatorLine[user.line] = data.lines[user.line];
    }
    return res.json(operatorLine);
  }
  
  res.status(403).json({ error: 'Access denied' });
});

app.post('/api/lines', requireLogin, requireAdmin, (req, res) => {
  const { lineName, labelWeek, model, date, target } = req.body;
  const data = readProductionData();

  if (data.lines[lineName]) {
    return res.status(400).json({ error: 'Line already exists' });
  }

  // Gunakan tanggal hari ini jika tidak disediakan
  const lineDate = date || getToday();
  const targetPerHour = Math.round(target / 8); // 8 jam kerja efektif

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
      // Jam kerja pagi (4 jam)
      { hour: "07:00 - 08:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 1 },
      { hour: "08:00 - 09:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 2 },
      { hour: "09:00 - 10:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 3 },
      { hour: "10:00 - 11:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 4 },
      
      // Istirahat panjang 11:00-13:00 (2 jam) - cumulative target tetap sama
      { hour: "11:00 - 13:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 4 },
      
      // Jam kerja siang (4 jam)
      { hour: "13:00 - 14:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 5 },
      { hour: "14:00 - 15:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 6 },
      { hour: "15:00 - 16:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 7 },
      { hour: "16:00 - 17:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 8 },
      
      // Overtime atau jam tambahan - cumulative target tetap maksimal
      { hour: "17:00 - 18:00", output: 0, defect: 0, qcChecked: 0, cumulativeTarget: targetPerHour * 8 }
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

app.put('/api/lines/:lineName', requireLogin, requireAdmin, (req, res) => {
  const lineName = req.params.lineName;
  const { labelWeek, model, date, target } = req.body;
  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  const oldDate = data.lines[lineName].date;
  const newDate = date || getToday();
  const targetPerHour = Math.round(target / 8);

  // Jika tanggal berubah, reset semua data
  if (oldDate !== newDate) {
    data.lines[lineName] = resetLineData({
      ...data.lines[lineName],
      labelWeek,
      model,
      date: newDate,
      target: parseInt(target),
      targetPerHour: targetPerHour
    });
  } else {
    // Jika tanggal sama, hanya update data dasar
    data.lines[lineName].labelWeek = labelWeek;
    data.lines[lineName].model = model;
    data.lines[lineName].target = parseInt(target);
    data.lines[lineName].targetPerHour = targetPerHour;
    
    // Update cumulative target di hourly_data
    data.lines[lineName].hourly_data = data.lines[lineName].hourly_data.map((hour, index) => ({
      ...hour,
      cumulativeTarget: targetPerHour * (index + 1)
    }));
  }

  writeProductionData(data);
  res.json({ 
    message: `Line ${lineName} updated successfully`, 
    data: data.lines[lineName],
    calculated: {
      targetPerHour: targetPerHour,
      message: `Target per jam: ${targetPerHour} unit (Target: ${target} ÷ 8 jam)`
    },
    reset: oldDate !== newDate ? 'Data telah direset karena perubahan tanggal.' : 'Tanggal tidak berubah, data tetap.'
  });
});

app.delete('/api/lines/:lineName', requireLogin, requireAdmin, (req, res) => {
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

  // Update line data
  data.lines[lineName] = { ...data.lines[lineName], ...newData };

  // Recalculate percentages
  const line = data.lines[lineName];
  const qcChecking = line.qcChecking || 0;
  const actualDefect = line.actualDefect || 0;

  let defectRatePercentage = (qcChecking > 0) ? (actualDefect / qcChecking) * 100 : 0;

  line.defectRatePercentage = parseFloat(defectRatePercentage.toFixed(2));

  writeProductionData(data);
  res.json({ message: `Line ${lineName} updated successfully.`, data: line });
});

// Operator Routes - Leader bisa mengelola operator di line yang ditugaskan
app.get('/api/operators/:lineName', requireLogin, requireLineAccess, (req, res) => {
  const lineName = req.params.lineName;
  const data = readProductionData();
  
  if (data.lines[lineName]) {
    res.json(data.lines[lineName].operators || []);
  } else {
    res.status(404).json({ error: 'Line not found' });
  }
});

// Leader bisa menambah operator
app.post('/api/operators/:lineName', requireLogin, requireLineAccess, requireLeader, (req, res) => {
  const data = readProductionData();
  const lineName = req.params.lineName;
  const newOperator = req.body;

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  if (!data.lines[lineName].operators) {
    data.lines[lineName].operators = [];
  }

  // Generate ID
  const maxId = data.lines[lineName].operators.reduce((max, op) => Math.max(max, op.id), 0);
  newOperator.id = maxId + 1;
  
  // Create username from name (lowercase, no spaces)
  const username = newOperator.name.toLowerCase().replace(/\s/g, '');
  
  // Calculate efficiency
  newOperator.efficiency = ((newOperator.output / newOperator.target) * 100).toFixed(1);

  data.lines[lineName].operators.push(newOperator);

  // Create user account automatically
  const usersData = readUsersData();
  const newUser = {
    id: usersData.users.length + 1,
    username: username,
    password: "password123", // default password
    name: newOperator.name,
    line: lineName,
    role: "operator"
  };
  
  usersData.users.push(newUser);
  fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(usersData, null, 2));

  writeProductionData(data);
  res.json({ 
    message: 'Operator added successfully.', 
    operator: newOperator,
    userAccount: {
      username: username,
      password: "password123",
      message: "Akun operator telah dibuat secara otomatis"
    }
  });
});

// Leader bisa mengupdate operator
app.put('/api/operators/:lineName/:id', requireLogin, requireLineAccess, requireLeader, (req, res) => {
  const data = readProductionData();
  const lineName = req.params.lineName;
  const operatorId = parseInt(req.params.id);
  const updatedData = req.body;

  if (!data.lines[lineName] || !data.lines[lineName].operators) {
    return res.status(404).json({ error: 'Line or operators not found' });
  }

  const operatorIndex = data.lines[lineName].operators.findIndex(op => op.id === operatorId);

  if (operatorIndex === -1) {
    return res.status(404).json({ error: 'Operator not found' });
  }

  // Update operator data
  data.lines[lineName].operators[operatorIndex] = {
    ...data.lines[lineName].operators[operatorIndex],
    ...updatedData
  };

  // Recalculate efficiency
  data.lines[lineName].operators[operatorIndex].efficiency = (
    (data.lines[lineName].operators[operatorIndex].output / data.lines[lineName].operators[operatorIndex].target) * 100
  ).toFixed(1);

  writeProductionData(data);
  res.json({ message: 'Operator updated successfully.', operator: data.lines[lineName].operators[operatorIndex] });
});

// Leader bisa menghapus operator
app.delete('/api/operators/:lineName/:id', requireLogin, requireLineAccess, requireLeader, (req, res) => {
  const data = readProductionData();
  const lineName = req.params.lineName;
  const operatorId = parseInt(req.params.id);

  if (!data.lines[lineName] || !data.lines[lineName].operators) {
    return res.status(404).json({ error: 'Line or operators not found' });
  }

  data.lines[lineName].operators = data.lines[lineName].operators.filter(op => op.id !== operatorId);
  writeProductionData(data);

  res.json({ message: 'Operator deleted successfully.' });
});

// User Management Routes - Admin only
app.get('/api/users', requireLogin, requireAdmin, (req, res) => {
  const usersData = readUsersData();
  res.json(usersData.users || []);
});

app.post('/api/users', requireLogin, requireAdmin, (req, res) => {
  const { username, password, name, line, role } = req.body;
  const usersData = readUsersData();

  // Check if username already exists
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

  // Check if username already exists (excluding current user)
  if (usersData.users.find(u => u.username === username && u.id !== userId)) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  // Update user
  usersData.users[userIndex] = {
    ...usersData.users[userIndex],
    username,
    // Only update password if provided
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

  // Prevent deletion of own account
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
  
  // Sheet 1: Summary Data
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
  
  // Sheet 2: Hourly Data dengan defect details
  const hourlyData = [
    ['HOURLY PRODUCTION DATA'],
    [],
    ['Jam', 'Target Kumulatif', 'Output', 'Defect', 'QC Checked', 'Defect Rate (%)', 'Jenis Defect', 'Area Defect', 'Keterangan']
  ];

  lineData.hourly_data.forEach(hour => {
    const defectRate = hour.qcChecked > 0 ? ((hour.defect / hour.qcChecked) * 100).toFixed(2) : '0.00';
    hourlyData.push([
      hour.hour, 
      hour.cumulativeTarget, 
      hour.output, 
      hour.defect, 
      hour.qcChecked, 
      defectRate,
      hour.defectType || '',
      hour.defectArea || '',
      hour.defectNotes || ''
    ]);
  });
  
  // Add totals
  hourlyData.push([]);
  hourlyData.push(['TOTAL', lineData.target, lineData.outputDay, lineData.actualDefect, lineData.qcChecking, lineData.defectRatePercentage + '%', '', '', '']);
  
  const hourlySheet = XLSX.utils.aoa_to_sheet(hourlyData);
  XLSX.utils.book_append_sheet(workbook, hourlySheet, 'Hourly Data');
  
  // Sheet 3: Operator Data
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
    
    // Generate buffer
    const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    // Set headers
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
  if (req.session.user) {
    if (req.session.user.role === 'admin') {
      res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    } else if (req.session.user.role === 'leader') {
      res.sendFile(path.join(__dirname, 'public', 'leader.html'));
    } else {
      res.redirect(`/line/${req.session.user.line}`);
    }
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.get('/admin', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/');
  }
  if (req.session.user.role !== 'admin') {
    if (req.session.user.role === 'leader') {
      return res.redirect('/leader');
    }
    return res.redirect(`/line/${req.session.user.line}`);
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Route untuk Leader Dashboard
app.get('/leader', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/');
  }
  if (req.session.user.role !== 'leader') {
    if (req.session.user.role === 'admin') {
      return res.redirect('/admin');
    }
    return res.redirect(`/line/${req.session.user.line}`);
  }
  res.sendFile(path.join(__dirname, 'public', 'leader.html'));
});

app.get('/line/:lineName', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/');
  }

  const lineName = req.params.lineName;
  
  // Check line access
  const user = req.session.user;
  let hasAccess = false;
  
  if (user.role === 'admin') {
    hasAccess = true;
  } else if (user.role === 'leader') {
    const assignedLines = user.line.split(',');
    hasAccess = assignedLines.includes(lineName);
  } else if (user.role === 'operator') {
    hasAccess = user.line === lineName;
  }

  if (!hasAccess) {
    return res.status(403).send('Access denied to this line');
  }

  res.sendFile(path.join(__dirname, 'public', 'operator.html'));
});

app.get('/input/:lineName', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/');
  }

  const lineName = req.params.lineName;
  
  // Check line access
  const user = req.session.user;
  let hasAccess = false;
  
  if (user.role === 'admin') {
    hasAccess = true;
  } else if (user.role === 'leader') {
    const assignedLines = user.line.split(',');
    hasAccess = assignedLines.includes(lineName);
  } else if (user.role === 'operator') {
    hasAccess = user.line === lineName;
  }

  if (!hasAccess) {
    return res.status(403).send('Access denied to this line');
  }

  res.sendFile(path.join(__dirname, 'public', 'input.html'));
});

// Static file routes
app.get('/style.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'style.css'));
});

app.get('/all.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'all.css'));
});

app.get('/login.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.js'));
});

app.get('/admin.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.js'));
});

// Leader JavaScript
app.get('/leader.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'leader.js'));
});

app.get('/operator.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'operator.js'));
});

app.get('/input.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'input.js'));
});

// Schedule daily backup at midnight
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    saveDailyBackup();
  }
}, 60000); // Check every minute

// Initialize and Start Server
initializeDataFiles();

// Create initial backup
setTimeout(saveDailyBackup, 5000);

app.listen(port, () => {
  console.log(`=================================`);
  console.log(`Production Dashboard System`);
  console.log(`Server berjalan di http://localhost:${port}`);
  console.log(`=================================`);
  console.log(`Fitur Algoritma Baru telah diimplementasikan`);
  console.log(`- Target kumulatif per jam`);
  console.log(`- QC Checking & Actual Defect`);
  console.log(`- Defect Rate berdasarkan QC Checking`);
  console.log(`- Defect Types & Areas Management`);
  console.log(`=================================`);
});