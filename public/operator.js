// public/operator.js - Simplified version

let currentLine = 'LINE-1';

async function initializeDashboard() {
    try {
        console.log('Initializing dashboard...');
        await fetchLineData();
        
        // Auto-refresh setiap 30 detik
        setInterval(fetchLineData, 30000);
    } catch (error) {
        console.error('Initialization failed:', error);
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
    }
}

function updateDashboard(data) {
    console.log('Updating dashboard with data:', data);
    
    // Update Header Info
    document.getElementById('line').textContent = `LINE: ${data.line || 'LINE-1'}`;
    document.getElementById('label-week').textContent = `LABEL/WEEK: ${data.labelWeek || '-'}`;
    document.getElementById('date').textContent = `DATE: ${data.date || '2025-11-11'}`;

    // Hitung target kumulatif berdasarkan jam sekarang
    const currentTarget = calculateCurrentTarget(data);
    
    // Update Main Values
    document.getElementById('target').textContent = currentTarget;
    document.getElementById('productivity').textContent = data.outputDay || 0;
    
    // Output/Day = selisih dari target kumulatif
    const outputDifference = (data.outputDay || 0) - currentTarget;
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
}

// Fungsi calculateCurrentTarget (sama seperti sebelumnya)
function calculateCurrentTarget(data) {
    if (!data || !data.hourly_data) return 0;
    
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTime = currentHour + currentMinute / 100;
    
    // Cari slot jam yang sesuai dengan waktu sekarang
    for (let i = 0; i < data.hourly_data.length; i++) {
        const hourSlot = data.hourly_data[i];
        const hourRange = hourSlot.hour;
        
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
            return hourSlot.cumulativeTarget || 0;
        }
    }
    
    // Jika sudah lewat jam terakhir (setelah 18:00), gunakan target kumulatif terakhir
    if (data.hourly_data.length > 0) {
        return data.hourly_data[data.hourly_data.length - 1].cumulativeTarget || 0;
    }
    
    return 0;
}

// Event listeners
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded, initializing dashboard...');
    initializeDashboard();
});