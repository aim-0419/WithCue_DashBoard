import { donutColors } from "../data/dashboard-meta.js";

function formatNumber(value, suffix) {
  return `${value}${suffix}`;
}

function createDonutBackground(metricKey, locations) {
  const total = locations.reduce((sum, location) => sum + Number(location[metricKey] || 0), 0);

  if (!total) {
    return "conic-gradient(rgba(255,255,255,0.08) 0 100%)";
  }

  let currentAngle = 0;
  const segments = locations.map((location, index) => {
    const ratio = (Number(location[metricKey] || 0) / total) * 360;
    const start = currentAngle;
    const end = currentAngle + ratio;
    currentAngle = end;
    return `${donutColors[index % donutColors.length]} ${start}deg ${end}deg`;
  });

  return `conic-gradient(${segments.join(", ")})`;
}

function getSyncMessage(data) {
  if (!data) {
    return "데이터 확인 중";
  }

  if (data.source === "firebase") {
    return "Firebase 실시간 운영 데이터";
  }

  if (data.source === "firebase-empty") {
    return "Firebase 연결됨, 초기 데이터 필요";
  }

  if (data.source === "mock-error") {
    const errorParts = [data.errorCode, data.errorMessage].filter(Boolean);
    return `Firebase 연결 오류: ${errorParts.join(" / ") || "알 수 없음"}`;
  }

  return "샘플 데이터 표시 중";
}

export function SummaryPanel({
  pageKey,
  displayedSessionCount,
  displayedConsentCount,
  locations,
  data,
}) {
  const showDonut = pageKey === "main";

  return (
    <article className="info-card info-card--primary">
      <p className="info-card__kicker">COLLECTION STATUS</p>
      <h2 className="info-card__title">관리자 요약</h2>

      {showDonut ? (
        <div className="donut-panel">
          <div className="donut-block">
            <p className="donut-block__label">총 세션 저장 수</p>
            <div
              className="donut-chart"
              style={{ background: createDonutBackground("SessionCount", locations) }}
            />
            <strong className="donut-total">{formatNumber(displayedSessionCount, "건")}</strong>
          </div>

          <div className="donut-block">
            <p className="donut-block__label">개인정보 동의</p>
            <div
              className="donut-chart"
              style={{ background: createDonutBackground("ConsentCount", locations) }}
            />
            <strong className="donut-total">{formatNumber(displayedConsentCount, "명")}</strong>
          </div>

          <div className="donut-legend">
            {locations.map((location, index) => {
              const ratio = displayedSessionCount
                ? Math.round((Number(location.SessionCount || 0) / displayedSessionCount) * 100)
                : 0;

              return (
                <div className="donut-legend__item" key={location.id || location.Name}>
                  <span
                    className="donut-legend__dot"
                    style={{ background: donutColors[index % donutColors.length] }}
                  />
                  <span className="donut-legend__name">{location.DisplayName || location.Name}</span>
                  <span className="donut-legend__ratio">{ratio}%</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="metric-stack">
          <div className="metric-box">
            <p className="metric-box__label">총 세션 저장 수</p>
            <strong className="metric-box__value">{formatNumber(displayedSessionCount, "건")}</strong>
          </div>
          <div className="metric-box">
            <p className="metric-box__label">개인정보 동의</p>
            <strong className="metric-box__value">{formatNumber(displayedConsentCount, "명")}</strong>
          </div>
        </div>
      )}

      {!showDonut && (
        <div className="status-box">
          <span className="status-dot" />
          <span>{getSyncMessage(data)}</span>
        </div>
      )}
    </article>
  );
}
