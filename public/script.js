// public/script.js

let currentLine = '';

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

async function fetchActiveLine() {
    try {
        const response = await fetch('/api/active-line');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        currentLine = data.line;
        updateDashboard(data);
        updateOperatorSection();
    } catch (error) {
        console.error("Gagal mengambil data line aktif:", error);
    }
}

async function setActiveLine(line) {
    try {
        const response = await fetch('/api/active-line', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ line })
        });
        
        if (response.ok) {
            currentLine = line;
            await fetchActiveLine();
        } else {
            throw new Error('Gagal mengubah line aktif');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Gagal mengubah line aktif.');
    }
}

function updateLineSelector(lines) {
    const lineButtons = document.getElementById('line-buttons');
    lineButtons.innerHTML = '';

    Object.keys(lines).forEach(line => {
        const button = document.createElement('button');
        button.className = 'line-btn';
        button.textContent = line;
        button.onclick = () => setActiveLine(line);
        
        if (line === currentLine) {
            button.classList.add('active');
        }
        
        lineButtons.appendChild(button);
    });
}

function updateDashboard(data) {
    // 1. Update Header Info
    document.getElementById('line').textContent = `LINE: ${data.line || 'N/A'}`;
    document.getElementById('label-week').textContent = `LABEL/WEEK: ${data.labelWeek || 'N/A'}`;
    document.getElementById('model').textContent = data.model || 'N/A';
    document.getElementById('date').textContent = `DATE: ${data.date || 'N/A'}`; 

    // 2. Update Main Values
    document.getElementById('target').textContent = data.target || 0;
    document.getElementById('productivity').textContent = data.productivity || 0;
    document.getElementById('defect-target').textContent = data.defectTarget || 0;
    document.getElementById('output-day').textContent = data.outputDay || 0;
    document.getElementById('defect-day').textContent = data.defectDay || 0;

    // 3. Update Percentages & Color Logic
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
    
    // 4. Update Hourly Data Table
    const tableBody = document.getElementById('hourly-table-body');
    tableBody.innerHTML = ''; 

    if (data.hourly_data && data.hourly_data.length > 0) {
        data.hourly_data.forEach(item => {
            const row = tableBody.insertRow();
            row.insertCell().textContent = item.hour;
            row.insertCell().textContent = item.output;
            row.insertCell().textContent = item.defect;
        });
    } else {
        const row = tableBody.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 3;
        cell.textContent = "Data per jam belum tersedia.";
    }

    // Update section titles
    document.getElementById('current-line').textContent = data.line;
    document.getElementById('hourly-line').textContent = data.line;
    document.getElementById('modal-line').textContent = data.line;
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

function updateOperatorSection() {
    if (currentLine) {
        fetchOperators();
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

// Event Listeners
document.addEventListener('DOMContentLoaded', function() {
    // Modal elements
    const modal = document.getElementById('operator-modal');
    const closeBtn = document.querySelector('.close');
    const cancelBtn = document.getElementById('cancel-btn');
    const addOperatorBtn = document.getElementById('add-operator-btn');
    const refreshOperatorsBtn = document.getElementById('refresh-operators-btn');
    const operatorForm = document.getElementById('operator-form');
    
    // Event listeners for modal
    addOperatorBtn.addEventListener('click', showModal);
    closeBtn.addEventListener('click', hideModal);
    cancelBtn.addEventListener('click', hideModal);
    operatorForm.addEventListener('submit', saveOperator);
    refreshOperatorsBtn.addEventListener('click', fetchOperators);
    
    // Close modal when clicking outside
    window.addEventListener('click', function(event) {
        if (event.target === modal) {
            hideModal();
        }
    });
    
    // Initial data load
    fetchLines();
    fetchActiveLine();
});

// Refresh data periodically
setInterval(() => {
    if (currentLine) {
        fetchActiveLine();
    }
}, 5000); // Refresh setiap 5 detik