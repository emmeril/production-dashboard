
function getJakartaDateInput() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

function logClientError(context, error) {
    const message = String(context || 'Client error').replace(/:\s*$/, '');
    if (typeof error === 'undefined') {
        console.error(`[dashboard] [ERROR] ${message}`);
        return;
    }

    console.error(`[dashboard] [ERROR] ${message}`, error);
}

function dashboard() {
    return {
        // Authentication state
        isAuthenticated: false,
        currentUser: {},
        loginForm: {
            username: '',
            password: ''
        },
        loginError: '',

        // Navigation
        currentPage: 'dashboard',
        mobileMenuOpen: false,
        sidebarCollapsed: false,
        navigation: [],

        // Data
        lines: [],
        linesWithModels: [],
        lineDetail: {},
        currentLine: '',
        currentModelId: '',
        dashboardData: {
            daily: [],
            lineDaily: [],
            lines: [],
            topDefectAreas: [],
            topDefectTypes: []
        },
        dashboardChart: null,
        dashboardChartDateRange: '7',
        dashboardChartLine: '',
        dashboardChartCurrentPage: 1,
        dashboardChartAutoPlay: true,
        dashboardChartAutoPlayInterval: 6000,
        dashboardChartAutoPlayTimer: null,
        users: [],
        dateReport: [],
        reportStartDate: getJakartaDateInput(),
        reportEndDate: getJakartaDateInput(),
        productionClockMinute: null,
        qcHourIndex: 0,

        // Forms
        inputForm: {
            hourIndex: 0,
            output: 0,
            defect: 0,
            qcChecked: 0,
            targetManual: 0,
            defectDetails: []
        },
        defectEntry: {
            type: '',
            area: '',
            notes: ''
        },
	        isSavingProduction: false,
	        isSavingQc: false,

        // QC follows the same configurable work schedule as every non-admin action.
        isQcWithinWorkingHours() {
            return !this.isWorkScheduleLocked();
        },

        defectTypes: [],
        defectAreas: [],

        // Modals
        lineModal: {
            open: false,
            isEdit: false,
            data: {
                lineName: '',
                modelId: '',
                labelWeek: '',
                model: '',
                target: 180,
                date: getJakartaDateInput()
            }
        },

        modelModal: {
            open: false,
            data: {
                lineName: '',
                labelWeek: '',
                model: '',
                target: 180,
                date: getJakartaDateInput()
            }
        },

        userModal: {
            open: false,
            isEdit: false,
            data: {
                id: null,
                username: '',
                password: '',
                name: '',
                role: 'operator',
                line: ''
            }
        },
	        defectCategoryModal: {
	            open: false,
	            kind: 'type',
	            id: null,
	            name: '',
	            severity: 'minor'
	        },

	        publicDisplaySettings: {
	            layoutWidth: 98,
	            marginLeft: 30,
	            marginTop: 12,
	            cellFontSize: 16,
	            sideFontSize: 14,
	            metricFontSize: 66,
	            percentFontSize: 40,
	            refreshInterval: 10000
	        },
	        workScheduleSettings: {
	            enabled: true,
	            workDays: [1, 2, 3, 4, 5, 6],
	            startTime: '07:00',
	            endTime: '17:00'
	        },
	        maintenanceStatus: null,
	        backupHistory: [],
	        maintenanceLoading: false,
	        maintenanceAction: '',
	        backupSearchTerm: '',
	        backupTypeFilter: '',
	        backupCurrentPage: 1,
	        backupsPerPage: 10,
	        restoreModal: {
	            open: false,
	            backup: null,
	            confirmation: ''
	        },

        // Toast notification
        toast: {
            show: false,
            type: 'info',
            message: ''
        },

        // Pagination state
        // Dashboard pagination
        dashboardCurrentPage: 1,
        dashboardItemsPerPage: 10,
        dashboardSearchTerm: '',
        dashboardLineFilter: '',
        dashboardStatusFilter: '',

        // Lines pagination
        currentLinePage: 1,
        linesPerPage: 10,
        lineSearchTerm: '',
        lineNameFilter: '',
        lineStatusFilter: '',
        lineDetailController: null,
        lineDetailRequestId: 0,

        // Users pagination
        currentUserPage: 1,
        usersPerPage: 10,
        userSearchTerm: '',

        // Date report pagination
        currentReportPage: 1,
	        reportPerPage: 10,

	        // QC correction pagination
	        qcCurrentPage: 1,
	        qcItemsPerPage: 10,
	        qcSearchTerm: '',
	        qcResultFilter: '',

	        // Defect category pagination
	        defectTypeCurrentPage: 1,
	        defectTypeItemsPerPage: 10,
	        defectTypeSearchTerm: '',
	        defectTypeSeverityFilter: '',
	        defectAreaCurrentPage: 1,
	        defectAreaItemsPerPage: 10,
	        defectAreaSearchTerm: '',

        // Initialize
        async init() {
            this.refreshProductionClock();
            setInterval(() => this.refreshProductionClock(), 30000);
            await this.checkAuth();
            if (!this.isAuthenticated) {
                this.setupNavigation();
                return;
            }
            await this.loadWorkScheduleSettings();
            this.setupNavigation();
            const initialRoute = this.getInitialRouteState();
            if (this.isAuthenticated && initialRoute && this.canUseRouteState(initialRoute)) {
                this.applyRouteState(initialRoute);
            } else {
                this.restorePageState();
            }
            await this.loadLines();
            await this.loadCurrentPageData();
            await this.loadDashboardData();
        },

        // Authentication methods
        async checkAuth() {
            try {
                const response = await fetch('/api/current-user');
                if (response.ok) {
                    this.currentUser = await response.json();
                    this.isAuthenticated = true;
                } else {
                    this.isAuthenticated = false;
                }
            } catch (error) {
                logClientError('Auth check failed:', error);
                this.isAuthenticated = false;
            }
        },

        async login() {
            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(this.loginForm)
                });

                if (response.ok) {
                    const data = await response.json();
                    this.currentUser = data.user;
                    this.isAuthenticated = true;
                    this.loginError = '';
                    await this.loadWorkScheduleSettings();
                    this.setupNavigation();
                    const initialRoute = this.getInitialRouteState();
                    if (initialRoute && this.canUseRouteState(initialRoute)) {
                        this.applyRouteState(initialRoute);
                    } else {
                        this.restorePageState();
                    }
                    await this.loadLines();
                    await this.loadCurrentPageData();
                    await this.loadDashboardData();
                } else {
                    const error = await response.json();
                    this.loginError = error.error || 'Login failed';
                    this.showToast(error.error, 'error');
                }
            } catch (error) {
                logClientError('Login error:', error);
                this.loginError = 'Network error. Please try again.';
                this.showToast('Network error. Please try again.', 'error');
            }
        },

        async logout() {
            try {
                await fetch('/api/logout', { method: 'POST' });
            } catch (error) {
                logClientError('Logout error:', error);
            } finally {
                this.stopDashboardChartAutoplay();
                this.isAuthenticated = false;
                this.currentUser = {};
                this.currentPage = 'dashboard';
                // Clear saved page state on logout
                localStorage.removeItem('dashboardPageState');
            }
        },

	        // Navigation
	        setupNavigation() {
	            const lineSummaryNav = { name: 'Ringkasan Line', page: 'line-summary', iconClass: 'fa-industry' };
	            const baseNav = this.canViewDashboard()
	                ? [
	                    { name: 'Dashboard', page: 'dashboard', iconClass: 'fa-house' },
	                    lineSummaryNav
	                ]
	                : [lineSummaryNav];

	            if (this.canViewDashboard()) {
	                this.navigation = [...baseNav];
	                if (this.canManageLines()) {
	                    this.navigation.push({ name: 'Management Line', page: 'admin-management', iconClass: 'fa-list-check' });
	                }
                if (this.currentUser.role === 'admin') {
	                    this.navigation.push(
	                        { name: 'Manajemen User', page: 'user-management', iconClass: 'fa-users-gear' },
	                        { name: 'Kategori Defect', page: 'defect-categories', iconClass: 'fa-triangle-exclamation' },
	                        { name: 'Hari Kerja', page: 'work-schedule-settings', iconClass: 'fa-calendar-days' },
	                        { name: 'Public Display', page: 'public-display-settings', iconClass: 'fa-tv' },
                        { name: 'Maintenance', page: 'system-actions', iconClass: 'fa-screwdriver-wrench' }
                    );
                } else if (this.canManageDefectCategories()) {
                    this.navigation.push({ name: 'Kategori Defect', page: 'defect-categories', iconClass: 'fa-triangle-exclamation' });
	                }
	            } else {
	                this.navigation = baseNav;
	            }

                if (this.canViewReport()) {
                    this.navigation.push({ name: 'Report', page: 'report', iconClass: 'fa-chart-column' });
                }
	        },

	        canViewDashboard() {
	            return this.currentUser.role === 'admin' || this.isAdminOperator();
	        },

	        isAdminOperator() {
	            return ['admin_operator_sewing', 'admin_operator_qc'].includes(this.currentUser.role);
	        },

            canViewReport() {
                return ['admin', 'admin_operator_sewing', 'admin_operator_qc'].includes(this.currentUser.role);
            },

	        canManageLines() {
	            return ['admin', 'admin_operator_sewing'].includes(this.currentUser.role);
	        },

	        canManageDefectCategories() {
	            return ['admin', 'admin_operator_qc'].includes(this.currentUser.role);
	        },

	        canManageProduction() {
	            return ['admin', 'operator'].includes(this.currentUser.role);
	        },

	        canManageQc() {
	            return ['admin', 'operator'].includes(this.currentUser.role);
	        },

	        canDeleteQc() {
	            return ['admin', 'admin_operator_qc'].includes(this.currentUser.role);
	        },

	        canCorrectProduction() {
	            return ['admin', 'admin_operator_sewing'].includes(this.currentUser.role);
	        },

	        canCorrectQc() {
	            return ['admin', 'admin_operator_qc'].includes(this.currentUser.role);
	        },

	        isSewingReportViewer() {
	            return this.currentUser.role === 'admin_operator_sewing';
	        },

	        isQcReportViewer() {
	            return this.currentUser.role === 'admin_operator_qc';
	        },

	        roleLabel(role) {
	            return {
	                admin: 'Admin',
	                admin_operator_sewing: 'Admin Operator Sewing',
	                admin_operator_qc: 'Admin Operator QC',
	                operator: 'Operator'
	            }[role] || role;
	        },

	        getDefaultPage() {
	            if (this.isAdminOperator()) return 'report';
	            return this.canViewDashboard() ? 'dashboard' : 'line-summary';
	        },

        getInitialRouteState() {
            const path = window.location.pathname.replace(/\/$/, '');

            if (path === '/admin') {
                return { currentPage: 'admin-management' };
            }

	            if (path === '/leader') {
	                return { currentPage: 'dashboard' };
	            }

            const lineMatch = path.match(/^\/line\/([^/]+)$/);
            if (lineMatch) {
                return {
                    currentPage: 'line-detail',
                    currentLine: decodeURIComponent(lineMatch[1])
                };
            }

            const inputMatch = path.match(/^\/input\/([^/]+)$/);
            if (inputMatch) {
                return {
                    currentPage: 'input-data',
                    currentLine: decodeURIComponent(inputMatch[1])
                };
            }

            return null;
        },

	        canUseRouteState(state) {
	            if (state.currentPage === 'dashboard') {
	                return this.canViewDashboard();
	            }

	            if (state.currentPage === 'admin-management') {
	                return this.canManageLines();
	            }

            if (state.currentPage === 'report') {
                return this.canViewReport();
            }

	            if (state.currentPage === 'user-management' || state.currentPage === 'defect-categories' || state.currentPage === 'work-schedule-settings' || state.currentPage === 'public-display-settings' || state.currentPage === 'system-actions') {
	                return state.currentPage === 'defect-categories'
	                    ? this.canManageDefectCategories()
	                    : this.currentUser.role === 'admin';
	            }

            if (state.currentPage === 'input-data') {
                return this.canManageProduction() || this.canManageQc();
            }

            return true;
        },

	        applyRouteState(state) {
	            this.currentPage = state.currentPage || this.getDefaultPage();
	            this.currentLine = state.currentLine || '';
	            this.currentModelId = state.currentModelId || '';
	            this.savePageState();
        },

        async loadCurrentPageData() {
            if (this.currentUser.role === 'operator'
                && this.currentModelId
                && !this.isManagementModelActive(this.currentLine, this.currentModelId)) {
                this.currentPage = 'line-summary';
                this.currentLine = '';
                this.currentModelId = '';
                this.savePageState();
                this.showToast('Model tersimpan sudah tidak Active. Silakan pilih model aktif.', 'info');
                return;
            }

            if ((this.currentPage === 'line-detail' || this.currentPage === 'input-data') && this.currentLine) {
                await this.loadLineDetail(this.currentLine, this.currentModelId);
            }

            if (this.currentPage === 'input-data') {
                await this.loadDefectConfig();
                if (!this.inputForm.defectDetails) this.resetInputForm();
                this.syncInputFormFromSelectedHour();
            }

            if (this.currentPage === 'admin-management') {
                await this.loadAdminData();
            }

            if (this.currentPage === 'user-management') {
                await this.loadUsers();
            }

	            if (this.currentPage === 'defect-categories') {
	                await this.loadDefectConfig();
	            }

	            if (this.currentPage === 'public-display-settings') {
	                await this.loadPublicDisplaySettings();
	            }

	            if (this.currentPage === 'work-schedule-settings') {
	                await this.loadWorkScheduleSettings();
	            }

	            if (this.currentPage === 'system-actions') {
	                await this.loadMaintenanceData();
	            }
	        },

	        changePage(page) {
	            if (page === 'dashboard' && !this.canViewDashboard()) {
	                this.currentPage = this.getDefaultPage();
	                this.savePageState();
	                return;
	            }

	            this.currentPage = page;
            this.savePageState();
            if (page !== 'dashboard') {
                this.stopDashboardChartAutoplay();
            }
            if (page === 'dashboard' || page === 'line-summary') {
                this.loadDashboardData();
            }
            if (page === 'user-management') {
                this.loadUsers();
            }
	            if (page === 'defect-categories') {
	                this.loadDefectConfig();
	            }
	            if (page === 'public-display-settings') {
	                this.loadPublicDisplaySettings();
	            }
	            if (page === 'work-schedule-settings') {
	                this.loadWorkScheduleSettings();
	            }
	            if (page === 'system-actions') {
	                this.loadMaintenanceData();
	            }
	        },

	        viewLine(lineName, modelId) {
	            this.currentLine = lineName;
	            this.currentModelId = modelId;
	            this.qcCurrentPage = 1;
	            this.qcSearchTerm = '';
	            this.qcResultFilter = '';
	            this.loadLineDetail(lineName, modelId);
	            this.changePage('line-detail');
	        },

        async inputData(lineName, modelId) {
            if (!this.canManageProduction() && !this.canManageQc()) {
                this.showToast('Anda tidak memiliki akses untuk input data', 'error');
                return;
            }

            if (!this.isManagementModelActive(lineName, modelId)) {
                this.showToast('Model ini tidak berstatus Active di Management Line. Pilih model aktif untuk input.', 'error');
                this.changePage('line-summary');
                return;
            }

            this.currentLine = lineName;
            this.currentModelId = modelId;
            this.resetInputForm();
            await this.loadLineDetail(lineName, modelId);
            await this.loadDefectConfig();
            this.syncInputFormFromSelectedHour();
            this.changePage('input-data');
        },

        // Save and restore page state
        savePageState() {
            if (this.isAuthenticated) {
                const pageState = {
                    currentPage: this.currentPage,
                    currentLine: this.currentLine,
                    currentModelId: this.currentModelId
                };
                localStorage.setItem('dashboardPageState', JSON.stringify(pageState));
            }
        },

	        restorePageState() {
	            if (this.isAuthenticated) {
	                const savedState = localStorage.getItem('dashboardPageState');
	                let restored = false;
	                if (savedState) {
	                    try {
	                        const state = JSON.parse(savedState);

                        // Check if the saved page is allowed for current user
                        const allowedPages = [
                            ...this.navigation.map(item => item.page),
                            'line-detail',
                            'input-data'
                        ];
	                        if (allowedPages.includes(state.currentPage) && this.canUseRouteState(state)) {
	                            this.currentPage = state.currentPage;
	                            this.currentLine = state.currentLine || '';
	                            this.currentModelId = state.currentModelId || '';
	                            restored = true;

                            // If we're on line-detail or input-data page, load the line detail
                            if ((this.currentPage === 'line-detail' || this.currentPage === 'input-data') &&
                                this.currentLine && this.currentModelId) {
                                this.loadLineDetail(this.currentLine, this.currentModelId).then(() => {
                                    if (this.currentPage === 'input-data') {
                                        if (!this.inputForm.defectDetails) this.resetInputForm();
                                        this.syncInputFormFromSelectedHour();
                                    }
                                });
                            }

                            if (this.currentPage === 'input-data') {
                                this.loadDefectConfig();
                            }


                            if (this.currentPage === 'user-management') {
                                this.loadUsers();
                            }

                            if (this.currentPage === 'defect-categories') {
                                this.loadDefectConfig();
                            }
                        }
	                    } catch (error) {
	                        logClientError('Error restoring page state:', error);
	                    }
	                }

	                if (!restored) {
	                    this.currentPage = this.getDefaultPage();
	                    this.currentLine = '';
	                    this.currentModelId = '';
	                    this.savePageState();
	                }
	            }
	        },

        // Data loading methods
        async loadLines() {
            try {
                const response = await fetch('/api/lines');
                if (response.ok) {
                    const data = await response.json();
                    this.lines = Object.keys(data).map(key => ({
                        name: key,
                        data: data[key]
                    }));

                    // Process lines with models for display
                    this.linesWithModels = [];
                    Object.keys(data).forEach(lineName => {
                        const line = data[lineName];
                        if (line.models) {
                            const modelIds = Object.keys(line.models);
                            modelIds.forEach((modelId, index) => {
                                this.linesWithModels.push({
                                    key: `${lineName}-${modelId}`,
                                    lineName: lineName,
                                    modelId: modelId,
                                    modelCount: modelIds.length,
                                    isFirstModel: index === 0,
                                    data: {
                                        ...line.models[modelId],
                                        lineActiveModel: line.activeModel,
                                        lineActiveModels: Array.isArray(line.activeModels) ? line.activeModels : (line.activeModel ? [line.activeModel] : [])
                                    }
                                });
                            });
                        }
                    });

                    if (this.lineNameFilter && !this.availableManagementLines.includes(this.lineNameFilter)) {
                        this.lineNameFilter = '';
                        this.currentLinePage = 1;
                    }
                    if (this.dashboardLineFilter && !this.availableDashboardLines.includes(this.dashboardLineFilter)) {
                        this.dashboardLineFilter = '';
                        this.dashboardCurrentPage = 1;
                    }
                    if (this.dashboardCurrentPage > Math.max(1, this.totalDashboardPages)) {
                        this.dashboardCurrentPage = 1;
                    }
                }
            } catch (error) {
                logClientError('Error loading lines:', error);
                this.showToast('Error loading lines', 'error');
            }
        },

        async loadLineDetail(lineName, modelId) {
            const requestId = ++this.lineDetailRequestId;
            if (this.lineDetailController) {
                this.lineDetailController.abort();
            }
            this.lineDetailController = new AbortController();

            try {
                let url;
                if (modelId) {
                    url = `/api/line/${lineName}/${modelId}`;
                } else {
                    url = `/api/line/${lineName}`;
                }

                const response = await fetch(url, { signal: this.lineDetailController.signal });
                if (requestId !== this.lineDetailRequestId) return;

                if (response.ok) {
                    const lineDetail = await response.json();
                    if (requestId !== this.lineDetailRequestId) return;

                    this.lineDetail = lineDetail;
                    if (!modelId && this.lineDetail.modelId) {
                        this.currentModelId = this.lineDetail.modelId;
                    }
                    this.selectCurrentProductionHour();
                } else {
                    this.showToast('Failed to load line detail', 'error');
                }
            } catch (error) {
                if (error.name === 'AbortError') return;
                logClientError('Error loading line detail:', error);
                this.showToast('Error loading line detail', 'error');
            } finally {
                if (requestId === this.lineDetailRequestId) {
                    this.lineDetailController = null;
                }
            }
        },

	        async loadDashboardData() {
	            if (!this.canViewDashboard()) {
	                return;
	            }

	            await this.loadLines();

            // Calculate dashboard totals from all models
            let totalOutput = 0;
            let totalTarget = 0;
            let totalDefect = 0;
            let totalQcChecked = 0;

            this.linesWithModels.forEach(line => {
                totalOutput += line.data.outputDay || 0;
                totalTarget += line.data.target || 0;
                totalDefect += Number(line.data.actualDefect) || 0;
                totalQcChecked += Number(line.data.qcChecking) || 0;
            });

	        // Kedua endpoint ini tidak saling bergantung, jadi muat bersamaan.
            const [usersResult, summaryResult] = await Promise.allSettled([
                fetch('/api/operator-count').then(response => response.ok ? response.json() : { operatorCount: 0 }),
                fetch('/api/dashboard-summary').then(response => response.ok ? response.json() : null)
            ]);
            const operatorCountData = usersResult.status === 'fulfilled' ? usersResult.value : { operatorCount: 0 };
            const activeOperators = Number(operatorCountData.operatorCount) || 0;
            const dashboardSummary = summaryResult.status === 'fulfilled' && summaryResult.value
                ? summaryResult.value
                : { daily: [], lineDaily: [], lines: [], topDefectAreas: [], topDefectTypes: [] };

            this.dashboardData = {
                totalOutput: totalOutput,
                totalTarget: totalTarget,
                defectRate: totalQcChecked > 0 ? ((totalDefect / totalQcChecked) * 100).toFixed(2) : 0,
                activeOperators: activeOperators,
                daily: dashboardSummary.daily || [],
                lineDaily: dashboardSummary.lineDaily || [],
                lines: dashboardSummary.lines || [],
                topDefectAreas: dashboardSummary.topDefectAreas || [],
                topDefectTypes: dashboardSummary.topDefectTypes || []
            };
            this.$nextTick(() => {
                if (this.dashboardChartCurrentPage > this.dashboardChartTotalPages) {
                    this.dashboardChartCurrentPage = 1;
                }
                this.renderDashboardChart();
                this.startDashboardChartAutoplay();
            });
        },

        async loadAdminData() {
            await this.loadLines();
        },

        async loadUsers() {
            try {
                const response = await fetch('/api/users');
                if (response.ok) {
                    this.users = await response.json();
                }
            } catch (error) {
                logClientError('Error loading users:', error);
                this.showToast('Error loading users', 'error');
            }
        },

        async loadDefectConfig() {
            try {
                const response = await fetch('/api/defect-config');
                if (response.ok) {
                    const config = await response.json();
                    this.defectTypes = config.defectTypes || [];
                    this.defectAreas = config.defectAreas || [];
	                this.defectTypeCurrentPage = Math.max(1, Math.min(this.defectTypeCurrentPage, this.totalDefectTypePages || 1));
	                this.defectAreaCurrentPage = Math.max(1, Math.min(this.defectAreaCurrentPage, this.totalDefectAreaPages || 1));
                } else {
                    this.showToast('Gagal memuat kategori defect', 'error');
                }
            } catch (error) {
                logClientError('Error loading defect config:', error);
                this.showToast('Error loading defect config', 'error');
            }
        },

        editDefectType(type) {
            this.openDefectCategoryModal('type', type);
        },

        editDefectArea(area) {
            this.openDefectCategoryModal('area', area);
        },

	        openDefectCategoryModal(kind, item = null) {
	            this.defectCategoryModal = {
	                open: true,
	                kind,
	                id: item ? item.id : null,
	                name: item ? item.name : '',
	                severity: kind === 'type' ? (item?.severity || 'minor') : ''
	            };
	        },

        closeDefectCategoryModal() {
            this.defectCategoryModal = {
	                open: false,
	                kind: 'type',
	                id: null,
	                name: '',
	                severity: 'minor'
	            };
	        },

        async saveDefectCategoryModal() {
            const kind = this.defectCategoryModal.kind;
            const name = (this.defectCategoryModal.name || '').trim();
            if (!name) {
                this.showToast('Nama kategori defect wajib diisi', 'error');
                return;
            }

	            const saved = await this.saveDefectCategory(kind, {
	                id: this.defectCategoryModal.id,
	                name,
	                severity: kind === 'type' ? (this.defectCategoryModal.severity || 'minor') : undefined,
	                active: true
	            });
            if (saved) this.closeDefectCategoryModal();
        },

        async toggleDefectType(type) {
            await this.saveDefectCategory('type', {
	                id: type.id,
	                name: type.name,
	                severity: type.severity || 'minor',
	                active: type.active === false
	            });
        },

        async toggleDefectArea(area) {
            await this.saveDefectCategory('area', {
	                id: area.id,
	                name: area.name,
	                active: area.active === false
	            });
        },

        async saveDefectCategory(kind, payload) {
            try {
                const collection = kind === 'type' ? 'defect-types' : 'defect-areas';
                const url = payload.id ? `/api/${collection}/${payload.id}` : `/api/${collection}`;
                const method = payload.id ? 'PUT' : 'POST';
	            const body = { name: payload.name, active: payload.active };
	            if (kind === 'type') body.severity = payload.severity || 'minor';
                const response = await fetch(url, {
                    method,
                    headers: { 'Content-Type': 'application/json' },
	                    body: JSON.stringify(body)
	                });

                if (response.ok) {
                    this.showToast('Kategori defect berhasil disimpan', 'success');
                    await this.loadDefectConfig();
                    return true;
                } else {
                    const error = await response.json();
                    this.showToast(error.error || 'Gagal menyimpan kategori defect', 'error');
                    return false;
                }
            } catch (error) {
                logClientError('Error saving defect category:', error);
                this.showToast('Error saving defect category', 'error');
                return false;
            }
        },

        async deleteDefectType(typeId) {
            await this.deleteDefectCategory('defect-types', typeId);
        },

        async deleteDefectArea(areaId) {
            await this.deleteDefectCategory('defect-areas', areaId);
        },

	        async deleteDefectCategory(collection, id) {
	            if (!confirm('Hapus kategori defect ini?')) return;

            try {
                const response = await fetch(`/api/${collection}/${id}`, { method: 'DELETE' });
                if (response.ok) {
                    this.showToast('Kategori defect berhasil dihapus', 'success');
                    await this.loadDefectConfig();
                } else {
                    const error = await response.json();
                    this.showToast(error.error || 'Gagal menghapus kategori defect', 'error');
                }
            } catch (error) {
                logClientError('Error deleting defect category:', error);
                this.showToast('Error deleting defect category', 'error');
	            }
	        },

	        normalizePublicDisplaySettings(settings = {}) {
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

	        async loadPublicDisplaySettings() {
	            try {
	                const response = await fetch('/api/public-display-settings');
	                if (response.ok) {
	                    this.publicDisplaySettings = this.normalizePublicDisplaySettings(await response.json());
	                } else {
	                    this.showToast('Gagal memuat setting public display', 'error');
	                }
	            } catch (error) {
	                logClientError('Error loading public display settings:', error);
	                this.showToast('Error loading public display settings', 'error');
	            }
	        },

	        async savePublicDisplaySettings() {
	            try {
	                const response = await fetch('/api/public-display-settings', {
	                    method: 'PUT',
	                    headers: { 'Content-Type': 'application/json' },
	                    body: JSON.stringify(this.normalizePublicDisplaySettings(this.publicDisplaySettings))
	                });

	                if (response.ok) {
	                    const result = await response.json();
	                    this.publicDisplaySettings = this.normalizePublicDisplaySettings(result.settings);
	                    this.showToast('Setting public display berhasil disimpan', 'success');
	                } else {
	                    const error = await response.json();
	                    this.showToast(error.error || 'Gagal menyimpan setting public display', 'error');
	                }
	            } catch (error) {
	                logClientError('Error saving public display settings:', error);
	                this.showToast('Error saving public display settings', 'error');
	            }
	        },

	        resetPublicDisplaySettings() {
	            this.publicDisplaySettings = this.normalizePublicDisplaySettings();
	        },

	        async loadWorkScheduleSettings() {
	            try {
	                const response = await fetch('/api/work-schedule-settings');
	                if (!response.ok) throw new Error('Gagal memuat pengaturan hari kerja');
	                this.workScheduleSettings = await response.json();
	            } catch (error) {
	                logClientError('Error loading work schedule settings:', error);
	                this.showToast(error.message, 'error');
	            }
	        },

	        isWorkScheduleLocked() {
	            if (!this.isAuthenticated || this.currentUser?.role === 'admin') return false;
	            if (!this.workScheduleSettings?.enabled) return false;

	            // Reference the clock tick so Alpine reevaluates the lock every 30 seconds.
	            this.productionClockMinute;
	            const now = new Date();
	            const weekday = new Intl.DateTimeFormat('en-US', {
	                timeZone: 'Asia/Jakarta', weekday: 'short'
	            }).format(now);
	            const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday];
	            if (!this.workScheduleSettings.workDays.includes(day)) return true;

	            const current = this.getCurrentProductionMinute();
	            const toMinutes = value => {
	                const [hour, minute] = String(value || '00:00').split(':').map(Number);
	                return (hour * 60) + minute;
	            };
	            const start = toMinutes(this.workScheduleSettings.startTime);
	            const end = toMinutes(this.workScheduleSettings.endTime);
	            const withinTime = start <= end
	                ? current >= start && current < end
	                : current >= start || current < end;
	            return !withinTime;
	        },

	        async saveWorkScheduleSettings() {
	            if (!this.workScheduleSettings.workDays.length) {
	                this.showToast('Pilih minimal satu hari kerja', 'error');
	                return;
	            }
	            try {
	                const response = await fetch('/api/work-schedule-settings', {
	                    method: 'PUT',
	                    headers: { 'Content-Type': 'application/json' },
	                    body: JSON.stringify(this.workScheduleSettings)
	                });
	                const result = await response.json();
	                if (!response.ok) throw new Error(result.error || 'Gagal menyimpan pengaturan hari kerja');
	                this.workScheduleSettings = result.settings;
	                this.showToast(result.message, 'success');
	            } catch (error) {
	                logClientError('Error saving work schedule settings:', error);
	                this.showToast(error.message, 'error');
	            }
	        },

	        publicDisplayPreviewUrl(defectMode = 'all') {
	            const lineName = this.lines?.[0]?.name || 'LINE_NAME';
	            return `/public-display?line=${encodeURIComponent(lineName)}&defect=${defectMode}`;
	        },

	        publicDisplayPreviewLinks() {
	            return [
	                {
	                    mode: 'all',
	                    label: 'Semua Defect',
	                    badge: 'Lengkap',
	                    description: 'Menampilkan data produksi dengan seluruh kategori defect.',
	                    url: this.publicDisplayPreviewUrl('all'),
	                    badgeClass: 'bg-blue-100 text-blue-700',
	                    buttonClass: 'btn-action-primary'
	                },
	                {
	                    mode: 'critical',
	                    label: 'Defect Critical',
	                    badge: 'Critical',
	                    description: 'Menampilkan data produksi dengan defect kategori critical saja.',
	                    url: this.publicDisplayPreviewUrl('critical'),
	                    badgeClass: 'bg-red-100 text-red-800',
	                    buttonClass: 'btn-action-danger'
	                },
	                {
	                    mode: 'major',
	                    label: 'Defect Major',
	                    badge: 'Major',
	                    description: 'Menampilkan data produksi dengan defect kategori major saja.',
	                    url: this.publicDisplayPreviewUrl('major'),
	                    badgeClass: 'bg-orange-100 text-orange-700',
	                    buttonClass: 'btn-action-danger'
	                },
	                {
	                    mode: 'minor',
	                    label: 'Defect Minor',
	                    badge: 'Minor',
	                    description: 'Menampilkan data produksi dengan defect kategori minor saja.',
	                    url: this.publicDisplayPreviewUrl('minor'),
	                    badgeClass: 'bg-gray-100 text-gray-700',
	                    buttonClass: 'btn-action-neutral'
	                }
	            ];
	        },

	        // Date-based report methods
	        async loadDateReport() {
            if (!this.reportStartDate || !this.reportEndDate) {
                this.showToast('Pilih tanggal mulai dan tanggal selesai terlebih dahulu', 'error');
                return;
            }
            if (this.reportStartDate > this.reportEndDate) {
                this.showToast('Tanggal mulai tidak boleh lebih besar dari tanggal selesai', 'error');
                return;
            }

            try {
                const params = new URLSearchParams({ startDate: this.reportStartDate, endDate: this.reportEndDate });
                const response = await fetch(`/api/date-report?${params.toString()}`);
                if (response.ok) {
                    this.dateReport = await response.json();
                    this.currentReportPage = 1; // Reset to first page
                    this.showToast(this.dateReport.length ? 'Laporan berhasil dimuat' : 'Tidak ada data pada rentang tanggal tersebut', this.dateReport.length ? 'success' : 'info');
                } else {
                    this.showToast('Gagal memuat laporan', 'error');
                }
            } catch (error) {
                logClientError('Error loading date report:', error);
                this.showToast('Error loading date report', 'error');
            }
        },

	        async exportDateReport() {
            if (!this.reportStartDate || !this.reportEndDate) {
                this.showToast('Pilih tanggal mulai dan tanggal selesai terlebih dahulu', 'error');
                return;
            }
            if (this.reportStartDate > this.reportEndDate) {
                this.showToast('Tanggal mulai tidak boleh lebih besar dari tanggal selesai', 'error');
                return;
            }

            try {
                const params = new URLSearchParams({ startDate: this.reportStartDate, endDate: this.reportEndDate });
                const response = await fetch(`/api/export-date-report?${params.toString()}`);
                if (response.ok) {
                    const blob = await response.blob();
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = this.reportStartDate === this.reportEndDate
                        ? `Production_Report_${this.reportStartDate}.xlsx`
                        : `Production_Report_${this.reportStartDate}_to_${this.reportEndDate}.xlsx`;
                    document.body.appendChild(a);
                    a.click();
                    window.URL.revokeObjectURL(url);
                    document.body.removeChild(a);
                    this.showToast('Excel exported successfully', 'success');
                } else {
                    const error = await response.json();
                    this.showToast(error.error || 'Failed to export Excel', 'error');
                }
            } catch (error) {
                logClientError('Error exporting Excel:', error);
                this.showToast('Error exporting Excel', 'error');
            }
        },

        async exportDateReportLine(line) {
            if (!line?.date || !line?.line || !line?.modelId) {
                this.showToast('Data line untuk export tidak lengkap', 'error');
                return;
            }

            try {
                const date = encodeURIComponent(line.date);
                const lineName = encodeURIComponent(line.line);
                const modelId = encodeURIComponent(line.modelId);
                const response = await fetch(`/api/export-date-report/${date}/${lineName}/${modelId}`);

                if (!response.ok) {
                    const error = await response.json();
                    this.showToast(error.error || 'Gagal export detail line', 'error');
                    return;
                }

                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `Production_QC_Detail_${line.line}_${line.modelId}_${line.date}.xlsx`;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                this.showToast(`Detail ${line.line} berhasil diexport`, 'success');
            } catch (error) {
                logClientError('Error exporting line detail:', error);
                this.showToast('Error export detail line', 'error');
            }
        },

        // Input data methods
        resetInputForm() {
            this.inputForm = {
                hourIndex: 0,
                output: this.currentUser.role === 'operator' ? '' : 0,
                targetManual: 0,
                defectDetails: []
            };
            this.qcHourIndex = 0;
            this.resetDefectEntry();
        },

        resetDefectEntry() {
            this.defectEntry = { type: '', area: '', notes: '' };
        },

	        syncInputFormFromSelectedHour() {
	            const hour = this.lineDetail.hourly_data?.[this.inputForm.hourIndex];
	            if (!hour) return;

	            const output = parseInt(hour.output) || 0;
	            this.inputForm.output = this.currentUser.role === 'operator' && !hour.productionLocked && output === 0
	                ? ''
	                : output;
	            this.inputForm.targetManual = parseInt(hour.targetManual) || 0;
	        },

        isProductionOutputBlank(value = this.inputForm.output) {
            return value === undefined || value === null || String(value).trim() === '';
        },

	        isProductionHourLocked(hour) {
	            return this.currentUser.role === 'operator' && (
	                Boolean(hour?.productionLocked) ||
                    this.isProductionBreakHour(hour) ||
                    this.isOperatorProductionBreakTime() ||
                    this.isProductionHourTooEarly(hour)
	            );
	        },

        isProductionBreakHour(hour) {
            return String(hour?.hour || '').trim() === '11:00 - 13:00';
        },

        isOperatorProductionBreakTime() {
            if (this.currentUser.role !== 'operator') return false;
            const currentMinutes = this.productionClockMinute ?? this.getCurrentProductionMinute();
            return currentMinutes >= 11 * 60 && currentMinutes < 13 * 60;
        },

        selectedProductionLockMessage() {
            const hour = this.lineDetail.hourly_data?.[this.inputForm.hourIndex];
            if (this.isProductionBreakHour(hour) || this.isOperatorProductionBreakTime()) {
                return 'Jam istirahat. Input produksi dibuka kembali pukul 13:00';
            }
            if (this.isProductionHourTooEarly(hour)) return 'Jam produksi ini belum dimulai';
            return 'Data jam ini sudah terkunci';
        },

	        isProductionHourTooEarly(hour) {
	            if (this.currentUser.role !== 'operator') return false;

	            const match = String(hour?.hour || '').match(/^(\d{1,2}):(\d{2})/);
	            if (!match) return false;

	            const currentMinutes = this.productionClockMinute ?? this.getCurrentProductionMinute();
	            const startMinutes = (parseInt(match[1], 10) * 60) + parseInt(match[2], 10);
	            return currentMinutes < startMinutes;
	        },

	        getCurrentProductionMinute() {
	            const parts = new Intl.DateTimeFormat('en-US', {
	                timeZone: 'Asia/Jakarta', hour: 'numeric', minute: 'numeric', hour12: false
	            }).formatToParts(new Date());
	            const hour = Number(parts.find(part => part.type === 'hour')?.value || 0) % 24;
	            const minute = Number(parts.find(part => part.type === 'minute')?.value || 0);
	            return (hour * 60) + minute;
	        },

        getCurrentProductionHourIndex() {
            const minutes = this.getCurrentProductionMinute();
            const hours = this.lineDetail.hourly_data || [];
            return hours.findIndex(hour => {
                const match = String(hour.hour || '').match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
                if (!match) return false;
                const start = Number(match[1]) * 60 + Number(match[2]);
                const end = Number(match[3]) * 60 + Number(match[4]);
                return minutes >= start && minutes < end;
            });
        },

        selectCurrentQcHour() {
            const index = this.getCurrentProductionHourIndex();
            if (index >= 0) this.qcHourIndex = index;
        },

        selectCurrentProductionHour() {
            if (this.currentUser.role !== 'operator') return;
            const index = this.getCurrentProductionHourIndex();
            const hour = this.lineDetail.hourly_data?.[index];
            if (index >= 0 && !this.isProductionBreakHour(hour)) {
                this.inputForm.hourIndex = index;
                this.syncInputFormFromSelectedHour();
            }
        },

	        refreshProductionClock() {
	            this.productionClockMinute = this.getCurrentProductionMinute();
	        },

	        isSelectedProductionHourLocked() {
	            const hour = this.lineDetail.hourly_data?.[this.inputForm.hourIndex];
	            return this.isProductionHourLocked(hour);
	        },

	        async submitProductionData() {
	            if (this.isSavingProduction) return;

	            if (!this.canManageProduction()) {
	                this.showToast('Anda tidak memiliki akses untuk input hasil sewing', 'error');
	                return;
	            }

	            if (this.isSelectedProductionHourLocked()) {
	                const hour = this.lineDetail.hourly_data?.[this.inputForm.hourIndex];
	                const message = (this.isProductionBreakHour(hour) || this.isOperatorProductionBreakTime())
                        ? 'Jam istirahat. Input produksi dibuka kembali pukul 13:00'
	                    : this.isProductionHourTooEarly(hour)
	                        ? 'Jam produksi ini belum dimulai. Silakan input saat jamnya sudah sesuai'
	                        : 'Data produksi jam ini sudah disimpan dan tidak bisa diubah';
	                this.showToast(message, 'error');
	                return;
	            }

            if (this.currentUser.role === 'operator' && this.isProductionOutputBlank()) {
                this.showToast('Output produksi wajib diisi sebelum menyimpan', 'error');
                return;
            }

	            this.isSavingProduction = true;
	            try {
	                const response = await fetch(`/api/update-production/${this.currentLine}/${this.currentModelId}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        hourIndex: this.inputForm.hourIndex,
                        output: this.inputForm.output,
                        targetManual: parseInt(this.inputForm.targetManual) || 0
                    })
                });

                if (response.ok) {
                    this.showToast('Data produksi berhasil disimpan', 'success');
                    await this.loadLineDetail(this.currentLine, this.currentModelId);
                    this.syncInputFormFromSelectedHour();
                    await this.loadDashboardData();
                } else {
                    const error = await response.json();
                    this.showToast(error.error || 'Failed to save data', 'error');
                }
	            } catch (error) {
	                logClientError('Error saving hourly data:', error);
	                this.showToast('Error saving data', 'error');
	            } finally {
	                this.isSavingProduction = false;
	            }
	        },

	        async submitQcCheck(result) {
	            if (this.isSavingQc) return;

            if (!this.isQcWithinWorkingHours()) {
                this.showToast('Input QC operator hanya dapat dilakukan pukul 07:00-17:00', 'error');
                return;
            }

	            if (!this.canManageQc()) {
	                this.showToast('Anda tidak memiliki akses untuk input QC', 'error');
	                return;
	            }

            if (result === 'defect' && (!this.defectEntry.type || !this.defectEntry.area)) {
                this.showToast('Pilih jenis defect dan area defect terlebih dahulu', 'error');
                return;
            }

	            this.selectCurrentQcHour();
	            this.isSavingQc = true;
	            try {
	                const response = await fetch(`/api/qc-check/${this.currentLine}/${this.currentModelId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
	                    body: JSON.stringify({
	                        result,
	                        hourIndex: this.qcHourIndex,
	                        type: this.defectEntry.type,
	                        area: this.defectEntry.area,
	                        notes: this.defectEntry.notes
	                    })
                });

                if (response.ok) {
                    this.showToast(result === 'defect' ? 'QC defect berhasil dicatat' : 'QC good berhasil dicatat', 'success');
                    if (result === 'defect') this.resetDefectEntry();
                    await this.loadLineDetail(this.currentLine, this.currentModelId);
                    await this.loadDashboardData();
                } else {
                    const error = await response.json();
                    this.showToast(error.error || 'Gagal menyimpan QC check', 'error');
                }
	            } catch (error) {
	                logClientError('Error saving QC check:', error);
	                this.showToast('Error saving QC check', 'error');
	            } finally {
	                this.isSavingQc = false;
	            }
	        },

	        async deleteQcCheck(checkId) {
	            if (!this.canDeleteQc() || !confirm('Hapus data QC ini?')) return;

	            try {
	                const response = await fetch(`/api/qc-check/${this.currentLine}/${this.currentModelId}/${checkId}`, { method: 'DELETE' });
	                if (!response.ok) {
	                    const error = await response.json();
	                    this.showToast(error.error || 'Gagal menghapus data QC', 'error');
	                    return;
	                }
	                this.showToast('Data QC berhasil dihapus', 'success');
	                await this.loadLineDetail(this.currentLine, this.currentModelId);
	                this.qcCurrentPage = Math.min(this.qcCurrentPage, this.totalQcPages);
	                await this.loadDashboardData();
	            } catch (error) {
	                logClientError('Error deleting QC check:', error);
	                this.showToast('Error menghapus data QC', 'error');
	            }
	        },

	        async editQcCheck(check) {
	            if (!this.canCorrectQc()) return;

	            const type = prompt('Jenis defect:', check.type || '');
	            if (type === null) return;
	            const area = prompt('Area defect:', check.area || '');
	            if (area === null) return;
	            const notes = prompt('Keterangan:', check.notes || '');
	            if (notes === null) return;

	            try {
	                const response = await fetch(`/api/qc-check/${this.currentLine}/${this.currentModelId}/${check.id}`, {
	                    method: 'PUT',
	                    headers: { 'Content-Type': 'application/json' },
	                    body: JSON.stringify({ type, area, notes })
	                });
	                if (!response.ok) {
	                    const error = await response.json();
	                    this.showToast(error.error || 'Gagal memperbarui defect', 'error');
	                    return;
	                }
	                this.showToast('Data defect berhasil diperbarui', 'success');
	                await this.loadLineDetail(this.currentLine, this.currentModelId);
	                await this.loadDashboardData();
	            } catch (error) {
	                logClientError('Error updating QC check:', error);
	                this.showToast('Error memperbarui defect', 'error');
	            }
	        },

        // Methods for target manual
        async updateTargetManual(lineName, modelId, hourIndex, targetManual) {
            if (!this.canManageProduction() && !this.canCorrectProduction()) {
                this.showToast('Anda tidak memiliki akses untuk input data', 'error');
                return;
            }

            try {
                const response = await fetch(`/api/update-target-manual/${lineName}/${modelId}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        hourIndex: hourIndex,
                        targetManual: targetManual
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    this.showToast('Target manual berhasil diupdate', 'success');
                    await this.loadLineDetail(lineName, modelId);
                    await this.loadDashboardData();
                } else {
                    const error = await response.json();
                    this.showToast(error.error || 'Failed to update target manual', 'error');
                }
            } catch (error) {
                logClientError('Error updating target manual:', error);
                this.showToast('Error updating target manual', 'error');
            }
        },

        // Update data langsung dari tabel
	        async updateHourlyDataDirect(lineName, modelId, hourIndex) {
	            if (this.isSavingProduction) return;

	            if (!this.canManageProduction() && !this.canCorrectProduction()) {
	                this.showToast('Anda tidak memiliki akses untuk input data', 'error');
	                return;
            }

	            const hour = this.lineDetail.hourly_data[hourIndex];

            if (this.currentUser.role === 'operator' && this.isProductionOutputBlank(hour.output)) {
                this.showToast('Output produksi wajib diisi sebelum menyimpan', 'error');
                return;
            }

	        if (this.isProductionHourLocked(hour)) {
	            const message = this.isProductionHourTooEarly(hour)
	                ? 'Jam produksi ini belum dimulai. Silakan input saat jamnya sudah sesuai'
	                : 'Data produksi jam ini sudah disimpan dan tidak bisa diubah';
	            this.showToast(message, 'error');
	            return;
	        }

	            this.isSavingProduction = true;
	            try {
	                const response = await fetch(`/api/update-production/${lineName}/${modelId}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        hourIndex: hourIndex,
                        output: hour.output,
                        targetManual: parseInt(hour.targetManual) || 0
                    })
                });

                if (response.ok) {
                    this.showToast('Data berhasil disimpan', 'success');
                    await this.loadLineDetail(lineName, modelId);
                    await this.loadDashboardData();
                } else {
                    const error = await response.json();
                    this.showToast(error.error || 'Failed to save data', 'error');
                }
	            } catch (error) {
	                logClientError('Error saving hourly data:', error);
	                this.showToast('Error saving data', 'error');
	            } finally {
	                this.isSavingProduction = false;
	            }
	        },

        // Admin management methods
        openLineModal(line = null) {
            if (line) {
                this.lineModal.isEdit = true;
                this.lineModal.data = {
                    lineName: line.lineName,
                    modelId: line.modelId,
                    labelWeek: line.data.labelWeek,
                    model: line.data.model,
                    target: line.data.target,
                    date: line.data.date
                };
            } else {
                this.lineModal.isEdit = false;
                this.lineModal.data = {
                    lineName: '',
                    modelId: '',
                    labelWeek: '',
                    model: '',
                    target: 180,
                    date: getJakartaDateInput()
                };
            }
            this.lineModal.open = true;
        },

        openModelModal() {
            this.modelModal.data = {
                lineName: '',
                labelWeek: '',
                model: '',
                target: 180,
                date: getJakartaDateInput()
            };
            this.modelModal.open = true;
        },

        async saveLine() {
            try {
                let url, method, bodyData;

                if (this.lineModal.isEdit) {
                    url = `/api/lines/${this.lineModal.data.lineName}`;
                    method = 'PUT';
                    bodyData = {
                        ...this.lineModal.data,
                        modelId: this.lineModal.data.modelId
                    };
                } else {
                    url = '/api/lines';
                    method = 'POST';
                    bodyData = this.lineModal.data;
                }

                const response = await fetch(url, {
                    method: method,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(bodyData)
                });

                if (response.ok) {
                    this.showToast(`Line ${this.lineModal.isEdit ? 'updated' : 'created'} successfully`, 'success');
                    this.lineModal.open = false;
                    await this.loadLines();
                    await this.loadDashboardData();
                } else {
                    const error = await response.json();
                    this.showToast(error.error || `Failed to ${this.lineModal.isEdit ? 'update' : 'create'} line`, 'error');
                }
            } catch (error) {
                logClientError('Error saving line:', error);
                this.showToast('Error saving line', 'error');
            }
        },

        async saveModel() {
            try {
                const response = await fetch(`/api/lines/${this.modelModal.data.lineName}/models`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(this.modelModal.data)
                });

                if (response.ok) {
                    this.showToast('Model added successfully', 'success');
                    this.modelModal.open = false;
                    await this.loadLines();
                    await this.loadDashboardData();
                } else {
                    const error = await response.json();
                    this.showToast(error.error || 'Failed to add model', 'error');
                }
            } catch (error) {
                logClientError('Error saving model:', error);
                this.showToast('Error saving model', 'error');
            }
        },

        async deleteModel(lineName, modelId) {
            if (!confirm(`Are you sure you want to delete model ${modelId} from line ${lineName}?`)) {
                return;
            }

            try {
                const response = await fetch(`/api/lines/${lineName}/models/${modelId}`, {
                    method: 'DELETE'
                });

                if (response.ok) {
                    this.showToast('Model deleted successfully', 'success');
                    await this.loadLines();
                    await this.loadDashboardData();
                } else {
                    const error = await response.json();
                    this.showToast(error.error || 'Failed to delete model', 'error');
                }
            } catch (error) {
                logClientError('Error deleting model:', error);
                this.showToast('Error deleting model', 'error');
            }
        },
        async setActiveModel(lineName, modelId) {
            try {
                const response = await fetch('/api/lines/' + encodeURIComponent(lineName) + '/active-model', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ modelId: modelId })
                });

                const result = await response.json();
                if (response.ok) {
                    this.showToast(result.message || 'Status model aktif diperbarui', 'success');
                    await this.loadLines();
                    await this.loadDashboardData();
                } else {
                    this.showToast(result.error || 'Failed to update active model', 'error');
                }
            } catch (error) {
                logClientError('Error updating active model:', error);
                this.showToast('Error updating active model', 'error');
            }
        },

        async deleteLine(lineName, modelCount = 1) {
            const confirmationMessage = modelCount > 1
                ? `Hapus line ${lineName} beserta seluruh ${modelCount} model di dalamnya? Tindakan ini tidak dapat dibatalkan.`
                : `Hapus line ${lineName}? Tindakan ini tidak dapat dibatalkan.`;

            if (!confirm(confirmationMessage)) {
                return;
            }

            try {
                const response = await fetch(`/api/lines/${lineName}`, {
                    method: 'DELETE'
                });

                if (response.ok) {
                    this.showToast(`Line ${lineName} berhasil dihapus`, 'success');
                    await this.loadLines();
                    await this.loadDashboardData();
                } else {
                    const error = await response.json();
                    this.showToast(error.error || 'Failed to delete line', 'error');
                }
            } catch (error) {
                logClientError('Error deleting line:', error);
                this.showToast('Error deleting line', 'error');
            }
        },

        openUserModal(user = null) {
            if (user) {
                this.userModal.isEdit = true;
                this.userModal.data = {
                    id: user.id,
                    username: user.username,
                    password: '',
                    name: user.name,
                    role: user.role,
                    line: user.line
                };
            } else {
                this.userModal.isEdit = false;
                this.userModal.data = {
                    id: null,
                    username: '',
                    password: '',
                    name: '',
                    role: 'operator',
                    line: ''
                };
            }
            this.userModal.open = true;
        },

        async saveUser() {
            try {
                const url = this.userModal.isEdit
                    ? `/api/users/${this.userModal.data.id}`
                    : '/api/users';

                const method = this.userModal.isEdit ? 'PUT' : 'POST';

                // Remove password if empty in edit mode
                const { id, ...data } = this.userModal.data;
                if (this.userModal.isEdit && !data.password) {
                    delete data.password;
                }

                const response = await fetch(url, {
                    method: method,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                });

                if (response.ok) {
                    this.showToast(`User ${this.userModal.isEdit ? 'updated' : 'created'} successfully`, 'success');
                    this.userModal.open = false;
                    await this.loadUsers();
                } else {
                    const error = await response.json();
                    this.showToast(error.error || `Failed to ${this.userModal.isEdit ? 'update' : 'create'} user`, 'error');
                }
            } catch (error) {
                logClientError('Error saving user:', error);
                this.showToast('Error saving user', 'error');
            }
        },

        async deleteUser(userId) {
            if (!confirm('Are you sure you want to delete this user?')) {
                return;
            }

            try {
                const response = await fetch(`/api/users/${userId}`, {
                    method: 'DELETE'
                });

                if (response.ok) {
                    this.showToast('User deleted successfully', 'success');
                    await this.loadUsers();
                } else {
                    const error = await response.json();
                    this.showToast(error.error || 'Failed to delete user', 'error');
                }
            } catch (error) {
                logClientError('Error deleting user:', error);
                this.showToast('Error deleting user', 'error');
            }
        },

        // Maintenance center
        async loadMaintenanceData() {
            if (this.currentUser.role !== 'admin') return;

            this.maintenanceLoading = true;
            try {
                await Promise.all([
                    this.loadSystemStatus(),
                    this.loadBackupHistory()
                ]);
            } finally {
                this.maintenanceLoading = false;
            }
        },

        async loadSystemStatus() {
            try {
                const response = await fetch('/api/system-status');
                if (!response.ok) throw new Error('Gagal memuat status sistem');
                this.maintenanceStatus = await response.json();
                return this.maintenanceStatus;
            } catch (error) {
                logClientError('Error loading system status:', error);
                this.maintenanceStatus = null;
                this.showToast(error.message, 'error');
                return null;
            }
        },

        async loadBackupHistory() {
            try {
                const response = await fetch('/api/backup-history');
                if (!response.ok) throw new Error('Gagal memuat riwayat backup');
                this.backupHistory = await response.json();
                this.backupCurrentPage = Math.min(this.backupCurrentPage, Math.max(1, this.totalBackupPages));
                return this.backupHistory;
            } catch (error) {
                logClientError('Error loading backup history:', error);
                this.backupHistory = [];
                this.showToast(error.message, 'error');
                return [];
            }
        },

        async createBackup() {
            if (this.maintenanceAction) return;
            this.maintenanceAction = 'backup';
            try {
                const response = await fetch('/api/backup/now', {
                    method: 'POST'
                });

                if (response.ok) {
                    const data = await response.json();
                    this.showToast(`Backup berhasil dibuat: ${data.filename || '-'}`, 'success');
                    await this.loadMaintenanceData();
                } else {
                    const error = await response.json();
                    this.showToast(error.error || 'Failed to create backup', 'error');
                }
            } catch (error) {
                logClientError('Error creating backup:', error);
                this.showToast('Error creating backup', 'error');
            } finally {
                this.maintenanceAction = '';
            }
        },

        async syncDates() {
            if (this.maintenanceAction) return;
            if (!confirm('Sinkronisasi akan mereset model bertanggal lama ke tanggal operasional hari ini. Backup data lama dibuat otomatis. Lanjutkan?')) return;

            this.maintenanceAction = 'sync';
            try {
                const response = await fetch('/api/sync-dates', {
                    method: 'POST'
                });

                if (response.ok) {
                    const data = await response.json();
                    this.showToast(data.message, data.resetCount > 0 ? 'success' : 'info');
                    await this.loadLines();
                    await this.loadDashboardData();
                    await this.loadMaintenanceData();
                } else {
                    const error = await response.json();
                    this.showToast(error.error || 'Failed to sync dates', 'error');
                }
            } catch (error) {
                logClientError('Error syncing dates:', error);
                this.showToast('Error syncing dates', 'error');
            } finally {
                this.maintenanceAction = '';
            }
        },

        async checkSystemStatus() {
            if (this.maintenanceAction) return;
            this.maintenanceAction = 'status';
            const status = await this.loadSystemStatus();
            this.maintenanceAction = '';
            if (!status) return;

            this.showToast(
                status.needsSync
                    ? `${status.otherDateModelCount} model masih menggunakan tanggal lama`
                    : 'Status sistem sehat dan seluruh model menggunakan tanggal hari ini',
                status.needsSync ? 'error' : 'success'
            );
        },

        openRestoreModal(backup) {
            this.restoreModal = {
                open: true,
                backup: backup,
                confirmation: ''
            };
        },

        closeRestoreModal() {
            if (this.maintenanceAction === 'restore') return;
            this.restoreModal = { open: false, backup: null, confirmation: '' };
        },

        async restoreBackup() {
            const backup = this.restoreModal.backup;
            if (!backup || this.restoreModal.confirmation !== 'RESTORE' || this.maintenanceAction) return;

            this.maintenanceAction = 'restore';
            try {
                const response = await fetch(`/api/restore-backup/${encodeURIComponent(backup.filename)}`, {
                    method: 'POST'
                });
                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || 'Gagal memulihkan backup');
                }

                this.restoreModal = { open: false, backup: null, confirmation: '' };
                this.showToast(
                    `Restore selesai. ${data.restoredModels} model ditambah, ${data.replacedModels} model diperbarui.`,
                    'success'
                );
                await this.loadLines();
                await this.loadDashboardData();
                await this.loadMaintenanceData();
            } catch (error) {
                logClientError('Error restoring backup:', error);
                this.showToast(error.message, 'error');
            } finally {
                this.maintenanceAction = '';
            }
        },

        backupTypeLabel(type) {
            return {
                daily: 'Snapshot harian',
                manual: 'Snapshot manual',
                archive: 'Snapshot arsip',
                pre_reset: 'Sebelum reset',
                pre_restore: 'Pengaman restore',
                database: 'Backup SQLite'
            }[type] || type || '-';
        },

        formatFileSize(bytes) {
            const size = Number(bytes) || 0;
            if (size < 1024) return `${size} B`;
            if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
            return `${(size / (1024 * 1024)).toFixed(1)} MB`;
        },
        // Utility methods
        formatDateTime(value) {
            if (!value) return '-';

            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return '-';

            return date.toLocaleString('id-ID', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        },

        formatShortDate(value) {
            if (!value) return '-';

            const date = new Date(`${value}T00:00:00`);
            if (Number.isNaN(date.getTime())) return value;

            return date.toLocaleDateString('id-ID', {
                day: '2-digit',
                month: 'short'
            });
        },

        formatDashboardDate(value) {
            if (!value) return 'Belum ada data';
            const date = new Date(`${value}T00:00:00`);
            if (Number.isNaN(date.getTime())) return value;
            return date.toLocaleDateString('id-ID', {
                day: '2-digit', month: 'short', year: 'numeric'
            });
        },

        formatDashboardNumber(value) {
            return (Number(value) || 0).toLocaleString('id-ID');
        },

        formatDashboardPercent(value) {
            return `${(Number(value) || 0).toLocaleString('id-ID', {
                minimumFractionDigits: 0,
                maximumFractionDigits: 2
            })}%`;
        },

        currentDateKey() {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        },

        resetDashboardChartPage() {
            this.dashboardChartCurrentPage = 1;
            this.$nextTick(() => {
                this.renderDashboardChart();
                this.startDashboardChartAutoplay();
            });
        },

        changeDashboardChartPage(page, restartAutoplay = false) {
            this.dashboardChartCurrentPage = Math.max(1, Math.min(page, this.dashboardChartTotalPages));
            this.$nextTick(() => this.renderDashboardChart());
            if (restartAutoplay) this.startDashboardChartAutoplay();
        },

        startDashboardChartAutoplay() {
            this.stopDashboardChartAutoplay();
            if (!this.dashboardChartAutoPlay || this.currentPage !== 'dashboard' || this.dashboardChartTotalPages <= 1) return;

            this.dashboardChartAutoPlayTimer = setInterval(() => {
                if (this.currentPage !== 'dashboard' || !this.dashboardChartAutoPlay || this.dashboardChartTotalPages <= 1) {
                    this.stopDashboardChartAutoplay();
                    return;
                }

                const nextPage = this.dashboardChartCurrentPage >= this.dashboardChartTotalPages
                    ? 1
                    : this.dashboardChartCurrentPage + 1;
                this.changeDashboardChartPage(nextPage);
            }, this.dashboardChartAutoPlayInterval);
        },

        stopDashboardChartAutoplay() {
            if (this.dashboardChartAutoPlayTimer) {
                clearInterval(this.dashboardChartAutoPlayTimer);
                this.dashboardChartAutoPlayTimer = null;
            }
        },

        toggleDashboardChartAutoplay() {
            this.dashboardChartAutoPlay = !this.dashboardChartAutoPlay;
            if (this.dashboardChartAutoPlay) {
                this.startDashboardChartAutoplay();
            } else {
                this.stopDashboardChartAutoplay();
            }
        },

        renderDashboardChart() {
            if (!this.$refs.dashboardChartCanvas || typeof Chart === 'undefined') return;

	            const labels = this.dashboardChartData.map(item => [
	                item.lineName || '-',
	                this.formatShortDate(item.date),
	                item.labelWeek || '-',
	                item.model || '-'
	            ]);
            const data = this.dashboardChartData;

            if (this.dashboardChart) {
                this.dashboardChart.destroy();
                this.dashboardChart = null;
            }

            if (!data.length) return;

            this.dashboardChart = new Chart(this.$refs.dashboardChartCanvas, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [
                        {
                            label: 'Target',
                            data: data.map(item => item.target || 0),
                            backgroundColor: 'rgba(0, 123, 255, 0.55)',
                            borderColor: '#007bff',
                            borderWidth: 1,
                            borderRadius: 4,
	                            maxBarThickness: 22
                        },
                        {
                            label: 'Output',
                            data: data.map(item => item.output || 0),
                            backgroundColor: 'rgba(40, 167, 69, 0.6)',
                            borderColor: '#28a745',
                            borderWidth: 1,
                            borderRadius: 4,
	                            maxBarThickness: 22
                        },
                        {
                            label: 'Defect',
                            data: data.map(item => item.defect || 0),
                            backgroundColor: 'rgba(220, 53, 69, 0.6)',
                            borderColor: '#dc3545',
                            borderWidth: 1,
                            borderRadius: 4,
	                            maxBarThickness: 22
                        }
                    ]
                },
	                options: {
	                    responsive: true,
	                    maintainAspectRatio: false,
	                    animation: false,
	                    events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'],
	                    interaction: { mode: 'index', axis: 'x', intersect: false },
	                    hover: { mode: 'index', axis: 'x', intersect: false },
	                    plugins: {
	                        legend: { position: 'top', labels: { boxWidth: 10, usePointStyle: true, font: { size: 10 } } },
	                        tooltip: {
	                            enabled: true,
	                            mode: 'index',
	                            axis: 'x',
	                            intersect: false,
	                            position: 'nearest',
	                            callbacks: {
	                                title: items => {
	                                    const item = data[items?.[0]?.dataIndex];
	                                    return item ? item.lineName : '';
	                                },
	                                afterTitle: items => {
	                                    const item = data[items?.[0]?.dataIndex];
	                                    if (!item) return '';
	                                    const dates = item.dates || (item.date ? [item.date] : []);
	                                    const details = [
	                                        item.labelWeek || '-',
	                                        item.model || '-'
	                                    ];
	                                    if (dates.length === 1) details.push(`Tanggal: ${this.formatShortDate(dates[0])}`);
	                                    if (dates.length > 1) details.push(`Tanggal: ${this.formatShortDate(dates[0])} - ${this.formatShortDate(dates[dates.length - 1])}`);
	                                    return details;
	                                }
	                            }
	                        }
                    },
                    scales: {
	                        x: {
	                            ticks: {
	                                autoSkip: false,
	                                maxRotation: 45,
	                                minRotation: 45,
	                                padding: 2,
	                                font: { size: 8, lineHeight: 1.1 }
	                            },
	                            grid: { display: false }
	                        },
	                        y: {
	                            beginAtZero: true,
	                            ticks: { font: { size: 9 } },
	                            title: { display: true, text: 'Qty', font: { size: 10 } },
	                            grid: { color: 'rgba(222, 226, 230, 0.7)' }
	                        }
	                    }
	                }
	            });
        },

        topDefectPercent(value, items = []) {
            const max = Math.max(...(items || []).map(item => parseInt(item.count) || 0), 1);
            return Math.max(6, Math.round(((parseInt(value) || 0) / max) * 100));
        },

        topCounterFromDaily(items = [], counterKey) {
            const counter = {};

            (items || []).forEach(item => {
                Object.entries(item[counterKey] || {}).forEach(([name, count]) => {
                    counter[name] = (counter[name] || 0) + (parseInt(count) || 0);
                });
            });

            return Object.entries(counter)
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
                .slice(0, 5);
        },

        formatDashboardCounter(counter = {}) {
            const items = Object.entries(counter || {})
                .filter(([name, count]) => name && (parseInt(count) || 0) > 0)
                .sort((a, b) => (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0) || a[0].localeCompare(b[0]));

            return items.length
                ? items.map(([name, count]) => `${name} (${parseInt(count) || 0})`).join(', ')
                : '-';
        },

        showToast(message, type = 'info') {
            this.toast = {
                show: true,
                type: type,
                message: message
            };

            setTimeout(() => {
                this.toast.show = false;
            }, 5000);
        },

        // Pagination Computed Properties

	        get filteredBackupHistory() {
	            const search = this.backupSearchTerm.trim().toLowerCase();
	            return (this.backupHistory || []).filter(backup => {
	                const matchesSearch = !search || [backup.filename, backup.date, this.backupTypeLabel(backup.type)]
	                    .some(value => String(value || '').toLowerCase().includes(search));
	                return matchesSearch && (!this.backupTypeFilter || backup.type === this.backupTypeFilter);
	            });
	        },

	        get paginatedBackupHistory() {
	            const perPage = Number(this.backupsPerPage);
	            const start = (this.backupCurrentPage - 1) * perPage;
	            return this.filteredBackupHistory.slice(start, start + perPage);
	        },

	        get totalBackupPages() {
	            return Math.ceil(this.filteredBackupHistory.length / Number(this.backupsPerPage));
	        },

	        get backupPages() {
	            return this.paginationPages(this.backupCurrentPage, this.totalBackupPages);
	        },

        get activeDefectTypes() {
            return (this.defectTypes || []).filter(type => type.active !== false);
        },

        get activeDefectAreas() {
            return (this.defectAreas || []).filter(area => area.active !== false);
        },

	        get filteredDefectTypes() {
	            const search = this.defectTypeSearchTerm.trim().toLowerCase();
	            const severity = this.defectTypeSeverityFilter;
	            return (this.defectTypes || []).filter(type => {
	                const typeSeverity = type.severity || 'minor';
	                const matchesSearch = !search ||
	                    [type.name, typeSeverity, type.active !== false ? 'aktif' : 'nonaktif']
	                        .some(value => String(value || '').toLowerCase().includes(search));
	                return matchesSearch && (!severity || typeSeverity === severity);
	            });
	        },

	        get paginatedDefectTypes() {
	            const perPage = Number(this.defectTypeItemsPerPage);
	            const start = (this.defectTypeCurrentPage - 1) * perPage;
	            return this.filteredDefectTypes.slice(start, start + perPage);
	        },

	        get totalDefectTypePages() {
	            return Math.ceil(this.filteredDefectTypes.length / Number(this.defectTypeItemsPerPage));
	        },

	        get defectTypePages() {
	            return this.paginationPages(this.defectTypeCurrentPage, this.totalDefectTypePages);
	        },

	        get filteredDefectAreas() {
	            const search = this.defectAreaSearchTerm.trim().toLowerCase();
	            return (this.defectAreas || []).filter(area => !search ||
	                [area.name, area.active !== false ? 'aktif' : 'nonaktif']
	                    .some(value => String(value || '').toLowerCase().includes(search))
	            );
	        },

	        get paginatedDefectAreas() {
	            const perPage = Number(this.defectAreaItemsPerPage);
	            const start = (this.defectAreaCurrentPage - 1) * perPage;
	            return this.filteredDefectAreas.slice(start, start + perPage);
	        },

	        get totalDefectAreaPages() {
	            return Math.ceil(this.filteredDefectAreas.length / Number(this.defectAreaItemsPerPage));
	        },

	        get defectAreaPages() {
	            return this.paginationPages(this.defectAreaCurrentPage, this.totalDefectAreaPages);
	        },

	        paginationPages(currentPage, totalPages) {
	            const start = Math.max(1, Math.min(currentPage - 2, totalPages - 4));
	            const end = Math.min(totalPages, start + 4);
	            return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
	        },

        get defectCategoryModalTitle() {
            const action = this.defectCategoryModal.id ? 'Edit' : 'Tambah';
            const label = this.defectCategoryModal.kind === 'type' ? 'Jenis Defect' : 'Area Defect';
            return `${action} ${label}`;
        },

        get inputDefectTotal() {
            return (this.inputForm.defectDetails || []).reduce((total, detail) => {
                return total + (parseInt(detail.quantity) || 0);
            }, 0);
        },

        get qcGoodCount() {
            return (this.lineDetail.qcChecks || []).filter(check => check.result === 'good').length;
        },

        get recentDefectChecks() {
            return (this.lineDetail.qcChecks || [])
                .filter(check => check.result === 'defect')
                .sort((a, b) => new Date(b.checkedAt || 0) - new Date(a.checkedAt || 0))
                .slice(0, 1);
        },

	        get allDefectChecks() {
	            return (this.lineDetail.qcChecks || [])
	                .filter(check => check.result === 'defect')
	                .sort((a, b) => new Date(b.checkedAt || 0) - new Date(a.checkedAt || 0));
	        },

	        get allQcChecks() {
	            return [...(this.lineDetail.qcChecks || [])]
	                .sort((a, b) => new Date(b.checkedAt || 0) - new Date(a.checkedAt || 0));
	        },

	        get filteredQcChecks() {
	            const search = this.qcSearchTerm.trim().toLowerCase();

	            return this.allQcChecks.filter(check => {
	                const matchesResult = !this.qcResultFilter || check.result === this.qcResultFilter;
	                const matchesSearch = !search || [check.hour, check.type, check.area, check.notes]
	                    .some(value => String(value || '').toLowerCase().includes(search));

	                return matchesResult && matchesSearch;
	            });
	        },

	        get paginatedQcChecks() {
	            const start = (this.qcCurrentPage - 1) * this.qcItemsPerPage;
	            return this.filteredQcChecks.slice(start, start + Number(this.qcItemsPerPage));
	        },

	        get totalQcPages() {
	            return Math.max(1, Math.ceil(this.filteredQcChecks.length / this.qcItemsPerPage));
	        },

	        get qcPages() {
	            const start = Math.max(1, Math.min(this.qcCurrentPage - 2, this.totalQcPages - 4));
	            const end = Math.min(this.totalQcPages, start + 4);
	            return Array.from({ length: end - start + 1 }, (_, index) => start + index);
	        },

        get selectedDashboardLineData() {
            const activeModelKeys = this.activeManagementModelKeys;
            return [...(this.dashboardData.lineDaily || [])]
                .filter(item => activeModelKeys.has(`${item.lineName}|${item.modelId}`))
                .sort((a, b) => new Date(a.date) - new Date(b.date) || a.lineName.localeCompare(b.lineName, undefined, { numeric: true }));
        },

	        get selectedDashboardSummary() {
	            const activeData = this.selectedDashboardLineData;
	            const latestDate = activeData[activeData.length - 1]?.date || '';
	            const activeRows = activeData.filter(item => item.date === latestDate);
	            if (!activeRows.length) return {
	                date: '',
	                lineCount: 0,
	                modelCount: 0,
	                target: 0,
	                output: 0,
                defect: 0,
	                criticalDefect: 0,
	                majorDefect: 0,
	                minorDefect: 0,
                qcChecked: 0,
                defectRate: 0
	            };

	            const summary = activeRows.reduce((result, item) => {
	                result.target += Number(item.target) || 0;
	                result.output += Number(item.output) || 0;
	                result.defect += Number(item.defect) || 0;
	                result.criticalDefect += Number(item.criticalDefect) || 0;
	                result.majorDefect += Number(item.majorDefect) || 0;
	                result.minorDefect += Number(item.minorDefect) || 0;
	                result.qcChecked += Number(item.qcChecked) || 0;
	                result.lineNames.add(item.lineName);
	                return result;
	            }, {
	                date: latestDate,
	                modelCount: activeRows.length,
	                target: 0,
	                output: 0,
	                defect: 0,
	                criticalDefect: 0,
	                majorDefect: 0,
	                minorDefect: 0,
	                qcChecked: 0,
	                lineNames: new Set()
	            });

	            summary.lineCount = summary.lineNames.size;
	            summary.defectRate = summary.qcChecked > 0
	                ? Number(((summary.defect / summary.qcChecked) * 100).toFixed(2))
	                : 0;
	            delete summary.lineNames;
	            return summary;
        },

	        get dashboardGoodCount() {
	            return Math.max((Number(this.selectedDashboardSummary.qcChecked) || 0)
	                - (Number(this.selectedDashboardSummary.defect) || 0), 0);
	        },

	        get dashboardAchievementPercent() {
	            const target = Number(this.selectedDashboardSummary.target) || 0;
	            const output = Number(this.selectedDashboardSummary.output) || 0;
	            return target > 0 ? Number(((output / target) * 100).toFixed(2)) : 0;
	        },

	        get dashboardAchievementStatus() {
	            const target = Number(this.selectedDashboardSummary.target) || 0;
	            if (target <= 0) return 'Target belum diisi';
	            if (this.dashboardAchievementPercent >= 100) return 'Target tercapai';
	            if (this.dashboardAchievementPercent >= 80) return 'Mendekati target';
	            return 'Perlu perhatian';
	        },

	        get dashboardAchievementTone() {
	            const target = Number(this.selectedDashboardSummary.target) || 0;
            if (target <= 0) return 'is-neutral';
            if (this.dashboardAchievementPercent >= 100) return 'is-success';
            if (this.dashboardAchievementPercent >= 80) return 'is-warning';
            return 'is-danger';
	        },

	        get dashboardOutputGapLabel() {
	            const gap = (Number(this.selectedDashboardSummary.output) || 0)
	                - (Number(this.selectedDashboardSummary.target) || 0);
            if (!(Number(this.selectedDashboardSummary.target) > 0)) return 'Belum ada target pembanding.';
            if (gap >= 0) return `Melebihi target ${this.formatDashboardNumber(gap)} unit.`;
            return `Kurang ${this.formatDashboardNumber(Math.abs(gap))} unit dari target.`;
	        },

	        get dashboardQualityStatus() {
	            const qcChecked = Number(this.selectedDashboardSummary.qcChecked) || 0;
            const defectRate = Number(this.selectedDashboardSummary.defectRate) || 0;
            if (qcChecked <= 0) return 'Belum diperiksa';
            if (defectRate > 5) return 'Perlu perhatian';
            return 'Dalam batas';
	        },

	        get dashboardQualityTone() {
	            const qcChecked = Number(this.selectedDashboardSummary.qcChecked) || 0;
            const defectRate = Number(this.selectedDashboardSummary.defectRate) || 0;
            if (qcChecked <= 0) return 'is-neutral';
            return defectRate > 5 ? 'is-danger' : 'is-success';
	        },

        get allDashboardChartData() {
            const groupedByLineDateModel = new Map();

            this.selectedDashboardLineData
                .forEach(item => {
                    const lineName = item.lineName || '-';
                    const date = item.date || '';
                    const modelId = item.modelId || item.model || '';
                    const key = `${date}|${lineName}|${modelId}`;
                    const current = groupedByLineDateModel.get(key) || {
                        lineName,
                        modelId: item.modelId || '',
                        labelWeek: item.labelWeek || '',
                        model: item.model || '',
                        date,
                        target: 0,
                        output: 0,
                        defect: 0
                    };

                    current.target += parseInt(item.target) || 0;
                    current.output += parseInt(item.output) || 0;
                    current.defect += parseInt(item.defect) || 0;
                    groupedByLineDateModel.set(key, current);
                });

            return Array.from(groupedByLineDateModel.values())
                .sort((a, b) => new Date(a.date) - new Date(b.date)
                    || a.lineName.localeCompare(b.lineName, undefined, { numeric: true })
                    || a.model.localeCompare(b.model));
        },

        get dashboardChartAvailableLines() {
            return [...new Set(this.allDashboardChartData.map(item => item.lineName))]
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        },

        get filteredDashboardChartData() {
            let data = this.allDashboardChartData;
            if (this.dashboardChartDateRange !== 'all') {
                const dates = data.map(item => item.date).filter(Boolean).sort();
                const latest = dates[dates.length - 1];
                if (latest) {
                    const cutoff = new Date(`${latest}T00:00:00`);
                    cutoff.setDate(cutoff.getDate() - Number(this.dashboardChartDateRange) + 1);
                    data = data.filter(item => new Date(`${item.date}T00:00:00`) >= cutoff);
                }
            }
            return this.dashboardChartLine
                ? data.filter(item => item.lineName === this.dashboardChartLine)
                : data;
        },

        get dashboardChartFilteredLines() {
            return [...new Set(this.filteredDashboardChartData.map(item => item.lineName))]
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        },

        get dashboardChartTotalPages() {
            return Math.max(1, this.dashboardChartFilteredLines.length);
        },

        get dashboardChartData() {
            const visibleLine = this.dashboardChartFilteredLines[this.dashboardChartCurrentPage - 1];
            return visibleLine
                ? this.filteredDashboardChartData.filter(item => item.lineName === visibleLine)
                : [];
        },

	        async deleteProductionHour(lineName, modelId, hourIndex) {
	            if (!this.canCorrectProduction() || !confirm('Hapus hasil sewing pada jam ini?')) return;

	            try {
	                const response = await fetch(`/api/production/${lineName}/${modelId}/${hourIndex}`, { method: 'DELETE' });
	                if (!response.ok) {
	                    const error = await response.json();
	                    this.showToast(error.error || 'Gagal menghapus hasil sewing', 'error');
	                    return;
	                }
	                this.showToast('Hasil sewing berhasil dihapus', 'success');
	                await this.loadLineDetail(lineName, modelId);
	                await this.loadDashboardData();
	            } catch (error) {
	                logClientError('Error deleting sewing result:', error);
	                this.showToast('Error menghapus hasil sewing', 'error');
	            }
	        },

        get activeManagementModelKeys() {
            return new Set((this.linesWithModels || [])
                .filter(line => (line.data.lineActiveModels || []).includes(line.modelId))
                .map(line => `${line.lineName}|${line.modelId}`));
        },

        isManagementModelActive(lineName, modelId) {
            return this.activeManagementModelKeys.has(`${lineName}|${modelId}`);
        },

        get dashboardDailyDetails() {
            return this.selectedDashboardLineData
	                .filter(item => item.date === this.currentDateKey())
                .sort((a, b) => a.lineName.localeCompare(b.lineName, undefined, { numeric: true })
                    || (a.modelId || '').localeCompare(b.modelId || '', undefined, { numeric: true }));
        },

        get selectedDashboardTopDefectAreas() {
            return this.topCounterFromDaily(this.selectedDashboardLineData, 'areaCounts');
        },

        get selectedDashboardTopDefectTypes() {
            return this.topCounterFromDaily(this.selectedDashboardLineData, 'typeCounts');
        },

        // Dashboard pagination
        get filteredDashboardLines() {
            if (!this.linesWithModels) return [];

            return this.linesWithModels.filter(line => {
                const matchesActiveModel = this.isManagementModelActive(line.lineName, line.modelId);
                // Search filter
                const searchTerm = this.dashboardSearchTerm.toLowerCase();
                const matchesSearch = !searchTerm ||
                    line.lineName.toLowerCase().includes(searchTerm) ||
                    line.modelId.toLowerCase().includes(searchTerm) ||
                    line.data.labelWeek.toLowerCase().includes(searchTerm) ||
                    line.data.model.toLowerCase().includes(searchTerm);

                const matchesLine = !this.dashboardLineFilter || line.lineName === this.dashboardLineFilter;

                // Status filter
                let matchesStatus = true;
                if (this.dashboardStatusFilter) {
                    if (this.dashboardStatusFilter === 'on-target') {
                        matchesStatus = line.data.outputDay >= line.data.target;
                    } else if (this.dashboardStatusFilter === 'behind') {
                        matchesStatus = line.data.outputDay < line.data.target && line.data.outputDay > 0;
                    } else if (this.dashboardStatusFilter === 'no-data') {
                        matchesStatus = line.data.outputDay === 0;
                    }
                }

                return matchesActiveModel && matchesSearch && matchesLine && matchesStatus;
            });
        },

        get paginatedDashboardLines() {
            const startIndex = (this.dashboardCurrentPage - 1) * this.dashboardItemsPerPage;
            const endIndex = startIndex + this.dashboardItemsPerPage;
            return this.filteredDashboardLines.slice(startIndex, endIndex);
        },

        get totalDashboardPages() {
            return Math.ceil(this.filteredDashboardLines.length / this.dashboardItemsPerPage);
        },

        get dashboardPages() {
            const pages = [];
            const totalPages = this.totalDashboardPages;
            const currentPage = this.dashboardCurrentPage;

            // Show up to 5 pages around current page
            let startPage = Math.max(1, currentPage - 2);
            let endPage = Math.min(totalPages, currentPage + 2);

            // Adjust if we're at the beginning
            if (currentPage <= 3) {
                endPage = Math.min(5, totalPages);
            }

            // Adjust if we're at the end
            if (currentPage >= totalPages - 2) {
                startPage = Math.max(1, totalPages - 4);
            }

            for (let i = startPage; i <= endPage; i++) {
                pages.push(i);
            }

            return pages;
        },

        // Lines pagination
        get availableManagementLines() {
            return [...new Set((this.linesWithModels || [])
                .map(line => line.lineName)
                .filter(Boolean))]
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        },

        get availableDashboardLines() {
            return [...new Set((this.linesWithModels || [])
                .filter(line => this.isManagementModelActive(line.lineName, line.modelId))
                .map(line => line.lineName)
                .filter(Boolean))]
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        },

        get filteredLines() {
            if (!this.linesWithModels) return [];

            return this.linesWithModels.filter(line => {
                // Search filter
                const searchTerm = this.lineSearchTerm.toLowerCase();
                const matchesSearch = !searchTerm ||
                    line.lineName.toLowerCase().includes(searchTerm) ||
                    line.modelId.toLowerCase().includes(searchTerm) ||
                    line.data.labelWeek.toLowerCase().includes(searchTerm) ||
                    line.data.model.toLowerCase().includes(searchTerm);

                const matchesLine = !this.lineNameFilter || line.lineName === this.lineNameFilter;

                // Status filter
                let matchesStatus = true;
                if (this.lineStatusFilter) {
                    if (this.lineStatusFilter === 'on-target') {
                        matchesStatus = line.data.outputDay >= line.data.target;
                    } else if (this.lineStatusFilter === 'behind') {
                        matchesStatus = line.data.outputDay < line.data.target && line.data.outputDay > 0;
                    } else if (this.lineStatusFilter === 'no-data') {
                        matchesStatus = line.data.outputDay === 0;
                    }
                }

                return matchesSearch && matchesLine && matchesStatus;
            });
        },

        get paginatedLines() {
            const startIndex = (this.currentLinePage - 1) * this.linesPerPage;
            const endIndex = startIndex + this.linesPerPage;
            return this.filteredLines.slice(startIndex, endIndex);
        },

        get totalLinePages() {
            return Math.ceil(this.filteredLines.length / this.linesPerPage);
        },

        get linePages() {
            const pages = [];
            const totalPages = this.totalLinePages;
            const currentPage = this.currentLinePage;

            // Show up to 5 pages around current page
            let startPage = Math.max(1, currentPage - 2);
            let endPage = Math.min(totalPages, currentPage + 2);

            // Adjust if we're at the beginning
            if (currentPage <= 3) {
                endPage = Math.min(5, totalPages);
            }

            // Adjust if we're at the end
            if (currentPage >= totalPages - 2) {
                startPage = Math.max(1, totalPages - 4);
            }

            for (let i = startPage; i <= endPage; i++) {
                pages.push(i);
            }

            return pages;
        },

        // Users pagination
        get filteredUsers() {
            if (!this.users) return [];

            const searchTerm = this.userSearchTerm.toLowerCase();
            return this.users.filter(user =>
                !searchTerm ||
                user.username.toLowerCase().includes(searchTerm) ||
                user.name.toLowerCase().includes(searchTerm) ||
                user.role.toLowerCase().includes(searchTerm) ||
                (user.line && user.line.toLowerCase().includes(searchTerm))
            );
        },

        get paginatedUsers() {
            const startIndex = (this.currentUserPage - 1) * this.usersPerPage;
            const endIndex = startIndex + this.usersPerPage;
            return this.filteredUsers.slice(startIndex, endIndex);
        },

        get totalUserPages() {
            return Math.ceil(this.filteredUsers.length / this.usersPerPage);
        },

        get userPages() {
            const pages = [];
            const totalPages = this.totalUserPages;
            const currentPage = this.currentUserPage;

            // Show up to 5 pages around current page
            let startPage = Math.max(1, currentPage - 2);
            let endPage = Math.min(totalPages, currentPage + 2);

            // Adjust if we're at the beginning
            if (currentPage <= 3) {
                endPage = Math.min(5, totalPages);
            }

            // Adjust if we're at the end
            if (currentPage >= totalPages - 2) {
                startPage = Math.max(1, totalPages - 4);
            }

            for (let i = startPage; i <= endPage; i++) {
                pages.push(i);
            }

            return pages;
        },

        // Date report pagination
        get paginatedDateReport() {
            const startIndex = (this.currentReportPage - 1) * this.reportPerPage;
            const endIndex = startIndex + this.reportPerPage;
            return this.dateReport.slice(startIndex, endIndex);
        },

        get totalReportPages() {
            return Math.ceil(this.dateReport.length / this.reportPerPage);
        },

        get reportPages() {
            const pages = [];
            const totalPages = this.totalReportPages;
            const currentPage = this.currentReportPage;

            // Show up to 5 pages around current page
            let startPage = Math.max(1, currentPage - 2);
            let endPage = Math.min(totalPages, currentPage + 2);

            // Adjust if we're at the beginning
            if (currentPage <= 3) {
                endPage = Math.min(5, totalPages);
            }

            // Adjust if we're at the end
            if (currentPage >= totalPages - 2) {
                startPage = Math.max(1, totalPages - 4);
            }

            for (let i = startPage; i <= endPage; i++) {
                pages.push(i);
            }

            return pages;
        }
    }
}
