const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');

const app = express();
const port = 3000;

// Middleware - HARUS di awal
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static file serving - FIXED
app.use('/public', express.static(path.join(__dirname, 'public')));

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

// Initialize data files
function initializeDataFiles() {
  // Initialize data.json if doesn't exist
  if (!fs.existsSync(path.join(__dirname, 'data.json'))) {
    const initialData = {
      "lines": {
        "F1-5A": {
          "labelWeek": "AP/14-2550",
          "model": "GOSIG GOLDEN SOFT TOY 40 PDS/GOLDEN RETRIEVER",
          "date": "2025-09-30",
          "target": 150,
          "productivity": 0,
          "defectTarget": 0,
          "outputDay": 900,
          "defectDay": 26,
          "achivementPercentage": 600.00,
          "defectRatePercentage": 2.89,
          "hourly_data": [
            { "hour": "08:00 - 09:00", "output": 100, "defect": 2 },
            { "hour": "09:00 - 10:00", "output": 120, "defect": 3 },
            { "hour": "10:00 - 11:00", "output": 110, "defect": 1 },
            { "hour": "11:00 - 12:00", "output": 100, "defect": 5 },
            { "hour": "12:00 - 13:00", "output": 0, "defect": 0 },
            { "hour": "13:00 - 14:00", "output": 130, "defect": 4 },
            { "hour": "14:00 - 15:00", "output": 140, "defect": 6 },
            { "hour": "15:00 - 16:00", "output": 100, "defect": 3 },
            { "hour": "16:00 - 17:00", "output": 100, "defect": 2 }
          ],
          "operators": [
            {
              "id": 1,
              "name": "Ahmad Susanto",
              "position": "Operator Mesin",
              "target": 100,
              "output": 95,
              "defect": 3,
              "efficiency": 95.0,
              "status": "active"
            }
          ]
        },
        "F1-5B": {
          "labelWeek": "AP/14-2551",
          "model": "GOSIG GOLDEN SOFT TOY 40 PDS/GOLDEN RETRIEVER",
          "date": "2025-09-30",
          "target": 120,
          "productivity": 0,
          "defectTarget": 0,
          "outputDay": 750,
          "defectDay": 18,
          "achivementPercentage": 625.00,
          "defectRatePercentage": 2.40,
          "hourly_data": [
            { "hour": "08:00 - 09:00", "output": 80, "defect": 1 },
            { "hour": "09:00 - 10:00", "output": 90, "defect": 2 },
            { "hour": "10:00 - 11:00", "output": 85, "defect": 1 },
            { "hour": "11:00 - 12:00", "output": 95, "defect": 3 },
            { "hour": "12:00 - 13:00", "output": 0, "defect": 0 },
            { "hour": "13:00 - 14:00", "output": 100, "defect": 2 },
            { "hour": "14:00 - 15:00", "output": 110, "defect": 4 },
            { "hour": "15:00 - 16:00", "output": 95, "defect": 2 },
            { "hour": "16:00 - 17:00", "output": 95, "defect": 3 }
          ],
          "operators": [
            {
              "id": 2,
              "name": "Siti Rahayu",
              "position": "Quality Control",
              "target": 50,
              "output": 48,
              "defect": 2,
              "efficiency": 96.0,
              "status": "active"
            }
          ]
        },
        "F1-5C": {
          "labelWeek": "AP/14-2552",
          "model": "GOSIG GOLDEN SOFT TOY 40 PDS/GOLDEN RETRIEVER",
          "date": "2025-09-30",
          "target": 180,
          "productivity": 0,
          "defectTarget": 0,
          "outputDay": 1100,
          "defectDay": 32,
          "achivementPercentage": 611.11,
          "defectRatePercentage": 2.91,
          "hourly_data": [
            { "hour": "08:00 - 09:00", "output": 120, "defect": 3 },
            { "hour": "09:00 - 10:00", "output": 130, "defect": 4 },
            { "hour": "10:00 - 11:00", "output": 125, "defect": 2 },
            { "hour": "11:00 - 12:00", "output": 115, "defect": 6 },
            { "hour": "12:00 - 13:00", "output": 0, "defect": 0 },
            { "hour": "13:00 - 14:00", "output": 140, "defect": 5 },
            { "hour": "14:00 - 15:00", "output": 150, "defect": 7 },
            { "hour": "15:00 - 16:00", "output": 120, "defect": 4 },
            { "hour": "16:00 - 17:00", "output": 100, "defect": 1 }
          ],
          "operators": [
            {
              "id": 3,
              "name": "Budi Pratama",
              "position": "Operator Packaging",
              "target": 150,
              "output": 142,
              "defect": 5,
              "efficiency": 94.7,
              "status": "break"
            }
          ]
        }
      },
      "activeLine": "F1-5A"
    };
    fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(initialData, null, 2));
    console.log('Data file created successfully');
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
          "id": 2,
          "username": "operator2",
          "password": "password123",
          "name": "Siti Rahayu",
          "line": "F1-5B",
          "role": "operator"
        },
        {
          "id": 3,
          "username": "operator3",
          "password": "password123",
          "name": "Budi Pratama",
          "line": "F1-5C",
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

// Utility Functions
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

// Data Routes
app.get('/api/lines', requireLogin, (req, res) => {
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const data = readProductionData();
  res.json(data.lines || {});
});

app.get('/api/line/:lineName', requireLogin, (req, res) => {
  const user = req.session.user;
  const lineName = req.params.lineName;

  // Operator hanya bisa akses line-nya sendiri
  if (user.role === 'operator' && user.line !== lineName) {
    return res.status(403).json({ error: 'Access denied to this line' });
  }

  const data = readProductionData();
  const lineData = data.lines[lineName];

  if (lineData) {
    res.json({ line: lineName, ...lineData });
  } else {
    res.status(404).json({ error: 'Line not found' });
  }
});

app.post('/api/update-line/:lineName', requireLogin, (req, res) => {
  const user = req.session.user;
  const lineName = req.params.lineName;
  const newData = req.body;

  // Operator hanya bisa update line-nya sendiri
  if (user.role === 'operator' && user.line !== lineName) {
    return res.status(403).json({ error: 'Access denied to this line' });
  }

  const data = readProductionData();

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  // Update line data
  data.lines[lineName] = { ...data.lines[lineName], ...newData };

  // Recalculate percentages
  const line = data.lines[lineName];
  const target = line.target || 1;
  const outputDay = line.outputDay || 0;
  const defectDay = line.defectDay || 0;

  let achivementPercentage = (outputDay / target) * 100;
  let defectRatePercentage = (outputDay > 0) ? (defectDay / outputDay) * 100 : 0;

  line.achivementPercentage = parseFloat(achivementPercentage.toFixed(2));
  line.defectRatePercentage = parseFloat(defectRatePercentage.toFixed(2));

  writeProductionData(data);
  res.json({ message: `Line ${lineName} updated successfully.`, data: line });
});

app.post('/api/update-hourly/:lineName', requireLogin, (req, res) => {
  const user = req.session.user;
  const lineName = req.params.lineName;
  const { hourIndex, output, defect } = req.body;

  // Operator hanya bisa update line-nya sendiri
  if (user.role === 'operator' && user.line !== lineName) {
    return res.status(403).json({ error: 'Access denied to this line' });
  }

  const data = readProductionData();

  if (!data.lines[lineName] || !data.lines[lineName].hourly_data) {
    return res.status(404).json({ error: 'Line or hourly data not found' });
  }

  // Update data per jam
  data.lines[lineName].hourly_data[hourIndex] = {
    ...data.lines[lineName].hourly_data[hourIndex],
    output: parseInt(output),
    defect: parseInt(defect)
  };

  // Hitung ulang total harian
  let totalOutput = 0;
  let totalDefect = 0;

  data.lines[lineName].hourly_data.forEach(hour => {
    totalOutput += hour.output || 0;
    totalDefect += hour.defect || 0;
  });

  data.lines[lineName].outputDay = totalOutput;
  data.lines[lineName].defectDay = totalDefect;

  // Hitung ulang persentase
  const target = data.lines[lineName].target || 1;
  let achivementPercentage = (totalOutput / target) * 100;
  let defectRatePercentage = (totalOutput > 0) ? (totalDefect / totalOutput) * 100 : 0;

  data.lines[lineName].achivementPercentage = parseFloat(achivementPercentage.toFixed(2));
  data.lines[lineName].defectRatePercentage = parseFloat(defectRatePercentage.toFixed(2));

  writeProductionData(data);
  res.json({
    message: 'Hourly data updated successfully.',
    data: data.lines[lineName]
  });
});

// Operator Routes
app.get('/api/operators/:lineName', requireLogin, (req, res) => {
  const user = req.session.user;
  const lineName = req.params.lineName;

  if (user.role === 'operator' && user.line !== lineName) {
    return res.status(403).json({ error: 'Access denied to this line' });
  }

  const data = readProductionData();
  if (data.lines[lineName]) {
    res.json(data.lines[lineName].operators || []);
  } else {
    res.status(404).json({ error: 'Line not found' });
  }
});

app.post('/api/operators/:lineName', requireLogin, requireAdmin, (req, res) => {
  const data = readProductionData();
  const lineName = req.params.lineName;
  const newOperator = req.body;

  if (!data.lines[lineName]) {
    return res.status(404).json({ error: 'Line not found' });
  }

  if (!data.lines[lineName].operators) {
    data.lines[lineName].operators = [];
  }

  // Generate ID jika tidak ada
  if (!newOperator.id) {
    const maxId = data.lines[lineName].operators.reduce((max, op) => Math.max(max, op.id), 0);
    newOperator.id = maxId + 1;
  }

  // Hitung efisiensi
  newOperator.efficiency = ((newOperator.output / newOperator.target) * 100).toFixed(1);

  data.lines[lineName].operators.push(newOperator);
  writeProductionData(data);

  res.json({ message: 'Operator added successfully.', operator: newOperator });
});

app.put('/api/operators/:lineName/:id', requireLogin, requireAdmin, (req, res) => {
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

app.delete('/api/operators/:lineName/:id', requireLogin, requireAdmin, (req, res) => {
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
  if (req.session.user.role === 'operator' && req.session.user.line !== lineName) {
    return res.status(403).send('Access denied to this line');
  }

  res.sendFile(path.join(__dirname, 'public', 'operator.html'));
});

// Static file routes as backup
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

// Initialize and Start Server
initializeDataFiles();

app.listen(port, () => {
  console.log(`=================================`);
  console.log(`Production Dashboard System`);
  console.log(`Server berjalan di http://localhost:${port}`);
  console.log(`=================================`);
  console.log(`Test Accounts:`);
  console.log(`- Admin: admin / admin123`);
  console.log(`- Operator F1-5A: operator1 / password123`);
  console.log(`- Operator F1-5B: operator2 / password123`);
  console.log(`- Operator F1-5C: operator3 / password123`);
  console.log(`=================================`);
  console.log(`URL Khusus per Line:`);
  console.log(`- Line F1-5A: http://localhost:${port}/line/F1-5A`);
  console.log(`- Line F1-5B: http://localhost:${port}/line/F1-5B`);
  console.log(`- Line F1-5C: http://localhost:${port}/line/F1-5C`);
  console.log(`=================================`);
});