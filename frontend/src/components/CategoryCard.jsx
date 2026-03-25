import { categoryPages } from "../data/dashboard-meta.js";

export function CategoryCard({ pageKey }) {
  return (
    <article className="info-card info-card--secondary">
      <p className="info-card__kicker">CATEGORY</p>
      <h2 className="info-card__title">카테고리</h2>
      <div className="info-card__category-list">
        {Object.entries(categoryPages).map(([key, item]) => (
          <a
            className={`category-link${key === pageKey ? " is-active" : ""}`}
            href={item.href}
            key={key}
          >
            {item.label}
          </a>
        ))}
      </div>
    </article>
  );
}
