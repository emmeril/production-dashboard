// public/operator.js - Updated dengan Multiple Defect Details

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

function updateDashboard(data) {
    console.log('Updating dashboard with data:', data);
    
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

    // Update Hourly Data Table dengan defect details
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
            const defectDetailsCell = row.insertCell();
            if (item.defectDetails && item.defectDetails.length > 0) {
                defectDetailsCell.innerHTML = item.defectDetails.map(defect => 
                    `<div style="margin-bottom: 5px; font-size: 0.8rem;">
                        <strong>${defect.quantity}x</strong> - ${defect.type || '-'} (${defect.area || '-'})
                        ${defect.notes ? `<br><em>${defect.notes}</em>` : ''}
                    </div>`
                ).join('');
            } else {
                defectDetailsCell.textContent = '-';
            }
        });
    } else {
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 7;
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
    
    // Auto-refresh setiap 30 detik untuk update target berdasarkan jam
    setInterval(fetchLineData, 30000);
    
    console.log('Event listeners registered');
});