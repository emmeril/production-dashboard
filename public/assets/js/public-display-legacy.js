(function () {
    'use strict';

    var DEFAULT_SETTINGS = {
        layoutWidth: 98,
        marginLeft: 30,
        marginTop: 12,
        cellFontSize: 16,
        sideFontSize: 14,
        metricFontSize: 66,
        percentFontSize: 40,
        refreshInterval: 10000
    };

    var state = {
        lineName: '',
        explicitModelId: '',
        currentModelId: '',
        activeModelIds: [],
        rotationIndex: 0,
        defectMode: 'all',
        refreshInterval: 10000,
        refreshTimer: null,
        clockTimer: null,
        qcEvaluationTimer: null,
        qcEvaluationLastLoadedAt: 0,
        qcEvaluations: [],
        qcEvaluationIndex: -1,
        qcEvaluationVisible: false,
        requestId: 0,
        isWithinWorkSchedule: false,
        workScheduleSettings: {
            enabled: true,
            workDays: [],
            startTime: '07:00',
            endTime: '17:00'
        },
        settings: DEFAULT_SETTINGS,
        data: emptyLineData()
    };

    function emptyLineData() {
        return {
            labelWeek: '',
            model: '',
            target: 0,
            outputDay: 0,
            actualDefect: 0,
            defectRatePercentage: 0,
            defectBreakdown: {},
            hourly_data: [],
            qcChecks: [],
            defectSeverityLookups: { types: {} }
        };
    }

    function element(id) {
        return document.getElementById(id);
    }

    function setText(id, value) {
        var target = element(id);
        if (target) target.textContent = String(value);
    }

    function setVisible(id, visible, displayValue) {
        var target = element(id);
        if (!target) return;
        target.style.display = visible ? (displayValue || 'block') : 'none';
    }

    function hideLoading() {
        setVisible('legacy-loading-overlay', false);
    }

    function hideError() {
        setVisible('legacy-error-overlay', false);
    }

    function showError(message) {
        hideLoading();
        setText('legacy-error-message', message || 'Terjadi kesalahan saat memuat display');
        setVisible('legacy-error-overlay', true, 'flex');
    }

    function logError(context, error) {
        if (window.console && typeof window.console.error === 'function') {
            window.console.error('[public-display-legacy] ' + context, error || '');
        }
    }

    function parseQuery() {
        var result = {};
        var query = window.location.search.replace(/^\?/, '');
        var parts = query ? query.split('&') : [];
        var index;
        for (index = 0; index < parts.length; index += 1) {
            var pair = parts[index].split('=');
            var rawKey = pair.shift() || '';
            var rawValue = pair.join('=');
            try {
                var key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
                result[key] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
            } catch (error) {
                logError('Parameter URL tidak valid', error);
            }
        }
        return result;
    }

    function requestJson(url, callback) {
        var xhr = new XMLHttpRequest();
        var completed = false;
        function finish(error, payload, status) {
            if (completed) return;
            completed = true;
            callback(error, payload, status);
        }
        xhr.open('GET', url, true);
        xhr.timeout = 15000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            var payload = null;
            try {
                payload = xhr.responseText ? JSON.parse(xhr.responseText) : {};
            } catch (error) {
                finish(new Error('Respons server tidak valid'), null, xhr.status);
                return;
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                finish(null, payload, xhr.status);
                return;
            }
            finish(new Error((payload && payload.error) || 'HTTP ' + xhr.status), payload, xhr.status);
        };
        xhr.onerror = function () {
            finish(new Error('Tidak dapat terhubung ke server'), null, 0);
        };
        xhr.ontimeout = function () {
            finish(new Error('Koneksi ke server timeout'), null, 0);
        };
        xhr.send();
    }

    function numberOr(value, fallback) {
        var number = Number(value);
        return isFinite(number) ? number : fallback;
    }

    function normalizeDisplaySettings(settings) {
        settings = settings || {};
        return {
            layoutWidth: numberOr(settings.layoutWidth, DEFAULT_SETTINGS.layoutWidth),
            marginLeft: numberOr(settings.marginLeft, DEFAULT_SETTINGS.marginLeft),
            marginTop: numberOr(settings.marginTop, DEFAULT_SETTINGS.marginTop),
            cellFontSize: numberOr(settings.cellFontSize, DEFAULT_SETTINGS.cellFontSize),
            sideFontSize: numberOr(settings.sideFontSize, DEFAULT_SETTINGS.sideFontSize),
            metricFontSize: numberOr(settings.metricFontSize, DEFAULT_SETTINGS.metricFontSize),
            percentFontSize: numberOr(settings.percentFontSize, DEFAULT_SETTINGS.percentFontSize),
            refreshInterval: numberOr(settings.refreshInterval, DEFAULT_SETTINGS.refreshInterval)
        };
    }

    function applyDisplaySettings() {
        var settings = state.settings;
        var style = document.body.style;
        style.setProperty('--display-layout-width', settings.layoutWidth + '%');
        style.setProperty('--display-margin-left', settings.marginLeft + 'px');
        style.setProperty('--display-margin-top', settings.marginTop + 'px');
        style.setProperty('--display-cell-font-size', settings.cellFontSize + 'px');
        style.setProperty('--display-output-font-size', Math.max(settings.cellFontSize + 2, 12) + 'px');
        style.setProperty('--display-clock-font-size', Math.max(settings.cellFontSize + 4, 14) + 'px');
        style.setProperty('--display-hour-font-size', Math.max(settings.sideFontSize - 2, 10) + 'px');
        style.setProperty('--display-side-font-size', settings.sideFontSize + 'px');
        style.setProperty('--display-metric-font-size', settings.metricFontSize + 'px');
        style.setProperty('--display-percent-font-size', settings.percentFontSize + 'px');
        state.refreshInterval = settings.refreshInterval;
        element('legacy-refresh-interval').value = String(state.refreshInterval);
    }

    function loadDisplaySettings(callback) {
        requestJson('/api/public-display-settings', function (error, settings) {
            if (error) {
                logError('Gagal memuat pengaturan display', error);
                state.settings = normalizeDisplaySettings({});
            } else {
                state.settings = normalizeDisplaySettings(settings);
            }
            applyDisplaySettings();
            callback();
        });
    }

    function qcMarkerColor(severity) {
        if (severity === 'critical') return '#dc2626';
        if (severity === 'major') return '#ea580c';
        return '#eab308';
    }

    function clearChildren(target) {
        while (target && target.firstChild) target.removeChild(target.firstChild);
    }

    function renderQcEvaluation(evaluation) {
        var markers = evaluation.markers || [];
        var markerLayer = element('legacy-qc-evaluation-markers');
        var markerList = element('legacy-qc-evaluation-marker-list');
        var index;
        setText('legacy-qc-evaluation-title', evaluation.title || 'Evaluasi Produk');
        setText('legacy-qc-evaluation-product', evaluation.productName || 'Foto produk aktual');
        setText('legacy-qc-evaluation-line', state.lineName || '-');
        setText('legacy-qc-evaluation-notes', evaluation.notes || 'Perhatikan setiap lokasi defect yang ditandai dan lakukan evaluasi proses.');
        element('legacy-qc-evaluation-photo').src = evaluation.photoDataUrl || '';
        clearChildren(markerLayer);
        clearChildren(markerList);

        for (index = 0; index < markers.length; index += 1) {
            var marker = markers[index];
            var color = qcMarkerColor(marker.severity);
            var markerElement = document.createElement('span');
            markerElement.className = 'qc-evaluation-marker';
            markerElement.style.left = numberOr(marker.x, 0) + '%';
            markerElement.style.top = numberOr(marker.y, 0) + '%';
            markerElement.style.backgroundColor = color;
            markerElement.textContent = String(index + 1);
            markerLayer.appendChild(markerElement);

            var item = document.createElement('div');
            item.className = 'qc-evaluation-marker-item';
            item.style.borderLeftColor = color;
            var heading = document.createElement('strong');
            heading.textContent = (index + 1) + '. ' + (marker.label || 'Defect');
            var area = document.createElement('span');
            area.textContent = 'Area: ' + (marker.area || '-');
            item.appendChild(heading);
            item.appendChild(area);
            if (marker.notes) {
                var notes = document.createElement('small');
                notes.textContent = marker.notes;
                item.appendChild(notes);
            }
            markerList.appendChild(item);
        }
    }

    function scheduleNextQcEvaluation(delay) {
        if (state.qcEvaluationTimer) window.clearTimeout(state.qcEvaluationTimer);
        if (!state.qcEvaluations.length) {
            state.qcEvaluationTimer = null;
            return;
        }
        state.qcEvaluationTimer = window.setTimeout(showNextQcEvaluation, delay);
    }

    function hideQcEvaluation() {
        state.qcEvaluationVisible = false;
        setVisible('legacy-qc-evaluation-overlay', false);
        scheduleNextQcEvaluation(30000);
    }

    function showNextQcEvaluation() {
        if (!state.qcEvaluations.length) return;
        state.qcEvaluationIndex = (state.qcEvaluationIndex + 1) % state.qcEvaluations.length;
        renderQcEvaluation(state.qcEvaluations[state.qcEvaluationIndex]);
        state.qcEvaluationVisible = true;
        setVisible('legacy-qc-evaluation-overlay', true, 'block');
        if (state.qcEvaluationTimer) window.clearTimeout(state.qcEvaluationTimer);
        state.qcEvaluationTimer = window.setTimeout(hideQcEvaluation, 15000);
    }

    function loadQcEvaluations(force) {
        var now = new Date().getTime();
        if (!force && now - state.qcEvaluationLastLoadedAt < 30000) return;
        state.qcEvaluationLastLoadedAt = now;
        requestJson('/api/public/qc-product-evaluations?line=' + encodeURIComponent(state.lineName), function (error, payload) {
            if (error) {
                logError('Gagal memuat evaluasi foto produk QC', error);
                return;
            }
            state.qcEvaluations = payload && payload.evaluations ? payload.evaluations : [];
            if (!state.qcEvaluations.length) {
                if (state.qcEvaluationTimer) window.clearTimeout(state.qcEvaluationTimer);
                state.qcEvaluationTimer = null;
                state.qcEvaluationVisible = false;
                setVisible('legacy-qc-evaluation-overlay', false);
                return;
            }
            if (!state.qcEvaluationVisible && !state.qcEvaluationTimer) scheduleNextQcEvaluation(10000);
        });
    }

    function workScheduleDescription() {
        var names = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
        var schedule = state.workScheduleSettings || {};
        var workDays = schedule.workDays || [];
        var days = [];
        var index;
        if (schedule.enabled === false) return 'Jadwal kerja tidak dibatasi.';
        for (index = 0; index < workDays.length; index += 1) {
            if (names[Number(workDays[index])]) days.push(names[Number(workDays[index])]);
        }
        return (days.join(', ') || 'Tidak ada hari kerja') + ' | ' +
            (schedule.startTime || '07:00') + ' - ' + (schedule.endTime || '17:00') + ' WIB';
    }

    function showScheduleOverlay() {
        state.data = emptyLineData();
        hideLoading();
        hideError();
        setVisible('legacy-display-root', false);
        setText('legacy-schedule-description', workScheduleDescription());
        setVisible('legacy-schedule-overlay', true, 'flex');
    }

    function hideScheduleOverlay() {
        setVisible('legacy-schedule-overlay', false);
    }

    function loadWorkScheduleStatus(callback) {
        requestJson('/api/public/work-schedule-status', function (error, result) {
            if (error) {
                logError('Gagal memuat jadwal kerja', error);
                showError(error.message);
                callback(false);
                return;
            }
            state.workScheduleSettings = result.settings || state.workScheduleSettings;
            state.isWithinWorkSchedule = result.withinWorkSchedule === true;
            if (!state.isWithinWorkSchedule) {
                showScheduleOverlay();
                callback(false);
                return;
            }
            hideScheduleOverlay();
            callback(true);
        });
    }

    function handleForbiddenSchedule() {
        state.isWithinWorkSchedule = false;
        loadWorkScheduleStatus(function () {});
    }

    function findActiveModel(models, modelId) {
        var index;
        for (index = 0; index < models.length; index += 1) {
            if (models[index].modelId === modelId) return models[index];
        }
        return null;
    }

    function loadModelData(modelId, requestId) {
        var line = encodeURIComponent(state.lineName);
        var model = encodeURIComponent(modelId);
        requestJson('/api/public/line/' + line + '/' + model, function (error, data, status) {
            if (requestId !== state.requestId) return;
            if (!error) {
                acceptLineData(modelId, data);
                return;
            }
            if (status === 403) {
                handleForbiddenSchedule();
                return;
            }
            requestJson('/api/line/' + line + '/' + model, function (fallbackError, fallbackData, fallbackStatus) {
                if (requestId !== state.requestId) return;
                if (!fallbackError) {
                    acceptLineData(modelId, fallbackData);
                } else if (fallbackStatus === 403) {
                    handleForbiddenSchedule();
                } else {
                    logError('Gagal memuat data line', fallbackError);
                    showError(fallbackError.message);
                }
            });
        });
    }

    function loadLineData() {
        if (!state.isWithinWorkSchedule) return;
        state.requestId += 1;
        var requestId = state.requestId;
        if (state.explicitModelId) {
            state.activeModelIds = [state.explicitModelId];
            loadModelData(state.explicitModelId, requestId);
            return;
        }

        requestJson('/api/public/line/' + encodeURIComponent(state.lineName) + '/active-models', function (error, payload, status) {
            if (requestId !== state.requestId) return;
            if (error) {
                if (status === 403) handleForbiddenSchedule();
                else showError(error.message);
                return;
            }
            var models = payload.activeModels || [];
            state.activeModelIds = [];
            var index;
            for (index = 0; index < models.length; index += 1) {
                if (models[index].modelId) state.activeModelIds.push(models[index].modelId);
            }
            if (!state.activeModelIds.length) {
                showError('Tidak ada model aktif untuk line ini');
                return;
            }
            var slot = state.rotationIndex % state.activeModelIds.length;
            var selectedModelId = state.activeModelIds[slot];
            state.rotationIndex = (slot + 1) % state.activeModelIds.length;
            var selectedModel = findActiveModel(models, selectedModelId);
            if (selectedModel && selectedModel.data) {
                acceptLineData(selectedModelId, selectedModel.data);
                return;
            }
            loadModelData(selectedModelId, requestId);
        });
    }

    function acceptLineData(modelId, data) {
        state.currentModelId = modelId;
        state.data = data || emptyLineData();
        hideLoading();
        hideError();
        hideScheduleOverlay();
        renderDisplay();
        setVisible('legacy-display-root', true, 'block');
    }

    function refreshAll() {
        loadQcEvaluations(false);
        loadWorkScheduleStatus(function (withinSchedule) {
            if (withinSchedule) loadLineData();
        });
    }

    function setupAutoRefresh() {
        if (state.refreshTimer) window.clearInterval(state.refreshTimer);
        var interval = state.refreshInterval > 0 ? state.refreshInterval : 60000;
        state.refreshTimer = window.setInterval(function () {
            if (state.refreshInterval > 0) {
                refreshAll();
            } else {
                loadWorkScheduleStatus(function (withinSchedule) {
                    if (withinSchedule && element('legacy-display-root').style.display === 'none') loadLineData();
                });
            }
        }, interval);
    }

    function parseHourRange(value) {
        if (!value || typeof value !== 'string') return null;
        var parts = value.split(' - ');
        if (parts.length !== 2) return null;
        var start = parts[0].split(':');
        var end = parts[1].split(':');
        if (start.length !== 2 || end.length !== 2) return null;
        return {
            start: (Number(start[0]) * 60) + Number(start[1]),
            end: (Number(end[0]) * 60) + Number(end[1])
        };
    }

    function jakartaTimeParts() {
        try {
            var formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Jakarta',
                hour: 'numeric',
                minute: 'numeric',
                hour12: false
            });
            var parts = formatter.formatToParts(new Date());
            var result = { hour: 0, minute: 0 };
            var index;
            for (index = 0; index < parts.length; index += 1) {
                if (parts[index].type === 'hour') result.hour = Number(parts[index].value) % 24;
                if (parts[index].type === 'minute') result.minute = Number(parts[index].value);
            }
            return result;
        } catch (error) {
            var now = new Date();
            return { hour: now.getHours(), minute: now.getMinutes() };
        }
    }

    function currentTimeInMinutes() {
        var time = jakartaTimeParts();
        return (time.hour * 60) + time.minute;
    }

    function productionHours() {
        var hours = state.data.hourly_data || [];
        var result = [];
        var index;
        for (index = 0; index < hours.length; index += 1) {
            if (parseHourRange(hours[index].hour) && (parseInt(hours[index].targetManual, 10) || 0) > 0) {
                result.push(hours[index]);
            }
        }
        return result;
    }

    function activeHourData() {
        var hours = productionHours();
        var current = currentTimeInMinutes();
        var previous = null;
        var index;
        for (index = 0; index < hours.length; index += 1) {
            var range = parseHourRange(hours[index].hour);
            if (current >= range.start && current < range.end) return hours[index];
            if (current >= range.end) previous = hours[index];
        }
        return previous || hours[0] || null;
    }

    function reduceHoursUntilCurrent(field, subtractField) {
        var hours = state.data.hourly_data || [];
        var current = currentTimeInMinutes();
        var total = 0;
        var index;
        for (index = 0; index < hours.length; index += 1) {
            var range = parseHourRange(hours[index].hour);
            if (!range || current < range.start) continue;
            total += parseInt(hours[index][field], 10) || 0;
            if (subtractField) total -= parseInt(hours[index][subtractField], 10) || 0;
        }
        return total;
    }

    function formatNumber(value) {
        var number = parseInt(value, 10) || 0;
        try {
            return number.toLocaleString('id-ID');
        } catch (error) {
            return String(number);
        }
    }

    function formatPercent(value) {
        return (parseFloat(value) || 0).toFixed(1) + '%';
    }

    function defectTitle() {
        if (state.defectMode === 'critical') return 'CRITICAL DEFECT';
        if (state.defectMode === 'major') return 'MAJOR DEFECT';
        if (state.defectMode === 'minor') return 'MINOR DEFECT';
        return 'ACT DEFECT';
    }

    function selectedDefectBreakdown() {
        var breakdown = state.data.defectBreakdown || {};
        return breakdown[state.defectMode] || {
            count: state.data.actualDefect || 0,
            rate: state.data.defectRatePercentage || 0
        };
    }

    function setMetricClass(id, baseClass, isBad) {
        var target = element(id);
        if (target) target.className = baseClass + (isBad ? ' metric-red' : ' metric-green');
    }

    function renderMetrics() {
        var activeHour = activeHourData();
        var hourTarget = activeHour ? (parseInt(activeHour.targetManual, 10) || 0) : 0;
        var balance = reduceHoursUntilCurrent('output', 'targetManual');
        var cumulativeTarget = reduceHoursUntilCurrent('targetManual');
        var dailyTarget = parseInt(state.data.target, 10) || 0;
        var outputDay = parseInt(state.data.outputDay, 10) || 0;
        var selectedDefect = selectedDefectBreakdown();
        var targetProgress = dailyTarget ? Math.min((cumulativeTarget / dailyTarget) * 100, 100) : 0;
        var balanceProgress = dailyTarget ? (balance / dailyTarget) * 100 : 0;
        var outputProgress = dailyTarget ? (outputDay / dailyTarget) * 100 : 0;

        setText('legacy-hour-target-side', 'TARGET : ' + formatNumber(hourTarget));
        setText('legacy-hour-target', formatNumber(hourTarget));
        setText('legacy-balance', formatNumber(balance));
        setText('legacy-output-day', formatNumber(outputDay));
        setText('legacy-target-progress', targetProgress.toFixed(1) + '%');
        setText('legacy-balance-progress', balanceProgress.toFixed(1) + '%');
        setText('legacy-output-progress', outputProgress.toFixed(1) + '%');
        setText('legacy-defect-title', defectTitle());
        setText('legacy-defect-count', formatNumber(selectedDefect.count));
        setText('legacy-defect-rate', formatPercent(selectedDefect.rate));
        setMetricClass('legacy-balance', 'isie', balance < 0);
        setMetricClass('legacy-defect-count', 'outday1', (parseFloat(selectedDefect.rate) || 0) > 3);
        setMetricClass('legacy-defect-rate', 'outday1', (parseFloat(selectedDefect.rate) || 0) > 3);
        element('legacy-balance').style.fontSize = String(Math.abs(balance)).length >= 3 ? '3.8em' : '';
    }

    function appendCell(row, text, className) {
        var cell = document.createElement('td');
        cell.textContent = String(text);
        if (className) cell.className = className;
        row.appendChild(cell);
    }

    function isActiveHour(hour) {
        var range = parseHourRange(hour && hour.hour);
        var current = currentTimeInMinutes();
        return range && current >= range.start && current < range.end;
    }

    function hourlyQcGoodCount(hour) {
        return Math.max((parseInt(hour.qcChecked, 10) || 0) - (parseInt(hour.defect, 10) || 0), 0);
    }

    function renderHourlyRows() {
        var container = element('legacy-hourly-rows');
        while (container.firstChild) container.removeChild(container.firstChild);
        var hours = (state.data.hourly_data || []).slice(0, 10);
        var index;
        for (index = 0; index < hours.length; index += 1) {
            var hour = hours[index];
            var row = document.createElement('tr');
            var good = hourlyQcGoodCount(hour);
            var output = parseInt(hour.output, 10) || 0;
            var defect = parseInt(hour.defect, 10) || 0;
            var rate = output + defect > 0 ? (defect / (output + defect)) * 100 : 0;
            appendCell(row, String(hour.hour || '-').replace(/\s+/g, ''), 'hour-cell' + (isActiveHour(hour) ? ' hour-active' : ''));
            appendCell(row, formatNumber(good), good > 0 ? 'output-ok' : 'output-ng');
            appendCell(row, formatNumber(defect), rate >= 3 ? 'output-ng' : 'output-ok');
            container.appendChild(row);
        }
    }

    function normalizeDefectKey(value) {
        return String(value || '').replace(/^\s+|\s+$/g, '').toLowerCase();
    }

    function defectSeverity(type) {
        var lookups = state.data.defectSeverityLookups || { types: {} };
        var types = lookups.types || {};
        var severity = types[normalizeDefectKey(type)];
        return severity === 'major' || severity === 'critical' ? severity : 'minor';
    }

    function matchesDefectMode(type) {
        return state.defectMode === 'all' || defectSeverity(type) === state.defectMode;
    }

    function topDefects() {
        var counts = {};
        var checks = state.data.qcChecks;
        var index;
        if (Object.prototype.toString.call(checks) === '[object Array]') {
            for (index = 0; index < checks.length; index += 1) {
                var check = checks[index];
                if (check.result !== 'defect' || !matchesDefectMode(check.type)) continue;
                var checkName = check.type || '-';
                counts[checkName] = (counts[checkName] || 0) + (parseInt(check.quantity, 10) || 1);
            }
        } else {
            var hours = state.data.hourly_data || [];
            for (index = 0; index < hours.length; index += 1) {
                var details = hours[index].defectDetails || [];
                var detailIndex;
                for (detailIndex = 0; detailIndex < details.length; detailIndex += 1) {
                    var detail = details[detailIndex];
                    if (!matchesDefectMode(detail.type)) continue;
                    var detailName = detail.type || '-';
                    counts[detailName] = (counts[detailName] || 0) + (parseInt(detail.quantity, 10) || 1);
                }
            }
        }
        var items = [];
        var names = Object.keys(counts);
        for (index = 0; index < names.length; index += 1) {
            items.push({ name: names[index], count: counts[names[index]] });
        }
        items.sort(function (left, right) {
            return right.count - left.count || left.name.localeCompare(right.name);
        });
        items = items.slice(0, 3);
        while (items.length < 3) items.push({ name: '-', count: '-' });
        return items;
    }

    function renderTopDefects() {
        var container = element('legacy-top-defect-rows');
        while (container.firstChild) container.removeChild(container.firstChild);
        var items = topDefects();
        var index;
        for (index = 0; index < items.length; index += 1) {
            var row = document.createElement('tr');
            appendCell(row, index + 1, 'legacy-defect-rank');
            appendCell(row, items[index].name, 'legacy-defect-name');
            appendCell(row, items[index].count, 'legacy-defect-total');
            container.appendChild(row);
        }
    }

    function renderDisplay() {
        setText('legacy-line-title', 'LINE: ' + (state.lineName || '-'));
        setText('legacy-model-name', state.data.model || '-');
        setText('legacy-week-label', 'WEEK : ' + (state.data.labelWeek || '-'));
        renderMetrics();
        renderHourlyRows();
        renderTopDefects();
        updateDateTime();
    }

    function updateDateTime() {
        var now = new Date();
        try {
            setText('legacy-current-date', now.toLocaleDateString('id-ID', {
                weekday: 'long',
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            }));
            setText('legacy-current-clock', now.toLocaleTimeString('id-ID', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            }));
        } catch (error) {
            setText('legacy-current-date', now.toDateString());
            setText('legacy-current-clock', now.toTimeString().split(' ')[0]);
        }
    }

    function replaceDefectQuery() {
        if (!window.history || typeof window.history.replaceState !== 'function') return;
        var url = window.location.pathname + '?line=' + encodeURIComponent(state.lineName);
        if (state.explicitModelId) url += '&model=' + encodeURIComponent(state.explicitModelId);
        url += '&defect=' + encodeURIComponent(state.defectMode);
        window.history.replaceState({}, '', url);
    }

    function attachControls() {
        element('legacy-error-close').addEventListener('click', hideError);
        element('legacy-defect-mode').addEventListener('change', function () {
            var value = this.value;
            state.defectMode = value === 'critical' || value === 'major' || value === 'minor' ? value : 'all';
            replaceDefectQuery();
            renderMetrics();
            renderTopDefects();
        });
        element('legacy-refresh-interval').addEventListener('change', function () {
            state.refreshInterval = Number(this.value) || 0;
            setupAutoRefresh();
        });
    }

    function init() {
        attachControls();
        updateDateTime();
        state.clockTimer = window.setInterval(function () {
            updateDateTime();
            if (element('legacy-display-root').style.display !== 'none') renderMetrics();
        }, 1000);

        var query = parseQuery();
        state.lineName = query.line || '';
        state.explicitModelId = query.model || '';
        state.currentModelId = state.explicitModelId;
        state.defectMode = query.defect || query.defectMode || 'all';
        if (state.defectMode !== 'critical' && state.defectMode !== 'major' && state.defectMode !== 'minor') {
            state.defectMode = 'all';
        }
        element('legacy-defect-mode').value = state.defectMode;

        if (!state.lineName) {
            showError('Parameter line tidak ditemukan. Gunakan format: /public-display-legacy?line=NAMA_LINE&model=MODEL_ID');
            return;
        }
        setText('legacy-line-title', 'LINE: ' + state.lineName);
        loadDisplaySettings(function () {
            loadQcEvaluations(true);
            refreshAll();
            setupAutoRefresh();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}());
