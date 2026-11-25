import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAdminDashboard,
  loginAdmin,
  logoutAdmin,
  updateCampaignLimit,
  updateVoucherChallengeSetting,
  updateVoucherCodeSetting,
} from "../api/client.js";
import { Layout } from "../components/Layout.jsx";
import { formatDate, formatDuration } from "../utils/format.js";

const DEFAULT_LIMIT_FEEDBACK = "The limit cannot be lower than vouchers already created.";

export function AdminPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const [dashboard, setDashboard] = useState(null);
  const [dashboardError, setDashboardError] = useState("");
  const [lastUpdated, setLastUpdated] = useState("Updating live");

  const [limitValue, setLimitValue] = useState("");
  const [limitFeedback, setLimitFeedback] = useState(DEFAULT_LIMIT_FEEDBACK);
  const [limitError, setLimitError] = useState(false);
  const [savingLimit, setSavingLimit] = useState(false);

  const [voucherCodeValue, setVoucherCodeValue] = useState("");
  const [codeFeedback, setCodeFeedback] = useState("");
  const [codeError, setCodeError] = useState(false);
  const [savingCode, setSavingCode] = useState(false);

  const [questionValue, setQuestionValue] = useState("");
  const [answerValue, setAnswerValue] = useState("");
  const [answerVisible, setAnswerVisible] = useState(false);
  const [challengeFeedback, setChallengeFeedback] = useState("");
  const [challengeError, setChallengeError] = useState(false);
  const [savingChallenge, setSavingChallenge] = useState(false);

  const limitInputRef = useRef(null);
  const codeInputRef = useRef(null);
  const questionInputRef = useRef(null);

  useEffect(() => {
    document.title = "Convocation vouchers · Event team";
  }, []);

  const syncDashboardState = useCallback((data) => {
    setDashboard(data);
    if (document.activeElement !== limitInputRef.current) {
      setLimitValue(String(data.limit));
    }
    if (document.activeElement !== codeInputRef.current) {
      setVoucherCodeValue(data.voucherCode || "");
    }
    if (document.activeElement !== questionInputRef.current) {
      setQuestionValue(data.voucherQuestion || "");
    }
    setLastUpdated(
      `Updated ${new Date().toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      })}`,
    );
  }, []);

  const refreshDashboard = useCallback(async () => {
    try {
      const data = await fetchAdminDashboard();
      syncDashboardState(data);
      setDashboardError("");
      setAuthenticated(true);
      return true;
    } catch (error) {
      if (error.status === 401) {
        setAuthenticated(false);
        return false;
      }
      setDashboardError(error.message);
      return false;
    } finally {
      setCheckingSession(false);
    }
  }, [syncDashboardState]);

  useEffect(() => {
    refreshDashboard();
  }, [refreshDashboard]);

  useEffect(() => {
    if (!authenticated) return undefined;
    const timer = window.setInterval(refreshDashboard, 5000);
    return () => window.clearInterval(timer);
  }, [authenticated, refreshDashboard]);

  const handleLogin = async (event) => {
    event.preventDefault();
    setLoginError("");
    setLoggingIn(true);
    try {
      await loginAdmin(password);
      setPassword("");
      await refreshDashboard();
    } catch (error) {
      setLoginError(error.message);
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await logoutAdmin();
    setAuthenticated(false);
    setDashboard(null);
    setDashboardError("");
    setCodeFeedback("");
    setCodeError(false);
    setChallengeFeedback("");
    setChallengeError(false);
    setLimitFeedback(DEFAULT_LIMIT_FEEDBACK);
    setLimitError(false);
    setAnswerVisible(false);
  };

  const handleSaveLimit = async (event) => {
    event.preventDefault();
    setLimitError(false);
    setLimitFeedback("Saving…");
    setSavingLimit(true);
    try {
      const updatedStatus = await updateCampaignLimit(Number(limitValue));
      const latestDashboard = await fetchAdminDashboard();
      syncDashboardState({ ...latestDashboard, ...updatedStatus });
      setLimitFeedback("Campaign limit updated.");
    } catch (error) {
      setLimitFeedback(error.message);
      setLimitError(true);
    } finally {
      setSavingLimit(false);
    }
  };

  const handleSaveCode = async (event) => {
    event.preventDefault();
    setCodeError(false);
    setCodeFeedback("Saving…");
    setSavingCode(true);
    try {
      const result = await updateVoucherCodeSetting(voucherCodeValue);
      setVoucherCodeValue(result.voucherCode);
      const latestDashboard = await fetchAdminDashboard();
      syncDashboardState(latestDashboard);
      setCodeFeedback(
        latestDashboard.challengeConfigured
          ? "Voucher code saved. Visitors can now enter it to claim."
          : "Voucher code saved. Add a question and answer below to open claims.",
      );
    } catch (error) {
      setCodeFeedback(error.message);
      setCodeError(true);
    } finally {
      setSavingCode(false);
    }
  };

  const handleSaveChallenge = async (event) => {
    event.preventDefault();
    const hadAnswerInput = Boolean(answerValue);
    setChallengeError(false);
    setChallengeFeedback("Saving…");
    setSavingChallenge(true);
    try {
      const result = await updateVoucherChallengeSetting(questionValue, answerValue);
      setQuestionValue(result.voucherQuestion);
      setAnswerValue("");
      setAnswerVisible(false);
      const latestDashboard = await fetchAdminDashboard();
      syncDashboardState(latestDashboard);
      setChallengeFeedback(
        !latestDashboard.challengeConfigured
          ? "Question and answer saved. Set a shared voucher code above to open claims."
          : hadAnswerInput
            ? "Question and answer saved. Visitors must answer correctly to claim."
            : "Question updated. Your existing answer was kept.",
      );
    } catch (error) {
      setChallengeFeedback(error.message);
      setChallengeError(true);
    } finally {
      setSavingChallenge(false);
    }
  };

  const progressPct = dashboard?.limit ? (dashboard.issued / dashboard.limit) * 100 : 0;

  return (
    <Layout
      headerLinkTo="/"
      headerLinkContent="← Back to convocation vouchers"
      footerLeft="Class of 2026 · Event team"
      footerRight="Updates automatically every 5 seconds"
    >
      <main className="admin-layout">
        {!authenticated ? (
          <section id="admin-login" className="admin-login-card" hidden={checkingSession}>
            <div className="eyebrow">
              <span className="live-dot" /> EVENT TEAM ACCESS
            </div>
            <h1>
              Welcome
              <br />
              <span>behind the scenes.</span>
            </h1>
            <p className="intro">
              Sign in to manage the Class of 2026 convocation voucher campaign.
            </p>
            <form id="login-form" onSubmit={handleLogin} noValidate>
              <label htmlFor="admin-password">Admin password</label>
              <input
                id="admin-password"
                className="admin-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <p id="login-error" className="form-error" role="alert" hidden={!loginError}>
                {loginError}
              </p>
              <button
                id="login-button"
                className="button button-primary"
                type="submit"
                disabled={loggingIn}
              >
                <span>{loggingIn ? "Signing in…" : "Sign in"}</span>
                <span className="button-arrow" aria-hidden="true">
                  →
                </span>
              </button>
            </form>
            <p className="field-hint login-hint">
              Your admin password is printed when you start the server, unless configured in the
              environment.
            </p>
          </section>
        ) : (
          <section id="admin-dashboard" className="dashboard">
            <div className="dashboard-heading">
              <div>
                <div className="eyebrow">
                  <span className="live-dot" /> CONVOCATION CAMPAIGN
                </div>
                <h1>
                  Your celebration,
                  <br />
                  <span>in numbers.</span>
                </h1>
              </div>
              <button
                id="logout-button"
                className="button button-quiet"
                type="button"
                onClick={handleLogout}
              >
                Sign out
              </button>
            </div>

            <div className="metric-grid">
              <article className="metric-card metric-primary">
                <span className="metric-label">Vouchers created</span>
                <strong id="metric-issued" className="metric-value">
                  {dashboard ? dashboard.issued.toLocaleString() : "—"}
                </strong>
                <span id="metric-progress" className="metric-footnote">
                  {dashboard
                    ? `${dashboard.issued.toLocaleString()} of ${dashboard.limit.toLocaleString()} convocation vouchers claimed`
                    : "Loading campaign…"}
                </span>
              </article>

              <article className="metric-card">
                <span className="metric-label">Still available</span>
                <strong id="metric-remaining" className="metric-value">
                  {dashboard ? dashboard.remaining.toLocaleString() : "—"}
                </strong>
                <span className="metric-footnote">From your total campaign limit</span>
              </article>

              <article className="metric-card">
                <span className="metric-label">Campaign timing</span>
                <strong id="metric-time" className="metric-value metric-time">
                  {!dashboard
                    ? "—"
                    : dashboard.issued === 0
                      ? "Not started"
                      : dashboard.available
                        ? formatDuration(dashboard.elapsedSeconds)
                        : formatDuration(dashboard.timeToFillSeconds)}
                </strong>
                <span id="metric-time-caption" className="metric-footnote">
                  {!dashboard
                    ? "Time to fill the voucher pool"
                    : dashboard.issued === 0
                      ? "Starts with the first voucher claim"
                      : dashboard.available
                        ? "Elapsed since the first voucher was claimed"
                        : "Time from campaign start to sell-out"}
                </span>
              </article>

              <article className="metric-card">
                <span className="metric-label">Average pace</span>
                <strong id="metric-rate" className="metric-value">
                  {dashboard ? `${dashboard.averagePerHour.toLocaleString()} / hr` : "—"}
                </strong>
                <span className="metric-footnote">
                  Vouchers per hour between first and latest
                </span>
              </article>
            </div>

            <section className="admin-panel limit-panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">CAMPAIGN SETTINGS</p>
                  <h2>Set the voucher limit</h2>
                </div>
                <span
                  id="campaign-status"
                  className={`status-pill${
                    dashboard && (!dashboard.available || !dashboard.challengeConfigured)
                      ? " sold-out"
                      : ""
                  }`}
                >
                  {!dashboard
                    ? "Live"
                    : !dashboard.available
                      ? "All claimed"
                      : !dashboard.challengeConfigured
                        ? "Setup needed"
                        : "Live"}
                </span>
              </div>
              <form id="limit-form" className="limit-form" onSubmit={handleSaveLimit} noValidate>
                <label htmlFor="voucher-limit">Maximum vouchers</label>
                <div className="limit-controls">
                  <input
                    ref={limitInputRef}
                    id="voucher-limit"
                    type="number"
                    min={1}
                    max={1000000}
                    step={1}
                    required
                    value={limitValue}
                    onChange={(event) => setLimitValue(event.target.value)}
                  />
                  <button
                    id="save-limit"
                    className="button button-primary button-small"
                    type="submit"
                    disabled={savingLimit}
                  >
                    Save limit
                  </button>
                </div>
                <p
                  id="limit-feedback"
                  className={`inline-feedback${limitError ? " is-error" : ""}`}
                  aria-live="polite"
                >
                  {limitFeedback}
                </p>
              </form>
              <div className="admin-progress-track">
                <div
                  id="admin-progress"
                  className="progress-fill"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </section>

            <section className="admin-panel voucher-code-panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">SHARED CLAIM CODE</p>
                  <h2>Set the voucher code</h2>
                </div>
                <span
                  id="voucher-code-status"
                  className={`status-pill${!dashboard?.voucherCode ? " sold-out" : ""}`}
                >
                  {dashboard?.voucherCode ? "Ready" : "Not set"}
                </span>
              </div>
              <form
                id="voucher-code-form"
                className="voucher-code-form"
                onSubmit={handleSaveCode}
                noValidate
              >
                <label htmlFor="voucher-code-setting">Shared voucher code visitors will enter</label>
                <div className="voucher-code-controls">
                  <input
                    ref={codeInputRef}
                    id="voucher-code-setting"
                    className="voucher-code-input"
                    type="text"
                    maxLength={256}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Enter any code you choose"
                    aria-describedby="voucher-code-hint"
                    value={voucherCodeValue}
                    onChange={(event) => setVoucherCodeValue(event.target.value)}
                  />
                  <button
                    id="save-voucher-code"
                    className="button button-primary button-small"
                    type="submit"
                    disabled={savingCode}
                  >
                    Save voucher code
                  </button>
                </div>
                <p id="voucher-code-hint" className="inline-feedback">
                  Any characters are allowed, including spaces and symbols. Visitors must enter the
                  exact same code.
                </p>
                <p
                  id="voucher-code-feedback"
                  className={`inline-feedback${codeError ? " is-error" : ""}`}
                  aria-live="polite"
                >
                  {codeFeedback}
                </p>
              </form>
            </section>

            <section className="admin-panel voucher-challenge-panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">CLAIM VERIFICATION</p>
                  <h2>Add a question and answer</h2>
                </div>
                <span
                  id="voucher-challenge-status"
                  className={`status-pill${!dashboard?.questionConfigured ? " sold-out" : ""}`}
                >
                  {dashboard?.questionConfigured ? "Ready" : "Not set"}
                </span>
              </div>
              <form
                id="voucher-challenge-form"
                className="voucher-challenge-form"
                onSubmit={handleSaveChallenge}
                noValidate
              >
                <label htmlFor="voucher-question-setting">Question visitors must answer</label>
                <textarea
                  ref={questionInputRef}
                  id="voucher-question-setting"
                  className="voucher-challenge-input"
                  maxLength={512}
                  rows={2}
                  placeholder="e.g. What is the name of the graduating faculty?"
                  aria-describedby="voucher-challenge-hint"
                  value={questionValue}
                  onChange={(event) => setQuestionValue(event.target.value)}
                />
                <label htmlFor="voucher-answer-setting">Correct answer</label>
                <div className="input-action-wrap">
                  <input
                    id="voucher-answer-setting"
                    className="voucher-challenge-input"
                    type={answerVisible ? "text" : "password"}
                    maxLength={256}
                    autoComplete="new-password"
                    placeholder={
                      dashboard?.questionConfigured
                        ? "Leave blank to keep current answer, or enter a new one"
                        : "Enter the answer"
                    }
                    value={answerValue}
                    onChange={(event) => setAnswerValue(event.target.value)}
                  />
                  <button
                    id="toggle-answer-visibility"
                    className="button button-quiet toggle-visibility"
                    type="button"
                    aria-controls="voucher-answer-setting"
                    aria-pressed={answerVisible}
                    onClick={() => setAnswerVisible((prev) => !prev)}
                  >
                    {answerVisible ? "Hide" : "Show"}
                  </button>
                </div>
                <p id="voucher-challenge-hint" className="inline-feedback">
                  After entering the shared voucher code, visitors will answer this question before
                  their voucher is created. The answer is stored securely and isn't shown in the
                  dashboard.
                </p>
                <button
                  id="save-voucher-challenge"
                  className="button button-primary button-small"
                  type="submit"
                  disabled={savingChallenge}
                >
                  Save question and answer
                </button>
                <p
                  id="voucher-challenge-feedback"
                  className={`inline-feedback${challengeError ? " is-error" : ""}`}
                  aria-live="polite"
                >
                  {challengeFeedback}
                </p>
              </form>
            </section>

            <section className="admin-panel activity-panel">
              <div className="panel-heading">
                <div>
                  <p className="panel-kicker">LATEST CLAIMS</p>
                  <h2>Recent vouchers</h2>
                </div>
                <span id="last-updated" className="updated-label">
                  {lastUpdated}
                </span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Voucher code</th>
                      <th>Created</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody id="recent-vouchers">
                    {(dashboard?.recent || []).map((voucher, index) => (
                      <tr key={`${voucher.createdAt}-${index}`}>
                        <td>{voucher.code}</td>
                        <td>{formatDate(voucher.createdAt)}</td>
                        <td>Created</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p
                  id="empty-vouchers"
                  className="empty-state"
                  hidden={Boolean(dashboard?.recent?.length)}
                >
                  No vouchers created yet. Your first claim will show up here.
                </p>
              </div>
            </section>
            <p id="dashboard-error" className="dashboard-error" role="alert" hidden={!dashboardError}>
              {dashboardError}
            </p>
          </section>
        )}
      </main>
    </Layout>
  );
}

