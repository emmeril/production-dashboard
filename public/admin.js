// public/admin.js

let currentLine = '';
let currentUser = null;
let allLines = {};

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

async function fetchLines() {
    try {
        const response = await fetch('/api/lines');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const lines = await response.json();
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

function updateDashboard(data) {
    // Update Header Info
    document.getElementById('line').textContent = `LINE: ${data.line || 'N/A'}`;
    document.getElementById('label-week').textContent = `LABEL/WEEK: ${data.labelWeek || 'N/A'}`;
    document.getElementById('model').textContent = data.model || 'N/A';
    document.getElementById('date').textContent = `DATE: ${data.date || 'N/A'}`;

    // Update Main Values dengan penjelasan
    document.getElementById('target').textContent = data.target || 0;
    document.getElementById('productivity').textContent = `${data.productivity || 0}/jam`;
    document.getElementById('output-day').textContent = data.outputDay || 0;
    document.getElementById('defect-day').textContent = data.defectDay || 0; // Total defect keseluruhan

    // Update Percentages & Color Logic
    const achievementElement = document.getElementById('achievement');
    const defectRateElement = document.getElementById('defect-rate');
    
    const achievement = (data.achivementPercentage || 0.00).toFixed(2);
    const defectRate = (data.defectRatePercentage || 0.00).toFixed(2);

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
    document.getElementById('current-line').textContent = data.line;
    document.getElementById('hourly-line').textContent = data.line;
    document.getElementById('modal-line').textContent = data.line;

    // Update Hourly Data Table
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
        cell.textContent = "Data per jam belum tersedia.";
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
                document.getElementById('hourly-table-body').innerHTML = '<tr><td colspan="4" style="text-align: center; color: #888;">Data per jam belum tersedia.</td></tr>';
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
    
    // Event listeners
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('add-operator-btn').addEventListener('click', showModal);
    document.getElementById('export-excel-btn').addEventListener('click', exportToExcel);
    document.getElementById('refresh-operators-btn').addEventListener('click', fetchOperators);
    
    // Modal event listeners
    document.querySelector('.close').addEventListener('click', hideModal);
    document.getElementById('cancel-btn').addEventListener('click', hideModal);
    document.getElementById('operator-form').addEventListener('submit', saveOperator);
    
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
        if (event.target === document.getElementById('operator-modal')) {
            hideModal();
        }
        if (event.target === document.getElementById('line-modal')) {
            hideLineModals();
        }
        if (event.target === document.getElementById('edit-line-modal')) {
            hideLineModals();
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