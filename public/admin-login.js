const loginState = {
    submitting: false
};

function qs(id) {
    return document.getElementById(id);
}

function showLoginError(message) {
    const errorBox = qs('admin-login-error');
    if (!errorBox) return;
    errorBox.textContent = message || 'Login failed';
    errorBox.classList.add('show');
}

function clearLoginError() {
    const errorBox = qs('admin-login-error');
    if (!errorBox) return;
    errorBox.textContent = '';
    errorBox.classList.remove('show');
}

function setLoginLoading(loading) {
    const button = qs('admin-login-submit');
    if (!button) return;
    button.disabled = loading;
    button.innerHTML = loading
        ? '<span><i class="fa-solid fa-spinner fa-spin"></i> Signing in...</span>'
        : 'Login to Admin Dashboard';
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

async function logoutIfNeeded() {
    try {
        await fetch('/api/logout', { credentials: 'include' });
    } catch {
    }
}

async function checkExistingAdminSession() {
    try {
        const user = await fetchJSON('/api/me');
        if (user?.isAdmin) {
            window.location.replace('/admin');
        }
    } catch {
    }
}

async function handleAdminLogin(event) {
    event.preventDefault();
    if (loginState.submitting) return;
    clearLoginError();
    const email = String(qs('admin-login-email')?.value || '').trim();
    const password = String(qs('admin-login-password')?.value || '');
    if (!email || !password) {
        showLoginError('Email and password are required');
        return;
    }
    loginState.submitting = true;
    setLoginLoading(true);
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email, password })
        });
        if (!response.ok) throw new Error(await response.text());
        const user = await fetchJSON('/api/me');
        if (!user?.isAdmin) {
            await logoutIfNeeded();
            showLoginError('Admin access is required');
            return;
        }
        window.location.replace('/admin');
    } catch (err) {
        showLoginError(err.message || 'Admin login failed');
    } finally {
        loginState.submitting = false;
        setLoginLoading(false);
    }
}

function initAdminLogin() {
    qs('admin-login-form')?.addEventListener('submit', handleAdminLogin);
    void checkExistingAdminSession();
}

document.addEventListener('DOMContentLoaded', initAdminLogin);
