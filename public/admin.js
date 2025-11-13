// public/admin.js

let currentLine = '';
let currentUser = null;
let allLines = {};
let allUsers = [];
let currentHistoryFile = '';
let currentHistoryData = null;
let defectTypes = [];
let defectAreas = [];

// Check authentication
async function checkAuth() {
    try {
        const response = await fetch('/api/current-user');
        if (response.ok) {
            currentUser = await response.json();
            if (currentUser.role !== 'admin') {
                window.location.href = `/line/${currentUser.line}`;
                return;
            }
            document.getElementById('admin-name').textContent = currentUser.name;
            initializeAdmin();
        } else {
            window.location.href = '/';
        }
    } catch (error) {
        console.error('Auth check failed:', error);
        window.location.href = '/';
    }
}

// Tab management
function initTabs() {
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');

    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const tabName = button.getAttribute('data-tab');
            
            // Deactivate all tabs
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));
            
            // Activate current tab
            button.classList.add('active');
            document.getElementById(tabName).classList.add('active');

            // Load data based on active tab
            if (tabName === 'user-management') {
                fetchUsers();
            } else if (tabName === 'history-management') {
                fetchHistoryFiles();
            } else if (tabName === 'defect-management') {
                fetchDefects();
            }
        });
    });
}

async function fetchLines() {
    try {
        const response = await fetch('/api/lines');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const lines = await response.json();
        allLines = lines;
        updateLineSelector(lines);
    } catch (error) {
        console.error("Gagal mengambil data lines:", error);
    }
}

async function fetchLineData(line) {
    try {
        const response = await fetch(`/api/line/${line}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        updateDashboard(data);
    } catch (error) {
        console.error("Gagal mengambil data line:", error);
    }
}

function updateLineSelector(lines) {
    allLines = lines; // Store lines data
    const lineButtons = document.getElementById('line-buttons');
    lineButtons.innerHTML = '';

    // Add "Add Line" button for admin
    const addButton = document.createElement('button');
    addButton.className = 'line-btn add-line-btn';
    addButton.innerHTML = '+ Tambah Line';
    addButton.onclick = showLineModal;
    lineButtons.appendChild(addButton);

    Object.keys(lines).forEach(line => {
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'line-button-container';
        
        const lineData = lines[line];
        const button = document.createElement('button');
        button.className = 'line-btn';
        button.innerHTML = `
            <div>${line}</div>
            <small style="font-size: 0.8em; opacity: 0.8;">
                Target: ${lineData.target} | Productivity: ${lineData.productivity}/jam
            </small>
        `;
        button.onclick = () => {
            currentLine = line;
            fetchLineData(line);
            updateLineButtons();
        };

        const editButton = document.createElement('button');
        editButton.className = 'line-edit-btn';
        editButton.innerHTML = '✎';
        editButton.title = 'Edit Line';
        editButton.onclick = (e) => {
            e.stopPropagation();
            showEditLineModal(line);
        };

        buttonContainer.appendChild(button);
        buttonContainer.appendChild(editButton);
        lineButtons.appendChild(buttonContainer);
    });

    if (!currentLine && Object.keys(lines).length > 0) {
        currentLine = Object.keys(lines)[0];
        fetchLineData(currentLine);
    }
    
    updateLineButtons();
}

function updateLineButtons() {
    document.querySelectorAll('.line-btn').forEach(btn => {
        if (btn.textContent.includes(currentLine)) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

// Dalam admin.js, update fungsi updateDashboard:
function updateDashboard(data) {
    // Update Header Info
    document.getElementById('line').textContent = `LINE: ${data.line || 'N/A'}`;
    document.getElementById('label-week').textContent = `LABEL/WEEK: ${data.labelWeek || 'N/A'}`;
    document.getElementById('model').textContent = data.model || 'N/A';
    document.getElementById('date').textContent = `DATE: ${data.date || 'N/A'}`;

    // Hitung target kumulatif berdasarkan jam sekarang
    const currentTarget = calculateCurrentTarget(data);
    
    // Update Main Values dengan algoritma baru
    document.getElementById('target').textContent = currentTarget;
    
    // Productivity = total output
    document.getElementById('productivity').textContent = data.outputDay || 0;
    
    // Output/Day = selisih dari target kumulatif
    const outputDifference = data.outputDay - currentTarget;
    document.getElementById('output-day').textContent = outputDifference;
    
    // Update QC Checking, Actual Defect, dan Defect Rate
    document.getElementById('qc-checking').textContent = data.qcChecking || 0;
    document.getElementById('actual-defect').textContent = data.actualDefect || 0;

    const defectRate = (data.defectRatePercentage || 0.00).toFixed(2);
    document.getElementById('defect-rate').textContent = `${defectRate}%`;

    // Warna untuk output difference
    const outputDayElement = document.getElementById('output-day');
    if (outputDifference >= 0) {
        outputDayElement.classList.add('green-bg');
        outputDayElement.classList.remove('red-bg');
    } else {
        outputDayElement.classList.add('red-bg');
        outputDayElement.classList.remove('green-bg');
    }

    // Warna untuk defect rate
    const defectRateElement = document.getElementById('defect-rate');
    const defectRateValue = parseFloat(defectRate);
    if (defectRateValue <= 2) {
        defectRateElement.classList.add('green-bg');
        defectRateElement.classList.remove('yellow-bg', 'red-bg');
    } else if (defectRateValue <= 5) {
        defectRateElement.classList.add('yellow-bg');
        defectRateElement.classList.remove('green-bg', 'red-bg');
    } else {
        defectRateElement.classList.add('red-bg');
        defectRateElement.classList.remove('green-bg', 'yellow-bg');
    }
    
    // Update section titles
    document.getElementById('current-line').textContent = data.line;
    document.getElementById('hourly-line').textContent = data.line;
    document.getElementById('modal-line').textContent = data.line;

    // Update Hourly Data Table dengan target kumulatif dan defect details
    updateHourlyTable(data.hourly_data);

    // Update operators
    if (data.operators) {
        updateOperatorTable(data.operators);
    } else {
        fetchOperators();
    }
}

function updateHourlyTable(hourlyData) {
    const tableBody = document.getElementById('hourly-table-body');
    tableBody.innerHTML = '';

    if (hourlyData && hourlyData.length > 0) {
        hourlyData.forEach(item => {
            const row = tableBody.insertRow();
            row.insertCell().textContent = item.hour || '-';
            
            // Target kumulatif
            row.insertCell().textContent = item.cumulativeTarget || 0;
            
            // Output aktual
            row.insertCell().textContent = item.output || 0;
            
            // Defect
            row.insertCell().textContent = item.defect || 0;
            
            // QC Checked
            row.insertCell().textContent = item.qcChecked || 0;
            
            // Calculate defect rate berdasarkan QC Checked
            const defectRateCell = row.insertCell();
            const defectRate = item.qcChecked > 0 ? ((item.defect / item.qcChecked) * 100).toFixed(2) : '0.00';
            defectRateCell.textContent = `${defectRate}%`;
            
            // Color coding for defect rate
            const defectRateValue = parseFloat(defectRate);
            if (defectRateValue <= 2) {
                defectRateCell.className = 'efficiency-high';
            } else if (defectRateValue <= 5) {
                defectRateCell.className = 'efficiency-medium';
            } else {
                defectRateCell.className = 'efficiency-low';
            }

            // Defect details
            row.insertCell().textContent = item.defectType || '-';
            row.insertCell().textContent = item.defectArea || '-';
            row.insertCell().textContent = item.defectNotes || '-';
        });
    } else {
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 9;
        cell.textContent = "Data per jam belum tersedia.";
        cell.style.textAlign = 'center';
        cell.style.color = '#888';
    }
}

async function fetchOperators() {
    if (!currentLine) return;
    
    try {
        const response = await fetch(`/api/operators/${currentLine}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const operators = await response.json();
        updateOperatorTable(operators);
    } catch (error) {
        console.error("Gagal mengambil data operator:", error);
    }
}

function updateOperatorTable(operators) {
    const tableBody = document.getElementById('operator-table-body');
    tableBody.innerHTML = '';

    if (operators && operators.length > 0) {
        operators.forEach((operator, index) => {
            const row = tableBody.insertRow();
            
            // No
            row.insertCell().textContent = index + 1;
            
            // Nama
            row.insertCell().textContent = operator.name;
            
            // Posisi
            row.insertCell().textContent = operator.position;
            
            // Target
            row.insertCell().textContent = operator.target;
            
            // Output
            row.insertCell().textContent = operator.output;
            
            // Defect
            row.insertCell().textContent = operator.defect;
            
            // Efisiensi
            const efficiencyCell = row.insertCell();
            efficiencyCell.textContent = `${operator.efficiency}%`;
            
            // Add efficiency class based on value
            const efficiency = parseFloat(operator.efficiency);
            if (efficiency >= 95) {
                efficiencyCell.className = 'efficiency-high';
            } else if (efficiency >= 85) {
                efficiencyCell.className = 'efficiency-medium';
            } else {
                efficiencyCell.className = 'efficiency-low';
            }
            
            // Status
            const statusCell = row.insertCell();
            statusCell.textContent = getStatusText(operator.status);
            statusCell.className = `status-${operator.status}`;
            
            // Aksi
            const actionCell = row.insertCell();
            const editButton = document.createElement('button');
            editButton.textContent = 'Edit';
            editButton.className = 'btn-edit';
            editButton.onclick = () => editOperator(operator);
            
            const deleteButton = document.createElement('button');
            deleteButton.textContent = 'Hapus';
            deleteButton.className = 'btn-danger';
            deleteButton.onclick = () => deleteOperator(operator.id);
            
            actionCell.appendChild(editButton);
            actionCell.appendChild(deleteButton);
        });
    } else {
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 9;
        cell.textContent = "Tidak ada data operator.";
        cell.style.textAlign = 'center';
    }
}

function getStatusText(status) {
    const statusMap = {
        'active': 'Aktif',
        'break': 'Istirahat',
        'off': 'Off'
    };
    return statusMap[status] || status;
}

// User Management Functions
async function fetchUsers() {
    try {
        const response = await fetch('/api/users');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        allUsers = await response.json();
        updateUserTable(allUsers);
    } catch (error) {
        console.error("Gagal mengambil data users:", error);
    }
}

function updateUserTable(users) {
    const tableBody = document.getElementById('user-table-body');
    tableBody.innerHTML = '';

    if (users && users.length > 0) {
        users.forEach((user, index) => {
            const row = tableBody.insertRow();
            row.insertCell().textContent = index + 1;
            row.insertCell().textContent = user.username;
            row.insertCell().textContent = user.name;
            row.insertCell().textContent = user.line;
            
            // Role dengan styling
            const roleCell = row.insertCell();
            roleCell.textContent = user.role;
            if (user.role === 'admin') {
                roleCell.className = 'efficiency-high';
            } else if (user.role === 'leader') {
                roleCell.className = 'efficiency-medium';
            } else {
                roleCell.className = 'efficiency-low';
            }
            
            // Aksi
            const actionCell = row.insertCell();
            const editButton = document.createElement('button');
            editButton.textContent = 'Edit';
            editButton.className = 'btn-edit';
            editButton.onclick = () => editUser(user);
            
            const deleteButton = document.createElement('button');
            deleteButton.textContent = 'Hapus';
            deleteButton.className = 'btn-danger';
            deleteButton.onclick = () => deleteUser(user.id);
            
            actionCell.appendChild(editButton);
            actionCell.appendChild(deleteButton);
        });
    } else {
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 6;
        cell.textContent = "Tidak ada data user.";
        cell.style.textAlign = 'center';
    }
}

function showUserModal() {
    document.getElementById('user-modal').style.display = 'block';
    document.getElementById('user-form').reset();
    document.getElementById('user-id').value = '';
    document.getElementById('user-modal-title').textContent = 'Tambah User Baru';
    document.getElementById('password-help').style.display = 'none';
    document.getElementById('user-password').required = true;

    // Populate line options
    const lineSelect = document.getElementById('user-line');
    lineSelect.innerHTML = '<option value="">Pilih Line</option>';
    
    Object.keys(allLines).forEach(line => {
        const option = document.createElement('option');
        option.value = line;
        option.textContent = line;
        lineSelect.appendChild(option);
    });
    
    // Add "all" option for admin
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'all (Semua Line)';
    lineSelect.appendChild(allOption);

    // Add multiple lines option for leader
    const multipleOption = document.createElement('option');
    multipleOption.value = 'multiple';
    multipleOption.textContent = 'multiple (Beberapa Line)';
    lineSelect.appendChild(multipleOption);
}

function editUser(user) {
    document.getElementById('user-id').value = user.id;
    document.getElementById('user-username').value = user.username;
    document.getElementById('user-password').value = '';
    document.getElementById('user-name').value = user.name;
    document.getElementById('user-role').value = user.role;

    document.getElementById('user-modal-title').textContent = 'Edit User';
    document.getElementById('password-help').style.display = 'block';
    document.getElementById('user-password').required = false;

    // Populate line options
    const lineSelect = document.getElementById('user-line');
    lineSelect.innerHTML = '<option value="">Pilih Line</option>';
    
    Object.keys(allLines).forEach(line => {
        const option = document.createElement('option');
        option.value = line;
        option.textContent = line;
        lineSelect.appendChild(option);
    });
    
    // Add "all" option for admin
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'all (Semua Line)';
    lineSelect.appendChild(allOption);

    // Add multiple lines option for leader
    const multipleOption = document.createElement('option');
    multipleOption.value = 'multiple';
    multipleOption.textContent = 'multiple (Beberapa Line)';
    lineSelect.appendChild(multipleOption);

    // Set current value
    lineSelect.value = user.line;
}

async function saveUser(event) {
    event.preventDefault();
    
    const userData = {
        username: document.getElementById('user-username').value,
        password: document.getElementById('user-password').value,
        name: document.getElementById('user-name').value,
        line: document.getElementById('user-line').value,
        role: document.getElementById('user-role').value
    };
    
    const userId = document.getElementById('user-id').value;
    
    try {
        let response;
        if (userId) {
            // Update existing user
            response = await fetch(`/api/users/${userId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(userData)
            });
        } else {
            // Add new user
            response = await fetch('/api/users', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(userData)
            });
        }
        
        if (response.ok) {
            hideUserModal();
            fetchUsers();
            alert(`User berhasil ${userId ? 'diupdate' : 'ditambahkan'}.`);
        } else {
            const error = await response.json();
            throw new Error(error.error || 'Gagal menyimpan user');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Gagal menyimpan user: ' + error.message);
    }
}

async function deleteUser(userId) {
    if (confirm('Apakah Anda yakin ingin menghapus user ini?')) {
        try {
            const response = await fetch(`/api/users/${userId}`, {
                method: 'DELETE'
            });
            
            if (response.ok) {
                alert('User berhasil dihapus.');
                fetchUsers();
            } else {
                const error = await response.json();
                throw new Error(error.error || 'Gagal menghapus user');
            }
        } catch (error) {
            console.error('Error:', error);
            alert('Gagal menghapus user: ' + error.message);
        }
    }
}

function hideUserModal() {
    document.getElementById('user-modal').style.display = 'none';
}

// Modal Functions
function showModal() {
    document.getElementById('operator-modal').style.display = 'block';
}

function hideModal() {
    document.getElementById('operator-modal').style.display = 'none';
    document.getElementById('operator-form').reset();
    document.getElementById('operator-id').value = '';
    document.getElementById('modal-title').textContent = 'Tambah Operator';
}

function editOperator(operator) {
    document.getElementById('operator-id').value = operator.id;
    document.getElementById('operator-name').value = operator.name;
    document.getElementById('operator-position').value = operator.position;
    document.getElementById('operator-target').value = operator.target;
    document.getElementById('operator-output').value = operator.output;
    document.getElementById('operator-defect').value = operator.defect;
    document.getElementById('operator-status').value = operator.status;
    
    document.getElementById('modal-title').textContent = 'Edit Operator';
    showModal();
}

async function deleteOperator(operatorId) {
    if (!currentLine) return;
    
    if (confirm('Apakah Anda yakin ingin menghapus operator ini?')) {
        try {
            const response = await fetch(`/api/operators/${currentLine}/${operatorId}`, {
                method: 'DELETE'
            });
            
            if (response.ok) {
                alert('Operator berhasil dihapus.');
                fetchOperators();
            } else {
                throw new Error('Gagal menghapus operator');
            }
        } catch (error) {
            console.error('Error:', error);
            alert('Gagal menghapus operator.');
        }
    }
}

async function saveOperator(event) {
    event.preventDefault();
    
    if (!currentLine) {
        alert('Pilih line terlebih dahulu!');
        return;
    }
    
    const operatorData = {
        name: document.getElementById('operator-name').value,
        position: document.getElementById('operator-position').value,
        target: parseInt(document.getElementById('operator-target').value),
        output: parseInt(document.getElementById('operator-output').value),
        defect: parseInt(document.getElementById('operator-defect').value),
        status: document.getElementById('operator-status').value
    };
    
    const operatorId = document.getElementById('operator-id').value;
    
    try {
        let response;
        if (operatorId) {
            // Update existing operator
            response = await fetch(`/api/operators/${currentLine}/${operatorId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(operatorData)
            });
        } else {
            // Add new operator
            response = await fetch(`/api/operators/${currentLine}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(operatorData)
            });
        }
        
        if (response.ok) {
            hideModal();
            fetchOperators();
            alert(`Operator berhasil ${operatorId ? 'diupdate' : 'ditambahkan'}.`);
        } else {
            throw new Error('Gagal menyimpan operator');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Gagal menyimpan operator.');
    }
}

// Line Management Functions
function showLineModal() {
    document.getElementById('line-modal').style.display = 'block';
    document.getElementById('line-form').reset();
    document.getElementById('line-productivity').value = '0';
}

function showEditLineModal(lineName) {
    const lineData = allLines[lineName];
    if (!lineData) return;

    document.getElementById('edit-line-modal').style.display = 'block';
    document.getElementById('edit-line-name').textContent = lineName;
    
    document.getElementById('edit-line-label').value = lineData.labelWeek || '';
    document.getElementById('edit-line-model').value = lineData.model || '';
    document.getElementById('edit-line-date').value = lineData.date || '';
    document.getElementById('edit-line-target').value = lineData.target || 0;
    document.getElementById('edit-line-productivity').value = lineData.productivity || 0;
}

function hideLineModals() {
    document.getElementById('line-modal').style.display = 'none';
    document.getElementById('edit-line-modal').style.display = 'none';
}

// Calculate productivity based on target
function calculateProductivity(target) {
    return Math.round(target / 9); // 9 working hours
}

// Add new line
async function addNewLine(event) {
    event.preventDefault();
    
    const lineData = {
        lineName: document.getElementById('line-name').value,
        labelWeek: document.getElementById('line-label').value,
        model: document.getElementById('line-model').value,
        date: document.getElementById('line-date').value,
        target: parseInt(document.getElementById('line-target').value)
    };

    // Validasi
    if (lineData.target < 0) {
        alert('Target harus lebih dari 0');
        return;
    }

    try {
        const response = await fetch('/api/lines', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(lineData)
        });

        if (response.ok) {
            const result = await response.json();
            hideLineModals();
            alert(`Line berhasil ditambahkan!\n${result.calculated.message}`);
            fetchLines(); // Refresh line list
        } else {
            const error = await response.json();
            throw new Error(error.error || 'Gagal menambah line');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Gagal menambah line: ' + error.message);
    }
}

// Update existing line
async function updateLine(event) {
    event.preventDefault();
    
    const lineName = document.getElementById('edit-line-name').textContent;
    const lineData = {
        labelWeek: document.getElementById('edit-line-label').value,
        model: document.getElementById('edit-line-model').value,
        date: document.getElementById('edit-line-date').value,
        target: parseInt(document.getElementById('edit-line-target').value)
    };

    // Validasi
    if (lineData.target < 0) {
        alert('Target harus lebih dari 0');
        return;
    }

    try {
        const response = await fetch(`/api/lines/${lineName}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(lineData)
        });

        if (response.ok) {
            const result = await response.json();
            hideLineModals();
            alert(`Line berhasil diupdate!\n${result.calculated.message}`);
            fetchLines(); // Refresh line list
            if (currentLine === lineName) {
                fetchLineData(currentLine); // Refresh current line data
            }
        } else {
            const error = await response.json();
            throw new Error(error.error || 'Gagal update line');
        }
  } catch (error) {
        console.error('Error:', error);
        alert('Gagal update line: ' + error.message);
    }
}

// Delete line
async function deleteLine() {
    const lineName = document.getElementById('edit-line-name').textContent;
    
    if (!confirm(`Apakah Anda yakin ingin menghapus line ${lineName}?`)) {
        return;
    }

    try {
        const response = await fetch(`/api/lines/${lineName}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            hideLineModals();
            alert('Line berhasil dihapus!');
            fetchLines(); // Refresh line list
            if (currentLine === lineName) {
                currentLine = '';
                // Reset dashboard
                document.querySelectorAll('.line-btn').forEach(btn => btn.classList.remove('active'));
                document.getElementById('line').textContent = 'LINE: -';
                document.getElementById('label-week').textContent = 'LABEL/WEEK: -';
                document.getElementById('model').textContent = '-';
                document.getElementById('date').textContent = 'DATE: -';
                // Reset values
                ['target', 'productivity', 'output-day', 'defect-day'].forEach(id => {
                    document.getElementById(id).textContent = '0';
                });
                document.getElementById('achievement').textContent = '0.00%';
                document.getElementById('defect-rate').textContent = '0.00%';
                document.getElementById('operator-table-body').innerHTML = '<tr><td colspan="9" style="text-align: center; color: #888;">Tidak ada data operator.</td></tr>';
                document.getElementById('hourly-table-body').innerHTML = '<tr><td colspan="9" style="text-align: center; color: #888;">Data per jam belum tersedia.</td></tr>';
            }
        } else {
            const error = await response.json();
            throw new Error(error.error || 'Gagal hapus line');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Gagal menghapus line: ' + error.message);
    }
}

// Export Excel function
async function exportToExcel() {
    if (!currentLine) {
        alert('Pilih line terlebih dahulu!');
        return;
    }

    try {
        const response = await fetch(`/api/export/${currentLine}`);
        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = `Production_Report_${currentLine}_${new Date().toISOString().split('T')[0]}.xlsx`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
        } else {
            throw new Error('Gagal export data');
        }
    } catch (error) {
        console.error('Export error:', error);
        alert('Gagal mengexport data ke Excel.');
    }
}

// Defect Management Functions
async function fetchDefects() {
    try {
        const response = await fetch('/api/defect-config');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const defectConfig = await response.json();
        defectTypes = defectConfig.defectTypes || [];
        defectAreas = defectConfig.defectAreas || [];
        updateDefectTables();
    } catch (error) {
        console.error("Gagal mengambil data defects:", error);
    }
}

function updateDefectTables() {
    updateDefectTypeTable();
    updateDefectAreaTable();
}

function updateDefectTypeTable() {
    const tableBody = document.getElementById('defect-type-table-body');
    tableBody.innerHTML = '';

    if (defectTypes.length > 0) {
        defectTypes.forEach((type, index) => {
            const row = tableBody.insertRow();
            row.insertCell().textContent = index + 1;
            row.insertCell().textContent = type.name;

            // Status
            const statusCell = row.insertCell();
            statusCell.textContent = type.active ? 'Aktif' : 'Nonaktif';
            statusCell.className = type.active ? 'status-active' : 'status-off';

            // Aksi
            const actionCell = row.insertCell();
            const editButton = document.createElement('button');
            editButton.textContent = 'Edit';
            editButton.className = 'btn-edit';
            editButton.onclick = () => editDefectType(type);

            const deleteButton = document.createElement('button');
            deleteButton.textContent = 'Hapus';
            deleteButton.className = 'btn-danger';
            deleteButton.onclick = () => deleteDefectType(type.id);

            actionCell.appendChild(editButton);
            actionCell.appendChild(deleteButton);
        });
    } else {
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 4;
        cell.textContent = "Tidak ada data jenis defect.";
        cell.style.textAlign = 'center';
    }
}

function updateDefectAreaTable() {
    const tableBody = document.getElementById('defect-area-table-body');
    tableBody.innerHTML = '';

    if (defectAreas.length > 0) {
        defectAreas.forEach((area, index) => {
            const row = tableBody.insertRow();
            row.insertCell().textContent = index + 1;
            row.insertCell().textContent = area.name;

            // Status
            const statusCell = row.insertCell();
            statusCell.textContent = area.active ? 'Aktif' : 'Nonaktif';
            statusCell.className = area.active ? 'status-active' : 'status-off';

            // Aksi
            const actionCell = row.insertCell();
            const editButton = document.createElement('button');
            editButton.textContent = 'Edit';
            editButton.className = 'btn-edit';
            editButton.onclick = () => editDefectArea(area);

            const deleteButton = document.createElement('button');
            deleteButton.textContent = 'Hapus';
            deleteButton.className = 'btn-danger';
            deleteButton.onclick = () => deleteDefectArea(area.id);

            actionCell.appendChild(editButton);
            actionCell.appendChild(deleteButton);
        });
    } else {
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 4;
        cell.textContent = "Tidak ada data area defect.";
        cell.style.textAlign = 'center';
    }
}

function showDefectTypeModal() {
    document.getElementById('defect-type-modal').style.display = 'block';
    document.getElementById('defect-type-form').reset();
    document.getElementById('defect-type-id').value = '';
    document.getElementById('defect-type-active').value = 'true';
    document.getElementById('defect-type-modal-title').textContent = 'Tambah Jenis Defect';
}

function editDefectType(type) {
    document.getElementById('defect-type-id').value = type.id;
    document.getElementById('defect-type-name').value = type.name;
    document.getElementById('defect-type-active').value = type.active.toString();
    document.getElementById('defect-type-modal-title').textContent = 'Edit Jenis Defect';
    document.getElementById('defect-type-modal').style.display = 'block';
}

function showDefectAreaModal() {
    document.getElementById('defect-area-modal').style.display = 'block';
    document.getElementById('defect-area-form').reset();
    document.getElementById('defect-area-id').value = '';
    document.getElementById('defect-area-active').value = 'true';
    document.getElementById('defect-area-modal-title').textContent = 'Tambah Area Defect';
}

function editDefectArea(area) {
    document.getElementById('defect-area-id').value = area.id;
    document.getElementById('defect-area-name').value = area.name;
    document.getElementById('defect-area-active').value = area.active.toString();
    document.getElementById('defect-area-modal-title').textContent = 'Edit Area Defect';
    document.getElementById('defect-area-modal').style.display = 'block';
}

async function saveDefectType(event) {
    event.preventDefault();

    const typeData = {
        name: document.getElementById('defect-type-name').value,
        active: document.getElementById('defect-type-active').value === 'true'
    };

    const typeId = document.getElementById('defect-type-id').value;

    try {
        let response;
        if (typeId) {
            response = await fetch(`/api/defect-types/${typeId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(typeData)
            });
        } else {
            response = await fetch('/api/defect-types', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(typeData)
            });
        }

        if (response.ok) {
            hideDefectTypeModal();
            fetchDefects();
            alert(`Jenis defect berhasil ${typeId ? 'diupdate' : 'ditambahkan'}.`);
        } else {
            throw new Error('Gagal menyimpan jenis defect');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Gagal menyimpan jenis defect: ' + error.message);
    }
}

async function saveDefectArea(event) {
    event.preventDefault();

    const areaData = {
        name: document.getElementById('defect-area-name').value,
        active: document.getElementById('defect-area-active').value === 'true'
    };

    const areaId = document.getElementById('defect-area-id').value;

    try {
        let response;
        if (areaId) {
            response = await fetch(`/api/defect-areas/${areaId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(areaData)
            });
        } else {
            response = await fetch('/api/defect-areas', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(areaData)
            });
        }

        if (response.ok) {
            hideDefectAreaModal();
            fetchDefects();
            alert(`Area defect berhasil ${areaId ? 'diupdate' : 'ditambahkan'}.`);
        } else {
            throw new Error('Gagal menyimpan area defect');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Gagal menyimpan area defect: ' + error.message);
    }
}

async function deleteDefectType(typeId) {
    if (confirm('Apakah Anda yakin ingin menghapus jenis defect ini?')) {
        try {
            const response = await fetch(`/api/defect-types/${typeId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                alert('Jenis defect berhasil dihapus.');
                fetchDefects();
            } else {
                throw new Error('Gagal menghapus jenis defect');
            }
        } catch (error) {
            console.error('Error:', error);
            alert('Gagal menghapus jenis defect: ' + error.message);
        }
    }
}

async function deleteDefectArea(areaId) {
    if (confirm('Apakah Anda yakin ingin menghapus area defect ini?')) {
        try {
            const response = await fetch(`/api/defect-areas/${areaId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                alert('Area defect berhasil dihapus.');
                fetchDefects();
            } else {
                throw new Error('Gagal menghapus area defect');
            }
        } catch (error) {
            console.error('Error:', error);
            alert('Gagal menghapus area defect: ' + error.message);
        }
    }
}

function hideDefectTypeModal() {
    document.getElementById('defect-type-modal').style.display = 'none';
}

function hideDefectAreaModal() {
    document.getElementById('defect-area-modal').style.display = 'none';
}

// History Data Functions
async function fetchHistoryFiles() {
    try {
        const response = await fetch('/api/history/files');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const historyFiles = await response.json();
        updateHistoryTable(historyFiles);
    } catch (error) {
        console.error("Gagal mengambil data history:", error);
    }
}

function updateHistoryTable(historyFiles) {
    const tableBody = document.getElementById('history-table-body');
    tableBody.innerHTML = '';

    if (historyFiles && historyFiles.length > 0) {
        historyFiles.forEach((file, index) => {
            const row = tableBody.insertRow();
            
            // No
            row.insertCell().textContent = index + 1;
            
            // Tanggal Backup
            const dateCell = row.insertCell();
            const date = new Date(file.date);
            dateCell.textContent = date.toLocaleDateString('id-ID', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
            
            // Jumlah Line (akan diisi setelah load data)
            const lineCountCell = row.insertCell();
            lineCountCell.textContent = 'Loading...';
            lineCountCell.id = `line-count-${file.date}`;
            
            // Ukuran File
            const sizeCell = row.insertCell();
            sizeCell.textContent = formatFileSize(file.size);
            
            // Aksi
            const actionCell = row.insertCell();
            
            const exportButton = document.createElement('button');
            exportButton.textContent = 'Export Excel';
            exportButton.className = 'btn-primary';
            exportButton.onclick = () => exportHistoryData(file.filename, file.date);
            
            actionCell.appendChild(exportButton);

            // Load line count
            loadLineCount(file.filename, file.date);
        });
    } else {
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 5;
        cell.textContent = "Tidak ada data history.";
        cell.style.textAlign = 'center';
    }
}

async function loadLineCount(filename, date) {
    try {
        const response = await fetch(`/api/history/${filename}`);
        if (response.ok) {
            const historyData = await response.json();
            const lineCount = Object.keys(historyData.lines || {}).length;
            document.getElementById(`line-count-${date}`).textContent = `${lineCount} Line`;
        }
    } catch (error) {
        console.error('Error loading line count:', error);
        document.getElementById(`line-count-${date}`).textContent = 'Error';
    }
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function viewHistoryData(filename, date) {
    try {
        const response = await fetch(`/api/history/${filename}`);
        if (!response.ok) {
            throw new Error('Gagal mengambil data history');
        }
        
        currentHistoryData = await response.json();
        currentHistoryFile = filename;
        
        // Update modal title
        document.getElementById('history-date').textContent = new Date(date).toLocaleDateString('id-ID');
        
        // Populate line selector
        updateHistoryLineSelector(currentHistoryData.lines);
        
        // Show modal
        document.getElementById('history-detail-modal').style.display = 'block';
        
    } catch (error) {
        console.error('Error viewing history data:', error);
        alert('Gagal memuat data history: ' + error.message);
    }
}

function updateHistoryLineSelector(lines) {
    const lineButtons = document.getElementById('history-line-buttons');
    lineButtons.innerHTML = '';

    Object.keys(lines).forEach(lineName => {
        const lineData = lines[lineName];
        const button = document.createElement('button');
        button.className = 'line-btn';
        button.innerHTML = `
            <div>${lineName}</div>
            <small style="font-size: 0.8em; opacity: 0.8;">
                Output: ${lineData.outputDay} | Achievement: ${lineData.achivementPercentage}%
            </small>
        `;
        button.onclick = () => {
            updateHistoryDashboard(lineName, lineData);
        };

        lineButtons.appendChild(button);
    });

    // Load first line by default
    const firstLine = Object.keys(lines)[0];
    if (firstLine) {
        updateHistoryDashboard(firstLine, lines[firstLine]);
    }
}

function updateHistoryDashboard(lineName, lineData) {
    // Update Header Info
    document.getElementById('history-line').textContent = `LINE: ${lineName}`;
    document.getElementById('history-label-week').textContent = `LABEL/WEEK: ${lineData.labelWeek || 'N/A'}`;
    document.getElementById('history-model').textContent = lineData.model || 'N/A';
    document.getElementById('history-date-detail').textContent = `DATE: ${lineData.date || 'N/A'}`;

    // Update Main Values
    document.getElementById('history-target').textContent = lineData.target || 0;
    document.getElementById('history-productivity').textContent = `${lineData.productivity || 0}/jam`;
    document.getElementById('history-output-day').textContent = lineData.outputDay || 0;
    document.getElementById('history-defect-day').textContent = lineData.defectDay || 0;

    // Update Percentages & Color Logic
    const achievementElement = document.getElementById('history-achievement');
    const defectRateElement = document.getElementById('history-defect-rate');
    
    const achievement = (lineData.achivementPercentage || 0.00).toFixed(2);
    const defectRate = (lineData.defectRatePercentage || 0.00).toFixed(2);

    achievementElement.textContent = `${achievement}%`;
    defectRateElement.textContent = `${defectRate}%`;

    if (parseFloat(achievement) >= 100) {
        achievementElement.classList.add('green-bg');
        achievementElement.classList.remove('yellow-bg');
    } else {
        achievementElement.classList.add('yellow-bg');
        achievementElement.classList.remove('green-bg');
    }
    
    // Update section titles
    document.getElementById('history-current-line').textContent = lineName;
    document.getElementById('history-hourly-line').textContent = lineName;

    // Update Hourly Data Table
    updateHistoryHourlyTable(lineData.hourly_data);

    // Update operators
    updateHistoryOperatorTable(lineData.operators);
}

function updateHistoryHourlyTable(hourlyData) {
    const tableBody = document.getElementById('history-hourly-table-body');
    tableBody.innerHTML = '';

    if (hourlyData && hourlyData.length > 0) {
        hourlyData.forEach(item => {
            const row = tableBody.insertRow();
            row.insertCell().textContent = item.hour;
            row.insertCell().textContent = item.output;
            row.insertCell().textContent = item.defect;
            
            // Calculate defect rate
            const defectRateCell = row.insertCell();
            const defectRate = item.output > 0 ? ((item.defect / item.output) * 100).toFixed(2) : '0.00';
            defectRateCell.textContent = `${defectRate}%`;
            
            // Color coding for defect rate
            const defectRateValue = parseFloat(defectRate);
            if (defectRateValue > 5) {
                defectRateCell.className = 'efficiency-low';
            } else if (defectRateValue > 2) {
                defectRateCell.className = 'efficiency-medium';
            } else {
                defectRateCell.className = 'efficiency-high';
            }
        });
    } else {
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 4;
        cell.textContent = "Data per jam tidak tersedia.";
    }
}

function updateHistoryOperatorTable(operators) {
    const tableBody = document.getElementById('history-operator-table-body');
    tableBody.innerHTML = '';

    if (operators && operators.length > 0) {
        operators.forEach((operator, index) => {
            const row = tableBody.insertRow();
            
            row.insertCell().textContent = index + 1;
            row.insertCell().textContent = operator.name;
            row.insertCell().textContent = operator.position;
            row.insertCell().textContent = operator.target;
            row.insertCell().textContent = operator.output;
            row.insertCell().textContent = operator.defect;
            
            // Efisiensi
            const efficiencyCell = row.insertCell();
            efficiencyCell.textContent = `${operator.efficiency}%`;
            
            // Add efficiency class based on value
            const efficiency = parseFloat(operator.efficiency);
            if (efficiency >= 95) {
                efficiencyCell.className = 'efficiency-high';
            } else if (efficiency >= 85) {
                efficiencyCell.className = 'efficiency-medium';
            } else {
                efficiencyCell.className = 'efficiency-low';
            }
            
            // Status
            const statusCell = row.insertCell();
            statusCell.textContent = getStatusText(operator.status);
            statusCell.className = `status-${operator.status}`;
        });
    } else {
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 8;
        cell.textContent = "Tidak ada data operator.";
        cell.style.textAlign = 'center';
    }
}

async function createBackup() {
    try {
        const response = await fetch('/api/backup/now', {
            method: 'POST'
        });
        
        if (response.ok) {
            alert('Backup berhasil dibuat!');
            fetchHistoryFiles();
        } else {
            throw new Error('Gagal membuat backup');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Gagal membuat backup: ' + error.message);
    }
}

async function exportHistoryData(filename, date) {
    try {
        const response = await fetch(`/api/history/${filename}/export`);
        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = `Historical_Production_Report_${date}.xlsx`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
        } else {
            throw new Error('Gagal export data history');
        }
    } catch (error) {
        console.error('Export history error:', error);
        alert('Gagal mengexport data history: ' + error.message);
    }
}

// Fungsi untuk menghitung target kumulatif berdasarkan jam sekarang
function calculateCurrentTarget(data) {
    if (!data || !data.hourly_data) return 0;
    
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTime = currentHour + currentMinute / 100; // Format: 8.30 untuk 08:30
    
    console.log(`Waktu sekarang: ${currentHour}:${currentMinute.toString().padStart(2, '0')}`);
    
    // Cari slot jam yang sesuai dengan waktu sekarang
    for (let i = 0; i < data.hourly_data.length; i++) {
        const hourSlot = data.hourly_data[i];
        const hourRange = hourSlot.hour;
        
        console.log(`Memeriksa slot jam: ${hourRange}`);
        
        // Parse jam dari format "07:00 - 08:00" atau "11:00 - 13:00"
        const [startTime, endTime] = hourRange.split(' - ');
        const startHour = parseInt(startTime.split(':')[0]);
        const startMinute = parseInt(startTime.split(':')[1]);
        const endHour = parseInt(endTime.split(':')[0]);
        const endMinute = parseInt(endTime.split(':')[1]);
        
        const startTimeValue = startHour + startMinute / 100;
        const endTimeValue = endHour + endMinute / 100;
        
        // Jika jam sekarang berada dalam rentang jam ini
        if (currentTime >= startTimeValue && currentTime < endTimeValue) {
            console.log(`Target kumulatif untuk ${hourRange}: ${hourSlot.cumulativeTarget}`);
            return hourSlot.cumulativeTarget || 0;
        }
    }
    
    // Jika sudah lewat jam terakhir (setelah 18:00), gunakan target kumulatif terakhir
    if (data.hourly_data.length > 0) {
        const lastTarget = data.hourly_data[data.hourly_data.length - 1].cumulativeTarget || 0;
        console.log(`Menggunakan target terakhir: ${lastTarget}`);
        return lastTarget;
    }
    
    return 0;
}

// Logout function
async function logout() {
    try {
        const response = await fetch('/api/logout', { method: 'POST' });
        if (response.ok) {
            window.location.href = '/';
        }
    } catch (error) {
        console.error('Logout failed:', error);
    }
}

function initializeAdmin() {
    // Load lines data
    fetchLines();
    
    // Initialize tabs
    initTabs();
    
    // Event listeners
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('add-operator-btn').addEventListener('click', showModal);
    document.getElementById('export-excel-btn').addEventListener('click', exportToExcel);
    document.getElementById('refresh-operators-btn').addEventListener('click', fetchOperators);
    
    // User management event listeners
    document.getElementById('add-user-btn').addEventListener('click', showUserModal);
    document.getElementById('refresh-users-btn').addEventListener('click', fetchUsers);
    
    // Defect management event listeners
    document.getElementById('add-type-btn').addEventListener('click', showDefectTypeModal);
    document.getElementById('add-area-btn').addEventListener('click', showDefectAreaModal);
    document.getElementById('refresh-defects-btn').addEventListener('click', fetchDefects);
    
    // History management event listeners
    document.getElementById('create-backup-btn').addEventListener('click', createBackup);
    document.getElementById('refresh-history-btn').addEventListener('click', fetchHistoryFiles);
    document.getElementById('export-history-btn').addEventListener('click', () => {
        if (currentHistoryFile) {
            const date = currentHistoryFile.replace('data_', '').replace('.json', '');
            exportHistoryData(currentHistoryFile, date);
        }
    });
    
    // Modal event listeners
    document.querySelectorAll('.close').forEach(closeBtn => {
        closeBtn.addEventListener('click', function() {
            this.closest('.modal').style.display = 'none';
        });
    });
    
    document.getElementById('cancel-btn').addEventListener('click', hideModal);
    document.getElementById('operator-form').addEventListener('submit', saveOperator);
    
    // User modal event listeners
    document.getElementById('cancel-user-btn').addEventListener('click', hideUserModal);
    document.getElementById('user-form').addEventListener('submit', saveUser);
    
    // Defect modal event listeners
    document.getElementById('cancel-defect-type-btn').addEventListener('click', hideDefectTypeModal);
    document.getElementById('cancel-defect-area-btn').addEventListener('click', hideDefectAreaModal);
    document.getElementById('defect-type-form').addEventListener('submit', saveDefectType);
    document.getElementById('defect-area-form').addEventListener('submit', saveDefectArea);
    
    // Line management event listeners
    document.getElementById('line-target').addEventListener('input', function() {
        const target = parseInt(this.value) || 0;
        document.getElementById('line-productivity').value = calculateProductivity(target);
    });

    document.getElementById('edit-line-target').addEventListener('input', function() {
        const target = parseInt(this.value) || 0;
        document.getElementById('edit-line-productivity').value = calculateProductivity(target);
    });

    document.getElementById('line-form').addEventListener('submit', addNewLine);
    document.getElementById('edit-line-form').addEventListener('submit', updateLine);
    document.getElementById('delete-line-btn').addEventListener('click', deleteLine);
    document.getElementById('cancel-line-btn').addEventListener('click', hideLineModals);
    document.getElementById('cancel-edit-line-btn').addEventListener('click', hideLineModals);
    
    // Close modals when clicking outside
    window.addEventListener('click', function(event) {
        if (event.target.classList.contains('modal')) {
            event.target.style.display = 'none';
        }
    });
    
    // Timer untuk auto-refresh
    setInterval(() => {
        if (currentLine) {
            fetchLineData(currentLine);
        }
    }, 5000);
}

// Initialize admin dashboard
document.addEventListener('DOMContentLoaded', checkAuth);