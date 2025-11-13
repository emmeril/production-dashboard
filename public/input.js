// public/input.js - Updated dengan Multiple Defect Details

let currentUser = null;
let currentLine = '';
let defectTypes = [];
let defectAreas = [];

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
            
            // Fetch defect types and areas
            await fetchDefects();
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

// Fetch defect types and areas
async function fetchDefects() {
    try {
        const [typesResponse, areasResponse] = await Promise.all([
            fetch('/api/defect-types'),
            fetch('/api/defect-areas')
        ]);

        if (typesResponse.ok) {
            defectTypes = await typesResponse.json();
        }
        if (areasResponse.ok) {
            defectAreas = await areasResponse.json();
        }
    } catch (error) {
        console.error("Gagal mengambil data defects:", error);
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
        updateHourlyInputs(data.hourly_data, data.target);
        updateQuickStats(data);
    } catch (error) {
        console.error("Gagal mengambil data line:", error);
        showError('Gagal mengambil data produksi. Silakan refresh halaman.');
    }
}

function updateHourlyInputs(hourlyData, totalTarget) {
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
            <div class="hour-info">
                <span class="target-info">Target: ${hour.cumulativeTarget || 0}</span>
            </div>
            <div class="hour-inputs">
                <div class="input-group">
                    <label>Output:</label>
                    <input type="number" id="hour-output-${index}" value="${hour.output || 0}" placeholder="Output" min="0" class="data-input">
                </div>
                <div class="input-group">
                    <label>Defect:</label>
                    <input type="number" id="hour-defect-${index}" value="${hour.defect || 0}" placeholder="Defect" min="0" class="data-input" readonly>
                    <small style="color: #ccc; font-size: 0.8rem;">Total: ${calculateTotalDefects(hour.defectDetails || [])}</small>
                </div>
                <div class="input-group">
                    <label>QC Checked:</label>
                    <input type="number" id="hour-qc-${index}" value="${hour.qcChecked || 0}" placeholder="QC Checked" min="0" class="data-input">
                </div>
                
                <!-- Multiple Defect Details Section -->
                <div class="defect-details-section">
                    <h4>Detail Defect (${calculateTotalDefects(hour.defectDetails || [])} defect):</h4>
                    <div class="defect-inputs" id="defect-inputs-${index}">
                        ${renderDefectDetails(hour.defectDetails || [], index)}
                    </div>
                    <button type="button" class="btn-secondary add-defect-btn" data-hour="${index}" style="margin-top: 10px;">
                        + Tambah Defect
                    </button>
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
            updateHourlyData(hourIndex);
        });
    });

    // Add event listeners untuk add defect buttons
    document.querySelectorAll('.add-defect-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const hourIndex = this.getAttribute('data-hour');
            addDefectInput(hourIndex);
        });
    });

    // Add input event listeners untuk real-time calculation
    document.querySelectorAll('.data-input').forEach(input => {
        input.addEventListener('input', updateQuickStatsFromInputs);
    });

    // Add event listeners untuk defect quantity inputs
    document.querySelectorAll('.defect-quantity').forEach(input => {
        input.addEventListener('input', function() {
            const hourIndex = this.getAttribute('data-hour');
            updateDefectTotal(hourIndex);
        });
    });

    // Add event listeners untuk remove defect buttons
    document.querySelectorAll('.remove-defect-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const hourIndex = this.getAttribute('data-hour');
            const defectIndex = this.getAttribute('data-defect-index');
            removeDefectInput(hourIndex, defectIndex);
        });
    });
}

function calculateTotalDefects(defectDetails) {
    return defectDetails.reduce((total, defect) => total + (parseInt(defect.quantity) || 0), 0);
}

function renderDefectDetails(defectDetails, hourIndex) {
    if (defectDetails.length === 0) {
        return `
            <div class="defect-input-row" data-defect-index="0">
                <div class="input-group">
                    <label>Jumlah:</label>
                    <input type="number" class="defect-quantity" data-hour="${hourIndex}" value="0" min="0" placeholder="Jumlah">
                </div>
                <div class="input-group">
                    <label>Jenis Defect:</label>
                    <select class="defect-type-select">
                        <option value="">Pilih Jenis Defect</option>
                        ${defectTypes.map(type => `<option value="${type.name}">${type.name}</option>`).join('')}
                    </select>
                </div>
                <div class="input-group">
                    <label>Area Defect:</label>
                    <select class="defect-area-select">
                        <option value="">Pilih Area Defect</option>
                        ${defectAreas.map(area => `<option value="${area.name}">${area.name}</option>`).join('')}
                    </select>
                </div>
                <div class="input-group">
                    <label>Keterangan:</label>
                    <input type="text" class="defect-notes" placeholder="Keterangan tambahan">
                </div>
                <button type="button" class="btn-danger remove-defect-btn" data-hour="${hourIndex}" data-defect-index="0" style="height: fit-content; margin-top: 25px;">×</button>
            </div>
        `;
    }

    return defectDetails.map((defect, defectIndex) => `
        <div class="defect-input-row" data-defect-index="${defectIndex}">
            <div class="input-group">
                <label>Jumlah:</label>
                <input type="number" class="defect-quantity" data-hour="${hourIndex}" value="${defect.quantity || 0}" min="0" placeholder="Jumlah">
            </div>
            <div class="input-group">
                <label>Jenis Defect:</label>
                <select class="defect-type-select">
                    <option value="">Pilih Jenis Defect</option>
                    ${defectTypes.map(type => `<option value="${type.name}" ${defect.type === type.name ? 'selected' : ''}>${type.name}</option>`).join('')}
                </select>
            </div>
            <div class="input-group">
                <label>Area Defect:</label>
                <select class="defect-area-select">
                    <option value="">Pilih Area Defect</option>
                    ${defectAreas.map(area => `<option value="${area.name}" ${defect.area === area.name ? 'selected' : ''}>${area.name}</option>`).join('')}
                </select>
            </div>
            <div class="input-group">
                <label>Keterangan:</label>
                <input type="text" class="defect-notes" value="${defect.notes || ''}" placeholder="Keterangan tambahan">
            </div>
            <button type="button" class="btn-danger remove-defect-btn" data-hour="${hourIndex}" data-defect-index="${defectIndex}" style="height: fit-content; margin-top: 25px;">×</button>
        </div>
    `).join('');
}

function addDefectInput(hourIndex) {
    const defectInputs = document.getElementById(`defect-inputs-${hourIndex}`);
    const defectRows = defectInputs.querySelectorAll('.defect-input-row');
    const newDefectIndex = defectRows.length;

    const newDefectRow = document.createElement('div');
    newDefectRow.className = 'defect-input-row';
    newDefectRow.setAttribute('data-defect-index', newDefectIndex);
    newDefectRow.innerHTML = `
        <div class="input-group">
            <label>Jumlah:</label>
            <input type="number" class="defect-quantity" data-hour="${hourIndex}" value="0" min="0" placeholder="Jumlah">
        </div>
        <div class="input-group">
            <label>Jenis Defect:</label>
            <select class="defect-type-select">
                <option value="">Pilih Jenis Defect</option>
                ${defectTypes.map(type => `<option value="${type.name}">${type.name}</option>`).join('')}
            </select>
        </div>
        <div class="input-group">
            <label>Area Defect:</label>
            <select class="defect-area-select">
                <option value="">Pilih Area Defect</option>
                ${defectAreas.map(area => `<option value="${area.name}">${area.name}</option>`).join('')}
            </select>
        </div>
        <div class="input-group">
            <label>Keterangan:</label>
            <input type="text" class="defect-notes" placeholder="Keterangan tambahan">
        </div>
        <button type="button" class="btn-danger remove-defect-btn" data-hour="${hourIndex}" data-defect-index="${newDefectIndex}" style="height: fit-content; margin-top: 25px;">×</button>
    `;

    defectInputs.appendChild(newDefectRow);

    // Add event listener untuk new defect quantity input
    newDefectRow.querySelector('.defect-quantity').addEventListener('input', function() {
        updateDefectTotal(hourIndex);
    });

    // Add event listener untuk remove button
    newDefectRow.querySelector('.remove-defect-btn').addEventListener('click', function() {
        removeDefectInput(hourIndex, newDefectIndex);
    });
}

function removeDefectInput(hourIndex, defectIndex) {
    const defectInputs = document.getElementById(`defect-inputs-${hourIndex}`);
    const defectRow = defectInputs.querySelector(`[data-defect-index="${defectIndex}"]`);
    
    if (defectRow) {
        defectRow.remove();
        updateDefectTotal(hourIndex);
        
        // Reindex remaining defect rows
        const remainingRows = defectInputs.querySelectorAll('.defect-input-row');
        remainingRows.forEach((row, index) => {
            row.setAttribute('data-defect-index', index);
            const removeBtn = row.querySelector('.remove-defect-btn');
            if (removeBtn) {
                removeBtn.setAttribute('data-defect-index', index);
            }
        });
    }
}

function updateDefectTotal(hourIndex) {
    const defectInputs = document.getElementById(`defect-inputs-${hourIndex}`);
    const quantityInputs = defectInputs.querySelectorAll('.defect-quantity');
    
    let totalDefects = 0;
    quantityInputs.forEach(input => {
        totalDefects += parseInt(input.value) || 0;
    });
    
    // Update defect input value
    const defectInput = document.getElementById(`hour-defect-${hourIndex}`);
    defectInput.value = totalDefects;
    
    // Update defect details title
    const defectSection = defectInputs.closest('.defect-details-section');
    const defectTitle = defectSection.querySelector('h4');
    defectTitle.textContent = `Detail Defect (${totalDefects} defect):`;
    
    updateQuickStatsFromInputs();
}

function updateQuickStatsFromInputs() {
    const hourlyGroups = document.querySelectorAll('.hour-input-group');
    let totalOutput = 0;
    let totalDefect = 0;
    let totalQCChecked = 0;
    
    hourlyGroups.forEach((group, index) => {
        const output = parseInt(document.getElementById(`hour-output-${index}`)?.value) || 0;
        const defect = parseInt(document.getElementById(`hour-defect-${index}`)?.value) || 0;
        const qcChecked = parseInt(document.getElementById(`hour-qc-${index}`)?.value) || 0;
        
        totalOutput += output;
        totalDefect += defect;
        totalQCChecked += qcChecked;
    });
    
    const defectRate = totalQCChecked > 0 ? ((totalDefect / totalQCChecked) * 100).toFixed(2) : '0.00';
    
    document.getElementById('total-output').textContent = totalOutput;
    document.getElementById('total-defect').textContent = totalDefect;
    document.getElementById('total-qc-checked').textContent = totalQCChecked;
    document.getElementById('total-defect-rate').textContent = `${defectRate}%`;
}

function updateQuickStats(data) {
    const totalOutput = data.outputDay || 0;
    const totalDefect = data.actualDefect || 0;
    const totalQCChecked = data.qcChecking || 0;
    
    const defectRate = totalQCChecked > 0 ? ((totalDefect / totalQCChecked) * 100).toFixed(2) : '0.00';
    
    document.getElementById('total-output').textContent = totalOutput;
    document.getElementById('total-defect').textContent = totalDefect;
    document.getElementById('total-qc-checked').textContent = totalQCChecked;
    document.getElementById('total-defect-rate').textContent = `${defectRate}%`;
}

async function updateHourlyData(hourIndex) {
    try {
        const output = document.getElementById(`hour-output-${hourIndex}`).value;
        const qcChecked = document.getElementById(`hour-qc-${hourIndex}`).value;
        
        // Collect defect details
        const defectInputs = document.getElementById(`defect-inputs-${hourIndex}`);
        const defectRows = defectInputs.querySelectorAll('.defect-input-row');
        const defectDetails = [];
        
        defectRows.forEach(row => {
            const quantity = row.querySelector('.defect-quantity').value;
            const type = row.querySelector('.defect-type-select').value;
            const area = row.querySelector('.defect-area-select').value;
            const notes = row.querySelector('.defect-notes').value;
            
            if (quantity > 0) {
                defectDetails.push({
                    quantity: parseInt(quantity),
                    type: type,
                    area: area,
                    notes: notes
                });
            }
        });
        
        const totalDefect = defectDetails.reduce((total, defect) => total + defect.quantity, 0);
        
        if (output !== '' && qcChecked !== '') {
            console.log('Updating hourly data:', { 
                hourIndex, 
                output, 
                defect: totalDefect, 
                qcChecked, 
                defectDetails 
            });
            
            const response = await fetch(`/api/update-hourly/${currentLine}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    hourIndex: parseInt(hourIndex),
                    output: parseInt(output),
                    defect: totalDefect,
                    qcChecked: parseInt(qcChecked),
                    defectDetails: defectDetails
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
        } else {
            alert('Harap isi output dan QC checked!');
        }
    } catch (error) {
        console.error('Error updating hourly data:', error);
        showError('Gagal mengupdate data: ' + error.message);
    }
}

async function saveAllData() {
    const hourlyGroups = document.querySelectorAll('.hour-input-group');
    let hasError = false;
    
    for (let hourIndex = 0; hourIndex < hourlyGroups.length; hourIndex++) {
        const output = document.getElementById(`hour-output-${hourIndex}`)?.value;
        const qcChecked = document.getElementById(`hour-qc-${hourIndex}`)?.value;
        
        if (output === '' || qcChecked === '') {
            showError(`Harap isi data untuk jam ke-${hourIndex + 1}`);
            hasError = true;
            break;
        }
        
        try {
            // Collect defect details for this hour
            const defectInputs = document.getElementById(`defect-inputs-${hourIndex}`);
            const defectRows = defectInputs.querySelectorAll('.defect-input-row');
            const defectDetails = [];
            
            defectRows.forEach(row => {
                const quantity = row.querySelector('.defect-quantity').value;
                const type = row.querySelector('.defect-type-select').value;
                const area = row.querySelector('.defect-area-select').value;
                const notes = row.querySelector('.defect-notes').value;
                
                if (quantity > 0) {
                    defectDetails.push({
                        quantity: parseInt(quantity),
                        type: type,
                        area: area,
                        notes: notes
                    });
                }
            });
            
            const totalDefect = defectDetails.reduce((total, defect) => total + defect.quantity, 0);
            
            const response = await fetch(`/api/update-hourly/${currentLine}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    hourIndex: parseInt(hourIndex),
                    output: parseInt(output),
                    defect: totalDefect,
                    qcChecked: parseInt(qcChecked),
                    defectDetails: defectDetails
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