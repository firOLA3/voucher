const formatDuration = (seconds) => {
  if (seconds == null) return "In progress";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
};

const formatDate = (value) => new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
}).format(new Date(value));

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.message || "Something went wrong. Please try again.");
    error.status = response.status;
    error.code = body.error;
    throw error;
  }
  return body;
}

function initClaimPage() {
  const form = document.querySelector("#claim-form");
  if (!form) return;
  const input = document.querySelector("#voucher-code");
  const codeError = document.querySelector("#form-error");
  const codeButton = document.querySelector("#submit-voucher");
  const codeStep = document.querySelector("#code-step");
  const questionStep = document.querySelector("#question-step");
  const answerInput = document.querySelector("#voucher-answer");
  const answerError = document.querySelector("#answer-error");
  const answerButton = document.querySelector("#submit-answer");
  const changeCodeButton = document.querySelector("#change-code");
  const codeHint = document.querySelector("#code-hint");
  const success = document.querySelector("#success-panel");
  const statusLabel = document.querySelector("#availability-label");
  const SOLD_OUT_MESSAGE = "this voucher is no longer available";
  let step = "code";
  let claimsOpen = false;
  let campaignSoldOut = false;
  let submitting = false;
  let verifiedCode = "";

  const showError = (element, inputElement, message) => {
    element.textContent = message;
    element.hidden = false;
    inputElement.setAttribute("aria-invalid", "true");
  };
  const clearError = (element, inputElement) => {
    element.textContent = "";
    element.hidden = true;
    inputElement.removeAttribute("aria-invalid");
  };
  const resetToCodeStep = ({ clearCode = false } = {}) => {
    step = "code";
    verifiedCode = "";
    if (clearCode) input.value = "";
    answerInput.value = "";
    codeStep.hidden = false;
    questionStep.hidden = true;
    clearError(codeError, input);
    clearError(answerError, answerInput);
    input.disabled = !claimsOpen;
    answerInput.disabled = !claimsOpen;
    codeButton.disabled = submitting || !claimsOpen;
    answerButton.disabled = true;
    if (campaignSoldOut) {
      showError(codeError, input, SOLD_OUT_MESSAGE);
    } else if (claimsOpen) {
      input.focus();
    }
  };
  const refreshAvailability = async () => {
    try {
      const campaign = await request("/api/v1/config");
      const soldOut = !campaign.available;
      campaignSoldOut = soldOut;
      claimsOpen = campaign.available && campaign.challengeConfigured;
      statusLabel.textContent = soldOut
        ? "All convocation vouchers have been claimed"
        : campaign.challengeConfigured
          ? "Convocation vouchers are still available"
          : "Voucher claims will open soon";
      input.placeholder = soldOut
        ? "Claims closed"
        : campaign.challengeConfigured
          ? "Enter your voucher code"
          : "Claims opening soon";
      if (codeHint) {
        codeHint.textContent = soldOut
          ? "All convocation vouchers have been claimed."
          : campaign.challengeConfigured
            ? "Enter the exact code provided by the event team."
            : "Waiting for the event team to finish setting up the verification question and answer.";
      }
      document.querySelector("#create-another").hidden = !claimsOpen;
      input.disabled = !claimsOpen;
      answerInput.disabled = !claimsOpen;
      codeButton.disabled = submitting || !claimsOpen || step !== "code";
      answerButton.disabled = submitting || !claimsOpen || step !== "answer";
      if (soldOut) {
        const activeInput = step === "answer" ? answerInput : input;
        const activeError = step === "answer" ? answerError : codeError;
        showError(activeError, activeInput, SOLD_OUT_MESSAGE);
      } else {
        if (codeError.textContent === SOLD_OUT_MESSAGE) clearError(codeError, input);
        if (answerError.textContent === SOLD_OUT_MESSAGE) clearError(answerError, answerInput);
      }
    } catch {
      statusLabel.textContent = "Voucher availability will update shortly";
    }
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (step === "code") {
      clearError(codeError, input);
      const code = input.value;
      if (!code || code.length > 256) {
        showError(codeError, input, code ? "Voucher codes must be 256 characters or fewer." : "Enter the voucher code.");
        input.focus();
        return;
      }
      submitting = true;
      codeButton.disabled = true;
      codeButton.querySelector("span").textContent = "Checking…";
      try {
        const result = await request("/api/v1/voucher-question", {
          method: "POST",
          body: JSON.stringify({ code }),
        });
        verifiedCode = code;
        document.querySelector("#voucher-question").textContent = result.question;
        step = "answer";
        codeStep.hidden = true;
        questionStep.hidden = false;
        answerInput.disabled = false;
        answerButton.disabled = false;
        answerInput.focus();
      } catch (error) {
        showError(codeError, input, error.message);
        await refreshAvailability();
      } finally {
        submitting = false;
        codeButton.querySelector("span").textContent = "Continue";
        codeButton.disabled = !claimsOpen || step !== "code";
      }
      return;
    }

    clearError(answerError, answerInput);
    if (!answerInput.value.trim()) {
      showError(answerError, answerInput, "Enter your answer.");
      answerInput.focus();
      return;
    }
    submitting = true;
    answerButton.disabled = true;
    answerButton.querySelector("span").textContent = "Checking…";
    try {
      const result = await request("/api/v1/vouchers", {
        method: "POST",
        body: JSON.stringify({ code: verifiedCode, answer: answerInput.value }),
      });
      document.querySelector("#success-code").textContent = result.voucher.code;
      success.hidden = false;
      form.hidden = true;
      await refreshAvailability();
    } catch (error) {
      if (error.code === "invalid_code") {
        resetToCodeStep();
        showError(codeError, input, error.message);
      } else {
        showError(answerError, answerInput, error.message);
      }
      await refreshAvailability();
    } finally {
      submitting = false;
      answerButton.querySelector("span").textContent = "Claim my voucher";
      answerButton.disabled = !claimsOpen || step !== "answer";
    }
  });

  input.addEventListener("input", () => clearError(codeError, input));
  answerInput.addEventListener("input", () => clearError(answerError, answerInput));
  changeCodeButton?.addEventListener("click", () => resetToCodeStep());
  document.querySelector("#create-another").addEventListener("click", () => {
    success.hidden = true;
    form.hidden = false;
    resetToCodeStep({ clearCode: true });
  });
  document.querySelector("#current-year").textContent = new Date().getFullYear();
  refreshAvailability();
  window.setInterval(refreshAvailability, 5000);
}

function initAdminPage() {
  const login = document.querySelector("#admin-login");
  if (!login) return;
  const dashboard = document.querySelector("#admin-dashboard");
  const loginForm = document.querySelector("#login-form");
  const loginError = document.querySelector("#login-error");
  const limitForm = document.querySelector("#limit-form");
  const feedback = document.querySelector("#limit-feedback");
  const codeFeedback = document.querySelector("#voucher-code-feedback");
  const challengeFeedback = document.querySelector("#voucher-challenge-feedback");
  const dashboardError = document.querySelector("#dashboard-error");
  const voucherCodeInput = document.querySelector("#voucher-code-setting");
  const voucherLimitInput = document.querySelector("#voucher-limit");
  const questionInput = document.querySelector("#voucher-question-setting");
  const answerInput = document.querySelector("#voucher-answer-setting");
  const toggleAnswerButton = document.querySelector("#toggle-answer-visibility");
  let refreshTimer;
  let latestChallengeConfigured = false;

  const setAnswerVisible = (visible) => {
    answerInput.type = visible ? "text" : "password";
    if (!toggleAnswerButton) return;
    toggleAnswerButton.textContent = visible ? "Hide" : "Show";
    toggleAnswerButton.setAttribute("aria-pressed", String(visible));
  };

  toggleAnswerButton?.addEventListener("click", () => {
    setAnswerVisible(answerInput.type === "password");
  });

  const renderDashboard = (data) => {
    latestChallengeConfigured = Boolean(data.challengeConfigured);
    document.querySelector("#metric-issued").textContent = data.issued.toLocaleString();
    document.querySelector("#metric-progress").textContent = `${data.issued.toLocaleString()} of ${data.limit.toLocaleString()} convocation vouchers claimed`;
    document.querySelector("#metric-remaining").textContent = data.remaining.toLocaleString();
    document.querySelector("#metric-time").textContent = data.issued === 0
      ? "Not started"
      : data.available
        ? formatDuration(data.elapsedSeconds)
        : formatDuration(data.timeToFillSeconds);
    document.querySelector("#metric-time-caption").textContent = data.issued === 0
      ? "Starts with the first voucher claim"
      : data.available
        ? "Elapsed since the first voucher was claimed"
        : "Time from campaign start to sell-out";
    document.querySelector("#metric-rate").textContent = `${data.averagePerHour.toLocaleString()} / hr`;
    if (document.activeElement !== voucherLimitInput) {
      voucherLimitInput.value = data.limit;
    }
    voucherLimitInput.max = "1000000";
    if (document.activeElement !== voucherCodeInput) {
      voucherCodeInput.value = data.voucherCode || "";
    }
    if (document.activeElement !== questionInput) {
      questionInput.value = data.voucherQuestion || "";
    }
    answerInput.placeholder = data.questionConfigured
      ? "Leave blank to keep current answer, or enter a new one"
      : "Enter the answer";
    const codeStatus = document.querySelector("#voucher-code-status");
    codeStatus.textContent = data.voucherCode ? "Ready" : "Not set";
    codeStatus.classList.toggle("sold-out", !data.voucherCode);
    const challengeStatus = document.querySelector("#voucher-challenge-status");
    challengeStatus.textContent = data.questionConfigured ? "Ready" : "Not set";
    challengeStatus.classList.toggle("sold-out", !data.questionConfigured);
    document.querySelector("#admin-progress").style.width = `${data.limit ? (data.issued / data.limit) * 100 : 0}%`;
    const status = document.querySelector("#campaign-status");
    if (!data.available) {
      status.textContent = "All claimed";
      status.classList.add("sold-out");
    } else if (!data.challengeConfigured) {
      status.textContent = "Setup needed";
      status.classList.add("sold-out");
    } else {
      status.textContent = "Live";
      status.classList.remove("sold-out");
    }
    const body = document.querySelector("#recent-vouchers");
    body.replaceChildren(...data.recent.map((voucher) => {
      const row = document.createElement("tr");
      const code = document.createElement("td");
      const created = document.createElement("td");
      const state = document.createElement("td");
      code.textContent = voucher.code;
      created.textContent = formatDate(voucher.createdAt);
      state.textContent = "Created";
      row.append(code, created, state);
      return row;
    }));
    document.querySelector("#empty-vouchers").hidden = data.recent.length > 0;
    document.querySelector("#last-updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
  };

  const refreshDashboard = async () => {
    try {
      renderDashboard(await request("/api/v1/admin/dashboard"));
      dashboardError.hidden = true;
      return true;
    } catch (error) {
      if (error.status === 401) {
        window.clearInterval(refreshTimer);
        dashboard.hidden = true;
        login.hidden = false;
        return false;
      }
      dashboardError.textContent = error.message;
      dashboardError.hidden = false;
      return false;
    }
  };

  const showDashboard = async () => {
    const loaded = await refreshDashboard();
    if (!loaded) return;
    login.hidden = true;
    dashboard.hidden = false;
    window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(refreshDashboard, 5000);
  };

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginError.hidden = true;
    const button = document.querySelector("#login-button");
    button.disabled = true;
    try {
      await request("/api/v1/admin/session", {
        method: "POST",
        body: JSON.stringify({ password: document.querySelector("#admin-password").value }),
      });
      document.querySelector("#admin-password").value = "";
      await showDashboard();
    } catch (error) {
      loginError.textContent = error.message;
      loginError.hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  limitForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    feedback.classList.remove("is-error");
    feedback.textContent = "Saving…";
    const button = document.querySelector("#save-limit");
    button.disabled = true;
    try {
      const data = await request("/api/v1/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ limit: Number(document.querySelector("#voucher-limit").value) }),
      });
      renderDashboard({ ...await request("/api/v1/admin/dashboard"), ...data });
      feedback.textContent = "Campaign limit updated.";
    } catch (error) {
      feedback.textContent = error.message;
      feedback.classList.add("is-error");
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#voucher-code-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.querySelector("#save-voucher-code");
    codeFeedback.classList.remove("is-error");
    codeFeedback.textContent = "Saving…";
    button.disabled = true;
    try {
      const result = await request("/api/v1/admin/voucher-code", {
        method: "PUT",
        body: JSON.stringify({ code: voucherCodeInput.value }),
      });
      voucherCodeInput.value = result.voucherCode;
      await refreshDashboard();
      codeFeedback.textContent = latestChallengeConfigured
        ? "Voucher code saved. Visitors can now enter it to claim."
        : "Voucher code saved. Add a question and answer below to open claims.";
    } catch (error) {
      codeFeedback.textContent = error.message;
      codeFeedback.classList.add("is-error");
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#voucher-challenge-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.querySelector("#save-voucher-challenge");
    const hadAnswerInput = Boolean(answerInput.value);
    challengeFeedback.classList.remove("is-error");
    challengeFeedback.textContent = "Saving…";
    button.disabled = true;
    try {
      const result = await request("/api/v1/admin/voucher-challenge", {
        method: "PUT",
        body: JSON.stringify({
          question: questionInput.value,
          answer: answerInput.value,
        }),
      });
      questionInput.value = result.voucherQuestion;
      answerInput.value = "";
      setAnswerVisible(false);
      await refreshDashboard();
      challengeFeedback.textContent = !latestChallengeConfigured
        ? "Question and answer saved. Set a shared voucher code above to open claims."
        : hadAnswerInput
          ? "Question and answer saved. Visitors must answer correctly to claim."
          : "Question updated. Your existing answer was kept.";
    } catch (error) {
      challengeFeedback.textContent = error.message;
      challengeFeedback.classList.add("is-error");
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#logout-button").addEventListener("click", async () => {
    await request("/api/v1/admin/session", { method: "DELETE" });
    window.clearInterval(refreshTimer);
    dashboardError.hidden = true;
    codeFeedback.textContent = "";
    codeFeedback.classList.remove("is-error");
    challengeFeedback.textContent = "";
    challengeFeedback.classList.remove("is-error");
    feedback.textContent = "The limit cannot be lower than vouchers already created.";
    feedback.classList.remove("is-error");
    setAnswerVisible(false);
    dashboard.hidden = true;
    login.hidden = false;
  });

  showDashboard();
}

if (document.body.dataset.page === "claim") initClaimPage();
if (document.body.dataset.page === "admin") initAdminPage();
