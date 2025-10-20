// public/operator.js

let currentUser = null;
let currentLine = '';

// Check authentication dan ambil data line
async function initializeOperator() {
    try {
        console.log('Initializing operator dashboard...');
        const response = await fetch('/api/current-user');
        if (response.ok) {
            currentUser = await response.json();
            console.log('Current user:', currentUser);
            
            if (currentUser.role !== 'operator') {
                window.location.href = '/';
                return;
            }
            
            currentLine = currentUser.line;
            document.getElementById('operator-name').textContent = currentUser.name;
            document.getElementById('operator-line').textContent = currentLine;
            
            // Set link untuk input data
            document.getElementById('input-data-link').href = `/input/${currentLine}`;
            
            await fetchLineData();
        } else {
            console.log('Not logged in, redirecting to login page');
            window.location.href = '/';
        }
    } catch (error) {
        console.error('Auth check failed:', error);
        window.location.href = '/';
    }
}

async function fetchLineData() {
    if (!currentLine) {
        console.error('No current line defined');
        return;
    }

    try {
        console.log('Fetching data for line:', currentLine);
        const response = await fetch(`/api/line/${currentLine}`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('Data received:', data);
        updateDashboard(data);
    } catch (error) {
        console.error("Gagal mengambil data line:", error);
        showError('Gagal mengambil data produksi. Silakan refresh halaman.');
    }
}

function updateDashboard(data) {
    console.log('Updating dashboard with data:', data);
    
    // Update Header Info
    document.getElementById('line').textContent = `LINE: ${data.line || 'N/A'}`;
    document.getElementById('label-week').textContent = `LABEL/WEEK: ${data.labelWeek || 'N/A'}`;
    document.getElementById('model').textContent = data.model || 'N/A';
    document.getElementById('date').textContent = `DATE: ${data.date || 'N/A'}`;

    // Update Main Values
    document.getElementById('target').textContent = data.target || 0;
    document.getElementById('productivity').textContent = `${data.productivity || 0}/H`;
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

    // Update Hourly Data Table
    updateHourlyTable(data.hourly_data);

    // Update operators table (read-only untuk operator)
    updateOperatorTable(data.operators);
}

function updateHourlyTable(hourlyData) {
    const tableBody = document.getElementById('hourly-table-body');
    tableBody.innerHTML = '';

    if (hourlyData && hourlyData.length > 0) {
        hourlyData.forEach(item => {
            const row = tableBody.insertRow();
            row.insertCell().textContent = item.hour || '-';
            row.insertCell().textContent = item.output || 0;
            row.insertCell().textContent = item.defect || 0;
            
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
        cell.style.textAlign = 'center';
        cell.style.color = '#888';
    }
}

function updateOperatorTable(operators) {
    const tableBody = document.getElementById('operator-table-body');
    tableBody.innerHTML = '';

    if (operators && operators.length > 0) {
        operators.forEach((operator, index) => {
            const row = tableBody.insertRow();
            
            row.insertCell().textContent = index + 1;
            row.insertCell().textContent = operator.name || '-';
            row.insertCell().textContent = operator.position || '-';
            row.insertCell().textContent = operator.target || 0;
            row.insertCell().textContent = operator.output || 0;
            row.insertCell().textContent = operator.defect || 0;
            
            const efficiencyCell = row.insertCell();
            const efficiency = operator.efficiency || 0;
            efficiencyCell.textContent = `${efficiency}%`;
            
            if (efficiency >= 95) {
                efficiencyCell.className = 'efficiency-high';
            } else if (efficiency >= 85) {
                efficiencyCell.className = 'efficiency-medium';
            } else {
                efficiencyCell.className = 'efficiency-low';
            }
            
            const statusCell = row.insertCell();
            statusCell.textContent = getStatusText(operator.status);
            statusCell.className = `status-${operator.status || 'off'}`;
        });
    } else {
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 8;
        cell.textContent = "Tidak ada data operator.";
        cell.style.textAlign = 'center';
        cell.style.color = '#888';
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

// Export Excel function
async function exportToExcel() {
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

function showError(message) {
    console.error('Error:', message);
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ff4444;
        color: white;
        padding: 15px;
        border-radius: 5px;
        z-index: 10000;
    `;
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);
    
    setTimeout(() => {
        document.body.removeChild(errorDiv);
    }, 5000);
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

// Event listeners
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded, initializing operator dashboard...');
    
    initializeOperator();
    
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('refresh-data-btn').addEventListener('click', function() {
        console.log('Manual refresh triggered');
        fetchLineData();
    });
    
    document.getElementById('export-excel-btn').addEventListener('click', exportToExcel);
    
    // Auto-refresh setiap 30 detik
    setInterval(fetchLineData, 30000);
    
    console.log('Event listeners registered');
});