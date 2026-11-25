const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
const TOKEN_STORAGE_KEY = "voucher_admin_token";

function readStoredToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function writeStoredToken(token) {
  try {
    if (token) {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage unavailability in restricted contexts.
  }
}

export async function apiRequest(path, options = {}) {
  const token = readStoredToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    ...options,
    headers,
  });

  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      writeStoredToken("");
    }
    const error = new Error(body.message || "Something went wrong. Please try again.");
    error.status = response.status;
    error.code = body.error;
    throw error;
  }
  return body;
}

export function fetchCampaignConfig() {
  return apiRequest("/api/v1/config");
}

export function verifyVoucherCode(code) {
  return apiRequest("/api/v1/voucher-question", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export function claimVoucher(code, answer) {
  return apiRequest("/api/v1/vouchers", {
    method: "POST",
    body: JSON.stringify({ code, answer }),
  });
}

export async function loginAdmin(password) {
  const result = await apiRequest("/api/v1/admin/session", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  if (result.token) {
    writeStoredToken(result.token);
  }
  return result;
}

export async function logoutAdmin() {
  try {
    await apiRequest("/api/v1/admin/session", { method: "DELETE" });
  } finally {
    writeStoredToken("");
  }
}

export function fetchAdminDashboard() {
  return apiRequest("/api/v1/admin/dashboard");
}

export function updateCampaignLimit(limit) {
  return apiRequest("/api/v1/admin/settings", {
    method: "PUT",
    body: JSON.stringify({ limit }),
  });
}

export function updateVoucherCodeSetting(code) {
  return apiRequest("/api/v1/admin/voucher-code", {
    method: "PUT",
    body: JSON.stringify({ code }),
  });
}

export function updateVoucherChallengeSetting(question, answer) {
  return apiRequest("/api/v1/admin/voucher-challenge", {
    method: "PUT",
    body: JSON.stringify({ question, answer }),
  });
}

