const state = {
    currentUser: null,
    activeOrder: null,
    orders: [],
    completedOrders: [],
    paymentRequests: [],
    numberHistory: [],
    allCountries: [],
    currentFilter: 'all',
    currentService: 'whatsapp',
    currentAdminTab: 'payment-requests',
    paymentHistoryRefreshInterval: null,
    liveUserRefreshInterval: null,
    inlineOrderPollInterval: null,
    inlineOrderTimerInterval: null,
    otpInterval: null,
    timerInterval: null,
    adminRefreshInterval: null,
    adminProviderSummaryRefreshInFlight: false,
    adminPendingPaymentsRefreshInFlight: false,
    adminNumberManagementLoaded: false,
    adminNumberManagementLoadInFlight: false,
    adminAlertInterval: null,
    adminAlertTimeout: null,
    lastPendingCount: 0,
    theme: 'light',
    otpPollInFlight: false,
    otpNotificationKeys: new Set(),
    hiddenCancelledOrderIds: new Set(),
    otpBlockedOrderIds: new Set(),
    cancelPendingOrderIds: new Set(),
    expiringOrderIds: new Set(),
    expiredOrderRetryAt: new Map(),
    expireRequestInFlight: false,
    historyView: 'activations',
    numberHistorySearch: '',
    activationFilter: 'waiting',
    purchaseInFlight: false,
    purchaseRequests: new Map(),
    adminUsers: [],
    adminBalanceAdjustments: [],
    adminUsersSearch: '',
    selectedAdminHistoryUserId: null,
    selectedAdminHistoryUserLabel: '',
    availableServices: [],
    serviceIconMap: {},
    serviceIconSummary: null,
    apiCatalogServices: [],
    serviceIconBrokenPaths: new Set(),
    waitingOrdersExpanded: false,
    processingRequestsExpanded: false,
    referralProgram: null,
    adminReferrals: [],
    pendingReferralCode: '',
    shouldOpenRegisterFromLanding: false,
    lastAdminSecurityEventId: 0,
    tierCache: new Map(),
    expandedTierCountryId: null,
    orderTierMeta: new Map()
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
        label: 'Easypaisa',
        minAmount: 100,
        currency: 'PKR',
        amountPlaceholder: 'Amount (Minimum 100 PKR)',
        transactionPlaceholder: 'Easypaisa Transaction ID (optional but recommended)',
        transactionRequired: false,
        uploadTitle: 'Upload Easypaisa payment screenshot',
        guidanceText: 'پیمنٹ کی اسکرین شاٹ اس باکس میں ڈال کر سبمٹ پیمنٹ پر کلک کر دیجیے',
        guidanceDirection: 'rtl',
        submitLabel: 'Submit Payment',
        successTitle: 'آپ کی Easypaisa پیمنٹ Add ہو گئی ہے، کچھ ہی دیر میں آپ کے اکاؤنٹ میں پیسے_ADD کر دیے جائیں گے'
    },
    binance: {
        key: 'binance',
        label: 'Binance',
        minAmount: 1,
        currency: 'USDT',
        amountPlaceholder: 'Amount sent (Minimum 1 USDT)',
        transactionPlaceholder: 'Binance Transaction ID',
        transactionRequired: true,
        uploadTitle: 'Upload Binance transfer screenshot',
        guidanceText: 'Send payment using Binance UID Transfer only. Do NOT use blockchain network transfer. Only direct Binance internal transfer accepted. Minimum deposit is 1 USDT.',
        guidanceDirection: 'ltr',
        submitLabel: 'Submit Binance Receipt',
        successTitle: 'Your Binance deposit request has been submitted. After admin approval, your wallet will be credited automatically.'
    }
};

const PAYMENT_PROOF_ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

const serviceMeta = {
    whatsapp: {
        label: 'WhatsApp',
        shortLabel: 'WA',
        catalogTitle: 'Available WhatsApp Numbers',
        description: 'Choose a country below and order in one tap.',
        iconClass: 'fa-brands fa-whatsapp',
        iconTone: 'text-[#25D366]',
        wrapperTone: 'bg-emerald-500/10 ring-1 ring-emerald-400/20'
    },
    facebook: {
        label: 'Facebook',
        shortLabel: 'FB',
        catalogTitle: 'Available Facebook Numbers',
        description: 'Pick a country below and buy instantly.',
        iconClass: 'fa-brands fa-facebook',
        iconTone: 'text-[#1877F2]',
        wrapperTone: 'bg-blue-500/10 ring-1 ring-blue-400/20'
    },
    instagram: {
        label: 'Instagram',
        shortLabel: 'IG',
        catalogTitle: 'Available Instagram Numbers',
        description: 'Pick a country below and order in one tap.',
        iconClass: 'fa-brands fa-instagram',
        iconTone: 'service-gradient-instagram',
        wrapperTone: 'bg-pink-500/10 ring-1 ring-pink-400/20'
    },
    snapchat: {
        label: 'Snapchat',
        shortLabel: 'SC',
        catalogTitle: 'Available Snapchat Numbers',
        description: 'Choose a country below and purchase a number quickly.',
        iconClass: 'fa-brands fa-snapchat',
        iconTone: 'text-[#FFFC00] drop-shadow-[0_0_10px_rgba(255,252,0,0.25)]',
        wrapperTone: 'bg-yellow-300/10 ring-1 ring-yellow-300/20'
    },
    tiktok: {
        label: 'TikTok',
        shortLabel: 'TT',
        catalogTitle: 'Available TikTok Numbers',
        description: 'Choose a country below and buy TikTok OTP numbers quickly.',
        iconClass: 'fa-brands fa-tiktok',
        iconTone: 'text-slate-900',
        wrapperTone: 'bg-slate-900/10 ring-1 ring-slate-400/20'
    },
    imo: {
        label: 'Imo Messenger',
        shortLabel: 'IMO',
        catalogTitle: 'Available Imo Messenger Numbers',
        description: 'Get OTP-ready Imo numbers with quick delivery.',
        iconClass: 'fa-solid fa-comment-dots',
        iconTone: 'text-blue-700',
        wrapperTone: 'bg-blue-500/10 ring-1 ring-blue-400/20'
    },
    tinder: {
        label: 'Tinder',
        shortLabel: 'TD',
        catalogTitle: 'Available Tinder Numbers',
        description: 'Choose a country and buy Tinder verification numbers instantly.',
        iconClass: 'fa-brands fa-tinder',
        iconTone: 'text-rose-600',
        wrapperTone: 'bg-rose-500/10 ring-1 ring-rose-400/20'
    },
    twitter: {
        label: 'Twitter / X',
        shortLabel: 'X',
        catalogTitle: 'Available Twitter Numbers',
        description: 'Buy low-cost numbers for X / Twitter verification.',
        iconClass: 'fa-brands fa-x-twitter',
        iconTone: 'text-slate-900',
        wrapperTone: 'bg-slate-900/10 ring-1 ring-slate-400/20'
    },
    amazon: {
        label: 'Amazon',
        shortLabel: 'AMZ',
        catalogTitle: 'Available Amazon Numbers',
        description: 'Pick a country below for Amazon OTP-ready numbers.',
        iconClass: 'fa-brands fa-amazon',
        iconTone: 'text-amber-600',
        wrapperTone: 'bg-amber-500/10 ring-1 ring-amber-400/20'
    },
    alibaba: {
        label: 'Alibaba',
        shortLabel: 'ABB',
        catalogTitle: 'Available Alibaba Numbers',
        description: 'Fast OTP numbers for Alibaba verification.',
        iconClass: 'fa-brands fa-alipay',
        iconTone: 'text-orange-600',
        wrapperTone: 'bg-orange-500/10 ring-1 ring-orange-400/20'
    },
    careem: {
        label: 'Careem',
        shortLabel: 'CRM',
        catalogTitle: 'Available Careem Numbers',
        description: 'Secure Careem-ready OTP numbers by country.',
        iconClass: 'fa-solid fa-taxi',
        iconTone: 'text-emerald-600',
        wrapperTone: 'bg-emerald-500/10 ring-1 ring-emerald-400/20'
    },
    spotify: {
        label: 'Spotify',
        shortLabel: 'SP',
        catalogTitle: 'Available Spotify Numbers',
        description: 'Buy Spotify OTP numbers with instant activation.',
        iconClass: 'fa-brands fa-spotify',
        iconTone: 'text-green-600',
        wrapperTone: 'bg-green-500/10 ring-1 ring-green-400/20'
    },
    openai: {
        label: 'OpenAI / ChatGPT',
        shortLabel: 'AI',
        catalogTitle: 'Available OpenAI Numbers',
        description: 'Choose a country for OpenAI / ChatGPT verification.',
        iconClass: 'fa-solid fa-brain',
        iconTone: 'text-slate-800',
        wrapperTone: 'bg-slate-500/10 ring-1 ring-slate-400/20'
    },
    paypal: {
        label: 'PayPal',
        shortLabel: 'PP',
        catalogTitle: 'Available PayPal Numbers',
        description: 'Trusted OTP numbers for PayPal account verification.',
        iconClass: 'fa-brands fa-paypal',
        iconTone: 'text-blue-700',
        wrapperTone: 'bg-blue-500/10 ring-1 ring-blue-400/20'
    },
    aliexpress: {
        label: 'AliExpress',
        shortLabel: 'AEX',
        catalogTitle: 'Available AliExpress Numbers',
        description: 'Affordable OTP numbers for AliExpress signup.',
        iconClass: 'fa-solid fa-cart-shopping',
        iconTone: 'text-orange-600',
        wrapperTone: 'bg-orange-500/10 ring-1 ring-orange-400/20'
    },
    wechat: {
        label: 'WeChat',
        shortLabel: 'WC',
        catalogTitle: 'Available WeChat Numbers',
        description: 'Buy numbers for WeChat verification in seconds.',
        iconClass: 'fa-brands fa-weixin',
        iconTone: 'text-lime-700',
        wrapperTone: 'bg-lime-500/10 ring-1 ring-lime-400/20'
    },
    viber: {
        label: 'Viber',
        shortLabel: 'VB',
        catalogTitle: 'Available Viber Numbers',
        description: 'Country-based Viber OTP numbers, ready to use.',
        iconClass: 'fa-brands fa-viber',
        iconTone: 'text-violet-700',
        wrapperTone: 'bg-violet-500/10 ring-1 ring-violet-400/20'
    },
    uber: {
        label: 'Uber',
        shortLabel: 'UB',
        catalogTitle: 'Available Uber Numbers',
        description: 'Quick Uber signup numbers with low pricing.',
        iconClass: 'fa-brands fa-uber',
        iconTone: 'text-slate-900',
        wrapperTone: 'bg-slate-900/10 ring-1 ring-slate-400/20'
    },
    microsoft: {
        label: 'Microsoft',
        shortLabel: 'MS',
        catalogTitle: 'Available Microsoft Numbers',
        description: 'Buy OTP numbers for Microsoft verification.',
        iconClass: 'fa-brands fa-microsoft',
        iconTone: 'text-sky-700',
        wrapperTone: 'bg-sky-500/10 ring-1 ring-sky-400/20'
    },
    signal: {
        label: 'Signal',
        shortLabel: 'SIG',
        catalogTitle: 'Available Signal Numbers',
        description: 'Secure Signal activation numbers by country.',
        iconClass: 'fa-solid fa-signal',
        iconTone: 'text-blue-600',
        wrapperTone: 'bg-blue-500/10 ring-1 ring-blue-400/20'
    },
    easypay: {
        label: 'Easypay',
        shortLabel: 'EP',
        catalogTitle: 'Available Easypay Numbers',
        description: 'Get phone numbers for Easypay verification.',
        iconClass: 'fa-solid fa-wallet',
        iconTone: 'text-amber-600',
        wrapperTone: 'bg-amber-500/10 ring-1 ring-amber-400/20'
    },
    google: {
        label: 'Google / Gmail / YouTube',
        shortLabel: 'GO',
        catalogTitle: 'Available Google Numbers',
        description: 'Choose a country below and order a Google-family OTP number.',
        iconClass: 'fa-brands fa-google',
        iconTone: 'service-gradient-google',
        wrapperTone: 'bg-white/10 ring-1 ring-white/10'
    }
};

const defaultCountries = [
    {
        name: 'Indonesia',
        code: '+62',
        price: 100,
        countryId: 6,
        flag: 'https://flagcdn.com/w40/id.png'
    }
];

function applyFallbackIfEmpty(serviceCountries) {
    if (!serviceCountries || serviceCountries.length === 0) {
        return defaultCountries;
    }
    return serviceCountries;
}

const BUILT_IN_SERVICE_ORDER = Object.keys(serviceMeta);
const TERMS_ACCEPTED_STORAGE_KEY = 'mrf-terms-accepted-v1';

const notificationSound = new Audio('https://www.soundjay.com/misc/sounds/bell-ringing-05.mp3');
const backgroundOtpSound = new Audio('https://assets.mixkit.co/sfx/preview/mixkit-alarm-digital-clock-beep-989.mp3');
let backgroundOtpSoundUnlocked = false;
let otpSoundStopTimer = null;
const SUPPORT_WHATSAPP_URL = 'https://wa.me/447716582579?text=I%20need%20help%20about%20mrfsms%20panel';
const LOCAL_DEFAULT_LOGO_URL = '/logos/default.svg';
let clientSignalsPromise = null;
let serviceIconMapPromise = null;
let serviceIconObserver = null;
let serviceIconCoverageSummaryTimer = null;
const SERVICE_ICON_DEBUG_PREFIX = '[service-icon]';

const qs = (id) => document.getElementById(id);
const qsa = (selector) => Array.from(document.querySelectorAll(selector));

function normalizeReferralCode(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 16);
}

function bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
}

async function sha256Hex(value) {
    const input = String(value || '');
    if (window.crypto?.subtle && typeof TextEncoder !== 'undefined') {
        const encoded = new TextEncoder().encode(input);
        const hashBuffer = await window.crypto.subtle.digest('SHA-256', encoded);
        return bufferToHex(hashBuffer);
    }
    let hash = 0;
    for (let index = 0; index < input.length; index += 1) {
        hash = ((hash << 5) - hash) + input.charCodeAt(index);
        hash |= 0;
    }
    return `fallback${Math.abs(hash)}`;
}

async function getClientSignals() {
    if (!clientSignalsPromise) {
        clientSignalsPromise = (async () => {
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
            const languages = Array.isArray(navigator.languages) ? navigator.languages.join(',') : String(navigator.language || '');
            const screenSize = typeof window.screen !== 'undefined'
                ? `${window.screen.width || 0}x${window.screen.height || 0}x${window.screen.colorDepth || 0}`
                : '0x0x0';
            const rawDeviceFingerprint = [
                navigator.userAgent || '',
                navigator.platform || '',
                navigator.hardwareConcurrency || '',
                navigator.maxTouchPoints || '',
                screenSize,
                timezone
            ].join('|');
            const rawBrowserFingerprint = [
                navigator.userAgent || '',
                navigator.vendor || '',
                navigator.language || '',
                languages,
                timezone
            ].join('|');
            return {
                deviceFingerprint: await sha256Hex(rawDeviceFingerprint),
                browserFingerprint: await sha256Hex(rawBrowserFingerprint)
            };
        })();
    }
    return clientSignalsPromise;
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

const THEME_STORAGE_KEY = 'mrf-theme';
const COUNTRY_FLAG_FALLBACKS = {
    canada: '🇨🇦',
    indonesia: '🇮🇩',
    saudi: '🇸🇦',
    'saudi arabia': '🇸🇦',
    brazil: '🇧🇷',
    usa: '🇺🇸',
    'usa virtual': '🇺🇸',
    'united states': '🇺🇸',
    'united kingdom': '🇬🇧',
    uk: '🇬🇧'
};

const COUNTRY_NAME_IMAGE_CODE_ALIASES = {
    usa: 'us',
    'usa virtual': 'us',
    'united states': 'us',
    'united states of america': 'us',
    uk: 'gb',
    'united kingdom': 'gb',
    saudi: 'sa',
    'saudi arabia': 'sa',
    'ivory coast': 'ci',
    'cote d ivoire': 'ci',
    'dr congo': 'cd',
    'democratic republic of the congo': 'cd',
    'congo dem republic': 'cd',
    macedonia: 'mk',
    'north macedonia': 'mk',
    uae: 'ae',
    'united arab emirates': 'ae',
    brunei: 'bn',
    'papua new guinea': 'pg',
    'hong kong': 'hk',
    taiwan: 'tw',
    laos: 'la',
    moldova: 'md',
    bolivia: 'bo',
    tanzania: 'tz',
    venezuela: 've',
    'south korea': 'kr',
    'north korea': 'kp',
    kosovo: 'xk'
};

let countryImageCodeLookup = null;

notificationSound.preload = 'auto';
backgroundOtpSound.preload = 'auto';
backgroundOtpSound.volume = 1;

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

function normalizeServiceLookup(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

const EXTRA_SERVICE_TYPE_ALIASES = {
    linkdlin: 'linkedin'
};

function createServiceTypeFromLabel(label, code = '') {
    const normalizedLabel = normalizeServiceLookup(label).replace(/\s+/g, '');
    if (normalizedLabel) return EXTRA_SERVICE_TYPE_ALIASES[normalizedLabel] || normalizedLabel;
    return String(code || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

function buildServiceShortLabel(label, fallback = '') {
    const words = String(label || '')
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean);
    if (words.length >= 2) {
        return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
    }
    const compact = String(label || fallback || '').replace(/[^A-Za-z0-9]+/g, '');
    return compact.slice(0, 2).toUpperCase() || 'SM';
}

function getStaticServiceLogoUrl(serviceType) {
    const resolvedIcon = resolveServiceIconMatch(serviceType);
    return resolvedIcon.finalImageUrl || LOCAL_DEFAULT_LOGO_URL;
}

function getServiceIconFileName(url) {
    const rawFileName = String(url || '').split('/').pop() || '';
    try {
        return decodeURIComponent(rawFileName);
    } catch {
        return rawFileName;
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
        await response.json();
        showToast(`User ${normalizedAction.replace(/-/g, ' ')} updated`, 'success');
        await loadAdminData();
        if (state.currentUser) {
            await refreshUserInfo();
        }
    } catch (err) {
        showToast(err.message || 'User security action failed', 'error');
    }
}

function resolveServiceIconMatch(serviceType) {
    const serviceIconMap = state.serviceIconMap && typeof state.serviceIconMap === 'object' ? state.serviceIconMap : {};
    const normalizedServiceName = normalizeServiceIconLookup(serviceType);
    const candidates = getServiceIconLookupCandidates(serviceType);
    const matchedKey = candidates.find((candidate) => serviceIconMap[candidate]) || '';
    const finalImageUrl = matchedKey ? serviceIconMap[matchedKey] : '';
    const matchedFileName = finalImageUrl ? getServiceIconFileName(finalImageUrl) : '';
    return {
        normalizedServiceName,
        candidates,
        matchedKey,
        matchedFileName,
        finalImageUrl
    };
}

function logServiceIconResolution(serviceType, resolvedIcon, renderMode) {
    console.log(SERVICE_ICON_DEBUG_PREFIX, {
        originalServiceName: serviceType,
        normalizedServiceName: resolvedIcon.normalizedServiceName || null,
        matchedFilename: resolvedIcon.matchedFileName || null,
        finalImageUrl: resolvedIcon.finalImageUrl || null,
        renderedWith: renderMode
    });
}

function normalizeServiceIconLookup(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
        .toLowerCase()
        .replace(/[\s&,\-\/()]+/g, '')
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

function addServiceIconLookupCandidate(bucket, value) {
    const rawValue = String(value || '').trim();
    if (!rawValue) return;
    const normalizedLookup = normalizeServiceIconLookup(rawValue);
    if (normalizedLookup) {
        bucket.add(normalizedLookup);
    }
    const withoutParentheses = rawValue.replace(/\([^)]*\)/g, ' ').trim();
    const normalizedWithoutParentheses = normalizeServiceIconLookup(withoutParentheses);
    if (normalizedWithoutParentheses) {
        bucket.add(normalizedWithoutParentheses);
    }
    rawValue
        .split(/[\\/,&]+/g)
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach((part) => {
            const normalizedPart = normalizeServiceIconLookup(part);
            if (normalizedPart) {
                bucket.add(normalizedPart);
            }
        });
    Array.from(rawValue.matchAll(/\(([^)]+)\)/g)).forEach((match) => {
        const normalizedPart = normalizeServiceIconLookup(match[1]);
        if (normalizedPart) {
            bucket.add(normalizedPart);
        }
    });
}

function getServiceIconLookupCandidates(serviceType) {
    const candidates = new Set();
    const rawValue = String(serviceType || '').trim();
    if (!rawValue) return [];
    const normalizedValue = normalizeServiceIconLookup(rawValue);
    const matchingCatalogEntry = (Array.isArray(state.availableServices) ? state.availableServices : []).find((service) => {
        const entryServiceType = String(service?.serviceType || '').trim();
        return entryServiceType === rawValue
            || normalizeServiceIconLookup(entryServiceType) === normalizedValue
            || normalizeServiceIconLookup(service?.label) === normalizedValue;
    });
    const matchingMeta = serviceMeta[rawValue] || serviceMeta[matchingCatalogEntry?.serviceType || ''] || null;
    addServiceIconLookupCandidate(candidates, rawValue);
    addServiceIconLookupCandidate(candidates, matchingCatalogEntry?.serviceType);
    addServiceIconLookupCandidate(candidates, matchingCatalogEntry?.label);
    addServiceIconLookupCandidate(candidates, matchingMeta?.label);
    return Array.from(candidates);
}

function registerServiceIconCoverageEntry(registry, serviceType, label, source) {
    const resolvedServiceType = String(serviceType || '').trim();
    const resolvedLabel = String(label || resolvedServiceType || 'Service').trim();
    const normalizedServiceName = normalizeServiceIconLookup(resolvedServiceType || resolvedLabel);
    if (!normalizedServiceName) return;
    if (!registry.has(normalizedServiceName)) {
        registry.set(normalizedServiceName, {
            normalizedServiceName,
            serviceType: resolvedServiceType || resolvedLabel,
            label: resolvedLabel,
            sources: new Set()
        });
    }
    const entry = registry.get(normalizedServiceName);
    if (!entry.serviceType && resolvedServiceType) {
        entry.serviceType = resolvedServiceType;
    }
    if ((!entry.label || entry.label === entry.serviceType) && resolvedLabel) {
        entry.label = resolvedLabel;
    }
    entry.sources.add(source);
}

function getServiceIconCoverageEntries() {
    const registry = new Map();
    Object.keys(serviceMeta).forEach((serviceType) => {
        registerServiceIconCoverageEntry(registry, serviceType, getServiceMeta(serviceType).label, 'public/app.js');
    });
    getDefaultServiceCatalog().forEach((service) => {
        registerServiceIconCoverageEntry(registry, service?.serviceType, service?.label || getServiceMeta(service?.serviceType).label, 'catalog');
    });
    (Array.isArray(state.apiCatalogServices) ? state.apiCatalogServices : []).forEach((service) => {
        registerServiceIconCoverageEntry(registry, service?.serviceType, service?.label, 'api');
    });
    (Array.isArray(state.availableServices) ? state.availableServices : []).forEach((service) => {
        registerServiceIconCoverageEntry(registry, service?.serviceType, service?.label, 'merged');
    });
    return Array.from(registry.values()).sort((left, right) => left.normalizedServiceName.localeCompare(right.normalizedServiceName));
}

function buildServiceIconCoverageSummary() {
    const coverageEntries = getServiceIconCoverageEntries();
    const matchedServices = [];
    const unmatchedServices = [];
    coverageEntries.forEach((entry) => {
        const resolvedIcon = resolveServiceIconMatch(entry.serviceType || entry.label);
        const serviceSummary = {
            serviceType: entry.serviceType || null,
            label: entry.label || null,
            normalizedServiceName: entry.normalizedServiceName || null,
            matchedFilename: resolvedIcon.matchedFileName || null,
            finalImageUrl: resolvedIcon.finalImageUrl || null,
            sources: Array.from(entry.sources).sort((left, right) => left.localeCompare(right))
        };
        if (resolvedIcon.finalImageUrl) {
            matchedServices.push(serviceSummary);
            return;
        }
        unmatchedServices.push(serviceSummary);
    });
    return {
        totalIconsFound: Number(state.serviceIconSummary?.totalIconsFound || Object.keys(state.serviceIconMap || {}).length),
        totalResolvedIcons: Number(state.serviceIconSummary?.totalResolvedIcons || Object.keys(state.serviceIconMap || {}).length),
        totalServicesEvaluated: coverageEntries.length,
        totalServicesMatched: matchedServices.length,
        unmatchedServices,
        duplicateIconNames: Array.isArray(state.serviceIconSummary?.duplicateIconNames) ? state.serviceIconSummary.duplicateIconNames : [],
        brokenImagePaths: Array.from(state.serviceIconBrokenPaths || [])
    };
}

function logServiceIconCoverageSummary() {
    const summary = buildServiceIconCoverageSummary();
    console.groupCollapsed(`${SERVICE_ICON_DEBUG_PREFIX} coverage summary`);
    console.log({
        totalIconsFound: summary.totalIconsFound,
        totalResolvedIcons: summary.totalResolvedIcons,
        totalServicesEvaluated: summary.totalServicesEvaluated,
        totalServicesMatched: summary.totalServicesMatched,
        totalUnmatchedServices: summary.unmatchedServices.length,
        duplicateIconNames: summary.duplicateIconNames.length,
        brokenImagePaths: summary.brokenImagePaths.length
    });
    if (summary.unmatchedServices.length) {
        console.log('unmatched services', summary.unmatchedServices);
    }
    if (summary.duplicateIconNames.length) {
        console.log('duplicate icon names', summary.duplicateIconNames);
    }
    if (summary.brokenImagePaths.length) {
        console.log('broken image paths', summary.brokenImagePaths);
    }
    console.groupEnd();
}

function scheduleServiceIconCoverageSummary(delay = 0) {
    if (serviceIconCoverageSummaryTimer) {
        window.clearTimeout(serviceIconCoverageSummaryTimer);
    }
    serviceIconCoverageSummaryTimer = window.setTimeout(() => {
        serviceIconCoverageSummaryTimer = null;
        logServiceIconCoverageSummary();
    }, Math.max(0, Number(delay || 0)));
}

async function loadServiceIconMap() {
    if (Object.keys(state.serviceIconMap || {}).length) {
        return state.serviceIconMap;
    }
    if (!serviceIconMapPromise) {
        serviceIconMapPromise = fetchJSON(`/api/service-icons?v=${Date.now()}`)
            .then((iconPayload) => {
                const iconMap = iconPayload?.icons && typeof iconPayload.icons === 'object'
                    ? iconPayload.icons
                    : (iconPayload && typeof iconPayload === 'object' ? iconPayload : {});
                const iconSummary = iconPayload?.summary && typeof iconPayload.summary === 'object'
                    ? iconPayload.summary
                    : {
                        totalIconsFound: Object.keys(iconMap || {}).length,
                        totalResolvedIcons: Object.keys(iconMap || {}).length,
                        duplicateIconNames: []
                    };
                state.serviceIconMap = iconMap && typeof iconMap === 'object' ? iconMap : {};
                state.serviceIconSummary = iconSummary;
                state.serviceIconBrokenPaths.clear();
                console.log(SERVICE_ICON_DEBUG_PREFIX, {
                    manifestLoaded: true,
                    iconCount: Object.keys(state.serviceIconMap).length,
                    totalIconsFound: Number(state.serviceIconSummary?.totalIconsFound || 0),
                    duplicateIconCount: Array.isArray(state.serviceIconSummary?.duplicateIconNames) ? state.serviceIconSummary.duplicateIconNames.length : 0,
                    amazon: state.serviceIconMap.amazon || null,
                    twitter: state.serviceIconMap.twitter || null,
                    netflix: state.serviceIconMap.netflix || null,
                    discord: state.serviceIconMap.discord || null,
                    steam: state.serviceIconMap.steam || null,
                    linkedin: state.serviceIconMap.linkedin || null,
                    cashapp: state.serviceIconMap.cashapp || null
                });
                return state.serviceIconMap;
            })
            .catch((error) => {
                state.serviceIconMap = {};
                state.serviceIconSummary = {
                    totalIconsFound: 0,
                    totalResolvedIcons: 0,
                    duplicateIconNames: []
                };
                state.serviceIconBrokenPaths.clear();
                console.warn(SERVICE_ICON_DEBUG_PREFIX, {
                    manifestLoaded: false,
                    error: error?.message || String(error || 'Unknown service icon manifest error')
                });
                return state.serviceIconMap;
            });
    }
    return serviceIconMapPromise;
}

function createGeneratedServiceMeta(serviceType, label, options = {}) {
    const displayLabel = String(label || serviceType || 'Service').trim() || 'Service';
    const shortLabel = buildServiceShortLabel(displayLabel, serviceType);
    const comingSoon = options.comingSoon === true;
    const generatedMeta = {
        label: displayLabel,
        shortLabel,
        catalogTitle: comingSoon ? `${displayLabel} Service Catalog` : `Available ${displayLabel} Numbers`,
        description: comingSoon
            ? `${displayLabel} has been added to the service catalog. Live number availability will be enabled soon.`
            : `Choose a country below and order ${displayLabel} numbers instantly.`,
        iconClass: 'fa-solid fa-globe',
        iconTone: 'text-emerald-700',
        wrapperTone: 'bg-emerald-500/10 ring-1 ring-emerald-400/20',
        generated: true,
        comingSoon
    };
    serviceMeta[serviceType] = generatedMeta;
    return generatedMeta;
}

function getDefaultServiceCatalog() {
    return BUILT_IN_SERVICE_ORDER.map((serviceType) => ({
        serviceType,
        label: getServiceMeta(serviceType).label,
        isBuiltIn: true,
        comingSoon: false,
        canOrder: true
    }));
}

function normalizeServiceCatalogEntry(entry) {
    const serviceType = String(entry?.serviceType || '').trim().toLowerCase()
        || createServiceTypeFromLabel(entry?.label, entry?.serviceType);
    const label = String(entry?.label || serviceType || 'Service').trim();
    if (!serviceType || !label) return null;
    const comingSoon = entry?.comingSoon === true || entry?.canOrder === false;
    const existingMeta = serviceMeta[serviceType];
    if (!existingMeta || existingMeta.generated) {
        createGeneratedServiceMeta(serviceType, label, { comingSoon });
    }
    return {
        serviceType,
        label,
        isBuiltIn: entry?.isBuiltIn === true,
        comingSoon,
        canOrder: entry?.canOrder !== false,
        preserveCountryOrder: entry?.preserveCountryOrder === true
    };
}

function getCurrentServiceCatalogEntry() {
    return (Array.isArray(state.availableServices) ? state.availableServices : [])
        .find((service) => service.serviceType === state.currentService) || null;
}

function canOrderCurrentService() {
    return getCurrentServiceCatalogEntry()?.canOrder !== false;
}

function mergeServiceCatalogEntries(primaryServices, fallbackServices) {
    const merged = [];
    const seen = new Set();
    const addService = (service) => {
        if (!service || !service.serviceType || seen.has(service.serviceType)) return;
        seen.add(service.serviceType);
        merged.push(service);
    };
    (Array.isArray(primaryServices) ? primaryServices : []).forEach(addService);
    (Array.isArray(fallbackServices) ? fallbackServices : []).forEach(addService);
    return merged;
}

function parseExtraServicesFromText(rawText) {
    const tokens = String(rawText || '')
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean);
    const seenLabels = new Set(BUILT_IN_SERVICE_ORDER.map((serviceType) => normalizeServiceLookup(getServiceMeta(serviceType).label)));
    const extras = [];
    for (let index = 0; index < tokens.length - 1; index += 1) {
        const code = tokens[index];
        const label = tokens[index + 1];
        if (!code || !label) continue;
        const looksLikeCode = !/\s/.test(code) && code.length <= 8;
        if (!looksLikeCode) continue;
        const normalizedLabel = normalizeServiceLookup(label);
        if (!normalizedLabel || seenLabels.has(normalizedLabel)) {
            if (tokens[index + 2] === label) index += 2;
            continue;
        }
        const serviceType = createServiceTypeFromLabel(label, code);
        if (!serviceType || seenLabels.has(normalizedLabel)) {
            if (tokens[index + 2] === label) index += 2;
            continue;
        }
        seenLabels.add(normalizedLabel);
        createGeneratedServiceMeta(serviceType, label, { comingSoon: false, serviceCode: code });
        extras.push({
            serviceType,
            label,
            isBuiltIn: false,
            comingSoon: false,
            canOrder: true
        });
        if (tokens[index + 2] === label) {
            index += 2;
        }
    }
    return extras.sort((left, right) => String(left.label || '').localeCompare(String(right.label || '')));
}

function parseExtraServicesFromCodeTableText(rawText) {
    const lines = String(rawText || '')
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean);
    const seenLabels = new Set(BUILT_IN_SERVICE_ORDER.map((serviceType) => normalizeServiceLookup(getServiceMeta(serviceType).label)));
    const seenServiceTypes = new Set(BUILT_IN_SERVICE_ORDER);
    const extras = [];
    lines.forEach((line) => {
        const tabParts = line.split(/\t+/).map((part) => part.trim()).filter(Boolean);
        const parts = tabParts.length >= 2
            ? [tabParts[0], tabParts[tabParts.length - 1]]
            : (() => {
                const match = line.match(/^(.*?)\s+([A-Za-z0-9_]+)$/);
                return match ? [match[1].trim(), match[2].trim()] : [];
            })();
        const [label, code] = parts;
        if (!label || !code) return;
        const looksLikeCode = !/\s/.test(code) && code.length <= 12;
        if (!looksLikeCode) return;
        const normalizedLabel = normalizeServiceLookup(label);
        const serviceType = createServiceTypeFromLabel(label, code);
        if (!normalizedLabel || !serviceType || seenLabels.has(normalizedLabel) || seenServiceTypes.has(serviceType)) return;
        seenLabels.add(normalizedLabel);
        seenServiceTypes.add(serviceType);
        createGeneratedServiceMeta(serviceType, label, { comingSoon: false, serviceCode: code });
        extras.push({
            serviceType,
            label,
            isBuiltIn: false,
            comingSoon: false,
            canOrder: true
        });
    });
    return extras.sort((left, right) => String(left.label || '').localeCompare(String(right.label || '')));
}

function renderServiceGrid() {
    const grid = qs('service-grid');
    if (!grid) return;
    const services = Array.isArray(state.availableServices) && state.availableServices.length
        ? state.availableServices
        : getDefaultServiceCatalog();
    grid.innerHTML = services.map((service) => {
        const meta = getServiceMeta(service.serviceType);
        const isActive = service.serviceType === state.currentService;
        return `
            <button type="button" data-service="${escapeAttr(service.serviceType)}" class="service-tile ${isActive ? 'active' : ''} ${service.comingSoon ? 'service-tile--coming-soon' : ''}">
                <span data-service-icon="${escapeAttr(service.serviceType)}" data-logo-size="lg"></span>
                <span>${escapeHtml(meta.label)}</span>
                ${service.comingSoon ? '<span class="service-tile-status">Soon</span>' : ''}
            </button>
        `;
    }).join('');
    hydrateStaticServiceIcons();
    syncServiceButtons();
    filterServiceButtons();
}

async function loadAvailableServices() {
    state.availableServices = getDefaultServiceCatalog();
    renderServiceGrid();
    let apiServices = [];
    try {
        const services = await fetchJSON('/api/service-catalog');
        apiServices = Array.isArray(services)
            ? services.map((service) => normalizeServiceCatalogEntry(service)).filter(Boolean)
            : [];
        state.apiCatalogServices = apiServices;
    } catch {
        state.apiCatalogServices = [];
    }
    let fallbackServices = [];
    try {
        const [legacyResponse, codeTableResponse] = await Promise.all([
            fetch('/All Social Media Platform.txt', { credentials: 'include' }),
            fetch('/New Services Lists/All Services Codes.txt', { credentials: 'include' })
        ]);
        const extraServices = [];
        if (legacyResponse.ok) {
            extraServices.push(...parseExtraServicesFromText(await legacyResponse.text()));
        }
        if (codeTableResponse.ok) {
            extraServices.push(...parseExtraServicesFromCodeTableText(await codeTableResponse.text()));
        }
        fallbackServices = [...getDefaultServiceCatalog(), ...extraServices];
    } catch {
    }
    const mergedServices = mergeServiceCatalogEntries(
        apiServices.length ? apiServices : getDefaultServiceCatalog(),
        fallbackServices
    );
    if (mergedServices.length) {
        state.availableServices = mergedServices;
        if (!mergedServices.some((service) => service.serviceType === state.currentService) && mergedServices[0]) {
            state.currentService = mergedServices[0].serviceType;
        }
        renderServiceGrid();
    }
    scheduleServiceIconCoverageSummary(0);
}

function getServiceMeta(serviceType) {
    if (serviceMeta[serviceType]) return serviceMeta[serviceType];
    return createGeneratedServiceMeta(serviceType, serviceType, { comingSoon: false });
}

function renderFallbackServiceGlyph(serviceType) {
    const meta = getServiceMeta(serviceType);
    const fallbackText = escapeHtml(buildServiceShortLabel(meta.label, serviceType));
    return `<span class="inline-flex h-full w-full items-center justify-center rounded-[7px] bg-emerald-50 text-[0.68em] font-black uppercase tracking-[0.18em] text-emerald-700 ring-1 ring-emerald-200">${fallbackText}</span>`;
}

function renderServiceBrandImageGlyph(serviceType) {
    const resolvedIcon = resolveServiceIconMatch(serviceType);
    if (!resolvedIcon.finalImageUrl) {
        return '';
    }
    logServiceIconResolution(serviceType, resolvedIcon, '<img class="service-icon-img">');
    return `<img class="service-icon-img" src="${escapeAttr(resolvedIcon.finalImageUrl)}" alt="" loading="lazy" decoding="async" aria-hidden="true">`;
}

function renderServiceFallbackMarkup(serviceType) {
    const resolvedIcon = resolveServiceIconMatch(serviceType);
    logServiceIconResolution(serviceType, resolvedIcon, 'fallback');
    const svgMarkup = renderServiceSvg(serviceType);
    if (svgMarkup) {
        return `<span class="inline-flex h-full w-full items-center justify-center overflow-hidden rounded-[7px] bg-white/95 p-[1px]">${svgMarkup}</span>`;
    }
    const meta = getServiceMeta(serviceType);
    if (!meta.iconClass) return renderFallbackServiceGlyph(serviceType);
    const wrapperTone = meta.wrapperTone || 'bg-emerald-500/10 ring-1 ring-emerald-400/20';
    const iconTone = meta.iconTone || 'text-emerald-700';
    return `
        <span class="inline-flex h-full w-full items-center justify-center rounded-[7px] ${escapeAttr(wrapperTone)}">
            <i class="${escapeAttr(`${meta.iconClass} ${iconTone}`)}" aria-hidden="true"></i>
        </span>
    `;
}

function renderServiceSvg(serviceType) {
    switch (serviceType) {
        case 'facebook':
            return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1877F2"></circle><path d="M13.68 20v-6.18h2.07l.31-2.4h-2.38V9.89c0-.69.19-1.16 1.18-1.16h1.26V6.58c-.22-.03-.96-.08-1.82-.08-1.8 0-3.03 1.1-3.03 3.13v1.79H9.23v2.4h2.04V20h2.41Z" fill="#fff"></path></svg>';
        case 'instagram':
            return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="6" fill="#E1306C"></rect><rect x="6.8" y="6.8" width="10.4" height="10.4" rx="3.2" fill="none" stroke="#fff" stroke-width="1.8"></rect><circle cx="12" cy="12" r="2.6" fill="none" stroke="#fff" stroke-width="1.8"></circle><circle cx="17" cy="7.2" r="1.2" fill="#fff"></circle></svg>';
        case 'snapchat':
            return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="6" fill="#FFFC00"></rect><path d="M12 6.2c1.8 0 3.2 1.46 3.2 3.25 0 .35-.05.68-.15 1 .28.35.62.63 1 .82.4.21.76.3.76.67 0 .46-.61.73-1.22.82-.33.05-.43.17-.46.28-.13.55-.36 1.3-1.3 1.3-.23 0-.44-.05-.62-.12-.17.54-.58 1.56-1.21 1.56-.63 0-1.04-1.02-1.21-1.56-.18.07-.39.12-.62.12-.94 0-1.17-.75-1.3-1.3-.03-.11-.13-.23-.46-.28-.61-.09-1.22-.36-1.22-.82 0-.37.36-.46.76-.67.38-.19.72-.47 1-.82-.1-.32-.15-.65-.15-1 0-1.79 1.4-3.25 3.2-3.25Z" fill="#111827"></path></svg>';
        case 'tiktok':
            return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="6" fill="#111827"></rect><path d="M14.8 6.2c.36 1.05 1.09 1.78 2.2 2.2v2.07a4.88 4.88 0 0 1-2.12-.7v4.1a4.08 4.08 0 1 1-4.08-4.08c.25 0 .5.03.74.08v2.12a1.9 1.9 0 1 0 1.1 1.72V6.2h2.16Z" fill="#fff"></path></svg>';
        case 'imo':
            return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#00A6FF"></circle><text x="12" y="14.6" font-size="6.8" font-family="DM Sans, Arial, sans-serif" text-anchor="middle" font-weight="800" fill="#ffffff">imo</text></svg>';
        case 'tinder':
        case 'twitter':
        case 'amazon':
        case 'alibaba':
        case 'careem':
        case 'spotify':
        case 'openai':
        case 'paypal':
        case 'aliexpress':
        case 'wechat':
        case 'viber':
        case 'uber':
        case 'microsoft':
        case 'signal':
        case 'easypay':
            return null;
        case 'google':
            return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.6 12.23c0-.72-.06-1.25-.2-1.8H12v3.41h5.52c-.11.85-.73 2.13-2.1 2.99l-.02.11 3.05 2.36.21.02c1.92-1.77 2.94-4.39 2.94-7.09Z" fill="#4285F4"></path><path d="M12 22c2.7 0 4.97-.89 6.62-2.42l-3.24-2.49c-.86.6-2.01 1.01-3.38 1.01-2.64 0-4.89-1.73-5.69-4.13l-.1.01-3.17 2.46-.03.1C4.66 19.83 8.05 22 12 22Z" fill="#34A853"></path><path d="M6.31 13.97A5.93 5.93 0 0 1 6 12c0-.69.12-1.35.31-1.97l-.01-.13-3.2-2.49-.1.05A9.94 9.94 0 0 0 2 12c0 1.62.39 3.15 1.08 4.54l3.23-2.57Z" fill="#FBBC05"></path><path d="M12 5.9c1.73 0 2.9.74 3.56 1.36l2.6-2.53C16.96 3.61 14.7 2.7 12 2.7 8.05 2.7 4.66 4.87 3.01 8.05L6.3 10.6c.81-2.4 3.05-4.7 5.7-4.7Z" fill="#EA4335"></path></svg>';
        case 'whatsapp':
            return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#25D366"></circle><path d="M17 15.2c-.23.65-1.35 1.24-1.86 1.31-.48.07-1.09.1-1.77-.12-.41-.13-.94-.31-1.62-.61-2.84-1.23-4.69-4.09-4.83-4.28-.14-.19-1.15-1.53-1.15-2.91 0-1.38.72-2.05.98-2.33.26-.28.56-.35.75-.35.19 0 .37 0 .54.01.17.01.4-.06.62.48.23.55.78 1.9.85 2.04.07.14.12.31.02.5-.09.19-.14.31-.28.47-.14.16-.29.36-.41.48-.14.14-.28.3-.12.58.16.28.72 1.18 1.55 1.91 1.06.94 1.96 1.23 2.24 1.37.28.14.44.12.61-.07.17-.19.72-.84.91-1.13.19-.28.37-.23.61-.14.25.09 1.58.75 1.85.89.28.14.47.21.54.33.07.12.07.72-.16 1.37Z" fill="#fff"></path><path d="M6.2 18.2 7 15.3" stroke="#fff" stroke-width="1.4" stroke-linecap="round"></path></svg>';
        default:
            return null;
    }
}

function renderServiceLogo(serviceType, size = 'md') {
    const sizeMap = {
        sm: 'service-logo service-logo--sm',
        md: 'service-logo service-logo--md',
        lg: 'service-logo service-logo--lg',
        xl: 'service-logo service-logo--xl'
    };
    const imageMarkup = renderServiceBrandImageGlyph(serviceType);
    if (imageMarkup) {
        return `<span class="${sizeMap[size] || sizeMap.md}" data-service-icon-mode="image">${imageMarkup}</span>`;
    }
    return `<span class="${sizeMap[size] || sizeMap.md}" data-service-icon-mode="fallback">${renderServiceFallbackMarkup(serviceType)}</span>`;
}

function renderServiceLogoFallbackOnly(serviceType, size = 'md') {
    const sizeMap = {
        sm: 'service-logo service-logo--sm',
        md: 'service-logo service-logo--md',
        lg: 'service-logo service-logo--lg',
        xl: 'service-logo service-logo--xl'
    };
    return `<span class="${sizeMap[size] || sizeMap.md}" data-service-icon-mode="fallback">${renderServiceFallbackMarkup(serviceType)}</span>`;
}

function disconnectServiceIconObserver() {
    if (!serviceIconObserver) return;
    serviceIconObserver.disconnect();
    serviceIconObserver = null;
}

function createServiceIconObserver() {
    if (!('IntersectionObserver' in window)) return null;
    if (serviceIconObserver) return serviceIconObserver;
    const serviceGridShell = document.querySelector('.service-grid-shell');
    serviceIconObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            renderVisibleServiceIconSlot(entry.target);
            serviceIconObserver?.unobserve(entry.target);
        });
    }, {
        root: serviceGridShell || null,
        rootMargin: '120px 0px',
        threshold: 0.01
    });
    return serviceIconObserver;
}

function isServiceIconSlotVisible(slot) {
    if (!slot) return false;
    const slotRect = slot.getBoundingClientRect();
    const serviceGridShell = slot.closest('.service-grid-shell');
    if (serviceGridShell) {
        const shellRect = serviceGridShell.getBoundingClientRect();
        return slotRect.bottom >= shellRect.top - 80 && slotRect.top <= shellRect.bottom + 80;
    }
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    return slotRect.bottom >= -80 && slotRect.top <= viewportHeight + 80;
}

function renderVisibleServiceIconSlot(slot) {
    if (!slot || slot.dataset.iconRendered === 'true') return;
    const serviceType = slot.dataset.serviceIcon;
    const logoSize = slot.dataset.logoSize || 'md';
    const resolvedIcon = resolveServiceIconMatch(serviceType);
    console.log(SERVICE_ICON_DEBUG_PREFIX, {
        originalServiceName: serviceType,
        normalizedServiceName: resolvedIcon.normalizedServiceName || null,
        matchedFilename: resolvedIcon.matchedFileName || null,
        finalImageUrl: resolvedIcon.finalImageUrl || null,
        phase: 'before-render'
    });
    slot.innerHTML = renderServiceLogo(serviceType, logoSize);
    slot.dataset.iconRendered = 'true';
    attachServiceIconImageHandlers(slot, serviceType, logoSize);
}

function attachServiceIconImageHandlers(slot, serviceType, size = 'md') {
    const image = slot.querySelector('img.service-icon-img');
    if (!image) return;
    const resolvedIcon = resolveServiceIconMatch(serviceType);
    image.addEventListener('load', () => {
        const resolvedImagePath = image.currentSrc || image.getAttribute('src') || resolvedIcon.finalImageUrl || '';
        if (resolvedImagePath) {
            state.serviceIconBrokenPaths.delete(resolvedImagePath);
        }
        console.log(SERVICE_ICON_DEBUG_PREFIX, {
            originalServiceName: serviceType,
            normalizedServiceName: resolvedIcon.normalizedServiceName || null,
            matchedFilename: resolvedIcon.matchedFileName || null,
            finalImageUrl: resolvedImagePath || null,
            renderedWith: '<img class="service-icon-img">',
            status: 'loaded'
        });
    }, { once: true });
    image.addEventListener('error', () => {
        const brokenImagePath = image.currentSrc || image.getAttribute('src') || resolvedIcon.finalImageUrl || '';
        if (brokenImagePath) {
            state.serviceIconBrokenPaths.add(brokenImagePath);
        }
        console.warn(SERVICE_ICON_DEBUG_PREFIX, {
            originalServiceName: serviceType,
            normalizedServiceName: resolvedIcon.normalizedServiceName || null,
            matchedFilename: resolvedIcon.matchedFileName || null,
            finalImageUrl: brokenImagePath || null,
            renderedWith: '<img class="service-icon-img">',
            status: 'error',
            fallbackApplied: true
        });
        slot.innerHTML = renderServiceLogoFallbackOnly(serviceType, size);
        scheduleServiceIconCoverageSummary(0);
    }, { once: true });
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
    return new Date(value).toLocaleString();
}

function formatClockTime(value) {
    if (!value) return '—';
    const candidate = new Date(value);
    if (Number.isNaN(candidate.getTime())) return '—';
    return candidate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatStatus(status) {
    const normalized = String(status || '')
        .replace(/[_-]+/g, ' ')
        .toLowerCase();
    if (normalized === 'completed waiting user action') return 'OTP Ready';
    if (normalized === 'otp_received' || normalized === 'active') return 'OTP Ready';
    if (normalized === 'pending') return 'Waiting for OTP';
    if (normalized === 'manual_adjustment') return 'Manual Adjustment';
    return normalized
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getStatusTone(status) {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'approved' || normalized === 'completed') {
        return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200';
    }
    if (normalized === 'cancelled' || normalized === 'rejected') {
        return 'bg-rose-50 text-rose-700 ring-1 ring-rose-200';
    }
    if (normalized === 'active' || normalized === 'pending' || normalized === 'otp_received') {
        return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200';
    }
    return 'bg-slate-100 text-slate-600 ring-1 ring-slate-200';
}

function getCountryFlag(country) {
    if (isRemoteImageUrl(country?.flag)) {
        return getCountryFlagByName(country?.name);
    }
    return country?.flag || '🌐';
}

function getCountryFlagByName(name) {
    return COUNTRY_FLAG_FALLBACKS[String(name || '').trim().toLowerCase()] || '🌐';
}

function isRemoteImageUrl(value) {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function getCountryFlagImageUrl(country, size = 'w40') {
    if (!country) return '';
    if (isRemoteImageUrl(country?.flag)) return String(country.flag).trim();
    const directFlagCode = flagEmojiToCountryCode(country?.flag);
    if (directFlagCode) return getFlagImageUrlFromCode(directFlagCode, size);
    const imageCode = getCountryImageCode(country);
    return getFlagImageUrlFromCode(imageCode, size);
}

function renderCountryFlagMarkup(country, size = 'w40') {
    const imageUrl = getCountryFlagImageUrl(country, size);
    if (imageUrl) {
        return `<img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(country?.name || 'Country')} flag" loading="lazy" decoding="async" class="h-5 w-7 rounded-[4px] object-cover shadow-[0_0_0_1px_rgba(15,23,42,0.08)] sm:h-7 sm:w-10">`;
    }
    return `<span class="inline-flex items-center justify-center text-lg sm:text-2xl">${escapeHtml(getCountryFlag(country))}</span>`;
}

function normalizeCountryLookup(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[`’']/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function flagEmojiToCountryCode(value) {
    const codePoints = [...String(value || '').trim()]
        .map((char) => char.codePointAt(0))
        .filter((point) => point >= 0x1F1E6 && point <= 0x1F1FF);
    if (codePoints.length !== 2) return '';
    return String.fromCharCode(
        codePoints[0] - 0x1F1E6 + 65,
        codePoints[1] - 0x1F1E6 + 65
    ).toLowerCase();
}

function getCountryImageCodeLookup() {
    if (countryImageCodeLookup) return countryImageCodeLookup;
    const lookup = new Map();
    const regionDisplayNames = typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
        ? new Intl.DisplayNames(['en'], { type: 'region' })
        : null;

    if (regionDisplayNames) {
        for (let first = 65; first <= 90; first += 1) {
            for (let second = 65; second <= 90; second += 1) {
                const code = `${String.fromCharCode(first)}${String.fromCharCode(second)}`;
                const displayName = regionDisplayNames.of(code);
                if (!displayName || displayName === code) continue;
                const normalizedName = normalizeCountryLookup(displayName);
                if (normalizedName && !lookup.has(normalizedName)) {
                    lookup.set(normalizedName, code.toLowerCase());
                }
            }
        }
    }

    Object.entries(COUNTRY_FLAG_FALLBACKS).forEach(([name, flag]) => {
        const code = flagEmojiToCountryCode(flag);
        const normalizedName = normalizeCountryLookup(name);
        if (code && normalizedName && !lookup.has(normalizedName)) {
            lookup.set(normalizedName, code);
        }
    });

    Object.entries(COUNTRY_NAME_IMAGE_CODE_ALIASES).forEach(([name, code]) => {
        const normalizedName = normalizeCountryLookup(name);
        if (normalizedName) {
            lookup.set(normalizedName, code);
        }
    });

    countryImageCodeLookup = lookup;
    return lookup;
}

function getCountryImageCode(country) {
    if (!country) return '';
    if (typeof country === 'object') {
        const fromFlag = flagEmojiToCountryCode(country.flag);
        if (fromFlag) return fromFlag;
        return getCountryImageCode(country.name || '');
    }
    const normalizedName = normalizeCountryLookup(country);
    if (!normalizedName) return '';
    return getCountryImageCodeLookup().get(normalizedName) || '';
}

function getFlagImageUrlFromCode(code, size = 'w40') {
    const normalizedCode = String(code || '').trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(normalizedCode)) return '';
    return `https://flagcdn.com/${size}/${normalizedCode}.png`;
}

function getOrderCountryFlagImageUrl(order, size = 'w40') {
    if (isRemoteImageUrl(order?.flag)) return String(order.flag).trim();
    const directFlagCode = flagEmojiToCountryCode(order?.flag);
    if (directFlagCode) return getFlagImageUrlFromCode(directFlagCode, size);
    const orderCountryId = order?.country_id ?? order?.countryId;
    const fromCurrentCatalog = state.allCountries.find((country) => {
        return String(country.countryId) === String(orderCountryId)
            || String(country.name || '').toLowerCase() === String(order?.country || '').toLowerCase();
    });
    const fallbackFlagCode = flagEmojiToCountryCode(getCountryFlagByName(order?.country));
    const imageCode = getCountryImageCode(fromCurrentCatalog)
        || getCountryImageCode(order?.country)
        || fallbackFlagCode;
    return getFlagImageUrlFromCode(imageCode, size);
}

function getOrderCountryFlag(order) {
    if (order?.flag && !isRemoteImageUrl(order.flag)) return order.flag;
    const orderCountryId = order?.country_id ?? order?.countryId;
    const fromCurrentCatalog = state.allCountries.find((country) => {
        return String(country.countryId) === String(orderCountryId)
            || String(country.name || '').toLowerCase() === String(order?.country || '').toLowerCase();
    });
    if (fromCurrentCatalog?.flag) return fromCurrentCatalog.flag;
    return getCountryFlagByName(order?.country);
}

function renderStatusBadge(status) {
    return `<span class="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap ${getStatusTone(status)}">${escapeHtml(formatStatus(status))}</span>`;
}

function formatPaymentStatus(status) {
    const normalized = String(status || 'pending').toLowerCase();
    if (normalized === 'approved' || normalized === 'completed' || normalized === 'success' || normalized === 'succeeded') {
        return 'Success';
    }
    if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'rejected' || normalized === 'failed') {
        return 'Cancel';
    }
    if (normalized === 'pending' || normalized === 'processing') {
        return 'Pending';
    }
    return formatStatus(normalized);
}

function renderPaymentStatusBadge(status) {
    return `<span class="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap ${getStatusTone(status)}">${escapeHtml(formatPaymentStatus(status))}</span>`;
}

function getSmsOrderPrimaryStatus(order, lifecycleStatus) {
    if (order?.otp_code || lifecycleStatus === 'active') return 'SMS was received';
    if (lifecycleStatus === 'pending') return 'Waiting for SMS';
    if (lifecycleStatus === 'completed') return 'Activation finished';
    if (lifecycleStatus === 'cancelled') return 'Activation cancelled';
    if (lifecycleStatus === 'expired') return 'Activation expired';
    return formatStatus(lifecycleStatus || 'pending');
}

function getSmsOrderTimeStatus(order, lifecycleStatus) {
    if (lifecycleStatus === 'completed') return 'Closed';
    if (lifecycleStatus === 'cancelled') return 'Refunded';
    return getOrderExpiryText(order);
}

function renderTypeBadge(type) {
    const normalized = String(type || 'deposit').toLowerCase();
    const tone = normalized === 'deduction'
        ? 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'
        : 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200';
    return `<span class="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap ${tone}">${escapeHtml(formatStatus(normalized))}</span>`;
}

function getUploadUrl(fileName) {
    return fileName ? `/uploads/${encodeURIComponent(fileName)}` : '';
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
            <div class="text-lg font-semibold text-slate-900">${escapeHtml(title)}</div>
            <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-100 bg-white text-emerald-600">
                <i class="fa-solid fa-inbox text-lg"></i>
            </div>
            <p class="mt-2 text-sm leading-6 text-slate-500">${escapeHtml(description)}</p>
        </div>
    `;
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

function setLoading(button, text) {
    if (!button) return;
    button.dataset.original = button.innerHTML;
    button.innerHTML = `<span class="inline-flex items-center gap-2"><i class="fa-solid fa-spinner animate-spin"></i><span>${escapeHtml(text)}</span></span>`;
    button.disabled = true;
}

function resetLoading(button) {
    if (!button) return;
    if (button.dataset.original) {
        button.innerHTML = button.dataset.original;
    }
    button.disabled = false;
}

async function fetchJSON(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        credentials: 'include'
    });
    if (!response.ok) {
        throw new Error(await response.text());
    }
    return response.json();
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

function markOtpNotificationSent(orderId, otpCode) {
    const normalizedOrderId = orderId == null ? '' : String(orderId);
    const normalizedOtpCode = String(otpCode || '').trim() || 'received';
    const notificationKey = `${normalizedOrderId}:${normalizedOtpCode}`;
    if (state.otpNotificationKeys.has(notificationKey)) {
        return false;
    }
    state.otpNotificationKeys.add(notificationKey);
    return true;
}

function openModal(id) {
    const modal = qs(id);
    if (!modal) return;
    modal.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    syncBalanceBannerVisibility();
}

function clearPaymentFormError() {
    const errorBox = qs('payment-form-error');
    if (!errorBox) return;
    errorBox.textContent = '';
    errorBox.classList.remove('show');
}

function showPaymentFormError(message) {
    const errorBox = qs('payment-form-error');
    if (!errorBox) {
        showToast(message, 'error');
        return;
    }
    errorBox.textContent = message;
    errorBox.classList.add('show');
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

function getPaymentRequestReferenceLabel(request) {
    return getPaymentMethodMeta(request?.payment_method).key === 'binance'
        ? 'Binance Transaction ID'
        : 'Transaction ID';
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

function validatePaymentProofFile(file) {
    const fileName = String(file?.name || '').trim().toLowerCase();
    const extension = fileName.includes('.') ? fileName.split('.').pop() : '';
    return Boolean(extension) && PAYMENT_PROOF_ALLOWED_EXTENSIONS.has(extension);
}

function setActivePaymentMethod(method = 'easypaisa') {
    const methodMeta = getPaymentMethodMeta(method);
    const amountInput = qs('payment-amount-input');
    const transactionInput = qs('payment-transaction-id-input');
    const uploadTitle = qs('payment-upload-title');
    const guidance = qs('payment-method-guidance');
    const submitButton = qs('submit-payment-btn');
    const methodInput = qs('payment-method-input');
    if (methodInput) {
        methodInput.value = methodMeta.key;
    }
    qsa('[data-payment-method-tab]').forEach((button) => {
        const isActive = String(button.dataset.paymentMethodTab || '') === methodMeta.key;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    qsa('[data-payment-method-panel]').forEach((panel) => {
        const isActive = String(panel.dataset.paymentMethodPanel || '') === methodMeta.key;
        panel.classList.toggle('hidden', !isActive);
    });
    if (amountInput) {
        amountInput.placeholder = methodMeta.amountPlaceholder;
        amountInput.min = String(methodMeta.minAmount);
    }
    if (transactionInput) {
        transactionInput.placeholder = methodMeta.transactionPlaceholder;
        transactionInput.required = methodMeta.transactionRequired;
    }
    if (uploadTitle) {
        uploadTitle.textContent = methodMeta.uploadTitle;
    }
    if (guidance) {
        guidance.textContent = methodMeta.guidanceText;
        guidance.dir = methodMeta.guidanceDirection || 'ltr';
        guidance.style.textAlign = methodMeta.guidanceDirection === 'rtl' ? 'right' : 'left';
    }
    if (submitButton) {
        submitButton.textContent = methodMeta.submitLabel;
    }
    clearPaymentFormError();
}

function updatePaymentSuccessView(method, result = {}) {
    const methodMeta = getPaymentMethodMeta(method);
    const successView = qs('payment-success-view');
    const successTitle = qs('payment-success-title');
    if (successView) {
        successView.dir = methodMeta.guidanceDirection === 'rtl' ? 'rtl' : 'ltr';
    }
    if (successTitle) {
        successTitle.style.textAlign = methodMeta.guidanceDirection === 'rtl' ? 'right' : 'left';
        successTitle.textContent = result?.paymentLabel
            ? `${methodMeta.successTitle} (${result.paymentLabel})`
            : methodMeta.successTitle;
    }
}

function clearAuthFormError() {
    const errorBox = qs('auth-form-error');
    if (!errorBox) return;
    errorBox.textContent = '';
    errorBox.classList.add('hidden');
}

function showAuthFormError(message) {
    const errorBox = qs('auth-form-error');
    if (!errorBox) {
        showToast(message, 'error');
        return;
    }
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
    errorBox.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function showPaymentTopAlert() {
    qs('payment-top-alert')?.classList.remove('hidden');
    updateProcessingModalState();
}

function hidePaymentTopAlert() {
    qs('payment-top-alert')?.classList.add('hidden');
    updateProcessingModalState();
}

function syncBalanceBannerVisibility() {
    const banner = qs('balance-banner');
    if (!banner) return;
    const paymentModal = qs('payment-modal');
    banner.style.display = paymentModal && !paymentModal.classList.contains('hidden') ? 'none' : 'flex';
}

function syncGuestBrowsingState() {
    const isLoggedIn = Boolean(state.currentUser);
    qs('user-info')?.classList.remove('hidden');
    qs('guest-access-notice')?.classList.toggle('hidden', isLoggedIn);
    qs('member-history-section')?.classList.toggle('hidden', !isLoggedIn);
    qs('history-top-nav')?.classList.toggle('hidden', !isLoggedIn);
    if (!isLoggedIn) {
        qs('payment-history-section')?.classList.add('hidden');
        qs('admin-panel')?.classList.add('hidden');
        if (qs('user-balance')) {
            qs('user-balance').textContent = formatMoney(0);
        }
    }
    updateProcessingModalState();
}

function unlockBackgroundOtpSound() {
    if (backgroundOtpSoundUnlocked) return;
    backgroundOtpSoundUnlocked = true;
    try {
        backgroundOtpSound.currentTime = 0;
    } catch {
    }
    const unlockAttempt = backgroundOtpSound.play();
    if (unlockAttempt && typeof unlockAttempt.then === 'function') {
        unlockAttempt.then(() => {
            backgroundOtpSound.pause();
            try {
                backgroundOtpSound.currentTime = 0;
            } catch {
            }
        }).catch(() => {
        });
    }
}

function playBackgroundOtpSound() {
    try {
        backgroundOtpSound.pause();
        backgroundOtpSound.currentTime = 0;
        backgroundOtpSound.volume = 0.85;
    } catch {
    }
    if (otpSoundStopTimer) {
        window.clearTimeout(otpSoundStopTimer);
        otpSoundStopTimer = null;
    }
    backgroundOtpSound.play().catch(() => {});
    otpSoundStopTimer = window.setTimeout(() => {
        try {
            backgroundOtpSound.pause();
            backgroundOtpSound.currentTime = 0;
        } catch {
        }
        otpSoundStopTimer = null;
    }, 1000);
}

function resetPaymentModalState() {
    qs('addFundsForm')?.reset();
    qs('payment-form-view')?.classList.remove('hidden');
    qs('payment-success-view')?.classList.add('hidden');
    clearPaymentFormError();
    if (qs('payment-screenshot-name')) {
        qs('payment-screenshot-name').textContent = 'Payment screenshot upload کریں';
    }
    updatePaymentSuccessView('easypaisa');
    setActivePaymentMethod('easypaisa');
}

function openAuthModal(mode = 'login') {
    setAuthMode(mode === 'register' ? 'register' : 'login');
    hideAccountDetails();
    hideHeaderQuickMenu();
    clearAuthFormError();
    openModal('login-prompt');
}

function openPaymentModal() {
    if (!state.currentUser) {
        openAuthModal('login');
        return;
    }
    resetPaymentModalState();
    openModal('payment-modal');
}

function hasAcceptedTerms() {
    try {
        return window.localStorage.getItem(TERMS_ACCEPTED_STORAGE_KEY) === 'accepted';
    } catch {
        return false;
    }
}

function acceptTermsAndContinue() {
    try {
        window.localStorage.setItem(TERMS_ACCEPTED_STORAGE_KEY, 'accepted');
    } catch {
    }
    closeModal('terms-modal');
}

function closeModal(id) {
    if (id === 'terms-modal' && !hasAcceptedTerms()) return;
    const modal = qs(id);
    if (!modal) return;
    modal.classList.add('hidden');
    if (id === 'payment-modal') {
        resetPaymentModalState();
    }
    if (!document.querySelector('.app-modal:not(.hidden)')) {
        document.body.classList.remove('overflow-hidden');
    }
    syncBalanceBannerVisibility();
}

function updateSidebarVisibility(forceClose = false) {
    const sidebar = qs('sidebar');
    const overlay = qs('sidebar-overlay');
    if (!sidebar || !overlay) return;
    if (forceClose) {
        sidebar.classList.remove('open');
        overlay.classList.add('hidden');
        return;
    }
    sidebar.classList.toggle('open');
    overlay.classList.toggle('hidden');
}

function getThemeIconMarkup(theme) {
    if (theme === 'dark') {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2.5v2.5"></path><path d="M12 19v2.5"></path><path d="M4.93 4.93l1.77 1.77"></path><path d="M17.3 17.3l1.77 1.77"></path><path d="M2.5 12H5"></path><path d="M19 12h2.5"></path><path d="M4.93 19.07l1.77-1.77"></path><path d="M17.3 6.7l1.77-1.77"></path></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path></svg>';
}

function applyTheme(theme) {
    const normalized = 'light';
    state.theme = normalized;
    document.body.classList.remove('dark-mode');
    const themeToggleIcon = qs('theme-toggle-icon');
    const themeToggleButton = qs('theme-toggle');
    if (themeToggleIcon) {
        themeToggleIcon.innerHTML = getThemeIconMarkup(normalized);
    }
    if (themeToggleButton) {
        themeToggleButton.setAttribute('aria-label', 'Light theme enabled');
    }
    try {
        localStorage.setItem(THEME_STORAGE_KEY, normalized);
    } catch {
    }
}

function initializeTheme() {
    applyTheme('light');
}

function toggleTheme() {
    applyTheme('light');
}

function syncAccountShortcutButtons() {
    const isLoggedIn = Boolean(state.currentUser);
    qs('header-account-button')?.classList.toggle('hidden', !isLoggedIn);
    qs('header-menu-button')?.classList.toggle('hidden', !isLoggedIn);
    if (!isLoggedIn) {
        hideAccountDetails();
        hideHeaderQuickMenu();
    }
}

function openAccountDetails() {
    if (!state.currentUser) {
        openAuthModal('login');
        return;
    }
    const card = qs('account-details-card');
    if (!card) return;
    card.classList.remove('hidden');
    hideHeaderQuickMenu();
}

function hideAccountDetails() {
    qs('account-details-card')?.classList.add('hidden');
}

function toggleAccountMenu() {
    const card = qs('account-details-card');
    if (!card) return;
    if (card.classList.contains('hidden')) {
        openAccountDetails();
        return;
    }
    hideAccountDetails();
}

function showHeaderQuickMenu() {
    if (!state.currentUser) {
        openAuthModal('login');
        return;
    }
    qs('header-quick-menu')?.classList.remove('hidden');
    hideAccountDetails();
}

function hideHeaderQuickMenu() {
    qs('header-quick-menu')?.classList.add('hidden');
}

function toggleHeaderQuickMenu() {
    const menu = qs('header-quick-menu');
    if (!menu) return;
    if (menu.classList.contains('hidden')) {
        showHeaderQuickMenu();
        return;
    }
    hideHeaderQuickMenu();
}

function syncServiceButtons() {
    qsa('[data-service]').forEach((button) => {
        button.classList.toggle('active', button.dataset.service === state.currentService);
    });
}

function filterServiceButtons() {
    const query = String(qs('service-search')?.value || '').trim().toLowerCase();
    qsa('#service-grid [data-service]').forEach((button) => {
        const serviceType = String(button.dataset.service || '').toLowerCase();
        const meta = getServiceMeta(serviceType);
        const searchableText = [serviceType, meta.label, meta.shortLabel].join(' ').toLowerCase();
        const isMatch = !query || searchableText.includes(query);
        button.classList.toggle('hidden', !isMatch);
    });
}

function hydrateStaticServiceIcons() {
    disconnectServiceIconObserver();
    const observer = createServiceIconObserver();
    qsa('[data-service-icon]').forEach((slot) => {
        const serviceType = slot.dataset.serviceIcon;
        const logoSize = slot.dataset.logoSize || 'md';
        const resolvedIcon = resolveServiceIconMatch(serviceType);
        slot.dataset.iconRendered = 'false';
        if (!resolvedIcon.finalImageUrl) {
            slot.innerHTML = renderServiceLogoFallbackOnly(serviceType, logoSize);
            return;
        }
        slot.innerHTML = '';
        if (observer && !isServiceIconSlotVisible(slot)) {
            observer.observe(slot);
            return;
        }
        renderVisibleServiceIconSlot(slot);
    });
}

function setAdminTab(tab) {
    state.currentAdminTab = tab;
    qsa('[data-admin-tab]').forEach((button) => {
        button.classList.toggle('active', button.dataset.adminTab === tab);
    });
    qsa('[data-admin-panel]').forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.adminPanel !== tab);
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

function updateHero() {
    const meta = getServiceMeta(state.currentService);
    qs('hero-title').textContent = meta.catalogTitle || `Available ${meta.label} Numbers`;
    qs('hero-description').textContent = meta.description;
    qs('hero-service-icon').innerHTML = renderServiceLogo(state.currentService, 'xl');
    if (qs('service-selection-caption')) {
        qs('service-selection-caption').textContent = `Choose ${meta.label} to load available numbers.`;
    }
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
    return 'pending';
}

function isWaitingOrder(order) {
    return getOrderLifecycleStatus(order) === 'pending';
}

function isWaitingViewOrder(order) {
    const lifecycle = getOrderLifecycleStatus(order);
    const rawStatus = String(order?.order_status || order?.status || '').toLowerCase();
    if (['completed', 'cancelled', 'expired'].includes(lifecycle)) return false;
    if (['completed', 'cancelled', 'expired_refunded', 'expired'].includes(rawStatus)) return false;
    return lifecycle === 'pending' || lifecycle === 'active';
}

function isValidActiveDashboardOrder(order) {
    return Boolean(order)
        && !isCancelledOrderHidden(order)
        && !isFinalOrderLifecycle(order)
        && !isAutoExpirableDashboardOrder(order)
        && isWaitingViewOrder(order);
}

function isPaidOrder(order) {
    return getOrderLifecycleStatus(order) === 'completed';
}

function isCancelledOrder(order) {
    return ['cancelled', 'expired'].includes(getOrderLifecycleStatus(order));
}

function getOrderFromState(orderId) {
    return state.orders.find((order) => String(order.id) === String(orderId)) || null;
}

function normalizeDashboardOrderId(orderOrId) {
    if (orderOrId == null) return '';
    if (typeof orderOrId === 'object') {
        return orderOrId.id == null ? '' : String(orderOrId.id).trim();
    }
    return String(orderOrId).trim();
}

function isCancelledOrderHidden(orderOrId) {
    const normalizedOrderId = normalizeDashboardOrderId(orderOrId);
    return Boolean(normalizedOrderId) && state.hiddenCancelledOrderIds.has(normalizedOrderId);
}

function filterHiddenCancelledOrders(orders) {
    return (Array.isArray(orders) ? orders : []).filter((order) => !isCancelledOrderHidden(order));
}

function suppressCancelledOrderInDashboard(orderId) {
    const normalizedOrderId = normalizeDashboardOrderId(orderId);
    if (!normalizedOrderId) return;
    state.hiddenCancelledOrderIds.add(normalizedOrderId);
    state.otpBlockedOrderIds.add(normalizedOrderId);
    state.cancelPendingOrderIds.delete(normalizedOrderId);
    state.orders = filterHiddenCancelledOrders(state.orders);
    state.completedOrders = filterHiddenCancelledOrders(state.completedOrders);
}

function setElementHtmlIfChanged(target, markup) {
    const element = typeof target === 'string' ? qs(target) : target;
    if (!element) return false;
    if (element.innerHTML === markup) return false;
    element.innerHTML = markup;
    return true;
}

function setAdminSectionRefreshing(indicatorId, refreshing) {
    const indicator = qs(indicatorId);
    if (!indicator) return;
    indicator.classList.toggle('is-refreshing', Boolean(refreshing));
    indicator.setAttribute('aria-busy', refreshing ? 'true' : 'false');
}

function isAutoExpirableDashboardOrder(order) {
    const expiry = order?.expires_at ? new Date(order.expires_at) : null;
    return Boolean(order)
        && getOrderLifecycleStatus(order) === 'pending'
        && !hasOrderOtp(order)
        && !order?.sms_received
        && expiry instanceof Date
        && !Number.isNaN(expiry.getTime())
        && new Date() >= expiry;
}

async function finalizeExpiredOrderDashboardState(orderId, message, options = {}) {
    const shouldUpdateModal = options.updateModal ?? Boolean(state.activeOrder && String(state.activeOrder.id) === String(orderId));
    const refunded = options.refunded !== false;
    suppressCancelledOrderInDashboard(orderId);
    state.expiredOrderRetryAt.delete(normalizeDashboardOrderId(orderId));
    if (shouldUpdateModal && state.activeOrder && String(state.activeOrder.id) === String(orderId)) {
        closeOrderModal();
    } else {
        renderActiveOrders(state.orders);
    }
    await loadNumberHistory();
    setHistoryView(state.historyView);
    if (refunded) {
        await refreshWalletBalanceSilently({ showIncreaseToast: false });
    }
    showToast(message, refunded ? 'success' : 'info', 6000);
}

async function queueDashboardOrderExpiry(order) {
    const normalizedOrderId = normalizeDashboardOrderId(order);
    if (!normalizedOrderId || !isAutoExpirableDashboardOrder(order)) return false;
    if (state.expiringOrderIds.has(normalizedOrderId)) return false;
    const nextRetryAt = Number(state.expiredOrderRetryAt.get(normalizedOrderId) || 0);
    if (nextRetryAt > Date.now()) return false;
    state.expiringOrderIds.add(normalizedOrderId);
    try {
        const expired = await requestOrderExpiry(order.id, {
            updateModal: Boolean(state.activeOrder && String(state.activeOrder.id) === String(order.id))
        });
        if (!expired) {
            state.expiredOrderRetryAt.set(normalizedOrderId, Date.now() + 8000);
        }
        return expired;
    } finally {
        state.expiringOrderIds.delete(normalizedOrderId);
    }
}

async function processExpiredDashboardOrders() {
    if (!state.currentUser || state.expireRequestInFlight) return;
    const expiredOrders = (state.orders || []).filter((order) => isAutoExpirableDashboardOrder(order) && !isOrderOtpFlowBlocked(order));
    for (const order of expiredOrders) {
        await queueDashboardOrderExpiry(order);
    }
}

function syncAdminPendingPaymentAlerts(totalPendingCount) {
    if (totalPendingCount > 0) {
        if (totalPendingCount > state.lastPendingCount) {
            startAdminAlertLoop();
            showToast(`New payment request received. Pending approvals: ${totalPendingCount}`, 'success', 30000, {
                dismissLabel: 'Mute',
                onDismiss: stopAdminAlertLoop
            });
            browserNotify('MRF SMS Admin Alert', `New payment request received. Pending approvals: ${totalPendingCount}`);
        }
    }
    if (totalPendingCount === 0 || totalPendingCount < state.lastPendingCount) {
        stopAdminAlertLoop();
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

function formatCountdown(targetValue, expiredLabel = 'Expired') {
    const target = targetValue ? new Date(targetValue) : null;
    if (!target || Number.isNaN(target.getTime())) return expiredLabel;
    const diff = Math.max(0, target - new Date());
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return diff <= 0 ? expiredLabel : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function getOrderExpiryText(order) {
    return formatCountdown(order?.expires_at, 'Expired');
}

function getCancelUnlockText(order) {
    return formatCountdown(order?.cancel_available_at, '0:00');
}

function isCancelAvailable(order) {
    if (!order?.cancel_available_at) return true;
    return new Date() >= new Date(order.cancel_available_at);
}

function hasOrderOtp(order) {
    return Boolean(String(order?.otp_code || '').trim() || order?.otp_received);
}

function isFinanciallySuccessfulAdminOrder(order) {
    return getOrderLifecycleStatus(order) === 'completed'
        || Boolean(order?.sms_received)
        || hasOrderOtp(order);
}

function getOrderRawStatus(order) {
    return String(order?.status || order?.order_status || '').trim().toLowerCase();
}

function isFinalOrderLifecycle(order) {
    const lifecycleStatus = getOrderLifecycleStatus(order);
    const rawStatus = getOrderRawStatus(order);
    return ['completed', 'cancelled', 'expired'].includes(lifecycleStatus)
        || ['expired_refunded', 'refunded'].includes(rawStatus);
}

function hasOrderSmsLock(order) {
    const providerStatus = String(order?.provider_last_status || '').trim().toUpperCase();
    return Boolean(order?.sms_received || (providerStatus && providerStatus !== ORDER_PROVIDER_WAITING_STATUS));
}

function isOrderCancelPending(orderOrId) {
    const normalizedOrderId = normalizeDashboardOrderId(orderOrId);
    return Boolean(normalizedOrderId) && state.cancelPendingOrderIds.has(normalizedOrderId);
}

function isOrderOtpFlowBlocked(orderOrId) {
    const normalizedOrderId = normalizeDashboardOrderId(orderOrId);
    return Boolean(normalizedOrderId) && (
        state.otpBlockedOrderIds.has(normalizedOrderId)
        || state.hiddenCancelledOrderIds.has(normalizedOrderId)
    );
}

function canShowOrderOtp(order) {
    return !isFinalOrderLifecycle(order)
        && !isOrderOtpFlowBlocked(order)
        && getOrderLifecycleStatus(order) === 'active'
        && hasOrderOtp(order);
}

function canCancelOrder(order) {
    return Boolean(order)
        && getOrderLifecycleStatus(order) === 'pending'
        && !hasOrderOtp(order)
        && !hasOrderSmsLock(order)
        && !isOrderCancelPending(order)
        && !isOrderOtpFlowBlocked(order)
        && isCancelAvailable(order);
}

function getOrderCancelLockMessage(order) {
    if (isOrderCancelPending(order)) return 'Cancel request in progress';
    if (isOrderOtpFlowBlocked(order) || isFinalOrderLifecycle(order)) return 'Order is no longer active';
    if (hasOrderOtp(order)) return 'OTP already received';
    if (hasOrderSmsLock(order)) return 'Cancel disabled after SMS/provider activity';
    return `Cancel available in ${getCancelUnlockText(order)}`;
}

function setOrderOtpFlowBlocked(orderOrId, blocked = true) {
    const normalizedOrderId = normalizeDashboardOrderId(orderOrId);
    if (!normalizedOrderId) return;
    if (blocked) {
        state.otpBlockedOrderIds.add(normalizedOrderId);
        return;
    }
    state.otpBlockedOrderIds.delete(normalizedOrderId);
}

function setOrderCancelPending(orderOrId, pending = true) {
    const normalizedOrderId = normalizeDashboardOrderId(orderOrId);
    if (!normalizedOrderId) return;
    if (pending) {
        state.cancelPendingOrderIds.add(normalizedOrderId);
        return;
    }
    state.cancelPendingOrderIds.delete(normalizedOrderId);
}

function refreshOrderHotfixViews(orderOrId) {
    const normalizedOrderId = normalizeDashboardOrderId(orderOrId);
    renderActiveOrders(state.orders);
    if (state.activeOrder && normalizedOrderId && String(state.activeOrder.id) === normalizedOrderId) {
        updateOrderVisual(state.activeOrder);
    }
}

function sortOrdersByMostRecent(orders) {
    const list = Array.isArray(orders) ? [...orders] : [];
    return list.sort((left, right) => {
        const leftValue = new Date(left?.completed_at || left?.created_at || 0).getTime();
        const rightValue = new Date(right?.completed_at || right?.created_at || 0).getTime();
        const leftTime = Number.isFinite(leftValue) ? leftValue : 0;
        const rightTime = Number.isFinite(rightValue) ? rightValue : 0;
        return rightTime - leftTime;
    });
}

function getActiveOrdersFromState() {
    return sortOrdersByMostRecent((state.orders || []).filter((order) => isValidActiveDashboardOrder(order)));
}

function getCompletedOrdersFromState() {
    return sortOrdersByMostRecent((state.completedOrders || []).filter((order) => getOrderLifecycleStatus(order) === 'completed'));
}

function getVisibleActiveOrdersForCurrentFilter() {
    const activeOrders = getActiveOrdersFromState();
    if (state.activationFilter === 'paid' || state.activationFilter === 'cancelled') {
        return [];
    }
    return activeOrders;
}

function getVisibleCompletedOrdersForCurrentFilter() {
    if (state.activationFilter === 'waiting' || state.activationFilter === 'cancelled') {
        return [];
    }
    return getCompletedOrdersFromState();
}

function getNumberHistoryTimestamp(entry) {
    return entry?.last_event_at || entry?.updated_at || entry?.final_status_at || entry?.completed_at || entry?.otp_received_at || entry?.purchased_at || entry?.created_at || '';
}

function sortNumberHistoryEntries(entries) {
    const list = Array.isArray(entries) ? [...entries] : [];
    return list.sort((left, right) => {
        const leftValue = new Date(getNumberHistoryTimestamp(left) || 0).getTime();
        const rightValue = new Date(getNumberHistoryTimestamp(right) || 0).getTime();
        const leftTime = Number.isFinite(leftValue) ? leftValue : 0;
        const rightTime = Number.isFinite(rightValue) ? rightValue : 0;
        return rightTime - leftTime;
    });
}

function syncNumberHistoryAction(history = state.numberHistory) {
    const action = qs('header-number-history-action');
    if (!action) return;
    const count = Array.isArray(history) ? history.length : 0;
    action.textContent = 'All Number History';
    action.dataset.meta = count ? `${count} saved entr${count === 1 ? 'y' : 'ies'}` : 'Saved numbers and OTP codes';
    action.title = count ? `${count} saved number history entr${count === 1 ? 'y' : 'ies'}` : 'All Number History';
}

function renderNumberHistory(entries = state.numberHistory) {
    const container = qs('number-history-list');
    if (!container) return;
    const allEntries = sortNumberHistoryEntries(Array.isArray(entries) ? entries : []);
    syncNumberHistoryAction(allEntries);
    if (!allEntries.length) {
        container.innerHTML = renderEmptyState('No number history yet', 'Every purchased number, OTP code, and final status will be saved here automatically.');
        return;
    }
    const search = String(state.numberHistorySearch || '').trim().toLowerCase();
    const filteredEntries = !search
        ? allEntries
        : allEntries.filter((entry) => {
            const serviceKey = String(entry?.service_type || '').trim().toLowerCase();
            const serviceMeta = getServiceMeta(serviceKey || entry?.service_name || 'service');
            const serviceLabel = String(entry?.service_name || '').trim() || serviceMeta.label;
            const status = String(entry?.status || entry?.order_status || 'pending').trim().toLowerCase();
            const haystack = [
                serviceLabel,
                serviceKey,
                entry?.country,
                entry?.phone_number,
                entry?.otp_code,
                status
            ].join(' ').toLowerCase();
            return haystack.includes(search);
        });
    if (!filteredEntries.length) {
        container.innerHTML = renderEmptyState('No matching number history', 'Try searching with service name, country, number, code, or status.');
        return;
    }
    container.innerHTML = filteredEntries.map((entry) => {
        const serviceKey = String(entry?.service_type || '').trim().toLowerCase();
        const serviceMeta = getServiceMeta(serviceKey || entry?.service_name || 'service');
        const serviceLabel = String(entry?.service_name || '').trim() || serviceMeta.label;
        const countryLabel = String(entry?.country || 'Unknown country').trim() || 'Unknown country';
        const status = String(entry?.status || entry?.order_status || 'pending').trim().toLowerCase() || 'pending';
        const historyDate = getNumberHistoryTimestamp(entry);
        const subtitleParts = [countryLabel];
        if (Number(entry?.price || 0) > 0) {
            subtitleParts.push(formatMoneyPrecise(entry.price));
        }
        return `
            <article class="number-history-card">
                <div class="number-history-card-header">
                    <div class="number-history-card-service">
                        <span>${renderServiceLogo(serviceKey || serviceLabel, 'md')}</span>
                        <div class="min-w-0">
                            <div class="number-history-card-service-name">${escapeHtml(serviceLabel)}</div>
                            <div class="number-history-card-service-subtitle">${escapeHtml(subtitleParts.join(' • '))}</div>
                        </div>
                    </div>
                    ${renderStatusBadge(status)}
                </div>
                <div class="number-history-card-grid">
                    <div class="number-history-card-field">
                        <span>Country</span>
                        <strong>${escapeHtml(countryLabel)}</strong>
                    </div>
                    <div class="number-history-card-field">
                        <span>Number</span>
                        <strong>${escapeHtml(entry?.phone_number || 'Not available')}</strong>
                    </div>
                    <div class="number-history-card-field number-history-card-code">
                        <span>Code</span>
                        <strong>${escapeHtml(entry?.otp_code || 'Not received yet')}</strong>
                    </div>
                    <div class="number-history-card-field">
                        <span>Date / Time</span>
                        <strong>${escapeHtml(formatRelativeTime(historyDate))}</strong>
                    </div>
                </div>
            </article>
        `;
    }).join('');
}

function updateActivationSummaryLine() {
    const summaryLine = qs('activation-summary-line');
    const activeOrders = getActiveOrdersFromState();
    const completedOrders = getCompletedOrdersFromState();
    const activeAmount = activeOrders.reduce((sum, order) => sum + Number(order.price || 0), 0);
    const completedAmount = completedOrders.reduce((sum, order) => sum + Number(order.price || 0), 0);
    const phoneHistoryAction = qs('header-phone-history-action');
    if (phoneHistoryAction) {
        phoneHistoryAction.textContent = 'Waiting for numbers';
        phoneHistoryAction.title = `${activeOrders.length} active order${activeOrders.length === 1 ? '' : 's'} and ${completedOrders.length} completed order${completedOrders.length === 1 ? '' : 's'}`;
    }
    if (!summaryLine) return;
    summaryLine.textContent = `Active orders ${activeOrders.length} pcs / Value ${formatMoneyPrecise(activeAmount)} / Completed ${completedOrders.length} pcs / Value ${formatMoneyPrecise(completedAmount)}`;
}

function syncWaitingOrdersVisibility() {
    const ordersList = qs('active-orders-list');
    const completedSection = qs('completed-orders-section');
    const summaryLine = qs('activation-summary-line');
    if (!ordersList) return;
    if (summaryLine) {
        summaryLine.classList.remove('activation-summary-toggle');
        summaryLine.removeAttribute('aria-disabled');
        summaryLine.removeAttribute('aria-expanded');
        summaryLine.tabIndex = -1;
    }
    const shouldShowActivations = state.historyView === 'activations' && Boolean(state.currentUser);
    ordersList.classList.toggle('hidden', !shouldShowActivations);
    completedSection?.classList.add('hidden');
}

function setActivationFilter(filter) {
    const nextFilter = ['waiting', 'paid', 'cancelled', 'all'].includes(filter) ? filter : 'waiting';
    if (nextFilter === 'waiting' && state.activationFilter !== 'waiting') {
        state.waitingOrdersExpanded = false;
    }
    state.activationFilter = nextFilter;
    qsa('[data-history-filter]').forEach((button) => {
        button.classList.toggle('active', button.dataset.historyFilter === state.activationFilter);
    });
    updateActivationSummaryLine();
    syncWaitingOrdersVisibility();
    if (state.historyView === 'activations') {
        renderActiveOrders(state.orders);
    }
}

function setHistoryView(view, options = {}) {
    const normalizedView = view === 'payments' ? 'payments' : view === 'numbers' ? 'numbers' : 'activations';
    state.historyView = normalizedView;
    const isLoggedIn = Boolean(state.currentUser);
    const title = qs('history-section-title');
    const titleCopy = qs('history-section-copy');
    const filterBar = qs('activation-filter-bar');
    const summaryLine = qs('activation-summary-line');
    const processingWrap = qs('processing-orders-wrap');
    const ordersList = qs('active-orders-list');
    const completedSection = qs('completed-orders-section');
    const numberHistorySection = qs('number-history-section');
    const paymentSection = qs('payment-history-section');
    if (title) {
        title.textContent = normalizedView === 'payments'
            ? 'Payment Details'
            : normalizedView === 'numbers'
                ? 'All Number History'
                : 'Waiting for numbers';
    }
    if (titleCopy) {
        titleCopy.textContent = normalizedView === 'payments'
            ? 'View pending, success, and cancel payment requests from your account.'
            : normalizedView === 'numbers'
                ? 'Permanent record of every purchased number, OTP code, and final status. Newest entries appear first.'
                : 'Purchased numbers waiting for OTP appear here instantly. Use All Number History to view every saved number and OTP later.';
    }
    filterBar?.classList.toggle('hidden', !isLoggedIn);
    summaryLine?.classList.add('hidden');
    processingWrap?.classList.toggle('hidden', normalizedView !== 'activations' || !isLoggedIn || !state.purchaseRequests.size);
    ordersList?.classList.toggle('hidden', normalizedView !== 'activations' || !isLoggedIn);
    completedSection?.classList.add('hidden');
    numberHistorySection?.classList.toggle('hidden', normalizedView !== 'numbers' || !isLoggedIn);
    paymentSection?.classList.toggle('hidden', normalizedView !== 'payments' || !isLoggedIn);
    qs('header-phone-history-action')?.classList.toggle('active', normalizedView === 'activations');
    qs('header-number-history-action')?.classList.toggle('active', normalizedView === 'numbers');
    if (normalizedView === 'payments' && isLoggedIn) {
        renderPaymentHistoryCards(state.paymentRequests);
    } else if (normalizedView === 'numbers' && isLoggedIn) {
        renderNumberHistory(state.numberHistory);
    } else if (isLoggedIn) {
        renderActiveOrders(state.orders);
    }
    syncWaitingOrdersVisibility();
    updateProcessingModalState();
    if (options.scroll) {
        const scrollTarget = normalizedView === 'payments'
            ? paymentSection
            : normalizedView === 'numbers'
                ? numberHistorySection
            : title?.closest('section');
        scrollTarget?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function getCountryStatusMeta(country) {
    const label = String(country?.statusLabel || '').trim();
    if (!label) return null;
    const rawTone = String(country?.statusColor || '').trim().toLowerCase();
    const tone = ['green', 'yellow', 'red', 'blue'].includes(rawTone) ? rawTone : 'blue';
    return {
        label,
        tone
    };
}

function renderCountryStatusBadge(country) {
    const statusMeta = getCountryStatusMeta(country);
    if (!statusMeta) return '';
    return `
        <span class="country-status-badge country-status-badge--${escapeAttr(statusMeta.tone)}">
            <span class="country-status-badge-dot" aria-hidden="true"></span>
            <span>${escapeHtml(statusMeta.label)}</span>
        </span>
    `;
}

function sortCountriesForDisplay(countries) {
    const list = Array.isArray(countries) ? [...countries] : [];
    return list.sort((left, right) => {
        const leftCatalogOrder = Number(left?.catalogOrder ?? Number.MAX_SAFE_INTEGER);
        const rightCatalogOrder = Number(right?.catalogOrder ?? Number.MAX_SAFE_INTEGER);
        return leftCatalogOrder - rightCatalogOrder;
    });
}

function renderTierRankBadge(rank) {
    const tone = rank === 'Gold'
        ? 'background:linear-gradient(135deg,#fde68a,#f59e0b);color:#7c2d12;'
        : rank === 'Silver'
            ? 'background:linear-gradient(135deg,#e2e8f0,#94a3b8);color:#1e293b;'
            : 'background:linear-gradient(135deg,#fdba74,#c2410c);color:#fff;';
    return `<span style="display:inline-flex;align-items:center;border-radius:999px;padding:.18rem .55rem;font-size:10px;font-weight:800;${tone}">${escapeHtml(rank)}</span>`;
}

function renderTierPanelMarkup(countryId, countryName, tiersState) {
    if (tiersState === 'loading') {
        return `<div style="padding:.9rem 1rem;font-size:12px;color:#15803d;">Loading series...</div>`;
    }
    if (!Array.isArray(tiersState) || !tiersState.length) {
        return `<div style="padding:.9rem 1rem;font-size:12px;color:#64748b;">No custom series configured for this country yet.</div>`;
    }
    return tiersState.map((tier) => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:.6rem;padding:.65rem 1rem;border-top:1px solid #d1fae5;">
            <div style="display:flex;align-items:center;gap:.5rem;min-width:0;">
                ${renderTierRankBadge(tier.rank)}
                <div style="font-size:12px;color:#334155;">
                    <div style="font-weight:700;">Tier ${escapeHtml(tier.tierNumber)}</div>
                    <div style="color:#64748b;">id ${escapeHtml(tier.providerId)}${tier.count != null ? ' • ' + escapeHtml(tier.count) + ' pcs' : ''}</div>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:.6rem;">
                <div style="font-weight:800;font-size:13px;color:#0f172a;white-space:nowrap;">${formatMoney(tier.price)}</div>
                <button class="country-buy-button" style="padding:.5rem .8rem;" data-action="buy-tier" data-country-name="${escapeAttr(countryName)}" data-country-id="${escapeAttr(countryId)}" data-tier-number="${escapeAttr(tier.tierNumber)}" data-provider-id="${escapeAttr(tier.providerId)}">Buy</button>
            </div>
        </div>
    `).join('');
}

async function toggleTierPanel(countryId, countryName) {
    const key = String(countryId);
    if (state.expandedTierCountryId === key) {
        state.expandedTierCountryId = null;
        renderCountries();
        return;
    }
    state.expandedTierCountryId = key;
    const cached = state.tierCache.get(key);
    const hasUsableCache = Array.isArray(cached) && cached.length > 0;
    if (!hasUsableCache) {
        state.tierCache.set(key, 'loading');
        renderCountries();
        try {
            const data = await fetchJSON(`/api/tiers/${encodeURIComponent(state.currentService)}/${encodeURIComponent(countryId)}`);
            state.tierCache.set(key, Array.isArray(data?.tiers) ? data.tiers : []);
        } catch {
            state.tierCache.set(key, []);
        }
    }
    renderCountries();
}

function renderCountries() {
    const container = qs('country-list');
    const search = qs('country-search')?.value.trim().toLowerCase() || '';
    const currentMeta = getServiceMeta(state.currentService);
    const canOrder = canOrderCurrentService();
    let filtered = [...state.allCountries];
    if (search) {
        filtered = filtered.filter((country) => country.name.toLowerCase().includes(search));
    }
    if (state.currentFilter === 'cheap') {
        filtered = filtered.filter((country) => Number(country.price) <= 250);
    } else if (state.currentFilter === 'premium') {
        filtered = filtered.filter((country) => Number(country.price) >= 300);
    }
    filtered = sortCountriesForDisplay(filtered);
    if (!filtered.length) {
        const title = 'No countries found';
        const message = state.allCountries.length
            ? 'Try a different country name.'
            : `No countries are configured for ${currentMeta.label} yet.`;
        container.innerHTML = renderEmptyState(title, message);
        updateHero();
        return;
    }
    container.innerHTML = `
        <div class="overflow-hidden rounded-[24px] border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-emerald-100 shadow-[0_20px_45px_rgba(22,163,74,0.08)]">
            <div class="country-table-head border-b border-emerald-200 bg-gradient-to-r from-emerald-600 via-emerald-500 to-green-500 text-white">
                <div>Flag</div>
                <div>Country</div>
                <div class="text-right">Price</div>
                <div class="text-right">Action</div>
            </div>
            ${filtered.map((country, index) => {
                const isExpanded = state.expandedTierCountryId === String(country.countryId);
                return `
                <div class="country-table-row"${index === 0 ? ' style="border-top:none;"' : ''}>
                    <div class="flex items-center justify-center">${renderCountryFlagMarkup(country)}</div>
                    <div class="min-w-0">
                        ${renderCountryStatusBadge(country)}
                        <div class="truncate text-sm font-semibold text-slate-900">${escapeHtml(country.name)}</div>
                        <div class="mt-1 truncate text-xs text-emerald-700/80">${escapeHtml(country.code || 'N/A')}</div>
                    </div>
                 <div class="text-right text-sm font-bold text-slate-900 whitespace-nowrap" style="${state.currentService === 'whatsapp' ? 'padding-right:2.5rem;' : ''}">${formatMoney(country.price)}</div>
                    <div class="flex justify-end items-center gap-1.5">
                        <button class="country-buy-button" ${canOrder ? `data-action="buy-country" data-country-name="${escapeAttr(country.name)}" data-country-id="${escapeAttr(country.countryId)}"` : 'disabled aria-disabled="true"'}>${canOrder ? 'Buy Number' : 'Coming Soon'}</button>
                        ${canOrder ? `<button data-action="toggle-tiers" data-country-name="${escapeAttr(country.name)}" data-country-id="${escapeAttr(country.countryId)}" title="Show series options" style="border:1px solid #bbf7d0;background:#ffffff;border-radius:.6rem;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;color:#15803d;font-size:11px;transform:${isExpanded ? 'rotate(180deg)' : 'none'};transition:transform .15s;">▼</button>` : ''}
                    </div>
                </div>
                ${isExpanded ? `<div style="background:#f8fffb;">${renderTierPanelMarkup(country.countryId, country.name, state.tierCache.get(String(country.countryId)))}</div>` : ''}
            `;
            }).join('')}
        </div>
    `;
    updateHero();
}

async function loadCountries() {
    try {
        const endpoint = state.currentService === 'whatsapp'
            ? '/api/countries'
            : `/api/services/${encodeURIComponent(state.currentService)}/countries`;
        const countries = await fetchJSON(endpoint);
        state.allCountries = applyFallbackIfEmpty(Array.isArray(countries) ? countries : []).map((country, index) => ({
            ...country,
            catalogOrder: index
        }));
        renderCountries();
    } catch (err) {
        state.allCountries = [];
        renderCountries();
        showToast(err.message || 'Failed to load countries', 'error');
    }
}

function renderOrderButtons(order) {
    const container = qs('order-buttons');
    if (!container) return;
    const lifecycleStatus = getOrderLifecycleStatus(order);
    const isOtpReady = canShowOrderOtp(order);
    if (isOtpReady) {
        container.innerHTML = `
            <button class="rounded-xl bg-emerald-500 px-3 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400" data-action="complete-order" data-order-id="${escapeAttr(order.id)}">Complete</button>
        `;
        return;
    }
    if (lifecycleStatus !== 'pending') {
        container.innerHTML = `
            <button class="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50" data-action="close-order-inline">Close</button>
        `;
        return;
    }
    const cancelEnabled = canCancelOrder(order);
    const cancelLockMessage = getOrderCancelLockMessage(order);
    const tierMeta = state.orderTierMeta.get(String(order.id));
    const tierRetryButton = (tierMeta && tierMeta.nextTierNumber && cancelEnabled)
        ? `<button class="rounded-xl border border-emerald-500 bg-emerald-500 text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 hover:border-emerald-400 px-3 py-2.5 text-sm font-semibold transition" data-action="retry-next-tier" data-order-id="${escapeAttr(order.id)}">OTP nahi aayi? Tier ${escapeAttr(tierMeta.nextTierNumber)} try karein</button>`
        : '';
    container.innerHTML = `
        ${tierRetryButton}
        <button class="rounded-xl ${cancelEnabled ? 'border border-orange-500 bg-orange-500 text-white shadow-lg shadow-orange-500/20 hover:bg-orange-400 hover:border-orange-400' : 'border border-slate-200 bg-white text-slate-900 hover:bg-slate-50 disabled:opacity-100'} px-3 py-2.5 text-sm font-semibold transition" data-action="cancel-order" title="${escapeAttr(cancelEnabled ? 'Cancel and refund this order' : cancelLockMessage)}" ${cancelEnabled ? '' : 'disabled'}>Cancel and Refund</button>
    `;
}

function updateTimerDisplay(order) {
    const now = new Date();
    const expiry = new Date(order.expires_at || new Date(new Date(order.created_at).getTime() + 25 * 60 * 1000));
    const cancelAt = new Date(order.cancel_available_at || new Date(new Date(order.created_at).getTime() + 17 * 1000));
    const expiryDiff = Math.max(0, expiry - now);
    const cancelDiff = Math.max(0, cancelAt - now);
    const expiryMins = Math.floor(expiryDiff / 60000);
    const expirySecs = Math.floor((expiryDiff % 60000) / 1000);
    const cancelMins = Math.floor(cancelDiff / 60000);
    const cancelSecs = Math.floor((cancelDiff % 60000) / 1000);
    qs('order-timer').textContent = expiryDiff <= 0 ? 'Expired' : `${expiryMins}:${String(expirySecs).padStart(2, '0')}`;
    qs('order-cancel-timer').textContent = cancelDiff <= 0 ? '0:00' : `${cancelMins}:${String(cancelSecs).padStart(2, '0')}`;
}

function updateOrderVisual(order) {
    const meta = getServiceMeta(order.service_type);
    const lifecycleStatus = getOrderLifecycleStatus(order);
    const isOtpReady = canShowOrderOtp(order);
    const cancelPending = isOrderCancelPending(order);
    const countryFlag = getOrderCountryFlag(order);
    qs('order-country-title').textContent = `${meta.label} ${countryFlag}`;
    qs('order-service-logo').innerHTML = renderServiceLogo(order.service_type, 'lg');
    qs('order-status-pill').className = `inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${getStatusTone(lifecycleStatus)}`;
    qs('order-status-pill').textContent = formatStatus(lifecycleStatus || 'active');
    qs('order-price-pill').textContent = formatMoney(order.price);
    qs('order-created-pill').textContent = `${order.country || 'Unknown country'} • ${formatRelativeTime(order.created_at)}`;
    qs('order-number').textContent = order.phone_number || 'Processing...';
    const checkOtpButton = qs('check-otp-btn');
    if (isOtpReady) {
        qs('order-otp').classList.remove('hidden');
        qs('order-waiting').classList.add('hidden');
        qs('order-expired-info').classList.add('hidden');
        qs('otp-value').textContent = order.otp_code || '------';
        checkOtpButton.classList.add('hidden');
    } else {
        qs('order-otp').classList.add('hidden');
        if (isWaitingOrder(order) && !isFinalOrderLifecycle(order)) {
            qs('order-waiting').classList.remove('hidden');
            qs('order-expired-info').classList.add('hidden');
            if (cancelPending) {
                checkOtpButton.classList.add('hidden');
                checkOtpButton.disabled = true;
                checkOtpButton.textContent = 'Cancel in progress';
                checkOtpButton.classList.add('opacity-60', 'cursor-not-allowed');
            } else {
                checkOtpButton.classList.remove('hidden');
                checkOtpButton.disabled = false;
                checkOtpButton.textContent = 'Check OTP Now';
                checkOtpButton.classList.remove('opacity-60', 'cursor-not-allowed');
            }
        } else {
            qs('order-waiting').classList.add('hidden');
            qs('order-expired-info').classList.remove('hidden');
            qs('order-expired-message').textContent = lifecycleStatus === 'expired'
                ? 'Time expired. Your money has been returned to your wallet.'
                : lifecycleStatus === 'cancelled'
                    ? 'This order was cancelled and refunded to your wallet.'
                    : 'This order is no longer active.';
            checkOtpButton.classList.add('hidden');
            checkOtpButton.disabled = true;
            checkOtpButton.textContent = lifecycleStatus === 'expired' ? 'Refund Completed' : 'Order Closed';
            checkOtpButton.classList.add('opacity-60', 'cursor-not-allowed');
        }
        qs('otp-value').textContent = '------';
    }
    renderOrderButtons(order);
    updateTimerDisplay(order);
}

function stopOrderIntervals() {
    if (state.otpInterval) window.clearInterval(state.otpInterval);
    if (state.timerInterval) window.clearInterval(state.timerInterval);
    state.otpInterval = null;
    state.timerInterval = null;
    state.otpPollInFlight = false;
}

function stopInlineOrderPolling() {
    if (state.inlineOrderPollInterval) window.clearInterval(state.inlineOrderPollInterval);
    state.inlineOrderPollInterval = null;
}

function stopInlineOrderTimers() {
    if (state.inlineOrderTimerInterval) window.clearInterval(state.inlineOrderTimerInterval);
    state.inlineOrderTimerInterval = null;
}

function startActiveOrderIntervals(order) {
    stopOrderIntervals();
    if (!order || canShowOrderOtp(order) || !isWaitingOrder(order) || isOrderOtpFlowBlocked(order)) {
        return;
    }
    state.otpInterval = window.setInterval(() => {
        if (!state.activeOrder || !isWaitingOrder(state.activeOrder) || isOrderOtpFlowBlocked(state.activeOrder)) return;
        void pollOtp(state.activeOrder.id, true);
    }, 5000);
    state.timerInterval = window.setInterval(() => {
        void tickActiveOrderTimer();
    }, 1000);
}

function refreshInlineOrderCountdowns() {
    qsa('[data-order-expiry-id]').forEach((element) => {
        const order = getOrderFromState(element.dataset.orderExpiryId);
        if (!order) return;
        element.textContent = getOrderExpiryText(order);
    });
    qsa('[data-cancel-unlock-id]').forEach((element) => {
        const order = getOrderFromState(element.dataset.cancelUnlockId);
        if (!order) return;
        element.textContent = getCancelUnlockText(order);
    });
    qsa('[data-cancel-order-id]').forEach((button) => {
        const order = getOrderFromState(button.dataset.cancelOrderId);
        if (!order) return;
        const canCancel = canCancelOrder(order);
        const cancelLockMessage = getOrderCancelLockMessage(order);
        button.disabled = !canCancel;
        button.classList.toggle('is-ready', canCancel);
        button.classList.toggle('is-locked', !canCancel);
        button.closest('.sms-order-cancel-panel')?.classList.toggle('is-ready', canCancel);
        button.closest('.sms-order-cancel-panel')?.classList.toggle('is-locked', !canCancel);
        const noteElement = button.closest('.sms-order-cancel-panel')?.querySelector('[data-cancel-note]');
        if (noteElement) {
            noteElement.textContent = canCancel ? 'Cancel available now' : cancelLockMessage;
        }
        button.title = canCancel
            ? 'Cancel and refund this order'
            : cancelLockMessage;
    });
    void processExpiredDashboardOrders();
}

function syncInlineOrderTimers() {
    const hasWaitingOrders = Boolean(state.currentUser) && state.orders.some((order) => isWaitingOrder(order));
    if (!hasWaitingOrders) {
        stopInlineOrderTimers();
        return;
    }
    if (!state.inlineOrderTimerInterval) {
        state.inlineOrderTimerInterval = window.setInterval(() => {
            refreshInlineOrderCountdowns();
        }, 1000);
    }
    refreshInlineOrderCountdowns();
}

function upsertOrderInState(order) {
    if (!order || order.id == null) return;
    const normalizedOrderId = normalizeDashboardOrderId(order);
    const lifecycleStatus = getOrderLifecycleStatus(order);
    state.orders = (Array.isArray(state.orders) ? state.orders : []).filter((item) => normalizeDashboardOrderId(item) !== normalizedOrderId);
    state.completedOrders = (Array.isArray(state.completedOrders) ? state.completedOrders : []).filter((item) => normalizeDashboardOrderId(item) !== normalizedOrderId);
    if (isCancelledOrderHidden(normalizedOrderId)) {
        return;
    }
    if (lifecycleStatus === 'completed') {
        state.completedOrders = sortOrdersByMostRecent([order, ...state.completedOrders]);
        return;
    }
    if (isAutoExpirableDashboardOrder(order)) {
        void queueDashboardOrderExpiry(order);
        return;
    }
    if (isValidActiveDashboardOrder(order)) {
        state.orders = sortOrdersByMostRecent([order, ...state.orders]);
    }
}

function mergeFetchedOrderWithLocalState(fetchedOrder, localOrder) {
    if (!localOrder || localOrder.id == null) return fetchedOrder;
    if (isFinalOrderLifecycle(fetchedOrder) || hasOrderSmsLock(fetchedOrder) || isOrderOtpFlowBlocked(fetchedOrder)) {
        return fetchedOrder;
    }
    if (isFinalOrderLifecycle(localOrder) || isOrderOtpFlowBlocked(localOrder)) {
        return fetchedOrder;
    }
    const fetchedHasOtp = hasOrderOtp(fetchedOrder);
    const localHasOtp = hasOrderOtp(localOrder);
    const fetchedLifecycle = getOrderLifecycleStatus(fetchedOrder);
    const localLifecycle = getOrderLifecycleStatus(localOrder);
    if (localHasOtp && !fetchedHasOtp) {
        return { ...fetchedOrder, ...localOrder };
    }
    if (localLifecycle === 'active' && fetchedLifecycle === 'pending') {
        return { ...fetchedOrder, ...localOrder };
    }
    return fetchedOrder;
}

function mergeOrdersWithLocalState(fetchedOrders) {
    const localOrders = filterHiddenCancelledOrders(state.orders || []);
    const localOrdersById = new Map(localOrders.map((order) => [String(order.id), order]));
    const normalizedFetchedOrders = Array.isArray(fetchedOrders)
        ? filterHiddenCancelledOrders(fetchedOrders).map((order) => mergeFetchedOrderWithLocalState(order, localOrdersById.get(String(order?.id))))
        : [];
    const fetchedIds = new Set(normalizedFetchedOrders.map((order) => String(order.id)));
    const localPendingOrders = localOrders.filter((order) => {
        if (!order || order.id == null) return false;
        if (fetchedIds.has(String(order.id))) return false;
        if (isAutoExpirableDashboardOrder(order)) {
            void queueDashboardOrderExpiry(order);
            return false;
        }
        return isValidActiveDashboardOrder(order);
    });
    return sortOrdersByMostRecent([...localPendingOrders, ...normalizedFetchedOrders].filter((order) => {
        if (isAutoExpirableDashboardOrder(order)) {
            void queueDashboardOrderExpiry(order);
            return false;
        }
        return isValidActiveDashboardOrder(order);
    }));
}

function ensureOrderCardVisible(orderData) {
    if (!orderData) return;
    upsertOrderInState(orderData);
    renderActiveOrders(state.orders);
    syncInlineOrderPolling({ immediate: true });
}

async function pollWaitingInlineOrders() {
    await processExpiredDashboardOrders();
    const waitingOrders = state.orders.filter((order) => {
        const isWaiting = isWaitingOrder(order);
        const isTrackedByModal = state.activeOrder && String(state.activeOrder.id) === String(order.id);
        return isWaiting && !isTrackedByModal && !isOrderOtpFlowBlocked(order);
    });
    for (const order of waitingOrders) {
        if (!state.currentUser) return;
        await pollOtp(order.id, true, { updateModal: false });
    }
}

function syncInlineOrderPolling(options = {}) {
    const { immediate = false } = options;
    const hasWaitingOrders = Boolean(state.currentUser) && state.orders.some((order) => {
        const isWaiting = isWaitingOrder(order);
        const isTrackedByModal = state.activeOrder && String(state.activeOrder.id) === String(order.id);
        return isWaiting && !isTrackedByModal && !isOrderOtpFlowBlocked(order);
    });
    if (!hasWaitingOrders) {
        stopInlineOrderPolling();
        stopInlineOrderTimers();
        return;
    }
    if (!state.inlineOrderPollInterval) {
        state.inlineOrderPollInterval = window.setInterval(() => {
            void pollWaitingInlineOrders();
        }, 5000);
    }
    syncInlineOrderTimers();
    if (immediate) {
        void pollWaitingInlineOrders();
    }
}

function refreshOrdersOnVisibilityRestore() {
    if (!state.currentUser || document.hidden) return;
    if (state.activeOrder && !canShowOrderOtp(state.activeOrder) && !isFinalOrderLifecycle(state.activeOrder) && !isOrderOtpFlowBlocked(state.activeOrder)) {
        void refreshActiveOrderState(state.activeOrder.id, { updateModal: true })
            .then((order) => {
                if (order && !canShowOrderOtp(order) && isWaitingOrder(order)) {
                    return pollOtp(order.id, true);
                }
                return false;
            })
            .catch(() => {});
    }
    syncInlineOrderPolling({ immediate: true });
}

async function refreshActiveOrderState(orderId, options = {}) {
    const refreshed = await fetchJSON(`/api/orders/${orderId}`);
    upsertOrderInState(refreshed);
    renderActiveOrders(state.orders);
    if (isCancelledOrderHidden(refreshed)) {
        return refreshed;
    }
    const shouldUpdateModal = options.updateModal ?? Boolean(state.activeOrder && String(state.activeOrder.id) === String(orderId));
    if (shouldUpdateModal) {
        state.activeOrder = refreshed;
        updateOrderVisual(refreshed);
        if (getOrderLifecycleStatus(refreshed) === 'active' || isFinalOrderLifecycle(refreshed) || isOrderOtpFlowBlocked(refreshed)) {
            stopOrderIntervals();
        }
    }
    return refreshed;
}

async function handleExpiredOrder(orderId, message = 'Time expired. Your money has been returned to your wallet.', options = {}) {
    const shouldUpdateModal = options.updateModal ?? Boolean(state.activeOrder && String(state.activeOrder.id) === String(orderId));
    if (state.expireRequestInFlight) return true;
    state.expireRequestInFlight = true;
    try {
        const refreshed = await refreshActiveOrderState(orderId, { updateModal: shouldUpdateModal });
        await finalizeExpiredOrderDashboardState(orderId, message, {
            updateModal: shouldUpdateModal,
            refunded: options.refunded !== false && getOrderLifecycleStatus(refreshed) === 'expired'
        });
        return true;
    } catch (err) {
        showToast(err.message || message, 'info', 6000);
        return false;
    } finally {
        state.expireRequestInFlight = false;
    }
}

async function requestOrderExpiry(orderId, options = {}) {
    const shouldUpdateModal = options.updateModal ?? Boolean(state.activeOrder && String(state.activeOrder.id) === String(orderId));
    if (state.expireRequestInFlight) return false;
    state.expireRequestInFlight = true;
    try {
        const result = await fetchJSON(`/api/orders/${orderId}/expire`, {
            method: 'POST'
        });
        const refreshed = await refreshActiveOrderState(orderId, { updateModal: shouldUpdateModal });
        if ((result.expired || !isWaitingOrder(refreshed)) && shouldUpdateModal) {
            stopOrderIntervals();
        }
        if (result.expired) {
            await finalizeExpiredOrderDashboardState(orderId, result.message || 'Time expired. Your money has been returned to your wallet.', {
                updateModal: shouldUpdateModal,
                refunded: result.refunded !== false
            });
        }
        return Boolean(result.expired);
    } catch (err) {
        showToast(err.message || 'Could not update order expiry', 'error');
        return false;
    } finally {
        state.expireRequestInFlight = false;
    }
}

async function tickActiveOrderTimer() {
    if (!state.activeOrder) return;
    updateTimerDisplay(state.activeOrder);
    if (getOrderLifecycleStatus(state.activeOrder) === 'pending') {
        renderOrderButtons(state.activeOrder);
    }
    const lifecycleStatus = getOrderLifecycleStatus(state.activeOrder);
    if (lifecycleStatus === 'active' || isFinalOrderLifecycle(state.activeOrder) || isOrderOtpFlowBlocked(state.activeOrder)) {
        stopOrderIntervals();
        return;
    }
    const expired = state.activeOrder.expires_at && new Date() >= new Date(state.activeOrder.expires_at);
    if (expired && isWaitingOrder(state.activeOrder)) {
        await requestOrderExpiry(state.activeOrder.id);
    }
}

async function pollOtp(orderId, silent = false, options = {}) {
    const shouldUpdateModal = options.updateModal ?? Boolean(state.activeOrder && String(state.activeOrder.id) === String(orderId));
    if (isOrderOtpFlowBlocked(orderId)) {
        if (shouldUpdateModal) {
            stopOrderIntervals();
        }
        return false;
    }
    if (state.otpPollInFlight) return false;
    state.otpPollInFlight = true;
    try {
        const result = await fetchJSON(`/api/orders/${orderId}/otp`);
        if (isOrderOtpFlowBlocked(orderId)) {
            if (shouldUpdateModal) {
                stopOrderIntervals();
            }
            return false;
        }
        if (result.received) {
            const refreshedOrder = await refreshActiveOrderState(orderId, { updateModal: shouldUpdateModal });
            if (shouldUpdateModal) {
                stopOrderIntervals();
            }
            if (!canShowOrderOtp(refreshedOrder) || isOrderOtpFlowBlocked(orderId)) {
                return true;
            }
            const serviceLabel = getServiceMeta(refreshedOrder?.service_type || state.currentService).label;
            const otpCode = String(result.code || refreshedOrder?.otp_code || '').trim();
            if (markOtpNotificationSent(orderId, otpCode)) {
                playBackgroundOtpSound();
                browserNotify('MRF SMS OTP Received', otpCode ? `${serviceLabel}: OTP ${otpCode}` : `${serviceLabel}: OTP received`);
                showToast('OTP received successfully', 'success');
            }
            await refreshUserInfo();
            return true;
        }
        if (result.expired) {
            await handleExpiredOrder(orderId, result.message || 'Time expired. Your money has been returned to your wallet.', {
                updateModal: shouldUpdateModal,
                refunded: result.refunded !== false
            });
            return true;
        }
        if (result.inactive) {
            const refreshedOrder = await refreshActiveOrderState(orderId, { updateModal: shouldUpdateModal });
            if (shouldUpdateModal || isFinalOrderLifecycle(refreshedOrder)) {
                stopOrderIntervals();
            }
            return true;
        }
        if (result.smsReceived) {
            await refreshActiveOrderState(orderId, { updateModal: shouldUpdateModal });
            return false;
        }
        if (result.validationLocked) {
            if (!silent) {
                showToast(result.message || 'OTP status is being verified. Please try again shortly.', 'info');
            }
            return false;
        }
        if (!silent) {
            showToast('No OTP yet. Still waiting...', 'info');
        }
        return false;
    } catch (err) {
        if (!silent) {
            showToast(err.message || 'OTP check failed', 'error');
        }
        return false;
    } finally {
        state.otpPollInFlight = false;
    }
}

async function openOrderModal(orderId) {
    try {
        const order = await fetchJSON(`/api/orders/${orderId}`);
        state.activeOrder = order;
        upsertOrderInState(order);
        renderActiveOrders(state.orders);
        updateOrderVisual(order);
        openModal('order-modal');
        syncInlineOrderPolling();
        startActiveOrderIntervals(order);
    } catch (err) {
        showToast(err.message || 'Could not load order details', 'error');
    }
}

function closeOrderModal() {
    closeModal('order-modal');
    stopOrderIntervals();
    state.activeOrder = null;
    syncInlineOrderPolling();
}

function startAdminAlertLoop() {
    stopAdminAlertLoop();
    try {
        notificationSound.pause();
        notificationSound.currentTime = 0;
    } catch {
    }
    notificationSound.play().catch(() => {});
    state.adminAlertInterval = window.setInterval(() => {
        try {
            notificationSound.currentTime = 0;
        } catch {
        }
        notificationSound.play().catch(() => {});
    }, 5000);
    state.adminAlertTimeout = window.setTimeout(() => {
        stopAdminAlertLoop();
    }, 30000);
}

function stopAdminAlertLoop() {
    if (state.adminAlertInterval) window.clearInterval(state.adminAlertInterval);
    if (state.adminAlertTimeout) window.clearTimeout(state.adminAlertTimeout);
    state.adminAlertInterval = null;
    state.adminAlertTimeout = null;
    try {
        notificationSound.pause();
        notificationSound.currentTime = 0;
    } catch {
    }
}

function renderCompletedOrders() {
    const container = qs('completed-orders-list');
    if (!container) return;
    const completedOrders = getVisibleCompletedOrdersForCurrentFilter();
    if (!completedOrders.length) {
        const emptyTitle = state.activationFilter === 'cancelled'
            ? 'No cancelled orders available'
            : 'No completed orders yet';
        const emptyCopy = state.activationFilter === 'cancelled'
            ? 'Cancelled or expired orders are not kept in this Active / Completed order flow.'
            : 'Orders move here after you tap Complete Order.';
        container.innerHTML = renderEmptyState(emptyTitle, emptyCopy);
        return;
    }
    container.innerHTML = completedOrders.map((order) => {
        const meta = getServiceMeta(order.service_type);
        const countryFlag = getOrderCountryFlag(order);
        const flagImageUrl = getOrderCountryFlagImageUrl(order);
        const displayOtp = String(order.otp_code || '').trim() || '------';
        const flagMarkup = flagImageUrl
            ? `<img class="sms-order-flag-image" src="${escapeAttr(flagImageUrl)}" alt="${escapeAttr(order.country || 'Country')} flag" loading="lazy" decoding="async">`
            : `<span class="sms-order-flag-fallback" aria-hidden="true">${escapeHtml(countryFlag)}</span>`;
        return `
            <article class="sms-order-card sms-order-card--completed sms-order-card--ready">
                <div class="sms-order-head">
                    <div class="sms-order-brand">
                        ${renderServiceLogo(order.service_type, 'sm')}
                        <div class="sms-order-service truncate">${escapeHtml(meta.label)}</div>
                    </div>
                    <div class="sms-order-phone-cluster">
                        ${flagMarkup}
                        <div class="sms-order-phone-text">${escapeHtml(order.phone_number || 'Processing...')}</div>
                        ${order.phone_number ? `<button type="button" class="sms-copy-button" data-action="copy-number" data-value="${escapeAttr(order.phone_number)}" title="Copy number" aria-label="Copy number">Copy</button>` : ''}
                    </div>
                </div>
                <div class="sms-order-info-row">
                    <span>Country: <strong>${escapeHtml(order.country || 'Unknown')}</strong></span>
                    <span class="sms-order-info-divider" aria-hidden="true"></span>
                    <span>Service: <strong>${escapeHtml(meta.label)}</strong></span>
                    <span class="sms-order-info-divider" aria-hidden="true"></span>
                    <span class="sms-order-info-status">Status: <strong>Completed</strong></span>
                </div>
                <div class="sms-order-otp-box">
                    <div class="sms-order-otp-label">OTP</div>
                    <div class="sms-order-otp-value">${escapeHtml(displayOtp)}</div>
                </div>
            </article>
        `;
    }).join('');
}

function renderActiveOrders(orders) {
    const container = qs('active-orders-list');
    if (!container) return;
    state.orders = sortOrdersByMostRecent(filterHiddenCancelledOrders(orders).filter((order) => {
        if (isAutoExpirableDashboardOrder(order)) {
            void queueDashboardOrderExpiry(order);
            return false;
        }
        return isValidActiveDashboardOrder(order);
    }));
    syncInlineOrderPolling();
    syncInlineOrderTimers();
    updateActivationSummaryLine();
    const activeOrders = getVisibleActiveOrdersForCurrentFilter();
    if (!activeOrders.length) {
        const emptyTitle = state.activationFilter === 'paid'
            ? 'Completed orders are shown below'
            : state.activationFilter === 'cancelled'
                ? 'No cancelled orders available'
                : 'No active orders yet';
        const emptyCopy = state.activationFilter === 'paid'
            ? 'Use All phone activation to view active and completed orders together.'
            : state.activationFilter === 'cancelled'
                ? 'Cancelled or expired orders are not kept in this Active / Completed order flow.'
                : 'Buy a number to see it appear here instantly.';
        container.innerHTML = renderEmptyState(emptyTitle, emptyCopy);
        renderCompletedOrders();
        syncWaitingOrdersVisibility();
        return;
    }
    container.innerHTML = activeOrders.map((order) => {
        const meta = getServiceMeta(order.service_type);
        const lifecycleStatus = getOrderLifecycleStatus(order);
        const isOtpReady = canShowOrderOtp(order);
        const canCancel = canCancelOrder(order);
        const cancelNote = canCancel ? 'Cancel available now' : getOrderCancelLockMessage(order);
        const countryFlag = getOrderCountryFlag(order);
        const flagImageUrl = getOrderCountryFlagImageUrl(order);
        const displayOtp = String(order.otp_code || '').trim() || '------';
        const priceValue = formatMoney(order.price);
        const expireValue = getSmsOrderTimeStatus(order, lifecycleStatus);
        const statusValue = isOtpReady ? 'OTP Received' : hasOrderSmsLock(order) ? 'SMS Received' : 'Waiting';
        const expireValueMarkup = lifecycleStatus === 'pending' || lifecycleStatus === 'active'
            ? `<strong data-order-expiry-id="${escapeAttr(order.id)}">${escapeHtml(expireValue)}</strong>`
            : `<strong>${escapeHtml(expireValue)}</strong>`;
        const statusDetailMarkup = `<strong>${escapeHtml(statusValue)}</strong>`;
        const flagMarkup = flagImageUrl
            ? `<img class="sms-order-flag-image" src="${escapeAttr(flagImageUrl)}" alt="${escapeAttr(order.country || 'Country')} flag" loading="lazy" decoding="async">`
            : `<span class="sms-order-flag-fallback" aria-hidden="true">${escapeHtml(countryFlag)}</span>`;
        const contentPanel = isOtpReady
            ? `
                    <div class="sms-order-otp-box">
                        <div class="sms-order-otp-label">OTP Received</div>
                        <div class="sms-order-otp-value">${escapeHtml(displayOtp)}</div>
                    </div>
                `
            : `
                    <div class="sms-order-live-box">
                        <span class="sms-wait-ring" aria-hidden="true"></span>
                        <div class="sms-order-live-copy min-w-0">
                            <div class="sms-order-live-title">Code will be here</div>
                        </div>
                    </div>
                `;
        const actionAreaMarkup = isOtpReady
            ? `
                <div class="sms-order-actions">
                    <button class="sms-order-btn complete" data-action="complete-order" data-order-id="${escapeAttr(order.id)}">Complete Order</button>
                </div>
                <div class="sms-order-foot">
                    <div class="sms-order-secondary-note"><span>OTP received. Tap Complete Order to move this card below.</span></div>
                </div>
            `
            : `
                <div class="sms-order-cancel-panel ${canCancel ? 'is-ready' : 'is-locked'}">
                    <div class="sms-order-actions">
                        <button class="sms-order-btn cancel ${canCancel ? 'is-ready' : 'is-locked'}" data-action="cancel-order" data-order-id="${escapeAttr(order.id)}" data-cancel-order-id="${escapeAttr(order.id)}" title="${escapeAttr(canCancel ? 'Cancel and refund this order' : cancelNote)}" ${canCancel ? '' : 'disabled'}>Cancel</button>
                    </div>
                    <div class="sms-order-foot">
                        <div class="sms-order-secondary-note"><span data-cancel-note>${escapeHtml(cancelNote)}</span></div>
                    </div>
                </div>
            `;
        return `
            <article class="sms-order-card sms-order-card--active ${isOtpReady ? 'sms-order-card--ready' : 'sms-order-card--waiting'}">
                <div class="sms-order-title-row">
                    <div class="sms-order-brand">
                        ${renderServiceLogo(order.service_type, 'sm')}
                        <div class="sms-order-service">${escapeHtml(meta.label)}</div>
                    </div>
                </div>
                <div class="sms-order-number-row">
                    ${flagMarkup}
                    <div class="sms-order-phone-text">${escapeHtml(order.phone_number || 'Processing...')}</div>
                    ${order.phone_number ? `<button type="button" class="sms-copy-button" data-action="copy-number" data-value="${escapeAttr(order.phone_number)}" title="Copy number" aria-label="Copy number">Copy</button>` : ''}
                </div>
                <div class="sms-order-meta-row">
                    <span>Price: <strong>${escapeHtml(priceValue)}</strong></span>
                    <span class="sms-order-meta-divider" aria-hidden="true"></span>
                    <span>Expire: ${expireValueMarkup}</span>
                    <span class="sms-order-meta-divider" aria-hidden="true"></span>
                    <span class="sms-order-meta-status">Status: ${statusDetailMarkup}</span>
                </div>
                ${contentPanel}
                ${actionAreaMarkup}
            </article>
        `;
    }).join('');
    renderCompletedOrders();
    refreshInlineOrderCountdowns();
    syncWaitingOrdersVisibility();
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

function getOrderFinancialTimestamp(order) {
    return order?.completed_at || order?.last_purchase_at || order?.created_at || null;
}

function formatProviderBalanceValue(value, currency = 'USD') {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return `— ${currency}`;
    return `${amount.toFixed(3)} ${currency || 'USD'}`;
}

function isTodayDate(value) {
    if (!value) return false;
    const candidate = new Date(value);
    if (Number.isNaN(candidate.getTime())) return false;
    const now = new Date();
    return candidate.getFullYear() === now.getFullYear()
        && candidate.getMonth() === now.getMonth()
        && candidate.getDate() === now.getDate();
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

function calculateDailyProfitDetails(orders) {
    const grouped = {};
    (orders || []).forEach((order) => {
        if (getOrderLifecycleStatus(order) !== 'completed') return;
        const dateKey = getFinancialDateKey(getOrderFinancialTimestamp(order));
        if (!dateKey) return;
        grouped[dateKey] = (grouped[dateKey] || 0) + getOrderProfit(order);
    });
    return Object.entries(grouped)
        .map(([date, profit]) => ({ date, profit }))
        .sort((left, right) => right.date.localeCompare(left.date));
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
            detail: summary?.latestReconciliationAt
                ? `Last sync ${formatRelativeTime(summary.latestReconciliationAt)}`
                : 'Waiting for first reconciliation',
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
            tone: Number(summary?.totalRealProfitLoss || 0) >= 0
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-rose-200 bg-rose-50 text-rose-700'
        },
        {
            title: 'Risk Overview',
            value: `${Number(summary?.riskOrders || 0)} / ${Number(summary?.criticalOrders || 0)}`,
            detail: `${Number(summary?.riskyUsers || 0)} risky users • ${Number(summary?.blockedUsers || 0)} manually blocked`,
            tone: summary?.latestAnomalyFlag
                ? 'border-rose-200 bg-rose-50 text-rose-700'
                : 'border-slate-200 bg-slate-50 text-slate-700'
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
    container.innerHTML = renderAdminTable(
        ['Service', 'Orders', 'Risk Orders', 'Real Provider Cost', 'Real Profit / Loss'],
        rows,
        'min-w-[860px]'
    );
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
            <td class="px-4 py-3">${entry.anomaly_flag
                ? '<span class="inline-flex items-center rounded-full bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200">Flagged</span>'
                : '<span class="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">OK</span>'}</td>
        </tr>
    `).join('');
    container.innerHTML = renderAdminTable(
        ['Time', 'Reason', 'Balance', 'Delta', 'Expected', 'Unmatched', 'Status'],
        rows,
        'min-w-[1020px]'
    );
}

function renderAdminProviderSecurityEvents(events) {
    const container = qs('admin-provider-security-list');
    if (!container) return;
    if (!events.length) {
        container.innerHTML = renderEmptyState('No provider security events yet', 'Risk, exploit, and reconciliation events will appear here when the backend flags them.');
        return;
    }
    const rows = events.map((event) => {
        const flags = [
            event.critical_exploit ? 'Critical' : '',
            event.loss_detected ? 'Loss' : '',
            event.risk_flag ? 'Risk' : ''
        ].filter(Boolean).join(' • ') || 'Tracked';
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
    container.innerHTML = renderAdminTable(
        ['Time', 'Event', 'Order', 'Service', 'Number', 'User', 'Reason', 'Provider Status', 'Provider Deduction', 'Refund Status', 'Flags'],
        rows,
        'min-w-[1480px]'
    );
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
    container.innerHTML = renderAdminTable(
        ['User ID', 'Name', 'Email', 'Risk Score', 'Risk Status', 'Confirmed Losses', 'Provider Loss', 'Blocked Until'],
        rows,
        'min-w-[1180px]'
    );
}

function renderAdminProviderDailyEarnings(entries, summary) {
    const container = qs('admin-provider-daily-earnings');
    if (!container) return;
    const todayKey = getFinancialDateKey(new Date());
    const totalProfitLabel = summary?.financialResetDate ? `Since ${summary.financialResetDate} Profit` : 'Since Reset Profit';
    const headerMarkup = `
        <div class="grid gap-3 lg:grid-cols-4">
            <div class="rounded-2xl border border-cyan-200 bg-cyan-50 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-700">Today Revenue</div>
                <div class="mt-2 text-2xl font-extrabold text-cyan-700">${escapeHtml(formatMoneyPrecise(summary?.todayRevenue || 0))}</div>
            </div>
            <div class="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">Today API Cost</div>
                <div class="mt-2 text-2xl font-extrabold text-amber-700">${escapeHtml(formatMoneyPrecise(summary?.todayApiCost || 0))}</div>
            </div>
            <div class="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">Today Profit</div>
                <div class="mt-2 text-2xl font-extrabold text-emerald-700">${escapeHtml(formatMoneyPrecise(summary?.todayProfit || 0))}</div>
            </div>
            <div class="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">${escapeHtml(totalProfitLabel)}</div>
                <div class="mt-2 text-2xl font-extrabold text-slate-900">${escapeHtml(formatMoneyPrecise(summary?.totalProfit || 0))}</div>
            </div>
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
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">
                    <div class="inline-flex items-center gap-2">
                        <span>${escapeHtml(entry.date || '—')}</span>
                        ${isTodayRow ? '<span class="inline-flex rounded-full bg-cyan-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-700">Today</span>' : ''}
                    </div>
                </td>
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
    container.innerHTML = renderAdminTable(
        ['Scope', 'Deposits', 'Revenue', 'API Cost', 'Real Profit'],
        rows,
        'min-w-[980px]'
    );
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
            <td class="px-4 py-3">
                <div class="flex flex-wrap gap-2">
                    <button class="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50" data-action="view-user-history" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}">
                        <i class="fa-solid fa-clock-rotate-left"></i>
                        <span>History</span>
                    </button>
                    <button class="inline-flex items-center gap-1 rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100" data-action="admin-user-unblock" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}">
                        <i class="fa-solid fa-unlock"></i>
                        <span>Unblock</span>
                    </button>
                    <button class="inline-flex items-center gap-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 transition hover:bg-amber-100" data-action="admin-user-remove-risk" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}">
                        <i class="fa-solid fa-shield-heart"></i>
                        <span>Remove Risk</span>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
    container.innerHTML = renderAdminTable(
        ['Name', 'Email', 'Confirmed Losses', 'Provider Loss', 'Block Reason', 'Blocked Until', 'Latest Order', 'Actions'],
        rows,
        'min-w-[1480px]'
    );
}

function renderAdminOrders(orders) {
    const container = qs('admin-orders-list');
    if (!container) return;
    if (!orders.length) {
        container.innerHTML = renderEmptyState('No orders yet', 'Ordered numbers will appear here with pricing, API cost, and profit details.');
        return;
    }
    const rows = orders.map((order) => {
        const service = getServiceMeta(order.service_type);
        const lifecycleStatus = getOrderLifecycleStatus(order);
        const providerCost = getOrderApiCost(order);
        const profit = getOrderProfit(order);
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0">
                <td class="px-4 py-3 break-all text-slate-700">${escapeHtml(order.user_email || 'Unknown email')}</td>
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(order.country || 'Unknown country')}</td>
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(service.label)}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatMoneyPrecise(order.price))}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-600">${escapeHtml(formatMoneyPrecise(providerCost))}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold ${profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${escapeHtml(formatMoneyPrecise(profit))}</td>
                <td class="px-4 py-3">${renderStatusBadge(lifecycleStatus)}</td>
            </tr>
        `;
    }).join('');
    container.innerHTML = renderAdminTable(
        ['User Email', 'Country', 'Service', 'Price', 'API Cost', 'Profit', 'Status'],
        rows,
        'min-w-[1080px]'
    );
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
    } finally {
        state.adminNumberManagementLoadInFlight = false;
        syncAdminAccordionLayout();
    }
}

function syncSidebarPendingPayment(requests) {
    const pendingRequests = (requests || []).filter((request) => String(request.status || '').toLowerCase() === 'pending');
    const totalPendingAmount = pendingRequests.reduce((sum, request) => sum + Number(request.amount || 0), 0);
    const paymentAction = qs('header-payment-detail-action');
    if (paymentAction) {
        paymentAction.textContent = 'Check Payment Details';
        paymentAction.dataset.meta = pendingRequests.length
            ? `Pending ${formatMoneyPrecise(totalPendingAmount)}`
            : 'Pending / Success / Cancel';
        paymentAction.title = pendingRequests.length
            ? `Pending amount ${formatMoneyPrecise(totalPendingAmount)}`
            : 'Check Payment Details';
    }
}

function renderPaymentHistoryCards(requests) {
    const container = qs('payment-history-list');
    if (!container) return;
    if (!requests.length) {
        container.innerHTML = renderEmptyState('No payment requests yet', 'Your submitted Easypaisa and Binance add-money requests will appear here after submission.');
        return;
    }
    const sortedRequests = [...requests].sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
    container.innerHTML = sortedRequests.map((request, index) => {
        const status = String(request.status || 'pending').toLowerCase();
        const methodMeta = getPaymentMethodMeta(request.payment_method);
        const verificationUrl = getPaymentVerificationUrl(request);
        const newestBadge = index === 0
            ? '<span class="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.16em] text-emerald-700">Newest</span>'
            : '';
        const proofButton = request.screenshot ? `
            <button class="btn-soft" data-action="view-payment-proof" data-image="${escapeAttr(getUploadUrl(request.screenshot))}" data-user="${escapeAttr(request.user_name || 'Customer')}" data-email="${escapeAttr(request.user_email || 'Unknown email')}" data-amount="${escapeAttr(formatPaymentRequestAmountText(request))}" data-status="${escapeAttr(formatPaymentStatus(request.status))}">
                <i class="fa-regular fa-image"></i>
                <span>View Proof</span>
            </button>
        ` : '';
        return `
            <article class="payment-detail-row ${escapeAttr(status)}">
                <div class="payment-detail-main">
                    <div class="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <div class="text-xs uppercase tracking-[0.2em] text-slate-500">Submitted</div>
                            <div class="mt-2 text-sm font-semibold text-slate-900">${escapeHtml(formatRelativeTime(request.created_at))}</div>
                        </div>
                        <div class="flex flex-wrap items-center gap-2">
                            ${newestBadge}
                            ${renderPaymentStatusBadge(status)}
                        </div>
                    </div>
                    <div class="mt-4 grid gap-2 sm:grid-cols-2">
                        <div class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                            <div class="text-[11px] uppercase tracking-[0.18em] text-slate-500">Amount</div>
                            <div class="mt-2 text-sm font-semibold text-slate-900">${escapeHtml(formatPaymentRequestAmountText(request))}</div>
                        </div>
                        <div class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                            <div class="text-[11px] uppercase tracking-[0.18em] text-slate-500">${escapeHtml(getPaymentRequestReferenceLabel(request))}</div>
                            <div class="mt-2 break-all text-sm font-semibold text-slate-900">${escapeHtml(getPaymentRequestReferenceValue(request))}</div>
                        </div>
                        <div class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                            <div class="text-[11px] uppercase tracking-[0.18em] text-slate-500">Payment Method</div>
                            <div class="mt-2 text-sm font-semibold text-slate-900">${escapeHtml(methodMeta.label)}</div>
                        </div>
                        <div class="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                            <div class="text-[11px] uppercase tracking-[0.18em] text-slate-500">Note</div>
                            <div class="mt-2 text-sm font-semibold text-slate-900">${escapeHtml(request.note || '—')}</div>
                        </div>
                    </div>
                </div>
                <div class="payment-detail-actions">
                    ${verificationUrl ? `<a class="btn-soft" href="${escapeAttr(verificationUrl)}" target="_blank" rel="noreferrer"><span>Verify TXID</span></a>` : ''}
                    ${proofButton}
                </div>
            </article>
        `;
    }).join('');
}

function renderAdminPaymentRequests(paymentRequests, legacyTransactions) {
    const items = [
        ...paymentRequests.map((request) => ({
            ...request,
            entry_kind: 'payment_request',
            source_label: 'Payment Request'
        })),
        ...legacyTransactions.map((transaction) => ({
            ...transaction,
            entry_kind: 'legacy_transaction',
            source_label: 'Legacy Deposit'
        }))
    ];
    if (!items.length) {
        return renderEmptyState('No pending requests', 'New Easypaisa and Binance payment requests will appear here for verification and approval.');
    }
    const rows = items.map((item) => {
        const methodMeta = getPaymentMethodMeta(item.payment_method);
        const verificationUrl = getPaymentVerificationUrl(item);
        const proofButton = item.screenshot ? `
            <button class="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50" data-action="view-payment-proof" data-image="${escapeAttr(getUploadUrl(item.screenshot))}" data-user="${escapeAttr(item.user_name || 'Customer')}" data-email="${escapeAttr(item.user_email || 'Unknown email')}" data-amount="${escapeAttr(formatPaymentRequestAmountText(item))}" data-status="${escapeAttr(formatStatus(item.status || 'pending'))}">
                <i class="fa-regular fa-image"></i>
                <span>Proof</span>
            </button>
        ` : '<span class="text-xs text-slate-500">No proof</span>';
        const actionButtons = item.entry_kind === 'payment_request'
            ? `
                <button class="inline-flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100" data-action="approve-payment-request" data-request-id="${escapeAttr(item.id)}">
                    <i class="fa-solid fa-check"></i>
                    <span>Approve</span>
                </button>
                <button class="inline-flex items-center gap-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100" data-action="cancel-payment-request" data-request-id="${escapeAttr(item.id)}">
                    <i class="fa-solid fa-xmark"></i>
                    <span>Reject</span>
                </button>
            `
            : `
                <button class="inline-flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100" data-action="approve-transaction" data-tx-id="${escapeAttr(item.id)}">
                    <i class="fa-solid fa-check"></i>
                    <span>Approve</span>
                </button>
                <button class="inline-flex items-center gap-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100" data-action="cancel-transaction" data-tx-id="${escapeAttr(item.id)}">
                    <i class="fa-solid fa-xmark"></i>
                    <span>Cancel</span>
                </button>
            `;
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0">
                <td class="px-4 py-3 font-medium text-slate-600">${escapeHtml(item.source_label)}</td>
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(methodMeta.label)}</td>
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(item.user_name || 'Customer')}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(item.user_email || 'Unknown email')}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatPaymentRequestAmountText(item))}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(item.transaction_id || `#${item.id}`)}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-500">${escapeHtml(formatRelativeTime(item.created_at))}</td>
                <td class="px-4 py-3">${proofButton}</td>
                <td class="px-4 py-3">
                    <div class="flex flex-wrap gap-2">
                        ${verificationUrl ? `<a class="inline-flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100" href="${escapeAttr(verificationUrl)}" target="_blank" rel="noreferrer" style="text-decoration:none;"><span>Verify TXID</span></a>` : ''}
                        ${actionButtons}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
    return renderAdminTable(
        ['Source', 'Method', 'Customer', 'User Email', 'Amount', 'Reference', 'Submitted', 'Proof', 'Actions'],
        rows,
        'min-w-[1360px]'
    );
}

function renderAdminPaymentHistory(paymentRequests) {
    if (!paymentRequests.length) {
        return renderEmptyState('No processed requests', 'Approved and cancelled payment requests will appear here once processed by admin.');
    }
    const rows = paymentRequests.map((request) => {
        const methodMeta = getPaymentMethodMeta(request.payment_method);
        const verificationUrl = getPaymentVerificationUrl(request);
        const proofButton = request.screenshot ? `
            <button class="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50" data-action="view-payment-proof" data-image="${escapeAttr(getUploadUrl(request.screenshot))}" data-user="${escapeAttr(request.user_name || 'Customer')}" data-email="${escapeAttr(request.user_email || 'Unknown email')}" data-amount="${escapeAttr(formatPaymentRequestAmountText(request))}" data-status="${escapeAttr(formatStatus(request.status || 'pending'))}">
                <i class="fa-regular fa-image"></i>
                <span>View Proof</span>
            </button>
        ` : '<span class="text-xs text-slate-500">No proof</span>';
        return `
            <tr class="border-b border-slate-200 align-top last:border-b-0">
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(methodMeta.label)}</td>
                <td class="px-4 py-3 font-medium text-slate-900">${escapeHtml(request.user_name || 'Customer')}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(request.user_email || 'Unknown email')}</td>
                <td class="px-4 py-3 whitespace-nowrap font-semibold text-slate-900">${escapeHtml(formatPaymentRequestAmountText(request))}</td>
                <td class="px-4 py-3 break-all text-slate-600">${escapeHtml(request.transaction_id || `#${request.id}`)}</td>
                <td class="px-4 py-3 whitespace-nowrap text-slate-500">${escapeHtml(formatRelativeTime(request.created_at))}</td>
                <td class="px-4 py-3">${renderStatusBadge(request.status || 'pending')}</td>
                <td class="px-4 py-3">
                    <div class="flex flex-wrap gap-2">
                        ${verificationUrl ? `<a class="inline-flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100" href="${escapeAttr(verificationUrl)}" target="_blank" rel="noreferrer" style="text-decoration:none;"><span>Verify TXID</span></a>` : ''}
                        ${proofButton}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
    return renderAdminTable(
        ['Method', 'Customer', 'User Email', 'Amount', 'Reference', 'Submitted', 'Status', 'Actions'],
        rows,
        'min-w-[1280px]'
    );
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
                <td class="px-4 py-3">
                    ${transaction.transaction_id ? `<a class="inline-flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100" href="https://easypaisa.com.pk/ticket-check/?ticketNo=${escapeAttr(transaction.transaction_id)}" target="_blank" style="text-decoration:none;"><span>Verify TXID</span></a>` : '<span class="text-xs text-slate-500">Internal Entry</span>'}
                </td>
            </tr>
        `;
    }).join('');
    return renderAdminTable(
        ['Type', 'Customer', 'Amount', 'Reference', 'Details', 'Date', 'Status', 'Actions'],
        rows,
        'min-w-[1240px]'
    );
}

function getReferralStatusMeta(entry) {
    const normalizedStatus = String(entry?.status || 'pending').toLowerCase();
    if (normalizedStatus === 'rewarded') {
        return {
            statusKey: 'rewarded',
            label: 'Rewarded',
            details: `Bonus added: ${formatMoneyPrecise(entry?.reward_amount || 0)} • Deposit: ${formatMoneyPrecise(entry?.qualifying_deposit_amount || 0)}`
        };
    }
    if (normalizedStatus === 'blocked') {
        return {
            statusKey: 'blocked',
            label: 'Blocked',
            details: entry?.fraud_reason || 'Referral bonus not allowed (security protection)'
        };
    }
    return {
        statusKey: 'pending',
        label: 'Pending',
        details: Number(entry?.qualifying_deposit_amount || 0) >= 170
            ? 'Waiting for reward review'
            : 'Waiting for friend deposit of 170 PKR+'
    };
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
    return renderAdminTable(
        ['Referrer', 'Referrer Email', 'Referred User', 'Referred Email', 'Code', 'Deposit', 'Reward', 'Status', 'Details', 'Date'],
        rows,
        'min-w-[1500px]'
    );
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
                <td class="px-4 py-3">
                    <div class="flex flex-wrap gap-2">
                        <button class="inline-flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100" data-action="adjust-user-balance" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}">
                            <i class="fa-solid fa-scale-balanced"></i>
                            <span>Adjust</span>
                        </button>
                        <button class="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50" data-action="view-user-history" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}">
                            <i class="fa-solid fa-clock-rotate-left"></i>
                            <span>History</span>
                        </button>
                        <button class="inline-flex items-center gap-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100" data-action="admin-user-block" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}">
                            <i class="fa-solid fa-user-lock"></i>
                            <span>Block</span>
                        </button>
                        <button class="inline-flex items-center gap-1 rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100" data-action="admin-user-unblock" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}">
                            <i class="fa-solid fa-unlock"></i>
                            <span>Unblock</span>
                        </button>
                        <button class="inline-flex items-center gap-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 transition hover:bg-amber-100" data-action="admin-user-remove-risk" data-user-id="${escapeAttr(user.id)}" data-user-label="${escapeAttr(user.name || user.email || `User #${user.id}`)}">
                            <i class="fa-solid fa-shield-heart"></i>
                            <span>Remove Risk</span>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
    return renderAdminTable(
        ['Name', 'Email', 'Balance', 'Role', 'Risk', 'Reason', 'Provider Loss', 'Actions'],
        rows,
        'min-w-[1480px]'
    );
}

function syncAdminUsersList() {
    const container = qs('admin-users-list');
    if (!container) return;
    const query = String(state.adminUsersSearch || '').trim().toLowerCase();
    const filteredUsers = !query
        ? state.adminUsers
        : state.adminUsers.filter((user) => String(user.email || '').toLowerCase().includes(query));
    container.innerHTML = filteredUsers.length
        ? renderAdminUsers(filteredUsers)
        : renderEmptyState('No matching user found', 'Try searching with the user Gmail or full email address.');
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
    return renderAdminTable(
        ['User', 'User Email', 'Amount', 'Reason', 'Adjusted By', 'Date'],
        rows,
        'min-w-[1240px]'
    );
}

function renderAdminUserHistory(history, userLabel) {
    if (!history.length) {
        return renderEmptyState('No history records', `${userLabel || 'This user'} has no purchases, deposits, or manual adjustments yet.`);
    }
    const rows = history.map((entry) => {
        const normalizedAmount = entry.entry_type === 'order'
            ? -Math.abs(Number(entry.amount || 0))
            : Number(entry.amount || 0);
        const isNegative = normalizedAmount < 0;
        const amountText = `${isNegative ? '-' : '+'}${formatMoneyPrecise(Math.abs(normalizedAmount))}`;
        const detailsMarkup = entry.entry_type === 'order'
            ? `
                <div class="font-medium text-slate-700">${escapeHtml(entry.details || '—')}</div>
                <div class="mt-1 text-xs text-slate-500">Number: ${escapeHtml(entry.phone_number || '—')} • Service: ${escapeHtml(formatStatus(entry.service_type || 'unknown'))} • Country: ${escapeHtml(entry.country || '—')}</div>
                <div class="mt-1 text-xs text-slate-500">Provider: ${escapeHtml(entry.provider_status || '—')} • OTP: ${escapeHtml(entry.otp_received ? 'Received' : 'No')}</div>
                <div class="mt-1 text-xs text-slate-500">Refund: ${escapeHtml(formatMoneyPrecise(entry.refund_amount || 0))} • Provider deduction: ${escapeHtml(formatMoneyPrecise(entry.provider_deduction_amount || 0))} • Provider loss: ${escapeHtml(formatMoneyPrecise(entry.provider_loss_amount || 0))}</div>
            `
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
    return renderAdminTable(
        ['Type', 'Amount', 'Details', 'Status', 'Date'],
        rows,
        'min-w-[1080px]'
    );
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
        container.innerHTML = renderAdminUserHistory(history, state.selectedAdminHistoryUserLabel);
        container.scrollTop = preserveScroll ? previousScrollTop : 0;
        container.scrollLeft = preserveScroll ? previousScrollLeft : 0;
    } catch (err) {
        container.innerHTML = renderEmptyState('History unavailable', err.message || 'Could not load user history right now.');
        container.scrollTop = preserveScroll ? previousScrollTop : 0;
        container.scrollLeft = preserveScroll ? previousScrollLeft : 0;
    } finally {
        syncAdminAccordionLayout();
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
        await response.json();
        showToast('Balance adjusted successfully', 'success');
        await loadAdminData();
        if (state.currentUser) {
            await refreshUserInfo();
        }
    } catch (err) {
        showToast(err.message || 'Balance adjustment failed', 'error');
    }
}

async function loadPaymentHistory() {
    if (!state.currentUser) {
        state.paymentRequests = [];
        syncSidebarPendingPayment([]);
        return [];
    }
    const section = qs('payment-history-section');
    const container = qs('payment-history-list');
    if (!section || !container) return;
    try {
        const history = await fetchJSON('/api/my-payment-history');
        state.paymentRequests = history;
        renderPaymentHistoryCards(history);
        syncSidebarPendingPayment(history);
        return history;
    } catch {
        state.paymentRequests = [];
        container.innerHTML = renderEmptyState('Payment history unavailable', 'Your add-money requests could not be loaded right now.');
        syncSidebarPendingPayment([]);
        return [];
    }
}

async function loadNumberHistory() {
    const container = qs('number-history-list');
    if (!state.currentUser) {
        state.numberHistory = [];
        syncNumberHistoryAction([]);
        if (container) {
            container.innerHTML = '';
        }
        return [];
    }
    if (!container) return [];
    try {
        const history = await fetchJSON('/api/number-history');
        state.numberHistory = Array.isArray(history) ? history : [];
        renderNumberHistory(state.numberHistory);
        return state.numberHistory;
    } catch {
        state.numberHistory = [];
        syncNumberHistoryAction([]);
        container.innerHTML = renderEmptyState('Number history unavailable', 'Your saved number history could not be loaded right now.');
        return [];
    }
}

async function loadAdminData() {
    if (!state.currentUser || !state.currentUser.isAdmin) return;
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
        state.adminUsers = users;
        state.adminBalanceAdjustments = balanceAdjustments;
        state.adminReferrals = referrals;
        const pendingPaymentRequests = paymentRequests.filter((request) => String(request.status || '').toLowerCase() === 'pending');
        const processedPaymentRequests = paymentRequests.filter((request) => String(request.status || '').toLowerCase() !== 'pending');
        const totalPendingCount = pendingPaymentRequests.length + pendingTransactions.length;
        renderAdminStats(providerAnalytics?.financeSummary || {});
        renderAdminTotalUsersSummary(users);
        renderAdminDailyProfitDetails(providerAnalytics?.dailyEarnings || [], providerAnalytics?.financeSummary || {});
        renderAdminUserSpending(providerAnalytics?.userSpending || calculateUserSpending([]), users);
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
        qs('admin-balance-adjustments-list').innerHTML = renderAdminBalanceAdjustments(balanceAdjustments);
        qs('admin-referrals-list').innerHTML = renderAdminReferralRecords(referrals);
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
    }
}

async function refreshUserInfo() {
    if (!state.currentUser) return;
    try {
        const user = await fetchJSON('/api/me');
        state.currentUser = user;
        await requestBrowserNotificationPermission();
        syncAccountShortcutButtons();
        closeModal('login-prompt');
        syncGuestBrowsingState();
        qs('user-balance').textContent = formatMoney(user.balance);
        qs('account-name').textContent = user.name || '—';
        qs('account-email').textContent = user.email || '—';
        qs('account-referral').textContent = user.referralCode || '—';
        qs('account-role').textContent = formatStatus(user.role || 'user');
        const orders = mergeOrdersWithLocalState(await fetchJSON('/api/orders'));
        state.orders = orders;
        if (state.activeOrder?.id != null) {
            state.activeOrder = orders.find((entry) => String(entry.id) === String(state.activeOrder.id))
                || state.completedOrders.find((entry) => String(entry.id) === String(state.activeOrder.id))
                || state.activeOrder;
        }
        renderActiveOrders(orders);
        void processExpiredDashboardOrders();
        syncInlineOrderPolling({ immediate: true });
        await loadPaymentHistory();
        await loadNumberHistory();
        await loadReferralProgram({ silent: true });
        setActivationFilter(state.activationFilter);
        setHistoryView(state.historyView);
        if (!state.paymentHistoryRefreshInterval) {
            state.paymentHistoryRefreshInterval = window.setInterval(() => {
                if (state.currentUser) {
                    loadPaymentHistory();
                }
            }, 30000);
        }
        if (!state.liveUserRefreshInterval) {
            state.liveUserRefreshInterval = window.setInterval(() => {
                if (!state.currentUser) return;
                refreshWalletBalanceSilently();
            }, 10000);
        }
        if (user.isAdmin) {
            qs('admin-panel').classList.remove('hidden');
            initAdminAccordion();
            await loadAdminData();
            ensureLightAdminAutoRefresh();
        } else {
            qs('admin-panel').classList.add('hidden');
            if (state.adminRefreshInterval) window.clearInterval(state.adminRefreshInterval);
            state.adminRefreshInterval = null;
            state.adminNumberManagementLoaded = false;
            state.adminNumberManagementLoadInFlight = false;
            state.lastPendingCount = 0;
            stopAdminAlertLoop();
        }
    } catch (err) {
        showToast(err.message || 'Failed to refresh account info', 'error');
    }
}

async function checkAuth() {
    try {
        const user = await fetchJSON('/api/me');
        state.currentUser = user;
        await refreshUserInfo();
    } catch {
        state.currentUser = null;
        state.orders = [];
        state.completedOrders = [];
        state.numberHistory = [];
        state.otpNotificationKeys = new Set();
        state.hiddenCancelledOrderIds = new Set();
        state.paymentRequests = [];
        state.referralProgram = null;
        state.adminReferrals = [];
        state.historyView = 'activations';
        state.numberHistorySearch = '';
        state.activationFilter = 'waiting';
        syncAccountShortcutButtons();
        hideAccountDetails();
        hideHeaderQuickMenu();
        closeOrderModal();
        stopInlineOrderPolling();
        stopInlineOrderTimers();
        closeModal('login-prompt');
        syncGuestBrowsingState();
        const numberHistorySearchInput = qs('number-history-search');
        if (numberHistorySearchInput) numberHistorySearchInput.value = '';
        qs('number-history-section')?.classList.add('hidden');
        qs('payment-history-section')?.classList.add('hidden');
        syncSidebarPendingPayment([]);
        syncNumberHistoryAction([]);
        qs('admin-panel')?.classList.add('hidden');
        if (state.adminRefreshInterval) window.clearInterval(state.adminRefreshInterval);
        state.adminRefreshInterval = null;
        if (state.paymentHistoryRefreshInterval) window.clearInterval(state.paymentHistoryRefreshInterval);
        state.paymentHistoryRefreshInterval = null;
        if (state.liveUserRefreshInterval) window.clearInterval(state.liveUserRefreshInterval);
        state.liveUserRefreshInterval = null;
        hidePaymentTopAlert();
        stopAdminAlertLoop();
        renderReferralProgram(null);
    }
}

async function refreshWalletBalanceSilently(options = {}) {
    if (!state.currentUser) return;
    const showIncreaseToast = options.showIncreaseToast !== false;
    try {
        const user = await fetchJSON('/api/me');
        const previousBalance = Number(state.currentUser?.balance || 0);
        const nextBalance = Number(user?.balance || 0);
        state.currentUser = { ...state.currentUser, ...user };
        qs('user-balance').textContent = formatMoney(user.balance);
        qs('account-name').textContent = user.name || '—';
        qs('account-email').textContent = user.email || '—';
        qs('account-referral').textContent = user.referralCode || '—';
        qs('account-role').textContent = formatStatus(user.role || 'user');
        syncAccountShortcutButtons();
        syncBalanceBannerVisibility();
        if (nextBalance > previousBalance) {
            await loadPaymentHistory();
            if (showIncreaseToast) {
                showToast(`Balance updated: ${formatMoney(user.balance)}`, 'success', 5000);
            }
        }
    } catch {
    }
}

function setAuthMode(mode) {
    const loginTab = qs('show-login-tab');
    const registerTab = qs('show-register-tab');
    const loginPanel = qs('login-form-wrap');
    const registerPanel = qs('register-form-wrap');
    const isLogin = mode === 'login';
    clearAuthFormError();
    loginTab.classList.toggle('active', isLogin);
    registerTab.classList.toggle('active', !isLogin);
    loginPanel.classList.toggle('hidden', !isLogin);
    registerPanel.classList.toggle('hidden', isLogin);
    if (!isLogin) {
        fillReferralFieldFromLanding();
    }
}

async function login(email, password) {
    const button = qs('login-btn');
    setLoading(button, 'Signing in...');
    clearAuthFormError();
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
            credentials: 'include'
        });
        if (!response.ok) throw new Error(await response.text());
        clearAuthFormError();
        showToast('Logged in successfully', 'success');
        await checkAuth();
        closeModal('login-prompt');
    } catch (err) {
        showAuthFormError(err.message || 'Login failed');
    } finally {
        resetLoading(button);
    }
}

async function register(name, email, password, referralCode = '') {
    const button = qs('register-btn');
    setLoading(button, 'Creating account...');
    clearAuthFormError();
    try {
        const clientSignals = await getClientSignals();
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                email,
                password,
                referralCode: normalizeReferralCode(referralCode),
                deviceFingerprint: clientSignals.deviceFingerprint,
                browserFingerprint: clientSignals.browserFingerprint
            }),
            credentials: 'include'
        });
        if (!response.ok) throw new Error(await response.text());
        await response.json();
        clearAuthFormError();
        showToast('Account created successfully. Please login.', 'success');
        qs('register-form').reset();
        fillReferralFieldFromLanding(Boolean(state.pendingReferralCode));
        setAuthMode('login');
    } catch (err) {
        showAuthFormError(err.message || 'Registration failed');
    } finally {
        resetLoading(button);
    }
}

async function logout() {
    try {
        const response = await fetch('/api/logout', { credentials: 'include' });
        if (!response.ok) throw new Error('Logout failed');
        state.currentUser = null;
        state.orders = [];
        state.completedOrders = [];
        state.numberHistory = [];
        state.otpNotificationKeys = new Set();
        state.hiddenCancelledOrderIds = new Set();
        state.paymentRequests = [];
        state.historyView = 'activations';
        state.numberHistorySearch = '';
        state.activeOrder = null;
        stopOrderIntervals();
        stopInlineOrderPolling();
        stopInlineOrderTimers();
        hideHeaderQuickMenu();
        state.activeOrder = null;
        stopOrderIntervals();
        stopInlineOrderPolling();
        stopInlineOrderTimers();
        if (state.adminRefreshInterval) window.clearInterval(state.adminRefreshInterval);
        state.adminRefreshInterval = null;
        if (state.paymentHistoryRefreshInterval) window.clearInterval(state.paymentHistoryRefreshInterval);
        state.paymentHistoryRefreshInterval = null;
        if (state.liveUserRefreshInterval) window.clearInterval(state.liveUserRefreshInterval);
        state.liveUserRefreshInterval = null;
        state.lastPendingCount = 0;
        stopAdminAlertLoop();
        closeModal('payment-modal');
        hidePaymentTopAlert();
        closeModal('login-prompt');
        syncGuestBrowsingState();
        const numberHistorySearchInput = qs('number-history-search');
        if (numberHistorySearchInput) numberHistorySearchInput.value = '';
        qs('number-history-section')?.classList.add('hidden');
        syncNumberHistoryAction([]);
        qs('payment-history-section')?.classList.add('hidden');
        syncSidebarPendingPayment([]);
        qs('admin-panel')?.classList.add('hidden');
        showToast('Logged out', 'success');
    } catch (err) {
        showToast(err.message || 'Logout failed', 'error');
    }
}

async function orderCountry(name, id) {
    if (!state.currentUser) {
        openAuthModal('login');
        return;
    }
    if (!canOrderCurrentService()) {
        showToast('This service is available for browsing only right now.', 'error');
        return;
    }
    const selectedService = state.currentService;
    const selectedCountry = state.allCountries.find((country) => String(country.countryId) === String(id));
    const currentBalance = Number(state.currentUser.balance || 0);
    const requiredBalance = Number(selectedCountry?.price || 0);
    if (currentBalance <= 0 || (requiredBalance > 0 && currentBalance < requiredBalance)) {
        showToast('Low balance. Please add balance first.', 'info', 3200);
        return;
    }
    setHistoryView('activations', { scroll: true });
    setActivationFilter('waiting');
    const requestId = typeof window.crypto?.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const controller = new AbortController();
    const requestMeta = {
        controller,
        requestId,
        countryName: name,
        serviceType: selectedService,
        price: Number(selectedCountry?.price || 0),
        mutedAbortToast: false
    };
    state.purchaseRequests.set(requestId, requestMeta);
    state.purchaseInFlight = true;
    state.processingRequestsExpanded = false;
    updateProcessingModalState();
    const idempotencyKey = typeof window.crypto?.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    try {
        const response = await fetch('/api/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ countryName: name, countryId: Number(id), service: selectedService, idempotencyKey }),
            credentials: 'include',
            signal: controller.signal
        });
        if (!response.ok) throw new Error(await response.text());
        const order = await response.json();
        const optimisticOrder = {
            id: order.id,
            country: name,
            country_id: Number(id),
            service_type: selectedService,
            flag: selectedCountry?.flag || getCountryFlag(selectedCountry),
            phone_number: order.number || order.phone_number || 'Processing...',
            price: Number(selectedCountry?.price || 0),
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 25 * 60 * 1000).toISOString(),
            cancel_available_at: new Date(Date.now() + 17 * 1000).toISOString(),
            order_status: 'pending',
            status: 'pending',
            otp_received: false
        };
        state.purchaseRequests.delete(requestId);
        state.purchaseInFlight = state.purchaseRequests.size > 0;
        updateProcessingModalState();
        if (optimisticOrder) {
            ensureOrderCardVisible(optimisticOrder);
        }
        showToast('Number purchased successfully', 'success');
        await refreshUserInfo();
        if (optimisticOrder) {
            ensureOrderCardVisible(optimisticOrder);
        }
    } catch (err) {
        if (err?.name === 'AbortError') {
            if (!requestMeta.mutedAbortToast) {
                showToast('Purchase request cancelled.', 'info');
            }
            return;
        }
        const message = err.message || 'Order failed';
        if (/balance|wallet|insufficient/i.test(message)) {
            showToast('Low balance. Please add balance first.', 'info', 3200);
            return;
        }
        showToast(message, 'error');
    } finally {
        if (state.purchaseRequests.has(requestId)) {
            state.purchaseRequests.delete(requestId);
            state.purchaseInFlight = state.purchaseRequests.size > 0;
            updateProcessingModalState();
        }
    }
}

async function buyTierNumber(name, id, tierNumber, providerId) {
    if (!state.currentUser) {
        openAuthModal('login');
        return;
    }
    if (!canOrderCurrentService()) {
        showToast('This service is available for browsing only right now.', 'error');
        return;
    }
    const selectedService = state.currentService;
    const cachedTiers = state.tierCache.get(String(id));
    const tierInfo = Array.isArray(cachedTiers) ? cachedTiers.find((t) => String(t.tierNumber) === String(tierNumber)) : null;
    const lockedProviderId = providerId != null ? Number(providerId) : Number(tierInfo?.providerId);
    const currentBalance = Number(state.currentUser.balance || 0);
    const requiredBalance = Number(tierInfo?.price || 0);
    if (currentBalance <= 0 || (requiredBalance > 0 && currentBalance < requiredBalance)) {
        showToast('Low balance. Please add balance first.', 'info', 3200);
        return;
    }
    setHistoryView('activations', { scroll: true });
    setActivationFilter('waiting');
    const idempotencyKey = typeof window.crypto?.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    try {
        const response = await fetch('/api/order/tier', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                countryName: name,
                countryId: Number(id),
                service: selectedService,
                tierNumber: Number(tierNumber),
                providerId: Number.isFinite(lockedProviderId) ? lockedProviderId : undefined,
                idempotencyKey
            }),
            credentials: 'include'
        });
        if (!response.ok) throw new Error(await response.text());
        const order = await response.json();
        state.orderTierMeta.set(String(order.id), {
            service: selectedService,
            countryId: Number(id),
            countryName: name,
            tierNumber: Number(tierNumber),
            nextTierNumber: order.nextTierNumber || null
        });
        const optimisticOrder = {
            id: order.id,
            country: name,
            country_id: Number(id),
            service_type: selectedService,
            flag: state.allCountries.find((c) => String(c.countryId) === String(id))?.flag,
            phone_number: order.number || order.phone_number || 'Processing...',
            price: requiredBalance,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 25 * 60 * 1000).toISOString(),
            cancel_available_at: new Date(Date.now() + 17 * 1000).toISOString(),
            order_status: 'pending',
            status: 'pending',
            otp_received: false
        };
        ensureOrderCardVisible(optimisticOrder);
        showToast(`Number purchased (Tier ${tierNumber})`, 'success');
        await refreshUserInfo();
        ensureOrderCardVisible(optimisticOrder);
    } catch (err) {
        const message = err.message || 'Order failed';
        if (/balance|wallet|insufficient/i.test(message)) {
            showToast('Low balance. Please add balance first.', 'info', 3200);
            return;
        }
        showToast(message, 'error');
    }
}

async function retryNextTier(orderId) {
    const meta = state.orderTierMeta.get(String(orderId));
    if (!meta || !meta.nextTierNumber) {
        showToast('No more series available for this country.', 'info');
        return;
    }
    try {
        const cancelResponse = await fetch(`/api/orders/${orderId}/cancel`, { method: 'POST', credentials: 'include' });
        const cancelMessage = await cancelResponse.text();
        if (!cancelResponse.ok) throw new Error(cancelMessage);
        suppressCancelledOrderInDashboard(orderId);
        if (state.activeOrder && String(state.activeOrder.id) === String(orderId)) {
            closeOrderModal();
        }
        renderActiveOrders(state.orders);
        await refreshWalletBalanceSilently({ showIncreaseToast: false });
        // Fetch a fresh tier list right before buying so the next tier's providerId is current,
        // since SMS Bower's series/providers can change between the original page load and now.
        state.tierCache.delete(String(meta.countryId));
        let nextProviderId = null;
        try {
            const data = await fetchJSON(`/api/tiers/${encodeURIComponent(meta.service)}/${encodeURIComponent(meta.countryId)}`);
            const freshTiers = Array.isArray(data?.tiers) ? data.tiers : [];
            state.tierCache.set(String(meta.countryId), freshTiers);
            const nextTier = freshTiers.find((t) => Number(t.tierNumber) === Number(meta.nextTierNumber));
            nextProviderId = nextTier?.providerId ?? null;
        } catch {
            nextProviderId = null;
        }
        await buyTierNumber(meta.countryName, meta.countryId, meta.nextTierNumber, nextProviderId);
    } catch (err) {
        showToast(err.message || 'Could not switch series, please try again.', 'error');
    }
}

function updateProcessingModalState() {
    const wrap = qs('processing-orders-wrap');
    const summary = qs('processing-orders-summary');
    const list = qs('processing-orders-list');
    const cancelButton = qs('processing-orders-cancel');
    if (!wrap || !summary || !list) return;
    const activeRequests = [...state.purchaseRequests.values()];
    const requestCount = activeRequests.length;
    const shouldShowInlineProcessing = state.historyView === 'activations' && Boolean(state.currentUser);
    if (!shouldShowInlineProcessing) {
        wrap.classList.add('hidden');
        list.classList.add('hidden');
        cancelButton?.classList.add('hidden');
        summary.setAttribute('aria-expanded', 'false');
        return;
    }
    if (!requestCount) {
        wrap.classList.add('hidden');
        list.innerHTML = '';
        state.processingRequestsExpanded = false;
        cancelButton?.classList.add('hidden');
        summary.setAttribute('aria-expanded', 'false');
        return;
    }
    wrap.classList.remove('hidden');
    summary.textContent = `${requestCount} ${requestCount === 1 ? 'number' : 'numbers'} in processing ${state.processingRequestsExpanded ? '▼' : '▶'}`;
    summary.setAttribute('aria-expanded', String(state.processingRequestsExpanded));
    list.innerHTML = activeRequests.map((entry) => `
        <div class="processing-inline-row">
            <div class="processing-inline-service">${escapeHtml(getServiceMeta(entry.serviceType).label)}</div>
            <div class="processing-inline-country">${escapeHtml(entry.countryName)}</div>
            <div class="processing-inline-status">Processing...</div>
        </div>
    `).join('');
    list.classList.toggle('hidden', !state.processingRequestsExpanded);
    cancelButton?.classList.toggle('hidden', !state.processingRequestsExpanded);
}

function cancelInFlightPurchases() {
    if (!state.purchaseRequests.size) {
        updateProcessingModalState();
        return;
    }

    state.purchaseRequests.forEach((requestMeta) => {
        requestMeta.mutedAbortToast = true;
        try {
            requestMeta.controller.abort();
        } catch {
        }
    });
    showToast('Running purchase requests cancelled.', 'info');
}

function resolveOrderActionId(orderId) {
    if (orderId != null && orderId !== '') return Number(orderId);
    if (state.activeOrder?.id != null) return Number(state.activeOrder.id);
    return null;
}

async function completeActiveOrder(orderId) {
    const targetOrderId = resolveOrderActionId(orderId);
    if (!targetOrderId) return;
    try {
        const response = await fetch(`/api/orders/${targetOrderId}/complete`, { method: 'POST', credentials: 'include' });
        if (!response.ok) throw new Error(await response.text());
        showToast('Order completed', 'success');
        const existingOrder = getOrderFromState(targetOrderId) || state.activeOrder;
        upsertOrderInState({
            ...(existingOrder || { id: targetOrderId }),
            order_status: 'completed',
            status: 'completed',
            completed_at: new Date().toISOString()
        });
        if (state.activeOrder && String(state.activeOrder.id) === String(targetOrderId)) {
            closeOrderModal();
        }
        // Instantly remove from the view; do NOT refresh from server to avoid flicker
        state.orders = state.orders.filter(order => String(order.id) !== String(targetOrderId));
        renderActiveOrders(state.orders);
        updateActivationSummaryLine();
        await loadNumberHistory();
        setHistoryView(state.historyView);
        // await refreshUserInfo(); // Removed to prevent order reappearing
    } catch (err) {
        showToast(err.message || 'Could not complete order', 'error');
    }
}

async function cancelActiveOrder(orderId) {
    const targetOrderId = resolveOrderActionId(orderId);
    if (!targetOrderId) return;
    const shouldUpdateModal = Boolean(state.activeOrder && String(state.activeOrder.id) === String(targetOrderId));
    setOrderCancelPending(targetOrderId, true);
    setOrderOtpFlowBlocked(targetOrderId, true);
    if (shouldUpdateModal) {
        stopOrderIntervals();
    }
    refreshOrderHotfixViews(targetOrderId);
    try {
        const response = await fetch(`/api/orders/${targetOrderId}/cancel`, { method: 'POST', credentials: 'include' });
        const message = await response.text();
        if (!response.ok) throw new Error(message);
        setOrderCancelPending(targetOrderId, false);
        showToast(message || 'Order cancelled & refunded', 'success');
        suppressCancelledOrderInDashboard(targetOrderId);
        if (state.activeOrder && String(state.activeOrder.id) === String(targetOrderId)) {
            closeOrderModal();
        }
        // Instantly remove from the view; do NOT refresh from server to avoid flicker
        renderActiveOrders(state.orders);
        updateActivationSummaryLine();
        await loadNumberHistory();
        setHistoryView(state.historyView);
        await refreshWalletBalanceSilently({ showIncreaseToast: false });
    } catch (err) {
        setOrderCancelPending(targetOrderId, false);
        setOrderOtpFlowBlocked(targetOrderId, false);
        try {
            await refreshActiveOrderState(targetOrderId, { updateModal: shouldUpdateModal });
            if (shouldUpdateModal && state.activeOrder && String(state.activeOrder.id) === String(targetOrderId)) {
                startActiveOrderIntervals(state.activeOrder);
            }
        } catch {
            refreshOrderHotfixViews(targetOrderId);
        }
        showToast(err.message || 'Cancel failed', 'error');
    }
}

async function handleTransactionAction(txId, action) {
    const actionLabel = action === 'approve' ? 'approve' : 'cancel';
    const confirmMessage = action === 'approve'
        ? 'Approve this transaction and add balance to the user?'
        : 'Cancel this transaction without adding funds?';
    if (!window.confirm(confirmMessage)) return;
    try {
        const response = await fetch(`/api/admin/transactions/${txId}/${actionLabel}`, {
            method: 'POST',
            credentials: 'include'
        });
        if (!response.ok) throw new Error(await response.text());
        showToast(action === 'approve' ? 'Payment approved successfully' : 'Payment cancelled successfully', 'success');
        await loadAdminData();
        if (state.currentUser) {
            await refreshUserInfo();
        }
    } catch (err) {
        showToast(err.message || 'Transaction update failed', 'error');
    }
}

async function handlePaymentRequestAction(requestId, action) {
    const endpointAction = action === 'approve' ? 'approve' : 'reject';
    const confirmMessage = action === 'approve'
        ? 'Approve this payment request and add balance to the user?'
        : 'Reject this payment request without adding funds?';
    if (!window.confirm(confirmMessage)) return;
    try {
        const response = await fetch(`/api/admin/payment-requests/${requestId}/${endpointAction}`, {
            method: 'POST',
            credentials: 'include'
        });
        if (!response.ok) throw new Error(await response.text());
        showToast(action === 'approve' ? 'Payment request approved successfully' : 'Payment request rejected successfully', 'success');
        if (state.currentUser) {
            await refreshUserInfo();
        } else {
            await loadAdminData();
            await loadPaymentHistory();
        }
    } catch (err) {
        showToast(err.message || 'Payment request update failed', 'error');
    }
}

function openScreenshotModal({ image, user, email, amount, status }) {
    qs('screenshot-preview').src = image;
    qs('screenshot-preview').alt = `${user} payment proof`;
    qs('screenshot-user').textContent = user;
    qs('screenshot-email').textContent = email;
    qs('screenshot-amount').textContent = amount;
    qs('screenshot-status').textContent = status;
    openModal('screenshot-modal');
}

function copyText(text) {
    navigator.clipboard.writeText(text)
        .then(() => showToast('Copied successfully', 'success'))
        .catch(() => showToast('Copy failed', 'error'));
}

function copyTextWithFeedback(button, text, successLabel = 'Copied ✓') {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
        showToast('Nothing to copy', 'error');
        return;
    }
    if (button && !button.dataset.copyOriginalLabel) {
        button.dataset.copyOriginalLabel = button.textContent || 'Copy Referral Link';
    }
    navigator.clipboard.writeText(normalizedText)
        .then(() => {
            if (button) {
                button.textContent = successLabel;
                window.setTimeout(() => {
                    button.textContent = button.dataset.copyOriginalLabel || 'Copy Referral Link';
                }, 1800);
            }
            showToast(successLabel, 'success');
        })
        .catch(() => showToast('Copy failed', 'error'));
}

function fillReferralFieldFromLanding(force = false) {
    const referralInput = qs('reg-referral');
    const referralNote = qs('referral-prefill-note');
    if (!referralInput) return;
    if (force) {
        referralInput.value = state.pendingReferralCode || '';
    } else if (state.pendingReferralCode && !String(referralInput.value || '').trim()) {
        referralInput.value = state.pendingReferralCode;
    }
    if (referralNote) {
        referralNote.classList.toggle('hidden', !state.pendingReferralCode);
    }
}

function renderReferralProgram(program = null) {
    const referralLinkInput = qs('referral-link-input');
    const referralCodeChip = qs('referral-code-chip');
    const referralHint = qs('referral-link-hint');
    const totalCount = qs('referral-total-count');
    const rewardedCount = qs('referral-rewarded-count');
    const totalReward = qs('referral-total-reward');
    const activityList = qs('referral-activity-list');
    const copyButton = qs('copy-referral-link-btn');
    const loginCta = qs('referral-login-cta');
    if (!referralLinkInput || !referralCodeChip || !referralHint || !totalCount || !rewardedCount || !totalReward || !activityList || !copyButton || !loginCta) {
        return;
    }
    const referrals = Array.isArray(program?.referrals) ? program.referrals : [];
    const stats = program?.stats || {};
    const displayCode = program?.referralCode || state.pendingReferralCode || '—';
    referralCodeChip.textContent = `${program?.referralCode ? 'Code' : state.pendingReferralCode ? 'Invite Code' : 'Code'}: ${displayCode}`;
    referralLinkInput.value = program?.referralLink || '';
    referralHint.textContent = program?.referralLink
        ? 'Copy and share your referral link with friends. Bonus is added only once per qualified referral.'
        : state.pendingReferralCode
            ? `Invite code ${state.pendingReferralCode} is already applied on the signup form.`
            : 'Login to get your personal referral link.';
    totalCount.textContent = String(Number(stats.totalReferrals || 0));
    rewardedCount.textContent = String(Number(stats.rewardedCount || 0));
    totalReward.textContent = formatMoneyPrecise(Number(stats.totalRewards || 0));
    copyButton.disabled = !program?.referralLink;
    copyButton.textContent = copyButton.dataset.copyOriginalLabel || 'Copy Referral Link';
    loginCta.classList.toggle('hidden', Boolean(state.currentUser));
    activityList.innerHTML = referrals.length
        ? referrals.map((entry) => {
            const statusMeta = getReferralStatusMeta(entry);
            return `
                <div class="referral-activity-item">
                    <div class="referral-activity-top">
                        <div class="referral-activity-name">${escapeHtml(entry.referred_name || entry.referred_email || 'Pending referral')}</div>
                        <span class="referral-status-pill ${escapeAttr(statusMeta.statusKey)}">${escapeHtml(statusMeta.label)}</span>
                    </div>
                    <div class="referral-activity-meta">${escapeHtml(entry.referred_email || 'Signup pending')}
                        <br>${escapeHtml(statusMeta.details)}
                        <br>${escapeHtml(formatRelativeTime(entry.created_at))}
                    </div>
                </div>
            `;
        }).join('')
        : `<div class="referral-activity-empty">${escapeHtml(state.currentUser ? 'Your referral activity will appear here after friends sign up through your link.' : 'Open signup, create your account, and your personal referral activity will appear here.')}</div>`;
}

async function loadReferralProgram(options = {}) {
    const { silent = false } = options;
    if (!state.currentUser) {
        state.referralProgram = null;
        renderReferralProgram(null);
        return null;
    }
    try {
        const program = await fetchJSON('/api/referral-program');
        state.referralProgram = program;
        renderReferralProgram(program);
        return program;
    } catch (err) {
        if (!silent) {
            showToast(err.message || 'Referral program unavailable', 'error');
        }
        return null;
    }
}

async function openReferralProgramModal() {
    renderReferralProgram(state.referralProgram);
    openModal('referral-program-modal');
    if (state.currentUser) {
        await loadReferralProgram({ silent: false });
    } else {
        renderReferralProgram(null);
    }
}

function openSupport() {
    const popup = window.open(SUPPORT_WHATSAPP_URL, '_blank', 'noopener,noreferrer');
    if (!popup) {
        window.location.assign(SUPPORT_WHATSAPP_URL);
    }
}

function showStartupMessages() {
    const params = new URLSearchParams(window.location.search);
    const googleError = params.get('google_error');
    state.pendingReferralCode = normalizeReferralCode(params.get('ref'));
    state.shouldOpenRegisterFromLanding = params.get('signup') === '1' || Boolean(state.pendingReferralCode);
    fillReferralFieldFromLanding(Boolean(state.pendingReferralCode));
    if (googleError) {
        showToast(`Google sign-in error: ${googleError.replace(/_/g, ' ')}`, 'error', 6000);
        params.delete('google_error');
        const newUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
        window.history.replaceState({}, document.title, newUrl);
    }
}

function handleReferralLanding() {
    fillReferralFieldFromLanding(Boolean(state.pendingReferralCode));
    if (!state.currentUser && state.shouldOpenRegisterFromLanding) {
        openAuthModal('register');
    }
}

function showTermsIfRequired() {
    if (!hasAcceptedTerms()) {
        openModal('terms-modal');
    }
}

function bindStaticEvents() {
    qs('mobile-menu-btn')?.addEventListener('click', () => updateSidebarVisibility(false));
    qs('sidebar-overlay')?.addEventListener('click', () => updateSidebarVisibility(true));
    qs('theme-toggle')?.addEventListener('click', toggleTheme);
    document.addEventListener('click', unlockBackgroundOtpSound, { once: true, capture: true });
    qsa('[data-support-trigger]').forEach((button) => {
        button.addEventListener('click', openSupport);
    });
    qs('show-login-tab').addEventListener('click', () => setAuthMode('login'));
    qs('show-register-tab').addEventListener('click', () => setAuthMode('register'));
    const submitLogin = async () => {
        await login(qs('login-email').value.trim(), qs('login-password').value);
    };
    qs('login-btn').addEventListener('click', submitLogin);
    ['login-email', 'login-password'].forEach((fieldId) => {
        qs(fieldId).addEventListener('keydown', async (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            await submitLogin();
        });
    });
    qs('register-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await register(qs('reg-name').value.trim(), qs('reg-email').value.trim(), qs('reg-password').value, qs('reg-referral')?.value.trim() || '');
    });
    qs('google-login-btn').addEventListener('click', () => {
        const referralCode = normalizeReferralCode(qs('reg-referral')?.value || state.pendingReferralCode);
        window.location.href = referralCode ? `/auth/google?ref=${encodeURIComponent(referralCode)}` : '/auth/google';
    });
    qs('accept-terms-btn')?.addEventListener('click', acceptTermsAndContinue);
    qs('close-payment-modal')?.addEventListener('click', () => closeModal('payment-modal'));
    qs('close-payment-top-alert')?.addEventListener('click', hidePaymentTopAlert);
    qsa('[data-payment-method-tab]').forEach((button) => {
        button.addEventListener('click', () => {
            setActivePaymentMethod(button.dataset.paymentMethodTab);
        });
    });
    qs('payment-screenshot-input')?.addEventListener('change', (event) => {
        const file = event.target.files?.[0];
        if (file && !validatePaymentProofFile(file)) {
            event.target.value = '';
            qs('payment-screenshot-name').textContent = 'Payment screenshot upload کریں';
            showPaymentFormError('Only JPG, JPEG, PNG, and WEBP payment proofs are allowed');
            return;
        }
        qs('payment-screenshot-name').textContent = file ? file.name : 'Payment screenshot upload کریں';
        if (file) clearPaymentFormError();
    });
    qs('addFundsForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = qs('submit-payment-btn');
        clearPaymentFormError();
        if (!state.currentUser) {
            openAuthModal('login');
            return;
        }
        const paymentMethod = qs('payment-method-input')?.value || 'easypaisa';
        const methodMeta = getPaymentMethodMeta(paymentMethod);
        const amount = Number(qs('payment-amount-input').value || 0);
        const transactionId = qs('payment-transaction-id-input')?.value.trim() || '';
        const note = qs('payment-note-input')?.value.trim() || '';
        const screenshotFile = qs('payment-screenshot-input')?.files?.[0];
        if (!amount || amount < methodMeta.minAmount) {
            showPaymentFormError(methodMeta.key === 'binance' ? 'Minimum Binance deposit is 1 USDT' : 'Minimum amount is 100 PKR');
            return;
        }
        if (methodMeta.transactionRequired && !transactionId) {
            showPaymentFormError('Binance transaction ID is required');
            return;
        }
        if (!screenshotFile) {
            showPaymentFormError('Screenshot upload is required');
            return;
        }
        if (!validatePaymentProofFile(screenshotFile)) {
            showPaymentFormError('Only JPG, JPEG, PNG, and WEBP payment proofs are allowed');
            return;
        }
        setLoading(button, methodMeta.key === 'binance' ? 'Submitting Binance receipt...' : 'Submitting payment...');
        try {
            const clientSignals = await getClientSignals();
            const formData = new FormData();
            formData.append('amount', String(amount));
            formData.append('payment_method', methodMeta.key);
            formData.append('screenshot', screenshotFile);
            if (transactionId) {
                formData.append('transaction_id', transactionId);
            }
            if (note) {
                formData.append('note', note);
            }
            formData.append('deviceFingerprint', clientSignals.deviceFingerprint);
            formData.append('browserFingerprint', clientSignals.browserFingerprint);
            const response = await fetch('/api/request-payment', {
                method: 'POST',
                body: formData,
                credentials: 'include'
            });
            if (!response.ok) throw new Error(await response.text());
            const result = await response.json();
            updatePaymentSuccessView(methodMeta.key, result || {});
            qs('payment-form-view')?.classList.add('hidden');
            qs('payment-success-view')?.classList.remove('hidden');
            if (state.currentUser) {
                await loadPaymentHistory();
            }
            if (state.currentUser && state.currentUser.isAdmin) {
                await loadAdminData();
            }
        } catch (err) {
            showPaymentFormError(err.message || 'Could not submit payment request');
        } finally {
            resetLoading(button);
        }
    });
    qs('country-search').addEventListener('input', renderCountries);
    qs('service-search')?.addEventListener('input', filterServiceButtons);
    qs('number-history-search')?.addEventListener('input', (event) => {
        state.numberHistorySearch = String(event.target?.value || '');
        renderNumberHistory(state.numberHistory);
    });
    qs('admin-users-search')?.addEventListener('input', (event) => {
        state.adminUsersSearch = String(event.target?.value || '');
        syncAdminUsersList();
    });
    qsa('[data-history-filter]').forEach((button) => {
        button.addEventListener('click', () => setActivationFilter(button.dataset.historyFilter));
    });
    qs('processing-orders-summary')?.addEventListener('click', () => {
        if (!state.purchaseRequests.size) return;
        state.processingRequestsExpanded = !state.processingRequestsExpanded;
        syncWaitingOrdersVisibility();
        updateProcessingModalState();
    });
    qsa('[data-filter]').forEach((button) => {
        button.addEventListener('click', () => {
            state.currentFilter = button.dataset.filter;
            qsa('[data-filter]').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === state.currentFilter));
            renderCountries();
        });
    });
    qsa('[data-admin-tab]').forEach((button) => {
        button.addEventListener('click', () => setAdminTab(button.dataset.adminTab));
    });
    initAdminAccordion();
    qs('service-grid')?.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-service]');
        if (!button) return;
        state.currentService = button.dataset.service;
            syncServiceButtons();
            qs('country-search').value = '';
            state.currentFilter = 'all';
            qsa('[data-filter]').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
            await loadCountries();
    });
    document.addEventListener('click', (event) => {
        if (!event.target.closest('#account-menu-root')) {
            hideAccountDetails();
        }
        if (!event.target.closest('#header-menu-root')) {
            hideHeaderQuickMenu();
        }
    });
    document.addEventListener('click', async (event) => {
        const actionTarget = event.target.closest('[data-action]');
        if (!actionTarget) return;
        const { action } = actionTarget.dataset;
        if (action === 'toggle-account-menu') {
            toggleAccountMenu();
            return;
        }
        if (action === 'toggle-header-menu') {
            toggleHeaderQuickMenu();
            return;
        }
        if (action === 'show-phone-history') {
            hideHeaderQuickMenu();
            setActivationFilter('waiting');
            setHistoryView('activations', { scroll: true });
            return;
        }
        if (action === 'show-number-history') {
            hideHeaderQuickMenu();
            setHistoryView('numbers', { scroll: true });
            return;
        }
        if (action === 'show-payment-history') {
            hideHeaderQuickMenu();
            setHistoryView('payments', { scroll: true });
            return;
        }
        if (action === 'open-whatsapp-guide-modal') {
            hideHeaderQuickMenu();
            openModal('whatsapp-guide-modal');
            return;
        }
        if (action === 'open-referral-modal') {
            hideAccountDetails();
            hideHeaderQuickMenu();
            await openReferralProgramModal();
            return;
        }
        if (action === 'toggle-admin-accordion') {
            initAdminAccordion();
            setActiveAdminAccordion(actionTarget.dataset.adminAccordionId);
            return;
        }
        if (action === 'refresh-admin-panel') {
            if (state.currentUser?.isAdmin) {
                await loadAdminData();
                if (isAdminNumberManagementOpen()) {
                    await loadAdminNumberManagement({ force: true });
                }
            }
            return;
        }
        if (action === 'toggle-history-view') {
            setHistoryView(state.historyView === 'activations' ? 'payments' : 'activations', { scroll: true });
            return;
        }
        if (action === 'open-auth-modal') {
            openAuthModal('login');
            return;
        }
        if (action === 'open-auth-register-modal') {
            closeModal('referral-program-modal');
            openAuthModal('register');
            return;
        }
        if (action === 'copy-account-number') {
            copyText('03439898333');
            return;
        }
        if (action === 'copy-payment-target') {
            copyText(actionTarget.dataset.copyValue || '');
            return;
        }
        if (action === 'buy-country') {
            await orderCountry(actionTarget.dataset.countryName, actionTarget.dataset.countryId);
            return;
        }
        if (action === 'toggle-tiers') {
            await toggleTierPanel(actionTarget.dataset.countryId, actionTarget.dataset.countryName);
            return;
        }
        if (action === 'buy-tier') {
            await buyTierNumber(actionTarget.dataset.countryName, actionTarget.dataset.countryId, actionTarget.dataset.tierNumber, actionTarget.dataset.providerId);
            return;
        }
        if (action === 'retry-next-tier') {
            await retryNextTier(actionTarget.dataset.orderId);
            return;
        }
        if (action === 'cancel-purchase-progress') {
            cancelInFlightPurchases();
            return;
        }
        if (action === 'view-order') {
            await openOrderModal(actionTarget.dataset.orderId);
            return;
        }
        if (action === 'copy-number') {
            copyText(actionTarget.dataset.value || '');
            return;
        }
        if (action === 'copy-referral-link') {
            copyTextWithFeedback(actionTarget, state.referralProgram?.referralLink || qs('referral-link-input')?.value || '', 'Copied ✓');
            return;
        }
        if (action === 'view-screenshot') {
            openScreenshotModal({
                image: actionTarget.dataset.image,
                user: actionTarget.dataset.user,
                email: actionTarget.dataset.email,
                amount: actionTarget.dataset.amount,
                status: actionTarget.dataset.status
            });
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
        if (action === 'complete-order') {
            await completeActiveOrder(actionTarget.dataset.orderId);
            return;
        }
        if (action === 'cancel-order') {
            await cancelActiveOrder(actionTarget.dataset.orderId);
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
            return;
        }
        if (action === 'close-order-inline') {
            closeOrderModal();
            return;
        }
        if (action === 'copy-otp') {
            if (state.activeOrder?.otp_code) copyText(state.activeOrder.otp_code);
            return;
        }
        if (action === 'open-account-details') {
            openAccountDetails();
            return;
        }
        if (action === 'hide-account-details') {
            hideAccountDetails();
            return;
        }
        if (action === 'open-payment-modal') {
            hideAccountDetails();
            hideHeaderQuickMenu();
            openPaymentModal();
            return;
        }
        if (action === 'logout') {
            hideAccountDetails();
            await logout();
            return;
        }
        if (action === 'check-otp-now') {
            if (state.activeOrder) await pollOtp(state.activeOrder.id, false);
            return;
        }
        if (action === 'copy-order-number') {
            if (state.activeOrder?.phone_number) copyText(state.activeOrder.phone_number);
            return;
        }
    });
    qsa('[data-close-modal]').forEach((button) => {
        button.addEventListener('click', () => {
            if (button.dataset.closeModal === 'order-modal') {
                closeOrderModal();
                return;
            }
            closeModal(button.dataset.closeModal);
        });
    });
    qsa('.app-modal').forEach((modal) => {
        modal.addEventListener('click', (event) => {
            if (event.target === modal) {
                if (modal.id === 'terms-modal') {
                    return;
                }
                closeModal(modal.id);
                if (modal.id === 'order-modal') {
                    closeOrderModal();
                }
            }
        });
    });
    window.addEventListener('resize', () => {
        if (state.purchaseRequests.size) {
            updateProcessingModalState();
        }
    });
    window.addEventListener('focus', () => {
        refreshOrdersOnVisibilityRestore();
    });
    document.addEventListener('visibilitychange', () => {
        refreshOrdersOnVisibilityRestore();
    });
    window.addEventListener('beforeunload', () => {
        stopOrderIntervals();
        stopInlineOrderPolling();
        stopInlineOrderTimers();
        if (state.adminRefreshInterval) window.clearInterval(state.adminRefreshInterval);
        if (state.paymentHistoryRefreshInterval) window.clearInterval(state.paymentHistoryRefreshInterval);
        if (state.liveUserRefreshInterval) window.clearInterval(state.liveUserRefreshInterval);
        stopAdminAlertLoop();
        try {
            backgroundOtpSound.pause();
            backgroundOtpSound.currentTime = 0;
        } catch {
        }
    });
}

async function init() {
    initializeTheme();
    await loadServiceIconMap();
    await loadAvailableServices();
    updateHero();
    setAdminTab(state.currentAdminTab);
    setActivationFilter(state.activationFilter);
    setAuthMode('login');
    bindStaticEvents();
    showStartupMessages();
    renderReferralProgram(null);
    syncGuestBrowsingState();
    syncBalanceBannerVisibility();
    showTermsIfRequired();
    await loadCountries();
    await checkAuth();
    handleReferralLanding();
}

document.addEventListener('DOMContentLoaded', init);
document.addEventListener('DOMContentLoaded', init);
