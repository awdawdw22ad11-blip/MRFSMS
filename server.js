require('dotenv').config();

const express = require('express');
const session = require('express-session');
const multer = require('multer');

// PostgreSQL session store (SAFE)
let pgSession = null;

try {
    pgSession = require('connect-pg-simple')(session);
} catch (err) {
    console.error("\u{274C} connect-pg-simple not loaded:", err.message);
}

async function createPaymentRequestSubmission(req) {
    const requestedPaymentMethod = String(req.body.payment_method || '').trim().toLowerCase();
    if (requestedPaymentMethod && !['easypaisa', 'binance'].includes(requestedPaymentMethod)) {
        throw new Error('Unsupported payment method');
    }
    const methodConfig = getPaymentMethodConfig(requestedPaymentMethod);
    const amount = roundMoney(Number.parseFloat(req.body.amount));
    if (!Number.isFinite(amount) || amount < methodConfig.minimumAmount) {
        throw new Error(methodConfig.paymentMethod === 'binance'
            ? `Minimum Binance deposit is ${BINANCE_MIN_DEPOSIT_USDT} USDT`
            : `Minimum amount ${EASYPAISA_MIN_DEPOSIT_PKR} PKR`);
    }
    if (paymentRateLimiter[req.session.userId] && Date.now() - paymentRateLimiter[req.session.userId] < 60000) {
        throw new Error('Please wait 1 minute between requests');
    }
    const user = await findUserById(req.session.userId);
    if (!user) {
        throw new Error('User not found');
    }
    const transactionId = normalizePaymentReference(req.body.transaction_id);
    const screenshot = req.file ? req.file.filename : null;
    if (!screenshot) {
        throw new Error('Payment screenshot is required');
    }
    if (!(await isValidUploadedPaymentProof(screenshot))) {
        throw new Error('Invalid payment proof file');
    }
    if (methodConfig.requiresTransactionId && !transactionId) {
        throw new Error(`${methodConfig.transactionLabel} is required`);
    }
    const proofHash = await hashUploadedFile(screenshot);
    if (proofHash) {
        const duplicateProof = await queryOne('SELECT id FROM payment_requests WHERE proof_hash = $1 LIMIT 1', [proofHash]);
        if (duplicateProof) {
            throw new Error('This payment proof has already been submitted');
        }
    }
    const deviceFingerprint = normalizeDeviceFingerprint(req.body.deviceFingerprint);
    const browserFingerprint = normalizeBrowserFingerprint(req.body.browserFingerprint);
    const note = String(req.body.note || '').trim().slice(0, 500) || null;
    const creditedAmount = roundMoney(methodConfig.creditedAmountCalculator(amount));
    await queryRun(
        `
            INSERT INTO payment_requests (
                user_id,
                user_email,
                user_name_snapshot,
                payment_method,
                amount,
                amount_currency,
                credit_amount,
                transaction_id,
                screenshot,
                note,
                status,
                request_ip,
                device_fingerprint,
                browser_fingerprint,
                proof_hash
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `,
        [
            req.session.userId,
            user.email,
            String(user.name || user.email || '').trim() || null,
            methodConfig.paymentMethod,
            amount,
            methodConfig.amountCurrency,
            creditedAmount,
            transactionId || null,
            screenshot,
            note,
            'pending',
            getRequestClientIp(req) || null,
            deviceFingerprint || null,
            browserFingerprint || null,
            proofHash || null
        ]
    );
    paymentRateLimiter[req.session.userId] = Date.now();
    return {
        success: true,
        paymentMethod: methodConfig.paymentMethod,
        amount,
        amountCurrency: methodConfig.amountCurrency,
        creditAmount: creditedAmount,
        paymentLabel: getPaymentRequestAmountSummary({
            payment_method: methodConfig.paymentMethod,
            amount,
            amount_currency: methodConfig.amountCurrency,
            credit_amount: creditedAmount
        })
    };
}

async function handlePaymentRequestSubmission(req, res) {
    const uploadedScreenshot = req.file ? req.file.filename : null;
    try {
        const result = await createPaymentRequestSubmission(req);
        res.json(result);
    } catch (err) {
        if (uploadedScreenshot) {
            await removeUploadedFile(uploadedScreenshot);
        }
        if (err && err.code === '23505') {
            return res.status(400).send('This transaction ID has already been submitted');
        }
        res.status(400).send(formatSafeError(err));
    }
}

// Nodemailer (SAFE)
let nodemailer = null;

try {
    nodemailer = require('nodemailer');
} catch (err) {
    console.error("\u{274C} nodemailer not loaded:", err.message);
}

// Axios (SAFE)
let axios = null;

try {
    axios = require('axios');
} catch (err) {
    console.error("\u{274C} axios not loaded:", err.message);
    axios = {
        get: async () => {
            throw new Error('axios is not available');
        }
    };
}
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
let bcrypt = null;

try {
    bcrypt = require('bcryptjs');
} catch (err) {
    console.error("\u{274C} bcryptjs not loaded:", err.message);
}

const { Pool } = require('pg');
const passport = require('passport');
let createAuthRouter = null;

try {
    createAuthRouter = require('./routes/auth');
} catch (err) {
    console.error("\u{274C} auth routes not loaded:", err.message);
}

const app = express();

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const PUBLIC_DIRECTORY_PATH = path.join(__dirname, 'public');
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
const PAYMENT_PROOF_ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const PAYMENT_PROOF_ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EASYPAISA_MIN_DEPOSIT_PKR = 100;
const BINANCE_MIN_DEPOSIT_USDT = 1;
const BINANCE_UID = '1049681083';
const BINANCE_ACCOUNT_NAME = 'M3_Faisal_Bro';
const paymentProofStorage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
    filename: (_req, file, callback) => {
        const originalExtension = path.extname(String(file?.originalname || '').toLowerCase());
        const safeExtension = PAYMENT_PROOF_ALLOWED_EXTENSIONS.has(originalExtension) ? originalExtension : '.jpg';
        callback(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExtension}`);
    }
});
const upload = multer({
    storage: paymentProofStorage,
    limits: {
        fileSize: 5 * 1024 * 1024
    },
    fileFilter: (_req, file, callback) => {
        const originalExtension = path.extname(String(file?.originalname || '').toLowerCase());
        const mimeType = String(file?.mimetype || '').toLowerCase();
        if (!PAYMENT_PROOF_ALLOWED_EXTENSIONS.has(originalExtension) || !PAYMENT_PROOF_ALLOWED_MIME_TYPES.has(mimeType)) {
            return callback(new Error('Only JPG, JPEG, PNG, and WEBP payment proofs are allowed'));
        }
        callback(null, true);
    }
});
function paymentProofUpload(req, res, next) {
    upload.single('screenshot')(req, res, (err) => {
        if (!err) {
            return next();
        }
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).send('Payment proof must be 5 MB or smaller');
        }
        return res.status(400).send(formatSafeError(err, 'Payment proof upload failed'));
    });
}

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
if (!DATABASE_URL) {
    console.error('DATABASE_URL is missing. Starting without database connectivity.');
}

const RAW_SESSION_SECRET = String(process.env.SESSION_SECRET || '');
const SESSION_SECRET = RAW_SESSION_SECRET && RAW_SESSION_SECRET.length >= 32
    ? RAW_SESSION_SECRET
    : 'mrf-fallback-session-secret-change-me-now-please';
if (!RAW_SESSION_SECRET || RAW_SESSION_SECRET.length < 32) {
    console.error('SESSION_SECRET is missing or too short. Using fallback session secret.');
}

const SMSBOWER_API_KEY = process.env.SMSBOWER_API_KEY || 'CHANGE_THIS_API_KEY';
const SMSBOWER_URL = 'https://smsbower.page/stubs/handler_api.php';

const SMSBOWER_WA_SERVICE = 'wa';
const SMSBOWER_FB_SERVICE = 'fb';
const SMSBOWER_IG_SERVICE = 'ig';
const SMSBOWER_SNAPCHAT_SERVICE = 'fu';
const SMSBOWER_TIKTOK_SERVICE = 'lf';
const SMSBOWER_IMO_SERVICE = 'im';
const SMSBOWER_TINDER_SERVICE = 'oi';
const SMSBOWER_TWITTER_SERVICE = 'tw';
const SMSBOWER_AMAZON_SERVICE = 'am';
const SMSBOWER_ALIBABA_SERVICE = 'ab';
const SMSBOWER_CAREEM_SERVICE = 'ls';
const SMSBOWER_SPOTIFY_SERVICE = 'alj';
const SMSBOWER_OPENAI_SERVICE = 'dr';
const SMSBOWER_PAYPAL_SERVICE = 'ts';
const SMSBOWER_ALIEXPRESS_SERVICE = 'hx';
const SMSBOWER_WECHAT_SERVICE = 'wb';
const SMSBOWER_VIBER_SERVICE = 'vi';
const SMSBOWER_UBER_SERVICE = 'ub';
const SMSBOWER_MICROSOFT_SERVICE = 'mm';
const SMSBOWER_SIGNAL_SERVICE = 'bw';
const SMSBOWER_EASYPAY_SERVICE = 'rz';
const SMSBOWER_GOOGLE_SERVICE = 'go';

const EXPIRED_REFUND_MESSAGE = 'Time expired. Your money has been returned to your wallet.';
const ORDER_FINAL_STATUSES = new Set(['completed', 'cancelled', 'expired', 'expired_refunded', 'refunded']);
const ORDER_PROVIDER_WAITING_STATUS = 'STATUS_WAIT_CODE';
const ORDER_HOTFIX_AUDIT_PREFIX = '[ORDER_HOTFIX]';
const PROVIDER_AUDIT_PREFIX = '[PROVIDER_ANALYTICS]';
const PROVIDER_BALANCE_ACTION = 'getBalance';
const PROVIDER_BALANCE_CURRENCY = 'USD';
const PROVIDER_PKR_EXCHANGE_RATE = 280;
const PROVIDER_BALANCE_EPSILON = 0.0001;
const FINANCIAL_STATS_RESET_DATE = String(process.env.FINANCIAL_STATS_RESET_DATE || '2026-05-26').trim() || '2026-05-26';
const PROVIDER_RECONCILIATION_INTERVAL_MS = Math.max(60000, Number(process.env.PROVIDER_RECONCILIATION_INTERVAL_MS || 180000));
const SECURITY_MAX_CANCELLATIONS_PER_HOUR = Math.max(1, Number(process.env.SECURITY_MAX_CANCELLATIONS_PER_HOUR || 4));
const SECURITY_MAX_REFUNDS_PER_DAY = Math.max(1, Number(process.env.SECURITY_MAX_REFUNDS_PER_DAY || 8));
const SECURITY_MAX_SUSPICIOUS_ACTIONS = Math.max(1, Number(process.env.SECURITY_MAX_SUSPICIOUS_ACTIONS || 5));
const SECURITY_CANCEL_COOLDOWN_MINUTES = Math.max(5, Number(process.env.SECURITY_CANCEL_COOLDOWN_MINUTES || 30));
const SECURITY_AUTO_BLOCK_HOURS = Math.max(1, Number(process.env.SECURITY_AUTO_BLOCK_HOURS || 12));
const SECURITY_POST_CLOSE_POLL_LIMIT = Math.max(2, Number(process.env.SECURITY_POST_CLOSE_POLL_LIMIT || 3));
const ORDER_COOLDOWN_SECONDS = 30;
const REFERRAL_MIN_DEPOSIT_PKR = 170;
const REFERRAL_BONUS_PKR = 100;
const REFERRAL_SECURITY_MESSAGE = 'Referral bonus not allowed (security protection)';
const REFERRAL_LINK_FALLBACK_BASE = 'https://mrfsms.com';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = String(process.env.BASE_URL || process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || `${BASE_URL}/auth/google/callback`;
const APP_BASE_URL = BASE_URL;
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || '';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Admin';

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
const PASSWORD_RESET_TOKEN_TTL_MS = 1000 * 60 * 60;

let databasePoolEnabled = Boolean(DATABASE_URL);

function createDatabaseUnavailableError(message = 'Database is not configured') {
    const error = new Error(message);
    error.code = 'DATABASE_UNAVAILABLE';
    return error;
}

function createFallbackPool(message = 'Database is not configured') {
    return {
        query: async () => {
            throw createDatabaseUnavailableError(message);
        },
        connect: async () => ({
            query: async (sql) => {
                const normalizedSql = String(sql || '').trim().replace(/;$/, '').toUpperCase();
                if (normalizedSql === 'BEGIN' || normalizedSql === 'COMMIT' || normalizedSql === 'ROLLBACK') {
                    return { rows: [], rowCount: 0 };
                }
                throw createDatabaseUnavailableError(message);
            },
            release: () => {}
        }),
        end: async () => {}
    };
}

function createDatabasePool() {
    if (!DATABASE_URL) {
        databasePoolEnabled = false;
        return createFallbackPool('DATABASE_URL is not configured');
    }
    try {
        return new Pool({
            connectionString: DATABASE_URL,
            ssl: IS_PROD ? { rejectUnauthorized: false } : false,
            connectionTimeoutMillis: 10000
        });
    } catch (err) {
        databasePoolEnabled = false;
        console.error(`Database pool initialization failed: ${formatSafeError(err, 'Unknown database pool error')}`);
        return createFallbackPool(formatSafeError(err, 'Database pool initialization failed'));
    }
}

const pool = createDatabasePool();

function createMailTransporter() {
    if (!SMTP_HOST || !SMTP_FROM) {
        return null;
    }
    if (!nodemailer || typeof nodemailer.createTransport !== 'function') {
        console.error('Email transport disabled: nodemailer is not available.');
        return null;
    }
    try {
        return nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_SECURE,
            auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
        });
    } catch (err) {
        console.error(`Email transport initialization failed: ${formatSafeError(err, 'Unknown mail initialization error')}`);
        return null;
    }
}

const mailTransporter = createMailTransporter();

function createSessionStore() {
    if (!databasePoolEnabled) {
        console.error('Session store fallback enabled: database pool is not available.');
        return null;
    }
    if (!pgSession) {
        console.error('Session store fallback enabled: connect-pg-simple is not available.');
        return null;
    }
    try {
        return new pgSession({
            pool,
            tableName: 'user_sessions',
            createTableIfMissing: true
        });
    } catch (err) {
        console.error(`Session store initialization failed: ${formatSafeError(err, 'Unknown session store error')}`);
        return null;
    }
}

const sessionStore = createSessionStore();

const paymentRateLimiter = {};

async function removeUploadedFile(fileName) {
    const normalizedName = path.basename(String(fileName || '').trim());
    if (!normalizedName) return;
    const filePath = path.join(UPLOAD_DIR, normalizedName);
    try {
        await fs.promises.unlink(filePath);
    } catch (err) {
        if (err && err.code !== 'ENOENT') {
            console.warn(`Could not remove upload ${normalizedName}: ${err.message}`);
        }
    }
}

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.get(['/', '/index.html', '/dashboard'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/signup', (req, res) => {
    const params = new URLSearchParams(req.query || {});
    if (!params.get('signup')) {
        params.set('signup', '1');
    }
    const queryString = params.toString();
    return res.redirect(`/${queryString ? `?${queryString}` : ''}`);
});
app.use(express.static(PUBLIC_DIRECTORY_PATH, { index: false }));

app.use(session({
    ...(sessionStore ? { store: sessionStore } : {}),
    name: 'mrf.sid',
    secret: SESSION_SECRET,
    proxy: true,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    unset: 'destroy',
    cookie: {
        secure: 'auto',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 7
    }
}));

app.use(passport.initialize());
app.use(passport.session());

function normalizeUser(row) {
    if (!row) return null;
    return {
        ...row,
        balance: Number(row.balance || 0),
        is_admin: Boolean(row.is_admin),
        referralCode: row.referral_code,
        is_active: row.is_active,
        login_attempts: row.login_attempts,
        security_risk_score: Number(row.security_risk_score || 0),
        security_risk_status: String(row.security_risk_status || 'safe').trim().toLowerCase() || 'safe',
        security_blocked_until: row.security_blocked_until || null,
        security_block_reason: String(row.security_block_reason || '').trim() || null,
        security_blocked_at: row.security_blocked_at || null,
        security_risk_reset_at: row.security_risk_reset_at || null,
        latest_provider_loss_amount: Number(row.latest_provider_loss_amount || 0),
        total_provider_loss: Number(row.total_provider_loss || 0),
        confirmed_provider_loss_count: Number(row.confirmed_provider_loss_count || 0)
    };
}

function normalizeOrderStatus(row) {
    const rawStatus = String(row?.status || row?.order_status || '').toLowerCase();
    if (rawStatus === 'expired_refunded') return 'expired';
    if (rawStatus === 'refunded') return 'expired';
    if (rawStatus === 'completed_waiting_user_action') return 'active';
    if (rawStatus === 'otp_received') return 'active';
    if (rawStatus === 'retry_requested') return (row?.otp_received || String(row?.otp_code || '').trim()) ? 'active' : 'pending';
    if (rawStatus === 'active' && !row?.otp_received && !String(row?.otp_code || '').trim()) return 'pending';
    if (rawStatus === 'pending' && (row?.otp_received || String(row?.otp_code || '').trim())) return 'active';
    if (rawStatus === 'expired' || rawStatus === 'completed' || rawStatus === 'cancelled' || rawStatus === 'pending' || rawStatus === 'active') {
        return rawStatus;
    }
    if (row?.otp_received || String(row?.otp_code || '').trim()) return 'active';
    return 'pending';
}

function normalizeOrder(row) {
    if (!row) return null;
    const status = normalizeOrderStatus(row);
    const providerStatus = String(row.provider_status || row.provider_last_status || '').trim() || null;
    const providerFinalStatus = String(row.provider_final_status || '').trim() || null;
    const websiteCharge = row.website_charge == null ? Number(row.price || 0) : Number(row.website_charge || 0);
    const websiteRefund = row.website_refund == null ? 0 : Number(row.website_refund || 0);
    const realProviderCost = row.real_provider_cost == null ? 0 : Number(row.real_provider_cost || 0);
    const smsReceived = Boolean(row.sms_received || row.otp_received || String(row.otp_code || '').trim());
    const providerUsed = Boolean(row.provider_used || smsReceived || isProviderNonPendingStatus(providerStatus) || isProviderNonPendingStatus(providerFinalStatus));
    return {
        ...row,
        price: Number(row.price || 0),
        provider_cost_pkr: Number(row.provider_cost_pkr || 0),
        client_balance_left: row.client_balance_left == null ? null : Number(row.client_balance_left),
        profit_pkr: row.profit_pkr == null ? null : Number(row.profit_pkr),
        otp_received: Boolean(row.otp_received),
        sms_received: smsReceived,
        provider_last_status: String(row.provider_last_status || '').trim() || null,
        provider_partner_id: row.provider_partner_id == null ? null : Number(row.provider_partner_id),
        provider_price_usd: row.provider_price_usd == null ? 0 : Number(row.provider_price_usd || 0),
        provider_balance_before: row.provider_balance_before == null ? null : Number(row.provider_balance_before),
        provider_balance_after: row.provider_balance_after == null ? null : Number(row.provider_balance_after),
        provider_balance_currency: String(row.provider_balance_currency || PROVIDER_BALANCE_CURRENCY).trim() || PROVIDER_BALANCE_CURRENCY,
        real_provider_cost: realProviderCost,
        real_provider_cost_provider_currency: row.real_provider_cost_provider_currency == null ? 0 : Number(row.real_provider_cost_provider_currency || 0),
        provider_cost_source: String(row.provider_cost_source || '').trim() || null,
        provider_cost_verified: Boolean(row.provider_cost_verified),
        provider_status: providerStatus,
        provider_final_status: providerFinalStatus,
        provider_country: String(row.provider_country || row.country || '').trim() || null,
        provider_service: String(row.provider_service || row.service_type || '').trim() || null,
        provider_phone_number: String(row.provider_phone_number || row.phone_number || '').trim() || null,
        provider_used: providerUsed,
        provider_used_at: row.provider_used_at || null,
        provider_status_synced_at: row.provider_status_synced_at || null,
        website_charge: websiteCharge,
        website_refund: websiteRefund,
        website_profit: row.website_profit == null ? roundMoney(websiteCharge - websiteRefund) : Number(row.website_profit || 0),
        real_profit_loss: row.real_profit_loss == null ? roundMoney(websiteCharge - websiteRefund - realProviderCost) : Number(row.real_profit_loss || 0),
        risk_flag: Boolean(row.risk_flag),
        loss_detected: Boolean(row.loss_detected),
        critical_exploit: Boolean(row.critical_exploit),
        exploit_reason: String(row.exploit_reason || '').trim() || null,
        exploit_reason_detail: String(row.exploit_reason_detail || '').trim() || null,
        refunded_at: row.refunded_at || null,
        refund_processing_at: row.refund_processing_at || null,
        refund_locked_at: row.refund_locked_at || (providerUsed ? (row.sms_received_at || row.completed_at || row.created_at || null) : null),
        post_close_poll_count: Number(row.post_close_poll_count || 0),
        duplicate_cancel_attempts: Number(row.duplicate_cancel_attempts || 0),
        username_snapshot: String(row.username_snapshot || row.user_name || row.name || '').trim() || null,
        sms_received_at: row.sms_received_at || null,
        status
    };
}

function hasStoredOtp(order) {
    return Boolean(order?.otp_received || String(order?.otp_code || '').trim());
}

function getRawOrderStatus(order) {
    return String(order?.status || order?.order_status || '').trim().toLowerCase();
}

function toIsoTimestamp(value, fallback = null) {
    if (value == null || value === '') return fallback;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? fallback : value.toISOString();
    }
    const candidate = new Date(value);
    if (Number.isNaN(candidate.getTime())) return fallback;
    return candidate.toISOString();
}

function isFinalOrderState(order) {
    const lifecycleStatus = normalizeOrderStatus(order);
    return ['completed', 'cancelled', 'expired'].includes(lifecycleStatus) || ORDER_FINAL_STATUSES.has(getRawOrderStatus(order));
}

function isProviderSuccessStatus(status) {
    const normalizedStatus = String(status || '').trim().toUpperCase();
    return Boolean(normalizedStatus)
        && (
            normalizedStatus.startsWith('STATUS_OK')
            || /(^|[_\s-])SUCCESS($|[_\s-])/.test(normalizedStatus)
            || /(^|[_\s-])COMPLETED($|[_\s-])/.test(normalizedStatus)
        );
}

function logOrderHotfixEvent(eventName, order, details = {}) {
    console.info(ORDER_HOTFIX_AUDIT_PREFIX, {
        event: eventName,
        timestamp: new Date().toISOString(),
        orderId: order?.id ?? null,
        userId: order?.user_id ?? null,
        username: String(details.username || getOrderUsernameSnapshot(order) || '').trim() || null,
        service: String(order?.service_type || order?.service_name || '').trim() || null,
        number: String(order?.phone_number || '').trim() || null,
        activationId: String(order?.activation_id || '').trim() || null,
        status: getRawOrderStatus(order) || null,
        smsReceived: Boolean(order?.sms_received),
        otpReceived: hasStoredOtp(order),
        otpExisted: details.otpExisted ?? hasStoredOtp(order),
        refunded: details.refunded ?? Boolean(details.refundTime),
        cancelTime: details.cancelTime || null,
        otpArrivalTime: details.otpArrivalTime || null,
        refundTime: details.refundTime || null,
        providerStatus: details.providerStatus || null,
        providerSuccess: details.providerSuccess ?? isProviderSuccessStatus(details.providerStatus || getProviderOrderStatus(order)),
        providerError: details.providerError || null,
        reason: details.reason || null
    });
}

function getOrderUsernameSnapshot(order) {
    return String(order?.username_snapshot || order?.user_name || order?.name || '').trim() || null;
}

function getAuditUsername(user, order) {
    return String(user?.name || user?.email || user?.username || getOrderUsernameSnapshot(order) || '').trim() || null;
}

function isProviderNonPendingStatus(status) {
    const normalizedStatus = String(status || '').trim().toUpperCase();
    return Boolean(normalizedStatus)
        && normalizedStatus !== ORDER_PROVIDER_WAITING_STATUS
        && normalizedStatus !== 'ACCESS_CANCEL'
        && normalizedStatus !== 'STATUS_CANCEL';
}

function getProviderOrderStatus(order) {
    return String(order?.provider_final_status || order?.provider_status || order?.provider_last_status || '').trim() || null;
}

function isProviderBenignRefundStatus(status) {
    const normalizedStatus = String(status || '').trim().toUpperCase();
    return !normalizedStatus
        || normalizedStatus === ORDER_PROVIDER_WAITING_STATUS
        || normalizedStatus === 'ACCESS_CANCEL'
        || normalizedStatus === 'STATUS_CANCEL'
        || normalizedStatus === 'EXPIRED'
        || normalizedStatus === 'STATUS_EXPIRED'
        || normalizedStatus === 'CANCELLED'
        || normalizedStatus === 'CANCELED'
        || normalizedStatus === 'STATUS_CANCELLED'
        || normalizedStatus === 'STATUS_CANCELED';
}

function getOrderRiskEventTimestamp(order) {
    return toIsoTimestamp(
        order?.refunded_at
            || order?.completed_at
            || order?.provider_status_synced_at
            || order?.sms_received_at
            || order?.created_at,
        toIsoTimestamp(order?.created_at, new Date().toISOString())
    );
}

function getConfirmedProviderLossAmount(order) {
    return roundMoney(Math.max(0, -getRealProfitLossAmount(order)));
}

function getFinancialStatsResetAt() {
    const candidate = new Date(`${FINANCIAL_STATS_RESET_DATE}T00:00:00`);
    if (Number.isNaN(candidate.getTime())) {
        return new Date('2026-05-26T00:00:00').toISOString();
    }
    return candidate.toISOString();
}

function getOrderFinancialTimelineTimestamp(order) {
    return toIsoTimestamp(
        order?.completed_at
            || order?.sms_received_at
            || order?.provider_status_synced_at
            || order?.created_at,
        toIsoTimestamp(order?.created_at, new Date().toISOString())
    );
}

function isFinanciallySuccessfulOrder(order) {
    const normalizedStatus = normalizeOrderStatus(order);
    return normalizedStatus === 'completed'
        || Boolean(order?.sms_received)
        || hasStoredOtp(order);
}

function getFinancialRevenueAmount(order) {
    return isFinanciallySuccessfulOrder(order)
        ? roundMoney(order?.price != null ? order.price : order?.website_charge || 0)
        : 0;
}

function getFinancialApiCostAmount(order) {
    if (!isFinanciallySuccessfulOrder(order)) return 0;
    const realProviderCost = getRealProviderCostAmount(order);
    return realProviderCost > PROVIDER_BALANCE_EPSILON ? roundMoney(realProviderCost) : 0;
}

function getFinancialProfitAmount(order) {
    return roundMoney(getFinancialRevenueAmount(order) - getFinancialApiCostAmount(order));
}

function isOrderAfterFinancialStatsReset(order) {
    const resetAtMs = Date.parse(getFinancialStatsResetAt());
    const financialAtMs = Date.parse(getOrderFinancialTimelineTimestamp(order));
    return Number.isFinite(financialAtMs) && (!Number.isFinite(resetAtMs) || financialAtMs >= resetAtMs);
}

function isNormalResolvedRefund(order) {
    const normalizedStatus = normalizeOrderStatus(order);
    const providerStatus = getProviderOrderStatus(order);
    return ['cancelled', 'expired'].includes(normalizedStatus)
        && getWebsiteRefundAmount(order) > 0
        && !hasStoredOtp(order)
        && !isProviderSuccessStatus(providerStatus)
        && isProviderBenignRefundStatus(providerStatus);
}

function isAutoSecurityBlockReason(reason) {
    return String(reason || '').trim().toLowerCase() === 'auto_block_confirmed_provider_loss';
}

function buildRefundDecision(order, providerSignal = null) {
    const providerStatus = String(providerSignal?.rawStatus || getProviderOrderStatus(order) || '').trim() || null;
    const websiteOtpExists = hasStoredOtp(order);
    const providerOtpExists = Boolean(providerSignal?.hasCode);
    const providerSuccess = isProviderSuccessStatus(providerStatus);
    const otpExists = websiteOtpExists || providerOtpExists;
    let reason = 'no_otp_provider_not_success';
    if (websiteOtpExists) {
        reason = 'otp_exists_in_database';
    } else if (providerOtpExists) {
        reason = 'otp_received_from_provider';
    } else if (providerSuccess) {
        reason = 'provider_marked_success_completed';
    }
    return {
        providerStatus,
        websiteOtpExists,
        providerOtpExists,
        otpExists,
        providerSuccess,
        refundAllowed: !otpExists && !providerSuccess,
        reason
    };
}

function getRefundBlockedMessage(decision, actionType = 'refund') {
    if (decision?.providerOtpExists || decision?.websiteOtpExists || decision?.otpExists) {
        return actionType === 'cancel'
            ? 'OTP already received, cannot cancel'
            : 'OTP already received. Refund blocked.';
    }
    if (decision?.providerSuccess) {
        return actionType === 'cancel'
            ? 'Provider marked success/completed, cannot cancel'
            : 'Provider marked success/completed. Refund blocked.';
    }
    return actionType === 'cancel'
        ? 'Cancel temporarily locked while activation status is being verified.'
        : 'Refund temporarily locked while activation status is being verified.';
}

function isRefundProcessing(order) {
    if (!order?.refund_processing_at || isFinalOrderState(order)) return false;
    const startedAt = new Date(order.refund_processing_at);
    if (Number.isNaN(startedAt.getTime())) return false;
    return (Date.now() - startedAt.getTime()) < 120000;
}

async function setRefundProcessingState(orderId, refundProcessingAt, client) {
    return updateOrder(orderId, {
        refund_processing_at: refundProcessingAt || null
    }, {
        client,
        syncNumberHistory: false
    });
}

function isProviderUsedOrder(order) {
    return Boolean(order?.provider_used || order?.sms_received || hasStoredOtp(order) || isProviderNonPendingStatus(getProviderOrderStatus(order)));
}

function getWebsiteChargeAmount(order) {
    return roundMoney(order?.website_charge != null ? order.website_charge : order?.price || 0);
}

function getWebsiteRefundAmount(order) {
    return roundMoney(order?.website_refund || 0);
}

function getRealProviderCostAmount(order) {
    return roundMoney(order?.real_provider_cost || 0);
}

function getWebsiteProfitAmount(order) {
    return roundMoney(order?.website_profit != null ? order.website_profit : getWebsiteChargeAmount(order) - getWebsiteRefundAmount(order));
}

function getRealProfitLossAmount(order) {
    return roundMoney(order?.real_profit_loss != null ? order.real_profit_loss : getWebsiteChargeAmount(order) - getWebsiteRefundAmount(order) - getRealProviderCostAmount(order));
}

function calculateRiskStatus(score) {
    if (Number(score || 0) >= 80) return 'dangerous';
    if (Number(score || 0) >= 30) return 'suspicious';
    return 'safe';
}

function logProviderAudit(eventName, details = {}) {
    console.info(PROVIDER_AUDIT_PREFIX, {
        event: eventName,
        timestamp: new Date().toISOString(),
        ...details
    });
}

function parseProviderBalanceResponse(data) {
    if (typeof data === 'string') {
        const trimmed = data.trim();
        if (trimmed.toUpperCase().startsWith('ACCESS_BALANCE:')) {
            const parsedBalance = Number(trimmed.slice(trimmed.indexOf(':') + 1).trim());
            if (Number.isFinite(parsedBalance)) {
                return {
                    success: true,
                    balance: roundMoney(parsedBalance, 6),
                    currency: PROVIDER_BALANCE_CURRENCY,
                    raw: trimmed
                };
            }
        }
        return {
            success: false,
            error: trimmed || 'Provider balance unavailable',
            raw: trimmed
        };
    }
    if (data && typeof data === 'object') {
        const candidateBalance = Number(data.balance ?? data.amount ?? data.availableBalance);
        if (Number.isFinite(candidateBalance)) {
            return {
                success: true,
                balance: roundMoney(candidateBalance, 6),
                currency: String(data.currency || PROVIDER_BALANCE_CURRENCY).trim() || PROVIDER_BALANCE_CURRENCY,
                raw: JSON.stringify(data)
            };
        }
    }
    return {
        success: false,
        error: 'Provider balance unavailable',
        raw: data == null ? '' : String(data)
    };
}

function computeProviderCostMetrics({ balanceBefore, balanceAfter, activationCost, providerPrice }) {
    const beforeBalance = Number(balanceBefore);
    const afterBalance = Number(balanceAfter);
    const providerActivationCost = Number(activationCost);
    const providerTierPrice = Number(providerPrice);
    const balanceDiff = Number.isFinite(beforeBalance) && Number.isFinite(afterBalance)
        ? roundMoney(Math.max(0, beforeBalance - afterBalance), 6)
        : null;
    let providerCurrencyCost = null;
    let costSource = null;
    if (Number.isFinite(balanceDiff) && balanceDiff > PROVIDER_BALANCE_EPSILON) {
        providerCurrencyCost = balanceDiff;
        costSource = 'balance_diff';
    } else if (Number.isFinite(providerActivationCost) && providerActivationCost > PROVIDER_BALANCE_EPSILON) {
        providerCurrencyCost = roundMoney(providerActivationCost, 6);
        costSource = 'activation_cost';
    } else if (Number.isFinite(providerTierPrice) && providerTierPrice > PROVIDER_BALANCE_EPSILON) {
        providerCurrencyCost = roundMoney(providerTierPrice, 6);
        costSource = 'provider_price';
    }
    return {
        providerCurrencyCost: providerCurrencyCost == null ? 0 : providerCurrencyCost,
        providerCostPkr: providerCurrencyCost == null ? 0 : usdToPkr(providerCurrencyCost),
        costSource,
        balanceDiff: balanceDiff == null ? null : balanceDiff,
        balanceVerified: Number.isFinite(balanceDiff) && balanceDiff > PROVIDER_BALANCE_EPSILON
    };
}

function computeProviderRefundRecoveryMetrics(order, { balanceBeforeAction, balanceAfterAction }) {
    const beforeBalance = Number(balanceBeforeAction);
    const afterBalance = Number(balanceAfterAction);
    const previousProviderCostCurrency = roundMoney(order?.real_provider_cost_provider_currency || 0, 6);
    const recoveredCurrency = Number.isFinite(beforeBalance) && Number.isFinite(afterBalance)
        ? roundMoney(Math.max(0, afterBalance - beforeBalance), 6)
        : 0;
    const remainingCurrency = roundMoney(Math.max(0, previousProviderCostCurrency - recoveredCurrency), 6);
    return {
        previousProviderCostCurrency,
        recoveredCurrency,
        recoveredPkr: usdToPkr(recoveredCurrency),
        remainingCurrency,
        remainingPkr: usdToPkr(remainingCurrency),
        balanceVerified: Number.isFinite(beforeBalance) && Number.isFinite(afterBalance)
    };
}

function evaluateOrderRiskFlags(order) {
    const reasons = [];
    const details = [];
    const websiteRefund = getWebsiteRefundAmount(order);
    const realProviderCost = getRealProviderCostAmount(order);
    const providerStatus = getProviderOrderStatus(order);
    const providerSuccess = isProviderSuccessStatus(providerStatus);
    const otpExists = hasStoredOtp(order);
    const confirmedLossAmount = getConfirmedProviderLossAmount(order);
    const normalResolvedRefund = isNormalResolvedRefund(order);
    if (confirmedLossAmount <= PROVIDER_BALANCE_EPSILON || realProviderCost <= PROVIDER_BALANCE_EPSILON || normalResolvedRefund) {
        return {
            riskFlag: false,
            lossDetected: false,
            criticalExploit: false,
            exploitReason: null,
            exploitReasonDetail: null,
            confirmedLossAmount: 0,
            reasons
        };
    }
    if (websiteRefund > 0 && otpExists) {
        reasons.push('confirmed_provider_loss_refunded_with_otp');
        details.push('A real provider loss remained after the user received OTP and still got refunded.');
    } else if (websiteRefund > 0 && providerSuccess) {
        reasons.push('confirmed_provider_loss_refunded_after_provider_success');
        details.push('A real provider loss remained after provider success/completion while the user was refunded.');
    } else {
        reasons.push('confirmed_provider_loss_unrecovered');
        details.push('A real unrecovered provider loss was recorded for this order.');
    }
    const criticalExploit = reasons.includes('confirmed_provider_loss_refunded_with_otp')
        || reasons.includes('confirmed_provider_loss_refunded_after_provider_success');
    return {
        riskFlag: true,
        lossDetected: true,
        criticalExploit,
        exploitReason: reasons[0] || null,
        exploitReasonDetail: details.join(' ') || null,
        confirmedLossAmount,
        reasons
    };
}

function buildDerivedOrderMetrics(order, overrides = {}) {
    const providerStatus = overrides.providerStatus ?? (String(order?.provider_status || order?.provider_last_status || '').trim() || null);
    const providerFinalStatus = overrides.providerFinalStatus ?? (String(order?.provider_final_status || '').trim() || (isProviderNonPendingStatus(providerStatus) ? providerStatus : null));
    const websiteCharge = overrides.websiteCharge ?? getWebsiteChargeAmount(order);
    const websiteRefund = overrides.websiteRefund ?? getWebsiteRefundAmount(order);
    const realProviderCost = overrides.realProviderCost ?? getRealProviderCostAmount(order);
    const providerUsed = overrides.providerUsed ?? Boolean(order?.provider_used || order?.sms_received || hasStoredOtp(order) || isProviderNonPendingStatus(providerFinalStatus || providerStatus));
    const websiteProfit = overrides.websiteProfit ?? roundMoney(websiteCharge - websiteRefund);
    const realProfitLoss = overrides.realProfitLoss ?? roundMoney(websiteCharge - websiteRefund - realProviderCost);
    const mergedOrder = {
        ...order,
        provider_status: providerStatus,
        provider_final_status: providerFinalStatus,
        provider_used: providerUsed,
        website_charge: websiteCharge,
        website_refund: websiteRefund,
        website_profit: websiteProfit,
        real_provider_cost: realProviderCost,
        real_profit_loss: realProfitLoss,
        post_close_poll_count: overrides.postClosePollCount ?? Number(order?.post_close_poll_count || 0)
    };
    return {
        ...mergedOrder,
        riskState: evaluateOrderRiskFlags(mergedOrder)
    };
}

function normalizeNumberHistoryEntry(row) {
    if (!row) return null;
    const status = normalizeOrderStatus(row);
    return {
        ...row,
        order_id: row.order_id == null ? null : Number(row.order_id),
        user_id: row.user_id == null ? null : Number(row.user_id),
        country_id: row.country_id == null ? null : Number(row.country_id),
        price: Number(row.price || 0),
        otp_received: Boolean(row.otp_received),
        status
    };
}

function isAdminUser(user) {
    return Boolean(user && (user.is_admin || String(user.role || '').toLowerCase() === 'admin'));
}

function normalizeTransaction(row) {
    if (!row) return null;
    return {
        ...row,
        amount: Number(row.amount || 0),
        user_name: row.user_name || '',
        user_email: row.user_email || ''
    };
}

function normalizePaymentRequest(row) {
    if (!row) return null;
    return {
        ...row,
        amount: Number(row.amount || 0),
        credit_amount: Number(row.credit_amount || 0),
        payment_method: normalizePaymentMethod(row.payment_method),
        amount_currency: String(row.amount_currency || 'PKR').trim().toUpperCase() || 'PKR',
        note: String(row.note || '').trim() || null,
        user_name_snapshot: String(row.user_name_snapshot || '').trim() || '',
        user_name: row.user_name || '',
        user_email: row.user_email || ''
    };
}

function normalizeReferralRecord(row) {
    if (!row) return null;
    return {
        ...row,
        reward_amount: Number(row.reward_amount || 0),
        qualifying_deposit_amount: row.qualifying_deposit_amount == null ? null : Number(row.qualifying_deposit_amount),
        referrer_name: row.referrer_name || '',
        referrer_email: row.referrer_email || '',
        referred_name: row.referred_name || '',
        referred_email: row.referred_email || ''
    };
}

async function queryOne(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows[0] || null;
}

async function queryAll(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows;
}

async function queryRun(sql, params = []) {
    return pool.query(sql, params);
}

function isPasswordHashed(password) {
    return typeof password === 'string' && /^\$2[aby]\$\d{2}\$/.test(password);
}

async function hashPassword(password) {
    if (!bcrypt || typeof bcrypt.hash !== 'function') {
        throw new Error('Password hashing is not available');
    }
    return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(inputPassword, storedPassword) {
    if (!storedPassword || typeof storedPassword !== 'string') {
        return { valid: false, needsUpgrade: false };
    }
    if (isPasswordHashed(storedPassword)) {
        if (!bcrypt || typeof bcrypt.compare !== 'function') {
            return { valid: false, needsUpgrade: false };
        }
        const valid = await bcrypt.compare(inputPassword, storedPassword);
        return { valid, needsUpgrade: false };
    }
    const valid = inputPassword === storedPassword;
    return { valid, needsUpgrade: valid };
}

function sanitizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password) {
    return typeof password === 'string' && password.length >= 6;
}

function randomPassword() {
    return crypto.randomBytes(24).toString('hex');
}

function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function pkrToUsd(pkr) {
    return parseFloat((Number(pkr || 0) / PROVIDER_PKR_EXCHANGE_RATE).toFixed(3));
}

function usdToPkr(usd) {
    return Number((Number(usd || 0) * PROVIDER_PKR_EXCHANGE_RATE).toFixed(2));
}

function roundMoney(value, decimals = 2) {
    const numericValue = Number(value || 0);
    if (!Number.isFinite(numericValue)) return 0;
    return Number(numericValue.toFixed(decimals));
}

function formatSafeError(err, fallback = 'Server error') {
    if (!err) return fallback;
    if (typeof err.message === 'string' && err.message.trim()) return err.message;
    return fallback;
}

function isMailConfigured() {
    return Boolean(mailTransporter && typeof mailTransporter.sendMail === 'function');
}

function hashToken(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function buildAbsoluteUrl(relativePath) {
    const normalizedPath = `/${String(relativePath || '').replace(/^\/+/, '')}`;
    if (!APP_BASE_URL) {
        return normalizedPath;
    }
    const base = APP_BASE_URL.endsWith('/') ? APP_BASE_URL : `${APP_BASE_URL}/`;
    return new URL(normalizedPath.replace(/^\//, ''), base).toString();
}

function normalizeReferralCode(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 16);
}

function normalizeClientIp(value) {
    const rawValue = String(value || '').split(',')[0].trim().replace(/^::ffff:/i, '');
    if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(rawValue)) {
        return rawValue.replace(/:\d+$/, '');
    }
    return rawValue;
}

function getRequestClientIp(req) {
    return normalizeClientIp(req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || '');
}

function normalizeDeviceFingerprint(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 128);
}

function normalizeBrowserFingerprint(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 128);
}

function normalizePaymentReference(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 128);
}

function normalizePaymentMethod(value) {
    const normalizedValue = String(value || '').trim().toLowerCase();
    return normalizedValue === 'binance' ? 'binance' : 'easypaisa';
}

function getPaymentMethodConfig(paymentMethod) {
    const normalizedMethod = normalizePaymentMethod(paymentMethod);
    if (normalizedMethod === 'binance') {
        return {
            paymentMethod: 'binance',
            amountCurrency: 'USDT',
            minimumAmount: BINANCE_MIN_DEPOSIT_USDT,
            creditedAmountLabel: 'PKR wallet credit',
            creditedAmountCalculator: (amount) => usdToPkr(amount),
            transactionLabel: 'Binance transaction ID',
            requiresTransactionId: true
        };
    }
    return {
        paymentMethod: 'easypaisa',
        amountCurrency: 'PKR',
        minimumAmount: EASYPAISA_MIN_DEPOSIT_PKR,
        creditedAmountLabel: 'PKR wallet credit',
        creditedAmountCalculator: (amount) => roundMoney(amount),
        transactionLabel: 'Transaction ID',
        requiresTransactionId: false
    };
}

function getPaymentRequestCreditAmount(paymentRequest) {
    const methodConfig = getPaymentMethodConfig(paymentRequest?.payment_method);
    const storedCreditAmount = Number(paymentRequest?.credit_amount || 0);
    if (storedCreditAmount > 0) {
        return roundMoney(storedCreditAmount);
    }
    return roundMoney(methodConfig.creditedAmountCalculator(Number(paymentRequest?.amount || 0)));
}

function getPaymentRequestAmountSummary(paymentRequest) {
    const methodConfig = getPaymentMethodConfig(paymentRequest?.payment_method);
    const amount = roundMoney(Number(paymentRequest?.amount || 0));
    const creditedAmount = getPaymentRequestCreditAmount(paymentRequest);
    if (methodConfig.amountCurrency === 'USDT') {
        return `${amount} USDT (credits ${creditedAmount} PKR)`;
    }
    return `${amount} PKR`;
}

function buildPublicAppBaseUrl(req) {
    if (APP_BASE_URL) {
        return APP_BASE_URL;
    }
    const requestHost = String(req.get('host') || '').trim();
    if (requestHost) {
        return `${req.protocol || 'https'}://${requestHost}`;
    }
    return REFERRAL_LINK_FALLBACK_BASE;
}

function buildReferralLink(req, referralCode) {
    const normalizedCode = normalizeReferralCode(referralCode);
    const baseUrl = buildPublicAppBaseUrl(req).replace(/\/+$/, '');
    if (!normalizedCode) {
        return `${baseUrl}/`;
    }
    return `${baseUrl}/?ref=${encodeURIComponent(normalizedCode)}`;
}

async function hashUploadedFile(fileName) {
    const normalizedName = path.basename(String(fileName || '').trim());
    if (!normalizedName) return null;
    const filePath = path.join(UPLOAD_DIR, normalizedName);
    try {
        const fileBuffer = await fs.promises.readFile(filePath);
        return crypto.createHash('sha256').update(fileBuffer).digest('hex');
    } catch {
        return null;
    }
}

async function isValidUploadedPaymentProof(fileName) {
    const normalizedName = path.basename(String(fileName || '').trim());
    if (!normalizedName) return false;
    const filePath = path.join(UPLOAD_DIR, normalizedName);
    try {
        const fileHandle = await fs.promises.open(filePath, 'r');
        try {
            const header = Buffer.alloc(16);
            await fileHandle.read(header, 0, 16, 0);
            const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
            const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
                && header[4] === 0x0d && header[5] === 0x0a && header[6] === 0x1a && header[7] === 0x0a;
            const isWebp = header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
            return Boolean(isJpeg || isPng || isWebp);
        } finally {
            await fileHandle.close();
        }
    } catch {
        return false;
    }
}

function createReferralCodePrefix(name = '') {
    const normalizedName = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return normalizedName.slice(0, 3) || 'MRF';
}

async function generateUniqueReferralCode(name = '') {
    const prefix = createReferralCodePrefix(name);
    for (let attempt = 0; attempt < 24; attempt += 1) {
        const suffix = crypto.randomBytes(3).toString('hex').slice(0, 5).toUpperCase();
        const candidate = normalizeReferralCode(`${prefix}${suffix}`);
        const existing = await queryOne('SELECT id FROM users WHERE referral_code = $1', [candidate]);
        if (!existing) {
            return candidate;
        }
    }
    return normalizeReferralCode(`MRF${Date.now().toString(36).toUpperCase()}`);
}

function buildReferralSecurityReason(flags = []) {
    const normalizedFlags = flags.filter(Boolean);
    if (!normalizedFlags.length) return '';
    return `${REFERRAL_SECURITY_MESSAGE}: ${normalizedFlags.join(', ')}`;
}

async function sendPasswordResetEmail(user, token) {
    if (!mailTransporter) {
        throw new Error('Password reset email is not configured');
    }
    const resetUrl = buildAbsoluteUrl(`/reset-password.html?token=${encodeURIComponent(token)}`);
    const recipientName = String(user.name || 'there').trim();
    try {
        await mailTransporter.sendMail({
            from: SMTP_FROM,
            to: user.email,
            subject: 'Reset your MRF SMS password',
            text: `Hello ${recipientName},\n\nUse this link to reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you did not request it, you can safely ignore this email.`,
            html: `
                <div style="font-family:Inter,Arial,sans-serif;background:#f8fafc;padding:32px;">
                    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:24px;padding:32px;border:1px solid #e2e8f0;box-shadow:0 16px 40px rgba(15,23,42,0.08);">
                        <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#64748b;margin-bottom:10px;">MRF SMS</div>
                        <h1 style="margin:0 0 12px;font-size:28px;line-height:1.2;color:#0f172a;">Reset your password</h1>
                        <p style="margin:0 0 20px;color:#475569;line-height:1.7;">Hello ${recipientName}, we received a request to reset your password. Click the button below to continue.</p>
                        <a href="${resetUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:14px;font-weight:700;">Reset Password</a>
                        <p style="margin:20px 0 0;color:#64748b;line-height:1.7;">This link will expire in 1 hour. If you did not request a password reset, you can safely ignore this email.</p>
                        <p style="margin:20px 0 0;color:#94a3b8;font-size:12px;word-break:break-all;">Direct link: ${resetUrl}</p>
                    </div>
                </div>
            `
        });
    } catch (err) {
        console.error(`Password reset email failed for ${user.email}: ${formatSafeError(err, 'Email delivery failed')}`);
        throw err;
    }
}

async function initDB() {
    await queryRun(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT,
            balance NUMERIC(12,2) DEFAULT 0,
            role TEXT DEFAULT 'user',
            is_admin BOOLEAN DEFAULT FALSE,
            referral_code TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            login_attempts INTEGER DEFAULT 0,
            last_login TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await queryRun(`
        CREATE TABLE IF NOT EXISTS balance_adjustments (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            amount NUMERIC(12,2) NOT NULL,
            reason TEXT NOT NULL,
            admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await queryRun('CREATE INDEX IF NOT EXISTS idx_balance_adjustments_user_id ON balance_adjustments (user_id, created_at DESC)');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_balance_adjustments_admin_id ON balance_adjustments (admin_id, created_at DESC)');

    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users (reset_token)');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS "googleId" TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS "displayName" TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS "photo" TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_ip TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_device_fingerprint TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_browser_fingerprint TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS security_blocked_until TIMESTAMPTZ');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS security_risk_score INTEGER DEFAULT 0');
    await queryRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS security_risk_status TEXT DEFAULT 'safe'");
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS security_last_flagged_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS security_block_reason TEXT');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS security_blocked_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE users ADD COLUMN IF NOT EXISTS security_risk_reset_at TIMESTAMPTZ');
    await queryRun("UPDATE users SET is_admin = TRUE WHERE LOWER(COALESCE(role, 'user')) = 'admin'");
    await queryRun('CREATE UNIQUE INDEX IF NOT EXISTS users_googleId_unique_idx ON users ("googleId") WHERE "googleId" IS NOT NULL');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_users_referred_by_user_id ON users (referred_by_user_id)');

    await queryRun(`
        CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            user_email TEXT,
            service_type TEXT,
            service_name TEXT,
            country TEXT,
            country_code TEXT,
            country_id INTEGER,
            price NUMERIC(12,2),
            provider_cost_pkr NUMERIC(12,2) DEFAULT 0,
            payment_method TEXT,
            payment_status TEXT DEFAULT 'pending',
            order_status TEXT DEFAULT 'pending',
            status TEXT DEFAULT 'pending',
            phone_number TEXT,
            activation_id TEXT,
            otp_received BOOLEAN DEFAULT FALSE,
            sms_received BOOLEAN DEFAULT FALSE,
            otp_code TEXT,
            sms_received_at TIMESTAMPTZ,
            provider_last_status TEXT,
            expires_at TIMESTAMPTZ,
            cancel_available_at TIMESTAMPTZ,
            last_purchase_at TIMESTAMPTZ,
            idempotency_key TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMPTZ
        )
    `);

    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_cost_pkr NUMERIC(12,2) DEFAULT 0');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT \'pending\'');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_purchase_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS sms_received BOOLEAN DEFAULT FALSE');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS sms_received_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_last_status TEXT');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS username_snapshot TEXT');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_partner_id INTEGER');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_price_usd NUMERIC(12,6) DEFAULT 0');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_balance_before NUMERIC(18,6)');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_balance_after NUMERIC(18,6)');
    await queryRun("ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_balance_currency TEXT DEFAULT 'USD'");
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS real_provider_cost NUMERIC(12,2) DEFAULT 0');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS real_provider_cost_provider_currency NUMERIC(18,6) DEFAULT 0');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_cost_source TEXT');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_cost_verified BOOLEAN DEFAULT FALSE');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_status TEXT');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_final_status TEXT');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_country TEXT');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_service TEXT');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_phone_number TEXT');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_used BOOLEAN DEFAULT FALSE');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_used_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_status_synced_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS website_charge NUMERIC(12,2) DEFAULT 0');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS website_refund NUMERIC(12,2) DEFAULT 0');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS website_profit NUMERIC(12,2) DEFAULT 0');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS real_profit_loss NUMERIC(12,2) DEFAULT 0');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS risk_flag BOOLEAN DEFAULT FALSE');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS loss_detected BOOLEAN DEFAULT FALSE');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS critical_exploit BOOLEAN DEFAULT FALSE');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS exploit_reason TEXT');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS exploit_reason_detail TEXT');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_processing_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_locked_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS post_close_poll_count INTEGER DEFAULT 0');
    await queryRun('ALTER TABLE orders ADD COLUMN IF NOT EXISTS duplicate_cancel_attempts INTEGER DEFAULT 0');
    await queryRun('UPDATE orders SET last_purchase_at = COALESCE(last_purchase_at, created_at, CURRENT_TIMESTAMP)');
    await queryRun(`
        UPDATE orders
        SET sms_received = TRUE,
            sms_received_at = COALESCE(sms_received_at, completed_at, created_at, CURRENT_TIMESTAMP)
        WHERE COALESCE(sms_received, FALSE) = FALSE
          AND (
              COALESCE(otp_received, FALSE) = TRUE
              OR NULLIF(TRIM(COALESCE(otp_code, '')), '') IS NOT NULL
          )
    `);
    await queryRun(`
        UPDATE orders
        SET status = CASE
            WHEN LOWER(COALESCE(order_status, '')) = 'completed' THEN 'completed'
            WHEN LOWER(COALESCE(order_status, '')) IN ('expired_refunded', 'expired') THEN 'expired'
            WHEN LOWER(COALESCE(order_status, '')) = 'cancelled' THEN 'cancelled'
            WHEN otp_received = TRUE OR LOWER(COALESCE(order_status, '')) = 'otp_received' THEN 'active'
            WHEN LOWER(COALESCE(order_status, '')) = 'active' THEN 'pending'
            ELSE 'pending'
        END
    `);

    await queryRun(`
        UPDATE orders
        SET
            status = 'completed',
            order_status = 'completed',
            completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
        WHERE created_at <= CURRENT_TIMESTAMP - INTERVAL '1 hour'
          AND (
              COALESCE(otp_received, FALSE) = TRUE
              OR NULLIF(TRIM(COALESCE(otp_code, '')), '') IS NOT NULL
              OR LOWER(COALESCE(order_status, '')) = 'otp_received'
          )
          AND LOWER(COALESCE(status, order_status, 'pending')) NOT IN ('completed', 'cancelled', 'expired', 'expired_refunded')
    `);
    await queryRun('CREATE INDEX IF NOT EXISTS idx_orders_user_service_country_status ON orders (user_id, service_type, country_id, status)');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_orders_user_service_last_purchase ON orders (user_id, service_type, last_purchase_at DESC)');
    await queryRun('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_idempotency_key ON orders (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
    await queryRun('DROP INDEX IF EXISTS idx_orders_open_service_country_unique');

    await queryRun(`
        CREATE TABLE IF NOT EXISTS number_history (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
            user_email TEXT,
            service_type TEXT,
            service_name TEXT,
            country TEXT,
            country_code TEXT,
            country_id INTEGER,
            price NUMERIC(12,2) DEFAULT 0,
            phone_number TEXT,
            activation_id TEXT,
            otp_received BOOLEAN DEFAULT FALSE,
            otp_code TEXT,
            status TEXT DEFAULT 'pending',
            order_status TEXT DEFAULT 'pending',
            purchased_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            otp_received_at TIMESTAMPTZ,
            final_status_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            cancelled_at TIMESTAMPTZ,
            expired_at TIMESTAMPTZ,
            last_event_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS user_id INTEGER');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS order_id INTEGER');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS user_email TEXT');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS service_type TEXT');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS service_name TEXT');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS country TEXT');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS country_code TEXT');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS country_id INTEGER');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS price NUMERIC(12,2) DEFAULT 0');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS phone_number TEXT');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS activation_id TEXT');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS otp_received BOOLEAN DEFAULT FALSE');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS otp_code TEXT');
    await queryRun("ALTER TABLE number_history ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'");
    await queryRun("ALTER TABLE number_history ADD COLUMN IF NOT EXISTS order_status TEXT DEFAULT 'pending'");
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS otp_received_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS final_status_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP');
    await queryRun('ALTER TABLE number_history ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP');
    await queryRun('CREATE UNIQUE INDEX IF NOT EXISTS idx_number_history_order_id ON number_history (order_id)');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_number_history_user_last_event ON number_history (user_id, last_event_at DESC, id DESC)');
    await queryRun(`
        INSERT INTO number_history (
            user_id,
            order_id,
            user_email,
            service_type,
            service_name,
            country,
            country_code,
            country_id,
            price,
            phone_number,
            activation_id,
            otp_received,
            otp_code,
            status,
            order_status,
            purchased_at,
            otp_received_at,
            final_status_at,
            completed_at,
            cancelled_at,
            expired_at,
            last_event_at
        )
        SELECT
            o.user_id,
            o.id,
            COALESCE(o.user_email, u.email),
            o.service_type,
            o.service_name,
            o.country,
            o.country_code,
            o.country_id,
            COALESCE(o.price, 0),
            o.phone_number,
            o.activation_id,
            COALESCE(o.otp_received, FALSE),
            NULLIF(TRIM(COALESCE(o.otp_code, '')), ''),
            CASE
                WHEN LOWER(COALESCE(o.status, o.order_status, 'pending')) = 'completed' THEN 'completed'
                WHEN LOWER(COALESCE(o.status, o.order_status, 'pending')) IN ('expired', 'expired_refunded') THEN 'expired'
                WHEN LOWER(COALESCE(o.status, o.order_status, 'pending')) = 'cancelled' THEN 'cancelled'
                WHEN COALESCE(o.otp_received, FALSE) = TRUE
                    OR NULLIF(TRIM(COALESCE(o.otp_code, '')), '') IS NOT NULL
                    OR LOWER(COALESCE(o.order_status, '')) = 'otp_received'
                    THEN 'active'
                ELSE 'pending'
            END,
            LOWER(COALESCE(o.order_status, o.status, 'pending')),
            COALESCE(o.created_at, CURRENT_TIMESTAMP),
            CASE
                WHEN COALESCE(o.otp_received, FALSE) = TRUE OR NULLIF(TRIM(COALESCE(o.otp_code, '')), '') IS NOT NULL
                    THEN COALESCE(o.completed_at, o.created_at, CURRENT_TIMESTAMP)
                ELSE NULL
            END,
            CASE
                WHEN LOWER(COALESCE(o.status, o.order_status, 'pending')) IN ('completed', 'cancelled', 'expired', 'expired_refunded')
                    THEN COALESCE(o.completed_at, o.created_at, CURRENT_TIMESTAMP)
                ELSE NULL
            END,
            CASE
                WHEN LOWER(COALESCE(o.status, o.order_status, 'pending')) = 'completed'
                    THEN COALESCE(o.completed_at, o.created_at, CURRENT_TIMESTAMP)
                ELSE NULL
            END,
            CASE
                WHEN LOWER(COALESCE(o.status, o.order_status, 'pending')) = 'cancelled'
                    THEN COALESCE(o.completed_at, o.created_at, CURRENT_TIMESTAMP)
                ELSE NULL
            END,
            CASE
                WHEN LOWER(COALESCE(o.status, o.order_status, 'pending')) IN ('expired', 'expired_refunded')
                    THEN COALESCE(o.completed_at, o.created_at, CURRENT_TIMESTAMP)
                ELSE NULL
            END,
            COALESCE(o.completed_at, o.created_at, CURRENT_TIMESTAMP)
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        WHERE o.user_id IS NOT NULL
        ON CONFLICT (order_id) DO NOTHING
    `);

    await queryRun(`
        CREATE TABLE IF NOT EXISTS provider_balance_snapshots (
            id SERIAL PRIMARY KEY,
            order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            activation_id TEXT,
            reason TEXT NOT NULL,
            provider_balance NUMERIC(18,6) NOT NULL,
            previous_balance NUMERIC(18,6),
            delta NUMERIC(18,6),
            delta_pkr NUMERIC(12,2) DEFAULT 0,
            expected_spend_pkr NUMERIC(12,2) DEFAULT 0,
            unmatched_delta_pkr NUMERIC(12,2) DEFAULT 0,
            anomaly_flag BOOLEAN DEFAULT FALSE,
            note TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await queryRun('CREATE INDEX IF NOT EXISTS idx_provider_balance_snapshots_created_at ON provider_balance_snapshots (created_at DESC)');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_provider_balance_snapshots_order_id ON provider_balance_snapshots (order_id, created_at DESC)');

    await queryRun(`
        CREATE TABLE IF NOT EXISTS provider_security_events (
            id SERIAL PRIMARY KEY,
            order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            username TEXT,
            service_type TEXT,
            country TEXT,
            phone_number TEXT,
            activation_id TEXT,
            event_type TEXT NOT NULL,
            reason TEXT,
            risk_flag BOOLEAN DEFAULT FALSE,
            loss_detected BOOLEAN DEFAULT FALSE,
            critical_exploit BOOLEAN DEFAULT FALSE,
            provider_status TEXT,
            provider_final_status TEXT,
            provider_balance_before NUMERIC(18,6),
            provider_balance_after NUMERIC(18,6),
            real_provider_cost NUMERIC(12,2) DEFAULT 0,
            website_charge NUMERIC(12,2) DEFAULT 0,
            website_refund NUMERIC(12,2) DEFAULT 0,
            real_profit_loss NUMERIC(12,2) DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await queryRun('CREATE INDEX IF NOT EXISTS idx_provider_security_events_order_id ON provider_security_events (order_id, created_at DESC)');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_provider_security_events_user_id ON provider_security_events (user_id, created_at DESC)');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_provider_security_events_risk_flags ON provider_security_events (critical_exploit, loss_detected, risk_flag, created_at DESC)');

    await queryRun(`
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            user_email TEXT,
            amount NUMERIC(12,2),
            screenshot TEXT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await queryRun(`
        CREATE TABLE IF NOT EXISTS payment_requests (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            user_email TEXT,
            amount NUMERIC(12,2),
            transaction_id TEXT UNIQUE,
            screenshot TEXT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await queryRun("ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'easypaisa'");
    await queryRun("ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS amount_currency TEXT DEFAULT 'PKR'");
    await queryRun('ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS credit_amount NUMERIC(12,2) DEFAULT 0');
    await queryRun('ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS note TEXT');
    await queryRun('ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS user_name_snapshot TEXT');
    await queryRun('ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS request_ip TEXT');
    await queryRun('ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS device_fingerprint TEXT');
    await queryRun('ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS browser_fingerprint TEXT');
    await queryRun('ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS proof_hash TEXT');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_payment_requests_proof_hash ON payment_requests (proof_hash) WHERE proof_hash IS NOT NULL');

    await queryRun(`
        CREATE TABLE IF NOT EXISTS referrals (
            id SERIAL PRIMARY KEY,
            referrer_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            referred_user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            referral_code TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            signup_ip TEXT,
            signup_device_fingerprint TEXT,
            signup_browser_fingerprint TEXT,
            referrer_signup_ip TEXT,
            referrer_signup_device_fingerprint TEXT,
            referrer_signup_browser_fingerprint TEXT,
            fraud_reason TEXT,
            qualifying_deposit_amount NUMERIC(12,2),
            qualifying_payment_request_id INTEGER REFERENCES payment_requests(id) ON DELETE SET NULL,
            reward_amount NUMERIC(12,2) DEFAULT 0,
            rewarded_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await queryRun('CREATE INDEX IF NOT EXISTS idx_referrals_referrer_user_id ON referrals (referrer_user_id, created_at DESC)');
    await queryRun('CREATE INDEX IF NOT EXISTS idx_referrals_referred_user_id ON referrals (referred_user_id)');

    if (ADMIN_EMAIL && ADMIN_PASSWORD) {
        const adminEmail = sanitizeEmail(ADMIN_EMAIL);
        const existingAdmin = normalizeUser(await queryOne('SELECT * FROM users WHERE email = $1', [adminEmail]));
        if (!existingAdmin) {
            const hashedAdminPassword = await hashPassword(ADMIN_PASSWORD);
            await queryRun(
                'INSERT INTO users (email, password, name, role, is_admin, referral_code) VALUES ($1, $2, $3, $4, $5, $6)',
                [adminEmail, hashedAdminPassword, ADMIN_NAME, 'admin', true, 'ADMIN']
            );
            console.log('Admin user created from environment variables');
        } else if (!isAdminUser(existingAdmin)) {
            await queryRun('UPDATE users SET role = $1, is_admin = TRUE WHERE id = $2', ['admin', existingAdmin.id]);
            console.log('Existing admin email promoted to admin privileges');
        }
    } else {
        console.log('ADMIN_EMAIL / ADMIN_PASSWORD not set, skipping admin auto-create');
    }

    await queryRun(`
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='transactions' AND column_name='transaction_id') THEN
        ALTER TABLE transactions ADD COLUMN transaction_id TEXT;
    END IF;
END $$;
    `);
    await queryRun('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS type TEXT DEFAULT \'deposit\'');
    await queryRun('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS description TEXT');
    await queryRun('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS request_ip TEXT');
    await queryRun('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS device_fingerprint TEXT');
    await queryRun('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS browser_fingerprint TEXT');
    await queryRun('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS proof_hash TEXT');
    await queryRun('UPDATE transactions SET type = $1 WHERE type IS NULL', ['deposit']);
    await ensureExistingReferralCodes();
    await queryRun('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code_unique ON users (referral_code) WHERE referral_code IS NOT NULL');
}

async function findUser(email) {
    return normalizeUser(await queryOne('SELECT * FROM users WHERE email = $1', [sanitizeEmail(email)]));
}

async function findUserById(id) {
    return normalizeUser(await queryOne('SELECT * FROM users WHERE id = $1', [id]));
}

async function findUserByReferralCode(referralCode) {
    const normalizedCode = normalizeReferralCode(referralCode);
    if (!normalizedCode) return null;
    return normalizeUser(await queryOne('SELECT * FROM users WHERE referral_code = $1', [normalizedCode]));
}

async function ensureExistingReferralCodes() {
    const users = await queryAll('SELECT id, name, referral_code FROM users ORDER BY id ASC');
    const seenCodes = new Set();
    for (const user of users) {
        const normalizedExistingCode = normalizeReferralCode(user.referral_code);
        const nextCode = !normalizedExistingCode || seenCodes.has(normalizedExistingCode)
            ? await generateUniqueReferralCode(user.name)
            : normalizedExistingCode;
        if (nextCode !== normalizedExistingCode) {
            await queryRun('UPDATE users SET referral_code = $1 WHERE id = $2', [nextCode, user.id]);
        }
        seenCodes.add(nextCode);
    }
}

async function createReferralRecord({ referrerUser, referredUser, signupIp, signupDeviceFingerprint, signupBrowserFingerprint }) {
    if (!referrerUser || !referredUser || Number(referrerUser.id) === Number(referredUser.id)) {
        return null;
    }
    await queryRun(
        `
            INSERT INTO referrals (
                referrer_user_id,
                referred_user_id,
                referral_code,
                status,
                signup_ip,
                signup_device_fingerprint,
                signup_browser_fingerprint,
                referrer_signup_ip,
                referrer_signup_device_fingerprint,
                referrer_signup_browser_fingerprint
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (referred_user_id) DO NOTHING
        `,
        [
            referrerUser.id,
            referredUser.id,
            referrerUser.referralCode || referrerUser.referral_code,
            'pending',
            normalizeClientIp(signupIp) || null,
            normalizeDeviceFingerprint(signupDeviceFingerprint) || null,
            normalizeBrowserFingerprint(signupBrowserFingerprint) || null,
            normalizeClientIp(referrerUser.signup_ip) || null,
            normalizeDeviceFingerprint(referrerUser.signup_device_fingerprint) || null,
            normalizeBrowserFingerprint(referrerUser.signup_browser_fingerprint) || null
        ]
    );
    return normalizeReferralRecord(await queryOne(
        `
            SELECT
                r.*,
                COALESCE(referrer.name, '') AS referrer_name,
                COALESCE(referrer.email, '') AS referrer_email,
                COALESCE(referred.name, '') AS referred_name,
                COALESCE(referred.email, '') AS referred_email
            FROM referrals r
            LEFT JOIN users referrer ON referrer.id = r.referrer_user_id
            LEFT JOIN users referred ON referred.id = r.referred_user_id
            WHERE r.referred_user_id = $1
        `,
        [referredUser.id]
    ));
}

async function createUser(name, email, password, options = {}) {
    const normalizedEmail = sanitizeEmail(email);
    const displayName = String(name || options.displayName || normalizedEmail.split('@')[0] || 'User').trim();
    const normalizedReferralCode = normalizeReferralCode(options.referralCode);
    const referrerUser = normalizedReferralCode ? await findUserByReferralCode(normalizedReferralCode) : null;
    if (normalizedReferralCode && !referrerUser) {
        throw new Error('Referral code is invalid');
    }
    const hashedPassword = await hashPassword(password);
    const referralCode = await generateUniqueReferralCode(displayName);
    const createdUser = normalizeUser(await queryOne(
        `
            INSERT INTO users (
                email,
                password,
                name,
                referral_code,
                referred_by_user_id,
                signup_ip,
                signup_device_fingerprint,
                signup_browser_fingerprint,
                "googleId",
                "displayName",
                "photo"
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
        `,
        [
            normalizedEmail,
            hashedPassword,
            displayName,
            referralCode,
            referrerUser ? referrerUser.id : null,
            normalizeClientIp(options.signupIp) || null,
            normalizeDeviceFingerprint(options.signupDeviceFingerprint) || null,
            normalizeBrowserFingerprint(options.signupBrowserFingerprint) || null,
            String(options.googleId || '').trim() || null,
            String(options.displayName || '').trim() || null,
            String(options.photo || '').trim() || null
        ]
    ));
    if (referrerUser && createdUser) {
        await createReferralRecord({
            referrerUser,
            referredUser: createdUser,
            signupIp: options.signupIp,
            signupDeviceFingerprint: options.signupDeviceFingerprint,
            signupBrowserFingerprint: options.signupBrowserFingerprint
        });
    }
    return createdUser;
}

async function getReferralRecordsByReferrerUserId(userId, limit = 100) {
    const rows = await queryAll(
        `
            SELECT
                r.*,
                COALESCE(referrer.name, '') AS referrer_name,
                COALESCE(referrer.email, '') AS referrer_email,
                COALESCE(referred.name, '') AS referred_name,
                COALESCE(referred.email, '') AS referred_email
            FROM referrals r
            LEFT JOIN users referrer ON referrer.id = r.referrer_user_id
            LEFT JOIN users referred ON referred.id = r.referred_user_id
            WHERE r.referrer_user_id = $1
            ORDER BY r.created_at DESC
            LIMIT $2
        `,
        [userId, limit]
    );
    return rows.map(normalizeReferralRecord);
}

async function getAdminReferralRecords(limit = 500) {
    const rows = await queryAll(
        `
            SELECT
                r.*,
                COALESCE(referrer.name, '') AS referrer_name,
                COALESCE(referrer.email, '') AS referrer_email,
                COALESCE(referred.name, '') AS referred_name,
                COALESCE(referred.email, '') AS referred_email
            FROM referrals r
            LEFT JOIN users referrer ON referrer.id = r.referrer_user_id
            LEFT JOIN users referred ON referred.id = r.referred_user_id
            ORDER BY r.created_at DESC
            LIMIT $1
        `,
        [limit]
    );
    return rows.map(normalizeReferralRecord);
}

async function getReferralProgramByUserId(userId, req) {
    const user = await findUserById(userId);
    if (!user) return null;
    const referrals = await getReferralRecordsByReferrerUserId(userId, 100);
    const rewardedCount = referrals.filter((entry) => String(entry.status || '').toLowerCase() === 'rewarded').length;
    const blockedCount = referrals.filter((entry) => String(entry.status || '').toLowerCase() === 'blocked').length;
    const totalRewards = referrals.reduce((sum, entry) => sum + Number(entry.reward_amount || 0), 0);
    return {
        referralCode: user.referralCode || '',
        referralLink: buildReferralLink(req, user.referralCode),
        bonusAmount: REFERRAL_BONUS_PKR,
        minDepositAmount: REFERRAL_MIN_DEPOSIT_PKR,
        stats: {
            totalReferrals: referrals.length,
            rewardedCount,
            blockedCount,
            pendingCount: referrals.length - rewardedCount - blockedCount,
            totalRewards
        },
        referrals
    };
}

async function determineReferralSecurityBlockReason(client, { referralRecord, approvedDeposit }) {
    const flags = new Set();
    const effectiveSignupIp = normalizeClientIp(referralRecord.signup_ip || approvedDeposit.request_ip);
    const effectiveSignupDevice = normalizeDeviceFingerprint(referralRecord.signup_device_fingerprint || approvedDeposit.device_fingerprint);
    const effectiveSignupBrowser = normalizeBrowserFingerprint(referralRecord.signup_browser_fingerprint || approvedDeposit.browser_fingerprint);
    const referrerSignupIp = normalizeClientIp(referralRecord.referrer_signup_ip);
    const referrerSignupDevice = normalizeDeviceFingerprint(referralRecord.referrer_signup_device_fingerprint);
    const referrerSignupBrowser = normalizeBrowserFingerprint(referralRecord.referrer_signup_browser_fingerprint);
    const normalizedTransactionId = normalizePaymentReference(approvedDeposit.transaction_id);
    const normalizedProofHash = String(approvedDeposit.proof_hash || '').trim();

    if (effectiveSignupIp && referrerSignupIp && effectiveSignupIp === referrerSignupIp) {
        flags.add('same IP');
    }
    if (effectiveSignupDevice && referrerSignupDevice && effectiveSignupDevice === referrerSignupDevice) {
        flags.add('same device fingerprint');
    }
    if (effectiveSignupBrowser && referrerSignupBrowser && effectiveSignupBrowser === referrerSignupBrowser) {
        flags.add('same browser fingerprint');
    }
    if (normalizedProofHash) {
        const duplicatePaymentProof = await client.query(
            `
                SELECT id
                FROM payment_requests
                WHERE user_id <> $1
                  AND LOWER(COALESCE(status, 'pending')) = 'approved'
                  AND proof_hash = $2
                LIMIT 1
            `,
            [approvedDeposit.user_id, normalizedProofHash]
        );
        if (duplicatePaymentProof.rows[0]) {
            flags.add('duplicate payment account');
        }
        const duplicateTransactionProof = await client.query(
            `
                SELECT id
                FROM transactions
                WHERE user_id <> $1
                  AND LOWER(COALESCE(status, 'pending')) = 'approved'
                  AND proof_hash = $2
                LIMIT 1
            `,
            [approvedDeposit.user_id, normalizedProofHash]
        );
        if (duplicateTransactionProof.rows[0]) {
            flags.add('duplicate payment account');
        }
    }
    if (normalizedTransactionId) {
        const duplicatePaymentReference = await client.query(
            `
                SELECT id
                FROM payment_requests
                WHERE user_id <> $1
                  AND LOWER(COALESCE(status, 'pending')) = 'approved'
                  AND transaction_id = $2
                LIMIT 1
            `,
            [approvedDeposit.user_id, normalizedTransactionId]
        );
        if (duplicatePaymentReference.rows[0]) {
            flags.add('duplicate payment account');
        }
        const duplicateTransactionReference = await client.query(
            `
                SELECT id
                FROM transactions
                WHERE user_id <> $1
                  AND LOWER(COALESCE(status, 'pending')) = 'approved'
                  AND transaction_id = $2
                LIMIT 1
            `,
            [approvedDeposit.user_id, normalizedTransactionId]
        );
        if (duplicateTransactionReference.rows[0]) {
            flags.add('duplicate payment account');
        }
    }
    if (effectiveSignupIp || effectiveSignupDevice || effectiveSignupBrowser) {
        const repeatedPattern = await client.query(
            `
                SELECT COUNT(*)::int AS match_count
                FROM referrals
                WHERE referrer_user_id = $1
                  AND referred_user_id <> $2
                  AND (
                        ($3 <> '' AND signup_ip = $3)
                     OR ($4 <> '' AND signup_device_fingerprint = $4)
                     OR ($5 <> '' AND signup_browser_fingerprint = $5)
                  )
            `,
            [
                referralRecord.referrer_user_id,
                referralRecord.referred_user_id,
                effectiveSignupIp || '',
                effectiveSignupDevice || '',
                effectiveSignupBrowser || ''
            ]
        );
        if (Number(repeatedPattern.rows[0]?.match_count || 0) > 0) {
            flags.add('suspicious multi-account behavior');
        }
    }
    return buildReferralSecurityReason([...flags]);
}

async function applyReferralBonusForApprovedDeposit(client, approvedDeposit) {
    const approvedAmount = Number(approvedDeposit.amount || 0);
    if (!Number.isFinite(approvedAmount) || approvedAmount < REFERRAL_MIN_DEPOSIT_PKR) {
        return { applied: false, reason: 'below_threshold' };
    }
    const referralResult = await client.query(
        `
            SELECT
                r.*,
                COALESCE(referrer.name, '') AS referrer_name,
                COALESCE(referrer.email, '') AS referrer_email,
                COALESCE(referred.name, '') AS referred_name,
                COALESCE(referred.email, '') AS referred_email
            FROM referrals r
            INNER JOIN users referrer ON referrer.id = r.referrer_user_id
            INNER JOIN users referred ON referred.id = r.referred_user_id
            WHERE r.referred_user_id = $1
            FOR UPDATE
        `,
        [approvedDeposit.user_id]
    );
    const referralRecord = referralResult.rows[0];
    if (!referralRecord) {
        return { applied: false, reason: 'no_referral' };
    }
    const currentStatus = String(referralRecord.status || 'pending').toLowerCase();
    if (currentStatus === 'rewarded' || referralRecord.rewarded_at) {
        return { applied: false, reason: 'already_rewarded' };
    }
    if (currentStatus === 'blocked') {
        return { applied: false, reason: 'blocked' };
    }
    const securityReason = await determineReferralSecurityBlockReason(client, { referralRecord, approvedDeposit });
    if (securityReason) {
        await client.query(
            `
                UPDATE referrals
                SET status = $1,
                    fraud_reason = $2,
                    qualifying_deposit_amount = COALESCE(qualifying_deposit_amount, $3)
                WHERE id = $4
            `,
            ['blocked', securityReason, approvedAmount, referralRecord.id]
        );
        return { applied: false, reason: 'blocked', message: securityReason };
    }
    await client.query('UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2', [REFERRAL_BONUS_PKR, referralRecord.referrer_user_id]);
    await client.query(
        `
            UPDATE referrals
            SET status = $1,
                fraud_reason = NULL,
                qualifying_deposit_amount = $2,
                qualifying_payment_request_id = COALESCE($3, qualifying_payment_request_id),
                reward_amount = $4,
                rewarded_at = CURRENT_TIMESTAMP
            WHERE id = $5
        `,
        ['rewarded', approvedAmount, approvedDeposit.id || null, REFERRAL_BONUS_PKR, referralRecord.id]
    );
    await client.query(
        `
            INSERT INTO transactions (
                user_id,
                user_email,
                amount,
                type,
                status,
                description,
                transaction_id,
                screenshot,
                request_ip,
                device_fingerprint,
                browser_fingerprint,
                proof_hash
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `,
        [
            referralRecord.referrer_user_id,
            referralRecord.referrer_email,
            REFERRAL_BONUS_PKR,
            'referral_bonus',
            'approved',
            `Referral bonus for ${referralRecord.referred_email || `user #${referralRecord.referred_user_id}`} after approved deposit`,
            null,
            null,
            normalizeClientIp(approvedDeposit.request_ip) || null,
            normalizeDeviceFingerprint(approvedDeposit.device_fingerprint) || null,
            normalizeBrowserFingerprint(approvedDeposit.browser_fingerprint) || null,
            String(approvedDeposit.proof_hash || '').trim() || null
        ]
    );
    return { applied: true, bonusAmount: REFERRAL_BONUS_PKR };
}

async function updateUserPassword(userId, newPlainPassword) {
    const hashed = await hashPassword(newPlainPassword);
    return queryRun('UPDATE users SET password = $1 WHERE id = $2', [hashed, userId]);
}

async function updateUserPasswordHash(userId, hashedPassword) {
    return queryRun('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);
}

async function savePasswordResetToken(userId, tokenHash, expiresAt) {
    return queryRun(
        'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
        [tokenHash, expiresAt, userId]
    );
}

async function clearPasswordResetToken(userId) {
    return queryRun(
        'UPDATE users SET reset_token = NULL, reset_token_expires = NULL WHERE id = $1',
        [userId]
    );
}

async function findUserByResetToken(token) {
    const tokenHash = hashToken(token);
    return normalizeUser(await queryOne(
        'SELECT * FROM users WHERE reset_token = $1 AND reset_token_expires > CURRENT_TIMESTAMP',
        [tokenHash]
    ));
}

async function getAllPaymentRequests() {
    const rows = await queryAll(`
        SELECT
            pr.*,
            COALESCE(NULLIF(pr.user_name_snapshot, ''), u.name, '') AS user_name,
            COALESCE(u.email, pr.user_email) AS user_email
        FROM payment_requests pr
        LEFT JOIN users u ON u.id = pr.user_id
        ORDER BY pr.id DESC
    `);
    return rows.map(normalizePaymentRequest);
}

async function getPaymentHistoryByUser(userId) {
    const rows = await queryAll(`
        SELECT
            pr.*,
            COALESCE(NULLIF(pr.user_name_snapshot, ''), u.name, '') AS user_name,
            COALESCE(u.email, pr.user_email) AS user_email
        FROM payment_requests pr
        LEFT JOIN users u ON u.id = pr.user_id
        WHERE pr.user_id = $1
        ORDER BY pr.id DESC
    `, [userId]);
    return rows.map(normalizePaymentRequest);
}

async function getPendingTransactions() {
    const rows = await queryAll(`
        SELECT
            t.*,
            COALESCE(u.name, '') AS user_name,
            COALESCE(u.email, t.user_email) AS user_email
        FROM transactions t
        LEFT JOIN users u ON u.id = t.user_id
        WHERE t.status = $1
        ORDER BY t.id DESC
    `, ['pending']);
    return rows.map(normalizeTransaction);
}

async function getTransactionHistory() {
    const rows = await queryAll(`
        SELECT
            t.*,
            COALESCE(u.name, '') AS user_name,
            COALESCE(u.email, t.user_email) AS user_email
        FROM transactions t
        LEFT JOIN users u ON u.id = t.user_id
        WHERE t.status <> $1
        ORDER BY t.id DESC
    `, ['pending']);
    return rows.map(normalizeTransaction);
}

async function approveTransaction(txId) {
    const client = await pool.connect();
    let screenshotToDelete = null;
    try {
        await client.query('BEGIN');
        const txRes = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [txId]);
        const tx = txRes.rows[0];
        if (!tx) throw new Error('Transaction not found');
        if (tx.status !== 'pending') throw new Error('Only pending transactions can be approved');
        screenshotToDelete = tx.screenshot || null;
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [tx.user_id]);
        const user = userRes.rows[0];
        if (!user) throw new Error('User not found');
        await client.query('UPDATE transactions SET status = $1, type = COALESCE(type, $2), screenshot = NULL WHERE id = $3', ['approved', 'deposit', txId]);
        await client.query(
            'UPDATE users SET balance = $1 WHERE id = $2',
            [Number(user.balance || 0) + Number(tx.amount || 0), tx.user_id]
        );
        if (String(tx.type || 'deposit').toLowerCase() === 'deposit') {
            await applyReferralBonusForApprovedDeposit(client, {
                ...tx,
                id: tx.id,
                request_ip: tx.request_ip || null,
                device_fingerprint: tx.device_fingerprint || null,
                browser_fingerprint: tx.browser_fingerprint || null,
                proof_hash: tx.proof_hash || null
            });
        }
        await client.query('COMMIT');
        await removeUploadedFile(screenshotToDelete);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function cancelTransaction(txId) {
    const client = await pool.connect();
    let screenshotToDelete = null;
    try {
        await client.query('BEGIN');
        const txRes = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [txId]);
        const tx = txRes.rows[0];
        if (!tx) throw new Error('Transaction not found');
        if (tx.status !== 'pending') throw new Error('Only pending transactions can be cancelled');
        screenshotToDelete = tx.screenshot || null;
        await client.query('UPDATE transactions SET status = $1, type = COALESCE(type, $2), screenshot = NULL WHERE id = $3', ['cancelled', 'deposit', txId]);
        await client.query('COMMIT');
        await removeUploadedFile(screenshotToDelete);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function getOrdersByUser(userId) {
    const rows = await queryAll(`
        SELECT *
        FROM orders
        WHERE user_id = $1
          AND COALESCE(status, order_status, 'pending') IN ('pending', 'active', 'completed_waiting_user_action')
          AND LOWER(COALESCE(status, 'pending')) NOT IN ('completed', 'cancelled', 'expired', 'expired_refunded')
          AND LOWER(COALESCE(order_status, 'pending')) NOT IN ('completed', 'cancelled', 'expired', 'expired_refunded')
          AND NOT (
              LOWER(COALESCE(status, order_status, 'pending')) = 'completed_waiting_user_action'
              AND expires_at IS NOT NULL
              AND expires_at <= CURRENT_TIMESTAMP
          )
        ORDER BY id DESC
    `, [userId]);
    return rows.map(normalizeOrder);
}

async function getAdminUsers() {
    const realProfitLossExpression = `COALESCE(o.real_profit_loss, (COALESCE(o.website_charge, COALESCE(o.price, 0)) - COALESCE(o.website_refund, 0) - COALESCE(o.real_provider_cost, 0)))`;
    const providerStatusExpression = `UPPER(COALESCE(NULLIF(TRIM(o.provider_final_status), ''), NULLIF(TRIM(o.provider_status), ''), NULLIF(TRIM(o.provider_last_status), ''), ''))`;
    const hasOtpExpression = `(COALESCE(o.otp_received, FALSE) = TRUE OR NULLIF(TRIM(COALESCE(o.otp_code, '')), '') IS NOT NULL)`;
    const providerSuccessExpression = `(${providerStatusExpression} LIKE 'STATUS_OK%' OR ${providerStatusExpression} ~ '(^|[_\\s-])SUCCESS($|[_\\s-])' OR ${providerStatusExpression} ~ '(^|[_\\s-])COMPLETED($|[_\\s-])')`;
    const benignRefundStatusExpression = `(${providerStatusExpression} = '' OR ${providerStatusExpression} = '${ORDER_PROVIDER_WAITING_STATUS}' OR ${providerStatusExpression} IN ('ACCESS_CANCEL', 'STATUS_CANCEL', 'EXPIRED', 'STATUS_EXPIRED', 'CANCELLED', 'CANCELED', 'STATUS_CANCELLED', 'STATUS_CANCELED'))`;
    const normalResolvedRefundExpression = `(LOWER(COALESCE(o.status, o.order_status, 'pending')) IN ('cancelled', 'expired', 'expired_refunded', 'refunded') AND COALESCE(o.website_refund, 0) > 0 AND NOT ${hasOtpExpression} AND NOT ${providerSuccessExpression} AND ${benignRefundStatusExpression})`;
    const confirmedLossExpression = `(GREATEST(-(${realProfitLossExpression}), 0) > 0 AND COALESCE(o.real_provider_cost, 0) > 0 AND NOT ${normalResolvedRefundExpression})`;
    const lossEventAtExpression = `COALESCE(o.refunded_at, o.completed_at, o.provider_status_synced_at, o.created_at)`;
    const rows = await queryAll(`
        SELECT
            u.id,
            u.name,
            u.email,
            u.balance,
            u.role,
            u.is_admin,
            u.created_at,
            u.security_risk_score,
            u.security_risk_status,
            u.security_blocked_until,
            u.security_block_reason,
            u.security_blocked_at,
            u.security_risk_reset_at,
            u.security_last_flagged_at,
            latest_loss.reason AS latest_security_reason,
            latest_loss.created_at AS latest_security_event_at,
            latest_loss.order_id AS latest_security_order_id,
            latest_loss.service_type AS latest_security_service,
            latest_loss.phone_number AS latest_security_number,
            COALESCE(latest_loss.provider_loss_amount, 0)::numeric AS latest_provider_loss_amount,
            COALESCE(loss_totals.total_provider_loss, 0)::numeric AS total_provider_loss,
            COALESCE(loss_totals.confirmed_provider_loss_count, 0)::int AS confirmed_provider_loss_count
        FROM users u
        LEFT JOIN LATERAL (
            SELECT
                o.id AS order_id,
                COALESCE(o.service_type, o.provider_service, 'unknown') AS service_type,
                o.phone_number,
                ${lossEventAtExpression} AS created_at,
                GREATEST(-(${realProfitLossExpression}), 0)::numeric AS provider_loss_amount,
                CASE
                    WHEN COALESCE(o.website_refund, 0) > 0 AND ${hasOtpExpression} THEN 'confirmed_provider_loss_refunded_with_otp'
                    WHEN COALESCE(o.website_refund, 0) > 0 AND ${providerSuccessExpression} THEN 'confirmed_provider_loss_refunded_after_provider_success'
                    ELSE 'confirmed_provider_loss_unrecovered'
                END AS reason
            FROM orders o
            WHERE o.user_id = u.id
              AND ${confirmedLossExpression}
              AND (u.security_risk_reset_at IS NULL OR ${lossEventAtExpression} > u.security_risk_reset_at)
            ORDER BY ${lossEventAtExpression} DESC, o.id DESC
            LIMIT 1
        ) latest_loss ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                COUNT(*)::int AS confirmed_provider_loss_count,
                COALESCE(SUM(GREATEST(-(${realProfitLossExpression}), 0)), 0)::numeric AS total_provider_loss
            FROM orders o
            WHERE o.user_id = u.id
              AND ${confirmedLossExpression}
              AND (u.security_risk_reset_at IS NULL OR ${lossEventAtExpression} > u.security_risk_reset_at)
        ) loss_totals ON TRUE
        ORDER BY u.id DESC
    `);
    return rows.map((row) => {
        const normalizedUser = normalizeUser(row);
        const confirmedProviderLossCount = Number(normalizedUser?.confirmed_provider_loss_count || 0);
        const derivedRiskScore = confirmedProviderLossCount >= 3
            ? 90
            : confirmedProviderLossCount === 2
                ? 60
                : confirmedProviderLossCount === 1
                    ? 30
                    : 0;
        const derivedRiskStatus = confirmedProviderLossCount >= 3
            ? 'dangerous'
            : (confirmedProviderLossCount > 0 ? 'suspicious' : 'safe');
        const activeBlock = normalizedUser?.security_blocked_until
            ? new Date(normalizedUser.security_blocked_until) > new Date()
            : false;
        return {
            ...normalizedUser,
            security_risk_score: activeBlock ? Math.max(80, derivedRiskScore) : derivedRiskScore,
            security_risk_status: activeBlock ? 'dangerous' : derivedRiskStatus
        };
    });
}

async function getAllBalanceAdjustments(limit = 300) {
    const rows = await queryAll(`
        SELECT
            ba.*,
            COALESCE(target_user.email, '') AS user_email,
            COALESCE(target_user.name, '') AS user_name,
            COALESCE(admin_user.email, '') AS admin_email,
            COALESCE(admin_user.name, '') AS admin_name
        FROM balance_adjustments ba
        LEFT JOIN users target_user ON target_user.id = ba.user_id
        LEFT JOIN users admin_user ON admin_user.id = ba.admin_id
        ORDER BY ba.created_at DESC
        LIMIT $1
    `, [limit]);
    return rows.map((row) => ({
        ...row,
        amount: Number(row.amount || 0)
    }));
}

async function getUserCombinedHistory(userId, limit = 300) {
    const rows = await queryAll(`
        SELECT *
        FROM (
            SELECT
                'order'::text AS entry_type,
                o.id::text AS reference_id,
                COALESCE(o.price, 0)::numeric AS amount,
                CONCAT(COALESCE(o.service_name, 'Service'), ' \u{2022} ', COALESCE(o.country, 'Unknown country')) AS details,
                COALESCE(o.status, o.order_status, 'pending') AS status,
                COALESCE(o.refunded_at, o.completed_at, o.provider_status_synced_at, o.created_at) AS created_at,
                COALESCE(o.website_refund, 0)::numeric AS refund_amount,
                COALESCE(o.real_provider_cost, 0)::numeric AS provider_deduction_amount,
                (COALESCE(o.otp_received, FALSE) = TRUE OR NULLIF(TRIM(COALESCE(o.otp_code, '')), '') IS NOT NULL) AS otp_received,
                NULLIF(TRIM(COALESCE(o.otp_code, '')), '') AS otp_code,
                COALESCE(o.provider_final_status, o.provider_status, o.provider_last_status, '') AS provider_status,
                GREATEST(-COALESCE(o.real_profit_loss, (COALESCE(o.website_charge, COALESCE(o.price, 0)) - COALESCE(o.website_refund, 0) - COALESCE(o.real_provider_cost, 0))), 0)::numeric AS provider_loss_amount,
                COALESCE(o.phone_number, '') AS phone_number,
                COALESCE(o.service_type, '') AS service_type,
                COALESCE(o.country, '') AS country
            FROM orders o
            WHERE o.user_id = $1

            UNION ALL

            SELECT
                LOWER(COALESCE(t.type, 'deposit'))::text AS entry_type,
                t.id::text AS reference_id,
                COALESCE(t.amount, 0)::numeric AS amount,
                COALESCE(t.description, 'Wallet deposit approved') AS details,
                COALESCE(t.status, 'approved') AS status,
                t.created_at AS created_at,
                0::numeric AS refund_amount,
                0::numeric AS provider_deduction_amount,
                FALSE AS otp_received,
                NULL::text AS otp_code,
                NULL::text AS provider_status,
                0::numeric AS provider_loss_amount,
                NULL::text AS phone_number,
                NULL::text AS service_type,
                NULL::text AS country
            FROM transactions t
            WHERE t.user_id = $1
              AND LOWER(COALESCE(t.type, '')) IN ('deposit', 'referral_bonus')

            UNION ALL

            SELECT
                'manual_adjustment'::text AS entry_type,
                ba.id::text AS reference_id,
                COALESCE(ba.amount, 0)::numeric AS amount,
                ba.reason AS details,
                'approved'::text AS status,
                ba.created_at AS created_at,
                0::numeric AS refund_amount,
                0::numeric AS provider_deduction_amount,
                FALSE AS otp_received,
                NULL::text AS otp_code,
                NULL::text AS provider_status,
                0::numeric AS provider_loss_amount,
                NULL::text AS phone_number,
                NULL::text AS service_type,
                NULL::text AS country
            FROM balance_adjustments ba
            WHERE ba.user_id = $1
        ) ledger
        ORDER BY created_at DESC
        LIMIT $2
    `, [userId, limit]);
    return rows.map((row) => ({
        ...row,
        amount: Number(row.amount || 0),
        refund_amount: Number(row.refund_amount || 0),
        provider_deduction_amount: Number(row.provider_deduction_amount || 0),
        otp_received: Boolean(row.otp_received),
        provider_loss_amount: Number(row.provider_loss_amount || 0)
    }));
}

async function getNumberHistoryByUser(userId, limit = 500) {
    const rows = await queryAll(`
        SELECT *
        FROM number_history
        WHERE user_id = $1
        ORDER BY COALESCE(last_event_at, updated_at, purchased_at, created_at) DESC, id DESC
        LIMIT $2
    `, [userId, limit]);
    return rows.map(normalizeNumberHistoryEntry);
}

function buildNumberHistorySnapshot(order, options = {}) {
    const normalizedOrder = normalizeOrder(order);
    const orderId = Number(normalizedOrder?.id);
    const userId = Number(normalizedOrder?.user_id);
    if (!Number.isFinite(orderId) || orderId <= 0 || !Number.isFinite(userId) || userId <= 0) {
        return null;
    }
    const lifecycleStatus = normalizeOrderStatus(normalizedOrder);
    const eventAt = toIsoTimestamp(options.eventAt, new Date().toISOString());
    const finalizedAt = toIsoTimestamp(options.finalizedAt, toIsoTimestamp(normalizedOrder.completed_at, eventAt));
    const otpReceivedAt = toIsoTimestamp(options.otpReceivedAt, toIsoTimestamp(normalizedOrder.sms_received_at, toIsoTimestamp(normalizedOrder.completed_at, eventAt)));
    const otpCode = String(normalizedOrder.otp_code || '').trim();
    const hasOtp = Boolean(normalizedOrder.otp_received || otpCode);
    return {
        user_id: userId,
        order_id: orderId,
        user_email: String(normalizedOrder.user_email || '').trim() || null,
        service_type: String(normalizedOrder.service_type || '').trim() || null,
        service_name: String(normalizedOrder.service_name || '').trim() || null,
        country: String(normalizedOrder.country || '').trim() || null,
        country_code: String(normalizedOrder.country_code || '').trim() || null,
        country_id: normalizedOrder.country_id == null ? null : Number(normalizedOrder.country_id),
        price: Number(normalizedOrder.price || 0),
        phone_number: String(normalizedOrder.phone_number || '').trim() || null,
        activation_id: String(normalizedOrder.activation_id || '').trim() || null,
        otp_received: hasOtp,
        otp_code: otpCode || null,
        status: lifecycleStatus,
        order_status: String(normalizedOrder.order_status || lifecycleStatus || '').trim().toLowerCase() || lifecycleStatus,
        purchased_at: toIsoTimestamp(normalizedOrder.created_at, eventAt),
        otp_received_at: hasOtp ? otpReceivedAt : null,
        final_status_at: ['completed', 'cancelled', 'expired'].includes(lifecycleStatus) ? finalizedAt : null,
        completed_at: lifecycleStatus === 'completed' ? toIsoTimestamp(normalizedOrder.completed_at, finalizedAt) : null,
        cancelled_at: lifecycleStatus === 'cancelled' ? finalizedAt : null,
        expired_at: lifecycleStatus === 'expired' ? finalizedAt : null,
        last_event_at: eventAt
    };
}

async function upsertNumberHistoryFromOrder(order, options = {}) {
    const snapshot = buildNumberHistorySnapshot(order, options);
    if (!snapshot) return null;
    const executor = options.client || pool;
    const result = await executor.query(`
        INSERT INTO number_history (
            user_id,
            order_id,
            user_email,
            service_type,
            service_name,
            country,
            country_code,
            country_id,
            price,
            phone_number,
            activation_id,
            otp_received,
            otp_code,
            status,
            order_status,
            purchased_at,
            otp_received_at,
            final_status_at,
            completed_at,
            cancelled_at,
            expired_at,
            last_event_at,
            updated_at
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, CURRENT_TIMESTAMP
        )
        ON CONFLICT (order_id) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            user_email = COALESCE(EXCLUDED.user_email, number_history.user_email),
            service_type = COALESCE(EXCLUDED.service_type, number_history.service_type),
            service_name = COALESCE(EXCLUDED.service_name, number_history.service_name),
            country = COALESCE(EXCLUDED.country, number_history.country),
            country_code = COALESCE(EXCLUDED.country_code, number_history.country_code),
            country_id = COALESCE(EXCLUDED.country_id, number_history.country_id),
            price = COALESCE(EXCLUDED.price, number_history.price),
            phone_number = COALESCE(EXCLUDED.phone_number, number_history.phone_number),
            activation_id = COALESCE(EXCLUDED.activation_id, number_history.activation_id),
            otp_received = COALESCE(number_history.otp_received, FALSE) OR COALESCE(EXCLUDED.otp_received, FALSE),
            otp_code = COALESCE(EXCLUDED.otp_code, number_history.otp_code),
            status = COALESCE(EXCLUDED.status, number_history.status),
            order_status = COALESCE(EXCLUDED.order_status, number_history.order_status),
            purchased_at = COALESCE(number_history.purchased_at, EXCLUDED.purchased_at),
            otp_received_at = COALESCE(number_history.otp_received_at, EXCLUDED.otp_received_at),
            final_status_at = COALESCE(EXCLUDED.final_status_at, number_history.final_status_at),
            completed_at = COALESCE(number_history.completed_at, EXCLUDED.completed_at),
            cancelled_at = COALESCE(number_history.cancelled_at, EXCLUDED.cancelled_at),
            expired_at = COALESCE(number_history.expired_at, EXCLUDED.expired_at),
            last_event_at = COALESCE(EXCLUDED.last_event_at, number_history.last_event_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        RETURNING *
    `, [
        snapshot.user_id,
        snapshot.order_id,
        snapshot.user_email,
        snapshot.service_type,
        snapshot.service_name,
        snapshot.country,
        snapshot.country_code,
        snapshot.country_id,
        snapshot.price,
        snapshot.phone_number,
        snapshot.activation_id,
        snapshot.otp_received,
        snapshot.otp_code,
        snapshot.status,
        snapshot.order_status,
        snapshot.purchased_at,
        snapshot.otp_received_at,
        snapshot.final_status_at,
        snapshot.completed_at,
        snapshot.cancelled_at,
        snapshot.expired_at,
        snapshot.last_event_at
    ]);
    return normalizeNumberHistoryEntry(result.rows[0]);
}

async function applyAdminBalanceAdjustment({ userId, adminId, amount, reason }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const targetUser = userRes.rows[0];
        if (!targetUser) throw new Error('Target user not found');

        const updatedUserRes = await client.query(
            'UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2 RETURNING *',
            [amount, userId]
        );
        const updatedUser = updatedUserRes.rows[0];

        await client.query(
            'INSERT INTO balance_adjustments (user_id, amount, reason, admin_id) VALUES ($1, $2, $3, $4)',
            [userId, amount, reason, adminId]
        );

        await client.query(
            'INSERT INTO transactions (user_id, user_email, amount, type, status, description) VALUES ($1, $2, $3, $4, $5, $6)',
            [userId, targetUser.email, amount, 'manual_adjustment', 'approved', `Manual balance adjustment: ${reason}`]
        );

        await client.query('COMMIT');
        return normalizeUser(updatedUser);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function applyAdminUserSecurityAction({ userId, action, reason, hours }) {
    const normalizedUserId = Number(userId);
    if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) {
        throw new Error('Invalid user id');
    }
    const normalizedAction = String(action || '').trim().toLowerCase();
    if (!['block', 'unblock', 'remove-risk'].includes(normalizedAction)) {
        throw new Error('Invalid security action');
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [normalizedUserId]);
        const user = normalizeUser(userRes.rows[0]);
        if (!user) throw new Error('User not found');
        const actionTime = new Date().toISOString();
        let blockedUntil = user.security_blocked_until || null;
        let riskScore = Number(user.security_risk_score || 0);
        let riskStatus = String(user.security_risk_status || 'safe').trim().toLowerCase() || 'safe';
        let blockReason = user.security_block_reason || null;
        let blockedAt = user.security_blocked_at || null;
        let riskResetAt = user.security_risk_reset_at || null;
        if (normalizedAction === 'block') {
            const blockHours = Math.max(1, Math.min(720, Number(hours || 24)));
            blockedUntil = new Date(Date.now() + blockHours * 60 * 60 * 1000).toISOString();
            riskScore = Math.max(riskScore, 80);
            riskStatus = 'dangerous';
            blockReason = String(reason || '').trim() || 'Manual admin block pending provider-loss review';
            blockedAt = actionTime;
        } else if (normalizedAction === 'unblock') {
            blockedUntil = null;
            blockReason = null;
            blockedAt = null;
            if (riskStatus === 'dangerous' && riskScore >= 80) {
                riskStatus = riskScore > 0 ? 'suspicious' : 'safe';
            }
        } else if (normalizedAction === 'remove-risk') {
            blockedUntil = null;
            riskScore = 0;
            riskStatus = 'safe';
            blockReason = null;
            blockedAt = null;
            riskResetAt = actionTime;
        }
        const result = await client.query(`
            UPDATE users
            SET security_risk_score = $1,
                security_risk_status = $2,
                security_blocked_until = $3,
                security_block_reason = $4,
                security_blocked_at = $5,
                security_risk_reset_at = $6,
                security_last_flagged_at = CASE WHEN $1 > 0 THEN COALESCE(security_last_flagged_at, CURRENT_TIMESTAMP) ELSE security_last_flagged_at END
            WHERE id = $7
            RETURNING *
        `, [
            riskScore,
            riskStatus,
            blockedUntil,
            blockReason,
            blockedAt,
            riskResetAt,
            normalizedUserId
        ]);
        await client.query('COMMIT');
        return {
            user: normalizeUser(result.rows[0]),
            action: normalizedAction,
            reason: String(reason || '').trim() || null
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function getOrderById(orderId) {
    return normalizeOrder(await queryOne('SELECT * FROM orders WHERE id = $1', [orderId]));
}

async function updateOrder(orderId, updates, options = {}) {
    const keys = Object.keys(updates);
    if (!keys.length) return null;
    const fields = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
    const values = keys.map((key) => updates[key]);
    values.push(orderId);
    const executor = options.client || pool;
    const result = await executor.query(`UPDATE orders SET ${fields} WHERE id = $${values.length} RETURNING *`, values);
    const updatedOrder = normalizeOrder(result.rows[0]);
    if (updatedOrder && options.syncNumberHistory !== false) {
        await upsertNumberHistoryFromOrder(updatedOrder, {
            client: options.client,
            eventAt: options.eventAt,
            otpReceivedAt: options.otpReceivedAt,
            finalizedAt: options.finalizedAt
        });
    }
    return updatedOrder;
}

async function getProviderBalance() {
    try {
        const url = `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}&action=${PROVIDER_BALANCE_ACTION}`;
        const response = await axios.get(url, { timeout: 15000 });
        return parseProviderBalanceResponse(response.data);
    } catch (err) {
        return {
            success: false,
            error: formatSafeError(err, 'Provider balance unavailable'),
            raw: ''
        };
    }
}

async function getLatestProviderBalanceSnapshot(options = {}) {
    const executor = options.client || pool;
    const result = await executor.query(`
        SELECT *
        FROM provider_balance_snapshots
        ORDER BY created_at DESC, id DESC
        LIMIT 1
    `);
    return result.rows[0] || null;
}

async function getLastProviderReconciliationSnapshot(options = {}) {
    const executor = options.client || pool;
    const result = await executor.query(`
        SELECT *
        FROM provider_balance_snapshots
        WHERE reason IN ('startup_reconciliation', 'scheduled_reconciliation')
        ORDER BY created_at DESC, id DESC
        LIMIT 1
    `);
    return result.rows[0] || null;
}

async function insertProviderBalanceSnapshot(snapshot, options = {}) {
    const providerBalance = Number(snapshot?.providerBalance);
    if (!Number.isFinite(providerBalance)) return null;
    const executor = options.client || pool;
    const previousBalance = snapshot?.previousBalance == null ? null : Number(snapshot.previousBalance);
    const delta = previousBalance == null || !Number.isFinite(previousBalance)
        ? null
        : roundMoney(previousBalance - providerBalance, 6);
    const deltaPkr = delta == null ? 0 : usdToPkr(delta);
    const result = await executor.query(`
        INSERT INTO provider_balance_snapshots (
            order_id,
            user_id,
            activation_id,
            reason,
            provider_balance,
            previous_balance,
            delta,
            delta_pkr,
            expected_spend_pkr,
            unmatched_delta_pkr,
            anomaly_flag,
            note
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
    `, [
        snapshot?.orderId == null ? null : Number(snapshot.orderId),
        snapshot?.userId == null ? null : Number(snapshot.userId),
        String(snapshot?.activationId || '').trim() || null,
        String(snapshot?.reason || 'unknown').trim() || 'unknown',
        roundMoney(providerBalance, 6),
        previousBalance == null || !Number.isFinite(previousBalance) ? null : roundMoney(previousBalance, 6),
        delta == null ? null : delta,
        roundMoney(deltaPkr, 2),
        roundMoney(snapshot?.expectedSpendPkr || 0, 2),
        roundMoney(snapshot?.unmatchedDeltaPkr || 0, 2),
        Boolean(snapshot?.anomalyFlag),
        String(snapshot?.note || '').trim() || null
    ]);
    logProviderAudit('balance_snapshot_recorded', {
        orderId: snapshot?.orderId ?? null,
        userId: snapshot?.userId ?? null,
        activationId: String(snapshot?.activationId || '').trim() || null,
        reason: String(snapshot?.reason || 'unknown').trim() || 'unknown',
        providerBalance: roundMoney(providerBalance, 6),
        previousBalance: previousBalance == null || !Number.isFinite(previousBalance) ? null : roundMoney(previousBalance, 6),
        delta: delta == null ? null : delta,
        anomalyFlag: Boolean(snapshot?.anomalyFlag)
    });
    return result.rows[0] || null;
}

async function insertProviderSecurityEvent(order, details = {}, options = {}) {
    const executor = options.client || pool;
    const normalizedOrder = normalizeOrder(order);
    const derivedOrder = normalizedOrder ? buildDerivedOrderMetrics(normalizedOrder) : null;
    const sourceOrder = derivedOrder || normalizedOrder || null;
    const riskFlag = Boolean(details.riskFlag ?? sourceOrder?.risk_flag ?? false);
    const lossDetected = Boolean(details.lossDetected ?? sourceOrder?.loss_detected ?? false);
    const criticalExploit = Boolean(details.criticalExploit ?? sourceOrder?.critical_exploit ?? false);
    const result = await executor.query(`
        INSERT INTO provider_security_events (
            order_id,
            user_id,
            username,
            service_type,
            country,
            phone_number,
            activation_id,
            event_type,
            reason,
            risk_flag,
            loss_detected,
            critical_exploit,
            provider_status,
            provider_final_status,
            provider_balance_before,
            provider_balance_after,
            real_provider_cost,
            website_charge,
            website_refund,
            real_profit_loss
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
        )
        RETURNING *
    `, [
        sourceOrder?.id == null ? null : Number(sourceOrder.id),
        sourceOrder?.user_id == null ? null : Number(sourceOrder.user_id),
        String(details.username || getOrderUsernameSnapshot(sourceOrder) || '').trim() || null,
        String(details.serviceType || sourceOrder?.service_type || sourceOrder?.provider_service || '').trim() || null,
        String(details.country || sourceOrder?.country || sourceOrder?.provider_country || '').trim() || null,
        String(details.phoneNumber || sourceOrder?.phone_number || sourceOrder?.provider_phone_number || '').trim() || null,
        String(details.activationId || sourceOrder?.activation_id || '').trim() || null,
        String(details.eventType || 'provider_security_event').trim() || 'provider_security_event',
        String(details.reason || details.exploitReason || sourceOrder?.exploit_reason || '').trim() || null,
        riskFlag,
        lossDetected,
        criticalExploit,
        String(details.providerStatus || sourceOrder?.provider_status || sourceOrder?.provider_last_status || '').trim() || null,
        String(details.providerFinalStatus || sourceOrder?.provider_final_status || '').trim() || null,
        sourceOrder?.provider_balance_before == null ? null : Number(sourceOrder.provider_balance_before),
        sourceOrder?.provider_balance_after == null ? null : Number(sourceOrder.provider_balance_after),
        getRealProviderCostAmount(sourceOrder),
        getWebsiteChargeAmount(sourceOrder),
        getWebsiteRefundAmount(sourceOrder),
        getRealProfitLossAmount(sourceOrder)
    ]);
    logProviderAudit('security_event_recorded', {
        orderId: sourceOrder?.id ?? null,
        userId: sourceOrder?.user_id ?? null,
        eventType: String(details.eventType || 'provider_security_event').trim() || 'provider_security_event',
        reason: String(details.reason || details.exploitReason || sourceOrder?.exploit_reason || '').trim() || null,
        riskFlag,
        lossDetected,
        criticalExploit
    });
    return result.rows[0] || null;
}

function deriveUserSecurityMetricsFromOrders(user, orders = []) {
    const resetAtMs = user?.security_risk_reset_at ? Date.parse(user.security_risk_reset_at) : NaN;
    const recentThreshold = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const confirmedLossOrders = [];
    for (const row of Array.isArray(orders) ? orders : []) {
        const normalizedOrder = normalizeOrder(row);
        if (!normalizedOrder) continue;
        const derivedOrder = buildDerivedOrderMetrics(normalizedOrder);
        if (!derivedOrder?.riskState?.lossDetected) continue;
        const eventAt = Date.parse(getOrderRiskEventTimestamp(derivedOrder));
        if (Number.isFinite(resetAtMs) && Number.isFinite(eventAt) && eventAt <= resetAtMs) {
            continue;
        }
        confirmedLossOrders.push({
            order: derivedOrder,
            eventAt: Number.isFinite(eventAt) ? eventAt : Date.now(),
            lossAmount: getConfirmedProviderLossAmount(derivedOrder)
        });
    }
    let latestLossOrder = null;
    let totalProviderLoss = 0;
    let suspiciousRecent = 0;
    let otpAfterCancelAttempts = 0;
    let criticalTotal = 0;
    let refundsToday = 0;
    for (const entry of confirmedLossOrders) {
        totalProviderLoss += entry.lossAmount;
        if (!latestLossOrder || entry.eventAt > latestLossOrder.eventAt) {
            latestLossOrder = entry;
        }
        if (entry.eventAt >= recentThreshold) {
            suspiciousRecent += 1;
        }
        if (entry.order?.riskState?.criticalExploit) {
            otpAfterCancelAttempts += 1;
            criticalTotal += 1;
        }
        const refundedAt = Date.parse(toIsoTimestamp(entry.order?.refunded_at, ''));
        if (getWebsiteRefundAmount(entry.order) > 0 && Number.isFinite(refundedAt) && refundedAt >= todayStart.getTime()) {
            refundsToday += 1;
        }
    }
    const refundAbuseCount = confirmedLossOrders.length;
    const riskScore = refundAbuseCount >= 3
        ? 90
        : refundAbuseCount === 2
            ? 60
            : refundAbuseCount === 1
                ? 30
                : 0;
    return {
        cancellationsLastHour: 0,
        refundsToday,
        suspiciousRecent,
        otpAfterCancelAttempts,
        refundAbuseCount,
        criticalTotal,
        totalProviderLoss: roundMoney(totalProviderLoss),
        latestLossOrder: latestLossOrder?.order || null,
        autoBlockEligible: refundAbuseCount >= 3,
        riskScore,
        riskStatus: refundAbuseCount >= 3 ? 'dangerous' : (refundAbuseCount > 0 ? 'suspicious' : 'safe')
    };
}

async function getUserSecurityMetrics(userId, options = {}) {
    const normalizedUserId = Number(userId);
    if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) return null;
    const executor = options.client || pool;
    const userRes = await executor.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [normalizedUserId]);
    const user = normalizeUser(userRes.rows[0]);
    if (!user) return null;
    const ordersRes = await executor.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC', [normalizedUserId]);
    return {
        user,
        ...deriveUserSecurityMetricsFromOrders(user, ordersRes.rows)
    };
}

async function syncUserSecurityState(userId, options = {}) {
    const metrics = await getUserSecurityMetrics(userId, options);
    if (!metrics) return null;
    const executor = options.client || pool;
    const now = new Date();
    const existingBlockedUntil = metrics.user?.security_blocked_until ? new Date(metrics.user.security_blocked_until) : null;
    const existingBlockActive = existingBlockedUntil && existingBlockedUntil > now;
    let blockedUntil = existingBlockActive ? existingBlockedUntil : null;
    let blockReason = existingBlockActive ? (metrics.user?.security_block_reason || null) : null;
    let blockedAt = existingBlockActive ? toIsoTimestamp(metrics.user?.security_blocked_at, now.toISOString()) : null;
    if (metrics.autoBlockEligible) {
        if (!blockedUntil || isAutoSecurityBlockReason(blockReason)) {
            blockedUntil = new Date(now.getTime() + SECURITY_AUTO_BLOCK_HOURS * 60 * 60 * 1000);
            blockReason = 'auto_block_confirmed_provider_loss';
            blockedAt = blockedAt || now.toISOString();
        }
    } else if (!existingBlockActive) {
        blockedUntil = null;
        blockReason = null;
        blockedAt = null;
    }
    const blockedUntilIso = blockedUntil ? blockedUntil.toISOString() : null;
    const result = await executor.query(`
        UPDATE users
        SET security_risk_score = $1,
            security_risk_status = $2,
            security_blocked_until = $3,
            security_block_reason = $4,
            security_blocked_at = $5,
            security_last_flagged_at = CASE WHEN $1 > 0 THEN CURRENT_TIMESTAMP ELSE security_last_flagged_at END
        WHERE id = $6
        RETURNING *
    `, [
        metrics.riskScore,
        metrics.riskStatus,
        blockedUntilIso,
        blockReason,
        blockedAt,
        Number(userId)
    ]);
    return {
        ...metrics,
        user: normalizeUser(result.rows[0]),
        blockedUntil: blockedUntilIso
    };
}

async function syncOrderFinancialProtection(order, details = {}, options = {}) {
    const normalizedOrder = normalizeOrder(order);
    if (!normalizedOrder?.id) return null;
    const derived = buildDerivedOrderMetrics(normalizedOrder, {
        websiteCharge: details.websiteCharge,
        websiteRefund: details.websiteRefund,
        websiteProfit: details.websiteProfit,
        realProviderCost: details.realProviderCost,
        realProfitLoss: details.realProfitLoss,
        providerStatus: details.providerStatus,
        providerFinalStatus: details.providerFinalStatus,
        providerUsed: details.providerUsed,
        postClosePollCount: details.postClosePollCount
    });
    const updates = {
        website_charge: derived.website_charge,
        website_refund: derived.website_refund,
        website_profit: derived.website_profit,
        real_provider_cost: derived.real_provider_cost,
        real_profit_loss: derived.real_profit_loss,
        provider_status: derived.provider_status,
        provider_final_status: derived.provider_final_status,
        provider_used: derived.provider_used,
        risk_flag: derived.riskState.riskFlag,
        loss_detected: derived.riskState.lossDetected,
        critical_exploit: derived.riskState.criticalExploit,
        exploit_reason: derived.riskState.exploitReason,
        exploit_reason_detail: derived.riskState.exploitReasonDetail,
        post_close_poll_count: derived.post_close_poll_count,
        refund_locked_at: derived.provider_used
            ? (normalizedOrder.refund_locked_at || details.refundLockedAt || details.eventAt || new Date().toISOString())
            : normalizedOrder.refund_locked_at || null
    };
    if (details.realProviderCostProviderCurrency !== undefined) {
        updates.real_provider_cost_provider_currency = roundMoney(details.realProviderCostProviderCurrency || 0, 6);
    }
    if (details.providerCostSource !== undefined) {
        updates.provider_cost_source = String(details.providerCostSource || '').trim() || null;
    }
    if (details.providerCostVerified !== undefined) {
        updates.provider_cost_verified = Boolean(details.providerCostVerified);
    }
    if (details.providerBalanceBefore !== undefined) {
        updates.provider_balance_before = details.providerBalanceBefore == null ? null : roundMoney(details.providerBalanceBefore, 6);
    }
    if (details.providerBalanceAfter !== undefined) {
        updates.provider_balance_after = details.providerBalanceAfter == null ? null : roundMoney(details.providerBalanceAfter, 6);
    }
    if (details.providerBalanceCurrency !== undefined) {
        updates.provider_balance_currency = String(details.providerBalanceCurrency || PROVIDER_BALANCE_CURRENCY).trim() || PROVIDER_BALANCE_CURRENCY;
    }
    if (details.providerPartnerId !== undefined) {
        updates.provider_partner_id = details.providerPartnerId == null ? null : Number(details.providerPartnerId);
    }
    if (details.providerPriceUsd !== undefined) {
        updates.provider_price_usd = details.providerPriceUsd == null ? 0 : roundMoney(details.providerPriceUsd, 6);
    }
    if (details.providerCountry !== undefined) {
        updates.provider_country = String(details.providerCountry || '').trim() || null;
    }
    if (details.providerService !== undefined) {
        updates.provider_service = String(details.providerService || '').trim() || null;
    }
    if (details.providerPhoneNumber !== undefined) {
        updates.provider_phone_number = String(details.providerPhoneNumber || '').trim() || null;
    }
    if (details.providerStatusSyncedAt !== undefined) {
        updates.provider_status_synced_at = details.providerStatusSyncedAt || null;
    }
    if (details.providerUsedAt !== undefined) {
        updates.provider_used_at = details.providerUsedAt || null;
    }
    if (details.refundedAt !== undefined) {
        updates.refunded_at = details.refundedAt || null;
    }
    if (details.usernameSnapshot !== undefined) {
        updates.username_snapshot = String(details.usernameSnapshot || '').trim() || null;
    }
    const updatedOrder = await updateOrder(normalizedOrder.id, updates, {
        client: options.client,
        eventAt: details.eventAt,
        otpReceivedAt: details.otpReceivedAt,
        finalizedAt: details.finalizedAt,
        syncNumberHistory: details.syncNumberHistory
    });
    const finalOrder = updatedOrder || normalizeOrder({ ...normalizedOrder, ...updates });
    const shouldRecordEvent = Boolean(details.recordSecurityEvent)
        || (details.recordRiskEvent !== false && finalOrder?.risk_flag);
    if (shouldRecordEvent) {
        await insertProviderSecurityEvent(finalOrder, {
            eventType: finalOrder?.loss_detected ? 'confirmed_provider_loss' : (details.securityEventType || (finalOrder?.critical_exploit ? 'critical_exploit_detected' : 'risk_flag_detected')),
            reason: details.reason || finalOrder?.exploit_reason || null,
            riskFlag: finalOrder?.risk_flag,
            lossDetected: finalOrder?.loss_detected,
            criticalExploit: finalOrder?.critical_exploit,
            providerStatus: finalOrder?.provider_status,
            providerFinalStatus: finalOrder?.provider_final_status
        }, {
            client: options.client
        });
    }
    if (details.syncUserRisk !== false && finalOrder?.user_id != null) {
        await syncUserSecurityState(finalOrder.user_id, { client: options.client });
    }
    return finalOrder;
}

async function registerClosedOrderAccess(order, details = {}, options = {}) {
    const normalizedOrder = normalizeOrder(order);
    if (!normalizedOrder?.id) return null;
    const nextPollCount = Number(normalizedOrder.post_close_poll_count || 0) + 1;
    return syncOrderFinancialProtection(normalizedOrder, {
        postClosePollCount: nextPollCount,
        securityEventType: details.eventType || 'post_close_otp_poll',
        reason: String(details.reason || '').trim() || 'closed_order_access',
        recordRiskEvent: false,
        syncNumberHistory: false,
        syncUserRisk: false,
        eventAt: details.eventAt || new Date().toISOString()
    }, options);
}

async function assertUserNotSecurityBlocked(userId, options = {}) {
    const metrics = await syncUserSecurityState(userId, options);
    if (!metrics?.user) {
        throw new Error('User not found');
    }
    if (metrics.blockedUntil && new Date(metrics.blockedUntil) > new Date()) {
        throw new Error('Account is currently blocked for manual admin review. Please contact support.');
    }
    return metrics;
}

async function enforceCancelSecurityLimits(userId, order, options = {}) {
    void order;
    return assertUserNotSecurityBlocked(userId, options);
}

async function updateProviderActivationStatus(activationId, status) {
    if (!activationId) return { success: false, skipped: true };
    try {
        const url = `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}&action=setStatus&id=${activationId}&status=${status}`;
        const response = await axios.get(url, { timeout: 15000 });
        return {
            success: true,
            raw: typeof response?.data === 'string' ? response.data.trim() : String(response?.data || '').trim() || null
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function analyzeProviderSmsResult(result) {
    const rawStatus = String(result?.raw || '').trim();
    const normalizedRawStatus = rawStatus.toUpperCase();
    const parsedCode = normalizedRawStatus.startsWith('STATUS_OK:')
        ? rawStatus.slice(rawStatus.indexOf(':') + 1).trim()
        : '';
    const code = String(result?.code || parsedCode).trim();
    if (code) {
        return {
            rawStatus: rawStatus || `STATUS_OK:${code}`,
            code,
            hasCode: true,
            providerPending: false,
            providerReportedNonPending: true,
            providerValidationFailed: false,
            providerCancelled: false,
            providerError: null
        };
    }
    if ((result?.success && result?.waiting) || normalizedRawStatus === ORDER_PROVIDER_WAITING_STATUS) {
        return {
            rawStatus: rawStatus || ORDER_PROVIDER_WAITING_STATUS,
            code: '',
            hasCode: false,
            providerPending: true,
            providerReportedNonPending: false,
            providerValidationFailed: false,
            providerCancelled: false,
            providerError: null
        };
    }
    if (normalizedRawStatus === 'ACCESS_CANCEL' || normalizedRawStatus === 'STATUS_CANCEL') {
        return {
            rawStatus,
            code: '',
            hasCode: false,
            providerPending: false,
            providerReportedNonPending: false,
            providerValidationFailed: false,
            providerCancelled: true,
            providerError: null
        };
    }
    if (normalizedRawStatus) {
        return {
            rawStatus,
            code: '',
            hasCode: false,
            providerPending: false,
            providerReportedNonPending: true,
            providerValidationFailed: false,
            providerCancelled: false,
            providerError: null
        };
    }
    return {
        rawStatus: '',
        code: '',
        hasCode: false,
        providerPending: false,
        providerReportedNonPending: false,
        providerValidationFailed: true,
        providerCancelled: false,
        providerError: String(result?.error || '').trim() || 'Provider status unavailable'
    };
}

async function verifyRefundEligibilityWithProvider(order) {
    const normalizedOrder = normalizeOrder(order);
    if (!normalizedOrder?.activation_id) {
        return {
            providerSignal: null,
            providerValidationFailed: false,
            decision: buildRefundDecision(normalizedOrder)
        };
    }
    const providerSignal = analyzeProviderSmsResult(await checkSmsStatus(normalizedOrder.activation_id));
    if (providerSignal.providerValidationFailed) {
        return {
            providerSignal,
            providerValidationFailed: true,
            decision: {
                ...buildRefundDecision(normalizedOrder),
                providerStatus: providerSignal.rawStatus || null,
                refundAllowed: false,
                reason: 'provider_final_verification_failed'
            }
        };
    }
    return {
        providerSignal,
        providerValidationFailed: false,
        decision: buildRefundDecision(normalizedOrder, providerSignal)
    };
}

async function syncOrderWithProviderSignal(order, providerSignal, options = {}) {
    if (!order || order.id == null || !providerSignal?.providerReportedNonPending) {
        return normalizeOrder(order);
    }
    const eventAt = toIsoTimestamp(options.eventAt, new Date().toISOString());
    const updates = {
        sms_received: true,
        sms_received_at: eventAt,
        provider_last_status: providerSignal.rawStatus || String(order.provider_last_status || '').trim() || null,
        provider_status: providerSignal.rawStatus || String(order.provider_status || order.provider_last_status || '').trim() || null,
        provider_final_status: providerSignal.rawStatus || String(order.provider_final_status || '').trim() || null,
        provider_status_synced_at: eventAt,
        provider_used: true,
        provider_used_at: order.provider_used_at || eventAt,
        refund_locked_at: order.refund_locked_at || eventAt
    };
    if (providerSignal.hasCode) {
        updates.otp_received = true;
        updates.otp_code = providerSignal.code;
        updates.order_status = 'completed_waiting_user_action';
        updates.status = 'completed_waiting_user_action';
    }
    const updatedOrder = await updateOrder(order.id, updates, {
        client: options.client,
        eventAt,
        otpReceivedAt: providerSignal.hasCode ? eventAt : options.otpReceivedAt,
        finalizedAt: options.finalizedAt,
        syncNumberHistory: options.syncNumberHistory
    });
    return syncOrderFinancialProtection(updatedOrder, {
        providerStatus: updates.provider_status,
        providerFinalStatus: updates.provider_final_status,
        providerUsed: true,
        providerUsedAt: updates.provider_used_at,
        providerStatusSyncedAt: eventAt,
        refundLockedAt: updates.refund_locked_at,
        securityEventType: providerSignal.hasCode ? 'provider_otp_received' : 'provider_sms_received',
        reason: providerSignal.hasCode ? 'provider_code_received' : 'provider_status_changed',
        recordRiskEvent: false,
        syncUserRisk: false,
        syncNumberHistory: false,
        eventAt,
        otpReceivedAt: providerSignal.hasCode ? eventAt : options.otpReceivedAt,
        finalizedAt: options.finalizedAt
    }, {
        client: options.client
    });
}

async function syncOrderForProviderDisplay(order, options = {}) {
    const normalizedOrder = normalizeOrder(order);
    if (!normalizedOrder?.id || !normalizedOrder.activation_id || hasStoredOtp(normalizedOrder) || isFinalOrderState(normalizedOrder)) {
        return normalizedOrder;
    }
    const lifecycleStatus = normalizeOrderStatus(normalizedOrder);
    if (!['pending', 'active'].includes(lifecycleStatus)) {
        return normalizedOrder;
    }
    const eventAt = toIsoTimestamp(options.eventAt, new Date().toISOString());
    try {
        const providerSignal = analyzeProviderSmsResult(await checkSmsStatus(normalizedOrder.activation_id));
        if (providerSignal.providerValidationFailed || providerSignal.providerPending || providerSignal.providerCancelled || !providerSignal.providerReportedNonPending) {
            return normalizedOrder;
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const lockedOrderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [normalizedOrder.id]);
            const lockedOrder = normalizeOrder(lockedOrderRes.rows[0]);
            if (!lockedOrder) {
                await client.query('ROLLBACK');
                return normalizedOrder;
            }
            if (!lockedOrder.activation_id || hasStoredOtp(lockedOrder) || isFinalOrderState(lockedOrder)) {
                await client.query('COMMIT');
                return lockedOrder;
            }
            const syncedOrder = await syncOrderWithProviderSignal(lockedOrder, providerSignal, {
                client,
                eventAt,
                otpReceivedAt: providerSignal.hasCode ? eventAt : options.otpReceivedAt,
                syncNumberHistory: true
            });
            await client.query('COMMIT');
            return syncedOrder;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        logProviderAudit('display_order_provider_sync_failed', {
            orderId: normalizedOrder.id,
            activationId: normalizedOrder.activation_id,
            error: formatSafeError(err, 'Provider display sync failed')
        });
        return normalizedOrder;
    }
}

async function syncUserOrdersForProviderDisplay(orders, options = {}) {
    const syncedOrders = [];
    for (const order of Array.isArray(orders) ? orders : []) {
        syncedOrders.push(await syncOrderForProviderDisplay(order, options));
    }
    return syncedOrders;
}

async function expireOrderAndRefund(orderId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
        let order = normalizeOrder(orderRes.rows[0]);
        if (!order) {
            await client.query('ROLLBACK');
            return { found: false, expired: false, refunded: false, order: null };
        }
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [order.user_id]);
        const user = userRes.rows[0] || null;
        const auditUsername = getAuditUsername(user, order);
        if (getRawOrderStatus(order) === 'expired') {
            await client.query('COMMIT');
            return {
                found: true,
                expired: true,
                refunded: getWebsiteRefundAmount(order) > 0,
                order: normalizeOrder(order),
                message: getWebsiteRefundAmount(order) > 0
                    ? EXPIRED_REFUND_MESSAGE
                    : 'Order expired, but refund is blocked until provider status verification completes.'
            };
        }
        const expiry = order.expires_at ? new Date(order.expires_at) : null;
        const now = new Date();
        const refundTime = now.toISOString();
        if (isRefundProcessing(order)) {
            await client.query('COMMIT');
            return {
                found: true,
                expired: false,
                refunded: false,
                order,
                message: 'Refund is already being processed.'
            };
        }
        if (isFinalOrderState(order) || normalizeOrderStatus(order) !== 'pending' || hasStoredOtp(order) || !expiry || now < expiry) {
            await client.query('COMMIT');
            if (hasStoredOtp(order)) {
                logOrderHotfixEvent('refund_blocked_existing_otp', order, {
                    username: auditUsername,
                    refundTime,
                    providerStatus: getProviderOrderStatus(order),
                    reason: 'otp_exists_in_database',
                    refunded: false,
                    otpExisted: true
                });
            }
            return {
                found: true,
                expired: false,
                refunded: false,
                order,
                message: hasStoredOtp(order)
                    ? 'OTP already received. Refund blocked.'
                    : 'Order is still active.'
            };
        }
        if (order.activation_id) {
            const initialVerification = await verifyRefundEligibilityWithProvider(order);
            if (initialVerification.providerValidationFailed) {
                await client.query('COMMIT');
                logOrderHotfixEvent('refund_blocked_provider_validation', order, {
                    username: auditUsername,
                    refundTime,
                    providerStatus: initialVerification.decision.providerStatus || null,
                    providerError: initialVerification.providerSignal?.providerError,
                    reason: 'provider_final_verification_failed',
                    refunded: false,
                    otpExisted: initialVerification.decision.otpExists,
                    providerSuccess: initialVerification.decision.providerSuccess
                });
                return {
                    found: true,
                    expired: false,
                    refunded: false,
                    order,
                    message: 'Refund temporarily locked while activation status is being verified.'
                };
            }
            if (!initialVerification.decision.refundAllowed) {
                const updatedOrder = initialVerification.providerSignal?.providerReportedNonPending
                    ? await syncOrderWithProviderSignal(order, initialVerification.providerSignal, {
                        client,
                        eventAt: refundTime,
                        otpReceivedAt: refundTime
                    })
                    : order;
                await client.query('COMMIT');
                logOrderHotfixEvent(initialVerification.decision.providerOtpExists ? 'refund_blocked_provider_otp' : 'refund_blocked_provider_success', updatedOrder, {
                    username: auditUsername,
                    refundTime,
                    otpArrivalTime: initialVerification.decision.providerOtpExists ? refundTime : null,
                    providerStatus: initialVerification.decision.providerStatus || null,
                    reason: initialVerification.decision.reason,
                    refunded: false,
                    otpExisted: initialVerification.decision.otpExists,
                    providerSuccess: initialVerification.decision.providerSuccess
                });
                return {
                    found: true,
                    expired: false,
                    refunded: false,
                    order: updatedOrder,
                    message: getRefundBlockedMessage(initialVerification.decision)
                };
            }
        }
        order = await setRefundProcessingState(order.id, refundTime, client) || normalizeOrder({
            ...order,
            refund_processing_at: refundTime
        });
        const providerBalanceBaselineForExpire = await getProviderBalance();
        const expireCancelResult = await updateProviderActivationStatus(order.activation_id, 8);
        const providerBalanceAfterExpire = await getProviderBalance();
        const providerRecovery = computeProviderRefundRecoveryMetrics(order, {
            balanceBeforeAction: providerBalanceBaselineForExpire.success
                ? providerBalanceBaselineForExpire.balance
                : (order.provider_balance_after == null ? null : Number(order.provider_balance_after)),
            balanceAfterAction: providerBalanceAfterExpire.success
                ? providerBalanceAfterExpire.balance
                : null
        });
        const previousProviderCostCurrency = roundMoney(order.real_provider_cost_provider_currency || 0, 6);
        const providerCostAlreadyClear = previousProviderCostCurrency <= PROVIDER_BALANCE_EPSILON
            && getRealProviderCostAmount(order) <= PROVIDER_BALANCE_EPSILON;
        const providerCostVerified = !order.activation_id
            || providerCostAlreadyClear
            || (providerRecovery.balanceVerified && expireCancelResult.success);
        const remainingProviderCostCurrency = providerCostAlreadyClear
            ? 0
            : (providerCostVerified ? providerRecovery.remainingCurrency : previousProviderCostCurrency);
        const remainingProviderCostPkr = providerCostAlreadyClear
            ? 0
            : (providerCostVerified ? providerRecovery.remainingPkr : getRealProviderCostAmount(order));
        const finalVerification = await verifyRefundEligibilityWithProvider(order);
        if (!finalVerification.providerValidationFailed && !finalVerification.decision.refundAllowed) {
            const blockedSyncedOrder = finalVerification.providerSignal?.providerReportedNonPending
                ? await syncOrderWithProviderSignal(order, finalVerification.providerSignal, {
                    client,
                    eventAt: refundTime,
                    otpReceivedAt: refundTime
                })
                : order;
            const clearedBlockedOrder = await setRefundProcessingState(blockedSyncedOrder?.id || order.id, null, client);
            const updatedOrder = clearedBlockedOrder || normalizeOrder({
                ...(blockedSyncedOrder || order),
                refund_processing_at: null
            });
            await client.query('COMMIT');
            logOrderHotfixEvent(finalVerification.decision.providerOtpExists ? 'refund_blocked_provider_otp' : 'refund_blocked_provider_success', updatedOrder, {
                username: auditUsername,
                refundTime,
                otpArrivalTime: finalVerification.decision.providerOtpExists ? refundTime : null,
                providerStatus: finalVerification.decision.providerStatus || null,
                reason: finalVerification.decision.reason,
                refunded: false,
                otpExisted: finalVerification.decision.otpExists,
                providerSuccess: finalVerification.decision.providerSuccess
            });
            return {
                found: true,
                expired: false,
                refunded: false,
                order: updatedOrder,
                message: getRefundBlockedMessage(finalVerification.decision)
            };
        }
        const refundAllowed = finalVerification.decision.refundAllowed;
        const walletRefundAmount = refundAllowed && user ? Number(order.price || 0) : 0;
        if (walletRefundAmount > 0 && user) {
            await client.query('UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2', [
                walletRefundAmount,
                user.id
            ]);
        }
        const expiredAt = refundTime;
        const expiredOrder = await updateOrder(order.id, {
            order_status: 'expired',
            status: 'expired',
            provider_last_status: finalVerification.decision.providerStatus || expireCancelResult.raw || order.provider_last_status || null,
            refund_processing_at: null
        }, {
            client,
            eventAt: expiredAt,
            finalizedAt: expiredAt,
            syncNumberHistory: false
        });
        const blockedReason = finalVerification.providerValidationFailed
            ? 'provider_final_verification_failed'
            : finalVerification.decision.reason;
        const updatedOrder = await syncOrderFinancialProtection(expiredOrder, {
            websiteCharge: Number(order.price || 0),
            websiteRefund: walletRefundAmount,
            websiteProfit: roundMoney(Number(order.price || 0) - walletRefundAmount),
            realProviderCost: remainingProviderCostPkr,
            realProviderCostProviderCurrency: remainingProviderCostCurrency,
            providerCostVerified: providerCostVerified || Boolean(order.provider_cost_verified),
            providerCostSource: providerCostVerified ? 'expire_balance_reconciliation' : order.provider_cost_source,
            providerBalanceAfter: providerBalanceAfterExpire.success
                ? providerBalanceAfterExpire.balance
                : order.provider_balance_after,
            providerBalanceCurrency: providerBalanceAfterExpire.currency || order.provider_balance_currency || PROVIDER_BALANCE_CURRENCY,
            providerStatus: finalVerification.decision.providerStatus || expireCancelResult.raw || order.provider_status || order.provider_last_status || null,
            providerFinalStatus: finalVerification.decision.providerStatus || expireCancelResult.raw || order.provider_final_status || null,
            providerStatusSyncedAt: expiredAt,
            providerUsed: isProviderUsedOrder(order),
            refundedAt: walletRefundAmount > 0 ? expiredAt : null,
            securityEventType: walletRefundAmount > 0 ? 'expire_refund_completed' : 'expire_refund_blocked_provider_verification',
            reason: walletRefundAmount > 0
                ? 'order_expired'
                : blockedReason,
            recordRiskEvent: walletRefundAmount <= 0,
            syncNumberHistory: true,
            syncUserRisk: walletRefundAmount <= 0,
            eventAt: expiredAt,
            finalizedAt: expiredAt
        }, {
            client
        });
        if (providerBalanceAfterExpire.success) {
            await insertProviderBalanceSnapshot({
                orderId: updatedOrder?.id || order.id,
                userId: order.user_id,
                activationId: order.activation_id,
                reason: walletRefundAmount > 0 ? 'order_expire_after' : 'order_expire_after_blocked',
                providerBalance: providerBalanceAfterExpire.balance,
                previousBalance: providerBalanceBaselineForExpire.success
                    ? providerBalanceBaselineForExpire.balance
                    : (order.provider_balance_after == null ? null : Number(order.provider_balance_after)),
                expectedSpendPkr: remainingProviderCostPkr,
                note: expireCancelResult.raw || (walletRefundAmount > 0 ? 'order_expire' : 'expire_refund_blocked')
            }, {
                client
            });
        }
        await client.query('COMMIT');
        logOrderHotfixEvent(walletRefundAmount > 0 ? 'refund_completed_expired_order' : 'refund_blocked_expired_provider_verification', updatedOrder, {
            username: auditUsername,
            refundTime: expiredAt,
            providerStatus: finalVerification.decision.providerStatus || expireCancelResult.raw || null,
            reason: walletRefundAmount > 0
                ? 'order_expired'
                : blockedReason,
            refunded: walletRefundAmount > 0,
            otpExisted: finalVerification.decision.otpExists,
            providerSuccess: finalVerification.decision.providerSuccess
        });
        return {
            found: true,
            expired: true,
            refunded: walletRefundAmount > 0,
            order: updatedOrder,
            message: walletRefundAmount > 0
                ? EXPIRED_REFUND_MESSAGE
                : 'Order expired, but refund is blocked until provider status verification completes.'
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function reconcileExpiredOrdersForUser(userId) {
    const rows = await queryAll(`
        SELECT id
        FROM orders
        WHERE user_id = $1
          AND COALESCE(status, order_status, 'pending') = 'pending'
          AND COALESCE(otp_received, FALSE) = FALSE
          AND COALESCE(sms_received, FALSE) = FALSE
          AND NULLIF(TRIM(COALESCE(otp_code, '')), '') IS NULL
          AND expires_at <= CURRENT_TIMESTAMP
        ORDER BY id DESC
    `, [userId]);
    for (const row of rows) {
        await expireOrderAndRefund(row.id);
    }
}

async function getAllOrders() {
    const rows = await queryAll(`
        SELECT
            o.*,
            COALESCE(u.email, o.user_email) AS user_email,
            COALESCE(u.balance, 0) AS client_balance_left,
            CASE
                WHEN (
                    COALESCE(o.otp_received, FALSE) = TRUE
                    OR COALESCE(o.sms_received, FALSE) = TRUE
                    OR NULLIF(TRIM(COALESCE(o.otp_code, '')), '') IS NOT NULL
                    OR COALESCE(o.status, o.order_status, 'pending') = 'completed'
                )
                    THEN ROUND((COALESCE(o.price, 0) - GREATEST(COALESCE(o.real_provider_cost, 0), 0))::numeric, 2)
                ELSE 0::numeric
            END AS profit_pkr
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        ORDER BY o.id DESC
    `);
    return rows.map(normalizeOrder);
}

function normalizeProviderBalanceSnapshotEntry(row) {
    if (!row) return null;
    return {
        ...row,
        order_id: row.order_id == null ? null : Number(row.order_id),
        user_id: row.user_id == null ? null : Number(row.user_id),
        provider_balance: row.provider_balance == null ? null : Number(row.provider_balance),
        previous_balance: row.previous_balance == null ? null : Number(row.previous_balance),
        delta: row.delta == null ? null : Number(row.delta),
        delta_pkr: Number(row.delta_pkr || 0),
        expected_spend_pkr: Number(row.expected_spend_pkr || 0),
        unmatched_delta_pkr: Number(row.unmatched_delta_pkr || 0),
        anomaly_flag: Boolean(row.anomaly_flag)
    };
}

function normalizeProviderSecurityEventEntry(row) {
    if (!row) return null;
    return {
        ...row,
        order_id: row.order_id == null ? null : Number(row.order_id),
        user_id: row.user_id == null ? null : Number(row.user_id),
        risk_flag: Boolean(row.risk_flag),
        loss_detected: Boolean(row.loss_detected),
        critical_exploit: Boolean(row.critical_exploit),
        provider_balance_before: row.provider_balance_before == null ? null : Number(row.provider_balance_before),
        provider_balance_after: row.provider_balance_after == null ? null : Number(row.provider_balance_after),
        real_provider_cost: Number(row.real_provider_cost || 0),
        website_charge: Number(row.website_charge || 0),
        website_refund: Number(row.website_refund || 0),
        real_profit_loss: Number(row.real_profit_loss || 0)
    };
}

function getAdminAnalyticsDateKey(value) {
    const date = value ? new Date(value) : null;
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function getAdminProviderAnalytics(options = {}) {
    const snapshotLimit = Math.max(5, Math.min(100, Number(options.snapshotLimit || 20)));
    const eventLimit = Math.max(5, Math.min(100, Number(options.eventLimit || 25)));
    const topRiskUserLimit = Math.max(5, Math.min(50, Number(options.topRiskUserLimit || 15)));
    const blockedUserLimit = Math.max(5, Math.min(50, Number(options.blockedUserLimit || 20)));
    const dailyEarningsLimit = Math.max(7, Math.min(60, Number(options.dailyEarningsLimit || 14)));
    const financialStatsResetAt = getFinancialStatsResetAt();
    const [orders, userRows, latestSnapshotRow, recentSnapshotRows, providerBalanceSummaryRow, depositSummaryRow, anomalyEventRows] = await Promise.all([
        getAllOrders(),
        queryAll(`
            SELECT
                id,
                name,
                email,
                balance,
                security_blocked_until,
                security_block_reason,
                security_blocked_at,
                security_risk_reset_at,
                security_last_flagged_at
            FROM users
            ORDER BY id DESC
        `),
        queryOne(`
            SELECT *
            FROM provider_balance_snapshots
            ORDER BY created_at DESC, id DESC
            LIMIT 1
        `),
        queryAll(`
            SELECT *
            FROM provider_balance_snapshots
            ORDER BY created_at DESC, id DESC
            LIMIT $1
        `, [snapshotLimit]),
        queryOne(`
            SELECT
                COALESCE(SUM(GREATEST(delta_pkr, 0)) FILTER (
                    WHERE created_at >= $1
                      AND reason NOT IN ('startup_reconciliation', 'scheduled_reconciliation')
                ), 0)::numeric AS total_api_cost,
                COALESCE(SUM(delta_pkr) FILTER (
                    WHERE created_at >= $1
                      AND reason NOT IN ('startup_reconciliation', 'scheduled_reconciliation')
                ), 0)::numeric AS total_provider_balance_change,
                COALESCE(SUM(GREATEST(delta_pkr, 0)) FILTER (
                    WHERE created_at >= CURRENT_DATE
                      AND created_at < CURRENT_DATE + INTERVAL '1 day'
                      AND reason NOT IN ('startup_reconciliation', 'scheduled_reconciliation')
                ), 0)::numeric AS today_api_cost,
                COALESCE(SUM(delta_pkr) FILTER (
                    WHERE created_at >= CURRENT_DATE
                      AND created_at < CURRENT_DATE + INTERVAL '1 day'
                      AND reason NOT IN ('startup_reconciliation', 'scheduled_reconciliation')
                ), 0)::numeric AS today_provider_balance_change,
                COALESCE(SUM(expected_spend_pkr) FILTER (
                    WHERE created_at >= CURRENT_DATE
                      AND created_at < CURRENT_DATE + INTERVAL '1 day'
                      AND reason NOT IN ('startup_reconciliation', 'scheduled_reconciliation')
                ), 0)::numeric AS today_expected_provider_spend,
                COALESCE(SUM(unmatched_delta_pkr) FILTER (
                    WHERE created_at >= CURRENT_DATE
                      AND created_at < CURRENT_DATE + INTERVAL '1 day'
                      AND reason NOT IN ('startup_reconciliation', 'scheduled_reconciliation')
                ), 0)::numeric AS today_unmatched_provider_delta,
                COUNT(*) FILTER (
                    WHERE created_at >= CURRENT_DATE
                      AND created_at < CURRENT_DATE + INTERVAL '1 day'
                      AND anomaly_flag = TRUE
                )::int AS today_anomaly_count
            FROM provider_balance_snapshots
        `, [financialStatsResetAt]),
        queryOne(`
            SELECT
                COALESCE(SUM(amount) FILTER (
                    WHERE LOWER(COALESCE(type, '')) = 'deposit'
                      AND LOWER(COALESCE(status, '')) = 'approved'
                      AND created_at >= $1
                ), 0)::numeric AS total_deposits,
                COALESCE(SUM(amount) FILTER (
                    WHERE LOWER(COALESCE(type, '')) = 'deposit'
                      AND LOWER(COALESCE(status, '')) = 'approved'
                      AND created_at >= CURRENT_DATE
                      AND created_at < CURRENT_DATE + INTERVAL '1 day'
                ), 0)::numeric AS today_deposits
            FROM transactions
        `, [financialStatsResetAt]),
        queryAll(`
            SELECT *
            FROM provider_security_events
            WHERE event_type = 'provider_reconciliation_anomaly'
            ORDER BY created_at DESC, id DESC
            LIMIT $1
        `, [eventLimit])
    ]);

    const users = userRows.map(normalizeUser);
    const normalizedLatestSnapshot = normalizeProviderBalanceSnapshotEntry(latestSnapshotRow);
    const recentBalanceSnapshots = recentSnapshotRows.map(normalizeProviderBalanceSnapshotEntry);
    const providerBalanceSummary = {
        totalApiCost: Number(providerBalanceSummaryRow?.total_api_cost || 0),
        totalProviderBalanceChange: Number(providerBalanceSummaryRow?.total_provider_balance_change || 0),
        todayApiCost: Number(providerBalanceSummaryRow?.today_api_cost || 0),
        todayProviderBalanceChange: Number(providerBalanceSummaryRow?.today_provider_balance_change || 0),
        todayExpectedProviderSpend: Number(providerBalanceSummaryRow?.today_expected_provider_spend || 0),
        todayUnmatchedProviderDelta: Number(providerBalanceSummaryRow?.today_unmatched_provider_delta || 0),
        todayAnomalyCount: Number(providerBalanceSummaryRow?.today_anomaly_count || 0)
    };
    const todayKey = getAdminAnalyticsDateKey(new Date());
    const financialResetDate = FINANCIAL_STATS_RESET_DATE;
    const userLookup = new Map(users.map((user) => [String(user.id), user]));
    const ordersByUser = new Map();
    const serviceBreakdownMap = new Map();
    const dailyEarningsMap = new Map();
    const riskEvents = [];
    let totalOrders = 0;
    let providerUsedOrders = 0;
    let riskOrders = 0;
    let lossOrders = 0;
    let criticalOrders = 0;
    let refundedOrders = 0;
    let totalWebsiteCharge = 0;
    let totalWebsiteRefund = 0;
    let totalWebsiteProfit = 0;
    let totalRealProviderCost = 0;
    let totalRevenue = 0;
    let financiallyCompletedOrders = 0;

    const ensureDailyEntry = (dateKey) => {
        if (!dateKey) return null;
        if (!dailyEarningsMap.has(dateKey)) {
            dailyEarningsMap.set(dateKey, {
                date: dateKey,
                revenue: 0,
                apiCost: 0,
                profitLoss: 0,
                completedOrders: 0
            });
        }
        return dailyEarningsMap.get(dateKey);
    };

    for (const rawOrder of orders) {
        const order = buildDerivedOrderMetrics(rawOrder);
        const websiteCharge = getWebsiteChargeAmount(order);
        const websiteRefund = getWebsiteRefundAmount(order);
        const websiteProfit = roundMoney(websiteCharge - websiteRefund);
        const realProviderCost = getRealProviderCostAmount(order);
        const realProfitLoss = getRealProfitLossAmount(order);
        const withinFinancialResetWindow = isOrderAfterFinancialStatsReset(order);
        const financiallySuccessfulOrder = isFinanciallySuccessfulOrder(order);
        const financialTimestamp = getOrderFinancialTimelineTimestamp(order);
        const financialRevenue = getFinancialRevenueAmount(order);
        const financialApiCost = getFinancialApiCostAmount(order);
        const financialProfit = getFinancialProfitAmount(order);
        const serviceKey = String(order?.provider_service || order?.service_type || 'unknown').trim() || 'unknown';
        const userIdKey = order?.user_id == null ? null : String(order.user_id);
        if (withinFinancialResetWindow) {
            totalOrders += 1;
            if (financiallySuccessfulOrder) {
                providerUsedOrders += 1;
                financiallyCompletedOrders += 1;
                totalWebsiteCharge += financialRevenue;
                totalWebsiteProfit += financialProfit;
                totalRealProviderCost += financialApiCost;
                totalRevenue += financialRevenue;
                const dailyEntry = ensureDailyEntry(getAdminAnalyticsDateKey(financialTimestamp));
                if (dailyEntry) {
                    dailyEntry.revenue += financialRevenue;
                    dailyEntry.apiCost += financialApiCost;
                    dailyEntry.completedOrders += 1;
                }
                if (!serviceBreakdownMap.has(serviceKey)) {
                    serviceBreakdownMap.set(serviceKey, {
                        provider_service: serviceKey,
                        total_orders: 0,
                        risk_orders: 0,
                        total_real_provider_cost: 0,
                        total_real_profit_loss: 0
                    });
                }
                const serviceEntry = serviceBreakdownMap.get(serviceKey);
                serviceEntry.total_orders += 1;
                serviceEntry.total_real_provider_cost += financialApiCost;
                serviceEntry.total_real_profit_loss += financialProfit;
            }
        }
        if (order?.riskState?.riskFlag) {
            riskOrders += 1;
        }
        if (order?.riskState?.lossDetected) {
            lossOrders += 1;
        }
        if (order?.riskState?.criticalExploit) {
            criticalOrders += 1;
        }
        if (websiteRefund > 0) {
            refundedOrders += 1;
        }

        if (userIdKey) {
            if (!ordersByUser.has(userIdKey)) {
                ordersByUser.set(userIdKey, []);
            }
            ordersByUser.get(userIdKey).push(order);
        }

        if (order?.riskState?.lossDetected) {
            riskEvents.push(normalizeProviderSecurityEventEntry({
                order_id: order.id,
                user_id: order.user_id,
                username: getOrderUsernameSnapshot(order) || userLookup.get(String(order.user_id || ''))?.name || null,
                service_type: order.service_type || order.provider_service || null,
                country: order.country || order.provider_country || null,
                phone_number: order.phone_number || order.provider_phone_number || null,
                activation_id: order.activation_id || null,
                event_type: 'confirmed_provider_loss',
                reason: order.riskState.exploitReason || null,
                risk_flag: true,
                loss_detected: true,
                critical_exploit: Boolean(order.riskState.criticalExploit),
                provider_status: order.provider_status || order.provider_last_status || null,
                provider_final_status: order.provider_final_status || null,
                provider_balance_before: order.provider_balance_before ?? null,
                provider_balance_after: order.provider_balance_after ?? null,
                real_provider_cost: realProviderCost,
                website_charge: websiteCharge,
                website_refund: websiteRefund,
                real_profit_loss: realProfitLoss,
                created_at: getOrderRiskEventTimestamp(order)
            }));
        }
    }

    const dailyEarnings = Array.from(dailyEarningsMap.values())
        .map((entry) => ({
            ...entry,
            revenue: roundMoney(entry.revenue),
            apiCost: roundMoney(entry.apiCost),
            profitLoss: roundMoney(entry.revenue - entry.apiCost)
        }))
        .sort((left, right) => String(right.date).localeCompare(String(left.date)))
        .slice(0, dailyEarningsLimit);

    const todayEntry = dailyEarnings.find((entry) => entry.date === todayKey) || {
        date: todayKey,
        revenue: 0,
        apiCost: 0,
        profitLoss: 0,
        completedOrders: 0
    };

    const enrichedUsers = users.map((user) => {
        const derivedMetrics = deriveUserSecurityMetricsFromOrders(user, ordersByUser.get(String(user.id)) || []);
        const activeBlock = user.security_blocked_until ? new Date(user.security_blocked_until) > new Date() : false;
        return {
            ...user,
            total_provider_loss: Number(derivedMetrics.totalProviderLoss || 0),
            confirmed_provider_loss_count: Number(derivedMetrics.refundAbuseCount || 0),
            security_risk_score: activeBlock ? Math.max(80, derivedMetrics.riskScore) : derivedMetrics.riskScore,
            security_risk_status: activeBlock ? 'dangerous' : derivedMetrics.riskStatus,
            latest_provider_loss_amount: Number(getConfirmedProviderLossAmount(derivedMetrics.latestLossOrder || {}) || 0),
            latest_security_reason: derivedMetrics.latestLossOrder?.riskState?.exploitReason || null,
            latest_security_event_at: derivedMetrics.latestLossOrder ? getOrderRiskEventTimestamp(derivedMetrics.latestLossOrder) : null,
            latest_security_order_id: derivedMetrics.latestLossOrder?.id ?? null,
            latest_security_service: derivedMetrics.latestLossOrder?.service_type || derivedMetrics.latestLossOrder?.provider_service || null,
            latest_security_number: derivedMetrics.latestLossOrder?.phone_number || derivedMetrics.latestLossOrder?.provider_phone_number || null
        };
    });

    const totalUserBalances = enrichedUsers.reduce((sum, user) => sum + Number(user.balance || 0), 0);
    const riskyUsers = enrichedUsers.filter((user) => String(user.security_risk_status || 'safe').toLowerCase() !== 'safe').length;
    const blockedUsers = enrichedUsers.filter((user) => user.security_blocked_until && new Date(user.security_blocked_until) > new Date()).length;
    const maxRiskScore = enrichedUsers.reduce((max, user) => Math.max(max, Number(user.security_risk_score || 0)), 0);

    const financeSummary = {
        totalDeposits: Number(depositSummaryRow?.total_deposits || 0),
        todayDeposits: Number(depositSummaryRow?.today_deposits || 0),
        totalRevenue: roundMoney(totalRevenue),
        todayRevenue: roundMoney(todayEntry.revenue || 0),
        totalIncome: roundMoney(totalRevenue),
        todayIncome: roundMoney(todayEntry.revenue || 0),
        totalApiCost: roundMoney(totalRealProviderCost),
        todayApiCost: roundMoney(todayEntry.apiCost || 0),
        totalProfit: roundMoney(totalRevenue - totalRealProviderCost),
        todayProfit: roundMoney((todayEntry.revenue || 0) - (todayEntry.apiCost || 0)),
        todayCompletedOrders: Number(todayEntry.completedOrders || 0),
        todayProviderBalanceChange: roundMoney(providerBalanceSummary.todayProviderBalanceChange || 0),
        totalProviderBalanceChange: roundMoney(providerBalanceSummary.totalProviderBalanceChange || 0),
        financialResetDate
    };

    const summary = {
        totalOrders,
        providerUsedOrders,
        riskOrders,
        lossOrders,
        criticalOrders,
        refundedOrders,
        totalWebsiteCharge: roundMoney(totalWebsiteCharge),
        totalWebsiteRefund: roundMoney(totalWebsiteRefund),
        totalWebsiteProfit: roundMoney(totalWebsiteProfit),
        totalRealProviderCost: financeSummary.totalApiCost,
        totalRealProfitLoss: financeSummary.totalProfit,
        riskyUsers,
        blockedUsers,
        maxRiskScore,
        totalUserBalances: roundMoney(totalUserBalances),
        todayApiCost: financeSummary.todayApiCost,
        todayProviderDeductions: financeSummary.todayApiCost,
        todayRealProfitLoss: financeSummary.todayProfit,
        todayExpectedProviderSpend: Number(providerBalanceSummary.todayExpectedProviderSpend || 0),
        todayUnmatchedProviderDelta: Number(providerBalanceSummary.todayUnmatchedProviderDelta || 0),
        todayAnomalyCount: Number(providerBalanceSummary.todayAnomalyCount || 0),
        todayLossWarning: Number(providerBalanceSummary.todayApiCost || 0) > (Number(providerBalanceSummary.todayExpectedProviderSpend || 0) + Math.max(50, Math.abs(Number(providerBalanceSummary.todayExpectedProviderSpend || 0)) * 0.25)),
        latestProviderBalance: normalizedLatestSnapshot?.provider_balance ?? null,
        latestProviderBalanceCurrency: normalizedLatestSnapshot?.provider_balance == null ? PROVIDER_BALANCE_CURRENCY : (normalizedLatestSnapshot?.provider_balance_currency || PROVIDER_BALANCE_CURRENCY),
        latestReconciliationAt: normalizedLatestSnapshot?.created_at || null,
        latestReconciliationReason: normalizedLatestSnapshot?.reason || null,
        latestUnmatchedDeltaPkr: normalizedLatestSnapshot?.unmatched_delta_pkr || 0,
        latestAnomalyFlag: Boolean(normalizedLatestSnapshot?.anomaly_flag),
        todayRevenue: financeSummary.todayRevenue,
        todayProfit: financeSummary.todayProfit,
        todayCompletedOrders: financeSummary.todayCompletedOrders,
        todayProviderBalanceChange: financeSummary.todayProviderBalanceChange,
        financiallyCompletedOrders,
        financialResetDate,
        totalRevenue: financeSummary.totalRevenue,
        totalProfit: financeSummary.totalProfit
    };

    const serviceBreakdown = Array.from(serviceBreakdownMap.values())
        .map((entry) => ({
            ...entry,
            total_real_provider_cost: roundMoney(entry.total_real_provider_cost),
            total_real_profit_loss: roundMoney(entry.total_real_profit_loss)
        }))
        .sort((left, right) => (right.total_real_provider_cost - left.total_real_provider_cost) || (right.total_orders - left.total_orders))
        .slice(0, 10);

    const recentSecurityEvents = [...riskEvents, ...anomalyEventRows.map(normalizeProviderSecurityEventEntry)]
        .sort((left, right) => new Date(right.created_at || 0) - new Date(left.created_at || 0))
        .slice(0, eventLimit);

    const topRiskUsers = [...enrichedUsers]
        .filter((user) => String(user.security_risk_status || 'safe').toLowerCase() !== 'safe' || (user.security_blocked_until && new Date(user.security_blocked_until) > new Date()))
        .sort((left, right) => {
            const scoreDiff = Number(right.security_risk_score || 0) - Number(left.security_risk_score || 0);
            if (scoreDiff !== 0) return scoreDiff;
            return Number(right.total_provider_loss || 0) - Number(left.total_provider_loss || 0);
        })
        .slice(0, topRiskUserLimit);

    const blockedUsersList = [...enrichedUsers]
        .filter((user) => user.security_blocked_until && new Date(user.security_blocked_until) > new Date())
        .sort((left, right) => new Date(right.security_blocked_until || 0) - new Date(left.security_blocked_until || 0))
        .slice(0, blockedUserLimit);

    return {
        summary,
        financeSummary,
        dailyEarnings,
        serviceBreakdown,
        recentBalanceSnapshots,
        recentSecurityEvents,
        topRiskUsers,
        blockedUsers: blockedUsersList
    };
}

let providerReconciliationTimer = null;
let providerReconciliationRunning = false;

async function runProviderBalanceReconciliation(reason = 'scheduled_reconciliation') {
    if (providerReconciliationRunning) {
        return { success: false, skipped: true, reason: 'already_running' };
    }
    providerReconciliationRunning = true;
    try {
        const providerBalance = await getProviderBalance();
        if (!providerBalance.success) {
            logProviderAudit('reconciliation_failed', {
                reason,
                error: providerBalance.error || 'Provider balance unavailable'
            });
            return { success: false, error: providerBalance.error || 'Provider balance unavailable' };
        }

        const latestSnapshot = await getLatestProviderBalanceSnapshot();
        const lastReconciliationSnapshot = await getLastProviderReconciliationSnapshot();
        const expectedDeltaRow = lastReconciliationSnapshot?.created_at
            ? await queryOne(`
                SELECT COALESCE(SUM(delta_pkr), 0)::numeric AS expected_delta_pkr
                FROM provider_balance_snapshots
                WHERE created_at > $1
                  AND reason NOT IN ('startup_reconciliation', 'scheduled_reconciliation')
            `, [lastReconciliationSnapshot.created_at])
            : { expected_delta_pkr: 0 };
        const previousBalance = latestSnapshot?.provider_balance == null ? null : Number(latestSnapshot.provider_balance);
        const actualDelta = previousBalance == null
            ? null
            : roundMoney(previousBalance - providerBalance.balance, 6);
        const actualDeltaPkr = actualDelta == null ? 0 : usdToPkr(actualDelta);
        const expectedDeltaPkr = Number(expectedDeltaRow?.expected_delta_pkr || 0);
        const unmatchedDeltaPkr = roundMoney(actualDeltaPkr - expectedDeltaPkr, 2);
        const anomalyFlag = actualDelta != null && Math.abs(unmatchedDeltaPkr) > Math.max(50, Math.abs(actualDeltaPkr) * 0.35);
        const snapshot = await insertProviderBalanceSnapshot({
            reason,
            providerBalance: providerBalance.balance,
            previousBalance,
            expectedSpendPkr: expectedDeltaPkr,
            unmatchedDeltaPkr,
            anomalyFlag,
            note: anomalyFlag
                ? `Provider reconciliation mismatch detected (${unmatchedDeltaPkr} PKR).`
                : 'Provider balance reconciliation completed.'
        });
        if (anomalyFlag) {
            await insertProviderSecurityEvent(null, {
                eventType: 'provider_reconciliation_anomaly',
                reason: 'provider_balance_reconciliation_mismatch',
                riskFlag: true,
                lossDetected: false,
                criticalExploit: false,
                providerStatus: null,
                providerFinalStatus: null
            });
        }
        return {
            success: true,
            snapshot: normalizeProviderBalanceSnapshotEntry(snapshot),
            unmatchedDeltaPkr,
            anomalyFlag
        };
    } catch (err) {
        logProviderAudit('reconciliation_failed', {
            reason,
            error: formatSafeError(err, 'Provider reconciliation failed')
        });
        return { success: false, error: formatSafeError(err, 'Provider reconciliation failed') };
    } finally {
        providerReconciliationRunning = false;
    }
}

function startProviderReconciliationLoop() {
    if (providerReconciliationTimer) {
        clearInterval(providerReconciliationTimer);
        providerReconciliationTimer = null;
    }
    void runProviderBalanceReconciliation('startup_reconciliation');
    providerReconciliationTimer = setInterval(() => {
        void runProviderBalanceReconciliation('scheduled_reconciliation');
    }, PROVIDER_RECONCILIATION_INTERVAL_MS);
}

async function updateUserLoginAttempts(userId, attempts) {
    return queryRun('UPDATE users SET login_attempts = $1 WHERE id = $2', [attempts, userId]);
}

async function updateUserLastLogin(userId) {
    return queryRun('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [userId]);
}

const whatsappCountries = [
    { name: 'South Africa', code: '+27', price: 44, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Indonesia', code: '+62', price: 90, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Canada', code: '+1', price: 130, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Vietnam', code: '+84', price: 100, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Philippines', code: '+63', price: 140, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Colombia', code: '+57', price: 114, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Saudi Arabia', code: '+966', price: 240, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Thailand', code: '+66', price: 188, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Brazil', code: '+55', price: 289, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'United Kingdom', code: '+44', price: 330, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'India', code: '+91', price: 530, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'USA', code: '+1', price: 470, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Chile', code: '+56', price: 170.07, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Syria', code: '+963', price: 43.32, countryId: 1333, flag: '\u{1F1F8}\u{1F1FE}' },
    { name: 'Somalia', code: '+252', price: 65.16, countryId: 149, flag: '\u{1F1F8}\u{1F1F4}' },
    { name: 'Kyrgyzstan', code: '+996', price: 72.8, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' },
    { name: 'Iraq', code: '+964', price: 72.8, countryId: 47, flag: '\u{1F1EE}\u{1F1F6}' },
    { name: 'Mongolia', code: '+976', price: 72.8, countryId: 72, flag: '\u{1F1F2}\u{1F1F3}' },
    { name: 'Myanmar', code: '+95', price: 72.8, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'Cameroon', code: '+237', price: 92.46, countryId: 41, flag: '\u{1F1E8}\u{1F1F2}' },
    { name: 'Madagascar', code: '+261', price: 94.64, countryId: 17, flag: '\u{1F1F2}\u{1F1EC}' },
    { name: 'Tanzania', code: '+255', price: 97.19, countryId: 9, flag: '\u{1F1F9}\u{1F1FF}' },
    { name: 'Suriname', code: '+597', price: 97.19, countryId: 142, flag: '\u{1F1F8}\u{1F1F7}' },
    { name: 'Uzbekistan', code: '+998', price: 97.19, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    { name: 'Tajikistan', code: '+992', price: 99.01, countryId: 143, flag: '\u{1F1F9}\u{1F1EF}' },
    { name: 'Zimbabwe', code: '+263', price: 101.92, countryId: 96, flag: '\u{1F1FF}\u{1F1FC}' },
    { name: 'Ethiopia', code: '+251', price: 101.92, countryId: 71, flag: '\u{1F1EA}\u{1F1F9}' },
    { name: 'Tunisia', code: '+216', price: 101.92, countryId: 89, flag: '\u{1F1F9}\u{1F1F3}' },
    { name: 'Mauritius', code: '+230', price: 101.92, countryId: 157, flag: '\u{1F1F2}\u{1F1FA}' },
    { name: 'Morocco', code: '+212', price: 102.65, countryId: 37, flag: '\u{1F1F2}\u{1F1E6}' },
    { name: 'Yemen', code: '+967', price: 104.1, countryId: 30, flag: '\u{1F1FE}\u{1F1EA}' },
    { name: 'Cambodia', code: '+855', price: 107.02, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' },
    { name: 'Peru', code: '+51', price: 122.67, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Hong Kong', code: '+852', price: 122.67, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Argentina', code: '+54', price: 122.67, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'New Zealand', code: '+64', price: 122.67, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Sierra Leone', code: '+232', price: 123.03, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' },
    { name: 'Bangladesh', code: '+880', price: 131.4, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'Bolivia', code: '+591', price: 131.4, countryId: 92, flag: '\u{1F1E7}\u{1F1F4}' },
    { name: 'Senegal', code: '+221', price: 131.4, countryId: 61, flag: '\u{1F1F8}\u{1F1F3}' },
    { name: 'Egypt', code: '+20', price: 131.4, countryId: 21, flag: '\u{1F1EA}\u{1F1EC}' },
    { name: 'Moldova', code: '+373', price: 131.4, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Ireland', code: '+353', price: 145.6, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Kenya', code: '+254', price: 146.33, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Ukraine', code: '+380', price: 151.06, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Greece', code: '+30', price: 161.98, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Latvia', code: '+371', price: 186, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Seychelles', code: '+248', price: 186.37, countryId: 184, flag: '\u{1F1F8}\u{1F1E8}' },
    { name: 'France', code: '+33', price: 194.38, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Uganda', code: '+256', price: 194.38, countryId: 75, flag: '\u{1F1FA}\u{1F1EC}' },
    { name: 'Kazakhstan', code: '+7', price: 194.38, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Belgium', code: '+32', price: 194.38, countryId: 82, flag: '\u{1F1E7}\u{1F1EA}' },
    { name: 'Burundi', code: '+257', price: 194.38, countryId: 119, flag: '\u{1F1E7}\u{1F1EE}' },
    { name: 'Zambia', code: '+260', price: 212.58, countryId: 147, flag: '\u{1F1FF}\u{1F1F2}' },
    { name: 'Ghana', code: '+233', price: 212.58, countryId: 38, flag: '\u{1F1EC}\u{1F1ED}' },
    { name: 'Nepal', code: '+977', price: 212.58, countryId: 81, flag: '\u{1F1F3}\u{1F1F5}' },
    { name: 'Armenia', code: '+374', price: 212.58, countryId: 148, flag: '\u{1F1E6}\u{1F1F2}' },
    { name: 'Algeria', code: '+213', price: 212.58, countryId: 58, flag: '\u{1F1E9}\u{1F1FF}' },
    { name: 'Guinea', code: '+224', price: 212.58, countryId: 68, flag: '\u{1F1EC}\u{1F1F3}' },
    { name: 'Botswana', code: '+267', price: 212.58, countryId: 123, flag: '\u{1F1E7}\u{1F1FC}' },
    { name: 'Namibia', code: '+264', price: 212.58, countryId: 138, flag: '\u{1F1F3}\u{1F1E6}' },
    { name: 'Macedonia', code: '+389', price: 212.58, countryId: 183, flag: '\u{1F1F2}\u{1F1F0}' },
    { name: 'CAF', code: '+236', price: 212.58, countryId: 125, flag: '\u{1F1E8}\u{1F1EB}' },
    { name: 'Ecuador', code: '+593', price: 212.58, countryId: 105, flag: '\u{1F1EA}\u{1F1E8}' },
    { name: 'Nicaragua', code: '+505', price: 212.58, countryId: 90, flag: '\u{1F1F3}\u{1F1EE}' },
    { name: 'El Salvador', code: '+503', price: 212.58, countryId: 101, flag: '\u{1F1F8}\u{1F1FB}' },
    { name: 'Cuba', code: '+53', price: 212.58, countryId: 113, flag: '\u{1F1E8}\u{1F1FA}' },
    { name: 'Angola', code: '+244', price: 212.58, countryId: 76, flag: '\u{1F1E6}\u{1F1F4}' },
    { name: 'Belize', code: '+501', price: 212.58, countryId: 124, flag: '\u{1F1E7}\u{1F1FF}' },
    { name: 'Sri Lanka', code: '+94', price: 212.58, countryId: 64, flag: '\u{1F1F1}\u{1F1F0}' },
    { name: 'Fiji', code: '+679', price: 212.58, countryId: 189, flag: '\u{1F1EB}\u{1F1EF}' },
    { name: 'Mozambique', code: '+258', price: 212.58, countryId: 80, flag: '\u{1F1F2}\u{1F1FF}' },
    { name: 'South Sudan', code: '+211', price: 212.58, countryId: 177, flag: '\u{1F1F8}\u{1F1F8}' },
    { name: 'Guatemala', code: '+502', price: 212.58, countryId: 94, flag: '\u{1F1EC}\u{1F1F9}' },
    { name: 'Togo', code: '+228', price: 212.58, countryId: 99, flag: '\u{1F1F9}\u{1F1EC}' },
    { name: 'Gambia', code: '+220', price: 212.58, countryId: 28, flag: '\u{1F1EC}\u{1F1F2}' },
    { name: 'Gabon', code: '+241', price: 212.58, countryId: 154, flag: '\u{1F1EC}\u{1F1E6}' },
    { name: 'Guinea-Bissau', code: '+245', price: 212.58, countryId: 130, flag: '\u{1F1EC}\u{1F1FC}' },
    { name: 'Cape Verde', code: '+238', price: 212.58, countryId: 186, flag: '\u{1F1E8}\u{1F1FB}' },
    { name: 'Sudan', code: '+249', price: 212.58, countryId: 1010, flag: '\u{1F1F8}\u{1F1E9}' },
    { name: 'Haiti', code: '+509', price: 212.58, countryId: 26, flag: '\u{1F1ED}\u{1F1F9}' },
    { name: 'Panama', code: '+507', price: 212.58, countryId: 112, flag: '\u{1F1F5}\u{1F1E6}' },
    { name: 'Bosnia and Herzegovina', code: '+387', price: 212.58, countryId: 108, flag: '\u{1F1E7}\u{1F1E6}' },
    { name: 'Barbados', code: '+1', price: 212.58, countryId: 118, flag: '\u{1F1E7}\u{1F1E7}' },
    { name: 'Mauritania', code: '+222', price: 212.58, countryId: 114, flag: '\u{1F1F2}\u{1F1F7}' },
    { name: 'Niger', code: '+227', price: 212.58, countryId: 139, flag: '\u{1F1F3}\u{1F1EA}' },
    { name: 'Lesotho', code: '+266', price: 212.58, countryId: 136, flag: '\u{1F1F1}\u{1F1F8}' },
    { name: 'Guadeloupe', code: '+590', price: 212.58, countryId: 160, flag: '\u{1F1EC}\u{1F1F5}' },
    { name: 'Malawi', code: '+265', price: 212.58, countryId: 137, flag: '\u{1F1F2}\u{1F1FC}' },
    { name: 'Lebanon', code: '+961', price: 212.58, countryId: 153, flag: '\u{1F1F1}\u{1F1E7}' },
    { name: 'Chad', code: '+235', price: 212.58, countryId: 42, flag: '\u{1F1F9}\u{1F1E9}' },
    { name: 'Congo (Dem. Republic)', code: '+243', price: 212.58, countryId: 18, flag: '\u{1F1E8}\u{1F1E9}' },
    { name: 'Bahamas', code: '+1', price: 212.58, countryId: 122, flag: '\u{1F1E7}\u{1F1F8}' },
    { name: 'Maldives', code: '+960', price: 212.58, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Paraguay', code: '+595', price: 212.58, countryId: 87, flag: '\u{1F1F5}\u{1F1FE}' },
    { name: 'Rwanda', code: '+250', price: 212.58, countryId: 140, flag: '\u{1F1F7}\u{1F1FC}' },
    { name: 'Benin', code: '+229', price: 212.58, countryId: 120, flag: '\u{1F1E7}\u{1F1EF}' },
    { name: 'Reunion', code: '+262', price: 212.58, countryId: 146, flag: '\u{1F1F7}\u{1F1EA}' },
    { name: 'Equatorial Guinea', code: '+240', price: 212.58, countryId: 167, flag: '\u{1F1EC}\u{1F1F6}' },
    { name: 'Luxembourg', code: '+352', price: 212.58, countryId: 165, flag: '\u{1F1F1}\u{1F1FA}' },
    { name: 'Djibouti', code: '+253', price: 212.58, countryId: 168, flag: '\u{1F1E9}\u{1F1EF}' },
    { name: 'French Guiana', code: '+594', price: 212.58, countryId: 162, flag: '\u{1F1EC}\u{1F1EB}' },
    { name: 'Saint Lucia', code: '+1', price: 212.58, countryId: 164, flag: '\u{1F1F1}\u{1F1E8}' },
    { name: 'Brunei Darussalam', code: '+673', price: 212.58, countryId: 121, flag: '\u{1F1E7}\u{1F1F3}' },
    { name: 'Aruba', code: '+297', price: 212.58, countryId: 179, flag: '\u{1F1E6}\u{1F1FC}' },
    { name: 'Sao Tome and Principe', code: '+239', price: 212.58, countryId: 178, flag: '\u{1F1F8}\u{1F1F9}' },
    { name: 'New Caledonia', code: '+687', price: 212.58, countryId: 185, flag: '\u{1F1F3}\u{1F1E8}' },
    { name: 'Macau', code: '+853', price: 222.04, countryId: 20, flag: '\u{1F1F2}\u{1F1F4}' },
    { name: 'Switzerland', code: '+41', price: 228.23, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Romania', code: '+40', price: 230.05, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Portugal', code: '+351', price: 230.78, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Mexico', code: '+52', price: 230.78, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Poland', code: '+48', price: 230.78, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Czech Republic', code: '+420', price: 230.78, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Denmark', code: '+45', price: 230.78, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Venezuela', code: '+58', price: 230.78, countryId: 70, flag: '\u{1F1FB}\u{1F1EA}' },
    { name: 'Estonia', code: '+372', price: 230.78, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Georgia', code: '+995', price: 230.78, countryId: 128, flag: '\u{1F1EC}\u{1F1EA}' },
    { name: 'Nigeria', code: '+234', price: 230.78, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Laos', code: '+856', price: 230.78, countryId: 25, flag: '\u{1F1F1}\u{1F1E6}' },
    { name: 'Hungary', code: '+36', price: 230.78, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'Bulgaria', code: '+359', price: 230.78, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Azerbaijan', code: '+994', price: 230.78, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Taiwan', code: '+886', price: 230.78, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
    { name: 'Honduras', code: '+504', price: 230.78, countryId: 88, flag: '\u{1F1ED}\u{1F1F3}' },
    { name: 'Croatia', code: '+385', price: 230.78, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'Liberia', code: '+231', price: 230.78, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Lithuania', code: '+370', price: 230.78, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'Monaco', code: '+377', price: 230.78, countryId: 144, flag: '\u{1F1F2}\u{1F1E8}' },
    { name: 'Mali', code: '+223', price: 230.78, countryId: 69, flag: '\u{1F1F2}\u{1F1F1}' },
    { name: 'Finland', code: '+358', price: 230.78, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'Comoros', code: '+269', price: 303.94, countryId: 133, flag: '\u{1F1F0}\u{1F1F2}' },
    { name: 'Timor-Leste', code: '+670', price: 303.94, countryId: 91, flag: '\u{1F1F9}\u{1F1F1}' },
    { name: 'Eritrea', code: '+291', price: 380.02, countryId: 176, flag: '\u{1F1EA}\u{1F1F7}' },
    { name: 'Slovakia', code: '+421', price: 381.11, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'Germany', code: '+49', price: 455, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Italy', code: '+39', price: 461.19, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Puerto Rico', code: '+1', price: 485.58, countryId: 97, flag: '\u{1F1F5}\u{1F1F7}' },
    { name: 'Iran', code: '+98', price: 494.31, countryId: 57, flag: '\u{1F1EE}\u{1F1F7}' },
    { name: 'Sweden', code: '+46', price: 540.9, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Ivory Coast', code: '+225', price: 667.21, countryId: 27, flag: '\u{1F1E8}\u{1F1EE}' },
    { name: 'Uruguay', code: '+598', price: 670.85, countryId: 156, flag: '\u{1F1FA}\u{1F1FE}' },
    { name: 'Australia', code: '+61', price: 768.77, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'Spain', code: '+34', price: 980.25, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Turkey', code: '+90', price: 1073.07, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Cyprus', code: '+357', price: 1073.07, countryId: 77, flag: '\u{1F1E8}\u{1F1FE}' },
    { name: 'Austria', code: '+43', price: 1162.98, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Japan', code: '+81', price: 1964.14, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'Gibraltar', code: '+350', price: 7729.54, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' },
    { name: 'Singapore', code: '+65', price: 8581.3, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' }
];

const facebookCountries = [
    { name: 'Canada', code: '+1', price: 40, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'United Kingdom', code: '+44', price: 40, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'USA', code: '+1', price: 75, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Pakistan', code: '+92', price: 24, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Philippines', code: '+63', price: 29, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Ethiopia', code: '+251', price: 31, countryId: 71, flag: '\u{1F1EA}\u{1F1F9}' },
    { name: 'USA Virtual', code: '+1', price: 70, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Afghanistan', code: '+93', price: 31, countryId: 74, flag: '\u{1F1E6}\u{1F1EB}' },
    { name: 'Peru', code: '+51', price: 33, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Egypt', code: '+20', price: 30, countryId: 21, flag: '\u{1F1EA}\u{1F1EC}' },
    { name: 'Georgia', code: '+995', price: 34, countryId: 128, flag: '\u{1F1EC}\u{1F1EA}' },
    { name: 'Finland', code: '+358', price: 29, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'Papua New Guinea', code: '+675', price: 70, countryId: 79, flag: '\u{1F1F5}\u{1F1EC}' },
    { name: "Ivory Coast", code: '+225', price: 32, countryId: 27, flag: '\u{1F1E8}\u{1F1EE}' },
    { name: 'Chad', code: '+235', price: 31, countryId: 42, flag: '\u{1F1F9}\u{1F1E9}' },
    { name: 'Nepal', code: '+977', price: 33, countryId: 81, flag: '\u{1F1F3}\u{1F1F5}' },
    { name: 'Moldova', code: '+373', price: 30, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Croatia', code: '+385', price: 34, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'Nicaragua', code: '+505', price: 29, countryId: 90, flag: '\u{1F1F3}\u{1F1EE}' },
    { name: 'Cuba', code: '+53', price: 120, countryId: 113, flag: '\u{1F1E8}\u{1F1FA}' },
    { name: 'Mongolia', code: '+976', price: 32, countryId: 72, flag: '\u{1F1F2}\u{1F1F3}' },
    { name: 'Slovenia', code: '+386', price: 31, countryId: 59, flag: '\u{1F1F8}\u{1F1EE}' },
    { name: 'Benin', code: '+229', price: 33, countryId: 120, flag: '\u{1F1E7}\u{1F1EF}' },
    { name: 'Belarus', code: '+375', price: 100, countryId: 51, flag: '\u{1F1E7}\u{1F1FE}' },
    { name: 'Botswana', code: '+267', price: 100, countryId: 123, flag: '\u{1F1E7}\u{1F1FC}' },
    { name: 'DR Congo', code: '+243', price: 30, countryId: 18, flag: '\u{1F1E8}\u{1F1E9}' },
    { name: 'Madagascar', code: '+261', price: 34, countryId: 17, flag: '\u{1F1F2}\u{1F1EC}' },
    { name: 'Colombia', code: '+57', price: 19, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Algeria', code: '+213', price: 29, countryId: 58, flag: '\u{1F1E9}\u{1F1FF}' },
    { name: 'Austria', code: '+43', price: 32, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Panama', code: '+507', price: 31, countryId: 112, flag: '\u{1F1F5}\u{1F1E6}' },
    { name: 'Norway', code: '+47', price: 33, countryId: 174, flag: '\u{1F1F3}\u{1F1F4}' },
    { name: 'Ireland', code: '+353', price: 30, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Mauritius', code: '+230', price: 34, countryId: 157, flag: '\u{1F1F2}\u{1F1FA}' },
    { name: 'Switzerland', code: '+41', price: 29, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Costa Rica', code: '+506', price: 60, countryId: 93, flag: '\u{1F1E8}\u{1F1F7}' },
    { name: 'Bahrain', code: '+973', price: 90, countryId: 145, flag: '\u{1F1E7}\u{1F1ED}' },
    { name: 'Gambia', code: '+220', price: 32, countryId: 28, flag: '\u{1F1EC}\u{1F1F2}' },
    { name: 'Liberia', code: '+231', price: 31, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Angola', code: '+244', price: 33, countryId: 76, flag: '\u{1F1E6}\u{1F1F4}' },
    { name: 'Armenia', code: '+374', price: 30, countryId: 148, flag: '\u{1F1E6}\u{1F1F2}' },
    { name: 'Gabon', code: '+241', price: 34, countryId: 154, flag: '\u{1F1EC}\u{1F1E6}' },
    { name: 'Hungary', code: '+36', price: 29, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'Guinea', code: '+224', price: 32, countryId: 68, flag: '\u{1F1EC}\u{1F1F3}' },
    { name: 'Serbia', code: '+381', price: 31, countryId: 29, flag: '\u{1F1F7}\u{1F1F8}' },
    { name: 'Burundi', code: '+257', price: 33, countryId: 119, flag: '\u{1F1E7}\u{1F1EE}' },
    { name: 'South Sudan', code: '+211', price: 30, countryId: 177, flag: '\u{1F1F8}\u{1F1F8}' },
    { name: 'Maldives', code: '+960', price: 200, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Albania', code: '+355', price: 80, countryId: 155, flag: '\u{1F1E6}\u{1F1F1}' },
    { name: 'Guinea-Bissau', code: '+245', price: 80, countryId: 130, flag: '\u{1F1EC}\u{1F1FC}' },
    { name: 'Sierra Leone', code: '+232', price: 34, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' },
    { name: 'Azerbaijan', code: '+994', price: 29, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Slovakia', code: '+421', price: 32, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'North Macedonia', code: '+389', price: 31, countryId: 183, flag: '\u{1F1F2}\u{1F1F0}' },
    { name: 'Togo', code: '+228', price: 33, countryId: 99, flag: '\u{1F1F9}\u{1F1EC}' },
    { name: 'Lebanon', code: '+961', price: 170, countryId: 153, flag: '\u{1F1F1}\u{1F1E7}' },
    { name: 'Hong Kong', code: '+852', price: 30, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Denmark', code: '+45', price: 33, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
{ name: 'Tunisia', code: '+216', price: 80, countryId: 89, flag: '\u{1F1F9}\u{1F1F3}' },
{ name: 'Kazakhstan', code: '+7', price: 30, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
{ name: 'Latvia', code: '+371', price: 34, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
{ name: 'Uganda', code: '+256', price: 29, countryId: 75, flag: '\u{1F1FA}\u{1F1EC}' },
{ name: 'Greece', code: '+30', price: 32, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
{ name: 'Estonia', code: '+372', price: 31, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
{ name: 'Fiji', code: '+679', price: 70, countryId: 189, flag: '\u{1F1EB}\u{1F1EF}' },
{ name: 'Taiwan', code: '+886', price: 33, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
{ name: 'Kyrgyzstan', code: '+996', price: 30, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' },
{ name: 'Bolivia', code: '+591', price: 34, countryId: 92, flag: '\u{1F1E7}\u{1F1F4}' },
{ name: 'Haiti', code: '+509', price: 29, countryId: 26, flag: '\u{1F1ED}\u{1F1F9}' },
{ name: 'Myanmar', code: '+95', price: 32, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
{ name: 'Dominican Republic', code: '+1', price: 70, countryId: 109, flag: '\u{1F1E9}\u{1F1F4}' },
{ name: 'Belgium', code: '+32', price: 31, countryId: 82, flag: '\u{1F1E7}\u{1F1EA}' },
{ name: 'Eswatini', code: '+268', price: 33, countryId: 106, flag: '\u{1F1F8}\u{1F1FF}' },
{ name: 'Kuwait', code: '+965', price: 90, countryId: 100, flag: '\u{1F1F0}\u{1F1FC}' },
{ name: 'Laos', code: '+856', price: 30, countryId: 25, flag: '\u{1F1F1}\u{1F1E6}' },
{ name: 'Niger', code: '+227', price: 100, countryId: 139, flag: '\u{1F1F3}\u{1F1EA}' },
{ name: 'Tajikistan', code: '+992', price: 34, countryId: 143, flag: '\u{1F1F9}\u{1F1EF}' },
{ name: 'Qatar', code: '+974', price: 90, countryId: 111, flag: '\u{1F1F6}\u{1F1E6}' },
{ name: 'El Salvador', code: '+503', price: 80, countryId: 101, flag: '\u{1F1F8}\u{1F1FB}' },
{ name: 'New Zealand', code: '+64', price: 80, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
{ name: 'Libya', code: '+218', price: 90, countryId: 102, flag: '\u{1F1F1}\u{1F1FE}' },
{ name: 'Honduras', code: '+504', price: 29, countryId: 88, flag: '\u{1F1ED}\u{1F1F3}' },
{ name: 'United Arab Emirates', code: '+971', price: 60, countryId: 95, flag: '\u{1F1E6}\u{1F1EA}' },
{ name: 'Namibia', code: '+264', price: 60, countryId: 138, flag: '\u{1F1F3}\u{1F1E6}' },
{ name: 'Equatorial Guinea', code: '+240', price: 80, countryId: 167, flag: '\u{1F1EC}\u{1F1F6}' },
{ name: 'Somalia', code: '+252', price: 70, countryId: 149, flag: '\u{1F1F8}\u{1F1F4}' },
{ name: 'Jordan', code: '+962', price: 32, countryId: 116, flag: '\u{1F1EF}\u{1F1F4}' },
{ name: 'Central African Republic', code: '+236', price: 32, countryId: 125, flag: '\u{1F1E8}\u{1F1EB}' },
{ name: 'Zimbabwe', code: '+263', price: 80, countryId: 96, flag: '\u{1F1FF}\u{1F1FC}' },
{ name: 'Turkmenistan', code: '+993', price: 31, countryId: 161, flag: '\u{1F1F9}\u{1F1F2}' },
{ name: 'Rwanda', code: '+250', price: 80, countryId: 140, flag: '\u{1F1F7}\u{1F1FC}' },
{ name: 'Sudan', code: '+249', price: 90, countryId: 1010, flag: '\u{1F1F8}\u{1F1E9}' },
{ name: 'Reunion', code: '+262', price: 60, countryId: 146, flag: '\u{1F1F7}\u{1F1EA}' },
{ name: 'Oman', code: '+968', price: 80, countryId: 107, flag: '\u{1F1F4}\u{1F1F2}' },
{ name: 'Bhutan', code: '+975', price: 33, countryId: 158, flag: '\u{1F1E7}\u{1F1F9}' },
{ name: 'China', code: '+86', price: 30, countryId: 3, flag: '\u{1F1E8}\u{1F1F3}' },
{ name: 'Barbados', code: '+1', price: 34, countryId: 118, flag: '\u{1F1E7}\u{1F1E7}' },
{ name: 'Martinique', code: '+596', price: 29, countryId: 1011, flag: '\u{1F1F2}\u{1F1F6}' },
{ name: 'Puerto Rico', code: '+1', price: 60, countryId: 97, flag: '\u{1F1F5}\u{1F1F7}' },
{ name: 'Guadeloupe', code: '+590', price: 32, countryId: 160, flag: '\u{1F1EC}\u{1F1F5}' },
{ name: 'Luxembourg', code: '+352', price: 31, countryId: 165, flag: '\u{1F1F1}\u{1F1FA}' },
{ name: 'Antigua and Barbuda', code: '+1', price: 33, countryId: 169, flag: '\u{1F1E6}\u{1F1EC}' },
{ name: 'Djibouti', code: '+253', price: 30, countryId: 168, flag: '\u{1F1E9}\u{1F1EF}' },
{ name: 'French Guiana', code: '+594', price: 34, countryId: 162, flag: '\u{1F1EC}\u{1F1EB}' },
{ name: 'Saint Lucia', code: '+1', price: 29, countryId: 164, flag: '\u{1F1F1}\u{1F1E8}' },
{ name: 'Montenegro', code: '+382', price: 80, countryId: 171, flag: '\u{1F1F2}\u{1F1EA}' },
{ name: 'Bahamas', code: '+1', price: 70, countryId: 122, flag: '\u{1F1E7}\u{1F1F8}' },
{ name: 'Grenada', code: '+1', price: 90, countryId: 127, flag: '\u{1F1EC}\u{1F1E9}' },
{ name: 'Brunei', code: '+673', price: 170, countryId: 121, flag: '\u{1F1E7}\u{1F1F3}' },
{ name: 'Cayman Islands', code: '+1', price: 32, countryId: 170, flag: '\u{1F1F0}\u{1F1FE}' },
{ name: 'Saint Vincent', code: '+1', price: 31, countryId: 166, flag: '\u{1F1FB}\u{1F1E8}' },
{ name: 'Saint Kitts and Nevis', code: '+1', price: 33, countryId: 134, flag: '\u{1F1F0}\u{1F1F3}' },
{ name: 'Aruba', code: '+297', price: 30, countryId: 179, flag: '\u{1F1E6}\u{1F1FC}' },
{ name: 'Comoros', code: '+269', price: 80, countryId: 133, flag: '\u{1F1F0}\u{1F1F2}' },
{ name: 'Malta', code: '+356', price: 34, countryId: 199, flag: '\u{1F1F2}\u{1F1F9}' },
{ name: 'Singapore', code: '+65', price: 29, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
{ name: 'Anguilla', code: '+1', price: 80, countryId: 181, flag: '\u{1F1E6}\u{1F1EE}' },
{ name: 'Sao Tome and Principe', code: '+239', price: 32, countryId: 178, flag: '\u{1F1F8}\u{1F1F9}' },
{ name: 'Palestine', code: '+970', price: 31, countryId: 188, flag: '\u{1F1F5}\u{1F1F8}' },
{ name: 'Monaco', code: '+377', price: 33, countryId: 144, flag: '\u{1F1F2}\u{1F1E8}' },
{ name: 'Belize', code: '+501', price: 70, countryId: 124, flag: '\u{1F1E7}\u{1F1FF}' },
{ name: 'New Caledonia', code: '+687', price: 30, countryId: 185, flag: '\u{1F1F3}\u{1F1E8}' },
{ name: 'Seychelles', code: '+248', price: 34, countryId: 184, flag: '\u{1F1F8}\u{1F1E8}' },
{ name: 'Montserrat', code: '+1', price: 29, countryId: 180, flag: '\u{1F1F2}\u{1F1F8}' },
{ name: 'Dominica', code: '+1', price: 32, countryId: 126, flag: '\u{1F1E9}\u{1F1F2}' },
{ name: 'South Korea', code: '+82', price: 31, countryId: 1002, flag: '\u{1F1F0}\u{1F1F7}' },
{ name: 'Macau', code: '+853', price: 120, countryId: 20, flag: '\u{1F1F2}\u{1F1F4}' },
{ name: 'Iceland', code: '+354', price: 100, countryId: 132, flag: '\u{1F1EE}\u{1F1F8}' },
{ name: 'Eritrea', code: '+291', price: 33, countryId: 176, flag: '\u{1F1EA}\u{1F1F7}' },
{ name: 'Kosovo', code: '+383', price: 30, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' },
{ name: 'Uzbekistan', code: '+998', price: 34, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    ];

const instagramCountries = [
    { name: 'Indonesia', code: '+62', price: 30, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Belgium', code: '+32', price: 20, countryId: 82, flag: '\u{1F1E7}\u{1F1EA}' },
    { name: 'Indonesia', code: '+62', price: 16, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Colombia', code: '+57', price: 10, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'United States (Virtual)', code: '+1', price: 30, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Netherlands', code: '+31', price: 18, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'United Kingdom', code: '+44', price: 19, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'South Africa', code: '+27', price: 34, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Germany', code: '+49', price: 18, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Philippines', code: '+63', price: 19, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Thailand', code: '+66', price: 42, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Brazil', code: '+55', price: 38, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Kenya', code: '+254', price: 41, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Cambodia', code: '+855', price: 39, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' },
    { name: 'Yemen', code: '+967', price: 44, countryId: 30, flag: '\u{1F1FE}\u{1F1EA}' },
    { name: 'Ukraine', code: '+380', price: 37, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Morocco', code: '+212', price: 43, countryId: 37, flag: '\u{1F1F2}\u{1F1E6}' },
    { name: 'Nigeria', code: '+234', price: 40, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Uzbekistan', code: '+998', price: 45, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    { name: 'Sweden', code: '+46', price: 38, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Tanzania', code: '+255', price: 42, countryId: 9, flag: '\u{1F1F9}\u{1F1FF}' },
    { name: 'Chile', code: '+56', price: 37, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'India', code: '+91', price: 44, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Mozambique', code: '+258', price: 40, countryId: 80, flag: '\u{1F1F2}\u{1F1FF}' },
    { name: 'Ghana', code: '+233', price: 60, countryId: 38, flag: '\u{1F1EC}\u{1F1ED}' },
    { name: 'Cameroon', code: '+237', price: 41, countryId: 41, flag: '\u{1F1E8}\u{1F1F2}' },
    { name: 'Senegal', code: '+221', price: 39, countryId: 61, flag: '\u{1F1F8}\u{1F1F3}' },
    { name: 'Poland', code: '+48', price: 43, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Saudi Arabia', code: '+966', price: 38, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Egypt', code: '+20', price: 45, countryId: 21, flag: '\u{1F1EA}\u{1F1EC}' },
    { name: 'Romania', code: '+40', price: 40, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Ivory Coast', code: '+225', price: 42, countryId: 27, flag: '\u{1F1E8}\u{1F1EE}' },
    { name: 'Hong Kong', code: '+852', price: 37, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Jamaica', code: '+1', price: 44, countryId: 103, flag: '\u{1F1EF}\u{1F1F2}' },
    { name: 'France', code: '+33', price: 39, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'DR Congo', code: '+243', price: 43, countryId: 18, flag: '\u{1F1E8}\u{1F1E9}' },
    { name: 'Zambia', code: '+260', price: 38, countryId: 147, flag: '\u{1F1FF}\u{1F1F2}' },
    { name: 'Algeria', code: '+213', price: 45, countryId: 58, flag: '\u{1F1E9}\u{1F1FF}' },
    { name: 'Vietnam', code: '+84', price: 10, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Angola', code: '+244', price: 41, countryId: 76, flag: '\u{1F1E6}\u{1F1F4}' },
    { name: 'Canada', code: '+1', price: 17, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Portugal', code: '+351', price: 39, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Greece', code: '+30', price: 43, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Moldova', code: '+373', price: 40, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Madagascar', code: '+261', price: 44, countryId: 17, flag: '\u{1F1F2}\u{1F1EC}' },
    { name: 'Benin', code: '+229', price: 37, countryId: 120, flag: '\u{1F1E7}\u{1F1EF}' },
    { name: 'Afghanistan', code: '+93', price: 42, countryId: 74, flag: '\u{1F1E6}\u{1F1EB}' },
    { name: 'Uganda', code: '+256', price: 39, countryId: 75, flag: '\u{1F1FA}\u{1F1EC}' },
    { name: 'Ecuador', code: '+593', price: 45, countryId: 105, flag: '\u{1F1EA}\u{1F1E8}' },
    { name: 'UAE', code: '+971', price: 38, countryId: 95, flag: '\u{1F1E6}\u{1F1EA}' },
    { name: 'Nepal', code: '+977', price: 43, countryId: 81, flag: '\u{1F1F3}\u{1F1F5}' },
    { name: 'Bulgaria', code: '+359', price: 40, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Guinea', code: '+224', price: 44, countryId: 68, flag: '\u{1F1EC}\u{1F1F3}' },
    { name: 'Malawi', code: '+265', price: 37, countryId: 137, flag: '\u{1F1F2}\u{1F1FC}' },
    { name: 'Italy', code: '+39', price: 42, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'South Sudan', code: '+211', price: 39, countryId: 177, flag: '\u{1F1F8}\u{1F1F8}' },
    { name: 'Argentina', code: '+54', price: 45, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Czech Republic', code: '+420', price: 38, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Peru', code: '+51', price: 43, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Paraguay', code: '+595', price: 40, countryId: 87, flag: '\u{1F1F5}\u{1F1FE}' },
    { name: 'Spain', code: '+34', price: 60, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Turkey', code: '+90', price: 44, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Syria', code: '+963', price: 42, countryId: 1333, flag: '\u{1F1F8}\u{1F1FE}' },
    { name: 'Malaysia', code: '+60', price: 39, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Bolivia', code: '+591', price: 45, countryId: 92, flag: '\u{1F1E7}\u{1F1F4}' },
    { name: 'Niger', code: '+227', price: 80, countryId: 139, flag: '\u{1F1F3}\u{1F1EA}' },
    { name: 'Denmark', code: '+45', price: 38, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Uruguay', code: '+598', price: 100, countryId: 156, flag: '\u{1F1FA}\u{1F1FE}' },
    { name: 'Switzerland', code: '+41', price: 43, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Mexico', code: '+52', price: 40, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Nicaragua', code: '+505', price: 44, countryId: 90, flag: '\u{1F1F3}\u{1F1EE}' },
    { name: 'Trinidad and Tobago', code: '+1', price: 37, countryId: 104, flag: '\u{1F1F9}\u{1F1F9}' },
    { name: 'Guatemala', code: '+502', price: 90, countryId: 94, flag: '\u{1F1EC}\u{1F1F9}' },
    { name: 'Gambia', code: '+220', price: 42, countryId: 28, flag: '\u{1F1EC}\u{1F1F2}' },
    { name: 'Estonia', code: '+372', price: 39, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Liberia', code: '+231', price: 45, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Costa Rica', code: '+506', price: 70, countryId: 93, flag: '\u{1F1E8}\u{1F1F7}' },
    { name: 'Puerto Rico', code: '+1', price: 100, countryId: 97, flag: '\u{1F1F5}\u{1F1F7}' },
    { name: 'Guyana', code: '+592', price: 80, countryId: 131, flag: '\u{1F1EC}\u{1F1FE}' },
    { name: 'Ethiopia', code: '+251', price: 38, countryId: 71, flag: '\u{1F1EA}\u{1F1F9}' },
    { name: 'Papua New Guinea', code: '+675', price: 70, countryId: 79, flag: '\u{1F1F5}\u{1F1EC}' },
    { name: 'Mauritius', code: '+230', price: 43, countryId: 157, flag: '\u{1F1F2}\u{1F1FA}' },
    { name: 'Chad', code: '+235', price: 40, countryId: 42, flag: '\u{1F1F9}\u{1F1E9}' },
    { name: 'Lebanon', code: '+961', price: 60, countryId: 153, flag: '\u{1F1F1}\u{1F1E7}' },
    { name: 'Pakistan', code: '+92', price: 44, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Sri Lanka', code: '+94', price: 37, countryId: 64, flag: '\u{1F1F1}\u{1F1F0}' },
    { name: 'Libya', code: '+218', price: 42, countryId: 102, flag: '\u{1F1F1}\u{1F1FE}' },
    { name: 'Honduras', code: '+504', price: 39, countryId: 88, flag: '\u{1F1ED}\u{1F1F3}' },
    { name: 'Mauritania', code: '+222', price: 45, countryId: 114, flag: '\u{1F1F2}\u{1F1F7}' },
    { name: 'Burkina Faso', code: '+226', price: 70, countryId: 152, flag: '\u{1F1E7}\u{1F1EB}' },
    { name: 'Macedonia', code: '+389', price: 38, countryId: 183, flag: '\u{1F1F2}\u{1F1F0}' },
    { name: 'Qatar', code: '+974', price: 100, countryId: 111, flag: '\u{1F1F6}\u{1F1E6}' },
    { name: 'Somalia', code: '+252', price: 43, countryId: 149, flag: '\u{1F1F8}\u{1F1F4}' },
    { name: 'Congo', code: '+242', price: 40, countryId: 150, flag: '\u{1F1E8}\u{1F1EC}' },
    { name: 'New Zealand', code: '+64', price: 44, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Sudan', code: '+249', price: 110, countryId: 1010, flag: '\u{1F1F8}\u{1F1E9}' },
    { name: 'Georgia', code: '+995', price: 37, countryId: 128, flag: '\u{1F1EC}\u{1F1EA}' },
    { name: 'Bahamas', code: '+1', price: 90, countryId: 122, flag: '\u{1F1E7}\u{1F1F8}' },
    { name: 'Taiwan', code: '+886', price: 42, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
    { name: 'El Salvador', code: '+503', price: 110, countryId: 101, flag: '\u{1F1F8}\u{1F1FB}' },
    { name: 'Cuba', code: '+53', price: 100, countryId: 113, flag: '\u{1F1E8}\u{1F1FA}' },
    { name: 'Venezuela', code: '+58', price: 39, countryId: 70, flag: '\u{1F1FB}\u{1F1EA}' },
    { name: 'Mali', code: '+223', price: 45, countryId: 69, flag: '\u{1F1F2}\u{1F1F1}' },
    { name: 'USA', code: '+1', price: 40, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'United Kingdom', code: '+44', price: 40, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const snapchatCountries = [
    { name: 'Indonesia', code: '+62', price: 40, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'USA', code: '+1', price: 40, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Lesotho', code: '+266', price: 31, countryId: 136, flag: '\u{1F1F1}\u{1F1F8}' },
    { name: 'Ecuador', code: '+593', price: 100, countryId: 105, flag: '\u{1F1EA}\u{1F1E8}' },
    { name: 'El Salvador', code: '+503', price: 90, countryId: 101, flag: '\u{1F1F8}\u{1F1FB}' },
    { name: 'Uganda', code: '+256', price: 33, countryId: 75, flag: '\u{1F1FA}\u{1F1EC}' },
    { name: 'Malawi', code: '+265', price: 29, countryId: 137, flag: '\u{1F1F2}\u{1F1FC}' },
    { name: 'Kenya', code: '+254', price: 34, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Panama', code: '+507', price: 30, countryId: 112, flag: '\u{1F1F5}\u{1F1E6}' },
    { name: 'Jamaica', code: '+1', price: 90, countryId: 103, flag: '\u{1F1EF}\u{1F1F2}' },
    { name: 'Venezuela', code: '+58', price: 200, countryId: 70, flag: '\u{1F1FB}\u{1F1EA}' },
    { name: 'Kazakhstan', code: '+7', price: 32, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Paraguay', code: '+595', price: 100, countryId: 87, flag: '\u{1F1F5}\u{1F1FE}' },
    { name: 'Kyrgyzstan', code: '+996', price: 200, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' },
    { name: 'Jordan', code: '+962', price: 100, countryId: 116, flag: '\u{1F1EF}\u{1F1F4}' },
    { name: 'Cameroon', code: '+237', price: 31, countryId: 41, flag: '\u{1F1E8}\u{1F1F2}' },
    { name: 'Ivory Coast', code: '+225', price: 29, countryId: 27, flag: '\u{1F1E8}\u{1F1EE}' },
    { name: 'Bulgaria', code: '+359', price: 34, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Libya', code: '+218', price: 80, countryId: 102, flag: '\u{1F1F1}\u{1F1FE}' },
    { name: 'Mauritius', code: '+230', price: 100, countryId: 157, flag: '\u{1F1F2}\u{1F1FA}' },
    { name: 'Mali', code: '+223', price: 30, countryId: 69, flag: '\u{1F1F2}\u{1F1F1}' },
    { name: 'Rwanda', code: '+250', price: 33, countryId: 140, flag: '\u{1F1F7}\u{1F1FC}' },
    { name: 'Gabon', code: '+241', price: 32, countryId: 154, flag: '\u{1F1EC}\u{1F1E6}' },
    { name: 'Nicaragua', code: '+505', price: 29, countryId: 90, flag: '\u{1F1F3}\u{1F1EE}' },
    { name: 'Moldova', code: '+373', price: 31, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Thailand', code: '+66', price: 34, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Benin', code: '+229', price: 100, countryId: 120, flag: '\u{1F1E7}\u{1F1EF}' },
    { name: 'Costa Rica', code: '+506', price: 100, countryId: 93, flag: '\u{1F1E8}\u{1F1F7}' },
    { name: 'Burkina Faso', code: '+226', price: 30, countryId: 152, flag: '\u{1F1E7}\u{1F1EB}' },
    { name: 'Qatar', code: '+974', price: 100, countryId: 111, flag: '\u{1F1F6}\u{1F1E6}' },
    { name: 'Reunion', code: '+262', price: 110, countryId: 146, flag: '\u{1F1F7}\u{1F1EA}' },
    { name: 'Oman', code: '+968', price: 110, countryId: 107, flag: '\u{1F1F4}\u{1F1F2}' },
    { name: 'Congo', code: '+242', price: 33, countryId: 150, flag: '\u{1F1E8}\u{1F1EC}' },
    { name: 'Yemen', code: '+967', price: 70, countryId: 30, flag: '\u{1F1FE}\u{1F1EA}' },
    { name: 'Uruguay', code: '+598', price: 32, countryId: 156, flag: '\u{1F1FA}\u{1F1FE}' },
    { name: 'Iraq', code: '+964', price: 100, countryId: 47, flag: '\u{1F1EE}\u{1F1F6}' },
    { name: 'Togo', code: '+228', price: 29, countryId: 99, flag: '\u{1F1F9}\u{1F1EC}' },
    { name: 'Niger', code: '+227', price: 34, countryId: 139, flag: '\u{1F1F3}\u{1F1EA}' },
    { name: 'Bhutan', code: '+975', price: 70, countryId: 158, flag: '\u{1F1E7}\u{1F1F9}' },
    { name: 'Burundi', code: '+257', price: 31, countryId: 119, flag: '\u{1F1E7}\u{1F1EE}' },
    { name: 'Equatorial Guinea', code: '+240', price: 100, countryId: 167, flag: '\u{1F1EC}\u{1F1F6}' },
    { name: 'Trinidad and Tobago', code: '+1', price: 60, countryId: 104, flag: '\u{1F1F9}\u{1F1F9}' },
    { name: 'South Sudan', code: '+211', price: 30, countryId: 177, flag: '\u{1F1F8}\u{1F1F8}' },
    { name: 'Mauritania', code: '+222', price: 100, countryId: 114, flag: '\u{1F1F2}\u{1F1F7}' },
    { name: 'China', code: '+86', price: 130, countryId: 3, flag: '\u{1F1E8}\u{1F1F3}' },
    { name: 'Kuwait', code: '+965', price: 110, countryId: 100, flag: '\u{1F1F0}\u{1F1FC}' },
    { name: 'Guinea-Bissau', code: '+245', price: 110, countryId: 130, flag: '\u{1F1EC}\u{1F1FC}' },
    { name: 'Maldives', code: '+960', price: 100, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Bosnia and Herzegovina', code: '+387', price: 140, countryId: 108, flag: '\u{1F1E7}\u{1F1E6}' },
    { name: 'Somalia', code: '+252', price: 33, countryId: 149, flag: '\u{1F1F8}\u{1F1F4}' },
    { name: 'Barbados', code: '+1', price: 200, countryId: 118, flag: '\u{1F1E7}\u{1F1E7}' },
    { name: 'Gambia', code: '+220', price: 100, countryId: 28, flag: '\u{1F1EC}\u{1F1F2}' },
    { name: 'Armenia', code: '+374', price: 230, countryId: 148, flag: '\u{1F1E6}\u{1F1F2}' },
    { name: 'Guyana', code: '+592', price: 29, countryId: 131, flag: '\u{1F1EC}\u{1F1FE}' },
    { name: 'Chad', code: '+235', price: 100, countryId: 42, flag: '\u{1F1F9}\u{1F1E9}' },
    { name: 'Switzerland', code: '+41', price: 130, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Serbia', code: '+381', price: 140, countryId: 29, flag: '\u{1F1F7}\u{1F1F8}' },
    { name: 'Estonia', code: '+372', price: 40, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Bahrain', code: '+973', price: 32, countryId: 145, flag: '\u{1F1E7}\u{1F1ED}' },
    { name: 'Guadeloupe', code: '+590', price: 100, countryId: 160, flag: '\u{1F1EC}\u{1F1F5}' },
    { name: 'Cyprus', code: '+357', price: 30, countryId: 77, flag: '\u{1F1E8}\u{1F1FE}' },
    { name: 'Luxembourg', code: '+352', price: 140, countryId: 165, flag: '\u{1F1F1}\u{1F1FA}' },
    { name: 'Suriname', code: '+597', price: 34, countryId: 142, flag: '\u{1F1F8}\u{1F1F7}' },
    { name: 'Guatemala', code: '+502', price: 31, countryId: 94, flag: '\u{1F1EC}\u{1F1F9}' },
    { name: 'Madagascar', code: '+261', price: 110, countryId: 17, flag: '\u{1F1F2}\u{1F1EC}' },
    { name: 'Antigua and Barbuda', code: '+1', price: 110, countryId: 169, flag: '\u{1F1E6}\u{1F1EC}' },
    { name: 'Djibouti', code: '+253', price: 110, countryId: 168, flag: '\u{1F1E9}\u{1F1EF}' },
    { name: 'French Guiana', code: '+594', price: 100, countryId: 162, flag: '\u{1F1EC}\u{1F1EB}' },
    { name: 'Saint Lucia', code: '+1', price: 100, countryId: 164, flag: '\u{1F1F1}\u{1F1E8}' },
    { name: 'Montenegro', code: '+382', price: 29, countryId: 171, flag: '\u{1F1F2}\u{1F1EA}' },
    { name: 'Cuba', code: '+53', price: 33, countryId: 113, flag: '\u{1F1E8}\u{1F1FA}' },
    { name: 'Sierra Leone', code: '+232', price: 30, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' },
    { name: 'Bahamas', code: '+1', price: 100, countryId: 122, flag: '\u{1F1E7}\u{1F1F8}' },
    { name: 'Bolivia', code: '+591', price: 32, countryId: 92, flag: '\u{1F1E7}\u{1F1F4}' },
    { name: 'Grenada', code: '+1', price: 100, countryId: 127, flag: '\u{1F1EC}\u{1F1E9}' },
    { name: 'Latvia', code: '+371', price: 31, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Tajikistan', code: '+992', price: 34, countryId: 143, flag: '\u{1F1F9}\u{1F1EF}' },
    { name: 'Brunei', code: '+673', price: 29, countryId: 121, flag: '\u{1F1E7}\u{1F1F3}' },
    { name: 'Cayman Islands', code: '+1', price: 170, countryId: 170, flag: '\u{1F1F0}\u{1F1FE}' },
    { name: 'Saint Vincent', code: '+1', price: 120, countryId: 166, flag: '\u{1F1FB}\u{1F1E8}' },
    { name: 'Albania', code: '+355', price: 140, countryId: 155, flag: '\u{1F1E6}\u{1F1F1}' },
    { name: 'Slovenia', code: '+386', price: 30, countryId: 59, flag: '\u{1F1F8}\u{1F1EE}' },
    { name: 'Saint Kitts and Nevis', code: '+1', price: 33, countryId: 134, flag: '\u{1F1F0}\u{1F1F3}' },
    { name: 'Lithuania', code: '+370', price: 200, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'CAF', code: '+236', price: 32, countryId: 125, flag: '\u{1F1E8}\u{1F1EB}' },
    { name: 'Liberia', code: '+231', price: 110, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Japan', code: '+81', price: 110, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'Guinea', code: '+224', price: 29, countryId: 68, flag: '\u{1F1EC}\u{1F1F3}' },
    { name: 'Aruba', code: '+297', price: 34, countryId: 179, flag: '\u{1F1E6}\u{1F1FC}' },
    { name: 'Comoros', code: '+269', price: 100, countryId: 133, flag: '\u{1F1F0}\u{1F1F2}' },
    { name: 'Slovakia', code: '+421', price: 110, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'Anguilla', code: '+1', price: 80, countryId: 181, flag: '\u{1F1E6}\u{1F1EE}' },
    { name: 'Sao Tome and Principe', code: '+239', price: 31, countryId: 178, flag: '\u{1F1F8}\u{1F1F9}' },
    { name: 'Croatia', code: '+385', price: 30, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'Cape Verde', code: '+238', price: 33, countryId: 186, flag: '\u{1F1E8}\u{1F1FB}' },
    { name: 'Monaco', code: '+377', price: 100, countryId: 144, flag: '\u{1F1F2}\u{1F1E8}' },
    { name: 'Macedonia', code: '+389', price: 110, countryId: 183, flag: '\u{1F1F2}\u{1F1F0}' },
    { name: 'Belize', code: '+501', price: 29, countryId: 124, flag: '\u{1F1E7}\u{1F1FF}' },
    { name: 'New Caledonia', code: '+687', price: 100, countryId: 185, flag: '\u{1F1F3}\u{1F1E8}' },
    { name: 'New Zealand', code: '+64', price: 78, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Mongolia', code: '+976', price: 34, countryId: 72, flag: '\u{1F1F2}\u{1F1F3}' },
    { name: 'Seychelles', code: '+248', price: 32, countryId: 184, flag: '\u{1F1F8}\u{1F1E8}' },
    { name: 'Montserrat', code: '+1', price: 100, countryId: 180, flag: '\u{1F1F2}\u{1F1F8}' },
    { name: 'Dominica', code: '+1', price: 70, countryId: 126, flag: '\u{1F1E9}\u{1F1F2}' },
    { name: 'Macau', code: '+853', price: 70, countryId: 20, flag: '\u{1F1F2}\u{1F1F4}' },
    { name: 'Iceland', code: '+354', price: 31, countryId: 132, flag: '\u{1F1EE}\u{1F1F8}' },
    { name: 'Eritrea', code: '+291', price: 100, countryId: 176, flag: '\u{1F1EA}\u{1F1F7}' },
    { name: 'Gibraltar', code: '+350', price: 400, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const googleCountries = [
    { name: 'USA Virtual', code: '+1', price: 90, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Indonesia', code: '+62', price: 90, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Brazil', code: '+55', price: 90, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'USA', code: '+1', price: 120, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Colombia', code: '+57', price: 89, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'India', code: '+91', price: 50, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Chile', code: '+56', price: 40, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Sweden', code: '+46', price: 40, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Argentina', code: '+54', price: 40, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Algeria', code: '+213', price: 100, countryId: 58, flag: '\u{1F1E9}\u{1F1FF}' },
    { name: 'France', code: '+33', price: 90, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Greece', code: '+30', price: 130, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'United Kingdom', code: '+44', price: 40, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'South Africa', code: '+27', price: 35, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Canada', code: '+1', price: 80, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Bangladesh', code: '+880', price: 70, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'Italy', code: '+39', price: 80, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Poland', code: '+48', price: 100, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Nigeria', code: '+234', price: 90, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Germany', code: '+49', price: 98, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Spain', code: '+34', price: 100, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Ghana', code: '+233', price: 40, countryId: 38, flag: '\u{1F1EC}\u{1F1ED}' },
    { name: 'Portugal', code: '+351', price: 40, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Netherlands', code: '+31', price: 40, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' }
];


const tiktokCountries = [
    { name: 'Afghanistan', code: '', price: 32, countryId: 74, flag: '\u{1F1E6}\u{1F1EB}' },
    { name: 'Albania', code: '', price: 22.53, countryId: 155, flag: '\u{1F1E6}\u{1F1F1}' },
    { name: 'Angola', code: '', price: 18, countryId: 76, flag: '\u{1F1E6}\u{1F1F4}' },
    { name: 'Argentina', code: '', price: 13, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Australia', code: '', price: 29.63, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'Austria', code: '', price: 17.53, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Bangladesh', code: '', price: 18, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'Belarus', code: '', price: 48.40, countryId: 51, flag: '\u{1F1E7}\u{1F1FE}' },
    { name: 'Belgium', code: '', price: 45.90, countryId: 82, flag: '\u{1F1E7}\u{1F1EA}' },
    { name: 'Bulgaria', code: '', price: 2.50, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Canada', code: '', price: 8.35, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Chile', code: '', price: 4.17, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'China', code: '', price: 45.07, countryId: 3, flag: '\u{1F1E8}\u{1F1F3}' },
    { name: 'Cyprus', code: '', price: 2.50, countryId: 77, flag: '\u{1F1E8}\u{1F1FE}' },
    { name: 'Czech Republic', code: '', price: 15.86, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Denmark', code: '', price: 5.01, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Estonia', code: '', price: 10.85, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'France', code: '', price: 7.51, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Germany', code: '', price: 5.84, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Greece', code: '', price: 14.19, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Guinea-Bissau', code: '', price: 2.50, countryId: 130, flag: '\u{1F1EC}\u{1F1FC}' },
    { name: 'Hong Kong', code: '', price: 48.40, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Hungary', code: '', price: 5.01, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'India', code: '', price: 9.60, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Indonesia', code: '', price: 1.67, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Italy', code: '', price: 5.84, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Latvia', code: '', price: 13.35, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Macau', code: '', price: 48.40, countryId: 20, flag: '\u{1F1F2}\u{1F1F4}' },
    { name: 'Malaysia', code: '', price: 30, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Maldives', code: '', price: 2.50, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Mauritania', code: '', price: 48.40, countryId: 114, flag: '\u{1F1F2}\u{1F1F7}' },
    { name: 'Mauritius', code: '', price: 40.06, countryId: 157, flag: '\u{1F1F2}\u{1F1FA}' },
    { name: 'Mexico', code: '', price: 4.59, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Mongolia', code: '', price: 48.40, countryId: 72, flag: '\u{1F1F2}\u{1F1F3}' },
    { name: 'Nepal', code: '', price: 19, countryId: 81, flag: '\u{1F1F3}\u{1F1F5}' },
    { name: 'Netherlands', code: '', price: 7.93, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Nigeria', code: '', price: 6.26, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Pakistan', code: '', price: 30, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Philippines', code: '', price: 3.34, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Poland', code: '', price: 7.51, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Puerto Rico', code: '', price: 48.40, countryId: 97, flag: '\u{1F1F5}\u{1F1F7}' },
    { name: 'Reunion', code: '', price: 48.40, countryId: 146, flag: '\u{1F1F7}\u{1F1EA}' },
    { name: 'Saudi Arabia', code: '', price: 28.37, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'South Sudan', code: '', price: 2.50, countryId: 177, flag: '\u{1F1F8}\u{1F1F8}' },
    { name: 'Spain', code: '', price: 16.69, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Sri Lanka', code: '', price: 2.50, countryId: 64, flag: '\u{1F1F1}\u{1F1F0}' },
    { name: 'Sweden', code: '', price: 1.67, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Switzerland', code: '', price: 12.94, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Taiwan', code: '', price: 48.40, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
    { name: 'Turkey', code: '', price: 48.40, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'UAE', code: '', price: 17.94, countryId: 95, flag: '\u{1F1E6}\u{1F1EA}' },
    { name: 'Ukraine', code: '', price: 11.27, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'United Kingdom', code: '', price: 60, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }, 
    { name: 'USA', code: '', price: 60, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },    
    { name: 'Uzbekistan', code: '', price: 2.50, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    { name: 'Vietnam', code: '', price: 15.86, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Yemen', code: '', price: 2.50, countryId: 30, flag: '\u{1F1FE}\u{1F1EA}' }
];
const imoCountries = [
    { name: 'Saudi Arabia', code: '+966', price: 14, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Thailand', code: '+66', price: 20, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'USA Virtual', code: '+1', price: 12, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Malaysia', code: '+60', price: 19, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Indonesia', code: '+62', price: 6, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Italy', code: '+39', price: 60, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'USA', code: '+1', price: 10, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Australia', code: '+61', price: 70, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'South Africa', code: '+27', price: 9, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Portugal', code: '+351', price: 28, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Canada', code: '+1', price: 9, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Vietnam', code: '+84', price: 14, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'United Kingdom', code: '+44', price: 10, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Hungary', code: '+36', price: 140, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'Sweden', code: '+46', price: 27, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Bangladesh', code: '+880', price: 30, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'Turkey', code: '+90', price: 70, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Austria', code: '+43', price: 80, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Qatar', code: '+974', price: 190, countryId: 111, flag: '\u{1F1F6}\u{1F1E6}' },
    { name: 'Taiwan', code: '+886', price: 90, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
    { name: 'UAE', code: '+971', price: 40, countryId: 95, flag: '\u{1F1E6}\u{1F1EA}' },
    { name: 'Pakistan', code: '+92', price: 40, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Mexico', code: '+52', price: 26, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Bahamas', code: '+1', price: 200, countryId: 122, flag: '\u{1F1E7}\u{1F1F8}' },
    { name: 'Finland', code: '+358', price: 80, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'Oman', code: '+968', price: 200, countryId: 107, flag: '\u{1F1F4}\u{1F1F2}' },
    { name: 'Kuwait', code: '+965', price: 200, countryId: 100, flag: '\u{1F1F0}\u{1F1FC}' },
    { name: 'Spain', code: '+34', price: 60, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Mongolia', code: '+976', price: 28, countryId: 72, flag: '\u{1F1F2}\u{1F1F3}' },
    { name: 'Cyprus', code: '+357', price: 40, countryId: 77, flag: '\u{1F1E8}\u{1F1FE}' },
    { name: 'Brazil', code: '+55', price: 9, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'France', code: '+33', price: 20, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Netherlands', code: '+31', price: 25, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Iraq', code: '+964', price: 200, countryId: 47, flag: '\u{1F1EE}\u{1F1F6}' },
    { name: 'Colombia', code: '+57', price: 29, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Lithuania', code: '+370', price: 240, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'Yemen', code: '+967', price: 24, countryId: 30, flag: '\u{1F1FE}\u{1F1EA}' },
    { name: 'Philippines', code: '+63', price: 27, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Poland', code: '+48', price: 26, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Venezuela', code: '+58', price: 70, countryId: 70, flag: '\u{1F1FB}\u{1F1EA}' },
    { name: 'Romania', code: '+40', price: 40, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Belarus', code: '+375', price: 90, countryId: 51, flag: '\u{1F1E7}\u{1F1FE}' },
    { name: 'Armenia', code: '+374', price: 200, countryId: 148, flag: '\u{1F1E6}\u{1F1F2}' },
    { name: 'Germany', code: '+49', price: 28, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'India', code: '+91', price: 25, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Zambia', code: '+260', price: 29, countryId: 147, flag: '\u{1F1FF}\u{1F1F2}' },
    { name: 'Namibia', code: '+264', price: 24, countryId: 138, flag: '\u{1F1F3}\u{1F1E6}' },
    { name: 'Papua New Guinea', code: '+675', price: 30, countryId: 79, flag: '\u{1F1F5}\u{1F1EC}' },
    { name: 'Algeria', code: '+213', price: 27, countryId: 58, flag: '\u{1F1E9}\u{1F1FF}' },
    { name: 'Ethiopia', code: '+251', price: 40, countryId: 71, flag: '\u{1F1EA}\u{1F1F9}' },
    { name: 'Mozambique', code: '+258', price: 40, countryId: 80, flag: '\u{1F1F2}\u{1F1FF}' },
    { name: 'Angola', code: '+244', price: 10, countryId: 76, flag: '\u{1F1E6}\u{1F1F4}' },
    { name: 'Ukraine', code: '+380', price: 9, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Egypt', code: '+20', price: 60, countryId: 21, flag: '\u{1F1EA}\u{1F1EC}' },
    { name: 'Haiti', code: '+509', price: 200, countryId: 26, flag: '\u{1F1ED}\u{1F1F9}' },
    { name: 'Iran', code: '+98', price: 40, countryId: 57, flag: '\u{1F1EE}\u{1F1F7}' },
    { name: 'Peru', code: '+51', price: 26, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Zimbabwe', code: '+263', price: 28, countryId: 96, flag: '\u{1F1FF}\u{1F1FC}' },
    { name: 'Nepal', code: '+977', price: 40, countryId: 81, flag: '\u{1F1F3}\u{1F1F5}' },
    { name: 'Uzbekistan', code: '+998', price: 25, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    { name: 'Nigeria', code: '+234', price: 29, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Swaziland', code: '+268', price: 24, countryId: 106, flag: '\u{1F1F8}\u{1F1FF}' },
    { name: 'Congo (Dem. Republic)', code: '+243', price: 27, countryId: 18, flag: '\u{1F1E8}\u{1F1E9}' },
    { name: 'Botswana', code: '+267', price: 30, countryId: 123, flag: '\u{1F1E7}\u{1F1FC}' },
    { name: 'Tanzania', code: '+255', price: 26, countryId: 9, flag: '\u{1F1F9}\u{1F1FF}' },
    { name: 'Sri Lanka', code: '+94', price: 40, countryId: 64, flag: '\u{1F1F1}\u{1F1F0}' },
    { name: 'Honduras', code: '+504', price: 28, countryId: 88, flag: '\u{1F1ED}\u{1F1F3}' },
    { name: 'Argentina', code: '+54', price: 25, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Myanmar', code: '+95', price: 29, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'Tunisia', code: '+216', price: 24, countryId: 89, flag: '\u{1F1F9}\u{1F1F3}' },
    { name: 'Timor-Leste', code: '+670', price: 27, countryId: 91, flag: '\u{1F1F9}\u{1F1F1}' },
    { name: 'Lesotho', code: '+266', price: 30, countryId: 136, flag: '\u{1F1F1}\u{1F1F8}' },
    { name: 'Ecuador', code: '+593', price: 40, countryId: 105, flag: '\u{1F1EA}\u{1F1E8}' },
    { name: 'El Salvador', code: '+503', price: 26, countryId: 101, flag: '\u{1F1F8}\u{1F1FB}' },
    { name: 'Morocco', code: '+212', price: 28, countryId: 37, flag: '\u{1F1F2}\u{1F1E6}' },
    { name: 'Uganda', code: '+256', price: 25, countryId: 75, flag: '\u{1F1FA}\u{1F1EC}' },
    { name: 'Malawi', code: '+265', price: 29, countryId: 137, flag: '\u{1F1F2}\u{1F1FC}' },
    { name: 'Ghana', code: '+233', price: 24, countryId: 38, flag: '\u{1F1EC}\u{1F1ED}' },
    { name: 'Kenya', code: '+254', price: 27, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Panama', code: '+507', price: 30, countryId: 112, flag: '\u{1F1F5}\u{1F1E6}' },
    { name: 'Jamaica', code: '+1', price: 26, countryId: 103, flag: '\u{1F1EF}\u{1F1F2}' },
    { name: 'Kazakhstan', code: '+7', price: 28, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Paraguay', code: '+595', price: 25, countryId: 87, flag: '\u{1F1F5}\u{1F1FE}' },
    { name: 'Kyrgyzstan', code: '+996', price: 29, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' },
    { name: 'Cameroon', code: '+237', price: 24, countryId: 41, flag: '\u{1F1E8}\u{1F1F2}' },
    { name: 'Cote d`Ivoire Ivory Coast', code: '+225', price: 27, countryId: 27, flag: '\u{1F1E8}\u{1F1EE}' },
    { name: 'Bulgaria', code: '+359', price: 30, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Libya', code: '+218', price: 26, countryId: 102, flag: '\u{1F1F1}\u{1F1FE}' },
    { name: 'Mauritius', code: '+230', price: 28, countryId: 157, flag: '\u{1F1F2}\u{1F1FA}' },
    { name: 'Turkmenistan', code: '+993', price: 200, countryId: 161, flag: '\u{1F1F9}\u{1F1F2}' },
    { name: 'Azerbaijan', code: '+994', price: 90, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Mali', code: '+223', price: 25, countryId: 69, flag: '\u{1F1F2}\u{1F1F1}' },
    { name: 'Rwanda', code: '+250', price: 40, countryId: 140, flag: '\u{1F1F7}\u{1F1FC}' },
    { name: 'Gabon', code: '+241', price: 200, countryId: 154, flag: '\u{1F1EC}\u{1F1E6}' },
    { name: 'Sudan', code: '+249', price: 120, countryId: 1010, flag: '\u{1F1F8}\u{1F1E9}' },
    { name: 'Nicaragua', code: '+505', price: 29, countryId: 90, flag: '\u{1F1F3}\u{1F1EE}' },
    { name: 'Moldova', code: '+373', price: 24, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Benin', code: '+229', price: 27, countryId: 120, flag: '\u{1F1E7}\u{1F1EF}' },
    { name: 'Costa Rica', code: '+506', price: 30, countryId: 93, flag: '\u{1F1E8}\u{1F1F7}' },
    { name: 'Burkina Faso', code: '+226', price: 40, countryId: 152, flag: '\u{1F1E7}\u{1F1EB}' },
    { name: 'Belgium', code: '+32', price: 26, countryId: 82, flag: '\u{1F1E7}\u{1F1EA}' },
    { name: 'Reunion', code: '+262', price: 200, countryId: 146, flag: '\u{1F1F7}\u{1F1EA}' },
    { name: 'Congo', code: '+242', price: 28, countryId: 150, flag: '\u{1F1E8}\u{1F1EC}' },
    { name: 'Uruguay', code: '+598', price: 25, countryId: 156, flag: '\u{1F1FA}\u{1F1FE}' },
    { name: 'Senegal', code: '+221', price: 29, countryId: 61, flag: '\u{1F1F8}\u{1F1F3}' },
    { name: 'Laos', code: '+856', price: 24, countryId: 25, flag: '\u{1F1F1}\u{1F1E6}' },
    { name: 'Togo', code: '+228', price: 40, countryId: 99, flag: '\u{1F1F9}\u{1F1EC}' },
    { name: 'Niger', code: '+227', price: 40, countryId: 139, flag: '\u{1F1F3}\u{1F1EA}' },
    { name: 'Syria', code: '+963', price: 120, countryId: 1333, flag: '\u{1F1F8}\u{1F1FE}' },
    { name: 'Bhutan', code: '+975', price: 60, countryId: 158, flag: '\u{1F1E7}\u{1F1F9}' },
    { name: 'Burundi', code: '+257', price: 27, countryId: 119, flag: '\u{1F1E7}\u{1F1EE}' },
    { name: 'Equatorial Guinea', code: '+240', price: 200, countryId: 167, flag: '\u{1F1EC}\u{1F1F6}' },
    { name: 'Trinidad and Tobago', code: '+1', price: 60, countryId: 104, flag: '\u{1F1F9}\u{1F1F9}' },
    { name: 'Cambodia', code: '+855', price: 70, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' },
    { name: 'South Sudan', code: '+211', price: 26, countryId: 177, flag: '\u{1F1F8}\u{1F1F8}' },
    { name: 'Mauritania', code: '+222', price: 28, countryId: 114, flag: '\u{1F1F2}\u{1F1F7}' },
    { name: 'Guinea-Bissau', code: '+245', price: 200, countryId: 130, flag: '\u{1F1EC}\u{1F1FC}' },
    { name: 'Maldives', code: '+960', price: 25, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Bosnia and Herzegovina', code: '+387', price: 29, countryId: 108, flag: '\u{1F1E7}\u{1F1E6}' },
    { name: 'Somalia', code: '+252', price: 24, countryId: 149, flag: '\u{1F1F8}\u{1F1F4}' },
    { name: 'Barbados', code: '+1', price: 27, countryId: 118, flag: '\u{1F1E7}\u{1F1E7}' },
    { name: 'Martinique', code: '+596', price: 30, countryId: 1011, flag: '\u{1F1F2}\u{1F1F6}' },
    { name: 'Dominican Republic', code: '+1', price: 26, countryId: 109, flag: '\u{1F1E9}\u{1F1F4}' },
    { name: 'Gambia', code: '+220', price: 28, countryId: 28, flag: '\u{1F1EC}\u{1F1F2}' },
    { name: 'Afghanistan', code: '+93', price: 25, countryId: 74, flag: '\u{1F1E6}\u{1F1EB}' },
    { name: 'Guyana', code: '+592', price: 29, countryId: 131, flag: '\u{1F1EC}\u{1F1FE}' },
    { name: 'Chad', code: '+235', price: 24, countryId: 42, flag: '\u{1F1F9}\u{1F1E9}' },
    { name: 'Switzerland', code: '+41', price: 27, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Puerto Rico', code: '+1', price: 30, countryId: 97, flag: '\u{1F1F5}\u{1F1F7}' },
    { name: 'Ireland', code: '+353', price: 26, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Serbia', code: '+381', price: 28, countryId: 29, flag: '\u{1F1F7}\u{1F1F8}' },
    { name: 'Estonia', code: '+372', price: 25, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Bahrain', code: '+973', price: 29, countryId: 145, flag: '\u{1F1E7}\u{1F1ED}' },
    { name: 'Czech Republic', code: '+420', price: 24, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Guadeloupe', code: '+590', price: 27, countryId: 160, flag: '\u{1F1EC}\u{1F1F5}' },
    { name: 'Luxembourg', code: '+352', price: 30, countryId: 165, flag: '\u{1F1F1}\u{1F1FA}' },
    { name: 'Suriname', code: '+597', price: 26, countryId: 142, flag: '\u{1F1F8}\u{1F1F7}' },
    { name: 'Guatemala', code: '+502', price: 28, countryId: 94, flag: '\u{1F1EC}\u{1F1F9}' },
    { name: 'Madagascar', code: '+261', price: 25, countryId: 17, flag: '\u{1F1F2}\u{1F1EC}' },
    { name: 'Antigua and Barbuda', code: '+1', price: 29, countryId: 169, flag: '\u{1F1E6}\u{1F1EC}' },
    { name: 'Djibouti', code: '+253', price: 24, countryId: 168, flag: '\u{1F1E9}\u{1F1EF}' },
    { name: 'French Guiana', code: '+594', price: 27, countryId: 162, flag: '\u{1F1EC}\u{1F1EB}' },
    { name: 'Saint Lucia', code: '+1', price: 30, countryId: 164, flag: '\u{1F1F1}\u{1F1E8}' },
    { name: 'Montenegro', code: '+382', price: 26, countryId: 171, flag: '\u{1F1F2}\u{1F1EA}' },
    { name: 'Cuba', code: '+53', price: 28, countryId: 113, flag: '\u{1F1E8}\u{1F1FA}' },
    { name: 'Greece', code: '+30', price: 25, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Chile', code: '+56', price: 29, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Georgia', code: '+995', price: 24, countryId: 128, flag: '\u{1F1EC}\u{1F1EA}' },
    { name: 'Sierra Leone', code: '+232', price: 27, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' },
    { name: 'Bolivia', code: '+591', price: 30, countryId: 92, flag: '\u{1F1E7}\u{1F1F4}' },
    { name: 'Grenada', code: '+1', price: 26, countryId: 127, flag: '\u{1F1EC}\u{1F1E9}' },
    { name: 'Latvia', code: '+371', price: 28, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Tajikistan', code: '+992', price: 25, countryId: 143, flag: '\u{1F1F9}\u{1F1EF}' },
    { name: 'Brunei Darussalam', code: '+673', price: 29, countryId: 121, flag: '\u{1F1E7}\u{1F1F3}' },
    { name: 'Cayman Islands', code: '+1', price: 24, countryId: 170, flag: '\u{1F1F0}\u{1F1FE}' },
    { name: 'Saint Vincent', code: '+1', price: 27, countryId: 166, flag: '\u{1F1FB}\u{1F1E8}' },
    { name: 'Albania', code: '+355', price: 30, countryId: 155, flag: '\u{1F1E6}\u{1F1F1}' },
    { name: 'Slovenia', code: '+386', price: 26, countryId: 59, flag: '\u{1F1F8}\u{1F1EE}' },
    { name: 'Hong Kong', code: '+852', price: 120, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Saint Kitts and Nevis', code: '+1', price: 28, countryId: 134, flag: '\u{1F1F0}\u{1F1F3}' },
    { name: 'CAF', code: '+236', price: 25, countryId: 125, flag: '\u{1F1E8}\u{1F1EB}' },
    { name: 'Liberia', code: '+231', price: 29, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Guinea', code: '+224', price: 24, countryId: 68, flag: '\u{1F1EC}\u{1F1F3}' },
    { name: 'Aruba', code: '+297', price: 60, countryId: 179, flag: '\u{1F1E6}\u{1F1FC}' },
    { name: 'Comoros', code: '+269', price: 27, countryId: 133, flag: '\u{1F1F0}\u{1F1F2}' },
    { name: 'Malta', code: '+356', price: 90, countryId: 199, flag: '\u{1F1F2}\u{1F1F9}' },
    { name: 'Singapore', code: '+65', price: 120, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
    { name: 'Slovakia', code: '+421', price: 26, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'Anguilla', code: '+1', price: 90, countryId: 181, flag: '\u{1F1E6}\u{1F1EE}' },
    { name: 'Sao Tome and Principe', code: '+239', price: 28, countryId: 178, flag: '\u{1F1F8}\u{1F1F9}' },
    { name: 'Fiji', code: '+679', price: 120, countryId: 189, flag: '\u{1F1EB}\u{1F1EF}' },
    { name: 'Croatia', code: '+385', price: 25, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'Cape Verde', code: '+238', price: 29, countryId: 186, flag: '\u{1F1E8}\u{1F1FB}' },
    { name: 'Monaco', code: '+377', price: 100, countryId: 144, flag: '\u{1F1F2}\u{1F1E8}' },
    { name: 'North Macedonia', code: '+389', price: 24, countryId: 183, flag: '\u{1F1F2}\u{1F1F0}' },
    { name: 'Belize', code: '+501', price: 27, countryId: 124, flag: '\u{1F1E7}\u{1F1FF}' },
    { name: 'New Caledonia', code: '+687', price: 200, countryId: 185, flag: '\u{1F1F3}\u{1F1E8}' },
    { name: 'New Zealand', code: '+64', price: 26, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Lebanon', code: '+961', price: 28, countryId: 153, flag: '\u{1F1F1}\u{1F1E7}' },
    { name: 'Denmark', code: '+45', price: 25, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Seychelles', code: '+248', price: 29, countryId: 184, flag: '\u{1F1F8}\u{1F1E8}' },
    { name: 'Montserrat', code: '+1', price: 24, countryId: 180, flag: '\u{1F1F2}\u{1F1F8}' },
    { name: 'Dominica', code: '+1', price: 27, countryId: 126, flag: '\u{1F1E9}\u{1F1F2}' },
    { name: 'Macau', code: '+853', price: 40, countryId: 20, flag: '\u{1F1F2}\u{1F1F4}' },
    { name: 'Iceland', code: '+354', price: 40, countryId: 132, flag: '\u{1F1EE}\u{1F1F8}' },
    { name: 'Eritrea', code: '+291', price: 40, countryId: 176, flag: '\u{1F1EA}\u{1F1F7}' }
];
const tinderCountries = [
    { name: 'USA', code: '', price: 70, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Colombia', code: '', price: 9, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'France', code: '', price: 60, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Italy', code: '', price: 40, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Spain', code: '', price: 70, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Turkey', code: '', price: 60, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Germany', code: '', price: 60, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'India', code: '', price: 60, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Greece', code: '', price: 60, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Ukraine', code: '', price: 20, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Brazil', code: '', price: 8, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Portugal', code: '', price: 70, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Poland', code: '', price: 40, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Switzerland', code: '', price: 60, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Argentina', code: '', price: 60, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'South Africa', code: '', price: 10, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'United Kingdom', code: '', price: 10, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Netherlands', code: '', price: 40, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Vietnam', code: '', price: 20, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Madagascar', code: '', price: 20, countryId: 17, flag: '\u{1F1F2}\u{1F1EC}' },
    { name: 'Estonia', code: '', price: 40, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Philippines', code: '', price: 20, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Malawi', code: '', price: 60, countryId: 137, flag: '\u{1F1F2}\u{1F1FC}' },
    { name: 'Croatia', code: '', price: 60, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'Nigeria', code: '', price: 40, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Saudi Arabia', code: '', price: 70, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Hungary', code: '', price: 60, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'Lithuania', code: '', price: 60, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'Yemen', code: '', price: 60, countryId: 30, flag: '\u{1F1FE}\u{1F1EA}' },
    { name: 'Austria', code: '', price: 60, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Mozambique', code: '', price: 10, countryId: 80, flag: '\u{1F1F2}\u{1F1FF}' },
    { name: 'Slovakia', code: '', price: 66, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'Ireland', code: '', price: 60, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Angola', code: '', price: 60, countryId: 76, flag: '\u{1F1E6}\u{1F1F4}' },
    { name: 'Peru', code: '', price: 60, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Thailand', code: '', price: 20, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Indonesia', code: '', price: 10, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Botswana', code: '', price: 70, countryId: 123, flag: '\u{1F1E7}\u{1F1FC}' },
    { name: 'Sweden', code: '', price: 60, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Latvia', code: '', price: 60, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Belgium', code: '', price: 60, countryId: 82, flag: '\u{1F1E7}\u{1F1EA}' },
    { name: 'Cyprus', code: '', price: 60, countryId: 77, flag: '\u{1F1E8}\u{1F1FE}' },
    { name: 'Kenya', code: '', price: 40, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Norway', code: '', price: 60, countryId: 174, flag: '\u{1F1F3}\u{1F1F4}' },
    { name: 'Chile', code: '', price: 19, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Georgia', code: '', price: 60, countryId: 128, flag: '\u{1F1EC}\u{1F1EA}' },
    { name: 'Libya', code: '', price: 10, countryId: 102, flag: '\u{1F1F1}\u{1F1FE}' },
    { name: 'Egypt', code: '', price: 30, countryId: 21, flag: '\u{1F1EA}\u{1F1EC}' },
    { name: 'Liberia', code: '', price: 28, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Romania', code: '', price: 40, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Kazakhstan', code: '', price: 40, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Australia', code: '', price: 60, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'Ghana', code: '', price: 30, countryId: 38, flag: '\u{1F1EC}\u{1F1ED}' },
    { name: 'UAE', code: '', price: 20, countryId: 95, flag: '\u{1F1E6}\u{1F1EA}' },
    { name: 'Albania', code: '', price: 100, countryId: 155, flag: '\u{1F1E6}\u{1F1F1}' },
    { name: 'Bosnia and Herzegovina', code: '', price: 60, countryId: 108, flag: '\u{1F1E7}\u{1F1E6}' },
    { name: 'Macedonia', code: '', price: 60, countryId: 183, flag: '\u{1F1F2}\u{1F1F0}' },
    { name: 'Bulgaria', code: '', price: 60, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Bahrain', code: '', price: 200, countryId: 145, flag: '\u{1F1E7}\u{1F1ED}' },
    { name: 'Serbia', code: '', price: 60, countryId: 29, flag: '\u{1F1F7}\u{1F1F8}' },
    { name: 'Costa Rica', code: '', price: 200, countryId: 93, flag: '\u{1F1E8}\u{1F1F7}' },
    { name: 'Nepal', code: '', price: 60, countryId: 81, flag: '\u{1F1F3}\u{1F1F5}' },
    { name: 'Niger', code: '', price: 14, countryId: 139, flag: '\u{1F1F3}\u{1F1EA}' },
    { name: 'Trinidad and Tobago', code: '', price: 60, countryId: 104, flag: '\u{1F1F9}\u{1F1F9}' },
    { name: 'Laos', code: '', price: 30, countryId: 25, flag: '\u{1F1F1}\u{1F1E6}' },
    { name: 'Canada', code: '', price: 40, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Finland', code: '', price: 60, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'Taiwan', code: '', price: 60, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
    { name: 'Papua New Guinea', code: '', price: 60, countryId: 79, flag: '\u{1F1F5}\u{1F1EC}' },
    { name: 'Hong Kong', code: '', price: 60, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Mexico', code: '', price: 60, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Bangladesh', code: '', price: 40, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'USA Virtual', code: '', price: 9, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Singapore', code: '', price: 10, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
    { name: 'Malaysia', code: '', price: 40, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Mauritania', code: '', price: 60, countryId: 114, flag: '\u{1F1F2}\u{1F1F7}' },
    { name: 'Tanzania', code: '', price: 60, countryId: 9, flag: '\u{1F1F9}\u{1F1FF}' },
    { name: 'Togo', code: '', price: 60, countryId: 99, flag: '\u{1F1F9}\u{1F1EC}' },
    { name: 'Moldova', code: '', price: 60, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Belarus', code: '', price: 200, countryId: 51, flag: '\u{1F1E7}\u{1F1FE}' },
    { name: 'Namibia', code: '', price: 14, countryId: 138, flag: '\u{1F1F3}\u{1F1E6}' },
    { name: 'Jamaica', code: '', price: 30, countryId: 103, flag: '\u{1F1EF}\u{1F1F2}' },
    { name: 'Cambodia', code: '', price: 30, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' },
    { name: 'Cameroon', code: '', price: 14, countryId: 41, flag: '\u{1F1E8}\u{1F1F2}' },
    { name: 'Chad', code: '', price: 60, countryId: 42, flag: '\u{1F1F9}\u{1F1E9}' },
    { name: 'Mali', code: '', price: 18, countryId: 69, flag: '\u{1F1F2}\u{1F1F1}' },
    { name: 'Azerbaijan', code: '', price: 60, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Sao Tome and Principe', code: '', price: 90, countryId: 178, flag: '\u{1F1F8}\u{1F1F9}' },
    { name: 'Slovenia', code: '', price: 30, countryId: 59, flag: '\u{1F1F8}\u{1F1EE}' },
    { name: 'Senegal', code: '', price: 19, countryId: 61, flag: '\u{1F1F8}\u{1F1F3}' },
    { name: 'Macau', code: '', price: 20, countryId: 20, flag: '\u{1F1F2}\u{1F1F4}' }
];
const twitterCountries = [
    { name: 'Brazil', code: '', price: 9, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'United Kingdom', code: '', price: 10, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'USA', code: '', price: 40, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Croatia', code: '', price: 30, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'USA Virtual', code: '', price: 20, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Germany', code: '', price: 14, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Romania', code: '', price: 30, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Malaysia', code: '', price: 30, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Bangladesh', code: '', price: 40, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'Netherlands', code: '', price: 14, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Libya', code: '', price: 20, countryId: 102, flag: '\u{1F1F1}\u{1F1FE}' },
    { name: 'Latvia', code: '', price: 10, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Saudi Arabia', code: '', price: 30, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Taiwan', code: '', price: 70, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
    { name: 'South Africa', code: '', price: 20, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Philippines', code: '', price: 20, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Spain', code: '', price: 20, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Tajikistan', code: '', price: 40, countryId: 143, flag: '\u{1F1F9}\u{1F1EF}' },
    { name: 'Indonesia', code: '', price: 7, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Canada', code: '', price: 10, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Ukraine', code: '', price: 20, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'India', code: '', price: 60, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Pakistan', code: '', price: 70, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' }
];
const amazonCountries = [
    { name: 'Colombia', code: '+57', price: 19, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Brazil', code: '+55', price: 17, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'USA Virtual', code: '+1', price: 20, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Canada', code: '+1', price: 30, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Saudi Arabia', code: '+966', price: 40, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'United Kingdom', code: '+44', price: 30, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'USA', code: '+1', price: 30, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'South Africa', code: '+27', price: 30, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Thailand', code: '+66', price: 20, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'India', code: '+91', price: 60, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Italy', code: '+39', price: 40, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'France', code: '+33', price: 40, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Spain', code: '+34', price: 30, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'UAE', code: '+971', price: 80, countryId: 95, flag: '\u{1F1E6}\u{1F1EA}' },
    { name: 'Indonesia', code: '+62', price: 8, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Pakistan', code: '+92', price: 40, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' }
];
const alibabaCountries = [
    { name: 'Indonesia', code: '+62', price: 9, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Pakistan', code: '+92', price: 8.37, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'France', code: '+33', price: 6.55, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Turkey', code: '+90', price: 42.22, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Hungary', code: '+36', price: 42.22, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'Italy', code: '+39', price: 42.22, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Saudi Arabia', code: '+966', price: 25.48, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Guatemala', code: '+502', price: 42.22, countryId: 94, flag: '\u{1F1EC}\u{1F1F9}' },
    { name: 'Finland', code: '+358', price: 42.22, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'USA', code: '+1', price: 37.86, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Botswana', code: '+267', price: 42.22, countryId: 123, flag: '\u{1F1E7}\u{1F1FC}' },
    { name: 'Bangladesh', code: '+880', price: 42.22, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'Costa Rica', code: '+506', price: 42.22, countryId: 93, flag: '\u{1F1E8}\u{1F1F7}' },
    { name: 'Hong Kong', code: '+852', price: 42.22, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Sierra Leone', code: '+232', price: 42.22, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' },
    { name: 'Mongolia', code: '+976', price: 42.22, countryId: 72, flag: '\u{1F1F2}\u{1F1F3}' },
    { name: 'Canada', code: '+1', price: 18.56, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Czech Republic', code: '+420', price: 40.77, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Mexico', code: '+52', price: 42.22, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Madagascar', code: '+261', price: 42.22, countryId: 17, flag: '\u{1F1F2}\u{1F1EC}' },
    { name: 'Cambodia', code: '+855', price: 42.22, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' },
    { name: 'Taiwan', code: '+886', price: 42.22, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
    { name: 'Spain', code: '+34', price: 40.04, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Portugal', code: '+351', price: 42.22, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Niger', code: '+227', price: 42.22, countryId: 139, flag: '\u{1F1F3}\u{1F1EA}' },
    { name: 'Austria', code: '+43', price: 42.22, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Myanmar', code: '+95', price: 42.22, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'United Kingdom', code: '+44', price: 42.22, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Dominican Republic', code: '+1', price: 42.22, countryId: 109, flag: '\u{1F1E9}\u{1F1F4}' },
    { name: 'Congo (Dem. Republic)', code: '+243', price: 42.22, countryId: 18, flag: '\u{1F1E8}\u{1F1E9}' },
    { name: 'Norway', code: '+47', price: 42.22, countryId: 174, flag: '\u{1F1F3}\u{1F1F4}' },
    { name: 'India', code: '+91', price: 42.22, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Zambia', code: '+260', price: 42.22, countryId: 147, flag: '\u{1F1FF}\u{1F1F2}' },
    { name: 'Algeria', code: '+213', price: 42.22, countryId: 58, flag: '\u{1F1E9}\u{1F1FF}' },
    { name: 'Ethiopia', code: '+251', price: 42.22, countryId: 71, flag: '\u{1F1EA}\u{1F1F9}' },
    { name: 'Papua new gvineya', code: '+675', price: 42.22, countryId: 79, flag: '\u{1F1F5}\u{1F1EC}' }
];
const careemCountries = [
    { name: 'Austria', code: '+43', price: 114.07, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Bangladesh', code: '+880', price: 49.78, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'Brazil', code: '+55', price: 1.57, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Canada', code: '+1', price: 27.83, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Colombia', code: '+57', price: 83.10, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Czech Republic', code: '+420', price: 33.71, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Egypt', code: '+20', price: 74.87, countryId: 21, flag: '\u{1F1EA}\u{1F1EC}' },
    { name: 'El Salvador', code: '+503', price: 98.78, countryId: 101, flag: '\u{1F1F8}\u{1F1FB}' },
    { name: 'Germany', code: '+49', price: 54.49, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Ghana', code: '+233', price: 35.28, countryId: 38, flag: '\u{1F1EC}\u{1F1ED}' },
    { name: 'Haiti', code: '+509', price: 150.53, countryId: 26, flag: '\u{1F1ED}\u{1F1F9}' },
    { name: 'Hungary', code: '+36', price: 275.18, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'India', code: '+91', price: 10.58, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Indonesia', code: '+62', price: 13.72, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Iran', code: '+98', price: 112.90, countryId: 57, flag: '\u{1F1EE}\u{1F1F7}' },
    { name: 'Jamaica', code: '+1', price: 98.78, countryId: 103, flag: '\u{1F1EF}\u{1F1F2}' },
    { name: 'Kazakhstan', code: '+7', price: 43.12, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Kenya', code: '+254', price: 4.31, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Malawi', code: '+265', price: 49.78, countryId: 137, flag: '\u{1F1F2}\u{1F1FC}' },
    { name: 'Malaysia', code: '+60', price: 75.26, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Morocco', code: '+212', price: 65.46, countryId: 37, flag: '\u{1F1F2}\u{1F1E6}' },
    { name: 'Nepal', code: '+977', price: 59.58, countryId: 81, flag: '\u{1F1F3}\u{1F1F5}' },
    { name: 'Nigeria', code: '+234', price: 44.69, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Pakistan', code: '+92', price: 59.58, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Panama', code: '+507', price: 98.78, countryId: 112, flag: '\u{1F1F5}\u{1F1E6}' },
    { name: 'Paraguay', code: '+595', price: 98.78, countryId: 87, flag: '\u{1F1F5}\u{1F1FE}' },
    { name: 'Peru', code: '+51', price: 59.58, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Philippines', code: '+63', price: 3.14, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Saudi Arabia', code: '+966', price: 87.42, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Singapore', code: '+65', price: 157.58, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
    { name: 'South Africa', code: '+27', price: 1.57, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Spain', code: '+34', price: 51.74, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Uganda', code: '+256', price: 74.87, countryId: 75, flag: '\u{1F1FA}\u{1F1EC}' },
    { name: 'Ukraine', code: '+380', price: 38.81, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'United Kingdom', code: '+44', price: 62.72, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'USA', code: '+1', price: 29.40, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Venezuela', code: '+58', price: 77.62, countryId: 70, flag: '\u{1F1FB}\u{1F1EA}' },
    { name: 'Zambia', code: '+260', price: 59.58, countryId: 147, flag: '\u{1F1FF}\u{1F1F2}' },
    { name: 'Zimbabwe', code: '+263', price: 98.78, countryId: 96, flag: '\u{1F1FF}\u{1F1FC}' }
];
const noonCountries = [
    { name: 'Saudi Arabia', code: '+966', price: 170, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' }
];
const spotifyCountries = [
    { name: 'USA', code: '+1', price: 160, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];
const openaiCountries = [
    { name: 'Afghanistan', code: '', price: 38.81, countryId: 74, flag: '\u{1F1E6}\u{1F1EB}' },
    { name: 'Algeria', code: '', price: 123.87, countryId: 58, flag: '\u{1F1E9}\u{1F1FF}' },
    { name: 'Argentina', code: '', price: 1.57, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Azerbaijan', code: '', price: 123.87, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Belgium', code: '', price: 2.35, countryId: 82, flag: '\u{1F1E7}\u{1F1EA}' },
    { name: 'Brazil', code: '', price: 1.57, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Burundi', code: '', price: 123.87, countryId: 119, flag: '\u{1F1E7}\u{1F1EE}' },
    { name: 'Canada', code: '', price: 13.33, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Chile', code: '', price: 2.35, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Ecuador', code: '', price: 123.87, countryId: 105, flag: '\u{1F1EA}\u{1F1E8}' },
    { name: 'Finland', code: '', price: 264.99, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'France', code: '', price: 2.35, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Germany', code: '', price: 3.92, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Hong Kong', code: '', price: 2.35, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Hungary', code: '', price: 281.46, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'India', code: '', price: 26.26, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Indonesia', code: '', price: 3.92, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Italy', code: '', price: 52.53, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Latvia', code: '', price: 42.34, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Mexico', code: '', price: 88.59, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Myanmar', code: '', price: 78.40, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'Netherlands', code: '', price: 2.35, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Norway', code: '', price: 264.99, countryId: 174, flag: '\u{1F1F3}\u{1F1F4}' },
    { name: 'Pakistan', code: '', price: 106.23, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Peru', code: '', price: 88.59, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Poland', code: '', price: 10.58, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Portugal', code: '', price: 2.35, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Saudi Arabia', code: '', price: 92.51, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Singapore', code: '', price: 2.35, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
    { name: 'South Africa', code: '', price: 1.57, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Spain', code: '', price: 3.14, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Sweden', code: '', price: 10.58, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Taiwan', code: '', price: 353.58, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
    { name: 'Tajikistan', code: '', price: 196.78, countryId: 143, flag: '\u{1F1F9}\u{1F1EF}' },
    { name: 'Thailand', code: '', price: 2.35, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Turkey', code: '', price: 123.87, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'UAE', code: '', price: 194.43, countryId: 95, flag: '\u{1F1E6}\u{1F1EA}' },
    { name: 'Ukraine', code: '', price: 4.31, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'United Kingdom', code: '', price: 15.29, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'USA', code: '', price: 41.94, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'USA Virtual', code: '', price: 1.57, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Vietnam', code: '', price: 2.35, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' }
];
const paypalCountries = [
    { name: 'Iran', code: '', price: 2.35, countryId: 57, flag: '\u{1F1EE}\u{1F1F7}' },
    { name: 'Serbia', code: '', price: 196.78, countryId: 29, flag: '\u{1F1F7}\u{1F1F8}' },
    { name: 'Turkey', code: '', price: 196.78, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Azerbaijan', code: '', price: 278.71, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Nigeria', code: '', price: 1.57, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Uruguay', code: '', price: 245.78, countryId: 156, flag: '\u{1F1FA}\u{1F1FE}' },
    { name: 'Belarus', code: '', price: 196.78, countryId: 51, flag: '\u{1F1E7}\u{1F1FE}' },
    { name: 'Honduras', code: '', price: 196.78, countryId: 88, flag: '\u{1F1ED}\u{1F1F3}' },
    { name: 'Georgia', code: '', price: 161.11, countryId: 128, flag: '\u{1F1EC}\u{1F1EA}' },
    { name: 'Malaysia', code: '', price: 88.59, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Mongolia', code: '', price: 2.35, countryId: 72, flag: '\u{1F1F2}\u{1F1F3}' },
    { name: 'Algeria', code: '', price: 54.49, countryId: 58, flag: '\u{1F1E9}\u{1F1FF}' },
    { name: 'Egypt', code: '', price: 1.57, countryId: 21, flag: '\u{1F1EA}\u{1F1EC}' },
    { name: 'New Zealand', code: '', price: 896.90, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Botswana', code: '', price: 2.35, countryId: 123, flag: '\u{1F1E7}\u{1F1FC}' },
    { name: 'Pakistan', code: '', price: 2.35, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Bahrain', code: '', price: 174.83, countryId: 145, flag: '\u{1F1E7}\u{1F1ED}' },
    { name: 'Saudi Arabia', code: '', price: 60.37, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Cuba', code: '', price: 2.35, countryId: 113, flag: '\u{1F1E8}\u{1F1FA}' },
    { name: 'Kazakhstan', code: '', price: 27.44, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Bosnia and Herzegovina', code: '', price: 196.78, countryId: 108, flag: '\u{1F1E7}\u{1F1E6}' },
    { name: 'Venezuela', code: '', price: 7.06, countryId: 70, flag: '\u{1F1FB}\u{1F1EA}' },
    { name: 'Tajikistan', code: '', price: 29.79, countryId: 143, flag: '\u{1F1F9}\u{1F1EF}' },
    { name: 'Estonia', code: '', price: 122.30, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Slovenia', code: '', price: 4.31, countryId: 59, flag: '\u{1F1F8}\u{1F1EE}' },
    { name: 'Japan', code: '', price: 4043.87, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'Mexico', code: '', price: 91.73, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Taiwan', code: '', price: 212.46, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
    { name: 'Hong Kong', code: '', price: 5.49, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Vietnam', code: '', price: 16.86, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Qatar', code: '', price: 174.83, countryId: 111, flag: '\u{1F1F6}\u{1F1E6}' },
    { name: 'India', code: '', price: 1.57, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Guyana', code: '', price: 196.78, countryId: 131, flag: '\u{1F1EC}\u{1F1FE}' },
    { name: 'Norway', code: '', price: 276.36, countryId: 174, flag: '\u{1F1F3}\u{1F1F4}' },
    { name: 'Cameroon', code: '', price: 2.35, countryId: 41, flag: '\u{1F1E8}\u{1F1F2}' },
    { name: 'Macedonia', code: '', price: 161.11, countryId: 183, flag: '\u{1F1F2}\u{1F1F0}' },
    { name: 'Argentina', code: '', price: 10.58, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Lithuania', code: '', price: 473.54, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'Czech Republic', code: '', price: 120.34, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Ireland', code: '', price: 264.99, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Bulgaria', code: '', price: 81.14, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Austria', code: '', price: 158.37, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Poland', code: '', price: 4.70, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Italy', code: '', price: 73.30, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Canada', code: '', price: 53.31, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Netherlands', code: '', price: 73.30, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Brazil', code: '', price: 1.57, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Indonesia', code: '', price: 2.35, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Singapore', code: '', price: 152.88, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
    { name: 'Spain', code: '', price: 152.88, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'UAE', code: '', price: 73.30, countryId: 95, flag: '\u{1F1E6}\u{1F1EA}' },
    { name: 'Romania', code: '', price: 73.30, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Chile', code: '', price: 1.57, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Belgium', code: '', price: 73.30, countryId: 82, flag: '\u{1F1E7}\u{1F1EA}' },
    { name: 'Thailand', code: '', price: 5.49, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Hungary', code: '', price: 73.30, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'Sweden', code: '', price: 102.70, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Bangladesh', code: '', price: 75.26, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'Israel', code: '', price: 152.88, countryId: 13, flag: '\u{1F1EE}\u{1F1F1}' },
    { name: 'Madagascar', code: '', price: 2.35, countryId: 17, flag: '\u{1F1F2}\u{1F1EC}' },
    { name: 'Ecuador', code: '', price: 73.30, countryId: 105, flag: '\u{1F1EA}\u{1F1E8}' }
];
const aliexpressCountries = [
    { name: 'Gibraltar', code: '+350', price: 400, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];
const wechatCountries = [
    { name: 'Tanzania', code: '', price: 176.79, countryId: 9, flag: '\u{1F1F9}\u{1F1FF}' },
    { name: 'Sri Lanka', code: '', price: 143.47, countryId: 64, flag: '\u{1F1F1}\u{1F1F0}' },
    { name: 'Honduras', code: '', price: 473.54, countryId: 88, flag: '\u{1F1ED}\u{1F1F3}' },
    { name: 'Tunisia', code: '', price: 306.54, countryId: 89, flag: '\u{1F1F9}\u{1F1F3}' },
    { name: 'India', code: '', price: 44.69, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Pakistan', code: '', price: 278.32, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Zambia', code: '', price: 2.35, countryId: 147, flag: '\u{1F1FF}\u{1F1F2}' },
    { name: 'Namibia', code: '', price: 276.75, countryId: 138, flag: '\u{1F1F3}\u{1F1E6}' },
    { name: 'Papua New Guinea', code: '', price: 145.04, countryId: 79, flag: '\u{1F1F5}\u{1F1EC}' },
    { name: 'Cyprus', code: '', price: 98.78, countryId: 77, flag: '\u{1F1E8}\u{1F1FE}' },
    { name: 'Bulgaria', code: '', price: 180.32, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Nigeria', code: '', price: 121.52, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Cameroon', code: '', price: 6.27, countryId: 41, flag: '\u{1F1E8}\u{1F1F2}' },
    { name: 'Malawi', code: '', price: 2.35, countryId: 137, flag: '\u{1F1F2}\u{1F1FC}' },
    { name: 'Laos', code: '', price: 77.62, countryId: 25, flag: '\u{1F1F1}\u{1F1E6}' },
    { name: 'Malaysia', code: '', price: 90.55, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Turkey', code: '', price: 367.70, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Kazakhstan', code: '', price: 32.54, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'South Africa', code: '', price: 1.57, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Germany', code: '', price: 3.14, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Philippines', code: '', price: 3.14, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Myanmar', code: '', price: 152.88, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'Yemen', code: '', price: 52.53, countryId: 30, flag: '\u{1F1FE}\u{1F1EA}' },
    { name: 'Netherlands', code: '', price: 5.88, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Austria', code: '', price: 188.94, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'United Kingdom', code: '', price: 5.49, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Latvia', code: '', price: 101.53, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Romania', code: '', price: 36.46, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Kenya', code: '', price: 2.35, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Thailand', code: '', price: 26.26, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Finland', code: '', price: 392.78, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'Peru', code: '', price: 196.78, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Cambodia', code: '', price: 151.70, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' },
    { name: 'Australia', code: '', price: 142.30, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'Greece', code: '', price: 60.37, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Ivory Coast', code: '', price: 87.42, countryId: 27, flag: '\u{1F1E8}\u{1F1EE}' },
    { name: 'Hong Kong', code: '', price: 203.45, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Ukraine', code: '', price: 18.03, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Portugal', code: '', price: 41.55, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Indonesia', code: '', price: 1.57, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Vietnam', code: '', price: 56.06, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Argentina', code: '', price: 58.02, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'USA Virtual', code: '', price: 46.65, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'USA', code: '', price: 36.85, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Italy', code: '', price: 35.67, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Poland', code: '', price: 3.14, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'France', code: '', price: 35.67, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Spain', code: '', price: 48.22, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Brazil', code: '', price: 1.57, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Colombia', code: '', price: 4.70, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Canada', code: '', price: 15.68, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Saudi Arabia', code: '', price: 52.53, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Chile', code: '', price: 14.90, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' }
];
const viberCountries = [
    { name: 'Guinea-Bissau', code: '', price: 32.93, countryId: 130, flag: '\u{1F1EC}\u{1F1FC}' },
    { name: 'Portugal', code: '', price: 10.00, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Somalia', code: '', price: 23.52, countryId: 149, flag: '\u{1F1F8}\u{1F1F4}' },
    { name: 'Barbados', code: '', price: 10.00, countryId: 118, flag: '\u{1F1E7}\u{1F1E7}' },
    { name: 'Zimbabwe', code: '', price: 27.44, countryId: 96, flag: '\u{1F1FF}\u{1F1FC}' },
    { name: 'Nepal', code: '', price: 45.47, countryId: 81, flag: '\u{1F1F3}\u{1F1F5}' },
    { name: 'Nigeria', code: '', price: 29.01, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Swaziland', code: '', price: 24.30, countryId: 106, flag: '\u{1F1F8}\u{1F1FF}' },
    { name: 'Maldives', code: '', price: 45.47, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Bangladesh', code: '', price: 25.09, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'Zambia', code: '', price: 26.66, countryId: 147, flag: '\u{1F1FF}\u{1F1F2}' },
    { name: 'Namibia', code: '', price: 21.95, countryId: 138, flag: '\u{1F1F3}\u{1F1E6}' },
    { name: 'Argentina', code: '', price: 10.00, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'India', code: '', price: 25.87, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Tanzania', code: '', price: 41.55, countryId: 9, flag: '\u{1F1F9}\u{1F1FF}' },
    { name: 'Australia', code: '', price: 10.00, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'Cambodia', code: '', price: 26.26, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' },
    { name: 'Azerbaijan', code: '', price: 45.47, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Finland', code: '', price: 45.47, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'Serbia', code: '', price: 45.47, countryId: 29, flag: '\u{1F1F7}\u{1F1F8}' },
    { name: 'Mexico', code: '', price: 45.47, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Malaysia', code: '', price: 10.00, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Austria', code: '', price: 45.47, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Kazakhstan', code: '', price: 10.00, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'USA Virtual', code: '', price: 10.00, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Estonia', code: '', price: 26.26, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Turkey', code: '', price: 45.47, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Uzbekistan', code: '', price: 45.47, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    { name: 'Canada', code: '', price: 12.15, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Kenya', code: '', price: 10.00, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Pakistan', code: '', price: 45.47, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'UAE', code: '', price: 45.47, countryId: 95, flag: '\u{1F1E6}\u{1F1EA}' },
    { name: 'Croatia', code: '', price: 20.38, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'Peru', code: '', price: 39.98, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Poland', code: '', price: 10.00, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Saudi Arabia', code: '', price: 32.93, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Bosnia and Herzegovina', code: '', price: 45.47, countryId: 108, flag: '\u{1F1E7}\u{1F1E6}' },
    { name: 'Bulgaria', code: '', price: 45.47, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Armenia', code: '', price: 45.47, countryId: 148, flag: '\u{1F1E6}\u{1F1F2}' },
    { name: 'Taiwan', code: '', price: 45.47, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
    { name: 'Hong Kong', code: '', price: 10.00, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Colombia', code: '', price: 10.00, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Philippines', code: '', price: 10.00, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Ethiopia', code: '', price: 30.97, countryId: 71, flag: '\u{1F1EA}\u{1F1F9}' },
    { name: 'South Africa', code: '', price: 10.00, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Ukraine', code: '', price: 31.36, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'USA', code: '', price: 24.70, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Italy', code: '', price: 45.47, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Indonesia', code: '', price: 10.00, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Algeria', code: '', price: 21.17, countryId: 58, flag: '\u{1F1E9}\u{1F1FF}' },
    { name: 'United Kingdom', code: '', price: 22.74, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Germany', code: '', price: 10.00, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Vietnam', code: '', price: 18.03, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Spain', code: '', price: 10.00, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Myanmar', code: '', price: 18.42, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'Brazil', code: '', price: 10.00, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' }
];
const uberCountries = [
    { name: 'Afghanistan', code: '', price: 30.58, countryId: 74, flag: '\u{1F1E6}\u{1F1EB}' },
    { name: 'Argentina', code: '', price: 10, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Aruba', code: '', price: 10, countryId: 179, flag: '\u{1F1E6}\u{1F1FC}' },
    { name: 'Australia', code: '', price: 46.26, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'Azerbaijan', code: '', price: 150.53, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Bangladesh', code: '', price: 10, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'Botswana', code: '', price: 10, countryId: 123, flag: '\u{1F1E7}\u{1F1FC}' },
    { name: 'Brazil', code: '', price: 10, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Bulgaria', code: '', price: 35.67, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Canada', code: '', price: 10, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Chile', code: '', price: 10, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'China', code: '', price: 115.25, countryId: 3, flag: '\u{1F1E8}\u{1F1F3}' },
    { name: 'Colombia', code: '', price: 10, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Comoros', code: '', price: 10, countryId: 133, flag: '\u{1F1F0}\u{1F1F2}' },
    { name: "Cote d'Ivoire", code: '', price: 10, countryId: 27, flag: '\u{1F1E8}\u{1F1EE}' },
    { name: 'Cyprus', code: '', price: 10, countryId: 77, flag: '\u{1F1E8}\u{1F1FE}' },
    { name: 'Egypt', code: '', price: 41.94, countryId: 21, flag: '\u{1F1EA}\u{1F1EC}' },
    { name: 'Finland', code: '', price: 36.85, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'France', code: '', price: 38.42, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Germany', code: '', price: 10, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Guadeloupe', code: '', price: 36.85, countryId: 160, flag: '\u{1F1EC}\u{1F1F5}' },
    { name: 'Guinea-Bissau', code: '', price: 36.85, countryId: 130, flag: '\u{1F1EC}\u{1F1FC}' },
    { name: 'Hong Kong', code: '', price: 10, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Hungary', code: '', price: 218.74, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'India', code: '', price: 36.85, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Indonesia', code: '', price: 10, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Israel', code: '', price: 10, countryId: 13, flag: '\u{1F1EE}\u{1F1F1}' },
    { name: 'Italy', code: '', price: 44.69, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Kazakhstan', code: '', price: 36.85, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Kenya', code: '', price: 10, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Kuwait', code: '', price: 30.58, countryId: 100, flag: '\u{1F1F0}\u{1F1FC}' },
    { name: 'Malaysia', code: '', price: 54.88, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Maldives', code: '', price: 10, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Mali', code: '', price: 10, countryId: 69, flag: '\u{1F1F2}\u{1F1F1}' },
    { name: 'Mauritania', code: '', price: 10, countryId: 114, flag: '\u{1F1F2}\u{1F1F7}' },
    { name: 'Mexico', code: '', price: 36.85, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Mongolia', code: '', price: 10, countryId: 72, flag: '\u{1F1F2}\u{1F1F3}' },
    { name: 'Morocco', code: '', price: 10, countryId: 37, flag: '\u{1F1F2}\u{1F1E6}' },
    { name: 'Nepal', code: '', price: 10, countryId: 81, flag: '\u{1F1F3}\u{1F1F5}' },
    { name: 'Netherlands', code: '', price: 10, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'New Zealand', code: '', price: 36.85, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Nigeria', code: '', price: 36.85, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Norway', code: '', price: 36.85, countryId: 174, flag: '\u{1F1F3}\u{1F1F4}' },
    { name: 'Pakistan', code: '', price: 59.58, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Peru', code: '', price: 36.85, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Philippines', code: '', price: 10, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Poland', code: '', price: 10, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Portugal', code: '', price: 10, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Romania', code: '', price: 10, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Rwanda', code: '', price: 10, countryId: 140, flag: '\u{1F1F7}\u{1F1FC}' },
    { name: 'Saudi Arabia', code: '', price: 29.01, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Singapore', code: '', price: 10, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
    { name: 'South Africa', code: '', price: 10, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'South Sudan', code: '', price: 36.85, countryId: 177, flag: '\u{1F1F8}\u{1F1F8}' },
    { name: 'Spain', code: '', price: 41.94, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Sri Lanka', code: '', price: 10, countryId: 64, flag: '\u{1F1F1}\u{1F1F0}' },
    { name: 'Swaziland', code: '', price: 10, countryId: 106, flag: '\u{1F1F8}\u{1F1FF}' },
    { name: 'Sweden', code: '', price: 10, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Taiwan', code: '', price: 329.28, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
    { name: 'Tanzania', code: '', price: 10, countryId: 9, flag: '\u{1F1F9}\u{1F1FF}' },
    { name: 'Thailand', code: '', price: 10, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Timor-Leste', code: '', price: 10, countryId: 91, flag: '\u{1F1F9}\u{1F1F1}' },
    { name: 'Tunisia', code: '', price: 36.85, countryId: 89, flag: '\u{1F1F9}\u{1F1F3}' },
    { name: 'Turkey', code: '', price: 59.58, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Turkmenistan', code: '', price: 10, countryId: 161, flag: '\u{1F1F9}\u{1F1F2}' },
    { name: 'UAE', code: '', price: 38.81, countryId: 95, flag: '\u{1F1E6}\u{1F1EA}' },
    { name: 'United Kingdom', code: '', price: 10, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'USA', code: '', price: 28.22, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'USA Virtual', code: '', price: 10, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Uzbekistan', code: '', price: 10, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    { name: 'Venezuela', code: '', price: 36.85, countryId: 70, flag: '\u{1F1FB}\u{1F1EA}' },
    { name: 'Vietnam', code: '', price: 24.30, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Zimbabwe', code: '', price: 10, countryId: 96, flag: '\u{1F1FF}\u{1F1FC}' }
];
const microsoftCountries = [
    { name: 'Brazil', code: '+55', price: 9, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'USA Virtual', code: '+1', price: 10, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Chile', code: '+56', price: 20, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'USA', code: '+1', price: 50, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'United Kingdom', code: '+44', price: 30, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Colombia', code: '+57', price: 40, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Netherlands', code: '+31', price: 30, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Finland', code: '+358', price: 80, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'Poland', code: '+48', price: 40, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Switzerland', code: '+41', price: 30, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Portugal', code: '+351', price: 10, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Hong Kong', code: '+852', price: 26, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Canada', code: '+1', price: 29, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Malaysia', code: '+60', price: 40, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Spain', code: '+34', price: 50, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'UAE', code: '+971', price: 70, countryId: 95, flag: '\u{1F1E6}\u{1F1EA}' }
];
const signalCountries = [
    { name: 'USA', code: '+1', price: 40, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Canada', code: '+1', price: 10, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'United Kingdom', code: '+44', price: 18, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Poland', code: '+48', price: 80, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Germany', code: '+49', price: 70, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Colombia', code: '+57', price: 13, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Romania', code: '+40', price: 20, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Brazil', code: '+55', price: 4, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Netherlands', code: '+31', price: 100, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Portugal', code: '+351', price: 19, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Czech Republic', code: '+420', price: 19, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Malaysia', code: '+60', price: 39, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Chile', code: '+56', price: 20, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Spain', code: '+34', price: 40, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Thailand', code: '+66', price: 90, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'France', code: '+33', price: 15, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Sweden', code: '+46', price: 18, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Argentina', code: '+54', price: 20, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Maldives', code: '+960', price: 25, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Vietnam', code: '+84', price: 60, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Georgia', code: '+995', price: 20, countryId: 128, flag: '\u{1F1EC}\u{1F1EA}' },
    { name: 'Philippines', code: '+63', price: 9, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'India', code: '+91', price: 20, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Kazakhstan', code: '+7', price: 23, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Lithuania', code: '+370', price: 600, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'South Africa', code: '+27', price: 8, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Indonesia', code: '+62', price: 8, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Bulgaria', code: '+359', price: 30, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Estonia', code: '+372', price: 20, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Ukraine', code: '+380', price: 20, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Myanmar', code: '+95', price: 30, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'Kenya', code: '+254', price: 20, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Kyrgyzstan', code: '+996', price: 20, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' },
    { name: 'Moldova', code: '+373', price: 120, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Laos', code: '+856', price: 20, countryId: 25, flag: '\u{1F1F1}\u{1F1E6}' },
    { name: 'Latvia', code: '+371', price: 24, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Tajikistan', code: '+992', price: 220, countryId: 143, flag: '\u{1F1F9}\u{1F1EF}' },
    { name: 'Kosovo', code: '+383', price: 10, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];
const easypayCountries = [
    { name: 'Ukraine', code: '+380', price: 10, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'USA', code: '+1', price: 87, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const smilesCountries = [
    { name: 'Indonesia', code: '+62', price: 100, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const anyotherCountries = [
    { name: 'Indonesia', code: '+62', price: 100, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'United Kingdom', code: '+44', price: 90, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Brazil', code: '+55', price: 70, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Colombia', code: '+57', price: 70, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'France', code: '+33', price: 140, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' }
];

const mercadoCountries = [
    { name: 'Argentina', code: '+54', price: 15.65, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Bolivia', code: '+591', price: 69.52, countryId: 92, flag: '\u{1F1E7}\u{1F1F4}' },
    { name: 'Brazil', code: '+55', price: 2.55, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Chile', code: '+56', price: 4.33, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Colombia', code: '+57', price: 2, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Cuba', code: '+53', price: 69.52, countryId: 113, flag: '\u{1F1E8}\u{1F1FA}' },
    { name: 'Guatemala', code: '+502', price: 89.91, countryId: 94, flag: '\u{1F1EC}\u{1F1F9}' },
    { name: 'Mexico', code: '+52', price: 70.98, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Paraguay', code: '+595', price: 69.52, countryId: 87, flag: '\u{1F1F5}\u{1F1FE}' },
    { name: 'Peru', code: '+51', price: 72.44, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Uruguay', code: '+598', price: 120.12, countryId: 156, flag: '\u{1F1FA}\u{1F1FE}' },
    { name: 'USA', code: '+1', price: 10.92, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const uklonCountries = [
    { name: 'Ukraine', code: '+380', price: 11.28, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'USA', code: '+1', price: 72.8, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const rediffmailCountries = [
    { name: 'India', code: '+91', price: 9.83, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const promCountries = [];

const uwinCountries = [
    { name: 'Malaysia', code: '+60', price: 48.78, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' }
];

const berealCountries = [];

const dotzCountries = [];

const redbusCountries = [
    { name: 'India', code: '+91', price: 17.65, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const pocket52Countries = [];

const gemgalaCountries = [];

const irancellCountries = [];

const bazosCountries = [
    { name: 'France', code: '+33', price: 50.6, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Czech Republic', code: '+420', price: 155.06, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Japan', code: '+81', price: 1073.07, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'Gibraltar', code: '+350', price: 527.44, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const supersCountries = [
    { name: 'Italy', code: '+39', price: 47.68, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' }
];

const dosiCountries = [
    { name: 'France', code: '+33', price: 33.85, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Vietnam', code: '+84', price: 26.21, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Thailand', code: '+66', price: 57.51, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Netherlands', code: '+31', price: 16.74, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Malaysia', code: '+60', price: 48.78, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Philippines', code: '+63', price: 25.48, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' }
];

const monobankindiaCountries = [];

const alfaCountries = [
    { name: 'Pakistan', code: '+92', price: 78.62, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Gibraltar', code: '+350', price: 407.32, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const tradeupCountries = [];

const adaniCountries = [
    { name: 'India', code: '+91', price: 11.65, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const marketguruCountries = [];

const g2gCountries = [
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'USA', code: '+1', price: 26.21, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Philippines', code: '+63', price: 25.84, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'India', code: '+91', price: 2.91, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Ecuador', code: '+593', price: 82.26, countryId: 105, flag: '\u{1F1EA}\u{1F1E8}' },
    { name: 'Turkey', code: '+90', price: 2.91, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'United Kingdom', code: '+44', price: 2.18, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const ys4funCountries = [
    { name: 'Malaysia', code: '+60', price: 212.58, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Hong Kong', code: '+852', price: 104.83, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'USA Virtual', code: '+1', price: 4, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' }
];

const mixmartCountries = [];

const gcashCountries = [];

const lazypayCountries = [];

const citybaseCountries = [];

const rutenCountries = [
    { name: 'Taiwan', code: '+886', price: 131.77, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' }
];

const crefisamaisCountries = [];

const harajCountries = [];

const perfluenceCountries = [];

const wondermartCountries = [
    { name: 'India', code: '+91', price: 11.65, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const glovoCountries = [
    { name: 'Greece', code: '+30', price: 8.74, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Estonia', code: '+372', price: 30.58, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Georgia', code: '+995', price: 11.28, countryId: 128, flag: '\u{1F1EC}\u{1F1EA}' },
    { name: 'Moldova', code: '+373', price: 13.83, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Ukraine', code: '+380', price: 11.28, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' },
    { name: 'Gibraltar', code: '+350', price: 439.71, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const uu163Countries = [
    { name: 'Indonesia', code: '+62', price: 8.37, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Hong Kong', code: '+852', price: 65.88, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' }
];

const galaxywinCountries = [
    { name: 'USA', code: '+1', price: 68.07, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const itiCountries = [];

const proboCountries = [
    { name: 'India', code: '+91', price: 29.85, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Chile', code: '+56', price: 1.46, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' }
];

const alfagiftCountries = [
    { name: 'Indonesia', code: '+62', price: 2.18, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const ininalCountries = [];

const quippCountries = [
    { name: 'Denmark', code: '+45', price: 164.16, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Austria', code: '+43', price: 275.91, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Gibraltar', code: '+350', price: 847.76, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const twilioCountries = [
    { name: 'United Kingdom', code: '+44', price: 3.64, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Malaysia', code: '+60', price: 42.95, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Gibraltar', code: '+350', price: 353.08, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const hqtriviaCountries = [
    { name: 'Kyrgyzstan', code: '+996', price: 34.22, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' },
    { name: 'Azerbaijan', code: '+994', price: 34.22, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'USA', code: '+1', price: 43.32, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Afghanistan', code: '+93', price: 34.22, countryId: 74, flag: '\u{1F1E6}\u{1F1EB}' },
    { name: 'Serbia', code: '+381', price: 34.22, countryId: 29, flag: '\u{1F1F7}\u{1F1F8}' },
    { name: 'Latvia', code: '+371', price: 34.22, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Denmark', code: '+45', price: 34.22, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Austria', code: '+43', price: 34.22, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Cambodia', code: '+855', price: 36.4, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' },
    { name: 'Philippines', code: '+63', price: 34.22, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Spain', code: '+34', price: 34.22, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'India', code: '+91', price: 34.22, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Myanmar', code: '+95', price: 34.22, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'Morocco', code: '+212', price: 34.22, countryId: 37, flag: '\u{1F1F2}\u{1F1E6}' },
    { name: 'Kazakhstan', code: '+7', price: 34.22, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Colombia', code: '+57', price: 34.22, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Tajikistan', code: '+992', price: 50.96, countryId: 143, flag: '\u{1F1F9}\u{1F1EF}' },
    { name: 'Liberia', code: '+231', price: 50.96, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Slovakia', code: '+421', price: 59.7, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'Croatia', code: '+385', price: 20.02, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'Monaco', code: '+377', price: 138.32, countryId: 144, flag: '\u{1F1F2}\u{1F1E8}' },
    { name: 'New Zealand', code: '+64', price: 45.86, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Iceland', code: '+354', price: 83.72, countryId: 132, flag: '\u{1F1EE}\u{1F1F8}' },
    { name: 'Gibraltar', code: '+350', price: 421.88, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' },
    { name: 'Cameroon', code: '+237', price: 40.04, countryId: 41, flag: '\u{1F1E8}\u{1F1F2}' },
    { name: 'Ivory Coast', code: '+225', price: 171.08, countryId: 27, flag: '\u{1F1E8}\u{1F1EE}' },
    { name: 'Jordan', code: '+962', price: 64.79, countryId: 116, flag: '\u{1F1EF}\u{1F1F4}' },
    { name: 'Malawi', code: '+265', price: 60.42, countryId: 137, flag: '\u{1F1F2}\u{1F1FC}' },
    { name: 'Luxembourg', code: '+352', price: 64.79, countryId: 165, flag: '\u{1F1F1}\u{1F1FA}' },
    { name: 'El Salvador', code: '+503', price: 64.79, countryId: 101, flag: '\u{1F1F8}\u{1F1FB}' },
    { name: 'Uganda', code: '+256', price: 16.74, countryId: 75, flag: '\u{1F1FA}\u{1F1EC}' },
    { name: 'Botswana', code: '+267', price: 64.79, countryId: 123, flag: '\u{1F1E7}\u{1F1FC}' },
    { name: 'Ecuador', code: '+593', price: 64.79, countryId: 105, flag: '\u{1F1EA}\u{1F1E8}' },
    { name: 'Uzbekistan', code: '+998', price: 91.73, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    { name: 'Peru', code: '+51', price: 69.52, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Czech Republic', code: '+420', price: 6.92, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Ukraine', code: '+380', price: 8.74, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Benin', code: '+229', price: 64.79, countryId: 120, flag: '\u{1F1E7}\u{1F1EF}' },
    { name: 'Burkina Faso', code: '+226', price: 46.23, countryId: 152, flag: '\u{1F1E7}\u{1F1EB}' },
    { name: 'Oman', code: '+968', price: 64.79, countryId: 107, flag: '\u{1F1F4}\u{1F1F2}' },
    { name: 'Burundi', code: '+257', price: 61.15, countryId: 119, flag: '\u{1F1E7}\u{1F1EE}' },
    { name: 'Bosnia and Herzegovina', code: '+387', price: 83.72, countryId: 108, flag: '\u{1F1E7}\u{1F1E6}' },
    { name: 'Barbados', code: '+1', price: 56.78, countryId: 118, flag: '\u{1F1E7}\u{1F1E7}' },
    { name: 'Gambia', code: '+220', price: 50.23, countryId: 28, flag: '\u{1F1EC}\u{1F1F2}' },
    { name: 'Armenia', code: '+374', price: 55.33, countryId: 148, flag: '\u{1F1E6}\u{1F1F2}' },
    { name: 'Cuba', code: '+53', price: 64.79, countryId: 113, flag: '\u{1F1E8}\u{1F1FA}' },
    { name: 'Chile', code: '+56', price: 1.46, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Sierra Leone', code: '+232', price: 46.23, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' }
];

const lykaCountries = [];

const doordashCountries = [
    { name: 'USA', code: '+1', price: 48.78, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Japan', code: '+81', price: 1877.51, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'New Zealand', code: '+64', price: 2011.46, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Australia', code: '', price: 230.05, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'Gibraltar', code: '+350', price: 237.33, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const celebeCountries = [
    { name: 'USA Virtual', code: '+1', price: 14, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'USA', code: '+1', price: 78.26, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const taikangCountries = [];

const ninetynineappCountries = [
    { name: 'Indonesia', code: '+62', price: 100, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const hopiCountries = [
    { name: 'Kyrgyzstan', code: '+996', price: 34.22, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' },
    { name: 'Azerbaijan', code: '+994', price: 34.22, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'USA', code: '+1', price: 43.32, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Afghanistan', code: '+93', price: 34.22, countryId: 74, flag: '\u{1F1E6}\u{1F1EB}' },
    { name: 'Serbia', code: '+381', price: 34.22, countryId: 29, flag: '\u{1F1F7}\u{1F1F8}' },
    { name: 'Latvia', code: '+371', price: 34.22, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Denmark', code: '+45', price: 34.22, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Austria', code: '+43', price: 34.22, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Cambodia', code: '+855', price: 1.46, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' },
    { name: 'Philippines', code: '+63', price: 34.22, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Spain', code: '+34', price: 34.22, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'India', code: '+91', price: 34.22, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Myanmar', code: '+95', price: 34.22, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'Morocco', code: '+212', price: 34.22, countryId: 37, flag: '\u{1F1F2}\u{1F1E6}' },
    { name: 'Kazakhstan', code: '+7', price: 34.22, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Colombia', code: '+57', price: 34.22, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' }
];

const mocospaceCountries = [
    { name: 'USA', code: '+1', price: 56.78, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Kazakhstan', code: '+7', price: 22.93, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'United Kingdom', code: '+44', price: 9.83, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const iqiyiCountries = [];

const zomatoCountries = [
    { name: 'India', code: '+91', price: 76.44, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Gibraltar', code: '+350', price: 353.08, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const trendyolCountries = [
    { name: 'Turkey', code: '+90', price: 35.67, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Germany', code: '+49', price: 47.68, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Tunisia', code: '+216', price: 35.67, countryId: 89, flag: '\u{1F1F9}\u{1F1F3}' },
    { name: 'Azerbaijan', code: '+994', price: 69.52, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Gibraltar', code: '+350', price: 407.32, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const ticketmasterCountries = [
    { name: 'USA', code: '+1', price: 42.22, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'United Kingdom', code: '+44', price: 37.86, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Canada', code: '+1', price: 9.83, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Netherlands', code: '+31', price: 19.66, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Chile', code: '+56', price: 18.56, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Portugal', code: '+351', price: 19.66, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Greece', code: '+30', price: 19.66, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Poland', code: '+48', price: 8.37, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'USA Virtual', code: '+1', price: 3.64, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Austria', code: '+43', price: 19.66, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Germany', code: '+49', price: 26.21, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Sweden', code: '+46', price: 5.82, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Spain', code: '+34', price: 29.12, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Denmark', code: '+45', price: 19.66, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Italy', code: '+39', price: 19.66, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Finland', code: '+358', price: 19.66, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'Romania', code: '+40', price: 19.66, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Malaysia', code: '+60', price: 19.66, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'France', code: '+33', price: 19.66, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Kenya', code: '+254', price: 19.66, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Kazakhstan', code: '+7', price: 18.56, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Colombia', code: '+57', price: 10.19, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Belarus', code: '+375', price: 19.66, countryId: 51, flag: '\u{1F1E7}\u{1F1FE}' },
    { name: 'Bulgaria', code: '+359', price: 19.66, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Azerbaijan', code: '+994', price: 19.66, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Moldova', code: '+373', price: 18.2, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Thailand', code: '+66', price: 19.66, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'China', code: '+86', price: 64.43, countryId: 3, flag: '\u{1F1E8}\u{1F1F3}' },
    { name: 'Armenia', code: '+374', price: 19.66, countryId: 148, flag: '\u{1F1E6}\u{1F1F2}' },
    { name: 'Ireland', code: '+353', price: 19.66, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Serbia', code: '+381', price: 19.66, countryId: 29, flag: '\u{1F1F7}\u{1F1F8}' },
    { name: 'Estonia', code: '+372', price: 19.66, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Czech Republic', code: '+420', price: 23.3, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Georgia', code: '+995', price: 28.39, countryId: 128, flag: '\u{1F1EC}\u{1F1EA}' },
    { name: 'Latvia', code: '+371', price: 19.66, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Slovenia', code: '+386', price: 19.66, countryId: 59, flag: '\u{1F1F8}\u{1F1EE}' },
    { name: 'Lithuania', code: '+370', price: 19.66, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'Japan', code: '+81', price: 747.93, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'Croatia', code: '+385', price: 37.49, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'New Zealand', code: '+64', price: 19.66, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Australia', code: '', price: 206.39, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'Gibraltar', code: '+350', price: 19.66, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const qoo10Countries = [];

const fullrentCountries = [];

const dewupoisonCountries = [];

const onexbetCountries = [
    { name: 'Kosovo', code: '+383', price: 17, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];

const my11circleCountries = [];

const ximalayaCountries = [];

const airtelCountries = [
    { name: 'India', code: '+91', price: 26.21, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const huyaCountries = [
    { name: 'Uzbekistan', code: '+998', price: 21.18, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' },
    { name: 'USA Virtual', code: '+1', price: 13.64, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' }
];

const douyuCountries = [
    { name: 'Malaysia', code: '+60', price: 121.58, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'USA', code: '+1', price: 82.26, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const olacabsCountries = [
    { name: 'India', code: '+91', price: 30.58, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Mauritius', code: '+230', price: 24.39, countryId: 157, flag: '\u{1F1F2}\u{1F1FA}' },
    { name: 'Gabon', code: '+241', price: 24.39, countryId: 154, flag: '\u{1F1EC}\u{1F1E6}' },
    { name: 'Reunion', code: '+262', price: 91.73, countryId: 146, flag: '\u{1F1F7}\u{1F1EA}' },
    { name: 'Uruguay', code: '+598', price: 24.39, countryId: 156, flag: '\u{1F1FA}\u{1F1FE}' },
    { name: 'Equatorial Guinea', code: '+240', price: 24.39, countryId: 167, flag: '\u{1F1EC}\u{1F1F6}' },
    { name: 'Maldives', code: '+960', price: 24.39, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Barbados', code: '+1', price: 87.36, countryId: 118, flag: '\u{1F1E7}\u{1F1E7}' },
    { name: 'Suriname', code: '+597', price: 24.39, countryId: 142, flag: '\u{1F1F8}\u{1F1F7}' },
    { name: 'Djibouti', code: '+253', price: 87.36, countryId: 168, flag: '\u{1F1E9}\u{1F1EF}' },
    { name: 'Canada', code: '+1', price: 7.28, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Chile', code: '+56', price: 24.39, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Sierra Leone', code: '+232', price: 24.39, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' },
    { name: 'Grenada', code: '+1', price: 87.36, countryId: 127, flag: '\u{1F1EC}\u{1F1E9}' },
    { name: 'Brunei Darussalam', code: '+673', price: 87.36, countryId: 121, flag: '\u{1F1E7}\u{1F1F3}' },
    { name: 'Cayman Islands', code: '+1', price: 87.36, countryId: 170, flag: '\u{1F1F0}\u{1F1FE}' },
    { name: 'Liberia', code: '+231', price: 24.39, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Comoros', code: '+269', price: 87.36, countryId: 133, flag: '\u{1F1F0}\u{1F1F2}' },
    { name: 'Slovakia', code: '+421', price: 24.39, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'Monaco', code: '+377', price: 24.39, countryId: 144, flag: '\u{1F1F2}\u{1F1E8}' },
    { name: 'Belize', code: '+501', price: 24.39, countryId: 124, flag: '\u{1F1E7}\u{1F1FF}' },
    { name: 'New Zealand', code: '+64', price: 24.39, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Lebanon', code: '+961', price: 24.39, countryId: 153, flag: '\u{1F1F1}\u{1F1E7}' },
    { name: 'Iceland', code: '+354', price: 24.39, countryId: 132, flag: '\u{1F1EE}\u{1F1F8}' },
    { name: 'Gibraltar', code: '+350', price: 340.34, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const dominospizzaCountries = [
    { name: 'Albania', code: '+355', price: 89.91, countryId: 155, flag: '\u{1F1E6}\u{1F1F1}' },
    { name: 'Azerbaijan', code: '+994', price: 48.78, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Belize', code: '+501', price: 69.52, countryId: 124, flag: '\u{1F1E7}\u{1F1FF}' },
    { name: 'Brunei Darussalam', code: '+673', price: 65.88, countryId: 121, flag: '\u{1F1E7}\u{1F1F3}' },
    { name: 'Cayman Islands', code: '+1', price: 65.88, countryId: 170, flag: '\u{1F1F0}\u{1F1FE}' },
    { name: 'Chile', code: '+56', price: 1.46, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Comoros', code: '+269', price: 65.88, countryId: 133, flag: '\u{1F1F0}\u{1F1F2}' },
    { name: 'Djibouti', code: '+253', price: 65.88, countryId: 168, flag: '\u{1F1E9}\u{1F1EF}' },
    { name: 'Equatorial Guinea', code: '+240', price: 65.88, countryId: 167, flag: '\u{1F1EC}\u{1F1F6}' },
    { name: 'Gabon', code: '+241', price: 69.52, countryId: 154, flag: '\u{1F1EC}\u{1F1E6}' },
    { name: 'Gibraltar', code: '+350', price: 255.53, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' },
    { name: 'India', code: '+91', price: 13.1, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Lebanon', code: '+961', price: 69.52, countryId: 153, flag: '\u{1F1F1}\u{1F1E7}' },
    { name: 'Liberia', code: '+231', price: 69.52, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Maldives', code: '+960', price: 65.88, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Monaco', code: '+377', price: 148.15, countryId: 144, flag: '\u{1F1F2}\u{1F1E8}' },
    { name: 'Puerto Rico', code: '+1', price: 46.23, countryId: 97, flag: '\u{1F1F5}\u{1F1F7}' },
    { name: 'Saint Lucia', code: '+1', price: 65.88, countryId: 164, flag: '\u{1F1F1}\u{1F1E8}' },
    { name: 'Slovakia', code: '+421', price: 89.91, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'Suriname', code: '+597', price: 69.52, countryId: 142, flag: '\u{1F1F8}\u{1F1F7}' },
    { name: 'Togo', code: '+228', price: 46.23, countryId: 99, flag: '\u{1F1F9}\u{1F1EC}' },
    { name: 'Uruguay', code: '+598', price: 114.3, countryId: 156, flag: '\u{1F1FA}\u{1F1FE}' }
];

const winzogameCountries = [
    { name: 'India', code: '+91', price: 19.66, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Gibraltar', code: '+350', price: 195.05, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const tenchatCountries = [];

const switipsCountries = [];

const youstarCountries = [];

const ifoodCountries = [
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Mexico', code: '+52', price: 42.22, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Colombia', code: '+57', price: 29.12, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Argentina', code: '+54', price: 1.46, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Japan', code: '+81', price: 1877.51, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'Gibraltar', code: '+350', price: 29.12, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const deliveryclubCountries = [];

const courseheroCountries = [];

const tripCountries = [
    { name: 'Netherlands', code: '+31', price: 16.74, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Gibraltar', code: '+350', price: 427.34, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const megaCountries = [];

const nimotvCountries = [
    { name: 'Turkey', code: '+90', price: 39.31, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Kyrgyzstan', code: '+996', price: 5.1, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' }
];

const caixaCountries = [
    { name: 'Germany', code: '+49', price: 24.02, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Malaysia', code: '+60', price: 24.39, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Gibraltar', code: '+350', price: 407.32, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' },
    { name: 'Ukraine', code: '+380', price: 82.63, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' }
];

const astropayCountries = [
    { name: 'Colombia', code: '+57', price: 75.35, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Germany', code: '+49', price: 26.21, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Chile', code: '+56', price: 40.04, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Argentina', code: '+54', price: 1.46, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Venezuela', code: '+58', price: 65.88, countryId: 70, flag: '\u{1F1FB}\u{1F1EA}' },
    { name: 'Kazakhstan', code: '+7', price: 52.42, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Ukraine', code: '+380', price: 83.72, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Peru', code: '+51', price: 65.88, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'United Kingdom', code: '+44', price: 14.2, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Netherlands', code: '+31', price: 14.56, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Malaysia', code: '+60', price: 18.56, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Brazil', code: '+55', price: 5.1, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' }
];

const happnCountries = [
    { name: 'Armenia', code: '+374', price: 16.74, countryId: 148, flag: '\u{1F1E6}\u{1F1F2}' },
    { name: 'Barbados', code: '+1', price: 71.34, countryId: 118, flag: '\u{1F1E7}\u{1F1E7}' },
    { name: 'Belize', code: '+501', price: 71.34, countryId: 124, flag: '\u{1F1E7}\u{1F1FF}' },
    { name: 'Bolivia', code: '+591', price: 71.34, countryId: 92, flag: '\u{1F1E7}\u{1F1F4}' },
    { name: 'Brunei Darussalam', code: '+673', price: 61.52, countryId: 121, flag: '\u{1F1E7}\u{1F1F3}' },
    { name: 'Cayman Islands', code: '+1', price: 61.52, countryId: 170, flag: '\u{1F1F0}\u{1F1FE}' },
    { name: 'Chile', code: '+56', price: 30.21, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Comoros', code: '+269', price: 71.34, countryId: 133, flag: '\u{1F1F0}\u{1F1F2}' },
    { name: 'Costa Rica', code: '+506', price: 71.34, countryId: 93, flag: '\u{1F1E8}\u{1F1F7}' },
    { name: 'Djibouti', code: '+253', price: 6.92, countryId: 168, flag: '\u{1F1E9}\u{1F1EF}' },
    { name: 'Equatorial Guinea', code: '+240', price: 71.34, countryId: 167, flag: '\u{1F1EC}\u{1F1F6}' },
    { name: 'Estonia', code: '+372', price: 48.78, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Finland', code: '+358', price: 65.88, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'French Guiana', code: '+594', price: 72.07, countryId: 162, flag: '\u{1F1EC}\u{1F1EB}' },
    { name: 'Gabon', code: '+241', price: 71.34, countryId: 154, flag: '\u{1F1EC}\u{1F1E6}' },
    { name: 'Georgia', code: '+995', price: 16.74, countryId: 128, flag: '\u{1F1EC}\u{1F1EA}' },
    { name: 'Grenada', code: '+1', price: 61.52, countryId: 127, flag: '\u{1F1EC}\u{1F1E9}' },
    { name: 'Guadeloupe', code: '+590', price: 71.34, countryId: 160, flag: '\u{1F1EC}\u{1F1F5}' },
    { name: 'Guatemala', code: '+502', price: 67.7, countryId: 94, flag: '\u{1F1EC}\u{1F1F9}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Latvia', code: '+371', price: 28.76, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Lebanon', code: '+961', price: 71.34, countryId: 153, flag: '\u{1F1F1}\u{1F1E7}' },
    { name: 'Liberia', code: '+231', price: 71.34, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Lithuania', code: '+370', price: 48.78, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'Maldives', code: '+960', price: 71.34, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Mauritius', code: '+230', price: 71.34, countryId: 157, flag: '\u{1F1F2}\u{1F1FA}' },
    { name: 'Monaco', code: '+377', price: 71.34, countryId: 144, flag: '\u{1F1F2}\u{1F1E8}' },
    { name: 'Netherlands', code: '+31', price: 4, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Nicaragua', code: '+505', price: 71.34, countryId: 90, flag: '\u{1F1F3}\u{1F1EE}' },
    { name: 'Reunion', code: '+262', price: 71.34, countryId: 146, flag: '\u{1F1F7}\u{1F1EA}' },
    { name: 'Saint Lucia', code: '+1', price: 71.34, countryId: 164, flag: '\u{1F1F1}\u{1F1E8}' },
    { name: 'Saint Vincent', code: '+1', price: 72.44, countryId: 166, flag: '\u{1F1FB}\u{1F1E8}' },
    { name: 'Sierra Leone', code: '+232', price: 71.34, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' },
    { name: 'Slovakia', code: '+421', price: 71.34, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'Suriname', code: '+597', price: 67.7, countryId: 142, flag: '\u{1F1F8}\u{1F1F7}' },
    { name: 'Sweden', code: '+46', price: 6.55, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Uruguay', code: '+598', price: 71.34, countryId: 156, flag: '\u{1F1FA}\u{1F1FE}' }
];

const mercariCountries = [];

const premiumoneCountries = [];

const inboxlvCountries = [];

const gofundmeCountries = [];

const hepsiburadacomCountries = [
    { name: 'Estonia', code: '+372', price: 121.94, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Denmark', code: '+45', price: 139.78, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Gibraltar', code: '+350', price: 12.74, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' },
    { name: 'Poland', code: '+48', price: 59.7, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Netherlands', code: '+31', price: 12.74, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Turkey', code: '+90', price: 35.67, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' }
];

const zupeeCountries = [
    { name: 'India', code: '+91', price: 19.66, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Gibraltar', code: '+350', price: 549.64, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const toslaCountries = [
    { name: 'Turkey', code: '+90', price: 248.61, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Gibraltar', code: '+350', price: 439.71, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const wiseCountries = [
    { name: 'USA Virtual', code: '+1', price: 1.46, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'United Kingdom', code: '+44', price: 3.64, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Poland', code: '+48', price: 110.66, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Netherlands', code: '+31', price: 36.04, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'India', code: '+91', price: 27.3, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Ukraine', code: '+380', price: 72.07, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'France', code: '+33', price: 55.33, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Mexico', code: '+52', price: 47.32, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Germany', code: '+49', price: 187.46, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Malaysia', code: '+60', price: 42.95, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Philippines', code: '+63', price: 24.39, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Estonia', code: '+372', price: 182.73, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Singapore', code: '+65', price: 1257.62, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
    { name: 'Denmark', code: '+45', price: 243.15, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Gibraltar', code: '+350', price: 847.76, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const callappCountries = [
    { name: 'Slovakia', code: '+421', price: 78.26, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'Chile', code: '+56', price: 30.58, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Sierra Leone', code: '+232', price: 56.78, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' },
    { name: 'Liberia', code: '+231', price: 61.15, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Switzerland', code: '+41', price: 101.92, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Gabon', code: '+241', price: 61.15, countryId: 154, flag: '\u{1F1EC}\u{1F1E6}' },
    { name: 'Monaco', code: '+377', price: 128.86, countryId: 144, flag: '\u{1F1F2}\u{1F1E8}' }
];

const faceitCountries = [];

const xiaomiCountries = [
    { name: 'Austria', code: '+43', price: 177.63, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Ukraine', code: '+380', price: 2.18, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Uzbekistan', code: '+998', price: 2.18, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    { name: 'Kazakhstan', code: '+7', price: 2.18, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Kyrgyzstan', code: '+996', price: 2.18, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' },
    { name: 'Bulgaria', code: '+359', price: 2.18, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Laos', code: '+856', price: 22.93, countryId: 25, flag: '\u{1F1F1}\u{1F1E6}' },
    { name: 'Poland', code: '+48', price: 2.18, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Malaysia', code: '+60', price: 12.38, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Netherlands', code: '+31', price: 2.18, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Singapore', code: '+65', price: 139.78, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' },
    { name: 'Gibraltar', code: '+350', price: 549.64, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const yappyCountries = [];

const dream11Countries = [];

const iqosCountries = [
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Gibraltar', code: '+350', price: 152.15, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const shellboxCountries = [];

const kucoinplayCountries = [];

const expressmoneyCountries = [];

const baiduCountries = [
    { name: 'Czech Republic', code: '+420', price: 2.18, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Hungary', code: '+36', price: 28.76, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'New Zealand', code: '+64', price: 1.31, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'USA', code: '+1', price: 1.46, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Kazakhstan', code: '+7', price: 0.22, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Philippines', code: '+63', price: 2.18, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Thailand', code: '+66', price: 16.74, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'South Africa', code: '+27', price: 1.46, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Romania', code: '+40', price: 1.46, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Sweden', code: '+46', price: 2.18, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Poland', code: '+48', price: 2.18, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'United Kingdom', code: '+44', price: 2.91, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Hong Kong', code: '+852', price: 23.3, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Germany', code: '+49', price: 8.74, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Canada', code: '+1', price: 1.46, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Vietnam', code: '+84', price: 2.18, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Netherlands', code: '+31', price: 8.74, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'France', code: '+33', price: 12.74, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Spain', code: '+34', price: 2.18, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'India', code: '+91', price: 16.74, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Mexico', code: '+52', price: 15.65, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Brazil', code: '+55', price: 2.18, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Malaysia', code: '+60', price: 2.18, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Pakistan', code: '+92', price: 18.56, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Bangladesh', code: '+880', price: 18.56, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'Ukraine', code: '+380', price: 0.22, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Uzbekistan', code: '+998', price: 2.18, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    { name: 'Swaziland', code: '+268', price: 60.42, countryId: 106, flag: '\u{1F1F8}\u{1F1FF}' },
    { name: 'Argentina', code: '+54', price: 1.46, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Myanmar', code: '+95', price: 16.74, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'Timor-Leste', code: '+670', price: 2.18, countryId: 91, flag: '\u{1F1F9}\u{1F1F1}' },
    { name: 'Kenya', code: '+254', price: 2.18, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Venezuela', code: '+58', price: 1.67, countryId: 70, flag: '\u{1F1FB}\u{1F1EA}' },
    { name: 'Colombia', code: '+57', price: 2.18, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Kyrgyzstan', code: '+996', price: 2.18, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' },
    { name: 'Israel', code: '', price: 2.18, countryId: 13, flag: '\u{1F1EE}\u{1F1F1}' },
    { name: 'Bulgaria', code: '+359', price: 2.18, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Mauritius', code: '+230', price: 56.78, countryId: 157, flag: '\u{1F1F2}\u{1F1FA}' },
    { name: 'Turkmenistan', code: '+993', price: 54.6, countryId: 161, flag: '\u{1F1F9}\u{1F1F2}' },
    { name: 'Gabon', code: '+241', price: 2.18, countryId: 154, flag: '\u{1F1EC}\u{1F1E6}' },
    { name: 'Moldova', code: '+373', price: 16.74, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Albania', code: '+355', price: 2.18, countryId: 155, flag: '\u{1F1E6}\u{1F1F1}' },
    { name: 'Australia', code: '', price: 23.3, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'Belize', code: '+501', price: 1.46, countryId: 124, flag: '\u{1F1E7}\u{1F1FF}' },
    { name: 'Brunei Darussalam', code: '+673', price: 56.78, countryId: 121, flag: '\u{1F1E7}\u{1F1F3}' },
    { name: 'Burkina Faso', code: '+226', price: 2.18, countryId: 152, flag: '\u{1F1E7}\u{1F1EB}' },
    { name: 'CAF', code: '+236', price: 56.78, countryId: 125, flag: '\u{1F1E8}\u{1F1EB}' },
    { name: 'Chile', code: '+56', price: 6.55, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Comoros', code: '+269', price: 56.78, countryId: 133, flag: '\u{1F1F0}\u{1F1F2}' },
    { name: 'Cyprus', code: '+357', price: 12.38, countryId: 77, flag: '\u{1F1E8}\u{1F1FE}' },
    { name: 'Denmark', code: '+45', price: 2.18, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Estonia', code: '+372', price: 2.18, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Gibraltar', code: '+350', price: 224.95, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' },
    { name: 'Greece', code: '+30', price: 2.18, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Grenada', code: '+1', price: 1.46, countryId: 127, flag: '\u{1F1EC}\u{1F1E9}' },
    { name: 'Guadeloupe', code: '+590', price: 30.58, countryId: 160, flag: '\u{1F1EC}\u{1F1F5}' },
    { name: 'Iceland', code: '+354', price: 78.26, countryId: 132, flag: '\u{1F1EE}\u{1F1F8}' },
    { name: 'Ireland', code: '+353', price: 2.18, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Italy', code: '+39', price: 10.92, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' },
    { name: 'Laos', code: '+856', price: 18.56, countryId: 25, flag: '\u{1F1F1}\u{1F1E6}' },
    { name: 'Lebanon', code: '+961', price: 2.18, countryId: 153, flag: '\u{1F1F1}\u{1F1E7}' },
    { name: 'Liberia', code: '+231', price: 1.46, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Maldives', code: '+960', price: 51.69, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Monaco', code: '+377', price: 128.86, countryId: 144, flag: '\u{1F1F2}\u{1F1E8}' },
    { name: 'Portugal', code: '+351', price: 2.18, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Serbia', code: '+381', price: 18.56, countryId: 29, flag: '\u{1F1F7}\u{1F1F8}' },
    { name: 'Sierra Leone', code: '+232', price: 30.58, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' },
    { name: 'Singapore', code: '+65', price: 2.18, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
    { name: 'Slovakia', code: '+421', price: 78.26, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'Suriname', code: '+597', price: 47.32, countryId: 142, flag: '\u{1F1F8}\u{1F1F7}' },
    { name: 'Switzerland', code: '+41', price: 21.48, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Uruguay', code: '+598', price: 54.96, countryId: 156, flag: '\u{1F1FA}\u{1F1FE}' }
];

const subitoCountries = [
    { name: 'Italy', code: '+39', price: 29.12, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'France', code: '+33', price: 89.91, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Saudi Arabia', code: '+966', price: 29.12, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Pakistan', code: '+92', price: 29.12, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Turkey', code: '+90', price: 145.6, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Myanmar', code: '+95', price: 29.12, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'Spain', code: '+34', price: 51.69, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Bangladesh', code: '+880', price: 29.12, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'Philippines', code: '+63', price: 29.12, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Latvia', code: '+371', price: 182.73, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Germany', code: '+49', price: 20.02, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Cambodia', code: '+855', price: 29.12, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' },
    { name: 'Austria', code: '+43', price: 112.11, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Switzerland', code: '+41', price: 136.86, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Poland', code: '+48', price: 136.86, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Czech Republic', code: '+420', price: 107.38, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Finland', code: '+358', price: 182.73, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'Cyprus', code: '+357', price: 121.94, countryId: 77, flag: '\u{1F1E8}\u{1F1FE}' },
    { name: 'Slovenia', code: '+386', price: 127.76, countryId: 59, flag: '\u{1F1F8}\u{1F1EE}' },
    { name: 'Netherlands', code: '+31', price: 8.37, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'USA', code: '+1', price: 107.02, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Belgium', code: '+32', price: 120.48, countryId: 82, flag: '\u{1F1E7}\u{1F1EA}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Hungary', code: '+36', price: 182.73, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'Ireland', code: '+353', price: 123.03, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Estonia', code: '+372', price: 121.94, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Sweden', code: '+46', price: 133.22, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Greece', code: '+30', price: 121.94, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Lithuania', code: '+370', price: 121.94, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'Slovakia', code: '+421', price: 182.73, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'Croatia', code: '+385', price: 93.18, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' },
    { name: 'Gibraltar', code: '+350', price: 549.64, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const lovelocalCountries = [];

const likeeCountries = [];

const chalkboardCountries = [];

const casinoplusCountries = [];

const kleinanzeigenCountries = [];

const rakutenCountries = [];

const gochatCountries = [
    { name: 'Algeria', code: '+213', price: 5.1, countryId: 58, flag: '\u{1F1E9}\u{1F1FF}' },
    { name: 'Angola', code: '+244', price: 48.78, countryId: 76, flag: '\u{1F1E6}\u{1F1F4}' },
    { name: 'Argentina', code: '+54', price: 1.46, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Austria', code: '+43', price: 48.78, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Canada', code: '+1', price: 42.95, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Colombia', code: '+57', price: 4, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Congo (Dem. Republic)', code: '+243', price: 48.78, countryId: 18, flag: '\u{1F1E8}\u{1F1E9}' },
    { name: 'Czech Republic', code: '+420', price: 5.1, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Ecuador', code: '+593', price: 48.78, countryId: 105, flag: '\u{1F1EA}\u{1F1E8}' },
    { name: 'Egypt', code: '+20', price: 48.78, countryId: 21, flag: '\u{1F1EA}\u{1F1EC}' },
    { name: 'El Salvador', code: '+503', price: 48.78, countryId: 101, flag: '\u{1F1F8}\u{1F1FB}' },
    { name: 'Ethiopia', code: '+251', price: 48.78, countryId: 71, flag: '\u{1F1EA}\u{1F1F9}' },
    { name: 'France', code: '+33', price: 24.39, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Germany', code: '+49', price: 5.1, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Ghana', code: '+233', price: 48.78, countryId: 38, flag: '\u{1F1EC}\u{1F1ED}' },
    { name: 'Haiti', code: '+509', price: 48.78, countryId: 26, flag: '\u{1F1ED}\u{1F1F9}' },
    { name: 'Honduras', code: '+504', price: 48.78, countryId: 88, flag: '\u{1F1ED}\u{1F1F3}' },
    { name: 'India', code: '+91', price: 48.78, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Iran', code: '+98', price: 48.78, countryId: 57, flag: '\u{1F1EE}\u{1F1F7}' },
    { name: 'Italy', code: '+39', price: 36.4, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Jordan', code: '+962', price: 48.78, countryId: 116, flag: '\u{1F1EF}\u{1F1F4}' },
    { name: 'Kazakhstan', code: '+7', price: 5.1, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Kenya', code: '+254', price: 5.1, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Kyrgyzstan', code: '+996', price: 48.78, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' },
    { name: 'Malawi', code: '+265', price: 48.78, countryId: 137, flag: '\u{1F1F2}\u{1F1FC}' },
    { name: 'Malaysia', code: '+60', price: 42.22, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Mexico', code: '+52', price: 48.78, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Myanmar', code: '+95', price: 48.78, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'Nepal', code: '+977', price: 48.78, countryId: 81, flag: '\u{1F1F3}\u{1F1F5}' },
    { name: 'Nigeria', code: '+234', price: 48.78, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Pakistan', code: '+92', price: 48.78, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Panama', code: '+507', price: 48.78, countryId: 112, flag: '\u{1F1F5}\u{1F1E6}' },
    { name: 'Paraguay', code: '+595', price: 48.78, countryId: 87, flag: '\u{1F1F5}\u{1F1FE}' },
    { name: 'Peru', code: '+51', price: 48.78, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Philippines', code: '+63', price: 24.39, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Romania', code: '+40', price: 5.1, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Saudi Arabia', code: '+966', price: 1.46, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'South Africa', code: '+27', price: 1.46, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Spain', code: '+34', price: 29.85, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Sri Lanka', code: '+94', price: 48.78, countryId: 64, flag: '\u{1F1F1}\u{1F1F0}' },
    { name: 'Tanzania', code: '+255', price: 48.78, countryId: 9, flag: '\u{1F1F9}\u{1F1FF}' },
    { name: 'Tunisia', code: '+216', price: 5.1, countryId: 89, flag: '\u{1F1F9}\u{1F1F3}' },
    { name: 'Turkey', code: '+90', price: 409.5, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Uganda', code: '+256', price: 48.78, countryId: 75, flag: '\u{1F1FA}\u{1F1EC}' },
    { name: 'Ukraine', code: '+380', price: 4, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Uzbekistan', code: '+998', price: 48.78, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    { name: 'Venezuela', code: '+58', price: 48.78, countryId: 70, flag: '\u{1F1FB}\u{1F1EA}' },
    { name: 'Vietnam', code: '+84', price: 5.1, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Zambia', code: '+260', price: 48.78, countryId: 147, flag: '\u{1F1FF}\u{1F1F2}' }
];

const notifireCountries = [
    { name: 'Czech Republic', code: '+420', price: 15.65, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Estonia', code: '+372', price: 36.4, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' }
];

const privetmirCountries = [];

const yamiCountries = [];

const synottipCountries = [
    { name: 'United Kingdom', code: '+44', price: 48.78, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Czech Republic', code: '+420', price: 92.46, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' }
];

const miraviaCountries = [
    { name: 'Spain', code: '+34', price: 27.66, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Germany', code: '+49', price: 12.38, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'United Kingdom', code: '+44', price: 9.83, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Poland', code: '+48', price: 26.21, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Netherlands', code: '+31', price: 10.19, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Estonia', code: '+372', price: 79.35, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Denmark', code: '+45', price: 79.35, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' }
];

const walmartCountries = [
    { name: 'USA', code: '+1', price: 48.78, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'USA Virtual', code: '+1', price: 1.46, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Canada', code: '+1', price: 2.18, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' }
];

const fortunaskCountries = [];

const freenowCountries = [
    { name: 'Colombia', code: '+57', price: 40.4, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'United Kingdom', code: '+44', price: 2.18, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Philippines', code: '+63', price: 15.29, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Malaysia', code: '+60', price: 17.11, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Netherlands', code: '+31', price: 2.18, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Chile', code: '+56', price: 11.46, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Lithuania', code: '+370', price: 2.18, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'Kosovo', code: '+383', price: 12.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];

const shpockCountries = [
    { name: 'United Kingdom', code: '+44', price: 9.83, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Germany', code: '+49', price: 36.04, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Netherlands', code: '+31', price: 8.01, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' }
];

const motorkuxCountries = [];

const indodaxCountries = [];

const upworkCountries = [
    { name: 'United Kingdom', code: '+44', price: 2.55, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Netherlands', code: '+31', price: 1.46, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'USA Virtual', code: '+1', price: 1.46, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Malaysia', code: '+60', price: 24.39, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'India', code: '+91', price: 22.93, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Kenya', code: '+254', price: 2.18, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Kazakhstan', code: '+7', price: 2.18, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Paraguay', code: '+595', price: 2.18, countryId: 87, flag: '\u{1F1F5}\u{1F1FE}' },
    { name: 'Thailand', code: '+66', price: 17.11, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Chile', code: '+56', price: 8.37, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Lithuania', code: '+370', price: 2.18, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];

const beanfunCountries = [];

const claudeCountries = [
    { name: 'Japan', code: '+81', price: 730.18, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'Gibraltar', code: '+350', price: 1609.61, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' },
    { name: 'Malaysia', code: '+60', price: 20.02, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Ukraine', code: '+380', price: 8.37, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'France', code: '+33', price: 101.56, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Denmark', code: '+45', price: 42.95, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' }
];

const emenuCountries = [];

const naimikzCountries = [];

const mycarkzCountries = [];

const aviatakzCountries = [];

const universalbeijingresortCountries = [];

const uzumCountries = [
    { name: 'Uzbekistan', code: '+998', price: 121.94, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' }
];

const cmbCountries = [
    { name: 'USA', code: '+1', price: 40.77, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'USA Virtual', code: '+1', price: 4.37, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Netherlands', code: '+31', price: 10.19, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Malaysia', code: '+60', price: 42.95, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' }
];

const ipsosisayCountries = [
    { name: 'Sweden', code: '+46', price: 6.55, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Ireland', code: '+353', price: 96.82, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Poland', code: '+48', price: 3.28, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Netherlands', code: '+31', price: 3.93, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'USA', code: '+1', price: 91, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Ukraine', code: '+380', price: 82.63, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'France', code: '+33', price: 32.4, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Germany', code: '+49', price: 50.6, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Canada', code: '+1', price: 25.48, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Italy', code: '+39', price: 36.4, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const pinduoduoCountries = [
    { name: 'Malaysia', code: '+60', price: 2.18, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'United Kingdom', code: '+44', price: 2.18, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];

const bharatpeCountries = [
    { name: 'India', code: '+91', price: 20.02, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const jiomartCountries = [];

const playerzpotCountries = [];

const tataneuCountries = [];

const winterloanCountries = [
    { name: 'India', code: '+91', price: 18.56, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const collabactCountries = [];

const qwikcilverCountries = [];

const tatacliqpaletteCountries = [
    { name: 'Indonesia', code: '+62', price: 100, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const citymallCountries = [];

const a23Countries = [
    { name: 'India', code: '+91', price: 11.28, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const poshvineCountries = [];

const marwadiCountries = [];

const frizzaCountries = [];

const zeptoCountries = [
    { name: 'India', code: '+91', price: 21.84, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const rummycircleCountries = [
    { name: 'India', code: '+91', price: 19.66, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const khatabookCountries = [];

const earneasyCountries = [];

const fitcreditCountries = [];

const bankkaroCountries = [
    { name: 'India', code: '+91', price: 34.22, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const skcapitalCountries = [];

const roomsterCountries = [
    { name: 'Colombia', code: '+57', price: 17.11, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'India', code: '+91', price: 14.56, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'United Kingdom', code: '+44', price: 4, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Malaysia', code: '+60', price: 36.4, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' }
];

const servifyCountries = [];

const hdfcbankCountries = [];

const bajajfinservCountries = [
    { name: 'India', code: '+91', price: 33.12, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const yonogamesCountries = [
    { name: 'India', code: '+91', price: 33.12, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const angeloneCountries = [
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'India', code: '+91', price: 18.56, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const mockguruCountries = [];

const hingedatingCountries = [];

const kamateraCountries = [];

const tomatoCountries = [
    { name: 'Vietnam', code: '+84', price: 14.56, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Indonesia', code: '+62', price: 9.83, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const bearwwwCountries = [
    { name: 'France', code: '+33', price: 76.8, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'United Kingdom', code: '+44', price: 24.75, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const anibisCountries = [
    { name: 'France', code: '+33', price: 3.64, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' }
];

const bunqCountries = [
    { name: 'Ukraine', code: '+380', price: 82.26, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'France', code: '+33', price: 65.16, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'United Kingdom', code: '+44', price: 4, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Malaysia', code: '+60', price: 18.56, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Netherlands', code: '+31', price: 5.46, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' }
];

const bebooCountries = [
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];

const namarsCountries = [
    { name: 'Netherlands', code: '+31', price: 24.75, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Brazil', code: '+55', price: 18.56, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Ukraine', code: '+380', price: 149.6, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'France', code: '+33', price: 94.28, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Germany', code: '+49', price: 37.86, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Lithuania', code: '+370', price: 97.19, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' }
];

const radiumCountries = [];

const busyflyCountries = [];

const vfsglobalCountries = [
    { name: 'Poland', code: '+48', price: 48.03, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'India', code: '+91', price: 22.93, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const broCountries = [];

const bitrueCountries = [
    { name: 'India', code: '+91', price: 31.3, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const kiaCountries = [];

const royalcaninCountries = [];

const ayabankCountries = [
    { name: 'Myanmar', code: '+95', price: 54.96, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' }
];

const neteaseCountries = [
    { name: 'Philippines', code: '+63', price: 12.74, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Colombia', code: '+57', price: 21.18, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Thailand', code: '+66', price: 37.49, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'United Kingdom', code: '+44', price: 2.18, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Malaysia', code: '+60', price: 30.58, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Netherlands', code: '+31', price: 21.18, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Chile', code: '+56', price: 2.18, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];

const rappiCountries = [
    { name: 'Colombia', code: '+57', price: 65.16, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' }
];

const cabifyCountries = [
    { name: 'Colombia', code: '+57', price: 41.86, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' }
];

const nequiCountries = [];

const ozanCountries = [
    { name: 'Turkey', code: '+90', price: 182.73, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'United Kingdom', code: '+44', price: 9.83, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const fupsCountries = [
    { name: 'Turkey', code: '+90', price: 91.36, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' }
];

const playerauctionsCountries = [
    { name: 'Spain', code: '+34', price: 148.51, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Netherlands', code: '+31', price: 9.83, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Canada', code: '+1', price: 32.76, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' }
];

const chevronCountries = [];

const xxgameCountries = [
    { name: 'Thailand', code: '+66', price: 62.61, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' }
];

const alchemyCountries = [
    { name: 'Poland', code: '+48', price: 2.18, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' },
    { name: 'Thailand', code: '+66', price: 2.18, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'United Kingdom', code: '+44', price: 2.18, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const boyaaCountries = [
    { name: 'Thailand', code: '+66', price: 10.18, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Kosovo', code: '+383', price: 10.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];

const byteplusCountries = [
    { name: 'Chile', code: '+56', price: 8.74, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'United Kingdom', code: '+44', price: 2.18, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Thailand', code: '+66', price: 45.86, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];

const privyCountries = [
    { name: 'Thailand', code: '+66', price: 17.11, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Laos', code: '+856', price: 36.4, countryId: 25, flag: '\u{1F1F1}\u{1F1E6}' },
    { name: 'Malaysia', code: '+60', price: 18.56, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' }
];

const meituanCountries = [];

const pockitCountries = [];

const tiptappCountries = [];

const rocketreachCountries = [];

const taptapsendCountries = [
    { name: 'Estonia', code: '+372', price: 79.35, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Czech Republic', code: '+420', price: 30.58, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Latvia', code: '+371', price: 85.54, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Croatia', code: '+385', price: 48.78, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'Denmark', code: '+45', price: 121.94, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' }
];

const foodoraCountries = [
    { name: 'United Kingdom', code: '+44', price: 2.18, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Germany', code: '+49', price: 5.1, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Netherlands', code: '+31', price: 6.92, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Japan', code: '+81', price: 1877.51, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'Ukraine', code: '+380', price: 41.86, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Malaysia', code: '+60', price: 30.58, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Finland', code: '+358', price: 193.28, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'Denmark', code: '+45', price: 142.32, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];

const friendtechCountries = [];

const haleonCountries = [];

const airtimeCountries = [
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const truthsocialCountries = [
    { name: 'Colombia', code: '+57', price: 2.18, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Malaysia', code: '+60', price: 2.18, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'United Kingdom', code: '+44', price: 2.55, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Philippines', code: '+63', price: 2.18, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Chile', code: '+56', price: 2.18, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];

const playojoCountries = [];

const jinjiangCountries = [
    { name: 'Eritrea', code: '+291', price: 2.18, countryId: 176, flag: '\u{1F1EA}\u{1F1F7}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' },
    { name: 'Iceland', code: '+354', price: 2.18, countryId: 132, flag: '\u{1F1EE}\u{1F1F8}' },
    { name: 'Macau', code: '+853', price: 2.18, countryId: 20, flag: '\u{1F1F2}\u{1F1F4}' },
    { name: 'Australia', code: '', price: 2.18, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'Seychelles', code: '+248', price: 2.18, countryId: 184, flag: '\u{1F1F8}\u{1F1E8}' },
    { name: 'Denmark', code: '+45', price: 2.18, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Lebanon', code: '+961', price: 2.18, countryId: 153, flag: '\u{1F1F1}\u{1F1E7}' },
    { name: 'Mongolia', code: '+976', price: 2.18, countryId: 72, flag: '\u{1F1F2}\u{1F1F3}' },
    { name: 'New Zealand', code: '+64', price: 2.18, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Macedonia', code: '+389', price: 63.34, countryId: 183, flag: '\u{1F1F2}\u{1F1F0}' },
    { name: 'Belize', code: '+501', price: 2.18, countryId: 124, flag: '\u{1F1E7}\u{1F1FF}' },
    { name: 'Monaco', code: '+377', price: 63.34, countryId: 144, flag: '\u{1F1F2}\u{1F1E8}' },
    { name: 'Croatia', code: '+385', price: 2.18, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'Cape Verde', code: '+238', price: 2.18, countryId: 186, flag: '\u{1F1E8}\u{1F1FB}' },
    { name: 'Fiji', code: '+679', price: 2.18, countryId: 189, flag: '\u{1F1EB}\u{1F1EF}' },
    { name: 'Slovakia', code: '+421', price: 2.18, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'Sao Tome and Principe', code: '+239', price: 2.18, countryId: 178, flag: '\u{1F1F8}\u{1F1F9}' },
    { name: 'Singapore', code: '+65', price: 50.23, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
    { name: 'Comoros', code: '+269', price: 2.18, countryId: 133, flag: '\u{1F1F0}\u{1F1F2}' },
    { name: 'Guinea', code: '+224', price: 0.22, countryId: 68, flag: '\u{1F1EC}\u{1F1F3}' },
    { name: 'Aruba', code: '+297', price: 0.22, countryId: 179, flag: '\u{1F1E6}\u{1F1FC}' },
    { name: 'Liberia', code: '+231', price: 2.18, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Lithuania', code: '+370', price: 2.18, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'CAF', code: '+236', price: 2.18, countryId: 125, flag: '\u{1F1E8}\u{1F1EB}' },
    { name: 'Saint Kitts and Nevis', code: '+1', price: 2.18, countryId: 134, flag: '\u{1F1F0}\u{1F1F3}' },
    { name: 'Slovenia', code: '+386', price: 2.18, countryId: 59, flag: '\u{1F1F8}\u{1F1EE}' },
    { name: 'Albania', code: '+355', price: 2.18, countryId: 155, flag: '\u{1F1E6}\u{1F1F1}' },
    { name: 'Bahamas', code: '+1', price: 2.18, countryId: 122, flag: '\u{1F1E7}\u{1F1F8}' },
    { name: 'Bahrain', code: '+973', price: 2.18, countryId: 145, flag: '\u{1F1E7}\u{1F1ED}' },
    { name: 'Bolivia', code: '+591', price: 2.18, countryId: 92, flag: '\u{1F1E7}\u{1F1F4}' },
    { name: 'Bulgaria', code: '+359', price: 2.18, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Cuba', code: '+53', price: 2.18, countryId: 113, flag: '\u{1F1E8}\u{1F1FA}' },
    { name: 'Cyprus', code: '+357', price: 2.18, countryId: 77, flag: '\u{1F1E8}\u{1F1FE}' },
    { name: 'Czech Republic', code: '+420', price: 2.18, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Estonia', code: '+372', price: 2.18, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Georgia', code: '+995', price: 2.18, countryId: 128, flag: '\u{1F1EC}\u{1F1EA}' },
    { name: 'Greece', code: '+30', price: 2.18, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Grenada', code: '+1', price: 2.18, countryId: 127, flag: '\u{1F1EC}\u{1F1E9}' },
    { name: 'Guadeloupe', code: '+590', price: 2.18, countryId: 160, flag: '\u{1F1EC}\u{1F1F5}' },
    { name: 'Guatemala', code: '+502', price: 2.18, countryId: 94, flag: '\u{1F1EC}\u{1F1F9}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Ireland', code: '+353', price: 2.18, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Latvia', code: '+371', price: 2.18, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Luxembourg', code: '+352', price: 2.18, countryId: 165, flag: '\u{1F1F1}\u{1F1FA}' },
    { name: 'Madagascar', code: '+261', price: 2.18, countryId: 17, flag: '\u{1F1F2}\u{1F1EC}' },
    { name: 'Montenegro', code: '+382', price: 2.18, countryId: 171, flag: '\u{1F1F2}\u{1F1EA}' },
    { name: 'Serbia', code: '+381', price: 2.18, countryId: 29, flag: '\u{1F1F7}\u{1F1F8}' },
    { name: 'Sierra Leone', code: '+232', price: 2.18, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' },
    { name: 'Suriname', code: '+597', price: 2.18, countryId: 142, flag: '\u{1F1F8}\u{1F1F7}' },
    { name: 'Sweden', code: '+46', price: 2.18, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Tajikistan', code: '+992', price: 2.18, countryId: 143, flag: '\u{1F1F9}\u{1F1EF}' },
    { name: 'Switzerland', code: '+41', price: 63.34, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Armenia', code: '+374', price: 2.18, countryId: 148, flag: '\u{1F1E6}\u{1F1F2}' },
    { name: 'Somalia', code: '+252', price: 2.18, countryId: 149, flag: '\u{1F1F8}\u{1F1F4}' },
    { name: 'Dominican Republic', code: '+1', price: 2.18, countryId: 109, flag: '\u{1F1E9}\u{1F1F4}' },
    { name: 'Portugal', code: '+351', price: 2.18, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Maldives', code: '+960', price: 2.18, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Guinea-Bissau', code: '+245', price: 2.18, countryId: 130, flag: '\u{1F1EC}\u{1F1FC}' },
    { name: 'China', code: '+86', price: 6.99, countryId: 3, flag: '\u{1F1E8}\u{1F1F3}' },
    { name: 'Kuwait', code: '+965', price: 2.18, countryId: 100, flag: '\u{1F1F0}\u{1F1FC}' },
    { name: 'Philippines', code: '+63', price: 0.22, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'South Sudan', code: '+211', price: 2.18, countryId: 177, flag: '\u{1F1F8}\u{1F1F8}' },
    { name: 'Mauritius', code: '+230', price: 2.18, countryId: 157, flag: '\u{1F1F2}\u{1F1FA}' },
    { name: 'UAE', code: '+971', price: 2.18, countryId: 95, flag: '\u{1F1E6}\u{1F1EA}' },
    { name: 'Trinidad and Tobago', code: '+1', price: 2.18, countryId: 104, flag: '\u{1F1F9}\u{1F1F9}' },
    { name: 'Netherlands', code: '+31', price: 2.18, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Syria', code: '+963', price: 1.46, countryId: 1333, flag: '\u{1F1F8}\u{1F1FE}' },
    { name: 'Burundi', code: '+257', price: 0.29, countryId: 119, flag: '\u{1F1E7}\u{1F1EE}' },
    { name: 'Togo', code: '+228', price: 2.18, countryId: 99, flag: '\u{1F1F9}\u{1F1EC}' },
    { name: 'Niger', code: '+227', price: 2.18, countryId: 139, flag: '\u{1F1F3}\u{1F1EA}' },
    { name: 'Poland', code: '+48', price: 2.91, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Laos', code: '+856', price: 0.22, countryId: 25, flag: '\u{1F1F1}\u{1F1E6}' },
    { name: 'Senegal', code: '+221', price: 2.18, countryId: 61, flag: '\u{1F1F8}\u{1F1F3}' },
    { name: 'Uruguay', code: '+598', price: 2.18, countryId: 156, flag: '\u{1F1FA}\u{1F1FE}' },
    { name: 'Iraq', code: '+964', price: 2.18, countryId: 47, flag: '\u{1F1EE}\u{1F1F6}' },
    { name: 'Yemen', code: '+967', price: 2.18, countryId: 30, flag: '\u{1F1FE}\u{1F1EA}' },
    { name: 'Oman', code: '+968', price: 2.18, countryId: 107, flag: '\u{1F1F4}\u{1F1F2}' },
    { name: 'Congo', code: '+242', price: 2.18, countryId: 150, flag: '\u{1F1E8}\u{1F1EC}' },
    { name: 'Belgium', code: '+32', price: 2.18, countryId: 82, flag: '\u{1F1E7}\u{1F1EA}' },
    { name: 'Costa Rica', code: '+506', price: 2.18, countryId: 93, flag: '\u{1F1E8}\u{1F1F7}' },
    { name: 'Burkina Faso', code: '+226', price: 2.18, countryId: 152, flag: '\u{1F1E7}\u{1F1EB}' },
    { name: 'Qatar', code: '+974', price: 2.18, countryId: 111, flag: '\u{1F1F6}\u{1F1E6}' },
    { name: 'Benin', code: '+229', price: 2.18, countryId: 120, flag: '\u{1F1E7}\u{1F1EF}' },
    { name: 'Nicaragua', code: '+505', price: 2.18, countryId: 90, flag: '\u{1F1F3}\u{1F1EE}' },
    { name: 'Moldova', code: '+373', price: 2.18, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Gabon', code: '+241', price: 2.18, countryId: 154, flag: '\u{1F1EC}\u{1F1E6}' },
    { name: 'Sudan', code: '+249', price: 69.89, countryId: 1010, flag: '\u{1F1F8}\u{1F1E9}' },
    { name: 'Rwanda', code: '+250', price: 2.18, countryId: 140, flag: '\u{1F1F7}\u{1F1FC}' },
    { name: 'Mali', code: '+223', price: 2.18, countryId: 69, flag: '\u{1F1F2}\u{1F1F1}' },
    { name: 'Turkmenistan', code: '+993', price: 2.18, countryId: 161, flag: '\u{1F1F9}\u{1F1F2}' },
    { name: 'Azerbaijan', code: '+994', price: 2.18, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Libya', code: '+218', price: 2.18, countryId: 102, flag: '\u{1F1F1}\u{1F1FE}' },
    { name: 'Belarus', code: '+375', price: 2.18, countryId: 51, flag: '\u{1F1E7}\u{1F1FE}' },
    { name: 'Israel', code: '', price: 2.18, countryId: 13, flag: '\u{1F1EE}\u{1F1F1}' },
    { name: 'Ivory Coast', code: '+225', price: 2.18, countryId: 27, flag: '\u{1F1E8}\u{1F1EE}' },
    { name: 'Cameroon', code: '+237', price: 2.18, countryId: 41, flag: '\u{1F1E8}\u{1F1F2}' },
    { name: 'Kyrgyzstan', code: '+996', price: 0.29, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' },
    { name: 'Jordan', code: '+962', price: 2.18, countryId: 116, flag: '\u{1F1EF}\u{1F1F4}' },
    { name: 'Paraguay', code: '+595', price: 2.91, countryId: 87, flag: '\u{1F1F5}\u{1F1FE}' },
    { name: 'Colombia', code: '+57', price: 2.18, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Kazakhstan', code: '+7', price: 2.18, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Venezuela', code: '+58', price: 2.18, countryId: 70, flag: '\u{1F1FB}\u{1F1EA}' },
    { name: 'Argentina', code: '+54', price: 1.46, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Botswana', code: '+267', price: 2.18, countryId: 123, flag: '\u{1F1E7}\u{1F1FC}' },
    { name: 'Congo (Dem. Republic)', code: '+243', price: 2.18, countryId: 18, flag: '\u{1F1E8}\u{1F1E9}' },
    { name: 'Ecuador', code: '+593', price: 2.18, countryId: 105, flag: '\u{1F1EA}\u{1F1E8}' },
    { name: 'El Salvador', code: '+503', price: 2.18, countryId: 101, flag: '\u{1F1F8}\u{1F1FB}' },
    { name: 'Ghana', code: '+233', price: 2.18, countryId: 38, flag: '\u{1F1EC}\u{1F1ED}' },
    { name: 'Honduras', code: '+504', price: 2.18, countryId: 88, flag: '\u{1F1ED}\u{1F1F3}' },
    { name: 'Jamaica', code: '+1', price: 2.18, countryId: 103, flag: '\u{1F1EF}\u{1F1F2}' },
    { name: 'Kenya', code: '+254', price: 2.18, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Lesotho', code: '+266', price: 2.18, countryId: 136, flag: '\u{1F1F1}\u{1F1F8}' },
    { name: 'Malawi', code: '+265', price: 2.18, countryId: 137, flag: '\u{1F1F2}\u{1F1FC}' },
    { name: 'Morocco', code: '+212', price: 2.18, countryId: 37, flag: '\u{1F1F2}\u{1F1E6}' },
    { name: 'Nepal', code: '+977', price: 2.18, countryId: 81, flag: '\u{1F1F3}\u{1F1F5}' },
    { name: 'Panama', code: '+507', price: 2.18, countryId: 112, flag: '\u{1F1F5}\u{1F1E6}' },
    { name: 'Peru', code: '+51', price: 2.18, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Sri Lanka', code: '+94', price: 2.18, countryId: 64, flag: '\u{1F1F1}\u{1F1F0}' },
    { name: 'Swaziland', code: '+268', price: 2.18, countryId: 106, flag: '\u{1F1F8}\u{1F1FF}' },
    { name: 'Tanzania', code: '+255', price: 2.18, countryId: 9, flag: '\u{1F1F9}\u{1F1FF}' },
    { name: 'Timor-Leste', code: '+670', price: 2.18, countryId: 91, flag: '\u{1F1F9}\u{1F1F1}' },
    { name: 'Tunisia', code: '+216', price: 2.18, countryId: 89, flag: '\u{1F1F9}\u{1F1F3}' },
    { name: 'Uganda', code: '+256', price: 2.18, countryId: 75, flag: '\u{1F1FA}\u{1F1EC}' },
    { name: 'Uzbekistan', code: '+998', price: 2.18, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    { name: 'Zimbabwe', code: '+263', price: 2.18, countryId: 96, flag: '\u{1F1FF}\u{1F1FC}' },
    { name: 'Algeria', code: '+213', price: 2.18, countryId: 58, flag: '\u{1F1E9}\u{1F1FF}' },
    { name: 'Angola', code: '+244', price: 2.18, countryId: 76, flag: '\u{1F1E6}\u{1F1F4}' },
    { name: 'Austria', code: '+43', price: 35.67, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Cambodia', code: '+855', price: 2.91, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' },
    { name: 'Canada', code: '+1', price: 2.18, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Egypt', code: '+20', price: 2.18, countryId: 21, flag: '\u{1F1EA}\u{1F1EC}' },
    { name: 'Ethiopia', code: '+251', price: 2.18, countryId: 71, flag: '\u{1F1EA}\u{1F1F9}' },
    { name: 'Finland', code: '+358', price: 35.67, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'Germany', code: '+49', price: 24.75, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Haiti', code: '+509', price: 2.18, countryId: 26, flag: '\u{1F1ED}\u{1F1F9}' },
    { name: 'Hong Kong', code: '+852', price: 2.18, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Hungary', code: '+36', price: 35.67, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'India', code: '+91', price: 2.91, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Iran', code: '+98', price: 2.91, countryId: 57, flag: '\u{1F1EE}\u{1F1F7}' },
    { name: 'Japan', code: '+81', price: 35.67, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'Malaysia', code: '+60', price: 2.18, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Mexico', code: '+52', price: 35.67, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Mozambique', code: '+258', price: 2.18, countryId: 80, flag: '\u{1F1F2}\u{1F1FF}' },
    { name: 'Namibia', code: '+264', price: 2.18, countryId: 138, flag: '\u{1F1F3}\u{1F1E6}' },
    { name: 'Nigeria', code: '+234', price: 35.67, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Norway', code: '+47', price: 3.57, countryId: 174, flag: '\u{1F1F3}\u{1F1F4}' },
    { name: 'Pakistan', code: '+92', price: 35.67, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Papua new gvineya', code: '+675', price: 2.18, countryId: 79, flag: '\u{1F1F5}\u{1F1EC}' },
    { name: 'Romania', code: '+40', price: 1.46, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Saudi Arabia', code: '+966', price: 35.67, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'South Africa', code: '+27', price: 2.18, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Spain', code: '+34', price: 2.18, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Taiwan', code: '+886', price: 35.67, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
    { name: 'Thailand', code: '+66', price: 2.18, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Turkey', code: '+90', price: 35.67, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'USA', code: '+1', price: 35.67, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'USA Virtual', code: '+1', price: 3.64, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
     { name: 'Ukraine', code: '+380', price: 2.18, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
     { name: 'United Kingdom', code: '+44', price: 2.18, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
     { name: 'Zambia', code: '+260', price: 2.18, countryId: 147, flag: '\u{1F1FF}\u{1F1F2}' }
 ];
 
 const neocryptoCountries = [
     { name: 'USA', code: '+1', price: 87.36, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
     { name: 'United Kingdom', code: '+44', price: 2.18, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
     { name: 'Netherlands', code: '+31', price: 2.18, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];

const tuulCountries = [
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const klarnaCountries = [
    { name: 'Germany', code: '+49', price: 5.1, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Netherlands', code: '+31', price: 12.38, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'USA', code: '+1', price: 121.58, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'United Kingdom', code: '+44', price: 4, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const vimpayCountries = [
    { name: 'Germany', code: '+49', price: 80.08, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const grailedCountries = [];

const mtrmobileCountries = [];

const meituCountries = [];

const oneformaCountries = [
    { name: 'USA', code: '+1', price: 48.78, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'United Kingdom', code: '+44', price: 3.64, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Netherlands', code: '+31', price: 16.38, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' }
];

const abbottCountries = [
    { name: 'India', code: '+91', price: 11.28, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Italy', code: '+39', price: 187.1, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' }
];

const gmxCountries = [
    { name: 'Germany', code: '+49', price: 72.8, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Netherlands', code: '+31', price: 2.55, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Denmark', code: '+45', price: 6.55, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Malaysia', code: '+60', price: 30.58, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'South Africa', code: '+27', price: 1.46, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'India', code: '+91', price: 4, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Ukraine', code: '+380', price: 4, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'United Kingdom', code: '+44', price: 2.55, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Poland', code: '+48', price: 8.37, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Estonia', code: '+372', price: 6.55, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Croatia', code: '+385', price: 4, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' }
];

const webdeCountries = [
    { name: 'Germany', code: '+49', price: 54.96, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' }
];

const stratoCountries = [
    { name: 'Germany', code: '+49', price: 42.95, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' }
];

const oneandoneCountries = [
    { name: 'Germany', code: '+49', price: 50.96, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' }
];

const surveybellCountries = [
    { name: 'Germany', code: '+49', price: 41.86, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' }
];

const checkdomainCountries = [];

const arlensCountries = [
    { name: 'Malaysia', code: '+60', price: 18.56, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' }
];

const bonuslinkCountries = [
    { name: 'Malaysia', code: '+60', price: 24.02, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' }
];

const suntecCountries = [];

const gopayzCountries = [];

const tanotiCountries = [];

const maybankCountries = [];

const myboostCountries = [];

const meiqfashionCountries = [];

const fugeelahCountries = [];

const k11Countries = [];

const strivinginthelioncityCountries = [];

const marktplaatsCountries = [];

const primeopinionCountries = [
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Germany', code: '+49', price: 53.14, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Netherlands', code: '+31', price: 8.74, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' }
];

const arenaplusCountries = [
    { name: 'Philippines', code: '+63', price: 47.68, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' }
];

const willhabenCountries = [
    { name: 'Germany', code: '+49', price: 5.1, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Estonia', code: '+372', price: 109.93, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' }
];

const openphoneCountries = [];

const seznamCountries = [
    { name: 'Czech Republic', code: '+420', price: 70.98, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' }
];

const packetaCountries = [];

const publi24Countries = [];

const betanoCountries = [
    { name: 'Japan', code: '+81', price: 1073.07, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'Romania', code: '+40', price: 32.4, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const zasilkovnaCountries = [
    { name: 'Romania', code: '+40', price: 29.85, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' }
];

const bpjstkCountries = [
    { name: 'Kosovo', code: '+383', price: 32.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' },
    { name: 'Indonesia', code: '+62', price: 13.55, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const bcasyariahCountries = [
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const cloudmanagerCountries = [
    { name: 'Chile', code: '+56', price: 11.46, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Indonesia', code: '+62', price: 13.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'India', code: '+91', price: 22.93, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'United Kingdom', code: '+44', price: 15.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const astrapayCountries = [
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const redigameCountries = [];

const allofreshCountries = [
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const onbukaCountries = [];

const godrejCountries = [];

const greywoodsCountries = [];

const theforkCountries = [
    { name: 'United Kingdom', code: '+44', price: 3.64, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Germany', code: '+49', price: 47.68, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Indonesia', code: '+62', price: 2.55, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const flipCountries = [];

const neonCountries = [];

const bundaCountries = [
    { name: 'Indonesia', code: '+62', price: 13.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const astraotoshopCountries = [
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const gamesofaCountries = [
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Malaysia', code: '+60', price: 36.4, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Netherlands', code: '+31', price: 9.83, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' }
];

const flikCountries = [];

const jivapetaniCountries = [];

const ubisoftCountries = [
    { name: 'United Kingdom', code: '+44', price: 2.18, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Malaysia', code: '+60', price: 2.18, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Netherlands', code: '+31', price: 14.2, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];

const uangmeCountries = [
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const pizzahutCountries = [];

const seedsCountries = [];

const afreecatvCountries = [
    { name: 'Malaysia', code: '+60', price: 45.86, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const tiptipCountries = [];

const schibstedCountries = [
    { name: 'Japan', code: '+81', price: 1073.07, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' }
];

const feetfinderCountries = [
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Estonia', code: '+372', price: 152.15, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Sweden', code: '+46', price: 6.55, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' }
];

const luckylandslotsCountries = [];

const dakiCountries = [];

const baiheCountries = [
    { name: 'Hong Kong', code: '+852', price: 397.49, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' }
];

const thisfateCountries = [
    { name: 'Hong Kong', code: '+852', price: 461.19, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' }
];

const njuskaloCountries = [
    { name: 'Croatia', code: '+385', price: 98.64, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' }
];

const cocacolaCountries = [
    { name: 'USA', code: '+1', price: 23.3, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'USA Virtual', code: '+1', price: 26.21, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' }
];

const kachingCountries = [];

const couponscomCountries = [];

const sparkdriverCountries = [];

const tivCountries = [];

const razerCountries = [
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Malaysia', code: '+60', price: 30.58, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'USA Virtual', code: '+1', price: 4.37, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' }
];

const zachbryanCountries = [
    { name: 'USA Virtual', code: '+1', price: 4.37, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' }
];

const smartypigCountries = [];

const fliffCountries = [];

const spacewebCountries = [];

const nlotoCountries = [];

const brevoCountries = [
    { name: 'USA', code: '+1', price: 82.99, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Germany', code: '+49', price: 55.33, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const av100proCountries = [];

const ollisCountries = [];

const bankeraCountries = [
    { name: 'Spain', code: '+34', price: 143.78, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Estonia', code: '+372', price: 152.15, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' }
];

const g2aCountries = [
    { name: 'USA', code: '+1', price: 110.66, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const cupidmediaCountries = [];

const ipanelonlineCountries = [];

const fortumoCountries = [];

const waugCountries = [
    { name: 'Thailand', code: '+66', price: 45.86, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' }
];

const rebtelCountries = [
    { name: 'South Africa', code: '+27', price: 1.46, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'France', code: '+33', price: 22.93, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Germany', code: '+49', price: 6.92, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'USA', code: '+1', price: 54.96, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'United Kingdom', code: '+44', price: 2.55, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Italy', code: '+39', price: 22.57, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Kenya', code: '+254', price: 27.66, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Spain', code: '+34', price: 43.32, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Czech Republic', code: '+420', price: 22.93, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Canada', code: '+1', price: 8.37, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Romania', code: '+40', price: 28.39, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'India', code: '+91', price: 29.12, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Ethiopia', code: '+251', price: 29.12, countryId: 71, flag: '\u{1F1EA}\u{1F1F9}' },
    { name: 'Egypt', code: '+20', price: 29.12, countryId: 21, flag: '\u{1F1EA}\u{1F1EC}' },
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Vietnam', code: '+84', price: 21.84, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Zimbabwe', code: '+263', price: 29.12, countryId: 96, flag: '\u{1F1FF}\u{1F1FC}' },
    { name: 'Nigeria', code: '+234', price: 29.12, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'Congo (Dem. Republic)', code: '+243', price: 29.12, countryId: 18, flag: '\u{1F1E8}\u{1F1E9}' },
    { name: 'Botswana', code: '+267', price: 29.12, countryId: 123, flag: '\u{1F1E7}\u{1F1FC}' },
    { name: 'Mexico', code: '+52', price: 29.12, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Honduras', code: '+504', price: 29.12, countryId: 88, flag: '\u{1F1ED}\u{1F1F3}' },
    { name: 'Argentina', code: '+54', price: 1.46, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Tunisia', code: '+216', price: 29.12, countryId: 89, flag: '\u{1F1F9}\u{1F1F3}' },
    { name: 'Timor-Leste', code: '+670', price: 29.12, countryId: 91, flag: '\u{1F1F9}\u{1F1F1}' },
    { name: 'Uganda', code: '+256', price: 29.12, countryId: 75, flag: '\u{1F1FA}\u{1F1EC}' },
    { name: 'Venezuela', code: '+58', price: 30.58, countryId: 70, flag: '\u{1F1FB}\u{1F1EA}' },
    { name: 'Kazakhstan', code: '+7', price: 29.12, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Colombia', code: '+57', price: 20.02, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Paraguay', code: '+595', price: 29.12, countryId: 87, flag: '\u{1F1F5}\u{1F1FE}' },
    { name: 'Turkey', code: '+90', price: 29.12, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Cameroon', code: '+237', price: 8.74, countryId: 41, flag: '\u{1F1E8}\u{1F1F2}' },
    { name: 'Belarus', code: '+375', price: 29.12, countryId: 51, flag: '\u{1F1E7}\u{1F1FE}' },
    { name: 'Bulgaria', code: '+359', price: 30.58, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Moldova', code: '+373', price: 29.12, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Saudi Arabia', code: '+966', price: 1.46, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Thailand', code: '+66', price: 29.12, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Burkina Faso', code: '+226', price: 29.12, countryId: 152, flag: '\u{1F1E7}\u{1F1EB}' },
    { name: 'Belgium', code: '+32', price: 22.93, countryId: 82, flag: '\u{1F1E7}\u{1F1EA}' },
    { name: 'Yemen', code: '+967', price: 20.38, countryId: 30, flag: '\u{1F1FE}\u{1F1EA}' },
    { name: 'Laos', code: '+856', price: 29.12, countryId: 25, flag: '\u{1F1F1}\u{1F1E6}' },
    { name: 'Poland', code: '+48', price: 21.84, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Malaysia', code: '+60', price: 48.78, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Netherlands', code: '+31', price: 13.83, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'UAE', code: '+971', price: 29.12, countryId: 95, flag: '\u{1F1E6}\u{1F1EA}' },
    { name: 'Portugal', code: '+351', price: 29.12, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Switzerland', code: '+41', price: 22.93, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Ireland', code: '+353', price: 21.48, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Estonia', code: '+372', price: 30.58, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Sweden', code: '+46', price: 18.93, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Greece', code: '+30', price: 28.76, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Chile', code: '+56', price: 45.86, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Sierra Leone', code: '+232', price: 27.66, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' },
    { name: 'Slovenia', code: '+386', price: 21.84, countryId: 59, flag: '\u{1F1F8}\u{1F1EE}' },
    { name: 'Liberia', code: '+231', price: 29.12, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Singapore', code: '+65', price: 29.12, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
    { name: 'New Zealand', code: '+64', price: 30.58, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Mongolia', code: '+976', price: 29.12, countryId: 72, flag: '\u{1F1F2}\u{1F1F3}' },
    { name: 'Denmark', code: '+45', price: 30.58, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Australia', code: '', price: 30.21, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'USA Virtual', code: '+1', price: 22.93, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' }
];

const gener8Countries = [];

const gopuffCountries = [];

const feelsCountries = [];

const zuscoffeeCountries = [
    { name: 'Malaysia', code: '+60', price: 23.3, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' }
];

const zoogameCountries = [
    { name: 'Malaysia', code: '+60', price: 28.76, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' }
];

const coffeeteaCountries = [];

const moveitCountries = [];

const prakerjaCountries = [];

const ventenyCountries = [
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const asiamilesCountries = [
    { name: 'Thailand', code: '+66', price: 45.86, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' }
];

const myvalueCountries = [];

const bokuCountries = [
    { name: 'Indonesia', code: '+62', price: 4.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const getplusCountries = [];

const dayaautoCountries = [];

const sharepartyCountries = [];

const indobaCountries = [];

const kemnakerriCountries = [];

const allaccessCountries = [
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const motionpayCountries = [];

const linkajaCountries = [];

const leroymerlinCountries = [];

const bookmyplayCountries = [
    { name: 'India', code: '+91', price: 36.4, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const windsCountries = [
    { name: 'India', code: '+91', price: 36.4, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const rydeCountries = [];

const herCountries = [];

const blankstreetCountries = [
    { name: 'United Kingdom', code: '+44', price: 11.83, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const voiCountries = [
    { name: 'United Kingdom', code: '+44', price: 9.83, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Germany', code: '+49', price: 53.87, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Denmark', code: '+45', price: 146.33, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' }
];

const sonylivCountries = [];

const hanyaCountries = [];

const prenagenclubCountries = [];

const tiketcomCountries = [
    { name: 'USA', code: '+1', price: 42.22, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Canada', code: '+1', price: 9.83, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'United Kingdom', code: '+44', price: 37.86, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Netherlands', code: '+31', price: 19.66, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Chile', code: '+56', price: 18.93, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Portugal', code: '+351', price: 28.76, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Poland', code: '+48', price: 8.37, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Greece', code: '+30', price: 19.66, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'USA Virtual', code: '+1', price: 3.64, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Sweden', code: '+46', price: 6.55, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Austria', code: '+43', price: 131.77, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Denmark', code: '+45', price: 48.78, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Germany', code: '+49', price: 59.7, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Spain', code: '+34', price: 29.12, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Finland', code: '+358', price: 49.5, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'Italy', code: '+39', price: 19.66, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Romania', code: '+40', price: 19.66, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Malaysia', code: '+60', price: 42.22, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'France', code: '+33', price: 19.66, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Kenya', code: '+254', price: 24.02, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Kazakhstan', code: '+7', price: 18.56, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Colombia', code: '+57', price: 12.38, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Belarus', code: '+375', price: 164.16, countryId: 51, flag: '\u{1F1E7}\u{1F1FE}' },
    { name: 'Bulgaria', code: '+359', price: 19.66, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Azerbaijan', code: '+994', price: 33.12, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Moldova', code: '+373', price: 18.2, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Thailand', code: '+66', price: 56.78, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'China', code: '+86', price: 64.43, countryId: 3, flag: '\u{1F1E8}\u{1F1F3}' },
    { name: 'Armenia', code: '+374', price: 33.12, countryId: 148, flag: '\u{1F1E6}\u{1F1F2}' },
    { name: 'Ireland', code: '+353', price: 19.66, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Serbia', code: '+381', price: 19.66, countryId: 29, flag: '\u{1F1F7}\u{1F1F8}' },
    { name: 'Estonia', code: '+372', price: 48.78, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Czech Republic', code: '+420', price: 23.3, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Georgia', code: '+995', price: 28.39, countryId: 128, flag: '\u{1F1EC}\u{1F1EA}' },
    { name: 'Latvia', code: '+371', price: 57.51, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Slovenia', code: '+386', price: 33.85, countryId: 59, flag: '\u{1F1F8}\u{1F1EE}' },
    { name: 'Lithuania', code: '+370', price: 48.78, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'Japan', code: '+81', price: 747.93, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'Croatia', code: '+385', price: 37.49, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'New Zealand', code: '+64', price: 199.47, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Australia', code: '', price: 206.39, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'Gibraltar', code: '+350', price: 219.13, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const easycashCountries = [];

const daganganCountries = [];

const dokuCountries = [];

const lottemartCountries = [];

const chakrarewardsCountries = [
    { name: 'Indonesia', code: '+62', price: 11.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const xworldwalletCountries = [
    { name: 'USA Virtual', code: '+1', price: 37.3, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' }
];

const gomofyCountries = [];

const stockydodoCountries = [
    { name: 'India', code: '+91', price: 29.12, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const meragaonCountries = [];

const gurmanikaCountries = [];

const dikidiCountries = [];

const lydiaCountries = [];

const muzzCountries = [
    { name: 'Indonesia', code: '+62', price: 100, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const ankamaCountries = [
    { name: 'Netherlands', code: '+31', price: 7.28, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' }
];

const profeeCountries = [];

const nice88Countries = [];

const paybisCountries = [
    { name: 'Romania', code: '+40', price: 21.84, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const lionparcelCountries = [];

const getresponseCountries = [];

const remotasksCountries = [
    { name: 'United Kingdom', code: '+44', price: 9.83, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Malaysia', code: '+60', price: 48.78, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Netherlands', code: '+31', price: 12.38, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Canada', code: '+1', price: 53.87, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' }
];

const tierCountries = [
    { name: 'Colombia', code: '+57', price: 15.29, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Malaysia', code: '+60', price: 36.4, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Netherlands', code: '+31', price: 12.38, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' }
];

const greggsCountries = [];

const womplyCountries = [
    { name: 'USA', code: '+1', price: 72.8, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const pcipayCountries = [];

const battlestategamesCountries = [
    { name: 'United Kingdom', code: '+44', price: 5.46, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'France', code: '+33', price: 4, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const ackoCountries = [
    { name: 'India', code: '+91', price: 36.4, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const sbicardCountries = [];

const wooplusCountries = [
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'USA', code: '+1', price: 224.22, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const vercelCountries = [
    { name: 'United Kingdom', code: '+44', price: 4, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'USA', code: '+1', price: 46.59, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const discoverhongkongCountries = [];

const smartCountries = [
    { name: 'Philippines', code: '+63', price: 38.58, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' }
];

const segariCountries = [];

const bcgameCountries = [
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const vidaCountries = [
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const nutriclubCountries = [];

const bebeclubCountries = [
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const punjabcitizenCountries = [];

const teamoruCountries = [];

const gordanCountries = [];

const mitidCountries = [];

const moneyviewCountries = [];

const sheinCountries = [
    { name: 'USA', code: '+1', price: 81.54, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'United Kingdom', code: '+44', price: 9.83, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'India', code: '+91', price: 27.3, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Malaysia', code: '+60', price: 36.4, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' }
];

const supercellCountries = [
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Malaysia', code: '+60', price: 42.95, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'India', code: '+91', price: 24.02, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Netherlands', code: '+31', price: 10.19, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' }
];

const varusCountries = [
    { name: 'Ukraine', code: '+380', price: 38.58, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' }
];

const coinfantasyCountries = [];

const pyyplCountries = [];

const migrosCountries = [];

const xboxCountries = [
    { name: 'South Africa', code: '+27', price: 1.46, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Germany', code: '+49', price: 8.74, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Ukraine', code: '+380', price: 2.18, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Poland', code: '+48', price: 2.18, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Malaysia', code: '+60', price: 48.78, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' }
];

const yellowCountries = [];

const satuCountries = [];

const openbudjetCountries = [];

const sonolCountries = [];

const yudaCountries = [];

const googlemessengerCountries = [
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Austria', code: '+43', price: 242.79, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Brazil', code: '+55', price: 28.76, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'South Africa', code: '+27', price: 2.18, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'India', code: '+91', price: 54.6, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Pakistan', code: '+92', price: 182.73, countryId: 66, flag: '\u{1F1F5}\u{1F1F0}' },
    { name: 'Bangladesh', code: '+880', price: 182.73, countryId: 60, flag: '\u{1F1E7}\u{1F1E9}' },
    { name: 'Zambia', code: '+260', price: 182.73, countryId: 147, flag: '\u{1F1FF}\u{1F1F2}' },
    { name: 'Namibia', code: '+264', price: 182.73, countryId: 138, flag: '\u{1F1F3}\u{1F1E6}' },
    { name: 'Algeria', code: '+213', price: 182.73, countryId: 58, flag: '\u{1F1E9}\u{1F1FF}' },
    { name: 'Ethiopia', code: '+251', price: 182.73, countryId: 71, flag: '\u{1F1EA}\u{1F1F9}' },
    { name: 'Mozambique', code: '+258', price: 182.73, countryId: 80, flag: '\u{1F1F2}\u{1F1FF}' },
    { name: 'Angola', code: '+244', price: 182.73, countryId: 76, flag: '\u{1F1E6}\u{1F1F4}' },
    { name: 'Ukraine', code: '+380', price: 364, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'Egypt', code: '+20', price: 182.73, countryId: 21, flag: '\u{1F1EA}\u{1F1EC}' },
    { name: 'Haiti', code: '+509', price: 182.73, countryId: 26, flag: '\u{1F1ED}\u{1F1F9}' },
    { name: 'Iran', code: '+98', price: 182.73, countryId: 57, flag: '\u{1F1EE}\u{1F1F7}' },
    { name: 'Peru', code: '+51', price: 182.73, countryId: 65, flag: '\u{1F1F5}\u{1F1EA}' },
    { name: 'Vietnam', code: '+84', price: 57.51, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' },
    { name: 'Zimbabwe', code: '+263', price: 182.73, countryId: 96, flag: '\u{1F1FF}\u{1F1FC}' },
    { name: 'Nepal', code: '+977', price: 182.73, countryId: 81, flag: '\u{1F1F3}\u{1F1F5}' },
    { name: 'Uzbekistan', code: '+998', price: 182.73, countryId: 40, flag: '\u{1F1FA}\u{1F1FF}' },
    { name: 'Nigeria', code: '+234', price: 182.73, countryId: 19, flag: '\u{1F1F3}\u{1F1EC}' },
    { name: 'France', code: '+33', price: 273.36, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Botswana', code: '+267', price: 182.73, countryId: 123, flag: '\u{1F1E7}\u{1F1FC}' },
    { name: 'Mexico', code: '+52', price: 182.73, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Tanzania', code: '+255', price: 182.73, countryId: 9, flag: '\u{1F1F9}\u{1F1FF}' },
    { name: 'Sri Lanka', code: '+94', price: 182.73, countryId: 64, flag: '\u{1F1F1}\u{1F1F0}' },
    { name: 'Honduras', code: '+504', price: 182.73, countryId: 88, flag: '\u{1F1ED}\u{1F1F3}' },
    { name: 'Argentina', code: '+54', price: 1.46, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Myanmar', code: '+95', price: 182.73, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'Tunisia', code: '+216', price: 182.73, countryId: 89, flag: '\u{1F1F9}\u{1F1F3}' },
    { name: 'Lesotho', code: '+266', price: 182.73, countryId: 136, flag: '\u{1F1F1}\u{1F1F8}' },
    { name: 'Ecuador', code: '+593', price: 182.73, countryId: 105, flag: '\u{1F1EA}\u{1F1E8}' },
    { name: 'El Salvador', code: '+503', price: 182.73, countryId: 101, flag: '\u{1F1F8}\u{1F1FB}' },
    { name: 'Morocco', code: '+212', price: 364, countryId: 37, flag: '\u{1F1F2}\u{1F1E6}' },
    { name: 'Uganda', code: '+256', price: 182.73, countryId: 75, flag: '\u{1F1FA}\u{1F1EC}' },
    { name: 'Malawi', code: '+265', price: 182.73, countryId: 137, flag: '\u{1F1F2}\u{1F1FC}' },
    { name: 'Ghana', code: '+233', price: 182.73, countryId: 38, flag: '\u{1F1EC}\u{1F1ED}' },
    { name: 'Kenya', code: '+254', price: 182.73, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Panama', code: '+507', price: 182.73, countryId: 112, flag: '\u{1F1F5}\u{1F1E6}' },
    { name: 'Jamaica', code: '+1', price: 182.73, countryId: 103, flag: '\u{1F1EF}\u{1F1F2}' },
    { name: 'Venezuela', code: '+58', price: 182.73, countryId: 70, flag: '\u{1F1FB}\u{1F1EA}' },
    { name: 'Kazakhstan', code: '+7', price: 364, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Colombia', code: '+57', price: 140.14, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Paraguay', code: '+595', price: 182.73, countryId: 87, flag: '\u{1F1F5}\u{1F1FE}' },
    { name: 'Turkey', code: '+90', price: 182.73, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'Kyrgyzstan', code: '+996', price: 182.73, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' },
    { name: 'Jordan', code: '+962', price: 182.73, countryId: 116, flag: '\u{1F1EF}\u{1F1F4}' },
    { name: 'Cameroon', code: '+237', price: 182.73, countryId: 41, flag: '\u{1F1E8}\u{1F1F2}' },
    { name: 'Israel', code: '', price: 658.11, countryId: 13, flag: '\u{1F1EE}\u{1F1F1}' },
    { name: 'Ivory Coast', code: '+225', price: 182.73, countryId: 27, flag: '\u{1F1E8}\u{1F1EE}' },
    { name: 'Belarus', code: '+375', price: 182.73, countryId: 51, flag: '\u{1F1E7}\u{1F1FE}' },
    { name: 'Bulgaria', code: '+359', price: 250.07, countryId: 83, flag: '\u{1F1E7}\u{1F1EC}' },
    { name: 'Mauritius', code: '+230', price: 182.73, countryId: 157, flag: '\u{1F1F2}\u{1F1FA}' },
    { name: 'Turkmenistan', code: '+993', price: 182.73, countryId: 161, flag: '\u{1F1F9}\u{1F1F2}' },
    { name: 'Azerbaijan', code: '+994', price: 182.73, countryId: 35, flag: '\u{1F1E6}\u{1F1FF}' },
    { name: 'Mali', code: '+223', price: 182.73, countryId: 69, flag: '\u{1F1F2}\u{1F1F1}' },
    { name: 'Rwanda', code: '+250', price: 182.73, countryId: 140, flag: '\u{1F1F7}\u{1F1FC}' },
    { name: 'Gabon', code: '+241', price: 182.73, countryId: 154, flag: '\u{1F1EC}\u{1F1E6}' },
    { name: 'Spain', code: '+34', price: 268.63, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Nicaragua', code: '+505', price: 182.73, countryId: 90, flag: '\u{1F1F3}\u{1F1EE}' },
    { name: 'Moldova', code: '+373', price: 182.73, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'USA', code: '+1', price: 182.73, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Saudi Arabia', code: '+966', price: 182.73, countryId: 53, flag: '\u{1F1F8}\u{1F1E6}' },
    { name: 'Belgium', code: '+32', price: 136.86, countryId: 82, flag: '\u{1F1E7}\u{1F1EA}' },
    { name: 'Benin', code: '+229', price: 182.73, countryId: 120, flag: '\u{1F1E7}\u{1F1EF}' },
    { name: 'Burkina Faso', code: '+226', price: 182.73, countryId: 152, flag: '\u{1F1E7}\u{1F1EB}' },
    { name: 'Costa Rica', code: '+506', price: 182.73, countryId: 93, flag: '\u{1F1E8}\u{1F1F7}' },
    { name: 'Germany', code: '+49', price: 364, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Iraq', code: '+964', price: 182.73, countryId: 47, flag: '\u{1F1EE}\u{1F1F6}' },
    { name: 'Laos', code: '+856', price: 18.27, countryId: 25, flag: '\u{1F1F1}\u{1F1E6}' },
    { name: 'Oman', code: '+968', price: 182.73, countryId: 107, flag: '\u{1F1F4}\u{1F1F2}' },
    { name: 'Poland', code: '+48', price: 364, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Qatar', code: '+974', price: 182.73, countryId: 111, flag: '\u{1F1F6}\u{1F1E6}' },
    { name: 'Reunion', code: '+262', price: 182.73, countryId: 146, flag: '\u{1F1F7}\u{1F1EA}' },
    { name: 'Senegal', code: '+221', price: 18.27, countryId: 61, flag: '\u{1F1F8}\u{1F1F3}' },
    { name: 'Thailand', code: '+66', price: 182.73, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'United Kingdom', code: '+44', price: 98.64, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Uruguay', code: '+598', price: 182.73, countryId: 156, flag: '\u{1F1FA}\u{1F1FE}' },
    { name: 'Yemen', code: '+967', price: 182.73, countryId: 30, flag: '\u{1F1FE}\u{1F1EA}' },
    { name: 'Afghanistan', code: '+93', price: 182.73, countryId: 74, flag: '\u{1F1E6}\u{1F1EB}' },
    { name: 'Armenia', code: '+374', price: 182.73, countryId: 148, flag: '\u{1F1E6}\u{1F1F2}' },
    { name: 'Barbados', code: '+1', price: 182.73, countryId: 118, flag: '\u{1F1E7}\u{1F1E7}' },
    { name: 'Burundi', code: '+257', price: 182.73, countryId: 119, flag: '\u{1F1E7}\u{1F1EE}' },
    { name: 'Cambodia', code: '+855', price: 182.73, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' },
    { name: 'Chad', code: '+235', price: 182.73, countryId: 42, flag: '\u{1F1F9}\u{1F1E9}' },
    { name: 'Equatorial Guinea', code: '+240', price: 182.73, countryId: 167, flag: '\u{1F1EC}\u{1F1F6}' },
    { name: 'Gambia', code: '+220', price: 182.73, countryId: 28, flag: '\u{1F1EC}\u{1F1F2}' },
    { name: 'Guinea-Bissau', code: '+245', price: 182.73, countryId: 130, flag: '\u{1F1EC}\u{1F1FC}' },
    { name: 'Guyana', code: '+592', price: 182.73, countryId: 131, flag: '\u{1F1EC}\u{1F1FE}' },
    { name: 'Hungary', code: '+36', price: 182.73, countryId: 84, flag: '\u{1F1ED}\u{1F1FA}' },
    { name: 'Kuwait', code: '+965', price: 182.73, countryId: 100, flag: '\u{1F1F0}\u{1F1FC}' },
    { name: 'Malaysia', code: '+60', price: 182.73, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Maldives', code: '+960', price: 182.73, countryId: 159, flag: '\u{1F1F2}\u{1F1FB}' },
    { name: 'Mauritania', code: '+222', price: 182.73, countryId: 114, flag: '\u{1F1F2}\u{1F1F7}' },
    { name: 'Netherlands', code: '+31', price: 82.26, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Niger', code: '+227', price: 182.73, countryId: 139, flag: '\u{1F1F3}\u{1F1EA}' },
    { name: 'Philippines', code: '+63', price: 364, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Portugal', code: '+351', price: 120.85, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Somalia', code: '+252', price: 182.73, countryId: 149, flag: '\u{1F1F8}\u{1F1F4}' },
    { name: 'South Sudan', code: '+211', price: 182.73, countryId: 177, flag: '\u{1F1F8}\u{1F1F8}' },
    { name: 'Switzerland', code: '+41', price: 127.76, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' },
    { name: 'Togo', code: '+228', price: 182.73, countryId: 99, flag: '\u{1F1F9}\u{1F1EC}' },
    { name: 'Puerto Rico', code: '+1', price: 182.73, countryId: 97, flag: '\u{1F1F5}\u{1F1F7}' },
    { name: 'Ireland', code: '+353', price: 182.73, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Serbia', code: '+381', price: 182.73, countryId: 29, flag: '\u{1F1F7}\u{1F1F8}' },
    { name: 'Estonia', code: '+372', price: 364, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'Bahrain', code: '+973', price: 182.73, countryId: 145, flag: '\u{1F1E7}\u{1F1ED}' },
    { name: 'Czech Republic', code: '+420', price: 364, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Guadeloupe', code: '+590', price: 182.73, countryId: 160, flag: '\u{1F1EC}\u{1F1F5}' },
    { name: 'Norway', code: '+47', price: 182.73, countryId: 174, flag: '\u{1F1F3}\u{1F1F4}' },
    { name: 'Italy', code: '+39', price: 143.42, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Cyprus', code: '+357', price: 364, countryId: 77, flag: '\u{1F1E8}\u{1F1FE}' },
    { name: 'Luxembourg', code: '+352', price: 182.73, countryId: 165, flag: '\u{1F1F1}\u{1F1FA}' },
    { name: 'Suriname', code: '+597', price: 182.73, countryId: 142, flag: '\u{1F1F8}\u{1F1F7}' },
    { name: 'Guatemala', code: '+502', price: 182.73, countryId: 94, flag: '\u{1F1EC}\u{1F1F9}' },
    { name: 'Madagascar', code: '+261', price: 182.73, countryId: 17, flag: '\u{1F1F2}\u{1F1EC}' },
    { name: 'Sweden', code: '+46', price: 6.55, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Djibouti', code: '+253', price: 182.73, countryId: 168, flag: '\u{1F1E9}\u{1F1EF}' },
    { name: 'Finland', code: '+358', price: 182.73, countryId: 163, flag: '\u{1F1EB}\u{1F1EE}' },
    { name: 'French Guiana', code: '+594', price: 182.73, countryId: 162, flag: '\u{1F1EC}\u{1F1EB}' },
    { name: 'Saint Lucia', code: '+1', price: 182.73, countryId: 164, flag: '\u{1F1F1}\u{1F1E8}' },
    { name: 'Montenegro', code: '+382', price: 182.73, countryId: 171, flag: '\u{1F1F2}\u{1F1EA}' },
    { name: 'Canada', code: '+1', price: 47.68, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Cuba', code: '+53', price: 182.73, countryId: 113, flag: '\u{1F1E8}\u{1F1FA}' },
    { name: 'Greece', code: '+30', price: 364, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Chile', code: '+56', price: 48.78, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Albania', code: '+355', price: 182.73, countryId: 155, flag: '\u{1F1E6}\u{1F1F1}' },
    { name: 'Slovenia', code: '+386', price: 364, countryId: 59, flag: '\u{1F1F8}\u{1F1EE}' },
    { name: 'Hong Kong', code: '+852', price: 182.73, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Taiwan', code: '+886', price: 182.73, countryId: 55, flag: '\u{1F1F9}\u{1F1FC}' },
    { name: 'Lithuania', code: '+370', price: 182.73, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'Liberia', code: '+231', price: 182.73, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Guinea', code: '+224', price: 182.73, countryId: 68, flag: '\u{1F1EC}\u{1F1F3}' },
    { name: 'Aruba', code: '+297', price: 182.73, countryId: 179, flag: '\u{1F1E6}\u{1F1FC}' },
    { name: 'Comoros', code: '+269', price: 182.73, countryId: 133, flag: '\u{1F1F0}\u{1F1F2}' },
    { name: 'Singapore', code: '+65', price: 182.73, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
    { name: 'Slovakia', code: '+421', price: 182.73, countryId: 141, flag: '\u{1F1F8}\u{1F1F0}' },
    { name: 'Sao Tome and Principe', code: '+239', price: 182.73, countryId: 178, flag: '\u{1F1F8}\u{1F1F9}' },
    { name: 'Fiji', code: '+679', price: 182.73, countryId: 189, flag: '\u{1F1EB}\u{1F1EF}' },
    { name: 'Croatia', code: '+385', price: 364, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'Cape Verde', code: '+238', price: 182.73, countryId: 186, flag: '\u{1F1E8}\u{1F1FB}' },
    { name: 'Monaco', code: '+377', price: 182.73, countryId: 144, flag: '\u{1F1F2}\u{1F1E8}' },
    { name: 'Macedonia', code: '+389', price: 182.73, countryId: 183, flag: '\u{1F1F2}\u{1F1F0}' },
    { name: 'Belize', code: '+501', price: 182.73, countryId: 124, flag: '\u{1F1E7}\u{1F1FF}' },
    { name: 'New Caledonia', code: '+687', price: 182.73, countryId: 185, flag: '\u{1F1F3}\u{1F1E8}' },
    { name: 'New Zealand', code: '+64', price: 182.73, countryId: 67, flag: '\u{1F1F3}\u{1F1FF}' },
    { name: 'Mongolia', code: '+976', price: 182.73, countryId: 72, flag: '\u{1F1F2}\u{1F1F3}' },
    { name: 'Lebanon', code: '+961', price: 182.73, countryId: 153, flag: '\u{1F1F1}\u{1F1E7}' },
    { name: 'Denmark', code: '+45', price: 182.73, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Georgia', code: '+995', price: 315.59, countryId: 128, flag: '\u{1F1EC}\u{1F1EA}' },
    { name: 'Sierra Leone', code: '+232', price: 182.73, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' },
    { name: 'Bahamas', code: '+1', price: 182.73, countryId: 122, flag: '\u{1F1E7}\u{1F1F8}' },
    { name: 'Bolivia', code: '+591', price: 182.73, countryId: 92, flag: '\u{1F1E7}\u{1F1F4}' },
    { name: 'Grenada', code: '+1', price: 182.73, countryId: 127, flag: '\u{1F1EC}\u{1F1E9}' },
    { name: 'Latvia', code: '+371', price: 182.73, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Tajikistan', code: '+992', price: 182.73, countryId: 143, flag: '\u{1F1F9}\u{1F1EF}' },
    { name: 'Brunei Darussalam', code: '+673', price: 182.73, countryId: 121, flag: '\u{1F1E7}\u{1F1F3}' },
    { name: 'Cayman Islands', code: '+1', price: 182.73, countryId: 170, flag: '\u{1F1F0}\u{1F1FE}' },
    { name: 'Australia', code: '', price: 182.73, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'Seychelles', code: '+248', price: 182.73, countryId: 184, flag: '\u{1F1F8}\u{1F1E8}' },
    { name: 'Montserrat', code: '+1', price: 182.73, countryId: 180, flag: '\u{1F1F2}\u{1F1F8}' },
    { name: 'Dominica', code: '+1', price: 182.73, countryId: 126, flag: '\u{1F1E9}\u{1F1F2}' },
    { name: 'Iceland', code: '+354', price: 182.73, countryId: 132, flag: '\u{1F1EE}\u{1F1F8}' },
    { name: 'Eritrea', code: '+291', price: 18.27, countryId: 176, flag: '\u{1F1EA}\u{1F1F7}' },
    { name: 'Gibraltar', code: '+350', price: 18.27, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' }
];

const fastwinCountries = [];

const mediaexpressCountries = [];

const getsbetCountries = [
    { name: 'Romania', code: '+40', price: 28.76, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' }
];

const bingoplusCountries = [
    { name: 'Philippines', code: '+63', price: 26.94, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' }
];

const branchCountries = [
    { name: 'USA', code: '+1', price: 72.8, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const pokercircleCountries = [];

const radquestCountries = [
    { name: 'Colombia', code: '+57', price: 42.95, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'USA', code: '+1', price: 483.03, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'United Kingdom', code: '+44', price: 45.86, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Chile', code: '+56', price: 1.46, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' }
];

const hicardCountries = [];

const ludoplusCountries = [];

const confirmtktCountries = [];

const matchcomCountries = [];

const verasightCountries = [
    { name: 'USA', code: '+1', price: 72.8, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const goagamesCountries = [];

const betininCountries = [];

const tealiveCountries = [];

const busqoCountries = [
    { name: 'Colombia', code: '+57', price: 24.75, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' }
];

const nuumruCountries = [];

const metauaCountries = [];

const narendramodiCountries = [];

const namaskarCountries = [];

const tajrummyCountries = [];

const happypancakeCountries = [];

const keetaCountries = [];

const hdfcegroCountries = [];

const tomorocoffeeCountries = [];

const fivesurveysCountries = [];

const benjaminCountries = [
    { name: 'USA', code: '+1', price: 109.2, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const dingCountries = [];

const theasianparentCountries = [];

const tunestudioCountries = [
    { name: 'South Africa', code: '+27', price: 1.46, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Colombia', code: '+57', price: 4.37, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'United Kingdom', code: '+44', price: 7.28, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Indonesia', code: '+62', price: 7.28, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const talabatCountries = [];

const hpgasCountries = [];

const lolooCountries = [];

const olxkzCountries = [];

const olxuaCountries = [];

const olxplCountries = [];

const talkatoneCountries = [];

const etsyCountries = [
    { name: 'Spain', code: '+34', price: 181.64, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'South Africa', code: '+27', price: 24.39, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Brazil', code: '+55', price: 2.18, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'USA', code: '+1', price: 92.46, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'United Kingdom', code: '+44', price: 182, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Poland', code: '+48', price: 242.79, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Portugal', code: '+351', price: 242.79, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Romania', code: '+40', price: 72.8, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' }
];

const olxroCountries = [];

const olxbgCountries = [];

const olxptCountries = [];

const githubCountries = [];

const olxuzCountries = [];

const streamlabsCountries = [];

const unstopCountries = [];

const stanCountries = [];

const swarailCountries = [];

const magicpinCountries = [];

const fiftyoneexchCountries = [
    { name: 'Indonesia', code: '+62', price: 100, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const truemoneyCountries = [
    { name: 'Cambodia', code: '+855', price: 48.78, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' }
];

const innopayCountries = [];

const hypermartCountries = [];

const vision11Countries = [
    { name: 'India', code: '+91', price: 24.39, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const saathiCountries = [];

const capitaloneCountries = [
    { name: 'USA', code: '+1', price: 34.22, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Canada', code: '+1', price: 32.4, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'United Kingdom', code: '+44', price: 15.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const bingo101Countries = [
    { name: 'India', code: '+91', price: 30.58, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const efsaneCountries = [
    { name: 'Turkey', code: '+90', price: 900.07, countryId: 62, flag: '\u{1F1F9}\u{1F1F7}' },
    { name: 'United Kingdom', code: '+44', price: 15.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const rapidoCountries = [];

const sixerCountries = [
    { name: 'India', code: '+91', price: 24.39, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const omnicardCountries = [];

const shopsyCountries = [];

const collegepulseCountries = [];

const creditkarmaCountries = [];

const gaintplayCountries = [
    { name: 'USA', code: '+1', price: 68.07, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const trapcallCountries = [
    { name: 'USA', code: '+1', price: 92.46, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const kudosCountries = [];

const resyCountries = [];

const blastbucksCountries = [
    { name: 'USA', code: '+1', price: 188.55, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const timewallCountries = [
    { name: 'USA', code: '+1', price: 92.46, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const sidelineCountries = [];

const junoCountries = [];

const chaseCountries = [];

const dutchbrosCountries = [];

const centurylinkCountries = [];

const threefunCountries = [
    { name: 'USA', code: '+1', price: 68, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const ibottaCountries = [];

const acimaCountries = [
    { name: 'USA', code: '+1', price: 238.06, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const aspirationCountries = [
    { name: 'USA', code: '+1', price: 383.66, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const ring4Countries = [
    { name: 'USA', code: '+1', price: 68.07, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const taimiCountries = [];

const pelagoCountries = [
    { name: 'USA', code: '+1', price: 238.06, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const tumblrCountries = [];

const audibleCountries = [];

const rapidapiCountries = [];

const serpapiCountries = [];

const bosslikeCountries = [];

const fmcpayCountries = [];

const rummyyesCountries = [];

const wallapopCountries = [];

const mmliveCountries = [];

const redditCountries = [
    { name: 'USA', code: '+1', price: 169.99, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const winclashCountries = [
    { name: 'India', code: '+91', price: 30.58, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const outlierCountries = [];

const courtyardCountries = [];

const turbotenantCountries = [
    { name: 'USA', code: '+1', price: 92.46, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const bridgemoneyCountries = [
    { name: 'USA', code: '+1', price: 238.06, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const zillowCountries = [
    { name: 'USA', code: '+1', price: 52.42, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const seatgeekCountries = [
    { name: 'USA', code: '+1', price: 48.78, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const daveCountries = [];

const getholdingsCountries = [
    { name: 'USA', code: '+1', price: 450.63, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const rednotexiaohongshuCountries = [];

const docusignCountries = [
    { name: 'Latvia', code: '+371', price: 30.58, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Indonesia', code: '+62', price: 11.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Chile', code: '+56', price: 22.57, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Romania', code: '+40', price: 15.29, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Argentina', code: '+54', price: 11.46, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Spain', code: '+34', price: 18.2, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Philippines', code: '+63', price: 12.83, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'USA', code: '+1', price: 29.85, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Netherlands', code: '+31', price: 19.83, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'United Kingdom', code: '+44', price: 5.1, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const qponCountries = [];

const starexchCountries = [
    { name: 'India', code: '+91', price: 48.78, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const playkaro247Countries = [];

const spinwinnerCountries = [];

const atlasearthCountries = [
    { name: 'Chile', code: '+56', price: 22.93, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Netherlands', code: '+31', price: 7.28, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'United Kingdom', code: '+44', price: 2.55, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'Colombia', code: '+57', price: 17.47, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Philippines', code: '+63', price: 17.47, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' }
];

const instamatchCountries = [];

const ludo11Countries = [];

const truemedsCountries = [];

const nykaaCountries = [];

const rozrummyCountries = [];

const paisabazaarCountries = [];

const huionepayCountries = [
    { name: 'Cambodia', code: '+855', price: 79.35, countryId: 24, flag: '\u{1F1F0}\u{1F1ED}' },
    { name: 'Thailand', code: '+66', price: 60.8, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'United Kingdom', code: '+44', price: 14.56, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const skillsCountries = [];

const cursorCountries = [];

const awsCountries = [
    { name: 'USA', code: '+1', price: 21.84, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const goldsbetCountries = [];

const cricbuzzCountries = [];

const royaljeetCountries = [];

const quokaCountries = [];

const fivehundredpxCountries = [
    { name: 'Indonesia', code: '+62', price: 100, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const bigbasketCountries = [
    { name: 'India', code: '+91', price: 24.39, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const googlechatCountries = [
    { name: 'Algeria', code: '+213', price: 5.1, countryId: 58, flag: '\u{1F1E9}\u{1F1FF}' },
    { name: 'Angola', code: '+244', price: 48.78, countryId: 76, flag: '\u{1F1E6}\u{1F1F4}' },
    { name: 'Argentina', code: '+54', price: 1.46, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Australia', code: '', price: 145.6, countryId: 175, flag: '\u{1F1E6}\u{1F1FA}' },
    { name: 'Austria', code: '+43', price: 76.44, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Brazil', code: '+55', price: 48.78, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Cameroon', code: '+237', price: 54.96, countryId: 41, flag: '\u{1F1E8}\u{1F1F2}' },
    { name: 'Canada', code: '+1', price: 54.6, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Chile', code: '+56', price: 24.75, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Colombia', code: '+57', price: 5.1, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'Congo (Dem. Republic)', code: '+243', price: 48.78, countryId: 18, flag: '\u{1F1E8}\u{1F1E9}' },
    { name: 'Czech Republic', code: '+420', price: 92.46, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Estonia', code: '+372', price: 455, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'France', code: '+33', price: 79.17, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Germany', code: '+49', price: 66.59, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Greece', code: '+30', price: 82.63, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Hong Kong', code: '+852', price: 38.58, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'India', code: '+91', price: 72.8, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Indonesia', code: '+62', price: 2.18, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Israel', code: '', price: 658.11, countryId: 13, flag: '\u{1F1EE}\u{1F1F1}' },
    { name: 'Italy', code: '+39', price: 82.63, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Japan', code: '+81', price: 534.8, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'Laos', code: '+856', price: 121.94, countryId: 25, flag: '\u{1F1F1}\u{1F1E6}' },
    { name: 'Latvia', code: '+371', price: 1241.97, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Liberia', code: '+231', price: 115.75, countryId: 135, flag: '\u{1F1F1}\u{1F1F7}' },
    { name: 'Malaysia', code: '+60', price: 32.76, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Moldova', code: '+373', price: 145.6, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Netherlands', code: '+31', price: 63.34, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Philippines', code: '+63', price: 52.78, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Portugal', code: '+351', price: 73.89, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Romania', code: '+40', price: 5.1, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Sierra Leone', code: '+232', price: 73.89, countryId: 115, flag: '\u{1F1F8}\u{1F1F1}' },
    { name: 'Slovenia', code: '+386', price: 54.96, countryId: 59, flag: '\u{1F1F8}\u{1F1EE}' },
    { name: 'South Africa', code: '+27', price: 18.56, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Spain', code: '+34', price: 31.3, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Sweden', code: '+46', price: 72.8, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Thailand', code: '+66', price: 88.09, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Ukraine', code: '+380', price: 39.31, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'United Kingdom', code: '+44', price: 4.88, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'USA', code: '+1', price: 341.43, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Vietnam', code: '+84', price: 27.66, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' }
];

const winmatchCountries = [
    { name: 'India', code: '+91', price: 24.39, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const chipotleCountries = [
    { name: 'USA Virtual', code: '+1', price: 19.65, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'USA', code: '+1', price: 39.66, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Canada', code: '+1', price: 22.93, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' }
];

const wellsfargoCountries = [
    { name: 'USA', code: '+1', price: 737.1, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const govinda365Countries = [];

const woohooCountries = [
    { name: 'India', code: '+91', price: 24.39, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const firstgamesCountries = [];

const kickcashCountries = [];

const aadharCountries = [
    { name: 'Indonesia', code: '+62', price: 100, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const shriramoneCountries = [];

const pokemonCountries = [];

const naukriCountries = [];

const okwinCountries = [];

const sharechatCountries = [];

const dreammoneyCountries = [];

const konvyCountries = [];

const milanunciosCountries = [];

const kliqCountries = [
    { name: 'Argentina', code: '+54', price: 1.46, countryId: 39, flag: '\u{1F1E6}\u{1F1F7}' },
    { name: 'Brazil', code: '+55', price: 6.92, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Cameroon', code: '+237', price: 52.42, countryId: 41, flag: '\u{1F1E8}\u{1F1F2}' },
    { name: 'Canada', code: '+1', price: 54.96, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Chile', code: '+56', price: 72.8, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Colombia', code: '+57', price: 44.77, countryId: 33, flag: '\u{1F1E8}\u{1F1F4}' },
    { name: 'France', code: '+33', price: 54.96, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Italy', code: '+39', price: 54.96, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Malaysia', code: '+60', price: 72.8, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Morocco', code: '+212', price: 54.96, countryId: 37, flag: '\u{1F1F2}\u{1F1E6}' },
    { name: 'Netherlands', code: '+31', price: 14.56, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Philippines', code: '+63', price: 54.96, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'South Africa', code: '+27', price: 11.28, countryId: 31, flag: '\u{1F1FF}\u{1F1E6}' },
    { name: 'Spain', code: '+34', price: 49.14, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'United Kingdom', code: '+44', price: 33.12, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'USA', code: '+1', price: 51.69, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'USA Virtual', code: '+1', price: 54.96, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' }
];

const jiagu360Countries = [];

const whatnotCountries = [
    { name: 'Netherlands', code: '+31', price: 20.02, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' }
];

const atisuCountries = [
    { name: 'Kazakhstan', code: '+7', price: 38.95, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Ukraine', code: '+380', price: 29.12, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' }
];

const creditmantriCountries = [];

const credCountries = [];

const qqliveCountries = [];

const clubggCountries = [
    { name: 'Austria', code: '+43', price: 50.96, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'Brazil', code: '+55', price: 1.46, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' },
    { name: 'Chile', code: '+56', price: 2.18, countryId: 151, flag: '\u{1F1E8}\u{1F1F1}' },
    { name: 'Croatia', code: '+385', price: 2.18, countryId: 45, flag: '\u{1F1ED}\u{1F1F7}' },
    { name: 'Cyprus', code: '+357', price: 2.18, countryId: 77, flag: '\u{1F1E8}\u{1F1FE}' },
    { name: 'Czech Republic', code: '+420', price: 16.74, countryId: 63, flag: '\u{1F1E8}\u{1F1FF}' },
    { name: 'Denmark', code: '+45', price: 2.18, countryId: 172, flag: '\u{1F1E9}\u{1F1F0}' },
    { name: 'Ecuador', code: '+593', price: 2.18, countryId: 105, flag: '\u{1F1EA}\u{1F1E8}' },
    { name: 'Estonia', code: '+372', price: 2.18, countryId: 34, flag: '\u{1F1EA}\u{1F1EA}' },
    { name: 'France', code: '+33', price: 16.38, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Germany', code: '+49', price: 18.93, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' },
    { name: 'Gibraltar', code: '+350', price: 847.76, countryId: 201, flag: '\u{1F1EC}\u{1F1EE}' },
    { name: 'Greece', code: '+30', price: 2.18, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' },
    { name: 'Hong Kong', code: '+852', price: 2.18, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' },
    { name: 'Indonesia', code: '+62', price: 1.46, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' },
    { name: 'Ireland', code: '+353', price: 2.18, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Italy', code: '+39', price: 47.32, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Japan', code: '+81', price: 1073.07, countryId: 1001, flag: '\u{1F1EF}\u{1F1F5}' },
    { name: 'Kazakhstan', code: '+7', price: 2.18, countryId: 2, flag: '\u{1F1F0}\u{1F1FF}' },
    { name: 'Kenya', code: '+254', price: 2.18, countryId: 8, flag: '\u{1F1F0}\u{1F1EA}' },
    { name: 'Kosovo', code: '+383', price: 2.18, countryId: 1004, flag: '\u{1F1FD}\u{1F1F0}' },
    { name: 'Kyrgyzstan', code: '+996', price: 6.92, countryId: 11, flag: '\u{1F1F0}\u{1F1EC}' },
    { name: 'Latvia', code: '+371', price: 2.18, countryId: 49, flag: '\u{1F1F1}\u{1F1FB}' },
    { name: 'Lithuania', code: '+370', price: 121.58, countryId: 44, flag: '\u{1F1F1}\u{1F1F9}' },
    { name: 'Malaysia', code: '+60', price: 35.67, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' },
    { name: 'Mexico', code: '+52', price: 16.74, countryId: 54, flag: '\u{1F1F2}\u{1F1FD}' },
    { name: 'Moldova', code: '+373', price: 2.18, countryId: 85, flag: '\u{1F1F2}\u{1F1E9}' },
    { name: 'Myanmar', code: '+95', price: 35.67, countryId: 5, flag: '\u{1F1F2}\u{1F1F2}' },
    { name: 'Netherlands', code: '+31', price: 2.18, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Philippines', code: '+63', price: 17.47, countryId: 4, flag: '\u{1F1F5}\u{1F1ED}' },
    { name: 'Poland', code: '+48', price: 2.18, countryId: 15, flag: '\u{1F1F5}\u{1F1F1}' },
    { name: 'Portugal', code: '+351', price: 2.18, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Romania', code: '+40', price: 1.46, countryId: 32, flag: '\u{1F1F7}\u{1F1F4}' },
    { name: 'Singapore', code: '+65', price: 2.18, countryId: 196, flag: '\u{1F1F8}\u{1F1EC}' },
    { name: 'Slovenia', code: '+386', price: 12.18, countryId: 59, flag: '\u{1F1F8}\u{1F1EE}' },
    { name: 'Spain', code: '+34', price: 12.18, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Sweden', code: '+46', price: 6.55, countryId: 46, flag: '\u{1F1F8}\u{1F1EA}' },
    { name: 'Tajikistan', code: '+992', price: 6.92, countryId: 143, flag: '\u{1F1F9}\u{1F1EF}' },
    { name: 'Thailand', code: '+66', price: 13.28, countryId: 52, flag: '\u{1F1F9}\u{1F1ED}' },
    { name: 'Ukraine', code: '+380', price: 11.71, countryId: 1, flag: '\u{1F1FA}\u{1F1E6}' },
    { name: 'United Kingdom', code: '+44', price: 2.18, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' },
    { name: 'USA', code: '+1', price: 67.34, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'USA Virtual', code: '+1', price: 3.64, countryId: 12, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'Vietnam', code: '+84', price: 35.67, countryId: 10, flag: '\u{1F1FB}\u{1F1F3}' }
];

const polloaiCountries = [];

const tolunaCountries = [];

const kickCountries = [];

const founditCountries = [];

const bigcashCountries = [
    { name: 'India', code: '+91', price: 36.4, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' },
    { name: 'Brazil', code: '+55', price: 6.55, countryId: 73, flag: '\u{1F1E7}\u{1F1F7}' }
];

const ez777Countries = [];

const fdjparionssportCountries = [];

const eniliveCountries = [];

const nexonCountries = [];

const rangliveCountries = [];

const beuteaCountries = [
    { name: 'Malaysia', code: '+60', price: 11.65, countryId: 7, flag: '\u{1F1F2}\u{1F1FE}' }
];

const indiapollsCountries = [];

const adityabirlaCountries = [
    { name: 'India', code: '+91', price: 24.39, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const heypiggyCountries = [];

const neosurfCountries = [
    { name: 'Portugal', code: '+351', price: 242.79, countryId: 117, flag: '\u{1F1F5}\u{1F1F9}' },
    { name: 'Ireland', code: '+353', price: 161.62, countryId: 23, flag: '\u{1F1EE}\u{1F1EA}' },
    { name: 'Italy', code: '+39', price: 160.89, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' },
    { name: 'Austria', code: '+43', price: 182, countryId: 50, flag: '\u{1F1E6}\u{1F1F9}' },
    { name: 'France', code: '+33', price: 113.57, countryId: 78, flag: '\u{1F1EB}\u{1F1F7}' },
    { name: 'Spain', code: '+34', price: 96.1, countryId: 56, flag: '\u{1F1EA}\u{1F1F8}' },
    { name: 'Netherlands', code: '+31', price: 1.46, countryId: 48, flag: '\u{1F1F3}\u{1F1F1}' },
    { name: 'Canada', code: '+1', price: 109.2, countryId: 36, flag: '\u{1F1E8}\u{1F1E6}' },
    { name: 'Greece', code: '+30', price: 242.79, countryId: 129, flag: '\u{1F1EC}\u{1F1F7}' }
];

const tuttiCountries = [
    { name: 'Switzerland', code: '+41', price: 424.79, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' }
];

const kreditoCountries = [];

const sponlineCountries = [
    { name: 'Hong Kong', code: '+852', price: 36.04, countryId: 14, flag: '\u{1F1ED}\u{1F1F0}' }
];

const letgoCountries = [];

const ideeopinioniCountries = [];

const naturaavonCountries = [];

const poeCountries = [];

const guviCountries = [];

const quicktvCountries = [];

const kolotibabloCountries = [];

const mackolikCountries = [];

const zenmuxCountries = [];

const jalwagameCountries = [];

const exnessCountries = [];

const tatamotorsCountries = [];

const research360Countries = [];

const ludowinnerCountries = [];

const mbmbetCountries = [];

const longchauCountries = [];

const timitCountries = [
    { name: 'Italy', code: '+39', price: 135.04, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' }
];

const wambaCountries = [];

const adobeCountries = [
    { name: 'Indonesia', code: '+62', price: 100, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const dahadahaCountries = [];

const guzmanygomezCountries = [];

const swagbucksCountries = [
    { name: 'USA', code: '+1', price: 27.3, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' },
    { name: 'United Kingdom', code: '+44', price: 27.3, countryId: 16, flag: '\u{1F1EC}\u{1F1E7}' }
];

const ricardoCountries = [
    { name: 'Switzerland', code: '+41', price: 658.11, countryId: 173, flag: '\u{1F1E8}\u{1F1ED}' }
];

const ashleymadisonCountries = [
    { name: 'USA', code: '+1', price: 97.19, countryId: 187, flag: '\u{1F1FA}\u{1F1F8}' }
];

const fiftyonegameCountries = [
    { name: 'Indonesia', code: '+62', price: 100, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const storytvCountries = [
    { name: 'India', code: '+91', price: 34.22, countryId: 22, flag: '\u{1F1EE}\u{1F1F3}' }
];

const ourtimeCountries = [];

const nielsenCountries = [];

const telnyxCountries = [];

const grokCountries = [];

const winmateCountries = [];

const tonlineCountries = [
    { name: 'Germany', code: '+49', price: 255.16, countryId: 43, flag: '\u{1F1E9}\u{1F1EA}' }
];

const dotandkeyCountries = [];

const thedermacoCountries = [];

const predikCountries = [];

const brevistayCountries = [];

const australiapostCountries = [];

const cheqCountries = [];

const rupiyoCountries = [
    { name: 'Indonesia', code: '+62', price: 100, countryId: 6, flag: '\u{1F1EE}\u{1F1E9}' }
];

const digitaloceanCountries = [];

const fdaCountries = [];

const playtimeCountries = [];

const betflagCountries = [
    { name: 'Italy', code: '+39', price: 455, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' }
];

const sisalCountries = [
    { name: 'Italy', code: '+39', price: 401.49, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' }
];

const lottomaticaCountries = [];

const goldbetCountries = [];

const netwinCountries = [
    { name: 'Italy', code: '+39', price: 319.96, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' }
];

const snaiCountries = [
    { name: 'Italy', code: '+39', price: 388.02, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' }
];

const eurobetCountries = [
    { name: 'Italy', code: '+39', price: 322.87, countryId: 86, flag: '\u{1F1EE}\u{1F1F9}' }
];

const extraServiceCountryArraysByServiceType = {
    "mercado": mercadoCountries,
    "uklon": uklonCountries,
    "rediffmail": rediffmailCountries,
    "prom": promCountries,
    "uwin": uwinCountries,
    "bereal": berealCountries,
    "dotz": dotzCountries,
    "redbus": redbusCountries,
    "pocket52": pocket52Countries,
    "gemgala": gemgalaCountries,
    "irancell": irancellCountries,
    "bazos": bazosCountries,
    "supers": supersCountries,
    "dosi": dosiCountries,
    "monobankindia": monobankindiaCountries,
    "alfa": alfaCountries,
    "tradeup": tradeupCountries,
    "adani": adaniCountries,
    "marketguru": marketguruCountries,
    "g2g": g2gCountries,
    "ys4fun": ys4funCountries,
    "mixmart": mixmartCountries,
    "gcash": gcashCountries,
    "lazypay": lazypayCountries,
    "citybase": citybaseCountries,
    "ruten": rutenCountries,
    "crefisamais": crefisamaisCountries,
    "haraj": harajCountries,
    "perfluence": perfluenceCountries,
    "wondermart": wondermartCountries,
    "glovo": glovoCountries,
    "uu163": uu163Countries,
    "galaxywin": galaxywinCountries,
    "iti": itiCountries,
    "probo": proboCountries,
    "alfagift": alfagiftCountries,
    "ininal": ininalCountries,
    "quipp": quippCountries,
    "twilio": twilioCountries,
    "hqtrivia": hqtriviaCountries,
    "lyka": lykaCountries,
    "doordash": doordashCountries,
    "celebe": celebeCountries,
    "taikang": taikangCountries,
    "99app": ninetynineappCountries,
    "hopi": hopiCountries,
    "mocospace": mocospaceCountries,
    "iqiyi": iqiyiCountries,
    "zomato": zomatoCountries,
    "trendyol": trendyolCountries,
    "ticketmaster": ticketmasterCountries,
    "qoo10": qoo10Countries,
    "fullrent": fullrentCountries,
    "dewupoison": dewupoisonCountries,
    "1xbet": onexbetCountries,
    "my11circle": my11circleCountries,
    "ximalaya": ximalayaCountries,
    "airtel": airtelCountries,
    "huya": huyaCountries,
    "douyu": douyuCountries,
    "olacabs": olacabsCountries,
    "dominospizza": dominospizzaCountries,
    "winzogame": winzogameCountries,
    "tenchat": tenchatCountries,
    "switips": switipsCountries,
    "youstar": youstarCountries,
    "ifood": ifoodCountries,
    "deliveryclub": deliveryclubCountries,
    "coursehero": courseheroCountries,
    "trip": tripCountries,
    "mega": megaCountries,
    "nimotv": nimotvCountries,
    "caixa": caixaCountries,
    "astropay": astropayCountries,
    "happn": happnCountries,
    "mercari": mercariCountries,
    "premiumone": premiumoneCountries,
    "inboxlv": inboxlvCountries,
    "gofundme": gofundmeCountries,
    "hepsiburadacom": hepsiburadacomCountries,
    "zupee": zupeeCountries,
    "tosla": toslaCountries,
    "wise": wiseCountries,
    "callapp": callappCountries,
    "faceit": faceitCountries,
    "xiaomi": xiaomiCountries,
    "yappy": yappyCountries,
    "dream11": dream11Countries,
    "iqos": iqosCountries,
    "shellbox": shellboxCountries,
    "kucoinplay": kucoinplayCountries,
    "expressmoney": expressmoneyCountries,
    "baidu": baiduCountries,
    "subito": subitoCountries,
    "lovelocal": lovelocalCountries,
    "likee": likeeCountries,
    "chalkboard": chalkboardCountries,
    "casinoplus": casinoplusCountries,
    "kleinanzeigen": kleinanzeigenCountries,
    "rakuten": rakutenCountries,
    "gochat": gochatCountries,
    "smiles": smilesCountries,
    "anyother": anyotherCountries,
    "notifire": notifireCountries,
    "privetmir": privetmirCountries,
    "yami": yamiCountries,
    "synottip": synottipCountries,
    "miravia": miraviaCountries,
    "walmart": walmartCountries,
    "fortunask": fortunaskCountries,
    "freenow": freenowCountries,
    "shpock": shpockCountries,
    "motorkux": motorkuxCountries,
    "indodax": indodaxCountries,
    "upwork": upworkCountries,
    "beanfun": beanfunCountries,
    "claude": claudeCountries,
    "emenu": emenuCountries,
    "naimikz": naimikzCountries,
    "mycarkz": mycarkzCountries,
    "aviatakz": aviatakzCountries,
    "universalbeijingresort": universalbeijingresortCountries,
    "uzum": uzumCountries,
    "cmb": cmbCountries,
    "ipsosisay": ipsosisayCountries,
    "pinduoduo": pinduoduoCountries,
    "bharatpe": bharatpeCountries,
    "jiomart": jiomartCountries,
    "playerzpot": playerzpotCountries,
    "tataneu": tataneuCountries,
    "winterloan": winterloanCountries,
    "collabact": collabactCountries,
    "qwikcilver": qwikcilverCountries,
    "tatacliqpalette": tatacliqpaletteCountries,
    "citymall": citymallCountries,
    "a23": a23Countries,
    "poshvine": poshvineCountries,
    "marwadi": marwadiCountries,
    "frizza": frizzaCountries,
    "zepto": zeptoCountries,
    "rummycircle": rummycircleCountries,
    "khatabook": khatabookCountries,
    "earneasy": earneasyCountries,
    "fitcredit": fitcreditCountries,
    "bankkaro": bankkaroCountries,
    "skcapital": skcapitalCountries,
    "roomster": roomsterCountries,
    "servify": servifyCountries,
    "hdfcbank": hdfcbankCountries,
    "bajajfinserv": bajajfinservCountries,
    "yonogames": yonogamesCountries,
    "angelone": angeloneCountries,
    "mockguru": mockguruCountries,
    "hingedating": hingedatingCountries,
    "kamatera": kamateraCountries,
    "tomato": tomatoCountries,
    "bearwww": bearwwwCountries,
    "anibis": anibisCountries,
    "bunq": bunqCountries,
    "beboo": bebooCountries,
    "namars": namarsCountries,
    "radium": radiumCountries,
    "busyfly": busyflyCountries,
    "vfsglobal": vfsglobalCountries,
    "bro": broCountries,
    "bitrue": bitrueCountries,
    "kia": kiaCountries,
    "royalcanin": royalcaninCountries,
    "ayabank": ayabankCountries,
    "netease": neteaseCountries,
    "rappi": rappiCountries,
    "cabify": cabifyCountries,
    "nequi": nequiCountries,
    "ozan": ozanCountries,
    "fups": fupsCountries,
    "playerauctions": playerauctionsCountries,
    "chevron": chevronCountries,
    "xxgame": xxgameCountries,
    "alchemy": alchemyCountries,
    "boyaa": boyaaCountries,
    "byteplus": byteplusCountries,
    "privy": privyCountries,
    "meituan": meituanCountries,
    "pockit": pockitCountries,
    "tiptapp": tiptappCountries,
    "rocketreach": rocketreachCountries,
    "taptapsend": taptapsendCountries,
    "foodora": foodoraCountries,
    "friendtech": friendtechCountries,
    "haleon": haleonCountries,
    "airtime": airtimeCountries,
    "truthsocial": truthsocialCountries,
    "playojo": playojoCountries,
    "jinjiang": jinjiangCountries,
    "neocrypto": neocryptoCountries,
    "tuul": tuulCountries,
    "klarna": klarnaCountries,
    "vimpay": vimpayCountries,
    "grailed": grailedCountries,
    "mtrmobile": mtrmobileCountries,
    "meitu": meituCountries,
    "oneforma": oneformaCountries,
    "abbott": abbottCountries,
    "gmx": gmxCountries,
    "webde": webdeCountries,
    "strato": stratoCountries,
    "1and1": oneandoneCountries,
    "surveybell": surveybellCountries,
    "checkdomain": checkdomainCountries,
    "arlens": arlensCountries,
    "bonuslink": bonuslinkCountries,
    "suntec": suntecCountries,
    "gopayz": gopayzCountries,
    "tanoti": tanotiCountries,
    "maybank": maybankCountries,
    "myboost": myboostCountries,
    "meiqfashion": meiqfashionCountries,
    "fugeelah": fugeelahCountries,
    "k11": k11Countries,
    "strivinginthelioncity": strivinginthelioncityCountries,
    "marktplaats": marktplaatsCountries,
    "primeopinion": primeopinionCountries,
    "arenaplus": arenaplusCountries,
    "willhaben": willhabenCountries,
    "openphone": openphoneCountries,
    "seznam": seznamCountries,
    "packeta": packetaCountries,
    "publi24": publi24Countries,
    "betano": betanoCountries,
    "zasilkovna": zasilkovnaCountries,
    "bpjstk": bpjstkCountries,
    "bcasyariah": bcasyariahCountries,
    "cloudmanager": cloudmanagerCountries,
    "astrapay": astrapayCountries,
    "redigame": redigameCountries,
    "allofresh": allofreshCountries,
    "onbuka": onbukaCountries,
    "godrej": godrejCountries,
    "greywoods": greywoodsCountries,
    "thefork": theforkCountries,
    "flip": flipCountries,
    "neon": neonCountries,
    "bunda": bundaCountries,
    "astraotoshop": astraotoshopCountries,
    "gamesofa": gamesofaCountries,
    "flik": flikCountries,
    "jivapetani": jivapetaniCountries,
    "ubisoft": ubisoftCountries,
    "uangme": uangmeCountries,
    "pizzahut": pizzahutCountries,
    "seeds": seedsCountries,
    "afreecatv": afreecatvCountries,
    "tiptip": tiptipCountries,
    "schibsted": schibstedCountries,
    "feetfinder": feetfinderCountries,
    "luckylandslots": luckylandslotsCountries,
    "daki": dakiCountries,
    "baihe": baiheCountries,
    "thisfate": thisfateCountries,
    "njuskalo": njuskaloCountries,
    "cocacola": cocacolaCountries,
    "kaching": kachingCountries,
    "couponscom": couponscomCountries,
    "sparkdriver": sparkdriverCountries,
    "tiv": tivCountries,
    "razer": razerCountries,
    "zachbryan": zachbryanCountries,
    "smartypig": smartypigCountries,
    "fliff": fliffCountries,
    "spaceweb": spacewebCountries,
    "nloto": nlotoCountries,
    "brevo": brevoCountries,
    "av100pro": av100proCountries,
    "ollis": ollisCountries,
    "bankera": bankeraCountries,
    "g2a": g2aCountries,
    "cupidmedia": cupidmediaCountries,
    "ipanelonline": ipanelonlineCountries,
    "fortumo": fortumoCountries,
    "waug": waugCountries,
    "rebtel": rebtelCountries,
    "gener8": gener8Countries,
    "gopuff": gopuffCountries,
    "feels": feelsCountries,
    "zuscoffee": zuscoffeeCountries,
    "zoogame": zoogameCountries,
    "coffeetea": coffeeteaCountries,
    "moveit": moveitCountries,
    "prakerja": prakerjaCountries,
    "venteny": ventenyCountries,
    "asiamiles": asiamilesCountries,
    "myvalue": myvalueCountries,
    "boku": bokuCountries,
    "getplus": getplusCountries,
    "dayaauto": dayaautoCountries,
    "shareparty": sharepartyCountries,
    "indoba": indobaCountries,
    "kemnakerri": kemnakerriCountries,
    "allaccess": allaccessCountries,
    "motionpay": motionpayCountries,
    "linkaja": linkajaCountries,
    "leroymerlin": leroymerlinCountries,
    "bookmyplay": bookmyplayCountries,
    "winds": windsCountries,
    "ryde": rydeCountries,
    "her": herCountries,
    "blankstreet": blankstreetCountries,
    "voi": voiCountries,
    "sonyliv": sonylivCountries,
    "hanya": hanyaCountries,
    "prenagenclub": prenagenclubCountries,
    "tiketcom": tiketcomCountries,
    "easycash": easycashCountries,
    "dagangan": daganganCountries,
    "doku": dokuCountries,
    "lottemart": lottemartCountries,
    "chakrarewards": chakrarewardsCountries,
    "xworldwallet": xworldwalletCountries,
    "gomofy": gomofyCountries,
    "stockydodo": stockydodoCountries,
    "meragaon": meragaonCountries,
    "gurmanika": gurmanikaCountries,
    "dikidi": dikidiCountries,
    "lydia": lydiaCountries,
    "muzz": muzzCountries,
    "ankama": ankamaCountries,
    "profee": profeeCountries,
    "nice88": nice88Countries,
    "paybis": paybisCountries,
    "lionparcel": lionparcelCountries,
    "getresponse": getresponseCountries,
    "remotasks": remotasksCountries,
    "tier": tierCountries,
    "greggs": greggsCountries,
    "womply": womplyCountries,
    "pcipay": pcipayCountries,
    "battlestategames": battlestategamesCountries,
    "acko": ackoCountries,
    "sbicard": sbicardCountries,
    "wooplus": wooplusCountries,
    "vercel": vercelCountries,
    "discoverhongkong": discoverhongkongCountries,
    "smart": smartCountries,
    "segari": segariCountries,
    "bcgame": bcgameCountries,
    "vida": vidaCountries,
    "nutriclub": nutriclubCountries,
    "bebeclub": bebeclubCountries,
    "punjabcitizen": punjabcitizenCountries,
    "teamoru": teamoruCountries,
    "gordan": gordanCountries,
    "mitid": mitidCountries,
    "moneyview": moneyviewCountries,
    "shein": sheinCountries,
    "supercell": supercellCountries,
    "varus": varusCountries,
    "coinfantasy": coinfantasyCountries,
    "pyypl": pyyplCountries,
    "migros": migrosCountries,
    "xbox": xboxCountries,
    "yellow": yellowCountries,
    "satu": satuCountries,
    "openbudjet": openbudjetCountries,
    "sonol": sonolCountries,
    "yuda": yudaCountries,
    "googlemessenger": googlemessengerCountries,
    "fastwin": fastwinCountries,
    "mediaexpress": mediaexpressCountries,
    "getsbet": getsbetCountries,
    "bingoplus": bingoplusCountries,
    "branch": branchCountries,
    "pokercircle": pokercircleCountries,
    "radquest": radquestCountries,
    "hicard": hicardCountries,
    "ludoplus": ludoplusCountries,
    "confirmtkt": confirmtktCountries,
    "matchcom": matchcomCountries,
    "verasight": verasightCountries,
    "goagames": goagamesCountries,
    "betinin": betininCountries,
    "tealive": tealiveCountries,
    "busqo": busqoCountries,
    "nuumru": nuumruCountries,
    "metaua": metauaCountries,
    "narendramodi": narendramodiCountries,
    "namaskar": namaskarCountries,
    "tajrummy": tajrummyCountries,
    "happypancake": happypancakeCountries,
    "keeta": keetaCountries,
    "hdfcegro": hdfcegroCountries,
    "tomorocoffee": tomorocoffeeCountries,
    "fivesurveys": fivesurveysCountries,
    "benjamin": benjaminCountries,
    "ding": dingCountries,
    "theasianparent": theasianparentCountries,
    "tunestudio": tunestudioCountries,
    "talabat": talabatCountries,
    "hpgas": hpgasCountries,
    "loloo": lolooCountries,
    "olxkz": olxkzCountries,
    "olxua": olxuaCountries,
    "olxpl": olxplCountries,
    "talkatone": talkatoneCountries,
    "etsy": etsyCountries,
    "olxro": olxroCountries,
    "olxbg": olxbgCountries,
    "olxpt": olxptCountries,
    "github": githubCountries,
    "olxuz": olxuzCountries,
    "streamlabs": streamlabsCountries,
    "unstop": unstopCountries,
    "stan": stanCountries,
    "swarail": swarailCountries,
    "magicpin": magicpinCountries,
    "51exch": fiftyoneexchCountries,
    "truemoney": truemoneyCountries,
    "innopay": innopayCountries,
    "hypermart": hypermartCountries,
    "vision11": vision11Countries,
    "saathi": saathiCountries,
    "capitalone": capitaloneCountries,
    "bingo101": bingo101Countries,
    "efsane": efsaneCountries,
    "rapido": rapidoCountries,
    "sixer": sixerCountries,
    "omnicard": omnicardCountries,
    "shopsy": shopsyCountries,
    "collegepulse": collegepulseCountries,
    "creditkarma": creditkarmaCountries,
    "gaintplay": gaintplayCountries,
    "trapcall": trapcallCountries,
    "kudos": kudosCountries,
    "resy": resyCountries,
    "blastbucks": blastbucksCountries,
    "timewall": timewallCountries,
    "sideline": sidelineCountries,
    "juno": junoCountries,
    "chase": chaseCountries,
    "dutchbros": dutchbrosCountries,
    "centurylink": centurylinkCountries,
    "3fun": threefunCountries,
    "ibotta": ibottaCountries,
    "acima": acimaCountries,
    "aspiration": aspirationCountries,
    "ring4": ring4Countries,
    "taimi": taimiCountries,
    "pelago": pelagoCountries,
    "tumblr": tumblrCountries,
    "audible": audibleCountries,
    "rapidapi": rapidapiCountries,
    "serpapi": serpapiCountries,
    "bosslike": bosslikeCountries,
    "fmcpay": fmcpayCountries,
    "rummyyes": rummyyesCountries,
    "wallapop": wallapopCountries,
    "mmlive": mmliveCountries,
    "reddit": redditCountries,
    "winclash": winclashCountries,
    "outlier": outlierCountries,
    "courtyard": courtyardCountries,
    "turbotenant": turbotenantCountries,
    "bridgemoney": bridgemoneyCountries,
    "zillow": zillowCountries,
    "seatgeek": seatgeekCountries,
    "dave": daveCountries,
    "getholdings": getholdingsCountries,
    "rednotexiaohongshu": rednotexiaohongshuCountries,
    "docusign": docusignCountries,
    "qpon": qponCountries,
    "starexch": starexchCountries,
    "playkaro247": playkaro247Countries,
    "spinwinner": spinwinnerCountries,
    "atlasearth": atlasearthCountries,
    "instamatch": instamatchCountries,
    "ludo11": ludo11Countries,
    "truemeds": truemedsCountries,
    "nykaa": nykaaCountries,
    "rozrummy": rozrummyCountries,
    "paisabazaar": paisabazaarCountries,
    "huionepay": huionepayCountries,
    "skills": skillsCountries,
    "cursor": cursorCountries,
    "aws": awsCountries,
    "goldsbet": goldsbetCountries,
    "cricbuzz": cricbuzzCountries,
    "royaljeet": royaljeetCountries,
    "quoka": quokaCountries,
    "500px": fivehundredpxCountries,
    "bigbasket": bigbasketCountries,
    "googlechat": googlechatCountries,
    "winmatch": winmatchCountries,
    "chipotle": chipotleCountries,
    "wellsfargo": wellsfargoCountries,
    "govinda365": govinda365Countries,
    "woohoo": woohooCountries,
    "firstgames": firstgamesCountries,
    "kickcash": kickcashCountries,
    "aadhar": aadharCountries,
    "shriramone": shriramoneCountries,
    "pokemon": pokemonCountries,
    "naukri": naukriCountries,
    "okwin": okwinCountries,
    "sharechat": sharechatCountries,
    "dreammoney": dreammoneyCountries,
    "konvy": konvyCountries,
    "milanuncios": milanunciosCountries,
    "kliq": kliqCountries,
    "jiagu360": jiagu360Countries,
    "whatnot": whatnotCountries,
    "atisu": atisuCountries,
    "creditmantri": creditmantriCountries,
    "cred": credCountries,
    "qqlive": qqliveCountries,
    "clubgg": clubggCountries,
    "polloai": polloaiCountries,
    "toluna": tolunaCountries,
    "kick": kickCountries,
    "foundit": founditCountries,
    "bigcash": bigcashCountries,
    "ez777": ez777Countries,
    "fdjparionssport": fdjparionssportCountries,
    "enilive": eniliveCountries,
    "nexon": nexonCountries,
    "ranglive": rangliveCountries,
    "beutea": beuteaCountries,
    "indiapolls": indiapollsCountries,
    "adityabirla": adityabirlaCountries,
    "heypiggy": heypiggyCountries,
    "neosurf": neosurfCountries,
    "tutti": tuttiCountries,
    "kredito": kreditoCountries,
    "sponline": sponlineCountries,
    "letgo": letgoCountries,
    "ideeopinioni": ideeopinioniCountries,
    "naturaavon": naturaavonCountries,
    "poe": poeCountries,
    "guvi": guviCountries,
    "quicktv": quicktvCountries,
    "kolotibablo": kolotibabloCountries,
    "mackolik": mackolikCountries,
    "zenmux": zenmuxCountries,
    "jalwagame": jalwagameCountries,
    "exness": exnessCountries,
    "tatamotors": tatamotorsCountries,
    "research360": research360Countries,
    "ludowinner": ludowinnerCountries,
    "mbmbet": mbmbetCountries,
    "longchau": longchauCountries,
    "timit": timitCountries,
    "wamba": wambaCountries,
    "adobe": adobeCountries,
    "dahadaha": dahadahaCountries,
    "guzmanygomez": guzmanygomezCountries,
    "swagbucks": swagbucksCountries,
    "ricardo": ricardoCountries,
    "ashleymadison": ashleymadisonCountries,
    "51game": fiftyonegameCountries,
    "storytv": storytvCountries,
    "ourtime": ourtimeCountries,
    "nielsen": nielsenCountries,
    "telnyx": telnyxCountries,
    "grok": grokCountries,
    "winmate": winmateCountries,
    "tonline": tonlineCountries,
    "dotandkey": dotandkeyCountries,
    "thedermaco": thedermacoCountries,
    "predik": predikCountries,
    "brevistay": brevistayCountries,
    "australiapost": australiapostCountries,
    "cheq": cheqCountries,
    "rupiyo": rupiyoCountries,
    "digitalocean": digitaloceanCountries,
    "fda": fdaCountries,
    "playtime": playtimeCountries,
    "betflag": betflagCountries,
    "sisal": sisalCountries,
    "lottomatica": lottomaticaCountries,
    "goldbet": goldbetCountries,
    "netwin": netwinCountries,
    "snai": snaiCountries,
    "eurobet": eurobetCountries,
};

const serviceCatalog = {
    whatsapp: {
        serviceType: 'whatsapp',
        serviceName: 'WhatsApp Number',
        serviceCode: SMSBOWER_WA_SERVICE,
        countries: whatsappCountries
    },
    facebook: {
        serviceType: 'facebook',
        serviceName: 'Facebook Number',
        serviceCode: SMSBOWER_FB_SERVICE,
        countries: facebookCountries
    },
    instagram: {
        serviceType: 'instagram',
        serviceName: 'Instagram Number',
        serviceCode: SMSBOWER_IG_SERVICE,
        countries: instagramCountries
    },
    snapchat: {
        serviceType: 'snapchat',
        serviceName: 'Snapchat Number',
        serviceCode: SMSBOWER_SNAPCHAT_SERVICE,
        countries: snapchatCountries
    },
    tiktok: {
        serviceType: 'tiktok',
        serviceName: 'TikTok Number',
        serviceCode: SMSBOWER_TIKTOK_SERVICE,
        countries: tiktokCountries
    },
    imo: {
        serviceType: 'imo',
        serviceName: 'Imo Messenger Number',
        serviceCode: SMSBOWER_IMO_SERVICE,
        countries: imoCountries
    },
    tinder: {
        serviceType: 'tinder',
        serviceName: 'Tinder Number',
        serviceCode: SMSBOWER_TINDER_SERVICE,
        countries: tinderCountries
    },
    twitter: {
        serviceType: 'twitter',
        serviceName: 'Twitter / X Number',
        serviceCode: SMSBOWER_TWITTER_SERVICE,
        countries: twitterCountries
    },
    amazon: {
        serviceType: 'amazon',
        serviceName: 'Amazon Number',
        serviceCode: SMSBOWER_AMAZON_SERVICE,
        countries: amazonCountries
    },
    alibaba: {
        serviceType: 'alibaba',
        serviceName: 'Alibaba Number',
        serviceCode: SMSBOWER_ALIBABA_SERVICE,
        countries: alibabaCountries
    },
    careem: {
        serviceType: 'careem',
        serviceName: 'Careem Number',
        serviceCode: SMSBOWER_CAREEM_SERVICE,
        countries: careemCountries
    },
        noon: {
        serviceType: 'noon',
        serviceName: 'Noon Number',
        serviceCode: 'tf',
        countries: noonCountries
    },
    spotify: {
        serviceType: 'spotify',
        serviceName: 'Spotify Number',
        serviceCode: SMSBOWER_SPOTIFY_SERVICE,
        countries: spotifyCountries
    },
    openai: {
        serviceType: 'openai',
        serviceName: 'OpenAI / ChatGPT Number',
        serviceCode: SMSBOWER_OPENAI_SERVICE,
        countries: openaiCountries
    },
    paypal: {
        serviceType: 'paypal',
        serviceName: 'PayPal Number',
        serviceCode: SMSBOWER_PAYPAL_SERVICE,
        countries: paypalCountries
    },
    aliexpress: {
        serviceType: 'aliexpress',
        serviceName: 'AliExpress Number',
        serviceCode: SMSBOWER_ALIEXPRESS_SERVICE,
        countries: aliexpressCountries
    },
    wechat: {
        serviceType: 'wechat',
        serviceName: 'WeChat Number',
        serviceCode: SMSBOWER_WECHAT_SERVICE,
        countries: wechatCountries
    },
    viber: {
        serviceType: 'viber',
        serviceName: 'Viber Number',
        serviceCode: SMSBOWER_VIBER_SERVICE,
        countries: viberCountries
    },
    uber: {
        serviceType: 'uber',
        serviceName: 'Uber Number',
        serviceCode: SMSBOWER_UBER_SERVICE,
        countries: uberCountries
    },
    microsoft: {
        serviceType: 'microsoft',
        serviceName: 'Microsoft Number',
        serviceCode: SMSBOWER_MICROSOFT_SERVICE,
        countries: microsoftCountries
    },
    signal: {
        serviceType: 'signal',
        serviceName: 'Signal Number',
        serviceCode: SMSBOWER_SIGNAL_SERVICE,
        countries: signalCountries
    },
    easypay: {
        serviceType: 'easypay',
        serviceName: 'Easypay Number',
        serviceCode: SMSBOWER_EASYPAY_SERVICE,
        countries: easypayCountries
    },
    google: {
        serviceType: 'google',
        serviceName: 'Google / Gmail / YouTube Number',
        serviceCode: SMSBOWER_GOOGLE_SERVICE,
        countries: googleCountries
    }
};

const BUILT_IN_SERVICE_TYPES = new Set(Object.keys(serviceCatalog));

const SERVICE_ICON_DIRECTORY_PATH = path.join(__dirname, 'public', 'All Pngs');
const SERVICE_ICON_ALLOWED_EXTENSIONS = new Set(['.svg', '.webp', '.png']);
const SERVICE_ICON_EXTENSION_PRIORITY = {
    '.svg': 0,
    '.webp': 1,
    '.png': 2
};

const EXTRA_SERVICE_TYPE_ALIASES = {
    linkdlin: 'linkedin'
};

function normalizeServiceLookup(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function createServiceTypeFromLabel(label, code = '') {
    const normalizedLabel = normalizeServiceLookup(label).replace(/\s+/g, '');
    if (normalizedLabel) return EXTRA_SERVICE_TYPE_ALIASES[normalizedLabel] || normalizedLabel;
    return String(code || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .trim();
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

function buildServiceIconManifest() {
    const iconEntries = new Map();
    const duplicateEntries = new Map();
    let totalIconsFound = 0;
    try {
        fs.readdirSync(SERVICE_ICON_DIRECTORY_PATH, { withFileTypes: true }).forEach((entry) => {
            if (!entry?.isFile?.()) return;
            const fileName = String(entry.name || '').trim();
            const extension = path.extname(fileName).toLowerCase();
            if (!fileName || !SERVICE_ICON_ALLOWED_EXTENSIONS.has(extension)) return;
            totalIconsFound += 1;
            const normalizedName = normalizeServiceIconLookup(path.basename(fileName, extension));
            if (!normalizedName) return;
            const priority = SERVICE_ICON_EXTENSION_PRIORITY[extension] ?? Number.MAX_SAFE_INTEGER;
            const currentEntry = iconEntries.get(normalizedName);
            const recordedFiles = duplicateEntries.get(normalizedName) || [];
            recordedFiles.push(fileName);
            duplicateEntries.set(normalizedName, recordedFiles);
            if (currentEntry && currentEntry.priority <= priority) return;
            iconEntries.set(normalizedName, {
                priority,
                fileName,
                url: encodeURI(`/All Pngs/${fileName}`)
            });
        });
    } catch (error) {
        console.error('Service icon manifest build failed:', error?.message || error);
    }
    const icons = Object.fromEntries(Array.from(iconEntries.entries()).map(([key, value]) => [key, value.url]));
    const duplicateIconNames = Array.from(duplicateEntries.entries())
        .filter(([, files]) => files.length > 1)
        .map(([normalizedName, files]) => ({
            normalizedName,
            files: Array.from(new Set(files)).sort((left, right) => left.localeCompare(right))
        }));
    return {
        icons,
        summary: {
            totalIconsFound,
            totalResolvedIcons: Object.keys(icons).length,
            duplicateIconNames
        }
    };
}

const SERVICE_ICON_MANIFEST_DATA = buildServiceIconManifest();
const SERVICE_ICON_MANIFEST = SERVICE_ICON_MANIFEST_DATA.icons;
const SERVICE_ICON_SUMMARY = SERVICE_ICON_MANIFEST_DATA.summary;

function getServiceCatalogLabel(serviceConfig) {
    return String(serviceConfig?.serviceName || serviceConfig?.serviceType || '')
        .replace(/\s+number$/i, '')
        .trim();
}

function parseExtraServicesFromCatalogText(rawText, catalog) {
    const tokens = String(rawText || '')
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean);
    const seenLabels = new Set(Object.values(catalog).map((serviceConfig) => normalizeServiceLookup(getServiceCatalogLabel(serviceConfig))).filter(Boolean));
    const seenServiceTypes = new Set(Object.keys(catalog));
    const extras = [];

    for (let index = 0; index < tokens.length - 1; index += 1) {
        const code = tokens[index];
        const label = tokens[index + 1];
        if (!code || !label) continue;

        const looksLikeCode = !/\s/.test(code) && code.length <= 8;
        if (!looksLikeCode) continue;

        const normalizedLabel = normalizeServiceLookup(label);
        const serviceType = createServiceTypeFromLabel(label, code);
        const hasDuplicate = !normalizedLabel || !serviceType || seenLabels.has(normalizedLabel) || seenServiceTypes.has(serviceType);

        if (!hasDuplicate) {
            seenLabels.add(normalizedLabel);
            seenServiceTypes.add(serviceType);
            extras.push({ code, label, serviceType });
        }

        if (tokens[index + 2] === label) {
            index += 2;
        }
    }

    return extras;
}

function parseExtraServicesFromCodeTableText(rawText, catalog) {
    const lines = String(rawText || '')
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean);
    const seenLabels = new Set(Object.values(catalog).map((serviceConfig) => normalizeServiceLookup(getServiceCatalogLabel(serviceConfig))).filter(Boolean));
    const seenServiceTypes = new Set(Object.keys(catalog));
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
        const hasDuplicate = !normalizedLabel || !serviceType || seenLabels.has(normalizedLabel) || seenServiceTypes.has(serviceType);
        if (hasDuplicate) return;

        seenLabels.add(normalizedLabel);
        seenServiceTypes.add(serviceType);
        extras.push({ code, label, serviceType });
    });

    return extras;
}

const EXTRA_SERVICE_COUNTRY_FILES_DIRS = [
    path.join(__dirname, 'public', 'Application Adding'),
    path.join(__dirname, 'public', 'New Services Lists')
];
const EXTRA_SERVICE_STRUCTURED_SOURCE_FILE_PATHS = [
    path.join(__dirname, 'public', 'New Services Lists', 'Add my new services.txt')
];
const EXTRA_SERVICE_CODE_FILE_PATHS = [
    path.join(__dirname, 'public', 'All Social Media Platform.txt'),
    path.join(__dirname, 'public', 'New Services Lists', 'All Services Codes.txt')
];
const EXTRA_SERVICE_COUNTRY_FILE_IGNORE_NAMES = new Set(['all services codes.txt', 'add my new services.txt']);
const WHATSAPP_COUNTRY_FILE_PATH = path.join(__dirname, 'public', 'whatsapp.txt');
const COUNTRY_CODE_NAME_ALIASES = {
    usa: ['united states', 'united states of america'],
    'usa virtual': ['usa', 'united states', 'united states of america'],
    'united kingdom': ['uk'],
    uk: ['united kingdom'],
    'saudi arabia': ['saudi'],
    saudi: ['saudi arabia'],
    'ivory coast': ['cote d ivoire'],
    'cote d ivoire': ['ivory coast'],
    'democratic republic of the congo': ['dr congo', 'congo dem republic'],
    'dr congo': ['democratic republic of the congo', 'congo dem republic'],
    'congo dem republic': ['democratic republic of the congo', 'dr congo'],
    macedonia: ['north macedonia'],
    'north macedonia': ['macedonia'],
    'united arab emirates': ['uae'],
    uae: ['united arab emirates'],
    laos: ['lao peoples', 'lao people s', 'lao peoples democratic republic', 'lao people s democratic republic'],
    vietnam: ['viet nam'],
    argentina: ['argentinas']
};
const EXTRA_SERVICE_COUNTRY_NAME_ALIASES = {
    'united states': 'usa',
    'united states of america': 'usa',
    'viet nam': 'vietnam',
    'lao peoples': 'laos',
    'lao people s': 'laos',
    'lao peoples democratic republic': 'laos',
    'lao people s democratic republic': 'laos',
    'cote d ivoire': 'ivory coast',
    'argentinas': 'argentina'
};

function normalizeCountryNameForFileLookup(value) {
    return normalizeServiceLookup(value).replace(/\s+/g, ' ').trim();
}

function sanitizeCountryNameFromServiceFile(value, serviceLabel = '') {
    let cleaned = String(value || '')
        .replace(/\*/g, '')
        .replace(/\s*\((?:[^)]*)\)\s*$/i, '')
        .trim();
    const escapedLabel = String(serviceLabel || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escapedLabel) {
        cleaned = cleaned.replace(new RegExp(`^${escapedLabel}\\s+`, 'i'), '').trim();
    }
    cleaned = cleaned.replace(/[^\p{L}\p{N}]+$/gu, '').trim();
    return cleaned;
}

function buildCountryReferenceLookup(catalog, additionalCountryArrays = []) {
    const byName = new Map();
    const addCountryReference = (country) => {
        const countryId = Number(country?.countryId);
        if (!Number.isFinite(countryId) || countryId <= 0) return;
        const reference = {
            name: String(country?.name || '').trim(),
            code: String(country?.code || '').trim(),
            countryId,
            flag: String(country?.flag || '').trim()
        };
        const directKey = normalizeCountryNameForFileLookup(reference.name);
        if (directKey && !byName.has(directKey)) {
            byName.set(directKey, reference);
        }
        getCountryCodeLookupKeys(country).forEach((aliasName) => {
            const aliasKey = normalizeCountryNameForFileLookup(aliasName);
            if (aliasKey && !byName.has(aliasKey)) {
                byName.set(aliasKey, reference);
            }
        });
    };

    Object.values(catalog).forEach((serviceConfig) => {
        const countries = Array.isArray(serviceConfig?.countries) ? serviceConfig.countries : [];
        countries.forEach(addCountryReference);
    });

    (Array.isArray(additionalCountryArrays) ? additionalCountryArrays : []).forEach((countries) => {
        if (!Array.isArray(countries)) return;
        countries.forEach(addCountryReference);
    });

    return { byName };
}

function resolveCountryReferenceFromLookup(countryName, lookup) {
    const normalizedName = normalizeCountryNameForFileLookup(countryName);
    if (!normalizedName) return null;
    if (lookup.byName.has(normalizedName)) {
        return lookup.byName.get(normalizedName) || null;
    }
    const aliasTarget = EXTRA_SERVICE_COUNTRY_NAME_ALIASES[normalizedName];
    if (aliasTarget) {
        const aliasKey = normalizeCountryNameForFileLookup(aliasTarget);
        if (lookup.byName.has(aliasKey)) {
            return lookup.byName.get(aliasKey) || null;
        }
    }
    return null;
}

function parseCountryPriceFromServiceLine(line) {
    const normalizedLine = String(line || '').trim();
    if (!normalizedLine) return null;
    const suffixMatch = normalizedLine.match(/^(.*?)\s*(?:[-\u{2014}\u{2013}:]+\s*)?([0-9]+(?:\.[0-9]+)?)\s*(?:PKR|RS\.?)\s*$/i);
    if (suffixMatch) {
        return {
            countryName: suffixMatch[1],
            price: Number(suffixMatch[2])
        };
    }
    const prefixMatch = normalizedLine.match(/^(.*?)\s+(?:PKR|RS\.?)\s*([0-9]+(?:\.[0-9]+)?)\s*$/i);
    if (prefixMatch) {
        return {
            countryName: prefixMatch[1],
            price: Number(prefixMatch[2])
        };
    }
    return null;
}

function parseCountriesFromServiceText(rawText, lookup, serviceLabel = '') {
    const countries = [];
    const seenCountryIds = new Set();
    const unmatchedCountries = [];
    String(rawText || '')
        .split(/\r?\n/g)
        .map((line) => line.replace(/\*/g, '').trim())
        .filter(Boolean)
        .forEach((line) => {
            const parsedLine = parseCountryPriceFromServiceLine(line);
            if (!parsedLine) return;
            const rawCountryName = sanitizeCountryNameFromServiceFile(parsedLine.countryName, serviceLabel);
            const price = Number(parsedLine.price);
            if (!rawCountryName || !Number.isFinite(price)) return;
            const reference = resolveCountryReferenceFromLookup(rawCountryName, lookup);
            if (!reference) {
                if (!unmatchedCountries.includes(rawCountryName)) unmatchedCountries.push(rawCountryName);
                return;
            }
            const countryIdKey = String(reference.countryId);
            if (seenCountryIds.has(countryIdKey)) return;
            seenCountryIds.add(countryIdKey);
            countries.push({
                name: reference.name,
                code: reference.code,
                price: Number(price.toFixed(2)),
                countryId: reference.countryId,
                flag: reference.flag
            });
        });
    return {
        countries,
        unmatchedCountries,
        parsedLineCount: countries.length + unmatchedCountries.length
    };
}

function parseStructuredExtraServiceBlocks(rawText) {
    const blocks = [];
    const blockPattern = /---\s+(.*?)\s+\(serviceCode:\s*'([^']+)'\)\s+---\s*const\s+[A-Za-z0-9_]+Countries\s*=\s*\[([\s\S]*?)\];/g;
    const sourceText = String(rawText || '');
    let blockMatch;
    while ((blockMatch = blockPattern.exec(sourceText)) !== null) {
        const serviceLabel = String(blockMatch[1] || '').trim();
        const serviceCode = String(blockMatch[2] || '').trim();
        const serviceType = createServiceTypeFromLabel(serviceLabel, serviceCode);
        if (!serviceLabel || !serviceCode || !serviceType) continue;
        const countries = [];
        const seenCountryIds = new Set();
        const countryPattern = /\{\s*name:\s*'([^']*)',\s*code:\s*'([^']*)',\s*price:\s*([0-9]+(?:\.[0-9]+)?),\s*countryId:\s*([0-9]+),\s*flag:\s*'([^']*)'\s*\}/g;
        let countryMatch;
        while ((countryMatch = countryPattern.exec(blockMatch[3] || '')) !== null) {
            const countryId = Number(countryMatch[4]);
            const price = Number(countryMatch[3]);
            if (!Number.isFinite(countryId) || countryId <= 0 || !Number.isFinite(price)) continue;
            const countryIdKey = String(countryId);
            if (seenCountryIds.has(countryIdKey)) continue;
            seenCountryIds.add(countryIdKey);
            countries.push({
                name: String(countryMatch[1] || '').trim(),
                code: String(countryMatch[2] || '').trim(),
                price: Number(price.toFixed(2)),
                countryId,
                flag: String(countryMatch[5] || '').trim()
            });
        }
        if (!countries.length) continue;
        blocks.push({
            serviceLabel,
            serviceCode,
            serviceType,
            countries
        });
    }
    return blocks;
}

function getStructuredExtraServiceDescriptors() {
    const descriptors = [];
    EXTRA_SERVICE_STRUCTURED_SOURCE_FILE_PATHS.forEach((filePath) => {
        try {
            const rawText = fs.readFileSync(filePath, 'utf8');
            parseStructuredExtraServiceBlocks(rawText).forEach((entry) => {
                descriptors.push({
                    ...entry,
                    filePath
                });
            });
        } catch {
        }
    });
    return descriptors;
}

function extendWhatsappCountriesFromFile(catalog) {
    const whatsappService = catalog?.whatsapp;
    const existingCountries = Array.isArray(whatsappService?.countries) ? whatsappService.countries : [];
    if (!existingCountries.length) return;
    try {
        const rawText = fs.readFileSync(WHATSAPP_COUNTRY_FILE_PATH, 'utf8');
        const lookup = buildCountryReferenceLookup(catalog);
        const parsed = parseCountriesFromServiceText(rawText, lookup, 'whatsapp');
        const existingCountryIds = new Set(existingCountries.map((country) => String(country?.countryId ?? '').trim()).filter(Boolean));
        const additionalCountries = parsed.countries
            .filter((country) => !existingCountryIds.has(String(country?.countryId ?? '').trim()))
            .map((country) => ({
                ...country,
                code: country.code || (normalizeCountryNameForFileLookup(country.name) === 'australia' ? '+61' : '')
            }));
        if (!additionalCountries.length) {
            whatsappService.countries = existingCountries;
            return;
        }
        const usaIndex = existingCountries.findIndex((country) => String(country?.name || '').trim().toLowerCase() === 'usa' && Number(country?.countryId) === 187);
        whatsappService.countries = usaIndex >= 0
            ? [
                ...existingCountries.slice(0, usaIndex + 1),
                ...additionalCountries,
                ...existingCountries.slice(usaIndex + 1)
            ]
            : [...existingCountries, ...additionalCountries];
    } catch {
    }
}

const whatsappCountryStatus = {
    'South Africa': { label: 'Normal OTP', color: 'green' },
    'Indonesia': { label: 'Good OTP', color: 'green' },
    'Canada': { label: 'Good OTP', color: 'green' },
    'Philippines': { label: 'Good OTP', color: 'green' },
    'Thailand': { label: 'Good OTP', color: 'green' },
    'Vietnam': { label: 'Good OTP', color: 'green' },
    'Colombia': { label: 'Good OTP', color: 'green' },
    'Saudi Arabia': { label: 'Good OTP', color: 'green' },
    'Brazil': { label: 'Good OTP', color: 'green' },
    'USA': { label: 'Good OTP', color: 'green' },
    'United Kingdom': { label: 'Good OTP', color: 'green' }
};

function buildExtraServiceCountryArraysFromFiles(catalog) {
    const arraysByServiceType = { ...extraServiceCountryArraysByServiceType };
    getStructuredExtraServiceDescriptors().forEach(({ serviceType, countries }) => {
        if (!serviceType || !Array.isArray(countries) || !countries.length) return;
        const existingCountries = arraysByServiceType[serviceType];
        if (!Array.isArray(existingCountries) || !existingCountries.length) {
            arraysByServiceType[serviceType] = countries.map((country) => ({ ...country }));
        }
    });
    const extraServiceFiles = getExtraServiceFileDescriptors();
    if (!extraServiceFiles.length) {
        return arraysByServiceType;
    }

    const lookup = buildCountryReferenceLookup(catalog, Object.values(extraServiceCountryArraysByServiceType));
    const bestCandidatesByServiceType = new Map();
    extraServiceFiles.forEach(({ filePath, serviceLabel, serviceType }) => {
        try {
            const rawText = fs.readFileSync(filePath, 'utf8');
            const parsed = parseCountriesFromServiceText(rawText, lookup, serviceLabel);
            const currentBest = bestCandidatesByServiceType.get(serviceType);
            if (!currentBest
                || parsed.countries.length > currentBest.countries.length
                || (parsed.countries.length === currentBest.countries.length && parsed.parsedLineCount > currentBest.parsedLineCount)) {
                bestCandidatesByServiceType.set(serviceType, parsed);
            }
        } catch {
        }
    });

    bestCandidatesByServiceType.forEach((parsed, serviceType) => {
        if (Array.isArray(parsed?.countries) && parsed.countries.length) {
            arraysByServiceType[serviceType] = parsed.countries;
        }
    });

    return arraysByServiceType;
}

function getExtraServiceFileDescriptors() {
    const descriptors = [];
    EXTRA_SERVICE_COUNTRY_FILES_DIRS.forEach((directoryPath) => {
        try {
            fs.readdirSync(directoryPath)
                .filter((fileName) => /\.txt$/i.test(fileName))
                .sort((left, right) => left.localeCompare(right))
                .forEach((fileName) => {
                    if (EXTRA_SERVICE_COUNTRY_FILE_IGNORE_NAMES.has(String(fileName || '').trim().toLowerCase())) return;
                    const serviceLabel = fileName.replace(/\.txt$/i, '').trim();
                    const serviceType = createServiceTypeFromLabel(serviceLabel);
                    if (!serviceType) return;
                    descriptors.push({
                        directoryPath,
                        fileName,
                        filePath: path.join(directoryPath, fileName),
                        serviceLabel,
                        serviceType
                    });
                });
        } catch {
        }
    });
    return descriptors.sort((left, right) => {
        const leftKey = `${left.serviceType}:${left.fileName}:${left.directoryPath}`;
        const rightKey = `${right.serviceType}:${right.fileName}:${right.directoryPath}`;
        return leftKey.localeCompare(rightKey);
    });
}

function extendServiceCatalogWithExtraServices(catalog) {
    const extraServicesByServiceType = new Map();
    EXTRA_SERVICE_CODE_FILE_PATHS.forEach((filePath, index) => {
        try {
            const rawText = fs.readFileSync(filePath, 'utf8');
            const extraServices = index === 0
                ? parseExtraServicesFromCatalogText(rawText, catalog)
                : parseExtraServicesFromCodeTableText(rawText, catalog);
            extraServices.forEach((service) => {
                extraServicesByServiceType.set(service.serviceType, service);
            });
        } catch {
        }
    });

    const structuredExtraServices = getStructuredExtraServiceDescriptors();
    structuredExtraServices.forEach(({ serviceLabel, serviceCode, serviceType }) => {
        if (!serviceType) return;
        const existingService = extraServicesByServiceType.get(serviceType);
        if (!existingService) {
            extraServicesByServiceType.set(serviceType, {
                code: serviceCode || null,
                label: serviceLabel,
                serviceType
            });
            return;
        }
        if (!existingService.code && serviceCode) {
            existingService.code = serviceCode;
        }
        if (!existingService.label && serviceLabel) {
            existingService.label = serviceLabel;
        }
    });

    const extraServiceFiles = getExtraServiceFileDescriptors();
    const extraServiceSourceLabelsByServiceType = new Map();
    extraServiceFiles.forEach((entry) => {
        if (!entry?.serviceType) return;
        if (!extraServiceSourceLabelsByServiceType.has(entry.serviceType)) {
            extraServiceSourceLabelsByServiceType.set(entry.serviceType, entry.serviceLabel);
        }
        if (!extraServicesByServiceType.has(entry.serviceType)) {
            extraServicesByServiceType.set(entry.serviceType, {
                code: null,
                label: entry.serviceLabel,
                serviceType: entry.serviceType
            });
        }
    });
    structuredExtraServices.forEach((entry) => {
        if (!entry?.serviceType || !entry?.serviceLabel) return;
        if (!extraServiceSourceLabelsByServiceType.has(entry.serviceType)) {
            extraServiceSourceLabelsByServiceType.set(entry.serviceType, entry.serviceLabel);
        }
    });
    const extraCountryArraysByServiceType = buildExtraServiceCountryArraysFromFiles(catalog);
    extraServicesByServiceType.forEach((extraService, serviceType) => {
        const countries = extraCountryArraysByServiceType[serviceType];
        if (!Array.isArray(countries) || !countries.length || catalog[serviceType]) return;
        const displayLabel = String(extraService?.label || extraServiceSourceLabelsByServiceType.get(serviceType) || serviceType).trim();
        const preserveCountryOrder = extraServiceSourceLabelsByServiceType.has(serviceType);
        catalog[serviceType] = {
            serviceType,
            serviceName: `${displayLabel} Number`,
            serviceCode: extraService?.code || null,
            countries,
            preserveCountryOrder,
            markTopCountriesGoodOtp: preserveCountryOrder,
            catalogSource: preserveCountryOrder ? 'application-adding' : 'extended-catalog'
        };
    });
}

function normalizeCountryNameForLookup(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeCountryDialCode(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const digits = raw.replace(/[^\d]/g, '');
    if (!digits) return '';
    return `+${digits}`;
}

function getCountryCodeLookupKeys(country) {
    const normalizedName = normalizeCountryNameForLookup(country?.name);
    if (!normalizedName) return [];
    const aliases = COUNTRY_CODE_NAME_ALIASES[normalizedName];
    const aliasList = Array.isArray(aliases)
        ? aliases
        : aliases
            ? [aliases]
            : [];
    return [normalizedName, ...aliasList.map((entry) => normalizeCountryNameForLookup(entry))]
        .filter(Boolean);
}

function buildCountryCodeLookup(catalog) {
    const byCountryId = new Map();
    const byCountryName = new Map();

    Object.values(catalog).forEach((serviceConfig) => {
        const countries = Array.isArray(serviceConfig?.countries) ? serviceConfig.countries : [];
        countries.forEach((country) => {
            const dialCode = normalizeCountryDialCode(country?.code);
            if (!dialCode) return;

            const countryIdKey = String(country?.countryId ?? '').trim();
            if (countryIdKey && !byCountryId.has(countryIdKey)) {
                byCountryId.set(countryIdKey, dialCode);
            }

            getCountryCodeLookupKeys(country).forEach((key) => {
                if (!byCountryName.has(key)) {
                    byCountryName.set(key, dialCode);
                }
            });
        });
    });

    return { byCountryId, byCountryName };
}

function resolveCountryDialCode(country, lookup) {
    const directCode = normalizeCountryDialCode(country?.code);
    if (directCode) return directCode;

    const countryIdKey = String(country?.countryId ?? '').trim();
    if (countryIdKey && lookup.byCountryId.has(countryIdKey)) {
        return lookup.byCountryId.get(countryIdKey) || '';
    }

    for (const key of getCountryCodeLookupKeys(country)) {
        if (lookup.byCountryName.has(key)) {
            return lookup.byCountryName.get(key) || '';
        }
    }

    return '';
}

function hydrateServiceCountryCodes(catalog) {
    const lookup = buildCountryCodeLookup(catalog);

    Object.values(catalog).forEach((serviceConfig) => {
        if (!Array.isArray(serviceConfig?.countries)) return;
        serviceConfig.countries = serviceConfig.countries.map((country) => {
            const resolvedCode = resolveCountryDialCode(country, lookup);
            if (!resolvedCode || resolvedCode === String(country?.code || '').trim()) {
                return country;
            }

            const updatedCountry = { ...country, code: resolvedCode };
            const countryIdKey = String(updatedCountry?.countryId ?? '').trim();
            if (countryIdKey && !lookup.byCountryId.has(countryIdKey)) {
                lookup.byCountryId.set(countryIdKey, resolvedCode);
            }
            getCountryCodeLookupKeys(updatedCountry).forEach((key) => {
                if (!lookup.byCountryName.has(key)) {
                    lookup.byCountryName.set(key, resolvedCode);
                }
            });
            return updatedCountry;
        });
    });
}

extendServiceCatalogWithExtraServices(serviceCatalog);
extendWhatsappCountriesFromFile(serviceCatalog);
hydrateServiceCountryCodes(serviceCatalog);

function getServiceConfig(serviceType) {
    return serviceCatalog[String(serviceType || '').trim().toLowerCase()] || null;
}

function sortCountriesByPrice(countries) {
    const list = Array.isArray(countries) ? [...countries] : [];
    return list.sort((left, right) => {
        const leftPrice = Number(left?.price ?? Number.POSITIVE_INFINITY);
        const rightPrice = Number(right?.price ?? Number.POSITIVE_INFINITY);
        if (leftPrice !== rightPrice) return leftPrice - rightPrice;
        return String(left?.name || '').localeCompare(String(right?.name || ''));
    });
}

function getWhatsappCountryStatus(countryName) {
    const directMatch = whatsappCountryStatus[String(countryName || '').trim()];
    if (!directMatch || typeof directMatch !== 'object') return null;
    const label = String(directMatch.label || '').trim();
    const color = String(directMatch.color || '').trim().toLowerCase();
    if (!label || !color) return null;
    return {
        label,
        color
    };
}

async function decorateCountriesWithOtpQuality(serviceType, countries) {
    const normalizedServiceType = String(serviceType || '').trim().toLowerCase();
    const serviceConfig = getServiceConfig(normalizedServiceType);
    const preserveCountryOrder = normalizedServiceType === 'whatsapp' || serviceConfig?.preserveCountryOrder === true;
    const baseCountries = preserveCountryOrder
        ? (Array.isArray(countries) ? [...countries] : [])
        : sortCountriesByPrice(countries);
    return baseCountries.map((country, index) => {
        const nextCountry = { ...country };
        if (Object.prototype.hasOwnProperty.call(nextCountry, 'otpQuality')) {
            delete nextCountry.otpQuality;
        }
        if (Object.prototype.hasOwnProperty.call(nextCountry, 'statusLabel')) {
            delete nextCountry.statusLabel;
        }
        if (Object.prototype.hasOwnProperty.call(nextCountry, 'statusColor')) {
            delete nextCountry.statusColor;
        }
        if (normalizedServiceType !== 'whatsapp') {
            return nextCountry;
        }
        const manualStatus = getWhatsappCountryStatus(nextCountry.name);
        if (!manualStatus) return nextCountry;
        return {
            ...nextCountry,
            statusLabel: manualStatus.label,
            statusColor: manualStatus.color
        };
    }).map((country, index) => {
        if (serviceConfig?.markTopCountriesGoodOtp === true && index < 3) {
            return {
                ...country,
                statusLabel: 'Good OTP',
                statusColor: 'green'
            };
        }
        return country;
    });
}

function parseV1NumberResponse(text) {
    const raw = String(text || '').trim();
    if (raw.startsWith('ACCESS_NUMBER:')) {
        const parts = raw.split(':');
        if (parts.length >= 3) {
            return {
                success: true,
                activationId: parts[1],
                phoneNumber: parts[2].startsWith('+') ? parts[2] : `+${parts[2]}`
            };
        }
    }
    return { success: false, error: raw || 'No number available' };
}

function parseNumberResponse(data) {
    if (typeof data === 'string') {
        const trimmed = data.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                return parseNumberResponse(JSON.parse(trimmed));
            } catch {
                return parseV1NumberResponse(trimmed);
            }
        }
        return parseV1NumberResponse(trimmed);
    }
    if (data && typeof data === 'object') {
        if (data.activationId && data.phoneNumber) {
            return {
                success: true,
                activationId: String(data.activationId),
                phoneNumber: String(data.phoneNumber).startsWith('+')
                    ? String(data.phoneNumber)
                    : `+${String(data.phoneNumber)}`,
                activationCost: data.activationCost == null ? null : Number(data.activationCost),
                countryCode: String(data.countryCode || '').trim() || null,
                activationOperator: String(data.activationOperator || '').trim() || null,
                activationTime: data.activationTime || null,
                canGetAnotherSms: Boolean(data.canGetAnotherSms)
            };
        }
    }
    return { success: false, error: 'No number available' };
}

function extractProvidersRecursive(node, bucket = [], seen = new Set()) {
    if (!node || typeof node !== 'object') return bucket;
    if (
        Object.prototype.hasOwnProperty.call(node, 'provider_id') &&
        Object.prototype.hasOwnProperty.call(node, 'price')
    ) {
        const providerId = Number(node.provider_id);
        const providerPrice = Number(node.price);
        if (!Number.isNaN(providerId) && !Number.isNaN(providerPrice)) {
            const key = `${providerId}:${providerPrice}`;
            if (!seen.has(key)) {
                seen.add(key);
                bucket.push({
                    provider_id: providerId,
                    price: providerPrice,
                    count: node.count
                });
            }
        }
    }
    for (const value of Object.values(node)) {
        if (value && typeof value === 'object') {
            extractProvidersRecursive(value, bucket, seen);
        }
    }
    return bucket;
}

async function fetchProviderTiers(countryId, serviceCode = 'wa') {
    const url = `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}&action=getPricesV3&service=${serviceCode}&country=${countryId}`;
    const response = await axios.get(url, { timeout: 15000 });
    const data = response.data;
    let providers = [];
    if (data && typeof data === 'object') {
        const countryNode =
            data[String(countryId)] ??
            data[countryId] ??
            (Object.keys(data).length === 1 ? Object.values(data)[0] : null);
        const serviceNode =
            countryNode?.[serviceCode] ??
            (countryNode && Object.keys(countryNode).length === 1 ? Object.values(countryNode)[0] : null);
        providers = extractProvidersRecursive(serviceNode || data);
    }
    providers = providers
        .filter((p) => Number.isFinite(p.provider_id) && Number.isFinite(p.price))
        .sort((a, b) => a.price - b.price);
    return providers;
}

async function buyNumberFromProviderWithRetry(countryId, provider, serviceCode = 'wa', maxAttempts = 3, delayMs = 5000) {
    let lastError = 'No number from provider';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await buyNumberFromProvider(countryId, provider, serviceCode);
        if (result.success) return result;
        lastError = result.error || lastError;
        if (attempt < maxAttempts) await waitMs(delayMs);
    }
    return { success: false, error: lastError };
}

async function buyNumberFromProvider(countryId, provider, serviceCode = 'wa') {
    const url =
        `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}` +
        `&action=getNumberV2` +
        `&service=${serviceCode}` +
        `&country=${countryId}` +
        `&maxPrice=${provider.price}` +
        `&providerIds=${provider.provider_id}`;
    try {
        const response = await axios.get(url, { timeout: 15000 });
        const parsed = parseNumberResponse(response.data);
        if (parsed.success) {
            return {
                ...parsed,
                provider_id: provider.provider_id,
                provider_price: provider.price,
                activationCost: parsed.activationCost,
                countryCode: parsed.countryCode,
                activationOperator: parsed.activationOperator,
                activationTime: parsed.activationTime,
                canGetAnotherSms: parsed.canGetAnotherSms
            };
        }
        return { success: false, error: parsed.error || 'No number from provider' };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function buyNumberByTierStrategy(countryId, clientMaxUsd, serviceCode = 'wa') {
    try {
        const providers = await fetchProviderTiers(countryId, serviceCode);
        const affordableProviders = providers
            .filter((p) => p.price <= clientMaxUsd + 0.000001)
            .slice(0, 5);
        if (!affordableProviders.length) {
            return {
                success: false,
                strategy: 'provider_unavailable',
                error: 'No provider tiers available in your price range'
            };
        }
        for (const provider of affordableProviders) {
            const startedAt = Date.now();
            let lastError = 'No number from provider';
            while (Date.now() - startedAt < 15000) {
                const result = await buyNumberFromProvider(countryId, provider, serviceCode);
                if (result.success) {
                    return {
                        success: true,
                        activationId: result.activationId,
                        phoneNumber: result.phoneNumber,
                        strategy: 'provider',
                        provider_id: result.provider_id,
                        provider_price: result.provider_price,
                        activationCost: result.activationCost,
                        countryCode: result.countryCode,
                        activationOperator: result.activationOperator,
                        activationTime: result.activationTime,
                        canGetAnotherSms: result.canGetAnotherSms
                    };
                }
                lastError = result.error || lastError;
                const elapsed = Date.now() - startedAt;
                const remaining = 15000 - elapsed;
                if (remaining <= 0) break;
                await waitMs(Math.min(5000, remaining));
            }
        }
        return {
            success: false,
            strategy: 'provider_exhausted',
            error: 'No number found in lowest 5 price tiers'
        };
    } catch (err) {
        return {
            success: false,
            strategy: 'provider_unavailable',
            error: err.message
        };
    }
}

async function buyNumberWithRetry(countryId, baseUsdPrice, maxAttempts = 3, serviceCode = 'wa') {
    const priceSteps = [];
    for (let i = 0; i < maxAttempts; i++) {
        priceSteps.push((baseUsdPrice * (1 + i * 0.05)).toFixed(3));
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const maxPriceUSD = priceSteps[attempt - 1];
        try {
            const url = `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}&action=getNumber&service=${serviceCode}&country=${countryId}&maxPrice=${maxPriceUSD}`;
            const response = await axios.get(url, { timeout: 15000 });
            const parsed = parseNumberResponse(response.data);
            if (parsed.success) {
                return {
                    success: true,
                    activationId: parsed.activationId,
                    phoneNumber: parsed.phoneNumber,
                    strategy: 'fallback',
                    activationCost: parsed.activationCost,
                    countryCode: parsed.countryCode,
                    activationOperator: parsed.activationOperator,
                    activationTime: parsed.activationTime,
                    canGetAnotherSms: parsed.canGetAnotherSms
                };
            }
            if (attempt < maxAttempts) {
                await waitMs(8000);
            }
        } catch (err) {
            if (attempt === maxAttempts) {
                return { success: false, error: err.message };
            }
            await waitMs(8000);
        }
    }
    return { success: false, error: 'No number available after all attempts' };
}

async function getBestAvailableNumber(countryId, clientMaxUsd, serviceCode = 'wa') {
    let result = await buyNumberByTierStrategy(countryId, clientMaxUsd, serviceCode);
    if (!result.success && result.strategy === 'provider_unavailable') {
        result = await buyNumberWithRetry(countryId, clientMaxUsd, 3, serviceCode);
    }
    return result;
}

/*
 * ===========================================================================
 * MANUAL TIER SYSTEM (client-selectable series, no database changes)
 * ===========================================================================
 * This lets us expose individual SMS Bower provider "series" to the client
 * as separate tiers, each with our own custom PKR price, instead of the fully
 * automatic background tier-fallback used by getBestAvailableNumber() above.
 *
 * How it works:
 *  - TIER_PRICING_PKR below defines, per service + countryId, an ordered list
 *    of custom prices (Tier 1, Tier 2, Tier 3 ...).
 *  - At request time we call fetchProviderTiers() (already used elsewhere) to
 *    get the LIVE list of SMS Bower providers/series for that country, sorted
 *    cheapest-first, and we pair them up positionally with our custom prices
 *    (cheapest live provider = Tier 1, next = Tier 2, etc).
 *  - Nothing is stored in the database for this mapping; it is always
 *    recomputed live, so it can never go stale and needs zero migrations.
 *
 * To add/edit tiers for a country, just edit TIER_PRICING_PKR below.
 */
const TIER_PRICING_PKR = {
    whatsapp: {
        // ======================== BRAZIL (73) ========================
        73: {
            // \u{1F949} BRONZE
            2579: 1137,
            3264: 659,
            2738: 427,
            3193: 362,
            2951: 361,
            3252: 360,
            3365: 358,
            3335: 348,
            3415: 347,
            3413: 346,
            3398: 345,
            3274: 304,
            3363: 303,
            // \u{1F948} SILVER
            3229: 324,
            // \u{1F947} GOLD
            3412: 358,
            2404: 289
        },
        // ======================== CANADA (36) ========================
        36: {
            // \u{1F949} BRONZE
            2462: 344,
            2567: 227,
            2430: 215,
            2675: 215,
            3109: 200,
            3001: 190,
            3160: 140,
            2217: 132,
            3198: 131,
            3228: 130,
            // \u{1F948} SILVER
            2568: 215,
            2262: 168,
            // \u{1F947} GOLD
            3406: 180
        },
        // ======================== COLOMBIA (33) ========================
        33: {
            // \u{1F949} BRONZE
            2579: 593,
            3193: 204,
            3109: 143,
            3288: 140,
            // \u{1F947} GOLD
            2335: 190,
            2286: 130,
            3243: 119,
            3253: 114,
            2236: 110
        },
        // ======================== INDIA (22) ========================
        22: {
            // \u{1F949} BRONZE (all)
            2579: 700,
            3406: 560,
            3193: 530
        },
        // ======================== INDONESIA (6) ========================
        6: {
            // \u{1F949} BRONZE
            2260: 253,
            2750: 253,
            54: 173,
            3001: 110,
            3386: 105,
            3094: 104,
            3355: 103,
            1056: 102,
            3160: 101,
            3347: 100,
            3168: 99,
            3417: 98,
            3109: 90,
            // \u{1F948} SILVER
            3406: 110,
            3426: 91,
            3320: 92,
            2272: 93,
            3334: 94,
            3267: 96,
            // \u{1F947} GOLD
            3424: 130,
            3029: 130,
            3061: 170,
            3327: 180
        },
        // ======================== PHILIPPINES (4) ========================
        4: {
            // \u{1F949} BRONZE
            2750: 350,
            2263: 349,
            2739: 244,
            3193: 204,
            2217: 190,
            3160: 190,
            3001: 144,
            3109: 140,
            // \u{1F948} SILVER
            3371: 143
        },
        // ======================== SAUDI ARABIA (53) ========================
        53: {
            // \u{1F949} BRONZE
            3160: 355,
            // \u{1F947} GOLD
            2377: 320
        },
        // ======================== SOUTH AFRICA (31) ========================
        31: {
            // \u{1F949} BRONZE (all)
            2260: 220,
            2217: 200,
            3001: 110,
            3160: 110,
            3109: 100,
            3155: 44
        },
        // ======================== THAILAND (52) ========================
        52: {
            // \u{1F949} BRONZE
            2750: 426,
            3335: 342,
            3193: 230,
            3109: 200,
            2217: 188,
            3001: 190,
            // \u{1F948} SILVER
            3371: 392,
            3237: 200
        },
        // ======================== UNITED KINGDOM (16) ========================
        16: {
            // \u{1F949} BRONZE
            2750: 616,
            2260: 616,
            2295: 403,
            3309: 477,
            1015: 475,
            3402: 444,
            2476: 419,
            3397: 411,
            2442: 410,
            3094: 400,
            3328: 390,
            3329: 380,
            3212: 370,
            3160: 360,
            3168: 340,
            3109: 330,
            // \u{1F947} GOLD
            3368: 329
        },
        // ======================== USA (187) ========================
        187: {
            // \u{1F949} BRONZE
            3370: 1515,
            2617: 1515,
            3237: 1007,
            3109: 470,
            // \u{1F948} SILVER
            3193: 607,
            // \u{1F947} GOLD
            3170: 523,
            2266: 472,
            2268: 470
        },
        // ======================== VIETNAM (10) ========================
        10: {
            // \u{1F949} BRONZE (all)
            2750: 300,
            3001: 200,
            3237: 197,
            2840: 196,
            3082: 194,
            3160: 160,
            2318: 130,
            3109: 100
        },

        // ======================== NEW COUNTRIES (Chile \u{2192} Singapore) ========================
        // ======================== CHILE (151) ========================
        151: {
            2750: 508,
            3428: 508,
            3193: 214,
            2217: 161,
            3160: 120,
            3001: 121,
            3235: 122,
            3109: 123
        },
        // ======================== SYRIA (1333) ========================
        1333: {
            3370: 196,
            3428: 196,
            3168: 181,
            3001: 120
        },
        // ======================== SOMALIA (149) ========================
        149: {
            3370: 196,
            3428: 196,
            3001: 120
        },
        // ======================== KYRGYZSTAN (11) ========================
        11: {
            2750: 239,
            3193: 213,
            3001: 120,
            3109: 121,
            3178: 120
        },
        // ======================== IRAQ (47) ========================
        47: {
            2260: 303,
            3428: 303,
            3193: 213,
            2217: 161,
            3001: 120
        },
        // ======================== MONGOLIA (72) ========================
        72: {
            2579: 337,
            3428: 337,
            3193: 213,
            3225: 179,
            3001: 120
        },
        // ======================== MYANMAR (5) ========================
        5: {
            2579: 224,
            3428: 224,
            3193: 213,
            3001: 120,
            3178: 120
        },
        // ======================== CAMEROON (41) ========================
        41: {
            2750: 619,
            3428: 619,
            2567: 373,
            3193: 213,
            2263: 165,
            2354: 120,
            3001: 120,
            3109: 121,
            3168: 122,
            2709: 123
        },
        // ======================== MADAGASCAR (17) ========================
        17: {
            2579: 264,
            3428: 264,
            3168: 248,
            2217: 233,
            3001: 120,
            3109: 121
        },
        // ======================== TANZANIA (9) ========================
        9: {
            2750: 196,
            3428: 196,
            3168: 135,
            2354: 120,
            3001: 120
        },
        // ======================== SURINAME (142) ========================
        142: {
            3370: 196,
            3428: 196,
            3001: 120
        },
        // ======================== UZBEKISTAN (40) ========================
        40: {
            3160: 253,
            3428: 253,
            3193: 213,
            3168: 185,
            3001: 120
        },
        // ======================== TAJIKISTAN (143) ========================
        143: {
            2579: 219,
            3193: 213,
            3001: 120,
            3225: 121
        },
        // ======================== ZIMBABWE (96) ========================
        96: {
            3160: 196,
            3428: 196,
            3001: 120
        },
        // ======================== ETHIOPIA (71) ========================
        71: {
            2750: 196,
            3428: 196,
            3001: 120,
            3168: 121
        },
        // ======================== TUNISIA (89) ========================
        89: {
            2750: 196,
            3428: 196,
            3168: 134,
            3001: 120,
            3178: 120
        },
        // ======================== MAURITIUS (157) ========================
        157: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== MOROCCO (37) ========================
        37: {
            2260: 507,
            3428: 507,
            2217: 477,
            2567: 373,
            3193: 213,
            3225: 134,
            3309: 120,
            3371: 121,
            3001: 120,
            3335: 122,
            3178: 120
        },
        // ======================== YEMEN (30) ========================
        30: {
            2579: 303,
            3428: 303,
            3193: 213,
            3001: 120,
            2377: 121
        },
        // ======================== CAMBODIA (24) ========================
        24: {
            2260: 507,
            3428: 507,
            3193: 213,
            3001: 120
        },
        // ======================== PERU (65) ========================
        65: {
            2260: 280,
            3428: 280,
            3193: 213,
            3109: 142,
            2354: 120,
            3001: 120
        },
        // ======================== HONG KONG (14) ========================
        14: {
            2260: 786,
            2579: 694,
            3428: 694,
            3328: 349,
            2217: 264,
            3193: 213,
            2318: 157,
            3001: 120
        },
        // ======================== ARGENTINA (39) ========================
        39: {
            2579: 870,
            2750: 507,
            2567: 373,
            2263: 333,
            3109: 306,
            2738: 302,
            2286: 221,
            3193: 213,
            3160: 179,
            3335: 124,
            3237: 120,
            3056: 121,
            3001: 120
        },
        // ======================== NEW ZEALAND (67) ========================
        67: {
            2750: 18567,
            3428: 18567,
            3160: 482,
            3237: 383,
            3001: 120
        },
        // ======================== SIERRA LEONE (115) ========================
        115: {
            2750: 196,
            3428: 196,
            3001: 120
        },
        // ======================== BANGLADESH (60) ========================
        60: {
            3160: 196,
            3428: 196,
            3001: 120
        },
        // ======================== BOLIVIA (92) ========================
        92: {
            2750: 196,
            3428: 196,
            3001: 120
        },
        // ======================== SENEGAL (61) ========================
        61: {
            2750: 196,
            3428: 196,
            3001: 120
        },
        // ======================== EGYPT (21) ========================
        21: {
            2260: 280,
            3428: 280,
            3193: 213,
            2750: 196,
            3001: 120,
            3160: 121
        },
        // ======================== MOLDOVA (85) ========================
        85: {
            2260: 896,
            3370: 791,
            3428: 791,
            2738: 227,
            3237: 179,
            3239: 121
        },
        // ======================== IRELAND (23) ========================
        23: {
            2260: 2476,
            3428: 2476,
            2738: 1561,
            2263: 1388,
            3329: 1186,
            3225: 314,
            3160: 296,
            3001: 120
        },
        // ======================== KENYA (8) ========================
        8: {
            2260: 280,
            3428: 280,
            3193: 213,
            3160: 151,
            3001: 120
        },
        // ======================== UKRAINE (1) ========================
        1: {
            2260: 743,
            3428: 743,
            3177: 381,
            3309: 345,
            3418: 336,
            3340: 291,
            3335: 277,
            3168: 233
        },
        // ======================== GREECE (129) ========================
        129: {
            2260: 1783,
            3428: 1783,
            2738: 608,
            2263: 507,
            2739: 379,
            3248: 314,
            3193: 213,
            3309: 211,
            3418: 198,
            3109: 151,
            3001: 120,
            3237: 121
        },
        // ======================== LATVIA (49) ========================
        49: {
            2260: 571,
            3428: 571,
            2476: 556,
            3237: 540,
            3340: 527,
            3335: 448,
            3193: 213,
            3001: 120
        },
        // ======================== SEYCHELLES (184) ========================
        184: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== FRANCE (78) ========================
        78: {
            2579: 1977,
            3428: 1977,
            2750: 1486,
            2442: 1301,
            3329: 1107,
            3237: 991,
            2738: 890,
            3418: 746,
            3160: 738,
            3335: 559,
            3109: 521,
            3193: 213
        },
        // ======================== UGANDA (75) ========================
        75: {
            2750: 196,
            3428: 196,
            3001: 120
        },
        // ======================== KAZAKHSTAN (2) ========================
        2: {
            2260: 3929,
            2579: 3467,
            3428: 3467,
            2750: 1857,
            3237: 1591,
            3335: 1310,
            3001: 120
        },
        // ======================== BELGIUM (82) ========================
        82: {
            3370: 3954,
            3309: 2195,
            2750: 1857,
            3225: 420,
            3160: 269,
            3001: 120
        },
        // ======================== BURUNDI (119) ========================
        119: {
            2750: 196,
            3428: 196,
            3001: 120
        },
        // ======================== ZAMBIA (147) ========================
        147: {
            2750: 196,
            3428: 196,
            3178: 179,
            3001: 120
        },
        // ======================== GHANA (38) ========================
        38: {
            2750: 196,
            3428: 196,
            2217: 187,
            2354: 120,
            3001: 120
        },
        // ======================== NEPAL (81) ========================
        81: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== ARMENIA (148) ========================
        148: {
            2750: 196,
            3001: 120
        },
        // ======================== ALGERIA (58) ========================
        58: {
            2750: 196,
            3428: 196,
            3001: 120
        },
        // ======================== GUINEA (68) ========================
        68: {
            2750: 196,
            3428: 196,
            2354: 120,
            3001: 120,
            3168: 121
        },
        // ======================== BOTSWANA (123) ========================
        123: {
            2579: 196,
            3428: 196,
            2354: 120,
            3001: 120,
            3160: 121
        },
        // ======================== NAMIBIA (138) ========================
        138: {
            3370: 196,
            3428: 196,
            3001: 120
        },
        // ======================== MACEDONIA (183) ========================
        183: {
            2750: 196,
            3001: 120
        },
        // ======================== CAF (125) ========================
        125: {
            3225: 196,
            3428: 196,
            3001: 120
        },
        // ======================== ECUADOR (105) ========================
        105: {
            2579: 196,
            3428: 196,
            3168: 128,
            3160: 120,
            3001: 120
        },
        // ======================== NICARAGUA (90) ========================
        90: {
            2750: 196,
            3428: 196,
            3001: 120
        },
        // ======================== EL SALVADOR (101) ========================
        101: {
            2750: 196,
            3001: 120
        },
        // ======================== CUBA (113) ========================
        113: {
            2750: 196,
            3428: 196,
            3001: 120
        },
        // ======================== ANGOLA (76) ========================
        76: {
            2260: 196,
            3428: 196,
            3160: 126,
            3001: 120
        },
        // ======================== BELIZE (124) ========================
        124: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== SRI LANKA (64) ========================
        64: {
            2579: 196,
            3428: 196,
            2354: 120,
            3001: 120,
            3160: 121
        },
        // ======================== FIJI (189) ========================
        189: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== MOZAMBIQUE (80) ========================
        80: {
            2579: 196,
            3428: 196,
            2354: 120,
            3001: 120
        },
        // ======================== SOUTH SUDAN (177) ========================
        177: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== GUATEMALA (94) ========================
        94: {
            2260: 196,
            3428: 196,
            3001: 120
        },
        // ======================== TOGO (99) ========================
        99: {
            2750: 196,
            3428: 196,
            3168: 170,
            3001: 120
        },
        // ======================== GAMBIA (28) ========================
        28: {
            2750: 196,
            3428: 196,
            3001: 120
        },
        // ======================== GABON (154) ========================
        154: {
            2750: 196,
            3428: 196,
            3001: 120
        },
        // ======================== GUINEA-BISSAU (130) ========================
        130: {
            2750: 196,
            3428: 196,
            3001: 120
        },
        // ======================== CAPE VERDE (186) ========================
        186: {
            2579: 196,
            3428: 196,
            2354: 120,
            3001: 120
        },
        // ======================== SUDAN (1010) ========================
        1010: {
            2750: 196,
            3001: 120
        },
        // ======================== HAITI (26) ========================
        26: {
            2750: 196,
            3428: 196,
            3001: 120
        },
        // ======================== PANAMA (112) ========================
        112: {
            2750: 196,
            3428: 196,
            3001: 120
        },
        // ======================== BOSNIA AND HERZEGOVINA (108) ========================
        108: {
            2750: 196,
            3001: 120
        },
        // ======================== BARBADOS (118) ========================
        118: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== MAURITANIA (114) ========================
        114: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== NIGERIA (19) ========================
        19: {
            2579: 280,
            3330: 280,
            3428: 280,
            3335: 223,
            3193: 213,
            2217: 173,
            3001: 120,
            3178: 120,
            3168: 121
        },
        // ======================== LESOTHO (136) ========================
        136: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== GUADELOUPE (160) ========================
        160: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== MALAWI (137) ========================
        137: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== LEBANON (153) ========================
        153: {
            2750: 196,
            3428: 196,
            3168: 160,
            3001: 120
        },
        // ======================== CHAD (42) ========================
        42: {
            2260: 196,
            3428: 196,
            3001: 120
        },
        // ======================== CONGO DEM REPUBLIC (18) ========================
        18: {
            2260: 196,
            3428: 196,
            2354: 120,
            3001: 120
        },
        // ======================== BAHAMAS (122) ========================
        122: {
            3370: 196,
            3428: 196,
            3001: 120
        },
        // ======================== MALDIVES (159) ========================
        159: {
            3160: 196,
            3428: 196,
            3001: 120
        },
        // ======================== PARAGUAY (87) ========================
        87: {
            2750: 196,
            3001: 120
        },
        // ======================== RWANDA (140) ========================
        140: {
            3370: 196,
            3428: 196,
            3001: 120
        },
        // ======================== BENIN (120) ========================
        120: {
            2750: 196,
            3428: 196,
            3001: 120,
            3168: 121
        },
        // ======================== REUNION (146) ========================
        146: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== EQUATORIAL GUINEA (167) ========================
        167: {
            3370: 196,
            3428: 196,
            3001: 120
        },
        // ======================== LUXEMBOURG (165) ========================
        165: {
            2750: 196,
            3001: 120
        },
        // ======================== DJIBOUTI (168) ========================
        168: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== FRENCH GUIANA (162) ========================
        162: {
            2579: 196,
            3001: 120
        },
        // ======================== SAINT LUCIA (164) ========================
        164: {
            2579: 196,
            3001: 120
        },
        // ======================== BRUNEI (121) ========================
        121: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== ARUBA (179) ========================
        179: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== SAO TOME (178) ========================
        178: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== NEW CALEDONIA (185) ========================
        185: {
            2579: 196,
            3428: 196,
            3001: 120
        },
        // ======================== MACAU (20) ========================
        20: {
            2217: 231,
            3001: 120
        },
        // ======================== SWITZERLAND (173) ========================
        173: {
            2750: 1610,
            3225: 224,
            3193: 213,
            3001: 120
        },
        // ======================== ROMANIA (32) ========================
        32: {
            2260: 805,
            3428: 805,
            3328: 636,
            2738: 608,
            2263: 507,
            3109: 428,
            2739: 368,
            3335: 216,
            3193: 213,
            3312: 172,
            3237: 144,
            3001: 120
        },
        // ======================== PORTUGAL (117) ========================
        117: {
            2579: 1300,
            3428: 1300,
            2263: 1001,
            2567: 791,
            3087: 791,
            2442: 647,
            2739: 607,
            3160: 606,
            3314: 550,
            3329: 486,
            3309: 450,
            3371: 379,
            3094: 374,
            3340: 374,
            3193: 213
        },
        // ======================== MEXICO (54) ========================
        54: {
            2579: 448,
            3330: 420,
            3370: 420,
            2750: 309,
            3109: 299,
            3160: 291,
            3193: 213,
            2354: 120
        },
        // ======================== POLAND (15) ========================
        15: {
            2579: 1581,
            3428: 1581,
            2738: 830,
            2263: 692,
            2295: 507,
            2739: 496,
            1015: 486,
            3418: 368,
            2217: 330,
            2284: 290,
            3094: 281,
            3309: 265,
            3109: 255,
            3328: 237,
            3193: 213,
            3237: 211,
            3001: 120
        },
        // ======================== CZECH REPUBLIC (63) ========================
        63: {
            2579: 2846,
            3428: 2846,
            2567: 1845,
            2750: 1114,
            2738: 949,
            3418: 890,
            2263: 791,
            3335: 656,
            2295: 608,
            3087: 587,
            3309: 575,
            2739: 567,
            2291: 508,
            3193: 213,
            3001: 120
        },
        // ======================== DENMARK (172) ========================
        172: {
            2750: 991,
            2260: 991,
            3428: 991,
            2263: 956,
            3237: 515,
            3193: 213,
            3001: 120
        },
        // ======================== VENEZUELA (70) ========================
        70: {
            2579: 280,
            3428: 280,
            3193: 213,
            2750: 196,
            3001: 120,
            3160: 121
        },
        // ======================== ESTONIA (34) ========================
        34: {
            2750: 595,
            3428: 595,
            2738: 569,
            3309: 562,
            3193: 213,
            3001: 120
        },
        // ======================== GEORGIA (128) ========================
        128: {
            2750: 507,
            3428: 507,
            3309: 407,
            3335: 248,
            3193: 213,
            3001: 120
        },
        // ======================== LAOS (25) ========================
        25: {
            2579: 258,
            3428: 258,
            2217: 233,
            3193: 213,
            3001: 120
        },
        // ======================== HUNGARY (84) ========================
        84: {
            2750: 3095,
            3428: 3095,
            3309: 1806,
            3237: 1449,
            3193: 213,
            3001: 120
        },
        // ======================== BULGARIA (83) ========================
        83: {
            2260: 672,
            2263: 608,
            3428: 608,
            2750: 507,
            3335: 372,
            3193: 213,
            3237: 181,
            3001: 120
        },
        // ======================== AZERBAIJAN (35) ========================
        35: {
            3330: 337,
            3428: 337,
            3193: 213
        },
        // ======================== TAIWAN (55) ========================
        55: {
            3330: 303,
            3428: 303,
            3193: 213,
            3001: 120
        },
        // ======================== HONDURAS (88) ========================
        88: {
            2579: 280,
            3428: 280,
            3193: 213,
            2750: 196,
            3001: 120
        },
        // ======================== CROATIA (45) ========================
        45: {
            2579: 1384,
            3428: 1384,
            2750: 1040,
            3335: 743,
            2738: 426,
            3193: 213,
            3001: 120
        },
        // ======================== LIBERIA (135) ========================
        135: {
            2579: 369,
            3428: 369,
            3193: 213,
            2750: 196,
            3001: 120,
            3109: 121,
            3160: 122
        },
        // ======================== LITHUANIA (44) ========================
        44: {
            2750: 743,
            3428: 743,
            3309: 705,
            3193: 213,
            3001: 120
        },
        // ======================== MONACO (144) ========================
        144: {
            2750: 571,
            3428: 571,
            3193: 213,
            3001: 120
        },
        // ======================== MALI (69) ========================
        69: {
            2750: 264,
            3428: 264,
            2217: 233,
            3193: 213,
            3001: 120
        },
        // ======================== FINLAND (163) ========================
        163: {
            2750: 891,
            3428: 891,
            3193: 213,
            3001: 120
        },
        // ======================== COMOROS (133) ========================
        133: {
            3370: 280,
            3428: 280,
            3001: 120
        },
        // ======================== TIMOR-LESTE (91) ========================
        91: {
            3370: 280,
            3428: 280,
            3001: 120,
            3160: 121
        },
        // ======================== ERITREA (176) ========================
        176: {
            2579: 351,
            3428: 351,
            3001: 120
        },
        // ======================== SLOVAKIA (141) ========================
        141: {
            2579: 3136,
            3370: 2767,
            2750: 352,
            3193: 213,
            3001: 120
        },
        // ======================== GERMANY (43) ========================
        43: {
            2579: 3163,
            3428: 3163,
            2750: 2476,
            3193: 1783,
            2738: 1441,
            2263: 1378,
            3329: 1265,
            3394: 1202,
            3418: 709,
            3087: 486,
            3225: 420
        },
        // ======================== ITALY (86) ========================
        86: {
            2579: 3954,
            3428: 3954,
            2750: 2674,
            2738: 2410,
            2263: 2372,
            2739: 2069,
            3304: 1972,
            3418: 1482,
            3335: 1092,
            3406: 791,
            3160: 608,
            3193: 213,
            2354: 120
        },
        // ======================== PUERTO RICO (97) ========================
        97: {
            2579: 448,
            3370: 420,
            3428: 420,
            3001: 120
        },
        // ======================== IRAN (57) ========================
        57: {
            3193: 456,
            3428: 456,
            3001: 120
        },
        // ======================== SWEDEN (46) ========================
        46: {
            2750: 1238,
            3428: 1238,
            2738: 854,
            2263: 712,
            2739: 588,
            3087: 527,
            3094: 416,
            3296: 378,
            3237: 374
        },
        // ======================== IVORY COAST (27) ========================
        27: {
            2260: 702,
            3193: 619,
            3428: 619,
            3237: 350,
            2750: 247,
            32: 193,
            3001: 120,
            3168: 121
        },
        // ======================== URUGUAY (156) ========================
        156: {
            2260: 619,
            3428: 619,
            3001: 120
        },
        // ======================== AUSTRALIA (175) ========================
        175: {
            2260: 24761,
            3428: 24761,
            3237: 8633,
            2293: 6980,
            2567: 6676,
            3193: 4329,
            2738: 987,
            2263: 712,
            2442: 710,
            3109: 246
        },
        // ======================== SPAIN (56) ========================
        56: {
            2260: 2476,
            3428: 2476,
            2738: 2148,
            2263: 1432,
            2739: 1170,
            3329: 949,
            3109: 625,
            3160: 592,
            3335: 469
        },
        // ======================== TURKEY (62) ========================
        62: {
            3370: 991,
            3428: 991,
            3329: 675,
            3094: 650,
            3335: 563,
            2750: 303,
            3193: 213,
            3001: 120
        },
        // ======================== CYPRUS (77) ========================
        77: {
            2750: 991,
            3428: 991,
            3193: 213,
            3001: 120
        },
        // ======================== AUSTRIA (50) ========================
        50: {
            2260: 4085,
            3428: 4085,
            2567: 3064,
            2738: 2584,
            2263: 2405,
            3109: 1200,
            3335: 1186,
            3329: 1178,
            3193: 213,
            3001: 120,
            3160: 121
        },
        // ======================== JAPAN (1001) ========================
        1001: {
            2260: 9904,
            3428: 9904,
            2567: 4744,
            3109: 598,
            2217: 491,
            3160: 348,
            3001: 120
        },
        // ======================== GIBRALTAR (201) ========================
        201: {
            2750: 7135,
            3428: 7135
        },
        // ======================== SINGAPORE (196) ========================
        196: {
            2260: 19805,
            3428: 19805,
            3001: 120
        }
    },
    facebook: {
        // ======================== CANADA (36) ========================
        36: {
            2750: 74,
            3330: 75,
            3428: 110,
            3001: 79,
            3198: 90,
            2441: 78,
            2748: 73,
            3160: 74,
            2266: 79,
            3140: 73
        },
        // ======================== USA VIRTUAL (12) ========================
        12: {
            2750: 94,
            2461: 94,
            2858: 97,
            2440: 94,
            2681: 74,
            2567: 74,
            3154: 75,
            3140: 72,
            2266: 70,
            3209: 71,
            3160: 70,
            2262: 70,
            3228: 69
        },
        // ======================== USA (187) ========================
        187: {
            3370: 622,
            2617: 535,
            3177: 403,
            3193: 247,
            2738: 224,
            3170: 192,
            2263: 160,
            2495: 99,
            3182: 80
        }
    }
};
const PROVIDER_RANK_CONFIG = {
    // ===== EXISTING RANKS =====
    // Brazil
    2404: 'Gold',
    3412: 'Gold',
    3229: 'Silver',
    // Canada
    3406: 'Gold',
    2262: 'Silver',
    2568: 'Silver',
    // Colombia
    3288: 'Gold',
    2236: 'Gold',
    3253: 'Gold',
    3243: 'Gold',
    2286: 'Gold',
    2335: 'Gold',
    // Indonesia
    3327: 'Gold',
    3061: 'Gold',
    3029: 'Gold',
    3424: 'Gold',
    3267: 'Silver',
    3334: 'Silver',
    2272: 'Silver',
    3320: 'Silver',
    3426: 'Silver',
    3406: 'Silver',
    // Philippines
    3371: 'Silver',
    // Thailand
    3237: 'Silver',
    // UK
    3368: 'Gold',
    // USA (WhatsApp)
    2268: 'Gold',
    2266: 'Gold',
    3170: 'Gold',
    3193: 'Silver',

    // ===== FACEBOOK RANKS =====
    // USA
    3370: 'Gold',
    2617: 'Silver',
    3193: 'Bronze',
    // Canada
    3406: 'Gold',
    2262: 'Silver',
    2462: 'Bronze',
    // Pakistan
    3109: 'Gold',
    3160: 'Silver',
    3001: 'Bronze',

    // ===== NEW WHATSAPP RANKS (all new countries) =====
    // Chile
    3428: 'Gold',
    3109: 'Gold',
    3193: 'Bronze',
    2217: 'Bronze',
    2750: 'Bronze',
    3160: 'Bronze',
    3001: 'Bronze',
    3235: 'Bronze',
    // Syria
    3428: 'Gold',
    3370: 'Bronze',
    3168: 'Bronze',
    3001: 'Bronze',
    // Somalia
    3428: 'Gold',
    3370: 'Bronze',
    3001: 'Bronze',
    // Kyrgyzstan
    3178: 'Gold',
    3109: 'Silver',
    2750: 'Bronze',
    3193: 'Bronze',
    3001: 'Bronze',
    // Iraq
    3428: 'Gold',
    2260: 'Bronze',
    3193: 'Bronze',
    2217: 'Bronze',
    3001: 'Bronze',
    // Mongolia
    3428: 'Gold',
    2579: 'Bronze',
    3193: 'Bronze',
    3225: 'Bronze',
    3001: 'Bronze',
    // Myanmar
    3428: 'Gold',
    3178: 'Silver',
    2579: 'Bronze',
    3193: 'Bronze',
    3001: 'Bronze',
    // Cameroon
    3428: 'Gold',
    2709: 'Silver',
    3109: 'Bronze',
    3168: 'Bronze',
    2750: 'Bronze',
    2567: 'Bronze',
    3193: 'Bronze',
    2263: 'Bronze',
    2354: 'Bronze',
    3001: 'Bronze',
    // Madagascar
    3428: 'Gold',
    3109: 'Silver',
    2579: 'Bronze',
    3168: 'Bronze',
    2217: 'Bronze',
    3001: 'Bronze',
    // Tanzania
    3428: 'Gold',
    3001: 'Silver',
    2354: 'Bronze',
    2750: 'Bronze',
    3168: 'Bronze',
    // Suriname
    3428: 'Gold',
    3370: 'Bronze',
    3001: 'Bronze',
    // Uzbekistan
    3428: 'Gold',
    3160: 'Bronze',
    3193: 'Bronze',
    3168: 'Bronze',
    3001: 'Bronze',
    // Tajikistan
    3225: 'Gold',
    3001: 'Silver',
    2579: 'Bronze',
    3193: 'Bronze',
    // Zimbabwe
    3428: 'Gold',
    3160: 'Bronze',
    3001: 'Bronze',
    // Ethiopia
    3428: 'Gold',
    3168: 'Silver',
    2750: 'Bronze',
    3001: 'Bronze',
    // Tunisia
    3178: 'Gold',
    3001: 'Silver',
    2750: 'Bronze',
    3428: 'Bronze',
    3168: 'Bronze',
    // Mauritius
    3428: 'Gold',
    2579: 'Bronze',
    3001: 'Bronze',
    // Morocco
    3178: 'Gold',
    3001: 'Silver',
    3335: 'Bronze',
    3371: 'Bronze',
    3309: 'Bronze',
    3225: 'Bronze',
    2260: 'Bronze',
    3428: 'Bronze',
    2217: 'Bronze',
    2567: 'Bronze',
    3193: 'Bronze',
    // Yemen
    2377: 'Gold',
    3001: 'Silver',
    2579: 'Bronze',
    3428: 'Bronze',
    3193: 'Bronze',
    // Cambodia
    3428: 'Gold',
    2260: 'Bronze',
    3193: 'Bronze',
    3001: 'Bronze',
    // Peru
    3428: 'Gold',
    3001: 'Silver',
    2354: 'Bronze',
    2260: 'Bronze',
    3193: 'Bronze',
    3109: 'Bronze',
    // Hong Kong
    3428: 'Gold',
    3001: 'Silver',
    2260: 'Bronze',
    2579: 'Bronze',
    3328: 'Bronze',
    2217: 'Bronze',
    3193: 'Bronze',
    2318: 'Bronze',
    // Argentina
    3428: 'Gold',
    3056: 'Silver',
    3237: 'Bronze',
    3001: 'Bronze',
    2579: 'Bronze',
    2750: 'Bronze',
    2567: 'Bronze',
    2263: 'Bronze',
    3109: 'Bronze',
    2738: 'Bronze',
    2286: 'Bronze',
    3193: 'Bronze',
    3160: 'Bronze',
    3335: 'Bronze',
    // New Zealand
    3428: 'Gold',
    3001: 'Silver',
    2750: 'Bronze',
    3160: 'Bronze',
    3237: 'Bronze',
    // Sierra Leone
    3428: 'Gold',
    2750: 'Bronze',
    3001: 'Bronze',
    // Bangladesh
    3428: 'Gold',
    3160: 'Bronze',
    3001: 'Bronze',
    // Bolivia
    3428: 'Gold',
    2750: 'Bronze',
    3001: 'Bronze',
    // Senegal
    3428: 'Gold',
    2750: 'Bronze',
    3001: 'Bronze',
    // Egypt
    3428: 'Gold',
    3160: 'Silver',
    3001: 'Bronze',
    2260: 'Bronze',
    3193: 'Bronze',
    2750: 'Bronze',
    // Moldova
    3428: 'Gold',
    3239: 'Silver',
    3370: 'Bronze',
    2260: 'Bronze',
    2738: 'Bronze',
    3237: 'Bronze',
    // Ireland
    3428: 'Gold',
    3001: 'Silver',
    2260: 'Bronze',
    2738: 'Bronze',
    2263: 'Bronze',
    3329: 'Bronze',
    3225: 'Bronze',
    3160: 'Bronze',
    // Kenya
    3428: 'Gold',
    3001: 'Silver',
    2260: 'Bronze',
    3193: 'Bronze',
    3160: 'Bronze',
    // Ukraine
    3428: 'Gold',
    2260: 'Bronze',
    3177: 'Bronze',
    3309: 'Bronze',
    3418: 'Bronze',
    3340: 'Bronze',
    3335: 'Bronze',
    3168: 'Bronze',
    // Greece
    3428: 'Gold',
    3001: 'Silver',
    3237: 'Bronze',
    2260: 'Bronze',
    2738: 'Bronze',
    2263: 'Bronze',
    2739: 'Bronze',
    3248: 'Bronze',
    3193: 'Bronze',
    3309: 'Bronze',
    3418: 'Bronze',
    3109: 'Bronze',
    // Latvia
    3428: 'Gold',
    3001: 'Silver',
    2260: 'Bronze',
    2476: 'Bronze',
    3237: 'Bronze',
    3340: 'Bronze',
    3335: 'Bronze',
    3193: 'Bronze',
    // Seychelles
    3428: 'Gold',
    2579: 'Bronze',
    3001: 'Bronze',
    // France
    3428: 'Gold',
    3193: 'Silver',
    2579: 'Bronze',
    2750: 'Bronze',
    2442: 'Bronze',
    3329: 'Bronze',
    3237: 'Bronze',
    2738: 'Bronze',
    3418: 'Bronze',
    3160: 'Bronze',
    3335: 'Bronze',
    3109: 'Bronze',
    // Uganda
    3428: 'Gold',
    2750: 'Bronze',
    3001: 'Bronze',
    // Kazakhstan
    3428: 'Gold',
    3001: 'Silver',
    2260: 'Bronze',
    2579: 'Bronze',
    2750: 'Bronze',
    3237: 'Bronze',
    3335: 'Bronze',
    // Belgium
    3309: 'Gold',   // cheapest provider is 3001 but rank not given; I'll assign Gold to 3309 based on original rank? Actually original rank not given for Belgium; I'll set 3001 as Silver, 3309 as Bronze, etc.
    3428: 'Gold',
    3001: 'Silver',
    3370: 'Bronze',
    2750: 'Bronze',
    3225: 'Bronze',
    3160: 'Bronze',
    // Zambia
    3428: 'Gold',
    3001: 'Silver',
    2750: 'Bronze',
    3178: 'Bronze',
    // Ghana
    3428: 'Gold',
    3001: 'Silver',
    2354: 'Bronze',
    2750: 'Bronze',
    2217: 'Bronze',
    // Nigeria
    3428: 'Gold',
    3178: 'Silver',
    3168: 'Bronze',
    3001: 'Bronze',
    2579: 'Bronze',
    3330: 'Bronze',
    3335: 'Bronze',
    3193: 'Bronze',
    2217: 'Bronze',
    // Lesotho
    3428: 'Gold',
    2579: 'Bronze',
    3001: 'Bronze',
    // Guadeloupe
    3428: 'Gold',
    2579: 'Bronze',
    3001: 'Bronze',
    // Malawi
    3428: 'Gold',
    2579: 'Bronze',
    3001: 'Bronze',
    // Lebanon
    3428: 'Gold',
    3001: 'Silver',
    2750: 'Bronze',
    3168: 'Bronze',
    // Chad
    3428: 'Gold',
    2260: 'Bronze',
    3001: 'Bronze',
    // Congo DR
    3428: 'Gold',
    3001: 'Silver',
    2354: 'Bronze',
    2260: 'Bronze',
    // Bahamas
    3428: 'Gold',
    3370: 'Bronze',
    3001: 'Bronze',
    // Maldives
    3428: 'Gold',
    3160: 'Bronze',
    3001: 'Bronze',
    // Paraguay
    2750: 'Bronze',
    3001: 'Bronze',
    // Rwanda
    3428: 'Gold',
    3370: 'Bronze',
    3001: 'Bronze',
    // Benin
    3428: 'Gold',
    3168: 'Silver',
    2750: 'Bronze',
    3001: 'Bronze',
    // Reunion
    3428: 'Gold',
    2579: 'Bronze',
    3001: 'Bronze',
    // Equatorial Guinea
    3428: 'Gold',
    3370: 'Bronze',
    3001: 'Bronze',
    // Luxembourg
    2750: 'Bronze',
    3001: 'Bronze',
    // Djibouti
    3428: 'Gold',
    2579: 'Bronze',
    3001: 'Bronze',
    // French Guiana
    2579: 'Bronze',
    3001: 'Bronze',
    // Saint Lucia
    2579: 'Bronze',
    3001: 'Bronze',
    // Brunei
    3428: 'Gold',
    2579: 'Bronze',
    3001: 'Bronze',
    // Aruba
    3428: 'Gold',
    2579: 'Bronze',
    3001: 'Bronze',
    // Sao Tome
    3428: 'Gold',
    2579: 'Bronze',
    3001: 'Bronze',
    // New Caledonia
    3428: 'Gold',
    2579: 'Bronze',
    3001: 'Bronze',
    // Macau
    2217: 'Bronze',
    3001: 'Bronze',
    // Switzerland
    2750: 'Bronze',
    3225: 'Bronze',
    3193: 'Bronze',
    3001: 'Bronze',
    // Romania
    3428: 'Gold',
    3001: 'Silver',
    2260: 'Bronze',
    3328: 'Bronze',
    2738: 'Bronze',
    2263: 'Bronze',
    3109: 'Bronze',
    2739: 'Bronze',
    3335: 'Bronze',
    3193: 'Bronze',
    3312: 'Bronze',
    3237: 'Bronze',
    // Portugal
    3428: 'Gold',
    3193: 'Silver',
    2579: 'Bronze',
    2263: 'Bronze',
    2567: 'Bronze',
    3087: 'Bronze',
    2442: 'Bronze',
    2739: 'Bronze',
    3160: 'Bronze',
    3314: 'Bronze',
    3329: 'Bronze',
    3309: 'Bronze',
    3371: 'Bronze',
    3094: 'Bronze',
    3340: 'Bronze',
    // Mexico
    2354: 'Gold',
    3370: 'Bronze',
    3330: 'Bronze',
    2579: 'Bronze',
    2750: 'Bronze',
    3109: 'Bronze',
    3160: 'Bronze',
    3193: 'Bronze',
    // Poland
    3428: 'Gold',
    3001: 'Silver',
    2579: 'Bronze',
    2738: 'Bronze',
    2263: 'Bronze',
    2295: 'Bronze',
    2739: 'Bronze',
    1015: 'Bronze',
    3418: 'Bronze',
    2217: 'Bronze',
    2284: 'Bronze',
    3094: 'Bronze',
    3309: 'Bronze',
    3109: 'Bronze',
    3328: 'Bronze',
    3193: 'Bronze',
    3237: 'Bronze',
    // Czech Republic
    3428: 'Gold',
    3001: 'Silver',
    2579: 'Bronze',
    2567: 'Bronze',
    2750: 'Bronze',
    2738: 'Bronze',
    3418: 'Bronze',
    2263: 'Bronze',
    3335: 'Bronze',
    2295: 'Bronze',
    3087: 'Bronze',
    3309: 'Bronze',
    2739: 'Bronze',
    2291: 'Bronze',
    3193: 'Bronze',
    // Denmark
    3428: 'Gold',
    3001: 'Silver',
    2750: 'Bronze',
    2260: 'Bronze',
    2263: 'Bronze',
    3237: 'Bronze',
    3193: 'Bronze',
    // Venezuela
    3428: 'Gold',
    3160: 'Silver',
    3001: 'Bronze',
    2579: 'Bronze',
    3193: 'Bronze',
    2750: 'Bronze',
    // Estonia
    3428: 'Gold',
    3001: 'Silver',
    2750: 'Bronze',
    2738: 'Bronze',
    3309: 'Bronze',
    3193: 'Bronze',
    // Georgia
    3428: 'Gold',
    3001: 'Silver',
    2750: 'Bronze',
    3309: 'Bronze',
    3335: 'Bronze',
    3193: 'Bronze',
    // Laos
    3428: 'Gold',
    3001: 'Silver',
    2579: 'Bronze',
    2217: 'Bronze',
    3193: 'Bronze',
    // Hungary
    3428: 'Gold',
    3001: 'Silver',
    2750: 'Bronze',
    3309: 'Bronze',
    3237: 'Bronze',
    3193: 'Bronze',
    // Bulgaria
    3428: 'Gold',
    3001: 'Silver',
    2260: 'Bronze',
    2263: 'Bronze',
    2750: 'Bronze',
    3335: 'Bronze',
    3193: 'Bronze',
    3237: 'Bronze',
    // Azerbaijan
    3428: 'Gold',
    3330: 'Bronze',
    3193: 'Bronze',
    // Taiwan
    3428: 'Gold',
    3001: 'Silver',
    3330: 'Bronze',
    3193: 'Bronze',
    // Honduras
    3428: 'Gold',
    3001: 'Silver',
    2579: 'Bronze',
    3193: 'Bronze',
    2750: 'Bronze',
    // Croatia
    3428: 'Gold',
    3001: 'Silver',
    2579: 'Bronze',
    2750: 'Bronze',
    3335: 'Bronze',
    2738: 'Bronze',
    3193: 'Bronze',
    // Liberia
    3160: 'Gold',
    3109: 'Silver',
    3428: 'Bronze',
    2579: 'Bronze',
    3193: 'Bronze',
    2750: 'Bronze',
    3001: 'Bronze',
    // Lithuania
    3428: 'Gold',
    3001: 'Silver',
    2750: 'Bronze',
    3309: 'Bronze',
    3193: 'Bronze',
    // Monaco
    3428: 'Gold',
    3001: 'Silver',
    2750: 'Bronze',
    3193: 'Bronze',
    // Mali
    3428: 'Gold',
    3001: 'Silver',
    2750: 'Bronze',
    2217: 'Bronze',
    3193: 'Bronze',
    // Finland
    3428: 'Gold',
    3001: 'Silver',
    2750: 'Bronze',
    3193: 'Bronze',
    // Comoros
    3428: 'Gold',
    3370: 'Bronze',
    3001: 'Bronze',
    // Timor-Leste
    3428: 'Gold',
    3160: 'Silver',
    3370: 'Bronze',
    3001: 'Bronze',
    // Eritrea
    3428: 'Gold',
    2579: 'Bronze',
    3001: 'Bronze',
    // Slovakia
    3428: 'Gold',
    3001: 'Silver',
    2579: 'Bronze',
    3370: 'Bronze',
    2750: 'Bronze',
    3193: 'Bronze',
    // Germany
    3428: 'Gold',
    3225: 'Silver',
    2579: 'Bronze',
    2750: 'Bronze',
    3193: 'Bronze',
    2738: 'Bronze',
    2263: 'Bronze',
    3329: 'Bronze',
    3394: 'Bronze',
    3418: 'Bronze',
    3087: 'Bronze',
    // Italy
    3428: 'Gold',
    2354: 'Silver',
    2579: 'Bronze',
    2750: 'Bronze',
    2738: 'Bronze',
    2263: 'Bronze',
    2739: 'Bronze',
    3304: 'Bronze',
    3418: 'Bronze',
    3335: 'Bronze',
    3406: 'Bronze',
    3160: 'Bronze',
    3193: 'Bronze',
    // Puerto Rico
    3428: 'Gold',
    3001: 'Silver',
    2579: 'Bronze',
    3370: 'Bronze',
    // Iran
    3428: 'Gold',
    3001: 'Silver',
    3193: 'Bronze',
    // Sweden
    3428: 'Gold',
    2750: 'Bronze',
    2738: 'Bronze',
    2263: 'Bronze',
    2739: 'Bronze',
    3087: 'Bronze',
    3094: 'Bronze',
    3296: 'Bronze',
    3237: 'Bronze',
    // Ivory Coast
    3428: 'Gold',
    3168: 'Silver',
    3001: 'Bronze',
    2260: 'Bronze',
    3193: 'Bronze',
    3237: 'Bronze',
    2750: 'Bronze',
    32: 'Bronze',
    // Uruguay
    3428: 'Gold',
    2260: 'Bronze',
    3001: 'Bronze',
    // Australia
    3428: 'Gold',
    3109: 'Silver',
    2260: 'Bronze',
    3237: 'Bronze',
    2293: 'Bronze',
    2567: 'Bronze',
    3193: 'Bronze',
    2738: 'Bronze',
    2263: 'Bronze',
    2442: 'Bronze',
    // Spain
    3428: 'Gold',
    3335: 'Silver',
    2260: 'Bronze',
    2738: 'Bronze',
    2263: 'Bronze',
    2739: 'Bronze',
    3329: 'Bronze',
    3109: 'Bronze',
    3160: 'Bronze',
    // Turkey
    3428: 'Gold',
    3001: 'Silver',
    3370: 'Bronze',
    3329: 'Bronze',
    3094: 'Bronze',
    3335: 'Bronze',
    2750: 'Bronze',
    3193: 'Bronze',
    // Cyprus
    3428: 'Gold',
    3001: 'Silver',
    2750: 'Bronze',
    3193: 'Bronze',
    // Austria
    3428: 'Gold',
    3160: 'Silver',
    3001: 'Bronze',
    2260: 'Bronze',
    2567: 'Bronze',
    2738: 'Bronze',
    2263: 'Bronze',
    3109: 'Bronze',
    3335: 'Bronze',
    3329: 'Bronze',
    3193: 'Bronze',
    // Japan
    3428: 'Gold',
    3001: 'Silver',
    2260: 'Bronze',
    2567: 'Bronze',
    3109: 'Bronze',
    2217: 'Bronze',
    3160: 'Bronze',
    // Gibraltar
    3428: 'Gold',
    2750: 'Bronze',
    // Singapore
    3428: 'Gold',
    3001: 'Silver',
    2260: 'Bronze'
};
function getProviderRank(providerId) {
    return PROVIDER_RANK_CONFIG[Number(providerId)] || 'Bronze';
}

function getTierPriceMap(serviceType, countryId) {
    const serviceKey = String(serviceType || '').trim().toLowerCase();
    const serviceTiers = TIER_PRICING_PKR[serviceKey];
    if (!serviceTiers) return null;
    const entry = serviceTiers[Number(countryId)];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    return Object.keys(entry).length ? entry : null;
}

function getTierPriceList(serviceType, countryId) {
    const map = getTierPriceMap(serviceType, countryId);
    if (!map) return null;
    return Object.values(map).map(Number);
}

async function getLiveTiersForCountry(serviceType, serviceCode, countryId) {
    const priceMap = getTierPriceMap(serviceType, countryId);
    if (!priceMap) return [];
    let providers = [];
    try {
        providers = await fetchProviderTiers(countryId, serviceCode);
    } catch {
        providers = [];
    }
    if (!providers.length) return [];
    const tiers = [];
    let tierNum = 1;
    for (const provider of providers) {
        const pid = Number(provider.provider_id);
        if (priceMap[pid] == null) continue;
        tiers.push({
            tierNumber: tierNum++,
            price: Number(priceMap[pid]),
          rank: getProviderRank(pid),
            providerId: pid,
            count: provider.count ?? null
        });
    }
    return tiers;
}

// ===== AUTO TIER BUYER (used by /api/order) =====
async function buyNumberWithAutoTier(countryId, serviceCode, serviceType) {
    const priceMap = getTierPriceMap(serviceType, countryId);
    if (!priceMap) {
        return buyNumberWithRetry(countryId, 1, 3, serviceCode);
    }
    let providers = [];
    try {
        providers = await fetchProviderTiers(countryId, serviceCode);
    } catch {
        return { success: false, error: 'Provider list unavailable' };
    }
    for (const provider of providers) {
        const pid = Number(provider.provider_id);
        if (!priceMap[pid]) continue;
        const customPrice = Number(priceMap[pid]);
        const result = await buyNumberFromProviderWithRetry(
            countryId,
            { provider_id: pid, price: pkrToUsd(customPrice) },
            serviceCode,
            2,
            3000
        );
        if (result.success) {
            result.customPricePkr = customPrice;
            return result;
        }
    }
    return buyNumberWithRetry(countryId, 1, 3, serviceCode);
}

// ===== ROUTES =====
app.get('/api/tiers/:service/:countryId', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    try {
        const serviceConfig = getServiceConfig(req.params.service);
        if (!serviceConfig || !serviceConfig.serviceCode) {
            return res.status(400).send('Invalid service selected');
        }
        const countryId = Number(req.params.countryId);
        if (!Number.isFinite(countryId)) {
            return res.status(400).send('Invalid country');
        }
        if (req.query.debug === '1') {
            const tierPrices = getTierPriceList(serviceConfig.serviceType, countryId);
            let rawProviders = [];
            let fetchError = null;
            try {
                rawProviders = await fetchProviderTiers(countryId, serviceConfig.serviceCode);
            } catch (e) {
                fetchError = e.message;
            }
            return res.json({
                debug: true,
                serviceType: serviceConfig.serviceType,
                serviceCode: serviceConfig.serviceCode,
                countryId,
                tierPricesConfigured: tierPrices,
                rawProviderCount: rawProviders.length,
                rawProviders: rawProviders.slice(0, 10),
                fetchError
            });
        }
        const tiers = await getLiveTiersForCountry(serviceConfig.serviceType, serviceConfig.serviceCode, countryId);
        res.json({ tiers });
    } catch (err) {
        res.status(500).send('Server error');
    }
});

app.post('/api/order/tier', ensureAuth, async (req, res) => {
    const client = await pool.connect();
    let activationToRelease = null;
    try {
        const { countryName, countryId, service, tierNumber } = req.body;
        const lockedProviderId = Number(req.body.providerId);
        const idempotencyKey = String(req.body.idempotencyKey || '').trim();
        if (!idempotencyKey || idempotencyKey.length < 8) {
            return res.status(400).send('Idempotency key is required');
        }
        const serviceConfig = getServiceConfig(service || 'whatsapp');
        if (!serviceConfig || !serviceConfig.serviceCode) {
            return res.status(400).send('Invalid service selected');
        }
        const countryObj = serviceConfig.countries.find((c) => Number(c.countryId) === Number(countryId));
        const resolvedCountryName = countryName || countryObj?.name || '';
        const tierIndex = Number(tierNumber);
        if (!Number.isFinite(tierIndex) || tierIndex < 1) {
            return res.status(400).send('Invalid tier selected');
        }

        const existingQuickMatch = await queryOne(
            'SELECT id, phone_number FROM orders WHERE user_id = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1',
            [req.session.userId, idempotencyKey]
        );
        if (existingQuickMatch) {
            return res.json({ id: existingQuickMatch.id, number: existingQuickMatch.phone_number, duplicate: true });
        }

        await assertUserNotSecurityBlocked(req.session.userId);

        const priceMap = getTierPriceMap(serviceConfig.serviceType, Number(countryId));
        if (!priceMap) {
            return res.status(400).send('Selected tier is not available right now');
        }
        // Get price directly from provider ID (not by index \u{2014} index order is unreliable)
        const tierPricesList = Object.values(priceMap).map(Number);
        let orderPrice = null;
        if (Number.isFinite(lockedProviderId) && lockedProviderId > 0 && priceMap[lockedProviderId] != null) {
            orderPrice = Number(priceMap[lockedProviderId]);
        } else {
            orderPrice = tierPricesList[tierIndex - 1] ?? null;
        }
        if (!orderPrice || orderPrice <= 0) {
            return res.status(400).send('Selected tier is not available right now');
        }

        let selectedProviderId = null;
        if (Number.isFinite(lockedProviderId) && lockedProviderId > 0) {
            selectedProviderId = lockedProviderId;
        } else {
            const liveTiers = await getLiveTiersForCountry(serviceConfig.serviceType, serviceConfig.serviceCode, Number(countryId));
            const selectedTier = liveTiers.find((t) => t.tierNumber === tierIndex);
            if (!selectedTier) {
                return res.status(400).send('Selected tier is not available right now');
            }
            selectedProviderId = selectedTier.providerId;
        }
        if (!selectedProviderId) {
            return res.status(400).send('Selected tier is not available right now');
        }

        const latestProviderSnapshot = await getLatestProviderBalanceSnapshot();
        const providerBalanceBeforePurchase = await getProviderBalance();
        const result = await buyNumberFromProviderWithRetry(
            Number(countryId),
            { provider_id: selectedProviderId, price: pkrToUsd(orderPrice) },
            serviceConfig.serviceCode,
            3,
            5000
        );
        if (!result.success) {
            return res.status(500).send('Number not available on this series right now, please try another tier');
        }
        activationToRelease = result.activationId || null;
        const providerBalanceAfterPurchase = await getProviderBalance();
        const providerCostMetrics = computeProviderCostMetrics({
            balanceBefore: providerBalanceBeforePurchase.success ? providerBalanceBeforePurchase.balance : null,
            balanceAfter: providerBalanceAfterPurchase.success ? providerBalanceAfterPurchase.balance : null,
            activationCost: result.activationCost,
            providerPrice: result.provider_price
        });
        const providerCostPKR = providerCostMetrics.providerCostPkr;
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 25 * 60 * 1000).toISOString();
        const cancelAvailableAt = new Date(now.getTime() + 17 * 1000).toISOString();

        await client.query('BEGIN');
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
        const user = userRes.rows[0];
        if (!user) {
            await client.query('ROLLBACK');
            return res.status(401).send('User not found');
        }
        await assertUserNotSecurityBlocked(user.id, { client });

        const existingByIdempotency = await client.query(
            'SELECT id, phone_number FROM orders WHERE user_id = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1',
            [user.id, idempotencyKey]
        );
        if (existingByIdempotency.rowCount > 0) {
            await client.query('COMMIT');
            activationToRelease = result.activationId || null;
            return res.json({
                id: existingByIdempotency.rows[0].id,
                number: existingByIdempotency.rows[0].phone_number,
                duplicate: true
            });
        }

        const activeOrdersCountRes = await client.query(
            `SELECT COUNT(*)::int AS total FROM orders
             WHERE user_id = $1 AND COALESCE(status, order_status, 'pending') IN ('pending', 'active', 'completed_waiting_user_action')`,
            [user.id]
        );
        const activeOrdersCount = Number(activeOrdersCountRes.rows[0]?.total || 0);
        if (activeOrdersCount >= 10) {
            await client.query('ROLLBACK');
            return res.status(409).send('You can only have 10 active orders at a time. Complete or cancel one first.');
        }

        const deductionRes = await client.query(
            'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance',
            [orderPrice, user.id]
        );
        if (deductionRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(400).send('Insufficient balance. Please add funds.');
        }

        const inserted = await client.query(`
            INSERT INTO orders (
                user_id, user_email, service_type, service_name, country, country_code, country_id,
                price, provider_cost_pkr, payment_method, order_status, status,
                phone_number, activation_id, username_snapshot,
                expires_at, cancel_available_at, last_purchase_at, idempotency_key, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                      $13, $14, $15, $16, $17, $18, $19, $20)
            RETURNING *
        `, [
            user.id, user.email, serviceConfig.serviceType, serviceConfig.serviceName,
            resolvedCountryName, countryObj?.code || '', Number(countryId),
            orderPrice, providerCostPKR, 'balance', 'pending', 'pending',
            result.phoneNumber, result.activationId, user.name,
            expiresAt, cancelAvailableAt, now.toISOString(), idempotencyKey, now.toISOString()
        ]);

        const createdOrder = await syncOrderFinancialProtection(inserted.rows[0], {
            websiteCharge: orderPrice,
            websiteRefund: 0,
            websiteProfit: orderPrice,
            realProviderCost: providerCostMetrics.providerCostPkr,
            realProviderCostProviderCurrency: providerCostMetrics.providerCurrencyCost,
            providerCostSource: providerCostMetrics.costSource,
            providerCostVerified: providerCostMetrics.costSource != null,
            providerBalanceBefore: providerBalanceBeforePurchase.success ? providerBalanceBeforePurchase.balance : null,
            providerBalanceAfter: providerBalanceAfterPurchase.success ? providerBalanceAfterPurchase.balance : null,
            providerBalanceCurrency: providerBalanceAfterPurchase.currency || providerBalanceBeforePurchase.currency || PROVIDER_BALANCE_CURRENCY,
            providerPartnerId: result.provider_id || null,
            providerPriceUsd: result.provider_price || result.activationCost || 0,
            providerStatus: ORDER_PROVIDER_WAITING_STATUS,
            providerFinalStatus: null,
            providerCountry: resolvedCountryName,
            providerService: serviceConfig.serviceCode,
            providerPhoneNumber: result.phoneNumber,
            providerStatusSyncedAt: now.toISOString(),
            usernameSnapshot: user.name,
            syncNumberHistory: true,
            syncUserRisk: false,
            recordRiskEvent: false,
            eventAt: now.toISOString()
        }, { client });

        if (providerBalanceAfterPurchase.success) {
            await insertProviderBalanceSnapshot({
                orderId: createdOrder?.id || inserted.rows[0]?.id,
                userId: user.id,
                activationId: result.activationId,
                reason: 'order_purchase_after',
                providerBalance: providerBalanceAfterPurchase.balance,
                previousBalance: providerBalanceBeforePurchase.success
                    ? providerBalanceBeforePurchase.balance
                    : (latestProviderSnapshot?.provider_balance == null ? null : Number(latestProviderSnapshot.provider_balance)),
                expectedSpendPkr: providerCostMetrics.providerCostPkr,
                note: providerCostMetrics.costSource || 'order_purchase'
            }, { client });
        }

        await client.query(
            'INSERT INTO transactions (user_id, user_email, amount, type, status, description) VALUES ($1, $2, $3, $4, $5, $6)',
            [user.id, user.email, orderPrice, 'deduction', 'approved', `${serviceConfig.serviceName} Tier ${tierIndex} \u{2022} ${resolvedCountryName}`]
        );

        await client.query('COMMIT');
        activationToRelease = null;
        res.json({
            id: createdOrder?.id || inserted.rows[0].id,
            number: result.phoneNumber,
            tierNumber: tierIndex,
            nextTierNumber: tierPricesList[tierIndex] ? tierIndex + 1 : null
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err && err.code === '23505') {
            const dedupedOrder = await queryOne(
                'SELECT id, phone_number FROM orders WHERE user_id = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1',
                [req.session.userId, String(req.body.idempotencyKey || '').trim()]
            );
            if (dedupedOrder) {
                return res.json({ id: dedupedOrder.id, number: dedupedOrder.phone_number, duplicate: true });
            }
        }
        res.status(500).send(formatSafeError(err, 'Order failed. Please try again.'));
    } finally {
        if (activationToRelease) {
            await updateProviderActivationStatus(activationToRelease, 8);
        }
        client.release();
    }
});
/* =========================== END MANUAL TIER SYSTEM =========================== */

async function checkSmsStatus(activationId) {
    try {
        const url = `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}&action=getStatus&id=${activationId}`;
        const response = await axios.get(url, { timeout: 15000 });
        const resText = String(response.data || '').trim();
        if (resText.startsWith('STATUS_OK:')) {
            return { success: true, code: resText.slice('STATUS_OK:'.length), raw: resText };
        }
        if (resText === ORDER_PROVIDER_WAITING_STATUS) {
            return { success: true, waiting: true, raw: resText };
        }
        return { success: false, raw: resText };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function ensureAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).send('Login required');
    next();
}

async function ensureAdmin(req, res, next) {
    try {
        if (!req.session.userId) return res.status(401).send('Login required');
        const user = await findUserById(req.session.userId);
        if (!isAdminUser(user)) return res.status(403).send('Admin only');
        req.user = user;
        next();
    } catch {
        res.status(500).send('Server error');
    }
}

const authRoutes = createAuthRouter
    ? createAuthRouter({
        passport,
        queryOne,
        queryRun,
        hashPassword,
        randomPassword,
        sanitizeEmail,
        createUser,
        normalizeReferralCode,
        updateUserLastLogin,
        updateUserLoginAttempts,
        googleClientId: GOOGLE_CLIENT_ID,
        googleClientSecret: GOOGLE_CLIENT_SECRET,
        googleCallbackUrl: GOOGLE_CALLBACK_URL
    })
    : express.Router();

if (!createAuthRouter) {
    console.error('Authentication routes are disabled because the auth module could not be loaded.');
    authRoutes.use((_req, res) => {
        res.status(503).send('Authentication service is temporarily unavailable');
    });
}

app.use('/auth', authRoutes);

app.get('/admin', ensureAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/countries', async (req, res) => {
    try {
        const countries = await decorateCountriesWithOtpQuality('whatsapp', serviceCatalog.whatsapp.countries);
        // For each country, fetch cheapest tier price
        const enriched = await Promise.all(countries.map(async (country) => {
            const countryId = country.countryId;
            const priceMap = getTierPriceMap('whatsapp', countryId);
            let cheapestTierPrice = null;
            if (priceMap) {
                const prices = Object.values(priceMap).map(Number);
                if (prices.length) {
                    cheapestTierPrice = Math.min(...prices);
                }
            }
            return {
                ...country,
                tierPrice: cheapestTierPrice,  // actual price that will be charged
                displayPrice: cheapestTierPrice || country.price // fallback to old price
            };
        }));
        res.json(enriched);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/service-catalog', (_req, res) => {
    try {
        const services = Object.values(serviceCatalog).map((serviceConfig) => ({
            serviceType: serviceConfig.serviceType,
            label: getServiceCatalogLabel(serviceConfig),
            isBuiltIn: BUILT_IN_SERVICE_TYPES.has(serviceConfig.serviceType),
            comingSoon: !serviceConfig.serviceCode,
            canOrder: Boolean(serviceConfig.serviceCode),
            preserveCountryOrder: serviceConfig.preserveCountryOrder === true,
            countryCount: Array.isArray(serviceConfig.countries) ? serviceConfig.countries.length : 0
        }));
        res.json(services);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/service-icons', (_req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=300');
        res.json({
            icons: SERVICE_ICON_MANIFEST,
            summary: SERVICE_ICON_SUMMARY
        });
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/referral-program', ensureAuth, async (req, res) => {
    try {
        const program = await getReferralProgramByUserId(req.session.userId, req);
        if (!program) return res.status(404).send('Referral program unavailable');
        res.json(program);
    } catch (err) {
        res.status(500).send(formatSafeError(err, 'Referral program unavailable'));
    }
});

app.get('/api/facebook/countries', async (req, res) => {
    try {
        res.json(await decorateCountriesWithOtpQuality('facebook', serviceCatalog.facebook.countries));
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/services/:service/countries', async (req, res) => {
    const serviceConfig = getServiceConfig(req.params.service);
    if (!serviceConfig) return res.status(404).send('Service not found');
    try {
        res.json(await decorateCountriesWithOtpQuality(serviceConfig.serviceType || req.params.service, serviceConfig.countries));
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/auth/google', (req, res) => {
    return res.redirect('/auth/google');
});

app.post('/api/forgot-password', async (req, res) => {
    try {
        if (!isMailConfigured()) {
            return res.status(503).send('Password reset email is not configured');
        }
        const email = sanitizeEmail(req.body.email);
        if (!validateEmail(email)) return res.status(400).send('Valid email is required');
        const user = await findUser(email);
        if (user) {
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS).toISOString();
            await savePasswordResetToken(user.id, hashToken(token), expiresAt);
            await sendPasswordResetEmail(user, token);
        }
        res.json({ success: true, message: 'If an account exists for that email, a reset link has been sent.' });
    } catch (err) {
        res.status(500).send(formatSafeError(err, 'Could not send password reset email'));
    }
});

app.get('/api/admin/users', ensureAdmin, async (req, res) => {
    try {
        const users = await getAdminUsers();
        res.json(users);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/admin/balance-adjustments', ensureAdmin, async (req, res) => {
    try {
        const adjustments = await getAllBalanceAdjustments();
        res.json(adjustments);
    } catch {
        res.status(500).send('Server error');
    }
});

app.post('/api/admin/users/:userId/adjust-balance', ensureAdmin, async (req, res) => {
    try {
        const targetUserId = Number(req.params.userId);
        const amount = Number(req.body.amount);
        const reason = String(req.body.reason || '').trim();

        if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
            return res.status(400).send('Invalid user id');
        }
        if (!Number.isFinite(amount) || amount === 0) {
            return res.status(400).send('Amount must be a non-zero number');
        }
        if (!reason) {
            return res.status(400).send('Reason is required');
        }

        const updatedUser = await applyAdminBalanceAdjustment({
            userId: targetUserId,
            adminId: req.user.id,
            amount,
            reason
        });

        res.json({
            success: true,
            user: {
                id: updatedUser.id,
                email: updatedUser.email,
                name: updatedUser.name,
                balance: updatedUser.balance
            }
        });
    } catch (err) {
        res.status(400).send(formatSafeError(err, 'Balance adjustment failed'));
    }
});

app.post('/api/admin/users/:userId/security-action', ensureAdmin, async (req, res) => {
    try {
        const targetUserId = Number(req.params.userId);
        const action = String(req.body.action || '').trim().toLowerCase();
        const reason = String(req.body.reason || '').trim();
        const hours = Number(req.body.hours || 24);
        const result = await applyAdminUserSecurityAction({
            userId: targetUserId,
            action,
            reason,
            hours
        });
        res.json({
            success: true,
            action: result.action,
            reason: result.reason,
            user: result.user
        });
    } catch (err) {
        res.status(400).send(formatSafeError(err, 'User security action failed'));
    }
});

app.get('/api/admin/users/:userId/history', ensureAdmin, async (req, res) => {
    try {
        const targetUserId = Number(req.params.userId);
        if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
            return res.status(400).send('Invalid user id');
        }
        const history = await getUserCombinedHistory(targetUserId);
        res.json(history);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/admin/referrals', ensureAdmin, async (_req, res) => {
    try {
        const referrals = await getAdminReferralRecords();
        res.json(referrals);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/admin/provider-analytics', ensureAdmin, async (_req, res) => {
    try {
        const analytics = await getAdminProviderAnalytics();
        res.json(analytics);
    } catch (err) {
        res.status(500).send(formatSafeError(err, 'Provider analytics unavailable'));
    }
});

app.post('/api/reset-password', async (req, res) => {
    try {
        const token = String(req.body.token || '').trim();
        const newPassword = req.body.newPassword;
        if (!token) return res.status(400).send('Reset token is required');
        if (!validatePassword(newPassword)) {
            return res.status(400).send('New password must be at least 6 characters');
        }
        const user = await findUserByResetToken(token);
        if (!user) return res.status(400).send('Reset link is invalid or expired');
        await updateUserPassword(user.id, newPassword);
        await clearPasswordResetToken(user.id);
        await updateUserLoginAttempts(user.id, 0);
        await queryRun('UPDATE users SET is_active = TRUE WHERE id = $1', [user.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send(formatSafeError(err, 'Could not reset password'));
    }
});

app.post('/api/register', async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        const email = sanitizeEmail(req.body.email);
        const password = req.body.password;
        const referralCode = normalizeReferralCode(req.body.referralCode);
        const signupDeviceFingerprint = normalizeDeviceFingerprint(req.body.deviceFingerprint);
        const signupBrowserFingerprint = normalizeBrowserFingerprint(req.body.browserFingerprint);
        if (!name) return res.status(400).send('Name is required');
        if (!validateEmail(email)) return res.status(400).send('Valid email is required');
        if (!validatePassword(password)) return res.status(400).send('Password must be at least 6 characters');
        const existing = await findUser(email);
        if (existing) return res.status(400).send('Email already exists');
        await createUser(name, email, password, {
            referralCode,
            signupIp: getRequestClientIp(req),
            signupDeviceFingerprint,
            signupBrowserFingerprint
        });
        res.json({ success: true });
    } catch (err) {
        if (String(err?.message || '').toLowerCase().includes('referral code is invalid')) {
            return res.status(400).send('Referral code is invalid');
        }
        res.status(500).send(formatSafeError(err));
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const email = sanitizeEmail(req.body.email);
        const password = req.body.password;
        if (!validateEmail(email)) return res.status(400).send('Valid email is required');
        if (typeof password !== 'string' || !password) return res.status(400).send('Password is required');
        const user = await findUser(email);
        if (!user) {
            return res.status(401).send('Invalid credentials');
        }
        if (!user.is_active) {
            return res.status(401).send('Account blocked');
        }
        const passwordCheck = await verifyPassword(password, user.password);
        if (!passwordCheck.valid) {
            const newAttempts = Number(user.login_attempts || 0) + 1;
            await updateUserLoginAttempts(user.id, newAttempts);
            if (newAttempts >= 5) {
                await queryRun('UPDATE users SET is_active = FALSE WHERE id = $1', [user.id]);
            }
            return res.status(401).send('Invalid credentials');
        }
        if (passwordCheck.needsUpgrade) {
            const upgradedHash = await hashPassword(password);
            await updateUserPasswordHash(user.id, upgradedHash);
        }
        await updateUserLoginAttempts(user.id, 0);
        await updateUserLastLogin(user.id);
        req.session.regenerate((regenErr) => {
            if (regenErr) {
                console.error('Session regenerate error:', regenErr);
                return res.status(500).send('Login failed');
            }
            req.session.userId = user.id;
            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('Session save error:', saveErr);
                    return res.status(500).send('Login failed');
                }
                return res.json({ success: true });
            });
        });
    } catch (err) {
        console.error('Login route error:', err);
        res.status(500).send(formatSafeError(err));
    }
});

app.post('/api/change-password', ensureAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (typeof currentPassword !== 'string' || !currentPassword) {
            return res.status(400).send('Current password is required');
        }
        if (!validatePassword(newPassword)) {
            return res.status(400).send('New password must be at least 6 characters');
        }
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(404).send('User not found');
        const passwordCheck = await verifyPassword(currentPassword, user.password);
        if (!passwordCheck.valid) {
            return res.status(400).send('Current password is incorrect');
        }
        await updateUserPassword(user.id, newPassword);
        res.send('OK');
    } catch (err) {
        res.status(500).send(formatSafeError(err));
    }
});

app.get('/api/me', ensureAuth, async (req, res) => {
    try {
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(401).send('User not found');
        res.json({
            id: user.id,
            name: user.name,
            email: user.email,
            balance: user.balance,
            role: user.role,
            isAdmin: isAdminUser(user),
            referralCode: user.referralCode,
            maskedPassword: '********'
        });
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/logout', (req, res) => {
    req.logout(() => {
        req.session.destroy(() => {
            res.clearCookie('mrf.sid');
            res.send('OK');
        });
    });
});

app.post('/api/order', ensureAuth, async (req, res) => {
    const client = await pool.connect();
    let activationToRelease = null;
    try {
        const { countryName, countryId, service } = req.body;
        const idempotencyKey = String(req.body.idempotencyKey || '').trim();
        if (!idempotencyKey || idempotencyKey.length < 8) {
            return res.status(400).send('Idempotency key is required');
        }
        const serviceConfig = getServiceConfig(service || 'whatsapp');
        if (!serviceConfig) return res.status(400).send('Invalid service selected');
        if (!serviceConfig.serviceCode) {
            return res.status(400).send('This service is available for browsing only right now');
        }
        const countryObj = serviceConfig.countries.find((c) => c.name === countryName && Number(c.countryId) === Number(countryId));
        if (!countryObj) return res.status(400).send('Invalid country selected');

        // Check existing order with same idempotency key
        const existingQuickMatch = await queryOne(
            'SELECT id, phone_number FROM orders WHERE user_id = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1',
            [req.session.userId, idempotencyKey]
        );
        if (existingQuickMatch) {
            return res.json({ id: existingQuickMatch.id, number: existingQuickMatch.phone_number, duplicate: true });
        }

        await assertUserNotSecurityBlocked(req.session.userId);

        // ---- AUTO TIER PURCHASE (uses your new tier map) ----
        const latestProviderSnapshot = await getLatestProviderBalanceSnapshot();
        const providerBalanceBeforePurchase = await getProviderBalance();
        const result = await buyNumberWithAutoTier(
            countryObj.countryId,
            serviceConfig.serviceCode,
            serviceConfig.serviceType
        );
        if (!result.success) {
            return res.status(500).send('Number not available at the moment, please try again later');
        }
        // Use the custom price from tier map if available, otherwise fallback to country price
        const orderPrice = result.customPricePkr || Number(countryObj.price || 0);
        if (orderPrice <= 0) {
            return res.status(400).send('Price not configured for this country');
        }
        // ---- end auto tier ----

        activationToRelease = result.activationId || null;
        const providerBalanceAfterPurchase = await getProviderBalance();
        const providerCostMetrics = computeProviderCostMetrics({
            balanceBefore: providerBalanceBeforePurchase.success ? providerBalanceBeforePurchase.balance : null,
            balanceAfter: providerBalanceAfterPurchase.success ? providerBalanceAfterPurchase.balance : null,
            activationCost: result.activationCost,
            providerPrice: result.provider_price
        });
        const providerCostPKR = providerCostMetrics.providerCostPkr;
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 25 * 60 * 1000).toISOString();
        const cancelAvailableAt = new Date(now.getTime() + 17 * 1000).toISOString();

        await client.query('BEGIN');
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
        const user = userRes.rows[0];
        if (!user) {
            await client.query('ROLLBACK');
            return res.status(401).send('User not found');
        }
        await assertUserNotSecurityBlocked(user.id, { client });

        const existingByIdempotency = await client.query(
            'SELECT id, phone_number FROM orders WHERE user_id = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1',
            [user.id, idempotencyKey]
        );
        if (existingByIdempotency.rowCount > 0) {
            await client.query('COMMIT');
            activationToRelease = result.activationId || null;
            return res.json({
                id: existingByIdempotency.rows[0].id,
                number: existingByIdempotency.rows[0].phone_number,
                duplicate: true
            });
        }

        const activeOrdersCountRes = await client.query(
            `SELECT COUNT(*)::int AS total FROM orders
             WHERE user_id = $1 AND COALESCE(status, order_status, 'pending') IN ('pending', 'active', 'completed_waiting_user_action')`,
            [user.id]
        );
        const activeOrdersCount = Number(activeOrdersCountRes.rows[0]?.total || 0);
        if (activeOrdersCount >= 10) {
            await client.query('ROLLBACK');
            return res.status(409).send('You can only have 10 active orders at a time. Complete or cancel one first.');
        }

        const deductionRes = await client.query(
            'UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance',
            [orderPrice, user.id]
        );
        if (deductionRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(400).send('Insufficient balance. Please add funds.');
        }

        const inserted = await client.query(`
            INSERT INTO orders (
                user_id, user_email, service_type, service_name, country, country_code, country_id,
                price, provider_cost_pkr, payment_method, order_status, status,
                phone_number, activation_id, username_snapshot,
                expires_at, cancel_available_at, last_purchase_at, idempotency_key, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                      $13, $14, $15, $16, $17, $18, $19, $20)
            RETURNING *
        `, [
            user.id, user.email, serviceConfig.serviceType, serviceConfig.serviceName,
            countryName, countryObj.code, countryObj.countryId,
            orderPrice, providerCostPKR, 'balance', 'pending', 'pending',
            result.phoneNumber, result.activationId, user.name,
            expiresAt, cancelAvailableAt, now.toISOString(), idempotencyKey, now.toISOString()
        ]);

        const createdOrder = await syncOrderFinancialProtection(inserted.rows[0], {
            websiteCharge: orderPrice,
            websiteRefund: 0,
            websiteProfit: orderPrice,
            realProviderCost: providerCostMetrics.providerCostPkr,
            realProviderCostProviderCurrency: providerCostMetrics.providerCurrencyCost,
            providerCostSource: providerCostMetrics.costSource,
            providerCostVerified: providerCostMetrics.costSource != null,
            providerBalanceBefore: providerBalanceBeforePurchase.success ? providerBalanceBeforePurchase.balance : null,
            providerBalanceAfter: providerBalanceAfterPurchase.success ? providerBalanceAfterPurchase.balance : null,
            providerBalanceCurrency: providerBalanceAfterPurchase.currency || providerBalanceBeforePurchase.currency || PROVIDER_BALANCE_CURRENCY,
            providerPartnerId: result.provider_id || null,
            providerPriceUsd: result.provider_price || result.activationCost || 0,
            providerStatus: ORDER_PROVIDER_WAITING_STATUS,
            providerFinalStatus: null,
            providerCountry: countryName,
            providerService: serviceConfig.serviceCode,
            providerPhoneNumber: result.phoneNumber,
            providerStatusSyncedAt: now.toISOString(),
            usernameSnapshot: user.name,
            syncNumberHistory: true,
            syncUserRisk: false,
            recordRiskEvent: false,
            eventAt: now.toISOString()
        }, { client });

        await client.query(
            'INSERT INTO transactions (user_id, user_email, amount, type, status, description) VALUES ($1, $2, $3, $4, $5, $6)',
            [user.id, user.email, orderPrice, 'deduction', 'approved', `${serviceConfig.serviceName} \u{2022} ${countryName}`]
        );

        await client.query('COMMIT');
        activationToRelease = null;
        res.json({ id: createdOrder?.id || inserted.rows[0].id, number: result.phoneNumber });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err && err.code === '23505') {
            const dedupedOrder = await queryOne(
                'SELECT id, phone_number FROM orders WHERE user_id = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1',
                [req.session.userId, String(req.body.idempotencyKey || '').trim()]
            );
            if (dedupedOrder) {
                return res.json({ id: dedupedOrder.id, number: dedupedOrder.phone_number, duplicate: true });
            }
        }
        res.status(500).send(formatSafeError(err, 'Order failed. Please try again.'));
    } finally {
        if (activationToRelease) {
            await updateProviderActivationStatus(activationToRelease, 8);
        }
        client.release();
    }
});

app.get('/api/orders/:orderId', ensureAuth, async (req, res) => {
    try {
        let order = await getOrderById(Number(req.params.orderId));
        if (!order) return res.status(404).send('Order not found');
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(401).send('User not found');
        if (order.user_id !== user.id && !isAdminUser(user)) {
            return res.status(403).send('Unauthorized');
        }
        if (getRawOrderStatus(order) === 'pending' && !order.sms_received && !hasStoredOtp(order) && order.expires_at && new Date() >= new Date(order.expires_at)) {
            await expireOrderAndRefund(order.id);
            order = await getOrderById(order.id);
        }
        order = await syncOrderForProviderDisplay(order);
        res.json(order);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/orders', ensureAuth, async (req, res) => {
    try {
        await reconcileExpiredOrdersForUser(req.session.userId);
        const userOrders = await syncUserOrdersForProviderDisplay(await getOrdersByUser(req.session.userId));
        res.json(userOrders);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/number-history', ensureAuth, async (req, res) => {
    try {
        const history = await getNumberHistoryByUser(req.session.userId);
        res.json(history);
    } catch {
        res.status(500).send('Server error');
    }
});

app.post('/api/orders/:orderId/cancel', ensureAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const orderId = Number(req.params.orderId);
        await client.query('BEGIN');
        const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
        let order = normalizeOrder(orderRes.rows[0]);
        if (!order) {
            await client.query('ROLLBACK');
            return res.status(404).send('Order not found');
        }
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
        const user = userRes.rows[0];
        if (!user || order.user_id !== user.id) {
            await client.query('ROLLBACK');
            return res.status(403).send('Unauthorized');
        }
        const auditUsername = getAuditUsername(user, order);
        // Special case: expired SMS-received order — allow cancel with NO refund
        const isExpiredSmsOrder =
            getRawOrderStatus(order) === 'completed_waiting_user_action' &&
            order.expires_at && new Date() >= new Date(order.expires_at);
        if (isExpiredSmsOrder) {
            const cancelledAt = new Date().toISOString();
            const cancelledOrder = await updateOrder(order.id, {
                order_status: 'cancelled',
                status: 'cancelled',
                refund_processing_at: null
            }, { client, eventAt: cancelledAt, finalizedAt: cancelledAt, syncNumberHistory: false });
            await syncOrderFinancialProtection(cancelledOrder || order, {
                websiteCharge: Number(order.price || 0),
                websiteRefund: 0,
                websiteProfit: Number(order.price || 0),
                realProviderCost: getRealProviderCostAmount(order),
                realProviderCostProviderCurrency: roundMoney(order.real_provider_cost_provider_currency || 0, 6),
                providerCostVerified: Boolean(order.provider_cost_verified),
                providerCostSource: order.provider_cost_source || null,
                providerBalanceAfter: order.provider_balance_after || null,
                providerBalanceCurrency: order.provider_balance_currency || PROVIDER_BALANCE_CURRENCY,
                providerStatus: order.provider_final_status || order.provider_status || null,
                providerFinalStatus: order.provider_final_status || null,
                providerStatusSyncedAt: cancelledAt,
                providerUsed: isProviderUsedOrder(order),
                refundedAt: null,
                securityEventType: 'cancel_expired_sms_no_refund',
                reason: 'expired_sms_received_no_refund_cancel',
                recordRiskEvent: false,
                syncNumberHistory: true,
                syncUserRisk: false,
                eventAt: cancelledAt,
                finalizedAt: cancelledAt
            }, { client });
            await client.query('COMMIT');
            logOrderHotfixEvent('cancel_expired_sms_no_refund', order, {
                username: auditUsername,
                cancelTime: cancelledAt,
                reason: 'expired_sms_received_no_refund_cancel',
                refunded: false,
                otpExisted: hasStoredOtp(order)
            });
            return res.status(200).send('Order cancelled. No refund issued.');
        }
        await enforceCancelSecurityLimits(user.id, order, { client });
        if (isRefundProcessing(order)) {
            await client.query('ROLLBACK');
            return res.status(409).send('Refund is already being processed.');
        }
        if (isFinalOrderState(order) || normalizeOrderStatus(order) !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(400).send('Cannot cancel now');
        }
        if (hasStoredOtp(order)) {
            await client.query('ROLLBACK');
            logOrderHotfixEvent('cancel_rejected_existing_otp', order, {
                username: auditUsername,
                cancelTime: new Date().toISOString(),
                providerStatus: getProviderOrderStatus(order),
                reason: 'otp_exists_in_database',
                refunded: false,
                otpExisted: true
            });
            return res.status(400).send('OTP already received, cannot cancel');
        }
        const now = new Date();
        const expiry = order.expires_at ? new Date(order.expires_at) : null;
        const cancelTime = now.toISOString();
        if (order.activation_id) {
            const initialVerification = await verifyRefundEligibilityWithProvider(order);
            if (initialVerification.providerValidationFailed) {
                await client.query('ROLLBACK');
                logOrderHotfixEvent('cancel_blocked_provider_validation', order, {
                    username: auditUsername,
                    cancelTime,
                    providerStatus: initialVerification.decision.providerStatus || null,
                    providerError: initialVerification.providerSignal?.providerError,
                    reason: 'provider_final_verification_failed',
                    refunded: false,
                    otpExisted: initialVerification.decision.otpExists,
                    providerSuccess: initialVerification.decision.providerSuccess
                });
                return res.status(409).send('Cancel temporarily locked while activation status is being verified.');
            }
            if (!initialVerification.decision.refundAllowed) {
                const updatedOrder = initialVerification.providerSignal?.providerReportedNonPending
                    ? await syncOrderWithProviderSignal(order, initialVerification.providerSignal, {
                        client,
                        eventAt: cancelTime,
                        otpReceivedAt: cancelTime
                    })
                    : order;
                await client.query('COMMIT');
                logOrderHotfixEvent(initialVerification.decision.providerOtpExists ? 'cancel_rejected_provider_otp' : 'cancel_rejected_provider_success', updatedOrder, {
                    username: auditUsername,
                    cancelTime,
                    otpArrivalTime: initialVerification.decision.providerOtpExists ? cancelTime : null,
                    providerStatus: initialVerification.decision.providerStatus || null,
                    reason: initialVerification.decision.reason,
                    refunded: false,
                    otpExisted: initialVerification.decision.otpExists,
                    providerSuccess: initialVerification.decision.providerSuccess
                });
                return res.status(400).send(getRefundBlockedMessage(initialVerification.decision, 'cancel'));
            }
        }
        if (expiry && now >= expiry && !hasStoredOtp(order) && getRawOrderStatus(order) === 'pending') {
            await client.query('ROLLBACK');
            const expireResult = await expireOrderAndRefund(order.id);
            return res.status(expireResult.expired ? 200 : 409).send(expireResult.message || EXPIRED_REFUND_MESSAGE);
        }
        const cancelAvailable = new Date(order.cancel_available_at);
        if (now < cancelAvailable) {
            await client.query('ROLLBACK');
            return res.status(400).send(`Please wait ${Math.ceil((cancelAvailable - now) / 1000)} seconds before cancelling.`);
        }
        order = await setRefundProcessingState(order.id, cancelTime, client) || normalizeOrder({
            ...order,
            refund_processing_at: cancelTime
        });
        const providerBalanceBaselineForCancel = await getProviderBalance();
        const cancelResult = await updateProviderActivationStatus(order.activation_id, 8);
        const providerBalanceAfterCancel = await getProviderBalance();
        const providerRecovery = computeProviderRefundRecoveryMetrics(order, {
            balanceBeforeAction: providerBalanceBaselineForCancel.success
                ? providerBalanceBaselineForCancel.balance
                : (order.provider_balance_after == null ? null : Number(order.provider_balance_after)),
            balanceAfterAction: providerBalanceAfterCancel.success
                ? providerBalanceAfterCancel.balance
                : null
        });
        const previousProviderCostCurrency = roundMoney(order.real_provider_cost_provider_currency || 0, 6);
        const providerCostAlreadyClear = previousProviderCostCurrency <= PROVIDER_BALANCE_EPSILON
            && getRealProviderCostAmount(order) <= PROVIDER_BALANCE_EPSILON;
        const providerCostVerified = !order.activation_id
            || providerCostAlreadyClear
            || (providerRecovery.balanceVerified && cancelResult.success);
        const remainingProviderCostCurrency = providerCostAlreadyClear
            ? 0
            : (providerCostVerified ? providerRecovery.remainingCurrency : previousProviderCostCurrency);
        const remainingProviderCostPkr = providerCostAlreadyClear
            ? 0
            : (providerCostVerified ? providerRecovery.remainingPkr : getRealProviderCostAmount(order));
        const finalVerification = await verifyRefundEligibilityWithProvider(order);
        if (!finalVerification.providerValidationFailed && !finalVerification.decision.refundAllowed) {
            const blockedSyncedOrder = finalVerification.providerSignal?.providerReportedNonPending
                ? await syncOrderWithProviderSignal(order, finalVerification.providerSignal, {
                    client,
                    eventAt: cancelTime,
                    otpReceivedAt: cancelTime
                })
                : order;
            const clearedBlockedOrder = await setRefundProcessingState(blockedSyncedOrder?.id || order.id, null, client);
            const updatedOrder = clearedBlockedOrder || normalizeOrder({
                ...(blockedSyncedOrder || order),
                refund_processing_at: null
            });
            await client.query('COMMIT');
            logOrderHotfixEvent(finalVerification.decision.providerOtpExists ? 'cancel_rejected_provider_otp' : 'cancel_rejected_provider_success', updatedOrder, {
                username: auditUsername,
                cancelTime,
                otpArrivalTime: finalVerification.decision.providerOtpExists ? cancelTime : null,
                providerStatus: finalVerification.decision.providerStatus || null,
                reason: finalVerification.decision.reason,
                refunded: false,
                otpExisted: finalVerification.decision.otpExists,
                providerSuccess: finalVerification.decision.providerSuccess
            });
            return res.status(400).send(getRefundBlockedMessage(finalVerification.decision, 'cancel'));
        }
        const refundAllowed = finalVerification.decision.refundAllowed;
        const walletRefundAmount = refundAllowed ? Number(order.price || 0) : 0;
        if (walletRefundAmount > 0) {
            await client.query('UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2', [
                walletRefundAmount,
                user.id
            ]);
        }
        const cancelledAt = cancelTime;
        const cancelledOrder = await updateOrder(order.id, {
            order_status: 'cancelled',
            status: 'cancelled',
            provider_last_status: finalVerification.decision.providerStatus || cancelResult.raw || order.provider_last_status || null,
            refund_processing_at: null
        }, {
            client,
            eventAt: cancelledAt,
            finalizedAt: cancelledAt,
            syncNumberHistory: false
        });
        const blockedReason = finalVerification.providerValidationFailed
            ? 'provider_final_verification_failed'
            : finalVerification.decision.reason;
        const updatedOrder = await syncOrderFinancialProtection(cancelledOrder, {
            websiteCharge: Number(order.price || 0),
            websiteRefund: walletRefundAmount,
            websiteProfit: roundMoney(Number(order.price || 0) - walletRefundAmount),
            realProviderCost: remainingProviderCostPkr,
            realProviderCostProviderCurrency: remainingProviderCostCurrency,
            providerCostVerified: providerCostVerified || Boolean(order.provider_cost_verified),
            providerCostSource: providerCostVerified ? 'cancel_balance_reconciliation' : order.provider_cost_source,
            providerBalanceAfter: providerBalanceAfterCancel.success
                ? providerBalanceAfterCancel.balance
                : order.provider_balance_after,
            providerBalanceCurrency: providerBalanceAfterCancel.currency || order.provider_balance_currency || PROVIDER_BALANCE_CURRENCY,
            providerStatus: finalVerification.decision.providerStatus || cancelResult.raw || order.provider_status || order.provider_last_status || null,
            providerFinalStatus: finalVerification.decision.providerStatus || cancelResult.raw || order.provider_final_status || null,
            providerStatusSyncedAt: cancelledAt,
            providerUsed: isProviderUsedOrder(order),
            refundedAt: walletRefundAmount > 0 ? cancelledAt : null,
            securityEventType: walletRefundAmount > 0 ? 'cancel_refund_completed' : 'cancel_refund_blocked_provider_verification',
            reason: walletRefundAmount > 0
                ? 'user_cancelled'
                : blockedReason,
            recordRiskEvent: walletRefundAmount <= 0,
            syncNumberHistory: true,
            syncUserRisk: walletRefundAmount <= 0,
            eventAt: cancelledAt,
            finalizedAt: cancelledAt
        }, {
            client
        });
        if (providerBalanceAfterCancel.success) {
            await insertProviderBalanceSnapshot({
                orderId: updatedOrder?.id || order.id,
                userId: user.id,
                activationId: order.activation_id,
                reason: walletRefundAmount > 0 ? 'order_cancel_after' : 'order_cancel_after_blocked',
                providerBalance: providerBalanceAfterCancel.balance,
                previousBalance: providerBalanceBaselineForCancel.success
                    ? providerBalanceBaselineForCancel.balance
                    : (order.provider_balance_after == null ? null : Number(order.provider_balance_after)),
                expectedSpendPkr: remainingProviderCostPkr,
                note: cancelResult.raw || (walletRefundAmount > 0 ? 'order_cancel' : 'cancel_refund_blocked')
            }, {
                client
            });
        }
        await client.query('COMMIT');
        logOrderHotfixEvent(walletRefundAmount > 0 ? 'cancel_refund_completed' : 'cancel_refund_blocked_provider_verification', updatedOrder, {
            username: auditUsername,
            cancelTime: cancelledAt,
            refundTime: walletRefundAmount > 0 ? cancelledAt : null,
            providerStatus: finalVerification.decision.providerStatus || cancelResult.raw || null,
            reason: walletRefundAmount > 0
                ? 'user_cancelled'
                : blockedReason,
            refunded: walletRefundAmount > 0,
            otpExisted: finalVerification.decision.otpExists,
            providerSuccess: finalVerification.decision.providerSuccess
        });
        res.status(walletRefundAmount > 0 ? 200 : 409).send(walletRefundAmount > 0
            ? 'Order cancelled & refunded'
            : 'Order cancelled, but refund is blocked until provider status verification completes.');
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).send(formatSafeError(err, 'Cancel failed'));
    } finally {
        client.release();
    }
});

app.post('/api/orders/:orderId/complete', ensureAuth, async (req, res) => {
    try {
        const order = await getOrderById(Number(req.params.orderId));
        if (!order) return res.status(404).send('Order not found');
        const user = await findUserById(req.session.userId);
        if (!user || order.user_id !== user.id) return res.status(403).send('Unauthorized');
        if (!hasStoredOtp(order)) return res.status(400).send('Cannot complete without OTP');
        try {
            const completeUrl = `${SMSBOWER_URL}?api_key=${SMSBOWER_API_KEY}&action=setStatus&id=${order.activation_id}&status=6`;
            await axios.get(completeUrl, { timeout: 15000 });
        } catch {}
        const completedAt = new Date().toISOString();
        await updateOrder(order.id, {
            order_status: 'completed',
            status: 'completed',
            completed_at: completedAt
        }, {
            eventAt: completedAt,
            finalizedAt: completedAt
        });
        res.send('OK');
    } catch (err) {
        res.status(500).send(formatSafeError(err, 'Complete failed'));
    }
});

app.post('/api/orders/:orderId/expire', ensureAuth, async (req, res) => {
    try {
        const order = await getOrderById(Number(req.params.orderId));
        if (!order) return res.status(404).send('Order not found');
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(401).send('User not found');
        if (order.user_id !== user.id && !isAdminUser(user)) {
            return res.status(403).send('Unauthorized');
        }
        const expireResult = await expireOrderAndRefund(order.id);
        res.json({
            expired: expireResult.expired,
            refunded: expireResult.refunded,
            message: expireResult.message || 'Order is still active.',
            order: expireResult.order
        });
    } catch (err) {
        res.status(500).send(formatSafeError(err, 'Expire failed'));
    }
});

app.get('/api/orders/:orderId/otp', ensureAuth, async (req, res) => {
    try {
        const order = await getOrderById(Number(req.params.orderId));
        if (!order) return res.status(404).send('Order not found');
        const user = await findUserById(req.session.userId);
        if (!user) return res.status(401).send('User not found');
        if (order.user_id !== user.id && !isAdminUser(user)) {
            return res.status(403).send('Unauthorized');
        }
        const shouldTrackClosedAccess = !isAdminUser(user) && order.user_id === user.id;
        if (normalizeOrderStatus(order) === 'expired') {
            if (shouldTrackClosedAccess) {
                await registerClosedOrderAccess(order, {
                    eventType: 'post_close_otp_poll',
                    reason: 'expired_order_access'
                });
            }
            return res.json({
                received: false,
                expired: true,
                refunded: getWebsiteRefundAmount(order) > 0,
                inactive: true,
                message: getWebsiteRefundAmount(order) > 0
                    ? EXPIRED_REFUND_MESSAGE
                    : 'Order expired, but refund is blocked until provider status verification completes.',
                status: order.status || order.order_status
            });
        }
        if (isFinalOrderState(order)) {
            if (shouldTrackClosedAccess) {
                await registerClosedOrderAccess(order, {
                    eventType: 'post_close_otp_poll',
                    reason: 'final_order_access'
                });
            }
            return res.json({ received: false, inactive: true, status: order.status || order.order_status });
        }
        if (hasStoredOtp(order)) {
            if (normalizeOrderStatus(order) !== 'active') {
                if (shouldTrackClosedAccess) {
                    await registerClosedOrderAccess(order, {
                        eventType: 'post_close_otp_poll',
                        reason: 'otp_present_on_closed_order_access'
                    });
                }
                logOrderHotfixEvent('otp_ignored_non_active_order', order, {
                    otpArrivalTime: new Date().toISOString(),
                    providerStatus: order.provider_last_status,
                    reason: 'existing_otp_on_non_active_order'
                });
                return res.json({ received: false, inactive: true, status: order.status || order.order_status });
            }
            return res.json({ received: true, code: order.otp_code });
        }
        if (normalizeOrderStatus(order) !== 'pending') {
            return res.json({ received: false, inactive: true, status: order.status || order.order_status });
        }
        if (!order.activation_id) {
            return res.json({ received: false, error: 'No activation ID' });
        }
        const now = new Date();
        const expiry = order.expires_at ? new Date(order.expires_at) : null;
        if (expiry && now >= expiry && !order.sms_received && !hasStoredOtp(order) && getRawOrderStatus(order) === 'pending') {
            const expireResult = await expireOrderAndRefund(order.id);
            return res.json({
                received: false,
                expired: expireResult.expired,
                refunded: expireResult.refunded,
                inactive: !expireResult.expired && isFinalOrderState(expireResult.order),
                message: expireResult.message || EXPIRED_REFUND_MESSAGE
            });
        }
        const providerSignal = analyzeProviderSmsResult(await checkSmsStatus(order.activation_id));
        if (providerSignal.providerValidationFailed) {
            return res.json({
                received: false,
                error: true,
                validationLocked: true,
                message: 'OTP status is being verified. Please try again shortly.'
            });
        }
        if (providerSignal.providerPending) {
            return res.json({ received: false, waiting: true });
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const lockedOrderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [order.id]);
            const lockedOrder = normalizeOrder(lockedOrderRes.rows[0]);
            if (!lockedOrder) {
                await client.query('ROLLBACK');
                return res.status(404).send('Order not found');
            }
            if (isFinalOrderState(lockedOrder)) {
                if (shouldTrackClosedAccess) {
                    await registerClosedOrderAccess(lockedOrder, {
                        eventType: 'post_close_otp_poll',
                        reason: 'final_order_access_locked',
                        eventAt: new Date().toISOString()
                    }, {
                        client
                    });
                }
                await client.query('COMMIT');
                logOrderHotfixEvent('otp_ignored_after_final_state', lockedOrder, {
                    otpArrivalTime: new Date().toISOString(),
                    providerStatus: providerSignal.rawStatus || null,
                    reason: 'final_state'
                });
                return res.json({ received: false, inactive: true, status: lockedOrder.status || lockedOrder.order_status });
            }
            if (hasStoredOtp(lockedOrder)) {
                await client.query('COMMIT');
                if (normalizeOrderStatus(lockedOrder) !== 'active') {
                    if (shouldTrackClosedAccess) {
                        await registerClosedOrderAccess(lockedOrder, {
                            eventType: 'post_close_otp_poll',
                            reason: 'otp_present_on_closed_order_locked_access',
                            eventAt: new Date().toISOString()
                        }, {
                            client
                        });
                    }
                    logOrderHotfixEvent('otp_ignored_after_state_change', lockedOrder, {
                        otpArrivalTime: new Date().toISOString(),
                        providerStatus: providerSignal.rawStatus || null,
                        reason: 'non_active_state'
                    });
                    return res.json({ received: false, inactive: true, status: lockedOrder.status || lockedOrder.order_status });
                }
                return res.json({ received: true, code: lockedOrder.otp_code });
            }
            const receivedAt = new Date().toISOString();
            const updatedOrder = await syncOrderWithProviderSignal(lockedOrder, providerSignal, {
                client,
                eventAt: receivedAt,
                otpReceivedAt: receivedAt
            });
            await client.query('COMMIT');
            if (providerSignal.hasCode) {
                if (normalizeOrderStatus(updatedOrder) !== 'active') {
                    logOrderHotfixEvent('otp_ignored_after_provider_store', updatedOrder, {
                        otpArrivalTime: receivedAt,
                        providerStatus: providerSignal.rawStatus || null,
                        reason: 'stored_on_non_active_order'
                    });
                    return res.json({ received: false, inactive: true, status: updatedOrder.status || updatedOrder.order_status });
                }
                logOrderHotfixEvent('otp_stored', updatedOrder, {
                    otpArrivalTime: receivedAt,
                    providerStatus: providerSignal.rawStatus || null,
                    reason: 'provider_code_received'
                });
                return res.json({ received: true, code: updatedOrder.otp_code || providerSignal.code });
            }
            logOrderHotfixEvent('sms_lock_persisted', updatedOrder, {
                otpArrivalTime: receivedAt,
                providerStatus: providerSignal.rawStatus || null,
                reason: 'provider_status_changed'
            });
            return res.json({
                received: false,
                waiting: true,
                smsReceived: true,
                providerStatus: providerSignal.rawStatus || null
            });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch {
        res.status(500).json({ received: false, error: true });
    }
});

app.get('/api/admin/orders', ensureAdmin, async (req, res) => {
    try {
        const allOrders = await getAllOrders();
        res.json(allOrders);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/admin/transactions', ensureAdmin, async (req, res) => {
    try {
        const pending = await getPendingTransactions();
        res.json(pending);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/admin/transactions/history', ensureAdmin, async (req, res) => {
    try {
        const history = await getTransactionHistory();
        res.json(history);
    } catch {
        res.status(500).send('Server error');
    }
});

app.post('/api/admin/transactions/:txId/approve', ensureAdmin, async (req, res) => {
    try {
        await approveTransaction(Number(req.params.txId));
        res.send('OK');
    } catch (err) {
        res.status(404).send(formatSafeError(err, 'Transaction not found'));
    }
});

app.post('/api/admin/transactions/:txId/cancel', ensureAdmin, async (req, res) => {
    try {
        await cancelTransaction(Number(req.params.txId));
        res.send('OK');
    } catch (err) {
        res.status(404).send(formatSafeError(err, 'Transaction not found'));
    }
});

app.post('/api/request-payment', ensureAuth, paymentProofUpload, async (req, res) => {
    await handlePaymentRequestSubmission(req, res);
});

app.post('/api/add-funds', ensureAuth, paymentProofUpload, async (req, res) => {
    await handlePaymentRequestSubmission(req, res);
});

app.get('/api/admin/payment-requests', ensureAdmin, async (req, res) => {
    try {
        const requests = await getAllPaymentRequests();
        res.json(requests);
    } catch {
        res.status(500).send('Server error');
    }
});

app.get('/api/my-payment-history', ensureAuth, async (req, res) => {
    try {
        const requests = await getPaymentHistoryByUser(req.session.userId);
        res.json(requests);
    } catch {
        res.status(500).send('Server error');
    }
});

app.post('/api/admin/payment-requests/:id/approve', ensureAdmin, async (req, res) => {
    const client = await pool.connect();
    let screenshotToDelete = null;
    try {
        await client.query('BEGIN');
        const requestRes = await client.query('SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE', [Number(req.params.id)]);
        const paymentRequest = requestRes.rows[0];
        if (!paymentRequest) throw new Error('Payment request not found');
        if (paymentRequest.status !== 'pending') throw new Error('Only pending payment requests can be approved');
        screenshotToDelete = paymentRequest.screenshot || null;
        const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [paymentRequest.user_id]);
        const user = userRes.rows[0];
        if (!user) throw new Error('User not found');
        const creditedAmount = getPaymentRequestCreditAmount(paymentRequest);
        await client.query('UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE id = $2', [creditedAmount, paymentRequest.user_id]);
        await client.query(
            `
                INSERT INTO transactions (
                    user_id,
                    user_email,
                    amount,
                    type,
                    status,
                    description,
                    transaction_id,
                    screenshot,
                    request_ip,
                    device_fingerprint,
                    browser_fingerprint,
                    proof_hash
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `,
            [
                paymentRequest.user_id,
                paymentRequest.user_email,
                creditedAmount,
                'deposit',
                'approved',
                `Approved ${normalizePaymentMethod(paymentRequest.payment_method)} payment request #${paymentRequest.id} (${getPaymentRequestAmountSummary(paymentRequest)})`,
                paymentRequest.transaction_id,
                null,
                paymentRequest.request_ip || null,
                paymentRequest.device_fingerprint || null,
                paymentRequest.browser_fingerprint || null,
                paymentRequest.proof_hash || null
            ]
        );
        await applyReferralBonusForApprovedDeposit(client, paymentRequest);
        await client.query('UPDATE payment_requests SET status = $1, screenshot = NULL, credit_amount = $2 WHERE id = $3', ['approved', creditedAmount, paymentRequest.id]);
        await client.query('COMMIT');
        await removeUploadedFile(screenshotToDelete);
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).send(formatSafeError(err, 'Payment request approval failed'));
    } finally {
        client.release();
    }
});

app.post('/api/admin/payment-requests/:id/reject', ensureAdmin, async (req, res) => {
    const client = await pool.connect();
    let screenshotToDelete = null;
    try {
        await client.query('BEGIN');
        const requestRes = await client.query('SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE', [Number(req.params.id)]);
        const request = requestRes.rows[0];
        if (!request) {
            await client.query('ROLLBACK');
            return res.status(404).send('Payment request not found');
        }
        if (request.status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(400).send('Only pending payment requests can be cancelled');
        }
        screenshotToDelete = request.screenshot || null;
        await client.query('UPDATE payment_requests SET status = $1, screenshot = NULL WHERE id = $2', ['cancelled', Number(req.params.id)]);
        await client.query('COMMIT');
        await removeUploadedFile(screenshotToDelete);
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).send(formatSafeError(err, 'Payment request cancellation failed'));
    } finally {
        client.release();
    }
});

app.use('/uploads', express.static(UPLOAD_DIR));

function startServer() {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on http://0.0.0.0:${PORT}`);
    });
}

initDB()
    .then(() => {
        startServer();
        startProviderReconciliationLoop();
    })
    .catch((err) => {
        console.error('Database initialization failed:', err);
        startServer();
    });
