import { useMemo, useState } from "react";
import { formatBirthDateInput, normalizeBirthDateInput } from "../lib/birthdate.js";

const genderOptions = [
  { value: "male", label: "남" },
  { value: "female", label: "여" },
];

// 지점은 AIM 하나뿐이라 선택 UI 없이 항상 이 값으로 고정함.
const FIXED_LOCATION = "aim";

// 현재 화면 상태만 바꾸고 나머지 쿼리는 최대한 유지함.
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

function ConsentField({ agreed, onChange }) {
  return (
    <div className="auth-field">
      <span className="auth-field__label">개인정보 동의</span>
      <div className="auth-consent">
        <div className="auth-consent__box">
          <p className="auth-consent__title">개인정보 보호 및 데이터 관리 방안</p>
          <p className="auth-consent__text">
            입력된 정보는 연구 참여자 식별 및 영상 데이터 파일명 매핑을 위해 사용됩니다. 동의해야 다음 단계로 이동할 수 있습니다.
          </p>
          <p className="auth-consent__text">
            1. 개인정보 비식별화 처리: 수집된 영상 데이터는 개인정보 보호를 위해 비식별화 절차를 거쳐 관리합니다.
          </p>
          <p className="auth-consent__text">
            얼굴 영역은 개인 식별 가능성을 최소화하기 위해 자동 또는 수동 방식의 모자이크(Blur/Masking) 처리 대상이 될 수 있으며, 실명과 개인 식별 정보는 데이터 파일에 직접 포함하지 않습니다.
          </p>
          <p className="auth-consent__text">
            참여자 정보는 무작위 생성된 참여자 ID 코드로 관리하며, 영상 파일에는 음성 정보를 포함하지 않거나 필요한 경우 별도의 음성 제거 절차를 적용합니다.
          </p>
          <p className="auth-consent__text">
            2. 데이터 접근 통제: 데이터는 연구 수행에 직접 참여하는 연구자에게만 접근 권한을 부여하며, 제한된 인원만 접근할 수 있도록 관리합니다.
          </p>
          <p className="auth-consent__text">
            외부 반출 또는 공유가 필요한 경우에는 비식별화 처리된 데이터에 한해 제공합니다.
          </p>
          <p className="auth-consent__text">
            3. 데이터 저장 및 보관: 데이터는 AIM 내부 저장 시스템에 보관하며, 정기적인 백업과 접근 권한 관리를 적용합니다.
          </p>
          <p className="auth-consent__text">
            수집 목적 범위 안에서만 데이터를 사용하며, 동의하지 않으면 회원가입 이후 수집 절차를 진행할 수 없습니다.
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
    location: FIXED_LOCATION,
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

  // 입력 중인 날짜를 제출 형식과 분리해 안내함.
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

    // 기본 입력 누락을 먼저 막음.
    if (!form.name.trim() || !form.birthDate || !form.gender) {
      setErrorMessage("이름, 생년월일, 성별을 모두 입력해 주세요.");
      return;
    }

    const birthDateResult = normalizeBirthDateInput(form.birthDate);
    if (!birthDateResult.ok) {
      setErrorMessage(birthDateResult.message);
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

    try {
      const result = isLogin ? await onLogin?.(payload, mode) : await onSignup?.(payload);

      if (result?.ok === false) {
        setErrorMessage(result.message || `${submitLabel} 요청에 실패했습니다.`);
      }
    } catch (error) {
      setErrorMessage(error?.message || `${submitLabel} 처리 중 오류가 발생했습니다.`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      <label className="auth-field">
        <span className="auth-field__label">이름</span>
        <input
          className="auth-input"
          type="text"
          placeholder="이름을 입력해 주세요."
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
            {/* 로그인과 회원가입 화면을 한 카드 안에서 전환함. */}
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
                  ? "관리자 계정으로 로그인하면 대시보드에 바로 접근할 수 있습니다."
                  : mode === "signup"
                    ? "개인정보 동의 후 회원가입을 진행합니다."
                    : "회원가입한 이름, 생년월일, 성별을 입력하면 수집 화면으로 이동합니다."}
              </p>

              {notice ? <p className="auth-message auth-message--notice">{notice}</p> : null}

              <AuthForm mode={mode} onLogin={onLogin} onSignup={onSignup} />

              {isAdminLogin ? (
                <a href={buildQuery("login")} className="auth-admin-link">
                  일반 수집 로그인으로 돌아가기
                </a>
              ) : null}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
