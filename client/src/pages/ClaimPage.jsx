import { useCallback, useEffect, useRef, useState } from "react";
import { claimVoucher, fetchCampaignConfig, verifyVoucherCode } from "../api/client.js";
import { Layout } from "../components/Layout.jsx";

const SOLD_OUT_MESSAGE = "this voucher is no longer available";

export function ClaimPage() {
  const [step, setStep] = useState("code");
  const [code, setCode] = useState("");
  const [verifiedCode, setVerifiedCode] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [codeError, setCodeError] = useState("");
  const [answerError, setAnswerError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [successCode, setSuccessCode] = useState("");

  const [campaign, setCampaign] = useState({
    loaded: false,
    failed: false,
    available: false,
    challengeConfigured: false,
  });

  const codeInputRef = useRef(null);
  const answerInputRef = useRef(null);
  const stepRef = useRef(step);
  stepRef.current = step;

  const claimsOpen = campaign.available && campaign.challengeConfigured;
  const campaignSoldOut = campaign.loaded && !campaign.failed && !campaign.available;

  useEffect(() => {
    document.title = "Convocation voucher · Class of 2026";
  }, []);

  const refreshAvailability = useCallback(async () => {
    try {
      const data = await fetchCampaignConfig();
      const soldOut = !data.available;
      setCampaign({
        loaded: true,
        failed: false,
        available: Boolean(data.available),
        challengeConfigured: Boolean(data.challengeConfigured),
      });
      if (soldOut) {
        if (stepRef.current === "answer") {
          setAnswerError(SOLD_OUT_MESSAGE);
        } else {
          setCodeError(SOLD_OUT_MESSAGE);
        }
      } else {
        setCodeError((prev) => (prev === SOLD_OUT_MESSAGE ? "" : prev));
        setAnswerError((prev) => (prev === SOLD_OUT_MESSAGE ? "" : prev));
      }
    } catch {
      setCampaign((prev) => ({ ...prev, failed: true }));
    }
  }, []);

  useEffect(() => {
    refreshAvailability();
    const timer = window.setInterval(refreshAvailability, 5000);
    return () => window.clearInterval(timer);
  }, [refreshAvailability]);

  const resetToCodeStep = ({ clearCode = false } = {}) => {
    setStep("code");
    setVerifiedCode("");
    setAnswer("");
    setCodeError(campaignSoldOut ? SOLD_OUT_MESSAGE : "");
    setAnswerError("");
    if (clearCode) {
      setCode("");
    }
    if (!campaignSoldOut && claimsOpen) {
      window.setTimeout(() => codeInputRef.current?.focus(), 0);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (step === "code") {
      setCodeError("");
      if (!code || code.length > 256) {
        setCodeError(
          code ? "Voucher codes must be 256 characters or fewer." : "Enter the voucher code.",
        );
        codeInputRef.current?.focus();
        return;
      }

      setSubmitting(true);
      try {
        const result = await verifyVoucherCode(code);
        setVerifiedCode(code);
        setQuestion(result.question);
        setStep("answer");
        window.setTimeout(() => answerInputRef.current?.focus(), 0);
      } catch (error) {
        setCodeError(error.message);
        await refreshAvailability();
      } finally {
        setSubmitting(false);
      }
      return;
    }

    setAnswerError("");
    if (!answer.trim()) {
      setAnswerError("Enter your answer.");
      answerInputRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const result = await claimVoucher(verifiedCode, answer);
      setSuccessCode(result.voucher.code);
      await refreshAvailability();
    } catch (error) {
      if (error.code === "invalid_code") {
        resetToCodeStep();
        setCodeError(error.message);
      } else {
        setAnswerError(error.message);
      }
      await refreshAvailability();
    } finally {
      setSubmitting(false);
    }
  };

  const statusLabel = !campaign.loaded && campaign.failed
    ? "Voucher availability will update shortly"
    : !campaign.loaded
      ? "Checking convocation vouchers…"
      : campaignSoldOut
        ? "All convocation vouchers have been claimed"
        : campaign.challengeConfigured
          ? "Convocation vouchers are still available"
          : "Voucher claims will open soon";

  const codePlaceholder = campaignSoldOut
    ? "Claims closed"
    : campaign.challengeConfigured
      ? "Enter your voucher code"
      : "Claims opening soon";

  const codeHint = campaignSoldOut
    ? "All convocation vouchers have been claimed."
    : campaign.challengeConfigured
      ? "Enter the exact code provided by the event team."
      : "Waiting for the event team to finish setting up the verification question and answer.";

  return (
    <Layout
      headerLinkTo="/admin"
      headerLinkContent={
        <>
          Event team <span aria-hidden="true">↗</span>
        </>
      }
      footerLeft="Celebrating the Class of 2026"
      footerRight={`© ${new Date().getFullYear()} Convocation`}
    >
      <main className="claim-layout">
        <section className="claim-card" aria-labelledby="claim-heading">
          <div className="sparkle" aria-hidden="true">
            <span className="sparkle-dot dot-one" />
            <span className="sparkle-dot dot-two" />
            <span className="sparkle-star">✳</span>
          </div>
          <div className="eyebrow">
            <span className="live-dot" /> CLASS OF 2026 · CELEBRATION VOUCHERS
          </div>
          <h1 id="claim-heading">
            Your big day,
            <br />
            <span>with a little extra.</span>
          </h1>
          <p className="intro">
            Enter your convocation voucher code and claim a little something for your special day.
          </p>

          <div className="availability" aria-live="polite">
            <div className="availability-copy">
              <span id="availability-label">{statusLabel}</span>
            </div>
          </div>

          {!successCode ? (
            <form id="claim-form" onSubmit={handleSubmit} noValidate>
              {step === "code" ? (
                <div id="code-step">
                  <label htmlFor="voucher-code">Your convocation voucher code</label>
                  <div className="input-wrap">
                    <span className="input-icon" aria-hidden="true">
                      ✳
                    </span>
                    <input
                      ref={codeInputRef}
                      id="voucher-code"
                      name="code"
                      type="text"
                      autoComplete="off"
                      maxLength={256}
                      placeholder={codePlaceholder}
                      aria-describedby="code-hint form-error"
                      aria-invalid={codeError ? "true" : undefined}
                      disabled={!claimsOpen}
                      value={code}
                      onChange={(event) => {
                        setCode(event.target.value);
                        if (codeError) setCodeError("");
                      }}
                    />
                  </div>
                  <p id="code-hint" className="field-hint">
                    {codeHint}
                  </p>
                  <p id="form-error" className="form-error" role="alert" hidden={!codeError}>
                    {codeError}
                  </p>
                  <button
                    id="submit-voucher"
                    className="button button-primary"
                    type="submit"
                    disabled={submitting || !claimsOpen}
                  >
                    <span>{submitting ? "Checking…" : "Continue"}</span>
                    <span className="button-arrow" aria-hidden="true">
                      →
                    </span>
                  </button>
                </div>
              ) : (
                <div id="question-step">
                  <label id="voucher-question" htmlFor="voucher-answer">
                    {question}
                  </label>
                  <div className="input-wrap">
                    <span className="input-icon" aria-hidden="true">
                      ?
                    </span>
                    <input
                      ref={answerInputRef}
                      id="voucher-answer"
                      name="answer"
                      type="text"
                      maxLength={256}
                      autoComplete="off"
                      placeholder="Your answer"
                      aria-describedby="answer-hint answer-error"
                      aria-invalid={answerError ? "true" : undefined}
                      disabled={!claimsOpen}
                      value={answer}
                      onChange={(event) => {
                        setAnswer(event.target.value);
                        if (answerError) setAnswerError("");
                      }}
                    />
                  </div>
                  <p id="answer-hint" className="field-hint">
                    Answer correctly to claim your convocation voucher.
                  </p>
                  <p id="answer-error" className="form-error" role="alert" hidden={!answerError}>
                    {answerError}
                  </p>
                  <button
                    id="submit-answer"
                    className="button button-primary"
                    type="submit"
                    disabled={submitting || !claimsOpen}
                  >
                    <span>{submitting ? "Checking…" : "Claim my voucher"}</span>
                    <span className="button-arrow" aria-hidden="true">
                      →
                    </span>
                  </button>
                  <button
                    id="change-code"
                    className="text-button step-back"
                    type="button"
                    onClick={() => resetToCodeStep()}
                  >
                    ← Use a different voucher code
                  </button>
                </div>
              )}
            </form>
          ) : (
            <section id="success-panel" className="success-panel" aria-live="polite">
              <div className="success-icon" aria-hidden="true">
                ✓
              </div>
              <div>
                <p className="success-title">Voucher created successfully</p>
                <p className="success-copy">
                  Your code <strong id="success-code">{successCode}</strong> is ready. Have a
                  wonderful celebration!
                </p>
              </div>
              <button
                id="create-another"
                className="text-button"
                type="button"
                hidden={!claimsOpen}
                onClick={() => {
                  setSuccessCode("");
                  resetToCodeStep({ clearCode: true });
                }}
              >
                Create another
              </button>
            </section>
          )}

          <p className="privacy-note">
            <span aria-hidden="true">✦</span> Class of 2026 convocation · While supplies last
          </p>
        </section>

        <aside className="side-note" aria-label="Convocation celebration invitation">
          <img
            className="event-artwork"
            src="/convocation-invitation.jpg"
            alt="Invitation to the Faculty of Nursing Sciences induction and oath-taking ceremony on November 25, 2026"
          />
          <p className="note-kicker">A SPECIAL DAY WORTH CELEBRATING</p>
          <p className="note-copy">
            Celebrate your hard-earned
            <br />
            moment in style.
          </p>
        </aside>
      </main>
    </Layout>
  );
}

