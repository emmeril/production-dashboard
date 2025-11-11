// public/leader.js - Updated dengan Target Kumulatif Berdasarkan Jam

let currentLine = '';
let currentUser = null;
let assignedLines = [];

// Check authentication
async function checkAuth() {
    try {
        const response = await fetch('/api/current-user');
        if (response.ok) {
            currentUser = await response.json();
            if (currentUser.role !== 'leader') {
                if (currentUser.role === 'admin') {
                    window.location.href = '/admin';
                } else {
                    window.location.href = `/line/${currentUser.line}`;
                }
                return;
            }
            document.getElementById('leader-name').textContent = currentUser.name;
            
            // Parse assigned lines
            assignedLines = currentUser.line.split(',');
            
            initializeLeader();
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

    // Only show assigned lines
    assignedLines.forEach(lineName => {
        if (lines[lineName]) {
            const lineData = lines[lineName];
            const button = document.createElement('button');
            button.className = 'line-btn';
            button.innerHTML = `
                <div>${lineName}</div>
                <small style="font-size: 0.8em; opacity: 0.8;">
                    Target: ${lineData.target} | Target/Jam: ${lineData.targetPerHour}
                </small>
            `;
            button.onclick = () => {
                currentLine = lineName;
                fetchLineData(lineName);
                updateLineButtons();
            };

            lineButtons.appendChild(button);
        }
    });

    if (!currentLine && assignedLines.length > 0) {
        currentLine = assignedLines[0];
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

// Fungsi untuk menghitung target kumulatif berdasarkan jam sekarang
// Fungsi calculateCurrentTarget yang diperbarui (untuk operator.js, admin.js, leader.js)
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

    // Update Hourly Data Table dengan target kumulatif
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
        });
    } else {
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 6;
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

function initializeLeader() {
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
        if (event.target === document.getElementById('operator-modal')) {
            hideModal();
        }
    });
    
    // Timer untuk auto-refresh untuk update target berdasarkan jam
    setInterval(() => {
        if (currentLine) {
            fetchLineData(currentLine);
        }
    }, 5000);
}

// Initialize leader dashboard
document.addEventListener('DOMContentLoaded', checkAuth);