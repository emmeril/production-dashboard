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
    ]
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
        }
      ]
    };
    fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(initialUsers, null, 2));
    console.log('Users file created successfully');
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

function requireLineAccess(req, res, next) {
  const user = req.session.user;
  const lineName = req.params.lineName;
  
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized - Please login' });
  }

  if (user.role === 'admin') {
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

  data.lines[lineName].hourly_data.forEach(hour => {
    totalOutput += hour.output || 0;
    totalDefect += hour.defect || 0;
    totalQCChecked += hour.qcChecked || 0;
  });

  data.lines[lineName].outputDay = totalOutput;
  data.lines[lineName].actualDefect = totalDefect;
  data.lines[lineName].qcChecking = totalQCChecked;

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

  writeProductionData(data);
  res.json({
    message: 'Target manual updated successfully.',
    data: data.lines[lineName].hourly_data[hourIndex]
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

  data.lines[lineName].hourly_data.forEach(hour => {
    totalOutput += hour.output || 0;
    totalDefect += hour.defect || 0;
    totalQCChecked += hour.qcChecked || 0;
  });

  data.lines[lineName].outputDay = totalOutput;
  data.lines[lineName].actualDefect = totalDefect;
  data.lines[lineName].qcChecking = totalQCChecked;

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

// Line Management Routes
app.get('/api/lines', requireLogin, (req, res) => {
  const user = req.session.user;
  const data = readProductionData();
  
  if (user.role === 'admin') {
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
  
  // Sheet 2: Hourly Data
  const hourlyData = [
    ['HOURLY PRODUCTION DATA'],
    [],
    ['Jam', 'Target Manual', 'Output', 'Selisih', 'Defect', 'QC Checked', 'Defect Rate (%)']
  ];

  lineData.hourly_data.forEach(hour => {
    const defectRate = hour.qcChecked > 0 ? ((hour.defect / hour.qcChecked) * 100).toFixed(2) : '0.00';
    hourlyData.push([
      hour.hour, 
      hour.targetManual,
      hour.output, 
      hour.selisih,
      hour.defect, 
      hour.qcChecked, 
      defectRate
    ]);
  });
  
  // Add totals
  hourlyData.push([]);
  hourlyData.push(['TOTAL', lineData.target, lineData.outputDay, '', lineData.actualDefect, lineData.qcChecking, lineData.defectRatePercentage + '%']);
  
  const hourlySheet = XLSX.utils.aoa_to_sheet(hourlyData);
  XLSX.utils.book_append_sheet(workbook, hourlySheet, 'Hourly Data');
  
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
  if (req.session.user) {
    if (req.session.user.role === 'admin') {
      res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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
    return res.redirect(`/line/${req.session.user.line}`);
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/line/:lineName', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/');
  }

  const lineName = req.params.lineName;
  
  const user = req.session.user;
  let hasAccess = false;
  
  if (user.role === 'admin') {
    hasAccess = true;
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
  
  const user = req.session.user;
  let hasAccess = false;
  
  if (user.role === 'admin') {
    hasAccess = true;
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

app.get('/login.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.js'));
});

app.get('/admin.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.js'));
});

app.get('/operator.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'operator.js'));
});

app.get('/input.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'input.js'));
});

// Initialize and Start Server
initializeDataFiles();

app.listen(port, () => {
  console.log(`=================================`);
  console.log(`Production Dashboard System`);
  console.log(`Server berjalan di http://localhost:${port}`);
  console.log(`=================================`);
  console.log(`Fitur yang tersedia:`);
  console.log(`- Input langsung di tabel Data Per Jam`);
  console.log(`- Target berdasarkan manual input`);
  console.log(`- Export Excel`);
  console.log(`=================================`);
});
