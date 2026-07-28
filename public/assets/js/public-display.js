function logPublicDisplayError(context, error) {
            const message = String(context || 'Public display error').replace(/:\s*$/, '');
            if (typeof error === 'undefined') {
                console.error(`[public-display] [ERROR] ${message}`);
                return;
            }

            console.error(`[public-display] [ERROR] ${message}`, error);
        }

        function publicDisplay() {
            return {
                lineData: {
                    name: '',
                    data: {
                        labelWeek: '',
                        model: '',
                        date: '',
                        target: 0,
                        targetPerHour: 0,
                        outputDay: 0,
                        qcChecking: 0,
	                        actualDefect: 0,
	                        defectRatePercentage: 0,
	                        defectBreakdown: {
	                            all: { count: 0, rate: 0 },
	                            major: { count: 0, rate: 0 },
	                            minor: { count: 0, rate: 0 }
	                        },
	                        hourly_data: [],
	                        operators: []
	                    }
	                },
	                currentModelId: '',
                explicitModelId: '',
                activeModelIds: [],
                rotationIndex: 0,
                defectMode: 'all',
	                displaySettings: {
	                    layoutWidth: 98,
	                    marginLeft: 30,
	                    marginTop: 12,
	                    cellFontSize: 16,
	                    sideFontSize: 14,
	                    metricFontSize: 66,
	                    percentFontSize: 40,
	                    refreshInterval: 10000
	                },
                errorMessage: '',
                scheduleLoaded: false,
                isWithinWorkSchedule: false,
                workScheduleSettings: {
                    enabled: true,
                    workDays: [],
                    startTime: '07:00',
                    endTime: '17:00'
                },
                refreshInterval: 10000,
                refreshTimer: null,
                refreshController: null,
                refreshRequestId: 0,
                dataUpdatedTimer: null,
                dataUpdated: false,

                async init() {
	                    const urlParams = new URLSearchParams(window.location.search);
	                    const lineName = urlParams.get('line');
	                    const modelId = urlParams.get('model');
	                    const defectMode = urlParams.get('defect') || urlParams.get('defectMode') || 'all';

	                    if (!lineName) {
	                        this.errorMessage = 'Parameter line tidak ditemukan. Gunakan format: public-display.html?line=NAMA_LINE&model=MODEL_ID';
	                        return;
	                    }

	                    this.lineData.name = lineName;
                    this.explicitModelId = modelId || '';
                    this.currentModelId = modelId || '';
	                    this.defectMode = ['all', 'critical', 'major', 'minor'].includes(defectMode) ? defectMode : 'all';
	                    await Promise.all([this.loadDisplaySettings(), this.loadWorkScheduleStatus()]);
	                    if (this.isWithinWorkSchedule) await this.loadLineData();
                    
                    this.setupAutoRefresh();
                    
                    this.updateDateTime();
                    setInterval(() => {
                        this.updateDateTime();
                        this.refreshWorkScheduleState();
                    }, 1000);
                    
	                },
                async loadLineData() {
                    if (!this.scheduleLoaded || !this.isWithinWorkSchedule) return;

                    const requestId = ++this.refreshRequestId;
                    if (this.refreshController) {
                        this.refreshController.abort();
                    }
                    this.refreshController = new AbortController();

                    try {
                        let response;
                        let selectedModelId = this.explicitModelId || '';
                        const encodedLineName = encodeURIComponent(this.lineData.name);

                        if (!selectedModelId) {
                            const activeModelsResponse = await fetch('/api/public/line/' + encodedLineName + '/active-models', { signal: this.refreshController.signal });
                            if (!activeModelsResponse.ok) {
                                if (activeModelsResponse.status === 403) {
                                    this.isWithinWorkSchedule = false;
                                    this.lineData.data = this.emptyLineData();
                                    this.errorMessage = '';
                                    await this.loadWorkScheduleStatus();
                                    return;
                                }
                                throw new Error('Gagal memuat daftar model aktif');
                            }

                            const activeModelsPayload = await activeModelsResponse.json();
                            this.activeModelIds = (activeModelsPayload.activeModels || [])
                                .map(item => item.modelId)
                                .filter(Boolean);

                            if (this.activeModelIds.length === 0) {
                                throw new Error('Tidak ada model aktif untuk line ini');
                            }

                            const rotationSlot = this.rotationIndex % this.activeModelIds.length;
                            selectedModelId = this.activeModelIds[rotationSlot];
                            this.rotationIndex = (rotationSlot + 1) % this.activeModelIds.length;
                        } else {
                            this.activeModelIds = [selectedModelId];
                        }

                        const encodedModelId = encodeURIComponent(selectedModelId);
                        response = await fetch('/api/public/line/' + encodedLineName + '/' + encodedModelId, { signal: this.refreshController.signal });

                        if (!response.ok && response.status !== 403) {
                            response = await fetch('/api/line/' + encodedLineName + '/' + encodedModelId, { signal: this.refreshController.signal });
                        }

                        if (requestId !== this.refreshRequestId) return;

                        if (response.ok) {
                            const data = await response.json();
                            if (requestId !== this.refreshRequestId) return;
                            this.lineData.data = data;
                            this.currentModelId = selectedModelId;
                            this.errorMessage = '';

                            this.dataUpdated = true;
                            if (this.dataUpdatedTimer) clearTimeout(this.dataUpdatedTimer);
                            this.dataUpdatedTimer = setTimeout(() => {
                                this.dataUpdated = false;
                            }, 1000);
                        } else {
                            const error = await response.json();
                            if (requestId !== this.refreshRequestId) return;
                            if (response.status === 403) {
                                this.isWithinWorkSchedule = false;
                                this.lineData.data = this.emptyLineData();
                                this.errorMessage = '';
                                await this.loadWorkScheduleStatus();
                                return;
                            }
                            this.errorMessage = error.error || 'Gagal memuat data line';
                        }
                    } catch (error) {
                        if (error.name === 'AbortError') return;
                        logPublicDisplayError('Error loading line data:', error);
                        this.errorMessage = error.message || 'Terjadi kesalahan saat memuat data';
                    } finally {
                        if (requestId === this.refreshRequestId) {
                            this.refreshController = null;
                        }
                    }
                },

                async loadWorkScheduleStatus() {
                    try {
                        const wasWithinSchedule = this.isWithinWorkSchedule;
                        const response = await fetch('/api/public/work-schedule-status');
                        if (!response.ok) throw new Error('Gagal memuat jadwal kerja');
                        const result = await response.json();
                        this.workScheduleSettings = result.settings;
                        this.isWithinWorkSchedule = result.withinWorkSchedule;

                        if (wasWithinSchedule && !this.isWithinWorkSchedule) {
                            this.lineData.data = this.emptyLineData();
                            this.errorMessage = '';
                        }
                    } catch (error) {
                        logPublicDisplayError('Error loading work schedule status:', error);
                        this.isWithinWorkSchedule = false;
                    } finally {
                        this.scheduleLoaded = true;
                    }
                },

                refreshWorkScheduleState() {
                    if (!this.scheduleLoaded) return;
                    const wasWithinSchedule = this.isWithinWorkSchedule;
                    this.isWithinWorkSchedule = this.calculateWithinWorkSchedule();

                    if (wasWithinSchedule && !this.isWithinWorkSchedule) {
                        this.lineData.data = this.emptyLineData();
                        this.errorMessage = '';
                    } else if (!wasWithinSchedule && this.isWithinWorkSchedule) {
                        this.loadLineData();
                    }
                },

                calculateWithinWorkSchedule() {
                    const schedule = this.workScheduleSettings;
                    if (!schedule?.enabled) return true;

                    const now = new Date();
                    const weekday = new Intl.DateTimeFormat('en-US', {
                        timeZone: 'Asia/Jakarta', weekday: 'short'
                    }).format(now);
                    const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday];
                    if (!schedule.workDays.map(Number).includes(day)) return false;

                    const jakartaTime = new Intl.DateTimeFormat('en-GB', {
                        timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
                    }).formatToParts(now);
                    const part = type => Number(jakartaTime.find(item => item.type === type)?.value || 0);
                    const current = (part('hour') * 60) + part('minute');
                    const toMinutes = value => {
                        const [hour, minute] = String(value || '00:00').split(':').map(Number);
                        return (hour * 60) + minute;
                    };
                    const start = toMinutes(schedule.startTime);
                    const end = toMinutes(schedule.endTime);
                    return start <= end
                        ? current >= start && current < end
                        : current >= start || current < end;
                },

                emptyLineData() {
                    return {
                        labelWeek: '', model: '', date: '', target: 0, targetPerHour: 0,
                        outputDay: 0, qcChecking: 0, actualDefect: 0, defectRatePercentage: 0,
                        defectBreakdown: {
                            all: { count: 0, rate: 0 },
                            critical: { count: 0, rate: 0 },
                            major: { count: 0, rate: 0 },
                            minor: { count: 0, rate: 0 }
                        },
                        hourly_data: [], operators: []
                    };
                },

                workScheduleDescription() {
                    const schedule = this.workScheduleSettings;
                    if (!schedule?.enabled) return '';
                    const names = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
                    const days = (schedule.workDays || []).map(day => names[Number(day)]).filter(Boolean).join(', ');
                    return `${days || 'Tidak ada hari kerja'} | ${schedule.startTime} - ${schedule.endTime} WIB`;
                },

                setupAutoRefresh() {
                    if (this.refreshTimer) {
                        clearInterval(this.refreshTimer);
                    }

                    if (this.refreshInterval > 0) {
                        this.refreshTimer = setInterval(async () => {
                            await this.loadWorkScheduleStatus();
                            if (this.isWithinWorkSchedule) await this.loadLineData();
                        }, this.refreshInterval);
                    }
                },

	                changeRefreshInterval() {
	                    this.refreshInterval = Number(this.refreshInterval) || 0;
	                    this.setupAutoRefresh();
	                },

	                changeDefectMode() {
	                    if (!['all', 'critical', 'major', 'minor'].includes(this.defectMode)) {
	                        this.defectMode = 'all';
	                    }

	                    const url = new URL(window.location.href);
	                    url.searchParams.set('defect', this.defectMode);
	                    window.history.replaceState({}, '', url.toString());
	                },

	                normalizeDisplaySettings(settings = {}) {
	                    const defaults = {
	                        layoutWidth: 98,
	                        marginLeft: 30,
	                        marginTop: 12,
	                        cellFontSize: 16,
	                        sideFontSize: 14,
	                        metricFontSize: 66,
	                        percentFontSize: 40,
	                        refreshInterval: 10000
	                    };

	                    return {
	                        layoutWidth: Number(settings.layoutWidth ?? defaults.layoutWidth),
	                        marginLeft: Number(settings.marginLeft ?? defaults.marginLeft),
	                        marginTop: Number(settings.marginTop ?? defaults.marginTop),
	                        cellFontSize: Number(settings.cellFontSize ?? defaults.cellFontSize),
	                        sideFontSize: Number(settings.sideFontSize ?? defaults.sideFontSize),
	                        metricFontSize: Number(settings.metricFontSize ?? defaults.metricFontSize),
	                        percentFontSize: Number(settings.percentFontSize ?? defaults.percentFontSize),
	                        refreshInterval: Number(settings.refreshInterval ?? defaults.refreshInterval)
	                    };
	                },

	                async loadDisplaySettings() {
	                    try {
	                        const response = await fetch('/api/public-display-settings');
	                        if (response.ok) {
	                            this.displaySettings = this.normalizeDisplaySettings(await response.json());
	                            this.refreshInterval = this.displaySettings.refreshInterval;
	                        }
	                    } catch (error) {
	                        logPublicDisplayError('Error loading public display settings:', error);
	                    }
	                },

	                displayCssVars() {
	                    const settings = this.displaySettings || {};
	                    return {
	                        '--display-layout-width': `${settings.layoutWidth || 98}%`,
	                        '--display-margin-left': `${settings.marginLeft ?? 30}px`,
	                        '--display-margin-top': `${settings.marginTop ?? 12}px`,
	                        '--display-cell-font-size': `${settings.cellFontSize || 16}px`,
	                        '--display-output-font-size': `${Math.max((settings.cellFontSize || 16) + 2, 12)}px`,
	                        '--display-clock-font-size': `${Math.max((settings.cellFontSize || 16) + 4, 14)}px`,
	                        '--display-hour-font-size': `${Math.max((settings.sideFontSize || 14) - 2, 10)}px`,
	                        '--display-side-font-size': `${settings.sideFontSize || 14}px`,
	                        '--display-metric-font-size': `${settings.metricFontSize || 66}px`,
	                        '--display-percent-font-size': `${settings.percentFontSize || 40}px`
	                    };
	                },

	                updateDateTime() {
	                    const now = new Date();
	                    const dateEl = document.getElementById('current-date');
	                    const clockEl = document.getElementById('current-clock');
	                    if (dateEl) {
	                        dateEl.textContent = now.toLocaleDateString('id-ID', {
	                            weekday: 'long',
	                            day: '2-digit',
	                            month: 'short',
	                            year: 'numeric'
	                        });
	                    }
	                    if (clockEl) {
	                        clockEl.textContent = now.toLocaleTimeString('id-ID', {
	                            hour: '2-digit',
	                            minute: '2-digit',
	                            second: '2-digit'
	                        });
	                    }
	                },
                
	                getCurrentTimeInMinutes() {
                    const parts = new Intl.DateTimeFormat('en-US', {
                        timeZone: 'Asia/Jakarta', hour: 'numeric', minute: 'numeric', hour12: false
                    }).formatToParts(new Date());
                    const hour = Number(parts.find(part => part.type === 'hour')?.value || 0) % 24;
                    const minute = Number(parts.find(part => part.type === 'minute')?.value || 0);
                    return hour * 60 + minute;
                },

                parseHourRange(hourRange) {
                    if (!hourRange || typeof hourRange !== 'string') {
                        return null;
                    }

                    const [start, end] = hourRange.split(' - ');
                    if (!start || !end) {
                        return null;
                    }

                    const [startHour, startMinute] = start.split(':').map(Number);
                    const [endHour, endMinute] = end.split(':').map(Number);

                    return {
                        start: (startHour * 60) + startMinute,
                        end: (endHour * 60) + endMinute
                    };
                },

                getActiveHourData() {
                    if (!this.lineData.data.hourly_data || this.lineData.data.hourly_data.length === 0) {
                        return null;
                    }

                    const currentTime = this.getCurrentTimeInMinutes();
                    const productionHours = this.lineData.data.hourly_data.filter(hour => {
                        const range = this.parseHourRange(hour.hour);
                        return range && (parseInt(hour.targetManual) || 0) > 0;
                    });

                    for (const hour of productionHours) {
                        const range = this.parseHourRange(hour.hour);
                        if (currentTime >= range.start && currentTime < range.end) {
                            return hour;
                        }
                    }

                    // During breaks or after working hours, keep the latest production result visible.
                    const previousHour = [...productionHours].reverse().find(hour => {
                        const range = this.parseHourRange(hour.hour);
                        return range && currentTime >= range.end;
                    });

                    return previousHour || productionHours[0] || null;
                },

                reduceHoursUntilCurrent(reducer, initialValue) {
                    if (!this.lineData.data.hourly_data || this.lineData.data.hourly_data.length === 0) {
                        return initialValue;
                    }

                    const currentTime = this.getCurrentTimeInMinutes();
                    return this.lineData.data.hourly_data.reduce((acc, hour) => {
                        const range = this.parseHourRange(hour.hour);
                        if (!range || currentTime < range.start) {
                            return acc;
                        }

                        return reducer(acc, hour);
                    }, initialValue);
                },
                
                getCurrentHourTarget() {
                    const activeHour = this.getActiveHourData();
                    return activeHour ? (activeHour.targetManual || 0) : 0;
                },
                
                getCurrentHourRange() {
                    const activeHour = this.getActiveHourData();
                    return activeHour ? activeHour.hour : 'No active hour';
                },
                
                calculateCurrentHourBalance() {
                    const activeHour = this.getActiveHourData();
                    if (!activeHour) return 0;
                    return (activeHour.output || 0) - (activeHour.targetManual || 0);
                },
                
                calculateCumulativeBalance() {
                    return this.reduceHoursUntilCurrent((acc, hour) => {
                        return acc + ((hour.output || 0) - (hour.targetManual || 0));
                    }, 0);
                },
                
                calculateCumulativeBalancePercentage() {
                    const dailyTarget = this.lineData.data.target || 0;
                    if (!dailyTarget || dailyTarget === 0) return '0.0';
                    
                    const cumulativeBalance = this.calculateCumulativeBalance();
                    // Rumus: (Balance Akumulasi / Total Target 8 Jam) × 100%
                    const percentage = (cumulativeBalance / dailyTarget) * 100;
                    
                    return percentage.toFixed(1);
                },
                
                calculateTargetProgressPercentage() {
                    if (!this.lineData.data.target || this.lineData.data.target === 0) return '0.0';
                    
                    const cumulativeTarget = this.calculateCumulativeTarget();
                    const percentage = (cumulativeTarget / this.lineData.data.target) * 100;
                    
                    return percentage > 100 ? '100.0' : percentage.toFixed(1);
                },
                
                calculateCumulativeTarget() {
                    return this.reduceHoursUntilCurrent((acc, hour) => {
                        return acc + (hour.targetManual || 0);
                    }, 0);
                },
                
                calculateCumulativeOutput() {
                    return this.reduceHoursUntilCurrent((acc, hour) => {
                        return acc + (hour.output || 0);
                    }, 0);
                },
                
	                calculateOutputPercentage() {
	                    if (!this.lineData.data.target || this.lineData.data.target === 0) return '0.0';
	                    return ((this.lineData.data.outputDay || 0) / this.lineData.data.target * 100).toFixed(1);
	                },

	                formatNumber(value) {
	                    return (parseInt(value) || 0).toLocaleString('id-ID');
	                },

		                formatPercent(value) {
		                    return `${(parseFloat(value) || 0).toFixed(1)}%`;
		                },

		                normalizeDefectKey(value) {
		                    return String(value || '').trim().toLowerCase();
		                },

		                getDefectSeverity(type) {
		                    const lookups = this.lineData.data.defectSeverityLookups || { types: {} };
		                    const typeSeverity = lookups.types?.[this.normalizeDefectKey(type)];

		                    return ['major', 'critical'].includes(typeSeverity) ? typeSeverity : 'minor';
		                },

		                matchesDefectMode(type, area) {
		                    return this.defectMode === 'all' || this.getDefectSeverity(type) === this.defectMode;
		                },

		                selectedDefectBreakdown() {
		                    const breakdown = this.lineData.data.defectBreakdown || {};
		                    const selected = breakdown[this.defectMode];

		                    if (selected) {
		                        return selected;
		                    }

		                    return {
		                        count: this.lineData.data.actualDefect || 0,
		                        rate: this.lineData.data.defectRatePercentage || 0
		                    };
		                },

		                selectedDefectCount() {
		                    return this.selectedDefectBreakdown().count || 0;
		                },

		                selectedDefectRate() {
		                    return this.selectedDefectBreakdown().rate || 0;
		                },

		                defectTitle() {
		                    if (this.defectMode === 'critical') return 'CRITICAL DEFECT';
		                    if (this.defectMode === 'major') return 'MAJOR DEFECT';
		                    if (this.defectMode === 'minor') return 'MINOR DEFECT';
		                    return 'ACT DEFECT';
		                },

	                compactHour(value) {
	                    return String(value || '-').replace(/\s+/g, '');
	                },

	                isActiveHour(hour) {
                    const range = this.parseHourRange(hour?.hour);
                    if (!range) return false;
                    const currentTime = this.getCurrentTimeInMinutes();
                    return currentTime >= range.start && currentTime < range.end;
                },

	                hourlyOutputClass(hour) {
	                    return (parseInt(hour.output) || 0) >= (parseInt(hour.targetManual) || 0) ? 'output-ok' : 'output-ng';
	                },

                    hourlyQcGoodCount(hour) {
                        return Math.max((parseInt(hour.qcChecked) || 0) - (parseInt(hour.defect) || 0), 0);
                    },

                    hourlyQcGoodClass(hour) {
                        return this.hourlyQcGoodCount(hour) > 0 ? 'output-ok' : 'output-ng';
                    },

	                hourlyDefectClass(hour) {
	                    const output = parseInt(hour.output) || 0;
	                    const defect = parseInt(hour.defect) || 0;
	                    const rate = output + defect > 0 ? (defect / (output + defect)) * 100 : 0;
	                    return rate >= 3 ? 'output-ng' : 'output-ok';
	                },

	                get displayHours() {
	                    return (this.lineData.data.hourly_data || []).slice(0, 10);
	                },

	                get topDefects() {
	                    const counts = {};
	                    const qcChecks = this.lineData.data.qcChecks;

		                    if (Array.isArray(qcChecks)) {
		                        qcChecks
		                            .filter(check => check.result === 'defect')
		                            .filter(check => this.matchesDefectMode(check.type, check.area))
		                            .forEach(check => {
	                                const name = check.type || '-';
	                                counts[name] = (counts[name] || 0) + 1;
	                            });
	                    } else {
		                        (this.lineData.data.hourly_data || []).forEach(hour => {
		                            (hour.defectDetails || []).filter(detail => this.matchesDefectMode(detail.type, detail.area)).forEach(detail => {
		                                const name = detail.type || '-';
		                                counts[name] = (counts[name] || 0) + (parseInt(detail.quantity) || 1);
		                            });
		                        });
	                    }

	                    const items = Object.entries(counts)
	                        .map(([name, count]) => ({ name, count }))
	                        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
	                        .slice(0, 3);

	                    while (items.length < 3) {
	                        items.push({ name: '-', count: '-' });
	                    }

	                    return items;
	                }
	            }
	        }
        
        document.addEventListener('DOMContentLoaded', function() {
            if (typeof Alpine === 'undefined') {
                logPublicDisplayError('Alpine.js tidak terdeteksi. Pastikan sudah dimuat.');
            }
        });
