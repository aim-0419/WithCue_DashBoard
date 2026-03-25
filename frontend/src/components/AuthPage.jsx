import { useMemo, useState } from "react";
import { formatBirthDateInput, normalizeBirthDateInput } from "../lib/birthdate.js";

const genderOptions = [
  { value: "male", label: "남" },
  { value: "female", label: "여" },
];

const locationOptions = [
  { value: "hyocheon", label: "효천점" },
  { value: "jangdeok", label: "장덕점" },
  { value: "aim", label: "AIM" },
];

function buildQuery(nextView) {
  const params = new URLSearchParams(window.location.search);
  params.set("view", nextView);
  params.delete("page");
  return `/?${params.toString()}`;
}

function GenderSelector({ value, onChange }) {
  return (
    <div className="auth-choice-group" role="radiogroup" aria-label="성별 선택">
      {genderOptions.map((option) => (
        <button
          type="button"
          key={option.value}
          className={`auth-choice${value === option.value ? " is-active" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function LocationSelector({ value, onChange }) {
  return (
    <div className="auth-location-grid" role="group" aria-label="위치 선택">
      {locationOptions.map((option) => (
        <button
          type="button"
          key={option.value}
          className={`auth-location${value === option.value ? " is-active" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ConsentField({ agreed, onChange }) {
  return (
    <div className="auth-field">
      <span className="auth-field__label">개인정보 동의</span>
      <div className="auth-consent">
        <div className="auth-consent__box">
          <p className="auth-consent__title">개인정보 수집 및 이용 안내</p>
          <p className="auth-consent__text">
            이름, 생년월일, 성별은 데이터 수집 참여자 확인과 수집 기록 관리 목적으로만
            사용됩니다.
          </p>
          <p className="auth-consent__text">
            수집된 정보는 연구 및 운영 목적에 한해 사용되며, 촬영 데이터와 참여자 정보를
            연결하는 식별 정보로만 관리됩니다.
          </p>
          <p className="auth-consent__text">
            동의하지 않으면 회원가입과 이후 수집 절차를 진행할 수 없습니다.
          </p>
        </div>

        <label className="auth-consent__check">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>개인정보 수집 및 이용에 동의합니다.</span>
        </label>
      </div>
    </div>
  );
}

function AuthForm({ mode, onLogin, onSignup }) {
  const [form, setForm] = useState({
    name: "",
    birthDate: "",
    gender: "male",
    location: "",
    consentAgreed: false,
  });
  const [errorMessage, setErrorMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isLogin = mode === "login" || mode === "admin-login";
  const isAdminLogin = mode === "admin-login";
  const isSignup = mode === "signup";

  const submitLabel = useMemo(() => {
    if (isAdminLogin) {
      return "관리자 로그인";
    }

    return isLogin ? "로그인" : "회원가입";
  }, [isAdminLogin, isLogin]);

  const birthDatePreview = useMemo(() => {
    const result = normalizeBirthDateInput(form.birthDate);
    return result.ok ? result.display : "";
  }, [form.birthDate]);

  function updateField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrorMessage("");
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (!form.name.trim() || !form.birthDate || !form.gender) {
      setErrorMessage("이름, 생년월일, 성별을 모두 입력해 주세요.");
      return;
    }

    const birthDateResult = normalizeBirthDateInput(form.birthDate);
    if (!birthDateResult.ok) {
      setErrorMessage(birthDateResult.message);
      return;
    }

    if (mode === "login" && !form.location) {
      setErrorMessage("로그인할 지점을 선택해 주세요.");
      return;
    }

    if (isSignup && !form.consentAgreed) {
      setErrorMessage("개인정보 동의 후 회원가입을 진행할 수 있습니다.");
      return;
    }

    const payload = {
      ...form,
      birthDate: birthDateResult.normalized,
      birthDateDisplay: birthDateResult.display,
    };

    setSubmitting(true);
    const result = isLogin ? await onLogin?.(payload, mode) : await onSignup?.(payload);
    setSubmitting(false);

    if (result?.ok === false) {
      setErrorMessage(result.message || `${submitLabel}에 실패했습니다.`);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <label className="auth-field">
        <span className="auth-field__label">이름</span>
        <input
          className="auth-input"
          type="text"
          placeholder="이름을 입력해 주세요"
          value={form.name}
          onChange={(event) => updateField("name", event.target.value)}
        />
      </label>

      <label className="auth-field">
        <span className="auth-field__label">생년월일</span>
        <input
          className="auth-input"
          type="text"
          inputMode="numeric"
          maxLength={8}
          placeholder="YY-MM-DD"
          value={form.birthDate}
          onChange={(event) => updateField("birthDate", formatBirthDateInput(event.target.value))}
        />
        <p className="auth-field__hint">
          {birthDatePreview ? `자동 변환: ${birthDatePreview}` : "YY-MM-DD 형식으로 입력해 주세요."}
        </p>
      </label>

      <div className="auth-field">
        <span className="auth-field__label">성별</span>
        <GenderSelector value={form.gender} onChange={(gender) => updateField("gender", gender)} />
      </div>

      {mode === "login" ? (
        <div className="auth-field">
          <span className="auth-field__label">지점 선택</span>
          <LocationSelector
            value={form.location}
            onChange={(location) => updateField("location", location)}
          />
        </div>
      ) : null}

      {isSignup ? (
        <ConsentField
          agreed={form.consentAgreed}
          onChange={(checked) => updateField("consentAgreed", checked)}
        />
      ) : null}

      {errorMessage ? <p className="auth-message auth-message--error">{errorMessage}</p> : null}

      <button type="submit" className="auth-submit">
        {submitting ? "처리 중..." : submitLabel}
      </button>
    </form>
  );
}

export function AuthPage({ mode = "login", notice = "", onLogin, onSignup }) {
  const isLogin = mode === "login";
  const isAdminLogin = mode === "admin-login";

  return (
    <main className="dashboard dashboard--auth">
      <section className="command-board command-board--auth">
        <div className="auth-shell">
          <section className="auth-card">
            <div className="auth-switch">
              <a
                href={buildQuery("login")}
                className={`auth-switch__button${isLogin ? " is-active" : ""}`}
              >
                로그인
              </a>
              <a
                href={buildQuery("signup")}
                className={`auth-switch__button${mode === "signup" ? " is-active" : ""}`}
              >
                회원가입
              </a>
            </div>

            <div className="auth-card__inner">
              <p className="info-card__kicker">
                {isAdminLogin ? "ADMIN ACCESS" : mode === "signup" ? "SIGN UP" : "LOGIN"}
              </p>
              <h1 className="auth-form-title">
                {isAdminLogin ? "관리자 로그인" : mode === "signup" ? "회원가입" : "로그인"}
              </h1>
              <p className="auth-form-description">
                {isAdminLogin
                  ? "관리자 계정으로 로그인하면 데이터 수집 현황 대시보드에 접근할 수 있습니다."
                  : mode === "signup"
                    ? "회원가입 시 개인정보 동의를 먼저 확인하고, 동의 완료 후 계정을 등록합니다."
                    : "회원가입한 이름, 생년월일, 성별을 입력하고 지점을 선택하면 해당 촬영 페이지로 바로 이동합니다."}
              </p>

              {notice ? <p className="auth-message auth-message--notice">{notice}</p> : null}

              <AuthForm mode={mode} onLogin={onLogin} onSignup={onSignup} />

              {!isAdminLogin ? (
                <a href={buildQuery("admin-login")} className="auth-admin-link">
                  관리자 대시보드 로그인
                </a>
              ) : (
                <a href={buildQuery("login")} className="auth-admin-link">
                  일반 수집 로그인으로 돌아가기
                </a>
              )}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
