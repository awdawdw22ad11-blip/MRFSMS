<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>MRF SMS | Admin Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700;800;900&family=Space+Grotesk:wght@700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="/admin.css">
</head>
<body class="admin-body">
    <div id="toast-wrap" class="toast-wrap" aria-live="polite" aria-atomic="true"></div>
    <div class="admin-shell">
        <header class="admin-topbar">
            <div class="admin-topbar-inner">
                <div class="admin-brand">
                    <span class="admin-brand-mark">MRF</span>
                    <div>
                        <div class="admin-brand-title">Admin Dashboard</div>
                        <div class="admin-brand-subtitle">Independent admin interface</div>
                    </div>
                </div>
                <div class="admin-session">
                    <div class="admin-session-card">
                        <strong id="admin-session-name">Loading...</strong>
                        <span id="admin-session-email">Checking admin session</span>
                    </div>
                    <button type="button" class="admin-action-button" data-action="refresh-admin-panel"><i class="fa-solid fa-rotate"></i><span>Refresh</span></button>
                    <button type="button" class="admin-action-button danger" data-action="logout"><i class="fa-solid fa-right-from-bracket"></i><span>Logout</span></button>
                </div>
            </div>
        </header>

        <main class="admin-main">
            <section id="admin-panel" class="admin-panel p-4 sm:p-5">
                <div class="admin-panel-header">
                    <div>
                        <p class="admin-panel-eyebrow">Admin panel</p>
                        <h1 class="admin-panel-title">Admin Dashboard</h1>
                        <p class="admin-panel-copy">Use admin-only sections to review finance, users, system activity, provider intelligence, and number management.</p>
                    </div>
                    <button type="button" class="admin-refresh-button" data-action="refresh-admin-panel">Refresh Data</button>
                </div>

                <div class="admin-section-group admin-accordion-item is-open" data-admin-accordion-item data-admin-accordion-id="overview">
                    <button type="button" class="admin-accordion-trigger" data-action="toggle-admin-accordion" data-admin-accordion-id="overview" aria-expanded="true" aria-controls="admin-accordion-panel-overview">
                        <span class="admin-accordion-copy">
                            <span class="admin-section-kicker">1. Financial Statistics</span>
                            <span class="admin-section-title">Financial Overview</span>
                            <span class="admin-section-copy">Review total deposits, income, API cost, profit, and daily breakdown.</span>
                        </span>
                        <span class="admin-accordion-indicator" aria-hidden="true"><i class="fa-solid fa-chevron-down"></i></span>
                    </button>
                    <div id="admin-accordion-panel-overview" class="admin-accordion-panel" data-admin-accordion-panel>
                        <div class="admin-accordion-panel-inner">
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Overall Financial Stats</h2>
                                    <p class="mt-1 text-sm text-slate-500">Overall and today deposits, income, API cost, and real profit.</p>
                                </div>
                                <div id="admin-stats-list" class="scroll-area overflow-x-auto"></div>
                            </div>
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Daily Profit Details</h2>
                                    <p class="mt-1 text-sm text-slate-500">Date-wise completed-order profit totals.</p>
                                </div>
                                <div id="admin-daily-profit-details" class="scroll-area overflow-x-auto"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="admin-section-group admin-accordion-item" data-admin-accordion-item data-admin-accordion-id="provider">
                    <button type="button" class="admin-accordion-trigger" data-action="toggle-admin-accordion" data-admin-accordion-id="provider" aria-expanded="false" aria-controls="admin-accordion-panel-provider">
                        <span class="admin-accordion-copy">
                            <span class="admin-section-kicker">2. Provider Intelligence</span>
                            <span class="admin-section-title">Provider Intelligence</span>
                            <span class="admin-section-copy">Track provider balance, real provider cost, risk events, and backend reconciliation.</span>
                        </span>
                        <span class="admin-accordion-indicator" aria-hidden="true"><i class="fa-solid fa-chevron-down"></i></span>
                    </button>
                    <div id="admin-accordion-panel-provider" class="admin-accordion-panel" data-admin-accordion-panel>
                        <div class="admin-accordion-panel-inner">
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Provider Summary<span id="admin-provider-summary-refresh-icon" class="admin-live-refresh-indicator" aria-label="Live refresh" aria-busy="false"><i class="fa-solid fa-rotate"></i></span></h2>
                                    <p class="mt-1 text-sm text-slate-500">Latest provider balance, real spend, real profit/loss, and mismatch status.</p>
                                </div>
                                <div id="admin-provider-summary" class="scroll-area overflow-x-auto"></div>
                            </div>
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Daily Earnings</h2>
                                    <p class="mt-1 text-sm text-slate-500">Backend-verified daily revenue, provider deductions, refunds, and profit.</p>
                                </div>
                                <div id="admin-provider-daily-earnings" class="scroll-area overflow-x-auto"></div>
                            </div>
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Provider Service Breakdown</h2>
                                    <p class="mt-1 text-sm text-slate-500">Service-wise provider cost, profit/loss, and risk counts.</p>
                                </div>
                                <div id="admin-provider-service-breakdown" class="scroll-area overflow-x-auto"></div>
                            </div>
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Provider Balance Snapshots</h2>
                                    <p class="mt-1 text-sm text-slate-500">Scheduled reconciliation and order action balance snapshots.</p>
                                </div>
                                <div id="admin-provider-balance-list" class="scroll-area overflow-x-auto"></div>
                            </div>
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Security Events &amp; Risk Users</h2>
                                    <p class="mt-1 text-sm text-slate-500">Provider anomalies, exploit signals, and risky users.</p>
                                </div>
                                <div id="admin-provider-security-list" class="scroll-area overflow-x-auto"></div>
                                <div class="mt-6 border-t border-slate-200 pt-6">
                                    <div class="mb-4">
                                        <h3 class="text-base font-semibold text-slate-900">Top Risk Users</h3>
                                        <p class="mt-1 text-sm text-slate-500">Users with elevated backend risk score or active security block.</p>
                                    </div>
                                    <div id="admin-provider-risk-users" class="scroll-area overflow-x-auto"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="admin-section-group admin-accordion-item" data-admin-accordion-item data-admin-accordion-id="payments">
                    <button type="button" class="admin-accordion-trigger" data-action="toggle-admin-accordion" data-admin-accordion-id="payments" aria-expanded="false" aria-controls="admin-accordion-panel-payments">
                        <span class="admin-accordion-copy">
                            <span class="admin-section-kicker">3. Payments</span>
                            <span class="admin-section-title">Payment Management</span>
                            <span class="admin-section-copy">Handle pending proofs, processed payment requests, and the finance ledger.</span>
                        </span>
                        <span class="admin-accordion-indicator" aria-hidden="true"><i class="fa-solid fa-chevron-down"></i></span>
                    </button>
                    <div id="admin-accordion-panel-payments" class="admin-accordion-panel" data-admin-accordion-panel>
                        <div class="admin-accordion-panel-inner">
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Pending Payment Requests<span id="admin-payment-requests-refresh-icon" class="admin-live-refresh-indicator" aria-label="Live refresh" aria-busy="false"><i class="fa-solid fa-rotate"></i></span></h2>
                                    <p class="mt-1 text-sm text-slate-500">Review screenshot proofs and approve or reject pending add-money requests.</p>
                                </div>
                                <div id="admin-payment-requests-list" class="scroll-area overflow-x-auto"></div>
                            </div>
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Processed Payment History</h2>
                                    <p class="mt-1 text-sm text-slate-500">Approved and cancelled payment requests with proof links and status.</p>
                                </div>
                                <div id="admin-payment-history-list" class="scroll-area overflow-x-auto"></div>
                            </div>
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Financial Ledger</h2>
                                    <p class="mt-1 text-sm text-slate-500">Approved deposits and order deductions for financial tracking.</p>
                                </div>
                                <div id="admin-financial-ledger-list" class="scroll-area overflow-x-auto"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="admin-section-group admin-accordion-item" data-admin-accordion-item data-admin-accordion-id="users">
                    <button type="button" class="admin-accordion-trigger" data-action="toggle-admin-accordion" data-admin-accordion-id="users" aria-expanded="false" aria-controls="admin-accordion-panel-users">
                        <span class="admin-accordion-copy">
                            <span class="admin-section-kicker">4. Users</span>
                            <span class="admin-section-title">User Management</span>
                            <span class="admin-section-copy">Check totals, user spending, balances, security actions, and selected-user history.</span>
                        </span>
                        <span class="admin-accordion-indicator" aria-hidden="true"><i class="fa-solid fa-chevron-down"></i></span>
                    </button>
                    <div id="admin-accordion-panel-users" class="admin-accordion-panel" data-admin-accordion-panel>
                        <div class="admin-accordion-panel-inner">
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Total Users</h2>
                                    <p class="mt-1 text-sm text-slate-500">Full number of registered users.</p>
                                </div>
                                <div id="admin-total-users-summary" class="scroll-area overflow-x-auto"></div>
                            </div>
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">User Spending</h2>
                                    <p class="mt-1 text-sm text-slate-500">Completed-order spending and user-wise breakdown.</p>
                                </div>
                                <div id="admin-user-spending-list" class="scroll-area overflow-x-auto"></div>
                            </div>
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">User Balances &amp; Manual Adjustment</h2>
                                    <p class="mt-1 text-sm text-slate-500">Adjust user balances and keep an audit trail.</p>
                                    <div class="admin-search-shell mt-3 rounded-2xl border px-4 py-3">
                                        <label for="admin-users-search" class="sr-only">Search users by email</label>
                                        <div class="flex items-center gap-3">
                                            <i class="fa-solid fa-magnifying-glass text-sm text-slate-400"></i>
                                            <input id="admin-users-search" type="search" inputmode="search" placeholder="Search by Gmail / email" class="admin-search-input w-full bg-transparent text-sm outline-none" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false">
                                        </div>
                                    </div>
                                </div>
                                <div id="admin-users-list" class="scroll-area overflow-x-auto"></div>
                            </div>
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Blocked Users</h2>
                                    <p class="mt-1 text-sm text-slate-500">Users with an active security block due to confirmed provider loss.</p>
                                </div>
                                <div id="admin-blocked-users-list" class="scroll-area overflow-x-auto"></div>
                            </div>
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Selected User Full History</h2>
                                    <p class="mt-1 text-sm text-slate-500">Purchases, deposits, and manual adjustments for the selected user.</p>
                                </div>
                                <div id="admin-user-history-list" class="scroll-area overflow-x-auto"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="admin-section-group admin-accordion-item" data-admin-accordion-item data-admin-accordion-id="security">
                    <button type="button" class="admin-accordion-trigger" data-action="toggle-admin-accordion" data-admin-accordion-id="security" aria-expanded="false" aria-controls="admin-accordion-panel-security">
                        <span class="admin-accordion-copy">
                            <span class="admin-section-kicker">5. Security</span>
                            <span class="admin-section-title">Security &amp; Referrals</span>
                            <span class="admin-section-copy">Review manual balance changes and referral activity.</span>
                        </span>
                        <span class="admin-accordion-indicator" aria-hidden="true"><i class="fa-solid fa-chevron-down"></i></span>
                    </button>
                    <div id="admin-accordion-panel-security" class="admin-accordion-panel" data-admin-accordion-panel>
                        <div class="admin-accordion-panel-inner">
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Manual Adjustment History</h2>
                                    <p class="mt-1 text-sm text-slate-500">All admin balance adjustments with reasons and timestamps.</p>
                                </div>
                                <div id="admin-balance-adjustments-list" class="scroll-area overflow-x-auto"></div>
                            </div>
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Referral Program Tracking</h2>
                                    <p class="mt-1 text-sm text-slate-500">Referred signups, deposit amount, reward status, and fraud blocks.</p>
                                </div>
                                <div id="admin-referrals-list" class="scroll-area overflow-x-auto"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="admin-section-group admin-accordion-item" data-admin-accordion-item data-admin-accordion-id="number-management">
                    <button type="button" class="admin-accordion-trigger" data-action="toggle-admin-accordion" data-admin-accordion-id="number-management" aria-expanded="false" aria-controls="admin-accordion-panel-number-management">
                        <span class="admin-accordion-copy">
                            <span class="admin-section-kicker">6. Number Management</span>
                            <span class="admin-section-title">Number Management</span>
                            <span class="admin-section-copy">Load order price, API cost, profit, and status details only when needed.</span>
                        </span>
                        <span class="admin-accordion-indicator" aria-hidden="true"><i class="fa-solid fa-chevron-down"></i></span>
                    </button>
                    <div id="admin-accordion-panel-number-management" class="admin-accordion-panel" data-admin-accordion-panel>
                        <div class="admin-accordion-panel-inner">
                            <div class="admin-data-card">
                                <div class="mb-4">
                                    <h2 class="text-lg font-semibold text-slate-900">Number Management</h2>
                                    <p class="mt-1 text-sm text-slate-500">User email, service, price, API cost, profit, and status load after this section opens.</p>
                                </div>
                                <div id="admin-orders-list" class="scroll-area overflow-x-auto">
                                    <div class="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">Number Management is not loaded yet. Open this section to load order records.</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>
        </main>
    </div>

    <div id="screenshot-modal" class="admin-modal hidden">
        <div class="admin-modal-card">
            <div class="admin-modal-header">
                <div>
                    <h2 class="admin-modal-title">Payment Proof Preview</h2>
                    <p class="admin-modal-subtitle">Inspect the screenshot before approving or rejecting the request.</p>
                </div>
                <button type="button" class="admin-modal-close" data-close-modal="screenshot-modal" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="admin-modal-body">
                <div class="screenshot-meta">
                    <div class="screenshot-meta-row"><span>User</span><strong id="screenshot-user">—</strong></div>
                    <div class="screenshot-meta-row"><span>Email</span><strong id="screenshot-email">—</strong></div>
                    <div class="screenshot-meta-row"><span>Amount</span><strong id="screenshot-amount">—</strong></div>
                    <div class="screenshot-meta-row"><span>Status</span><strong id="screenshot-status">—</strong></div>
                </div>
                <img id="screenshot-preview" class="screenshot-preview" src="" alt="Payment proof">
            </div>
        </div>
    </div>

    <script src="/admin.js"></script>
</body>
</html>
