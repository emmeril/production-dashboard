// public/input.js

let currentUser = null;
let currentLine = '';

// Check authentication dan ambil data line
async function initializeInput() {
    try {
        console.log('Initializing input page...');
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
            document.getElementById('current-line').textContent = currentLine;
            
            // Set link untuk dashboard
            document.getElementById('dashboard-link').href = `/line/${currentLine}`;
            
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
        updateHourlyInputs(data.hourly_data);
        updateQuickStats(data.hourly_data);
    } catch (error) {
        console.error("Gagal mengambil data line:", error);
        showError('Gagal mengambil data produksi. Silakan refresh halaman.');
    }
}

function updateHourlyInputs(hourlyData) {
    const hourlyInputs = document.getElementById('hourly-inputs');
    hourlyInputs.innerHTML = '';
    
    if (!hourlyData || hourlyData.length === 0) {
        hourlyInputs.innerHTML = '<div style="text-align: center; color: #888; padding: 20px;">Data per jam tidak tersedia.</div>';
        return;
    }
    
    // Buat input fields untuk setiap jam (07:00-17:00)
    hourlyData.forEach((hour, index) => {
        const hourDiv = document.createElement('div');
        hourDiv.className = 'hour-input-group';
        hourDiv.innerHTML = `
            <div class="hour-label">${hour.hour || `Jam ${index + 1}`}</div>
            <div class="hour-inputs">
                <div class="input-group">
                    <label>Output:</label>
                    <input type="number" id="hour-output-${index}" value="${hour.output || 0}" placeholder="Output" min="0" class="data-input">
                </div>
                <div class="input-group">
                    <label>Defect:</label>
                    <input type="number" id="hour-defect-${index}" value="${hour.defect || 0}" placeholder="Defect" min="0" class="data-input">
                </div>
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

    // Add input event listeners untuk real-time calculation
    document.querySelectorAll('.data-input').forEach(input => {
        input.addEventListener('input', updateQuickStatsFromInputs);
    });
}

function updateQuickStatsFromInputs() {
    const inputs = document.querySelectorAll('.data-input');
    let totalOutput = 0;
    let totalDefect = 0;
    
    // Group inputs by hour
    for (let i = 0; i < inputs.length; i += 2) {
        const output = parseInt(inputs[i].value) || 0;
        const defect = parseInt(inputs[i + 1].value) || 0;
        totalOutput += output;
        totalDefect += defect;
    }
    
    const defectRate = totalOutput > 0 ? ((totalDefect / totalOutput) * 100).toFixed(2) : '0.00';
    
    document.getElementById('total-output').textContent = totalOutput;
    document.getElementById('total-defect').textContent = totalDefect;
    document.getElementById('total-defect-rate').textContent = `${defectRate}%`;
}

function updateQuickStats(hourlyData) {
    let totalOutput = 0;
    let totalDefect = 0;
    
    hourlyData.forEach(hour => {
        totalOutput += hour.output || 0;
        totalDefect += hour.defect || 0;
    });
    
    const defectRate = totalOutput > 0 ? ((totalDefect / totalOutput) * 100).toFixed(2) : '0.00';
    
    document.getElementById('total-output').textContent = totalOutput;
    document.getElementById('total-defect').textContent = totalDefect;
    document.getElementById('total-defect-rate').textContent = `${defectRate}%`;
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
            showSuccess('Data berhasil diupdate!');
            fetchLineData(); // Refresh data
            updateQuickStatsFromInputs(); // Update stats
        } else {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Gagal update data');
        }
    } catch (error) {
        console.error('Error updating hourly data:', error);
        showError('Gagal mengupdate data: ' + error.message);
    }
}

async function saveAllData() {
    const inputs = document.querySelectorAll('.data-input');
    let hasError = false;
    
    for (let i = 0; i < inputs.length; i += 2) {
        const hourIndex = i / 2;
        const output = inputs[i].value;
        const defect = inputs[i + 1].value;
        
        if (output === '' || defect === '') {
            showError(`Harap isi data untuk jam ke-${hourIndex + 1}`);
            hasError = true;
            break;
        }
        
        try {
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
            
            if (!response.ok) {
                throw new Error('Gagal update data');
            }
        } catch (error) {
            console.error('Error updating hourly data:', error);
            hasError = true;
            break;
        }
    }
    
    if (!hasError) {
        showSuccess('Semua data berhasil disimpan!');
        fetchLineData(); // Refresh data
    }
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
        showError('Gagal mengexport data ke Excel.');
    }
}

function showError(message) {
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
        border-left: 4px solid #cc0000;
    `;
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);
    
    setTimeout(() => {
        document.body.removeChild(errorDiv);
    }, 5000);
}

function showSuccess(message) {
    const successDiv = document.createElement('div');
    successDiv.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #00cc00;
        color: white;
        padding: 15px;
        border-radius: 5px;
        z-index: 10000;
        border-left: 4px solid #009900;
    `;
    successDiv.textContent = message;
    document.body.appendChild(successDiv);
    
    setTimeout(() => {
        document.body.removeChild(successDiv);
    }, 3000);
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
    console.log('DOM loaded, initializing input page...');
    
    initializeInput();
    
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('refresh-data-btn').addEventListener('click', function() {
        console.log('Manual refresh triggered');
        fetchLineData();
    });
    
    document.getElementById('save-all-btn').addEventListener('click', saveAllData);
    document.getElementById('export-excel-btn').addEventListener('click', exportToExcel);
    
    console.log('Event listeners registered');
});