import { bodyPartMeta } from "../data/dashboard-meta.js";

export function BodyMapPanel({ bodyParts }) {
  return (
    <section className="bodymap-panel" aria-label="신체 부위별 데이터 현황">
      <div className="bodymap-stage">
        <div className="bodymap-content">
          <img
            className="body-silhouette-image"
            src="/assets/images/body.png"
            alt="신체 부위 데이터 표시용 인체 이미지"
          />

          <div className="connector connector--neck" />
          <div className="connector connector--hip" />
          <div className="connector connector--left-shoulder" />
          <div className="connector connector--right-shoulder" />
          <div className="connector connector--left-knee" />
          <div className="connector connector--right-knee" />

          <div className="joint joint--neck" />
          <div className="joint joint--hip" />
          <div className="joint joint--left-shoulder" />
          <div className="joint joint--right-shoulder" />
          <div className="joint joint--left-knee" />
          <div className="joint joint--right-knee" />

          <div className="body-part-grid">
            {bodyPartMeta.map((part) => (
              <article className={part.className} key={part.key}>
                <p className="body-part-card__label">{part.label}</p>
                <strong className="body-part-card__value">{bodyParts[part.key] || 0}건</strong>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
