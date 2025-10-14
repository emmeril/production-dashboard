// public/admin.js

let currentLine = '';
let currentUser = null;

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
    const lineButtons = document.getElementById('line-buttons');
    lineButtons.innerHTML = '';

    Object.keys(lines).forEach(line => {
        const button = document.createElement('button');
        button.className = 'line-btn';
        button.textContent = line;
        button.onclick = () => {
            currentLine = line;
            fetchLineData(line);
            updateLineButtons();
        };
        
        lineButtons.appendChild(button);
    });

    // Set default line jika belum ada
    if (!currentLine && Object.keys(lines).length > 0) {
        currentLine = Object.keys(lines)[0];
        fetchLineData(currentLine);
    }
    
    updateLineButtons();
}

function updateLineButtons() {
    document.querySelectorAll('.line-btn').forEach(btn => {
        if (btn.textContent === currentLine) {
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

    // Update Main Values
    document.getElementById('target').textContent = data.target || 0;
    document.getElementById('productivity').textContent = data.productivity || 0;
    document.getElementById('defect-target').textContent = data.defectTarget || 0;
    document.getElementById('output-day').textContent = data.outputDay || 0;
    document.getElementById('defect-day').textContent = data.defectDay || 0;

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
    
    // Update Hourly Data Table
    const tableBody = document.getElementById('hourly-table-body');
    tableBody.innerHTML = '';

    if (data.hourly_data && data.hourly_data.length > 0) {
        data.hourly_data.forEach(item => {
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

    // Update section titles
    document.getElementById('current-line').textContent = data.line;
    document.getElementById('hourly-line').textContent = data.line;
    document.getElementById('modal-line').textContent = data.line;

    // Update operators
    if (data.operators) {
        updateOperatorTable(data.operators);
    } else {
        fetchOperators();
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
    
    // Close modal when clicking outside
    window.addEventListener('click', function(event) {
        const modal = document.getElementById('operator-modal');
        if (event.target === modal) {
            hideModal();
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