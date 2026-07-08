const state = {
    currentUser: null,
    adminUsers: [],
    adminBalanceAdjustments: [],
    adminReferrals: [],
    adminUsersSearch: '',
    selectedAdminHistoryUserId: null,
    selectedAdminHistoryUserLabel: '',
    adminRefreshInterval: null,
    adminProviderSummaryRefreshInFlight: false,
    adminPendingPaymentsRefreshInFlight: false,
    adminNumberManagementLoaded: false,
    adminNumberManagementLoadInFlight: false,
    lastPendingCount: 0,
    lastAdminSecurityEventId: 0
};

const ORDER_PROVIDER_WAITING_STATUS = 'STATUS_WAIT_CODE';
const ADMIN_LIVE_REFRESH_INTERVAL_MS = 10000;

const adminAccordion = {
    panel: null,
    items: [],
    resizeBound: false
};

const PAYMENT_METHOD_META = {
    easypaisa: {
        key: 'easypaisa',
        label: 'Easypaisa'
    },
    binance: {
        key: 'binance',
        label: 'Binance'
    }
};

function qs(id) {
    return document.getElementById(id);
}

function qsa(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
    return escapeHtml(value);
}

function formatMoney(value) {
    return `${Number(value || 0).toFixed(0)} PKR`;
}

function formatMoneyPrecise(value) {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) return '0 PKR';
    return `${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2)} PKR`;
}

function formatUsdtAmount(value) {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) return '0 USDT';
    return `${Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2)} USDT`;
}

function formatRelativeTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString();
}

function formatStatus(status) {
    const normalized = String(status || '')
        .replace(/[_-]+/g, ' ')
        .toLowerCase();
    if (normalized === 'completed waiting user action') return 'OTP Ready';
    if (normalized === 'otp received' || normalized === 'active') return 'OTP Ready';
    if (normalized === 'pending') return 'Waiting for OTP';
    if (normalized === 'manual adjustment') return 'Manual Adjustment';
    return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function getStatusTone(status) {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'approved' || normalized === 'completed' || normalized === 'success' || normalized === 'safe') {
        return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200';
    }
    if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'rejected' || normalized === 'failed' || normalized === 'dangerous') {
        return 'bg-rose-50 text-rose-700 ring-1 ring-rose-200';
    }
    if (normalized === 'active' || normalized === 'pending' || normalized === 'otp_received') {
        return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200';
    }
    return 'bg-slate-100 text-slate-600 ring-1 ring-slate-200';
}

function renderStatusBadge(status) {
    return `<span class="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap ${getStatusTone(status)}">${escapeHtml(formatStatus(status))}</span>`;
}

function renderTypeBadge(type) {
    const normalized = String(type || 'deposit').toLowerCase();
    const tone = normalized === 'deduction'
        ? 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'
        : 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200';
    return `<span class="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap ${tone}">${escapeHtml(formatStatus(normalized))}</span>`;
}

async function fetchJSON(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        credentials: 'include'
    });
    if (!response.ok) {
        const error = new Error(await response.text());
        error.status = response.status;
        throw error;
    }
    return response.json();
}

function showToast(message, type = 'info', duration = 4000, options = {}) {
    const wrap = qs('toast-wrap');
    if (!wrap) return;
    const toneMap = {
        success: 'border-emerald-400/30 bg-emerald-500 text-white',
        error: 'border-rose-400/30 bg-rose-500 text-white',
        info: 'border-blue-400/30 bg-blue-500 text-white'
    };
    const { dismissLabel = '', onDismiss = null } = options || {};
    const toast = document.createElement('div');
    toast.className = `toast-card ${toneMap[type] || toneMap.info}`;
    let removed = false;
    let timeoutId = null;
    const dismissToast = () => {
        if (removed) return;
        removed = true;
        if (typeof onDismiss === 'function') {
            try {
                onDismiss();
            } catch {
            }
        }
        toast.classList.add('opacity-0', 'translate-y-2');
        window.setTimeout(() => toast.remove(), 220);
    };
    toast.innerHTML = `
        <div class="flex items-start gap-3">
            <div class="mt-0.5 text-sm"><i class="fa-solid ${type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-triangle-exclamation' : 'fa-circle-info'}"></i></div>
            <div class="flex-1 text-sm font-medium leading-6">${escapeHtml(message)}</div>
            ${dismissLabel ? `<button type="button" class="rounded-full border border-white/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/90" data-toast-dismiss>${escapeHtml(dismissLabel)}</button>` : ''}
        </div>
    `;
    wrap.appendChild(toast);
    if (dismissLabel) {
        toast.querySelector('[data-toast-dismiss]')?.addEventListener('click', () => {
            if (timeoutId) window.clearTimeout(timeoutId);
            dismissToast();
        });
    }
    timeoutId = window.setTimeout(dismissToast, duration);
    return toast;
}

async function requestBrowserNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
        try {
            await Notification.requestPermission();
        } catch {
        }
    }
}

function browserNotify(title, body) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
        try {
            new Notification(title, { body });
        } catch {
        }
    }
}

function renderAdminTable(headers, rowsMarkup, minWidthClass = 'min-w-[860px]') {
    return `
        <div class="${minWidthClass}">
            <table class="table-auto w-full text-left text-sm text-slate-700">
                <thead>
                    <tr>
                        ${headers.map((header, index) => `
                            <th class="bg-emerald-50 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600 ${index === 0 ? 'rounded-l-2xl' : ''} ${index === headers.length - 1 ? 'rounded-r-2xl' : ''}">${escapeHtml(header)}</th>
                        `).join('')}
                    </tr>
                </thead>
                <tbody>${rowsMarkup}</tbody>
            </table>
        </div>
    `;
}

function renderEmptyState(title, description) {
    return `
        <div class="rounded-[28px] border border-dashed border-emerald-200 bg-emerald-50/60 p-6 text-center text-slate-600">
            <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-100 bg-white text-emerald-600">
                <i class="fa-solid fa-inbox text-lg"></i>
            </div>
            <div class="text-lg font-semibold text-slate-900">${escapeHtml(title)}</div>
            <p class="mt-2 text-sm leading-6 text-slate-500">${escapeHtml(description)}</p>
        </div>
    `;
}

function setElementHtmlIfChanged(target, markup) {
    const element = typeof target === 'string' ? qs(target) : target;
    if (!element) return false;
    if (element.innerHTML === markup) return false;
    element.innerHTML = markup;
    return true;
}

function captureAdminScrollPositions() {
    const positions = new Map();
    qsa('#admin-panel .scroll-area').forEach((area) => {
        if (!area.id) return;
        positions.set(area.id, {
            top: area.scrollTop,
            left: area.scrollLeft
        });
    });
    return positions;
}

function restoreAdminScrollPositions(positions) {
    if (!(positions instanceof Map)) return;
    qsa('#admin-panel .scroll-area').forEach((area) => {
        if (!area.id || !positions.has(area.id)) return;
        const saved = positions.get(area.id);
        area.scrollTop = Number(saved?.top || 0);
        area.scrollLeft = Number(saved?.left || 0);
    });
}

function syncAdminAccordionLayout() {
    if (!adminAccordion.items.length) return;
    adminAccordion.items.forEach((item) => {
        const trigger = item.querySelector('[data-action="toggle-admin-accordion"]');
        const panel = item.querySelector('[data-admin-accordion-panel]');
        const inner = panel?.firstElementChild;
        const isOpen = item.classList.contains('is-open');
        if (trigger) {
            trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        }
        if (panel) {
            panel.style.maxHeight = isOpen && inner ? `${inner.scrollHeight}px` : '0px';
        }
    });
}

function isAdminNumberManagementAccordion(accordionId) {
    const normalizedId = String(accordionId || '').trim().toLowerCase();
    return normalizedId === 'number-management' || normalizedId === 'orders';
}

function isAdminNumberManagementOpen() {
    return adminAccordion.items.some((item) => isAdminNumberManagementAccordion(item.dataset.adminAccordionId) && item.classList.contains('is-open'));
}

function resetAdminNumberManagement() {
    const container = qs('admin-orders-list');
    state.adminNumberManagementLoaded = false;
    if (container) {
        container.innerHTML = renderEmptyState('Number Management not loaded', 'Open this section to load order records only when needed.');
    }
}

function setActiveAdminAccordion(accordionId) {
    if (!accordionId || !adminAccordion.items.length) return;
    adminAccordion.items.forEach((item) => {
        item.classList.toggle('is-open', item.dataset.adminAccordionId === accordionId);
    });
    syncAdminAccordionLayout();
    if (isAdminNumberManagementAccordion(accordionId)) {
        void loadAdminNumberManagement();
    } else {
        resetAdminNumberManagement();
    }
}

function initAdminAccordion() {
    const panel = qs('admin-panel');
    if (!panel) return;
    if (adminAccordion.panel !== panel || !adminAccordion.items.length) {
        adminAccordion.panel = panel;
        adminAccordion.items = Array.from(panel.querySelectorAll('[data-admin-accordion-item]'));
    }
    if (!adminAccordion.items.length) return;
    if (!adminAccordion.items.some((item) => item.classList.contains('is-open'))) {
        adminAccordion.items[0].classList.add('is-open');
    }
    syncAdminAccordionLayout();
    if (adminAccordion.resizeBound) return;
    window.addEventListener('resize', () => {
        window.requestAnimationFrame(syncAdminAccordionLayout);
    }, { passive: true });
    adminAccordion.resizeBound = true;
}

function setAdminSectionRefreshing(indicatorId, refreshing) {
    const indicator = qs(indicatorId);
    if (!indicator) return;
    indicator.classList.toggle('is-refreshing', Boolean(refreshing));
    indicator.setAttribute('aria-busy', refreshing ? 'true' : 'false');
}

function getOrderRawStatus(order) {
    return String(order?.status || order?.order_status || '').trim().toLowerCase();
}

function hasOrderOtp(order) {
    return Boolean(String(order?.otp_code || '').trim() || order?.otp_received);
}

function getOrderLifecycleStatus(order) {
    const rawStatus = getOrderRawStatus(order);
    const hasOtp = hasOrderOtp(order);
    if (rawStatus === 'expired_refunded' || rawStatus === 'refunded') return 'expired';
    if (['completed', 'expired', 'cancelled'].includes(rawStatus)) return rawStatus;
    if (rawStatus === 'completed_waiting_user_action') return 'active';
    if (rawStatus === 'otp_received') return 'active';
    if (rawStatus === 'retry_requested') return hasOtp ? 'active' : 'pending';
    if (rawStatus === 'active' && !hasOtp) return 'pending';
    if (rawStatus === 'pending' && hasOtp) return 'active';
    if (rawStatus === 'active') return 'active';
    if (hasOtp) return 'active';
    if (rawStatus === 'pending') return 'pending';
    return rawStatus || 'pending';
}

function isFinanciallySuccessfulAdminOrder(order) {
    return getOrderLifecycleStatus(order) === 'completed'
        || Boolean(order?.sms_received)
        || hasOrderOtp(order);
}

function getOrderApiCost(order) {
    if (!isFinanciallySuccessfulAdminOrder(order)) {
        return 0;
    }
    if (order?.real_provider_cost != null && Number.isFinite(Number(order.real_provider_cost))) {
        return Math.max(0, Number(order.real_provider_cost || 0));
    }
    if (order?.provider_cost_pkr != null && Number.isFinite(Number(order.provider_cost_pkr))) {
        return Math.max(0, Number(order.provider_cost_pkr || 0));
    }
    return 0;
}

function getOrderProfit(order) {
    if (!isFinanciallySuccessfulAdminOrder(order)) {
        return 0;
    }
    const websiteCharge = Number(order?.price ?? order?.website_charge ?? 0);
    const providerCost = getOrderApiCost(order);
    if (order?.profit_pkr != null && Number.isFinite(Number(order.profit_pkr))) {
        return Number(order.profit_pkr || 0);
    }
    return websiteCharge - providerCost;
}

function formatProviderBalanceValue(value, currency = 'USD') {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return `— ${currency}`;
    return `${amount.toFixed(3)} ${currency || 'USD'}`;
}

function getFinancialDateKey(value) {
    if (!value) return '';
    const raw = String(value || '').trim();
    const directMatch = raw.match(/^\d{4}-\d{2}-\d{2}/);
    if (directMatch) return directMatch[0];
    const candidate = new Date(value);
    if (Number.isNaN(candidate.getTime())) return '';
    const year = candidate.getFullYear();
    const month = String(candidate.getMonth() + 1).padStart(2, '0');
    const day = String(candidate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function calculateUserSpending(orders) {
    const result = {};
    let total = 0;
    (orders || []).forEach((order) => {
        if (getOrderLifecycleStatus(order) !== 'completed') return;
        const amount = Number(order.amount ?? order.price ?? 0);
        const userId = String(order.user_id ?? order.userId ?? 'Unknown');
        total += amount;
        if (!result[userId]) {
            result[userId] = 0;
        }
        result[userId] += amount;
    });
    return { total, perUser: result };
}

function getPaymentMethodMeta(method) {
    const normalizedMethod = String(method || 'easypaisa').trim().toLowerCase();
    return PAYMENT_METHOD_META[normalizedMethod] || PAYMENT_METHOD_META.easypaisa;
}

function getPaymentCreditAmount(request) {
    const creditAmount = Number(request?.credit_amount || 0);
    if (Number.isFinite(creditAmount) && creditAmount > 0) {
        return creditAmount;
    }
    return 0;
}

function formatPaymentRequestAmountText(request) {
    const methodMeta = getPaymentMethodMeta(request?.payment_method);
    if (methodMeta.key === 'binance') {
        const creditAmount = getPaymentCreditAmount(request);
        const creditText = creditAmount > 0 ? ` • Credit ${formatMoneyPrecise(creditAmount)}` : '';
        return `${formatUsdtAmount(request?.amount || 0)}${creditText}`;
    }
    return formatMoneyPrecise(request?.amount || 0);
}

function getPaymentRequestReferenceValue(request) {
    const methodMeta = getPaymentMethodMeta(request?.payment_method);
    if (request?.transaction_id) {
        return request.transaction_id;
    }
    return methodMeta.key === 'binance' ? 'Required for Binance approval' : 'Awaiting verification';
}

function getPaymentVerificationUrl(request) {
    const methodMeta = getPaymentMethodMeta(request?.payment_method);
    if (methodMeta.key !== 'easypaisa' || !request?.transaction_id) {
        return '';
    }
    return `https://easypaisa.com.pk/ticket-check/?ticketNo=${encodeURIComponent(request.transaction_id)}`;
}

function getUploadUrl(fileName) {
    return fileName ? `/uploads/${encodeURIComponent(fileName)}` : '';
}

function renderAdminTotalUsersSummary(users) {
    const container = qs('admin-total-users-summary');
    if (!container) return;
    const totalUsers = Array.isArray(users) ? users.length : 0;
    container.innerHTML = `
        <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Total Users</div>
            <div class="mt-2 text-3xl font-extrabold tracking-tight text-slate-900">${escapeHtml(String(totalUsers))}</div>
            <div class="mt-2 text-sm text-slate-500">Registered users currently available in the system.</div>
        </div>
    `;
}

function renderAdminDailyProfitDetails(entries, summary) {
    const container = qs('admin-daily-profit-details');
    if (!container) return;
    const todayKey = getFinancialDateKey(new Date());
    const totalProfitLabel = summary?.financialResetDate ? `Since ${summary.financialResetDate} Profit` : 'Since Reset Profit';
    const summaryMarkup = `
        <div class="grid gap-3 lg:grid-cols-4">
            <div class="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">Today Profit</div>
                <div class="mt-2 text-2xl font-extrabold text-emerald-700">${escapeHtml(formatMoneyPrecise(summary?.todayProfit || 0))}</div>
            </div>
            <div class="rounded-2xl border border-cyan-200 bg-cyan-50 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-700">Today Revenue</div>
                <div class="mt-2 text-2xl font-extrabold text-cyan-700">${escapeHtml(formatMoneyPrecise(summary?.todayRevenue || 0))}</div>
            </div>
            <div class="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">Today API Cost</div>
                <div class="mt-2 text-2xl font-extrabold text-amber-700">${escapeHtml(formatMoneyPrecise(summary?.todayApiCost || 0))}</div>
            </div>
            <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">${escapeHtml(totalProfitLabel)}</div>
                <div class="mt-2 text-2xl font-extrabold text-slate-900">${escapeHtml(formatMoneyPrecise(summary?.totalProfit || 0))}</div>
            </div>
        </div>
    `;
    if (!entries.length) {
        container.innerHTML = `${summaryMarkup}<div class="mt-4">${renderEmptyState('No daily earnings data available', 'Backend-verified revenue, provider cost, and profit totals will appear automatically.')}</div>`;
        return;
    }
    const rows = entries.map((entry) => {
        const isTodayRow = entry.date === todayKey;
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0 ${isTodayRow ? 'bg-emerald-50/70' : ''}">
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">
                    <div class="inline-flex items-center gap-2">
                        <span>${escapeHtml(entry.date)}</span>
                        ${isTodayRow ? '<span class="inline-flex rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700">Today</span>' : ''}
                    </div>
                </td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-cyan-700">${escapeHtml(formatMoneyPrecise(entry.revenue || 0))}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-amber-700">${escapeHtml(formatMoneyPrecise(entry.apiCost || 0))}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold ${(Number(entry.profitLoss || 0) >= 0) ? 'text-emerald-700' : 'text-rose-700'}">${escapeHtml(formatMoneyPrecise(entry.profitLoss || 0))}</td>
            </tr>
        `;
    }).join('');
    container.innerHTML = `${summaryMarkup}<div class="mt-4">${renderAdminTable(['Date', 'Revenue', 'API Cost', 'Profit'], rows, 'min-w-[820px]')}</div>`;
}

function renderAdminUserSpending(spending, users) {
    const container = qs('admin-user-spending-list');
    if (!container) return;
    const userLookup = new Map((users || []).map((user) => [String(user.id), user]));
    const spendingRows = Object.entries(spending?.perUser || {})
        .map(([userId, amount]) => {
            const user = userLookup.get(String(userId)) || {};
            return {
                userId,
                userName: user.name || `User #${userId}`,
                userEmail: user.email || 'Unknown email',
                amount: Number(amount || 0)
            };
        })
        .sort((left, right) => right.amount - left.amount);
    const topSpender = spendingRows[0];
    const summaryMarkup = `
        <div class="grid gap-3 lg:grid-cols-2">
            <div class="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">Total Spending</div>
                <div class="mt-2 text-2xl font-extrabold text-emerald-700">${escapeHtml(formatMoneyPrecise(spending?.total || 0))}</div>
            </div>
            <div class="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">Top Spender</div>
                <div class="mt-2 text-lg font-bold text-slate-900">${escapeHtml(topSpender ? topSpender.userName : '—')}</div>
                <div class="mt-1 text-sm text-slate-500">${escapeHtml(topSpender ? `${formatMoneyPrecise(topSpender.amount)} • ID ${topSpender.userId}` : 'No completed spending yet')}</div>
            </div>
        </div>
    `;
    if (!spendingRows.length) {
        container.innerHTML = `${summaryMarkup}<div class="mt-4">${renderEmptyState('No spending data available', 'Completed user orders will appear here once spending is recorded.')}</div>`;
        return;
    }
    const rows = spendingRows.map((entry, index) => `
        <tr class="border-b border-slate-200 align-top last:border-b-0 ${index === 0 ? 'bg-amber-50/70' : ''}">
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(entry.userId)}</td>
            <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(entry.userName)}</td>
            <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(entry.userEmail)}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold ${index === 0 ? 'text-amber-700' : 'text-emerald-700'}">${escapeHtml(formatMoneyPrecise(entry.amount))}</td>
        </tr>
    `).join('');
    container.innerHTML = `${summaryMarkup}<div class="mt-4">${renderAdminTable(['User ID', 'User', 'Email', 'Amount Spent'], rows, 'min-w-[860px]')}</div>`;
}

function renderAdminProviderSummary(summary) {
    const container = qs('admin-provider-summary');
    if (!container) return;
    const cards = [
        {
            title: 'User Wallet Balances',
            value: formatMoneyPrecise(summary?.totalUserBalances || 0),
            detail: `${Number(summary?.riskyUsers || 0)} suspicious users ready for review`,
            tone: 'border-slate-200 bg-slate-50 text-slate-700'
        },
        {
            title: 'Provider Balance',
            value: formatProviderBalanceValue(summary?.latestProviderBalance, summary?.latestProviderBalanceCurrency || 'USD'),
            detail: summary?.latestReconciliationAt ? `Last sync ${formatRelativeTime(summary.latestReconciliationAt)}` : 'Waiting for first reconciliation',
            tone: 'border-cyan-200 bg-cyan-50 text-cyan-700'
        },
        {
            title: 'Real Provider Cost',
            value: formatMoneyPrecise(summary?.totalRealProviderCost || 0),
            detail: `${Number(summary?.financiallyCompletedOrders || 0)} completed OTP orders`,
            tone: 'border-amber-200 bg-amber-50 text-amber-700'
        },
        {
            title: 'Today API Cost',
            value: formatMoneyPrecise(summary?.todayApiCost || 0),
            detail: 'Only billed completed OTP orders are counted',
            tone: 'border-cyan-200 bg-cyan-50 text-cyan-700'
        },
        {
            title: 'Real Profit',
            value: formatMoneyPrecise(summary?.totalRealProfitLoss || 0),
            detail: `Today ${formatMoneyPrecise(summary?.todayRealProfitLoss || 0)} • Revenue ${formatMoneyPrecise(summary?.totalRevenue || 0)}`,
            tone: Number(summary?.totalRealProfitLoss || 0) >= 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'
        },
        {
            title: 'Risk Overview',
            value: `${Number(summary?.riskOrders || 0)} / ${Number(summary?.criticalOrders || 0)}`,
            detail: `${Number(summary?.riskyUsers || 0)} risky users • ${Number(summary?.blockedUsers || 0)} manually blocked`,
            tone: summary?.latestAnomalyFlag ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-slate-200 bg-slate-50 text-slate-700'
        }
    ];
    const headerMarkup = `
        <div class="grid gap-3 xl:grid-cols-5">
            ${cards.map((card) => `
                <div class="rounded-2xl border p-4 ${card.tone}">
                    <div class="text-[11px] font-semibold uppercase tracking-[0.18em]">${escapeHtml(card.title)}</div>
                    <div class="mt-2 text-2xl font-extrabold tracking-tight">${escapeHtml(card.value)}</div>
                    <div class="mt-2 text-sm text-slate-500">${escapeHtml(card.detail)}</div>
                </div>
            `).join('')}
        </div>
    `;
    const reconciliationNote = `
        <div class="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            <div class="font-semibold text-slate-900">Latest reconciliation</div>
            <div class="mt-1">Reason: ${escapeHtml(summary?.latestReconciliationReason || '—')}</div>
            <div class="mt-1">Unmatched delta: <strong>${escapeHtml(formatMoneyPrecise(summary?.latestUnmatchedDeltaPkr || 0))}</strong></div>
            <div class="mt-1">Financial reset date: ${escapeHtml(summary?.financialResetDate || '—')}</div>
            <div class="mt-1">Revenue / API cost / profit: ${escapeHtml(formatMoneyPrecise(summary?.totalRevenue || 0))} / ${escapeHtml(formatMoneyPrecise(summary?.totalRealProviderCost || 0))} / ${escapeHtml(formatMoneyPrecise(summary?.totalRealProfitLoss || 0))}</div>
            <div class="mt-1 ${summary?.todayLossWarning ? 'font-semibold text-rose-700' : 'text-slate-600'}">${escapeHtml(summary?.todayLossWarning ? 'Warning: provider deductions are higher than expected today.' : 'No unusual provider deduction warning detected for today.')}</div>
        </div>
    `;
    setElementHtmlIfChanged(container, `${headerMarkup}${reconciliationNote}`);
}

function renderAdminProviderServiceBreakdown(entries) {
    const container = qs('admin-provider-service-breakdown');
    if (!container) return;
    if (!entries.length) {
        container.innerHTML = renderEmptyState('No provider service data yet', 'Service-wise provider cost and risk data will appear automatically after order activity.');
        return;
    }
    const rows = entries.map((entry) => `
        <tr class="border-b border-slate-200 align-top last:border-b-0">
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatStatus(entry.provider_service || 'unknown'))}</td>
            <td class="px-4 py-3 whitespace-nowrap text-slate-700">${escapeHtml(String(entry.total_orders || 0))}</td>
            <td class="px-4 py-3 whitespace-nowrap text-slate-700">${escapeHtml(String(entry.risk_orders || 0))}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatMoneyPrecise(entry.total_real_provider_cost || 0))}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold ${(Number(entry.total_real_profit_loss || 0) >= 0) ? 'text-emerald-700' : 'text-rose-700'}">${escapeHtml(formatMoneyPrecise(entry.total_real_profit_loss || 0))}</td>
        </tr>
    `).join('');
    container.innerHTML = renderAdminTable(['Service', 'Orders', 'Risk Orders', 'Real Provider Cost', 'Real Profit / Loss'], rows, 'min-w-[860px]');
}

function renderAdminProviderBalanceSnapshots(entries) {
    const container = qs('admin-provider-balance-list');
    if (!container) return;
    if (!entries.length) {
        container.innerHTML = renderEmptyState('No provider balance snapshots yet', 'Scheduled reconciliation and order actions will populate balance snapshots here.');
        return;
    }
    const rows = entries.map((entry) => `
        <tr class="border-b border-slate-200 align-top last:border-b-0 ${entry.anomaly_flag ? 'bg-rose-50/60' : ''}">
            <td class="px-4 py-3 whitespace-nowrap text-slate-700">${escapeHtml(formatRelativeTime(entry.created_at))}</td>
            <td class="px-4 py-3 whitespace-nowrap font-medium text-slate-900">${escapeHtml(formatStatus(entry.reason || 'snapshot'))}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatProviderBalanceValue(entry.provider_balance, entry.provider_balance_currency || 'USD'))}</td>
            <td class="px-4 py-3 whitespace-nowrap text-slate-600">${escapeHtml(formatMoneyPrecise(entry.delta_pkr || 0))}</td>
            <td class="px-4 py-3 whitespace-nowrap text-slate-600">${escapeHtml(formatMoneyPrecise(entry.expected_spend_pkr || 0))}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold ${(Number(entry.unmatched_delta_pkr || 0) === 0) ? 'text-slate-700' : 'text-rose-700'}">${escapeHtml(formatMoneyPrecise(entry.unmatched_delta_pkr || 0))}</td>
            <td class="px-4 py-3">${entry.anomaly_flag ? '<span class="inline-flex items-center rounded-full bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200">Flagged</span>' : '<span class="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">OK</span>'}</td>
        </tr>
    `).join('');
    container.innerHTML = renderAdminTable(['Time', 'Reason', 'Balance', 'Delta', 'Expected', 'Unmatched', 'Status'], rows, 'min-w-[1020px]');
}

function renderAdminProviderSecurityEvents(events) {
    const container = qs('admin-provider-security-list');
    if (!container) return;
    if (!events.length) {
        container.innerHTML = renderEmptyState('No provider security events yet', 'Risk, exploit, and reconciliation events will appear here when the backend flags them.');
        return;
    }
    const rows = events.map((event) => {
        const flags = [event.critical_exploit ? 'Critical' : '', event.loss_detected ? 'Loss' : '', event.risk_flag ? 'Risk' : ''].filter(Boolean).join(' • ') || 'Tracked';
        const refundStatus = Number(event.website_refund || 0) > 0 ? `Refunded ${formatMoneyPrecise(event.website_refund || 0)}` : 'No refund';
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0 ${(event.critical_exploit || event.loss_detected) ? 'bg-rose-50/60' : ''}">
                <td class="px-4 py-3 whitespace-nowrap text-slate-700">${escapeHtml(formatRelativeTime(event.created_at))}</td>
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(formatStatus(event.event_type || 'event'))}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-700">${escapeHtml(event.order_id == null ? '—' : `#${event.order_id}`)}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-700">${escapeHtml(formatStatus(event.service_type || 'unknown'))}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(event.phone_number || '—')}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(event.username || 'System')}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(event.reason || '—')}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-600">${escapeHtml(event.provider_final_status || event.provider_status || '—')}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatMoneyPrecise(event.real_provider_cost || 0))}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-600">${escapeHtml(refundStatus)}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold ${(event.critical_exploit || event.loss_detected) ? 'text-rose-700' : 'text-slate-700'}">${escapeHtml(flags)}</td>
            </tr>
        `;
    }).join('');
    container.innerHTML = renderAdminTable(['Time', 'Event', 'Order', 'Service', 'Number', 'User', 'Reason', 'Provider Status', 'Provider Deduction', 'Refund Status', 'Flags'], rows, 'min-w-[1480px]');
}

function renderAdminProviderRiskUsers(users) {
    const container = qs('admin-provider-risk-users');
    if (!container) return;
    if (!users.length) {
        container.innerHTML = renderEmptyState('No risky users flagged', 'Suspicious and blocked users will appear here once backend scoring detects abuse patterns.');
        return;
    }
    const rows = users.map((user) => `
        <tr class="border-b border-slate-200 align-top last:border-b-0 ${String(user.security_risk_status || '').toLowerCase() === 'dangerous' ? 'bg-rose-50/60' : ''}">
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(String(user.id || '—'))}</td>
            <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(user.name || 'Unknown user')}</td>
            <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(user.email || '—')}</td>
            <td class="px-4 py-3 whitespace-nowrap text-slate-700">${escapeHtml(String(Number(user.security_risk_score || 0)))}</td>
            <td class="px-4 py-3">${renderStatusBadge(user.security_risk_status || 'safe')}</td>
            <td class="px-4 py-3 whitespace-nowrap text-slate-600">${escapeHtml(String(Number(user.confirmed_provider_loss_count || 0)))}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold ${Number(user.total_provider_loss || 0) > 0 ? 'text-rose-700' : 'text-slate-700'}">${escapeHtml(formatMoneyPrecise(user.total_provider_loss || 0))}</td>
            <td class="px-4 py-3 whitespace-nowrap text-slate-600">${escapeHtml(user.security_blocked_until ? formatRelativeTime(user.security_blocked_until) : '—')}</td>
        </tr>
    `).join('');
    container.innerHTML = renderAdminTable(['User ID', 'Name', 'Email', 'Risk Score', 'Risk Status', 'Confirmed Losses', 'Provider Loss', 'Blocked Until'], rows, 'min-w-[1180px]');
}

function renderAdminProviderDailyEarnings(entries, summary) {
    const container = qs('admin-provider-daily-earnings');
    if (!container) return;
    const todayKey = getFinancialDateKey(new Date());
    const totalProfitLabel = summary?.financialResetDate ? `Since ${summary.financialResetDate} Profit` : 'Since Reset Profit';
    const headerMarkup = `
        <div class="grid gap-3 lg:grid-cols-4">
            <div class="rounded-2xl border border-cyan-200 bg-cyan-50 p-4"><div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-700">Today Revenue</div><div class="mt-2 text-2xl font-extrabold text-cyan-700">${escapeHtml(formatMoneyPrecise(summary?.todayRevenue || 0))}</div></div>
            <div class="rounded-2xl border border-amber-200 bg-amber-50 p-4"><div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">Today API Cost</div><div class="mt-2 text-2xl font-extrabold text-amber-700">${escapeHtml(formatMoneyPrecise(summary?.todayApiCost || 0))}</div></div>
            <div class="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">Today Profit</div><div class="mt-2 text-2xl font-extrabold text-emerald-700">${escapeHtml(formatMoneyPrecise(summary?.todayProfit || 0))}</div></div>
            <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4"><div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">${escapeHtml(totalProfitLabel)}</div><div class="mt-2 text-2xl font-extrabold text-slate-900">${escapeHtml(formatMoneyPrecise(summary?.totalProfit || 0))}</div></div>
        </div>
    `;
    if (!entries.length) {
        container.innerHTML = `${headerMarkup}<div class="mt-4">${renderEmptyState('No daily earnings rows yet', 'This table will refresh automatically from backend-verified provider deductions and completed-order revenue.')}</div>`;
        return;
    }
    const rows = entries.map((entry) => {
        const isTodayRow = entry.date === todayKey;
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0 ${isTodayRow ? 'bg-cyan-50/60' : ''}">
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900"><div class="inline-flex items-center gap-2"><span>${escapeHtml(entry.date || '—')}</span>${isTodayRow ? '<span class="inline-flex rounded-full bg-cyan-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-700">Today</span>' : ''}</div></td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-cyan-700">${escapeHtml(formatMoneyPrecise(entry.revenue || 0))}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-amber-700">${escapeHtml(formatMoneyPrecise(entry.apiCost || 0))}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold ${(Number(entry.profitLoss || 0) >= 0) ? 'text-emerald-700' : 'text-rose-700'}">${escapeHtml(formatMoneyPrecise(entry.profitLoss || 0))}</td>
            </tr>
        `;
    }).join('');
    container.innerHTML = `${headerMarkup}<div class="mt-4">${renderAdminTable(['Date', 'Revenue', 'API Cost', 'Profit'], rows, 'min-w-[820px]')}</div>`;
}

function renderAdminStats(stats) {
    const container = qs('admin-stats-list');
    if (!container) return;
    const totalScopeLabel = stats?.financialResetDate ? `Since ${stats.financialResetDate}` : 'Since Reset';
    const rows = `
        <tr class="border-b border-slate-200 align-top last:border-b-0">
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(totalScopeLabel)}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatMoneyPrecise(stats.totalDeposits))}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatMoneyPrecise(stats.totalRevenue ?? stats.totalIncome ?? 0))}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatMoneyPrecise(stats.totalApiCost))}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-emerald-700">${escapeHtml(formatMoneyPrecise(stats.totalProfit))}</td>
        </tr>
        <tr class="border-b border-slate-200 align-top last:border-b-0">
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-emerald-700">Today</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatMoneyPrecise(stats.todayDeposits))}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatMoneyPrecise(stats.todayRevenue ?? stats.todayIncome ?? 0))}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatMoneyPrecise(stats.todayApiCost))}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-emerald-700">${escapeHtml(formatMoneyPrecise(stats.todayProfit))}</td>
        </tr>
    `;
    container.innerHTML = renderAdminTable(['Scope', 'Deposits', 'Revenue', 'API Cost', 'Real Profit'], rows, 'min-w-[980px]');
}

function renderAdminBlockedUsers(users) {
    const container = qs('admin-blocked-users-list');
    if (!container) return;
    if (!users.length) {
        container.innerHTML = renderEmptyState('No blocked users', 'Users auto-blocked or manually blocked for confirmed provider loss will appear here.');
        return;
    }
    const rows = users.map((user) => `
        <tr class="border-b border-slate-200 align-top last:border-b-0 bg-rose-50/40">
            <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(user.name || 'Unknown user')}</td>
            <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(user.email || '—')}</td>
            <td class="px-4 py-3 whitespace-nowrap text-slate-700">${escapeHtml(String(Number(user.confirmed_provider_loss_count || 0)))}</td>
            <td class="px-4 py-3 whitespace-nowrap font-semibold text-rose-700">${escapeHtml(formatMoneyPrecise(user.total_provider_loss || 0))}</td>
            <td class="px-4 py-3 text-slate-600">${escapeHtml(user.security_block_reason || user.latest_security_reason || 'Confirmed provider loss threshold reached')}</td>
            <td class="px-4 py-3 whitespace-nowrap text-slate-600">${escapeHtml(user.security_blocked_until ? formatRelativeTime(user.security_blocked_until) : '—')}</td>
            <td class="px-4 py-3 whitespace-nowrap text-slate-600">${escapeHtml(user.latest_security_order_id == null ? '—' : `#${user.latest_security_order_id}`)}</td>
            <td class="px-4 py-3"><div class="flex flex-wrap gap-2"><button class="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50" data-action="view-user-history" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}"><i class="fa-solid fa-clock-rotate-left"></i><span>History</span></button><button class="inline-flex items-center gap-1 rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100" data-action="admin-user-unblock" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}"><i class="fa-solid fa-unlock"></i><span>Unblock</span></button><button class="inline-flex items-center gap-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 transition hover:bg-amber-100" data-action="admin-user-remove-risk" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}"><i class="fa-solid fa-shield-heart"></i><span>Remove Risk</span></button></div></td>
        </tr>
    `).join('');
    container.innerHTML = renderAdminTable(['Name', 'Email', 'Confirmed Losses', 'Provider Loss', 'Block Reason', 'Blocked Until', 'Latest Order', 'Actions'], rows, 'min-w-[1480px]');
}

function renderAdminOrders(orders) {
    const container = qs('admin-orders-list');
    if (!container) return;
    if (!orders.length) {
        container.innerHTML = renderEmptyState('No orders yet', 'Ordered numbers will appear here with pricing, API cost, and profit details.');
        return;
    }
    const rows = orders.map((order) => {
        const lifecycleStatus = getOrderLifecycleStatus(order);
        const providerCost = getOrderApiCost(order);
        const profit = getOrderProfit(order);
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0">
                <td class="px-4 py-3 break-all text-slate-700">${escapeHtml(order.user_email || 'Unknown email')}</td>
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(order.country || 'Unknown country')}</td>
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(formatStatus(order.service_type || 'Unknown service'))}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatMoneyPrecise(order.price))}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-600">${escapeHtml(formatMoneyPrecise(providerCost))}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold ${profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${escapeHtml(formatMoneyPrecise(profit))}</td>
                <td class="px-4 py-3">${renderStatusBadge(lifecycleStatus)}</td>
            </tr>
        `;
    }).join('');
    container.innerHTML = renderAdminTable(['User Email', 'Country', 'Service', 'Price', 'API Cost', 'Profit', 'Status'], rows, 'min-w-[1080px]');
}

async function loadAdminNumberManagement(options = {}) {
    const { force = false, silent = false } = options;
    const container = qs('admin-orders-list');
    if (!state.currentUser?.isAdmin || !container) return;
    if (state.adminNumberManagementLoadInFlight || (state.adminNumberManagementLoaded && !force)) return;
    state.adminNumberManagementLoadInFlight = true;
    container.innerHTML = renderEmptyState('Loading Number Management...', 'Orders are loaded only when this section is opened to keep the admin dashboard fast.');
    syncAdminAccordionLayout();
    try {
        const orders = await fetchJSON('/api/admin/orders');
        if (!isAdminNumberManagementOpen()) {
            state.adminNumberManagementLoaded = false;
            return;
        }
        renderAdminOrders(Array.isArray(orders) ? orders : []);
        state.adminNumberManagementLoaded = true;
    } catch (err) {
        container.innerHTML = renderEmptyState('Number Management unavailable', 'Order records could not be loaded right now.');
        if (!silent) {
            showToast(err.message || 'Failed to load Number Management', 'error');
        }
        handleAuthError(err);
    } finally {
        state.adminNumberManagementLoadInFlight = false;
        syncAdminAccordionLayout();
    }
}

function renderAdminPaymentRequests(paymentRequests, legacyTransactions) {
    const items = [
        ...paymentRequests.map((request) => ({ ...request, entry_kind: 'payment_request', source_label: 'Payment Request' })),
        ...legacyTransactions.map((transaction) => ({ ...transaction, entry_kind: 'legacy_transaction', source_label: 'Legacy Deposit' }))
    ];
    if (!items.length) {
        return renderEmptyState('No pending requests', 'New Easypaisa and Binance payment requests will appear here for verification and approval.');
    }
    const rows = items.map((item) => {
        const methodMeta = getPaymentMethodMeta(item.payment_method);
        const verificationUrl = getPaymentVerificationUrl(item);
        const proofButton = item.screenshot ? `<button class="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50" data-action="view-payment-proof" data-image="${escapeAttr(getUploadUrl(item.screenshot))}" data-user="${escapeAttr(item.user_name || 'Customer')}" data-email="${escapeAttr(item.user_email || 'Unknown email')}" data-amount="${escapeAttr(formatPaymentRequestAmountText(item))}" data-status="${escapeAttr(formatStatus(item.status || 'pending'))}"><i class="fa-regular fa-image"></i><span>Proof</span></button>` : '<span class="text-xs text-slate-500">No proof</span>';
        const actionButtons = item.entry_kind === 'payment_request'
            ? `<button class="inline-flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100" data-action="approve-payment-request" data-request-id="${escapeAttr(item.id)}"><i class="fa-solid fa-check"></i><span>Approve</span></button><button class="inline-flex items-center gap-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100" data-action="cancel-payment-request" data-request-id="${escapeAttr(item.id)}"><i class="fa-solid fa-xmark"></i><span>Reject</span></button>`
            : `<button class="inline-flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100" data-action="approve-transaction" data-tx-id="${escapeAttr(item.id)}"><i class="fa-solid fa-check"></i><span>Approve</span></button><button class="inline-flex items-center gap-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100" data-action="cancel-transaction" data-tx-id="${escapeAttr(item.id)}"><i class="fa-solid fa-xmark"></i><span>Cancel</span></button>`;
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0">
                <td class="px-4 py-3 font-medium text-slate-600">${escapeHtml(item.source_label)}</td>
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(methodMeta.label)}</td>
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(item.user_name || 'Customer')}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(item.user_email || 'Unknown email')}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatPaymentRequestAmountText(item))}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(getPaymentRequestReferenceValue(item) || `#${item.id}`)}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-500">${escapeHtml(formatRelativeTime(item.created_at))}</td>
                <td class="px-4 py-3">${proofButton}</td>
                <td class="px-4 py-3"><div class="flex flex-wrap gap-2">${verificationUrl ? `<a class="inline-flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100" href="${escapeAttr(verificationUrl)}" target="_blank" rel="noreferrer" style="text-decoration:none;"><span>Verify TXID</span></a>` : ''}${actionButtons}</div></td>
            </tr>
        `;
    }).join('');
    return renderAdminTable(['Source', 'Method', 'Customer', 'User Email', 'Amount', 'Reference', 'Submitted', 'Proof', 'Actions'], rows, 'min-w-[1360px]');
}

function renderAdminPaymentHistory(paymentRequests) {
    if (!paymentRequests.length) {
        return renderEmptyState('No processed requests', 'Approved and cancelled payment requests will appear here once processed by admin.');
    }
    const rows = paymentRequests.map((request) => {
        const methodMeta = getPaymentMethodMeta(request.payment_method);
        const verificationUrl = getPaymentVerificationUrl(request);
        const proofButton = request.screenshot ? `<button class="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50" data-action="view-payment-proof" data-image="${escapeAttr(getUploadUrl(request.screenshot))}" data-user="${escapeAttr(request.user_name || 'Customer')}" data-email="${escapeAttr(request.user_email || 'Unknown email')}" data-amount="${escapeAttr(formatPaymentRequestAmountText(request))}" data-status="${escapeAttr(formatStatus(request.status || 'pending'))}"><i class="fa-regular fa-image"></i><span>View Proof</span></button>` : '<span class="text-xs text-slate-500">No proof</span>';
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0">
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(methodMeta.label)}</td>
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(request.user_name || 'Customer')}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(request.user_email || 'Unknown email')}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatPaymentRequestAmountText(request))}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(getPaymentRequestReferenceValue(request) || `#${request.id}`)}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-500">${escapeHtml(formatRelativeTime(request.created_at))}</td>
                <td class="px-4 py-3">${renderStatusBadge(request.status || 'pending')}</td>
                <td class="px-4 py-3"><div class="flex flex-wrap gap-2">${verificationUrl ? `<a class="inline-flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100" href="${escapeAttr(verificationUrl)}" target="_blank" rel="noreferrer" style="text-decoration:none;"><span>Verify TXID</span></a>` : ''}${proofButton}</div></td>
            </tr>
        `;
    }).join('');
    return renderAdminTable(['Method', 'Customer', 'User Email', 'Amount', 'Reference', 'Submitted', 'Status', 'Actions'], rows, 'min-w-[1280px]');
}

function renderFinancialLedger(transactions) {
    if (!transactions.length) {
        return renderEmptyState('No ledger entries', 'Approved deposits and order deductions will appear here for financial tracking.');
    }
    const rows = transactions.map((transaction) => {
        const isDeduction = String(transaction.type || 'deposit').toLowerCase() === 'deduction';
        const amountText = `${isDeduction ? '-' : '+'}${formatMoneyPrecise(transaction.amount)}`;
        const referenceText = transaction.transaction_id || `Ledger #${transaction.id}`;
        const detailsText = transaction.description || (isDeduction ? 'Wallet deduction for OTP order' : 'Wallet deposit approved');
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0">
                <td class="px-4 py-3">${renderTypeBadge(transaction.type || 'deposit')}</td>
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(transaction.user_email || transaction.user_name || 'Customer')}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold ${isDeduction ? 'text-rose-700' : 'text-emerald-700'}">${escapeHtml(amountText)}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(referenceText)}</td>
                <td class="px-4 py-3 text-slate-600">${escapeHtml(detailsText)}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-500">${escapeHtml(formatRelativeTime(transaction.created_at))}</td>
                <td class="px-4 py-3">${renderStatusBadge(transaction.status || 'approved')}</td>
                <td class="px-4 py-3">${transaction.transaction_id ? `<a class="inline-flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100" href="https://easypaisa.com.pk/ticket-check/?ticketNo=${escapeAttr(transaction.transaction_id)}" target="_blank" rel="noreferrer" style="text-decoration:none;"><span>Verify TXID</span></a>` : '<span class="text-xs text-slate-500">Internal Entry</span>'}</td>
            </tr>
        `;
    }).join('');
    return renderAdminTable(['Type', 'Customer', 'Amount', 'Reference', 'Details', 'Date', 'Status', 'Actions'], rows, 'min-w-[1240px]');
}

function getReferralStatusMeta(entry) {
    const normalizedStatus = String(entry?.status || 'pending').toLowerCase();
    if (normalizedStatus === 'rewarded') {
        return { statusKey: 'rewarded', label: 'Rewarded', details: `Bonus added: ${formatMoneyPrecise(entry?.reward_amount || 0)} • Deposit: ${formatMoneyPrecise(entry?.qualifying_deposit_amount || 0)}` };
    }
    if (normalizedStatus === 'blocked') {
        return { statusKey: 'blocked', label: 'Blocked', details: entry?.fraud_reason || 'Referral bonus not allowed (security protection)' };
    }
    return { statusKey: 'pending', label: 'Pending', details: Number(entry?.qualifying_deposit_amount || 0) >= 170 ? 'Waiting for reward review' : 'Waiting for friend deposit of 170 PKR+' };
}

function renderAdminReferralRecords(referrals) {
    if (!referrals.length) {
        return renderEmptyState('No referral activity yet', 'Referred signups, rewards, and blocked attempts will appear here.');
    }
    const rows = referrals.map((entry) => {
        const statusMeta = getReferralStatusMeta(entry);
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0">
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(entry.referrer_name || 'Unknown')}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(entry.referrer_email || '—')}</td>
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(entry.referred_name || 'Pending')}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(entry.referred_email || '—')}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-600">${escapeHtml(entry.referral_code || '—')}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(entry.qualifying_deposit_amount == null ? '—' : formatMoneyPrecise(entry.qualifying_deposit_amount))}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-emerald-700">${escapeHtml(Number(entry.reward_amount || 0) > 0 ? formatMoneyPrecise(entry.reward_amount) : '—')}</td>
                <td class="px-4 py-3">${renderStatusBadge(statusMeta.statusKey)}</td>
                <td class="px-4 py-3 text-slate-600">${escapeHtml(statusMeta.details)}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-500">${escapeHtml(formatRelativeTime(entry.created_at))}</td>
            </tr>
        `;
    }).join('');
    return renderAdminTable(['Referrer', 'Referrer Email', 'Referred User', 'Referred Email', 'Code', 'Deposit', 'Reward', 'Status', 'Details', 'Date'], rows, 'min-w-[1500px]');
}

function renderAdminUsers(users) {
    if (!users.length) {
        return renderEmptyState('No users found', 'Registered users will appear here for manual balance adjustments.');
    }
    const rows = users.map((user) => {
        const roleLabel = user.is_admin ? 'Admin' : (user.role || 'user');
        const riskStatus = user.security_risk_status || 'safe';
        const riskReason = user.latest_security_reason || '—';
        const providerLoss = Number(user.latest_provider_loss_amount || 0);
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0">
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(user.name || 'Unnamed')}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(user.email || 'Unknown email')}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatMoneyPrecise(user.balance))}</td>
                <td class="px-4 py-3">${renderStatusBadge(roleLabel)}</td>
                <td class="px-4 py-3">${renderStatusBadge(riskStatus)}</td>
                <td class="px-4 py-3 text-slate-600">${escapeHtml(riskReason)}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold ${providerLoss > 0 ? 'text-rose-700' : 'text-slate-700'}">${escapeHtml(formatMoneyPrecise(providerLoss))}</td>
                <td class="px-4 py-3"><div class="flex flex-wrap gap-2"><button class="inline-flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100" data-action="adjust-user-balance" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}"><i class="fa-solid fa-scale-balanced"></i><span>Adjust</span></button><button class="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50" data-action="view-user-history" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}"><i class="fa-solid fa-clock-rotate-left"></i><span>History</span></button><button class="inline-flex items-center gap-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100" data-action="admin-user-block" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}"><i class="fa-solid fa-user-lock"></i><span>Block</span></button><button class="inline-flex items-center gap-1 rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100" data-action="admin-user-unblock" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}"><i class="fa-solid fa-unlock"></i><span>Unblock</span></button><button class="inline-flex items-center gap-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 transition hover:bg-amber-100" data-action="admin-user-remove-risk" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}"><i class="fa-solid fa-shield-heart"></i><span>Remove Risk</span></button></div></td>
            </tr>
        `;
    }).join('');
    return renderAdminTable(['Name', 'Email', 'Balance', 'Role', 'Risk', 'Reason', 'Provider Loss', 'Actions'], rows, 'min-w-[1480px]');
}

function syncAdminUsersList() {
    const container = qs('admin-users-list');
    if (!container) return;
    const query = String(state.adminUsersSearch || '').trim().toLowerCase();
    const filteredUsers = !query ? state.adminUsers : state.adminUsers.filter((user) => String(user.email || '').toLowerCase().includes(query));
    container.innerHTML = filteredUsers.length ? renderAdminUsers(filteredUsers) : renderEmptyState('No matching user found', 'Try searching with the user Gmail or full email address.');
}

function renderAdminBalanceAdjustments(adjustments) {
    if (!adjustments.length) {
        return renderEmptyState('No adjustments yet', 'Manual positive or negative admin balance adjustments will appear here.');
    }
    const rows = adjustments.map((entry) => {
        const isNegative = Number(entry.amount || 0) < 0;
        const amountText = `${isNegative ? '-' : '+'}${formatMoneyPrecise(Math.abs(Number(entry.amount || 0)))}`;
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0">
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(entry.user_name || 'User')}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(entry.user_email || 'Unknown email')}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold ${isNegative ? 'text-rose-700' : 'text-emerald-700'}">${escapeHtml(amountText)}</td>
                <td class="px-4 py-3 text-slate-600">${escapeHtml(entry.reason || 'No reason')}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(entry.admin_email || entry.admin_name || 'System')}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-500">${escapeHtml(formatRelativeTime(entry.created_at))}</td>
            </tr>
        `;
    }).join('');
    return renderAdminTable(['User', 'User Email', 'Amount', 'Reason', 'Adjusted By', 'Date'], rows, 'min-w-[1240px]');
}

function renderAdminUserHistory(history, userLabel) {
    if (!history.length) {
        return renderEmptyState('No history records', `${userLabel || 'This user'} has no purchases, deposits, or manual adjustments yet.`);
    }
    const rows = history.map((entry) => {
        const normalizedAmount = entry.entry_type === 'order' ? -Math.abs(Number(entry.amount || 0)) : Number(entry.amount || 0);
        const isNegative = normalizedAmount < 0;
        const amountText = `${isNegative ? '-' : '+'}${formatMoneyPrecise(Math.abs(normalizedAmount))}`;
        const detailsMarkup = entry.entry_type === 'order'
            ? `<div class="font-medium text-slate-700">${escapeHtml(entry.details || '—')}</div><div class="mt-1 text-xs text-slate-500">Number: ${escapeHtml(entry.phone_number || '—')} • Service: ${escapeHtml(formatStatus(entry.service_type || 'unknown'))} • Country: ${escapeHtml(entry.country || '—')}</div><div class="mt-1 text-xs text-slate-500">Provider: ${escapeHtml(entry.provider_status || '—')} • OTP: ${escapeHtml(entry.otp_received ? 'Received' : 'No')}</div><div class="mt-1 text-xs text-slate-500">Refund: ${escapeHtml(formatMoneyPrecise(entry.refund_amount || 0))} • Provider deduction: ${escapeHtml(formatMoneyPrecise(entry.provider_deduction_amount || 0))} • Provider loss: ${escapeHtml(formatMoneyPrecise(entry.provider_loss_amount || 0))}</div>`
            : `<div class="text-slate-600">${escapeHtml(entry.details || '—')}</div>`;
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0">
                <td class="px-4 py-3">${renderStatusBadge(entry.entry_type || 'entry')}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold ${isNegative ? 'text-rose-700' : 'text-emerald-700'}">${escapeHtml(amountText)}</td>
                <td class="px-4 py-3">${detailsMarkup}</td>
                <td class="px-4 py-3">${renderStatusBadge(entry.status || 'approved')}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-500">${escapeHtml(formatRelativeTime(entry.created_at))}</td>
            </tr>
        `;
    }).join('');
    return renderAdminTable(['Type', 'Amount', 'Details', 'Status', 'Date'], rows, 'min-w-[1080px]');
}

async function loadAdminUserHistory(userId, userLabel = '', options = {}) {
    const container = qs('admin-user-history-list');
    if (!container) return;
    const preserveScroll = Boolean(options.preserveScroll);
    const previousScrollTop = container.scrollTop;
    const previousScrollLeft = container.scrollLeft;
    state.selectedAdminHistoryUserId = Number(userId);
    state.selectedAdminHistoryUserLabel = userLabel || `User #${userId}`;
    if (!preserveScroll) {
        container.innerHTML = renderEmptyState('Loading user history', 'Please wait while history is fetched...');
    }
    try {
        const history = await fetchJSON(`/api/admin/users/${Number(userId)}/history`);
        container.innerHTML = renderAdminUserHistory(Array.isArray(history) ? history : [], state.selectedAdminHistoryUserLabel);
        container.scrollTop = preserveScroll ? previousScrollTop : 0;
        container.scrollLeft = preserveScroll ? previousScrollLeft : 0;
    } catch (err) {
        container.innerHTML = renderEmptyState('History unavailable', err.message || 'Could not load user history right now.');
        container.scrollTop = preserveScroll ? previousScrollTop : 0;
        container.scrollLeft = preserveScroll ? previousScrollLeft : 0;
        handleAuthError(err);
    } finally {
        syncAdminAccordionLayout();
    }
}

function syncAdminPendingPaymentAlerts(totalPendingCount) {
    if (totalPendingCount > 0 && totalPendingCount > state.lastPendingCount) {
        showToast(`New payment request received. Pending approvals: ${totalPendingCount}`, 'success', 30000, { dismissLabel: 'Mute' });
        browserNotify('MRF SMS Admin Alert', `New payment request received. Pending approvals: ${totalPendingCount}`);
    }
    state.lastPendingCount = totalPendingCount;
}

async function refreshAdminProviderSummarySection(options = {}) {
    if (!state.currentUser?.isAdmin || state.adminProviderSummaryRefreshInFlight) return;
    if (!qs('admin-provider-summary')) return;
    state.adminProviderSummaryRefreshInFlight = true;
    setAdminSectionRefreshing('admin-provider-summary-refresh-icon', true);
    try {
        const providerAnalytics = await fetchJSON('/api/admin/provider-analytics');
        renderAdminProviderSummary(providerAnalytics?.summary || {});
        renderAdminStats(providerAnalytics?.financeSummary || {});
        renderAdminDailyProfitDetails(providerAnalytics?.dailyEarnings || [], providerAnalytics?.financeSummary || {});
        renderAdminProviderServiceBreakdown(providerAnalytics?.serviceBreakdown || []);
        renderAdminProviderBalanceSnapshots(providerAnalytics?.recentBalanceSnapshots || []);
        renderAdminProviderSecurityEvents(providerAnalytics?.recentSecurityEvents || []);
        renderAdminProviderRiskUsers(providerAnalytics?.topRiskUsers || []);
        renderAdminProviderDailyEarnings(providerAnalytics?.dailyEarnings || [], providerAnalytics?.financeSummary || {});
        renderAdminBlockedUsers(providerAnalytics?.blockedUsers || []);
    } catch (err) {
        if (!options.silent) {
            showToast(err.message || 'Failed to refresh provider summary', 'error');
        }
        handleAuthError(err);
    } finally {
        state.adminProviderSummaryRefreshInFlight = false;
        setAdminSectionRefreshing('admin-provider-summary-refresh-icon', false);
    }
}

async function refreshAdminPendingPaymentsSection(options = {}) {
    if (!state.currentUser?.isAdmin || state.adminPendingPaymentsRefreshInFlight) return;
    if (!qs('admin-payment-requests-list')) return;
    state.adminPendingPaymentsRefreshInFlight = true;
    setAdminSectionRefreshing('admin-payment-requests-refresh-icon', true);
    try {
        const [paymentRequests, pendingTransactions] = await Promise.all([
            fetchJSON('/api/admin/payment-requests'),
            fetchJSON('/api/admin/transactions')
        ]);
        const pendingPaymentRequests = paymentRequests.filter((request) => String(request.status || '').toLowerCase() === 'pending');
        setElementHtmlIfChanged('admin-payment-requests-list', renderAdminPaymentRequests(pendingPaymentRequests, pendingTransactions));
        syncAdminPendingPaymentAlerts(pendingPaymentRequests.length + pendingTransactions.length);
    } catch (err) {
        if (!options.silent) {
            showToast(err.message || 'Failed to refresh pending payments', 'error');
        }
        handleAuthError(err);
    } finally {
        state.adminPendingPaymentsRefreshInFlight = false;
        setAdminSectionRefreshing('admin-payment-requests-refresh-icon', false);
    }
}

function ensureLightAdminAutoRefresh() {
    if (!state.currentUser?.isAdmin || state.adminRefreshInterval) return;
    state.adminRefreshInterval = window.setInterval(() => {
        if (!state.currentUser?.isAdmin || document.hidden) return;
        void refreshAdminProviderSummarySection({ silent: true });
        void refreshAdminPendingPaymentsSection({ silent: true });
    }, ADMIN_LIVE_REFRESH_INTERVAL_MS);
}

async function loadAdminData() {
    if (!state.currentUser?.isAdmin) return;
    try {
        const adminScrollPositions = captureAdminScrollPositions();
        const [paymentRequests, ledgerTransactions, pendingTransactions, users, balanceAdjustments, referrals, providerAnalytics] = await Promise.all([
            fetchJSON('/api/admin/payment-requests'),
            fetchJSON('/api/admin/transactions/history'),
            fetchJSON('/api/admin/transactions'),
            fetchJSON('/api/admin/users'),
            fetchJSON('/api/admin/balance-adjustments'),
            fetchJSON('/api/admin/referrals'),
            fetchJSON('/api/admin/provider-analytics')
        ]);
        state.adminUsers = Array.isArray(users) ? users : [];
        state.adminBalanceAdjustments = Array.isArray(balanceAdjustments) ? balanceAdjustments : [];
        state.adminReferrals = Array.isArray(referrals) ? referrals : [];
        const pendingPaymentRequests = paymentRequests.filter((request) => String(request.status || '').toLowerCase() === 'pending');
        const processedPaymentRequests = paymentRequests.filter((request) => String(request.status || '').toLowerCase() !== 'pending');
        const totalPendingCount = pendingPaymentRequests.length + pendingTransactions.length;
        renderAdminStats(providerAnalytics?.financeSummary || {});
        renderAdminTotalUsersSummary(state.adminUsers);
        renderAdminDailyProfitDetails(providerAnalytics?.dailyEarnings || [], providerAnalytics?.financeSummary || {});
        renderAdminUserSpending(providerAnalytics?.userSpending || calculateUserSpending([]), state.adminUsers);
        renderAdminProviderSummary(providerAnalytics?.summary || {});
        renderAdminProviderServiceBreakdown(providerAnalytics?.serviceBreakdown || []);
        renderAdminProviderBalanceSnapshots(providerAnalytics?.recentBalanceSnapshots || []);
        renderAdminProviderSecurityEvents(providerAnalytics?.recentSecurityEvents || []);
        renderAdminProviderRiskUsers(providerAnalytics?.topRiskUsers || []);
        renderAdminProviderDailyEarnings(providerAnalytics?.dailyEarnings || [], providerAnalytics?.financeSummary || {});
        renderAdminBlockedUsers(providerAnalytics?.blockedUsers || []);
        const latestSecurityEvent = providerAnalytics?.recentSecurityEvents?.[0] || null;
        if (latestSecurityEvent?.id != null) {
            const latestSecurityEventId = Number(latestSecurityEvent.id || 0);
            if (state.lastAdminSecurityEventId > 0 && latestSecurityEventId > state.lastAdminSecurityEventId) {
                const orderText = latestSecurityEvent.order_id == null ? 'system event' : `order #${latestSecurityEvent.order_id}`;
                const alertBody = latestSecurityEvent.reason === 'otp_or_sms_refunded'
                    ? `OTP-after-refund detected on ${orderText}`
                    : latestSecurityEvent.event_type === 'provider_reconciliation_anomaly'
                        ? `Provider-loss mismatch detected: ${formatMoneyPrecise(latestSecurityEvent.real_provider_cost || 0)}`
                        : `${formatStatus(latestSecurityEvent.event_type || latestSecurityEvent.reason || 'provider_alert')} on ${orderText}`;
                showToast(alertBody, 'error', 12000);
                browserNotify('MRF SMS Admin Alert', alertBody);
            }
            state.lastAdminSecurityEventId = Math.max(state.lastAdminSecurityEventId || 0, latestSecurityEventId);
        }
        setElementHtmlIfChanged('admin-payment-requests-list', renderAdminPaymentRequests(pendingPaymentRequests, pendingTransactions));
        qs('admin-payment-history-list').innerHTML = renderAdminPaymentHistory(processedPaymentRequests);
        qs('admin-financial-ledger-list').innerHTML = renderFinancialLedger(ledgerTransactions);
        syncAdminUsersList();
        qs('admin-balance-adjustments-list').innerHTML = renderAdminBalanceAdjustments(state.adminBalanceAdjustments);
        qs('admin-referrals-list').innerHTML = renderAdminReferralRecords(state.adminReferrals);
        if (state.selectedAdminHistoryUserId) {
            await loadAdminUserHistory(state.selectedAdminHistoryUserId, state.selectedAdminHistoryUserLabel, { preserveScroll: true });
        } else if (qs('admin-user-history-list')) {
            qs('admin-user-history-list').innerHTML = renderEmptyState('Select a user', 'Click History beside a user to view purchases, deposits, and manual adjustments.');
        }
        restoreAdminScrollPositions(adminScrollPositions);
        syncAdminAccordionLayout();
        syncAdminPendingPaymentAlerts(totalPendingCount);
    } catch (err) {
        showToast(err.message || 'Failed to load admin dashboard', 'error');
        handleAuthError(err);
    }
}

async function promptAdminBalanceAdjustment(userId, userLabel = '') {
    const amountInput = window.prompt(`Enter adjustment amount for ${userLabel || `User #${userId}`}\nUse positive value to add, negative value to deduct.`, '-100');
    if (amountInput == null) return;
    const amount = Number(amountInput);
    if (!Number.isFinite(amount) || amount === 0) {
        showToast('Enter a valid non-zero amount', 'error');
        return;
    }
    const reason = window.prompt('Enter adjustment reason', 'Penalty for exploiting OTP bug');
    if (reason == null) return;
    const trimmedReason = String(reason || '').trim();
    if (!trimmedReason) {
        showToast('Reason is required', 'error');
        return;
    }
    try {
        const response = await fetch(`/api/admin/users/${Number(userId)}/adjust-balance`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ amount, reason: trimmedReason })
        });
        if (!response.ok) throw new Error(await response.text());
        showToast('Balance adjusted successfully', 'success');
        await loadAdminData();
    } catch (err) {
        showToast(err.message || 'Balance adjustment failed', 'error');
        handleAuthError(err);
    }
}

async function promptAdminUserSecurityAction(userId, action, userLabel = '') {
    const normalizedAction = String(action || '').trim().toLowerCase();
    const safeUserLabel = userLabel || `User #${userId}`;
    let hours = 24;
    if (normalizedAction === 'block') {
        const hoursInput = window.prompt(`Block ${safeUserLabel} for how many hours?`, '24');
        if (hoursInput == null) return;
        hours = Number(hoursInput);
        if (!Number.isFinite(hours) || hours <= 0) {
            showToast('Enter valid block hours', 'error');
            return;
        }
    }
    const defaultReason = normalizedAction === 'block'
        ? 'Manual admin block pending provider-loss review'
        : normalizedAction === 'unblock'
            ? 'Manual admin unblock after review'
            : 'Manual admin risk removal after review';
    const reasonInput = window.prompt(`Enter reason for ${normalizedAction.replace(/-/g, ' ')} on ${safeUserLabel}`, defaultReason);
    if (reasonInput == null) return;
    const reason = String(reasonInput || '').trim();
    if (!reason) {
        showToast('Reason is required', 'error');
        return;
    }
    try {
        const response = await fetch(`/api/admin/users/${Number(userId)}/security-action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ action: normalizedAction, reason, hours })
        });
        if (!response.ok) throw new Error(await response.text());
        showToast(`User ${normalizedAction.replace(/-/g, ' ')} updated`, 'success');
        await loadAdminData();
    } catch (err) {
        showToast(err.message || 'User security action failed', 'error');
        handleAuthError(err);
    }
}

async function handleTransactionAction(txId, action) {
    const actionLabel = action === 'approve' ? 'approve' : 'cancel';
    const confirmMessage = action === 'approve' ? 'Approve this transaction and add balance to the user?' : 'Cancel this transaction without adding funds?';
    if (!window.confirm(confirmMessage)) return;
    try {
        const response = await fetch(`/api/admin/transactions/${txId}/${actionLabel}`, {
            method: 'POST',
            credentials: 'include'
        });
        if (!response.ok) throw new Error(await response.text());
        showToast(action === 'approve' ? 'Payment approved successfully' : 'Payment cancelled successfully', 'success');
        await loadAdminData();
    } catch (err) {
        showToast(err.message || 'Transaction update failed', 'error');
        handleAuthError(err);
    }
}

async function handlePaymentRequestAction(requestId, action) {
    const endpointAction = action === 'approve' ? 'approve' : 'reject';
    const confirmMessage = action === 'approve' ? 'Approve this payment request and add balance to the user?' : 'Reject this payment request without adding funds?';
    if (!window.confirm(confirmMessage)) return;
    try {
        const response = await fetch(`/api/admin/payment-requests/${requestId}/${endpointAction}`, {
            method: 'POST',
            credentials: 'include'
        });
        if (!response.ok) throw new Error(await response.text());
        showToast(action === 'approve' ? 'Payment request approved successfully' : 'Payment request rejected successfully', 'success');
        await loadAdminData();
    } catch (err) {
        showToast(err.message || 'Payment request update failed', 'error');
        handleAuthError(err);
    }
}

function openModal(id) {
    const modal = qs(id);
    if (!modal) return;
    modal.classList.remove('hidden');
}

function closeModal(id) {
    const modal = qs(id);
    if (!modal) return;
    modal.classList.add('hidden');
}

function openScreenshotModal({ image, user, email, amount, status }) {
    const preview = qs('screenshot-preview');
    if (preview) {
        preview.src = image || '';
        preview.alt = `${user || 'Customer'} payment proof`;
    }
    if (qs('screenshot-user')) qs('screenshot-user').textContent = user || 'Customer';
    if (qs('screenshot-email')) qs('screenshot-email').textContent = email || 'Unknown email';
    if (qs('screenshot-amount')) qs('screenshot-amount').textContent = amount || '—';
    if (qs('screenshot-status')) qs('screenshot-status').textContent = status || '—';
    openModal('screenshot-modal');
}

async function logout() {
    try {
        await fetch('/api/logout', { credentials: 'include' });
    } finally {
        window.location.replace('/admin-login');
    }
}

function handleAuthError(err) {
    if (err?.status === 401 || err?.status === 403) {
        window.setTimeout(() => {
            window.location.replace('/admin-login');
        }, 600);
    }
}

function syncAdminSessionHeader(user) {
    if (qs('admin-session-name')) qs('admin-session-name').textContent = user?.name || 'Admin';
    if (qs('admin-session-email')) qs('admin-session-email').textContent = user?.email || 'Admin session';
}

async function verifyAdminSession() {
    try {
        const user = await fetchJSON('/api/me');
        if (!user?.isAdmin) {
            window.location.replace('/');
            return false;
        }
        state.currentUser = user;
        syncAdminSessionHeader(user);
        await requestBrowserNotificationPermission();
        return true;
    } catch (err) {
        window.location.replace('/admin-login');
        return false;
    }
}

function bindAdminEvents() {
    qs('admin-users-search')?.addEventListener('input', (event) => {
        state.adminUsersSearch = event.target.value || '';
        syncAdminUsersList();
    });
    qsa('[data-close-modal]').forEach((button) => {
        button.addEventListener('click', () => closeModal(button.dataset.closeModal));
    });
    document.addEventListener('click', async (event) => {
        const actionTarget = event.target.closest('[data-action]');
        if (!actionTarget) return;
        const { action } = actionTarget.dataset;
        if (action === 'toggle-admin-accordion') {
            initAdminAccordion();
            setActiveAdminAccordion(actionTarget.dataset.adminAccordionId);
            return;
        }
        if (action === 'refresh-admin-panel') {
            await loadAdminData();
            if (isAdminNumberManagementOpen()) {
                await loadAdminNumberManagement({ force: true });
            }
            return;
        }
        if (action === 'logout') {
            await logout();
            return;
        }
        if (action === 'view-payment-proof') {
            openScreenshotModal({
                image: actionTarget.dataset.image,
                user: actionTarget.dataset.user,
                email: actionTarget.dataset.email,
                amount: actionTarget.dataset.amount,
                status: actionTarget.dataset.status
            });
            return;
        }
        if (action === 'approve-payment-request') {
            await handlePaymentRequestAction(actionTarget.dataset.requestId, 'approve');
            return;
        }
        if (action === 'cancel-payment-request') {
            await handlePaymentRequestAction(actionTarget.dataset.requestId, 'cancel');
            return;
        }
        if (action === 'approve-transaction') {
            await handleTransactionAction(actionTarget.dataset.txId, 'approve');
            return;
        }
        if (action === 'cancel-transaction') {
            await handleTransactionAction(actionTarget.dataset.txId, 'cancel');
            return;
        }
        if (action === 'adjust-user-balance') {
            await promptAdminBalanceAdjustment(actionTarget.dataset.userId, actionTarget.dataset.userLabel || 'User');
            return;
        }
        if (action === 'view-user-history') {
            await loadAdminUserHistory(actionTarget.dataset.userId, actionTarget.dataset.userLabel || 'User');
            return;
        }
        if (action === 'admin-user-block') {
            await promptAdminUserSecurityAction(actionTarget.dataset.userId, 'block', actionTarget.dataset.userLabel || 'User');
            return;
        }
        if (action === 'admin-user-unblock') {
            await promptAdminUserSecurityAction(actionTarget.dataset.userId, 'unblock', actionTarget.dataset.userLabel || 'User');
            return;
        }
        if (action === 'admin-user-remove-risk') {
            await promptAdminUserSecurityAction(actionTarget.dataset.userId, 'remove-risk', actionTarget.dataset.userLabel || 'User');
        }
    });
}

async function initAdminApp() {
    bindAdminEvents();
    initAdminAccordion();
    const isAdmin = await verifyAdminSession();
    if (!isAdmin) return;
    await loadAdminData();
    ensureLightAdminAutoRefresh();
}

document.addEventListener('DOMContentLoaded', initAdminApp);
