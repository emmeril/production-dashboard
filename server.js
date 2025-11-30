const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const crypto = require('crypto');

const app = express();
const port = 3000;

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
    console.log(`Auto-reset selesai: ${resetCount} model direset ke tanggal ${today}`);
  }

  return resetCount;
}

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
    fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(initialData, null, 2));
    console.log('Data file created successfully with multi-model support');
  }

  if (!fs.existsSync(path.join(__dirname, 'users.json'))) {
    const initialUsers = {
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
    fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(initialUsers, null, 2));
    console.log('Users file created successfully with encrypted passwords');
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

function writeUsersData(data) {
  try {
    fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('ERROR: Gagal menulis ke users.json:', error.message);
  }
}

function generateUserId(users) {
  if (users.length === 0) return 1;
  const maxId = Math.max(...users.map(user => user.id));
  return maxId + 1;
}

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

function autoCheckDateReset(req, res, next) {
  checkAndResetDataForNewDay();
  next();
}

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

app.post('/api/backup/now', requireLogin, requireAdmin, (req, res) => {
  try {
    saveDailyBackup();
    res.json({ message: 'Backup created successfully' });
  } catch (error) {
    console.error('Error creating backup:', error);
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

app.post('/api/sync-dates', requireLogin, requireAdmin, (req, res) => {
  const resetCount = checkAndResetDataForNewDay();
  const today = getToday();
  
  res.json({ 
    message: `Sinkronisasi tanggal selesai. ${resetCount} model direset ke tanggal ${today}`,
    resetCount: resetCount,
    today: today
  });
});

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
  res.json({ message: `Model ${modelId} deleted from line ${lineName} successfully` });
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
      console.log(`Mengambil data dari backup: ${backupFile}`);
      data = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    } else {
      console.log(`Backup tidak ditemukan, menggunakan data.json untuk tanggal: ${date}`);
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
  
  summarySheet.mergeCells('A1:J1');
  const titleCell = summarySheet.getCell('A1');
  titleCell.value = 'PRODUCTION REPORT SUMMARY - ' + date;
  titleCell.style = titleStyle;
  
  summarySheet.getCell('A3').value = 'Generated Date';
  summarySheet.getCell('B3').value = new Date().toLocaleString('id-ID');
  summarySheet.getCell('A4').value = 'Report Date';
  summarySheet.getCell('B4').value = date;
  summarySheet.getCell('A5').value = 'Total Lines';
  summarySheet.getCell('B5').value = Object.keys(data.lines).length;
  
  const headers = ['Line', 'Model ID', 'Label/Week', 'Model', 'Target', 'Output', 'Achievement %', 'Defect', 'QC Checked', 'Defect Rate %'];
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
      
      const defectRateCell = row.getCell(10);
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
      console.log(`Mengambil data dari backup untuk export: ${backupFile}`);
      data = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    } else {
      console.log(`Backup tidak ditemukan, menggunakan data.json untuk export tanggal: ${date}`);
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
    console.log(`Export Excel dengan styling untuk tanggal ${date} berhasil`);
  } catch (error) {
    console.error('Export date report error:', error);
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
  
  summarySheet.mergeCells('A1:H1');
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
  
  const headers = ['Metric', 'Value', 'Target per Hour', 'Output/Hari', 'QC Checking', 'Actual Defect', 'Defect Rate (%)'];
  summarySheet.getRow(9).values = headers;
  summarySheet.getRow(9).eachCell((cell) => {
    cell.style = headerStyle;
  });
  
  const dataRow1 = summarySheet.getRow(10);
  dataRow1.values = [
    'Production Data',
    modelData.target || 0,
    modelData.targetPerHour || 0,
    modelData.outputDay || 0,
    modelData.qcChecking || 0,
    modelData.actualDefect || 0,
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
    { width: 15 }
  ];
  
  const hourlySheet = workbook.addWorksheet('HOURLY DATA');
  
  hourlySheet.mergeCells('A1:G1');
  const hourlyTitle = hourlySheet.getCell('A1');
  hourlyTitle.value = 'HOURLY PRODUCTION DATA';
  hourlyTitle.style = titleStyle;
  
  const hourlyHeaders = ['Jam', 'Target Manual', 'Output', 'Selisih (Output - Target)', 'Defect', 'QC Checked', 'Defect Rate (%)'];
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
      
      const row = hourlySheet.getRow(rowIndex);
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
    console.log(`Export Excel dengan styling untuk ${lineName}-${modelId} berhasil`);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to generate Excel file' });
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
  
  if (!modelData.targetPerHour) {
    modelData.targetPerHour = Math.round(modelData.target / 8);
  }
  
  res.json(modelData);
});

app.get('/public-display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public-display.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

setInterval(() => {
  saveDailyBackup();
  console.log('Auto backup dijalankan');
  
  const resetCount = checkAndResetDataForNewDay();
  if (resetCount > 0) {
    console.log(`Auto reset data selesai: ${resetCount} model direset`);
  }
}, 60000);

initializeDataFiles();

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
  console.log(`- AUTO RESET DATA SETIAP HARI BARU (FIXED)`);
  console.log(`- Laporan berdasarkan tanggal (FIXED - SEMUA MODEL TERCATAT)`);
  console.log(`- Backup dan History System`);
  console.log(`- Export Excel DENGAN STYLING LANJUTAN`);
  console.log(`- PASSWORD ENCRYPTION DENGAN SHA-256`);
  console.log(`- UNIQUE USER ID MANAGEMENT`);
  console.log(`- FITUR PILIH TANGGAL KEMBALI AKTIF`);
  console.log(`- RESET DATA OPERATOR SETIAP GANTI HARI`);
  console.log(`=================================`);
  console.log(`Default Users:`);
  console.log(`- Admin: admin / admin123`);
  console.log(`- Admin Operator: admin_operator / adminop123`);
  console.log(`- Operator: operator1 / password123`);
  console.log(`=================================`);
});
