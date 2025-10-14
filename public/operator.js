// public/operator.js

let currentUser = null;
let currentLine = '';

// Check authentication dan ambil data line
async function initializeOperator() {
    try {
        console.log('Initializing operator...');
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
        updateHourlyInputs(data.hourly_data);
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
        });
    } else {
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 3;
        cell.textContent = "Data per jam belum tersedia.";
        cell.style.textAlign = 'center';
        cell.style.color = '#888';
    }
}

function updateHourlyInputs(hourlyData) {
    const hourlyInputs = document.getElementById('hourly-inputs');
    hourlyInputs.innerHTML = '';
    
    if (!hourlyData || hourlyData.length === 0) {
        hourlyInputs.innerHTML = '<div style="text-align: center; color: #888; padding: 20px;">Data per jam tidak tersedia.</div>';
        return;
    }
    
    // Buat input fields untuk setiap jam
    hourlyData.forEach((hour, index) => {
        const hourDiv = document.createElement('div');
        hourDiv.className = 'hour-input-group';
        hourDiv.innerHTML = `
            <div class="hour-label">${hour.hour || `Jam ${index + 1}`}</div>
            <div class="hour-inputs">
                <input type="number" id="hour-output-${index}" value="${hour.output || 0}" placeholder="Output" min="0" style="color: #000;">
                <input type="number" id="hour-defect-${index}" value="${hour.defect || 0}" placeholder="Defect" min="0" style="color: #000;">
                <button type="button" class="btn-update" data-hour="${index}">Update</button>
            </div>
        `;
        hourlyInputs.appendChild(hourDiv);
    });
    
    // Add event listeners untuk update buttons
    document.querySelectorAll('.btn-update').forEach(btn => {
        btn.addEventListener('click', function() {
            const hourIndex = this.getAttribute('data-hour');
            const output = document.getElementById(`hour-output-${hourIndex}`).value;
            const defect = document.getElementById(`hour-defect-${hourIndex}`).value;
            
            if (output !== '' && defect !== '') {
                updateHourlyData(hourIndex, output, defect);
            } else {
                alert('Harap isi output dan defect!');
            }
        });
    });
}

async function updateHourlyData(hourIndex, output, defect) {
    try {
        console.log('Updating hourly data:', { hourIndex, output, defect });
        
        const response = await fetch(`/api/update-hourly/${currentLine}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                hourIndex: parseInt(hourIndex),
                output: parseInt(output),
                defect: parseInt(defect)
            })
        });

        if (response.ok) {
            const data = await response.json();
            alert('Data berhasil diupdate!');
            fetchLineData(); // Refresh data
        } else {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Gagal update data');
        }
    } catch (error) {
        console.error('Error updating hourly data:', error);
        alert('Gagal mengupdate data: ' + error.message);
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

function showError(message) {
    // Anda bisa implementasikan notifikasi error yang lebih baik di sini
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
    console.log('DOM loaded, initializing operator...');
    
    initializeOperator();
    
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('refresh-data-btn').addEventListener('click', function() {
        console.log('Manual refresh triggered');
        fetchLineData();
    });
    
    // Auto-refresh setiap 30 detik
    setInterval(fetchLineData, 30000);
    
    console.log('Event listeners registered');
});