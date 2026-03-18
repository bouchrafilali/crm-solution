import { useState } from "react";
import { queryShoppingBrain } from "./shoppingBrainApi.js";
import type { ShoppingBrainResponse, NextAction, Recommendation } from "./types.js";
import "./styles.css";

const CTA_LABELS: Record<NextAction, string> = {
  explore_more: "View piece",
  ask_size_or_details: "Ask for sizing",
  move_toward_checkout: "Continue to checkout",
  suggest_consultation: "Book consultation",
};

const NEXT_ACTION_BTN: Record<NextAction, string> = {
  explore_more: "Explore more pieces",
  ask_size_or_details: "Ask about sizing",
  move_toward_checkout: "Continue to checkout",
  suggest_consultation: "Book a consultation",
};

const EXAMPLE_QUERIES = [
  "An elegant white outfit for a wedding",
  "A statement kaftan for a gala evening",
  "Understated luxury for a city dinner",
];

function RecommendationCard({ rec, ctaLabel }: { rec: Recommendation; ctaLabel: string }) {
  const [imgError, setImgError] = useState(false);

  return (
    <article className="card">
      <div className="card__image-wrap">
        {rec.image && !imgError ? (
          <img
            src={rec.image}
            alt={rec.title}
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="card__image-placeholder">
            <span>BFL</span>
          </div>
        )}
      </div>
      <div className="card__body">
        <p className="card__merchant">{rec.merchant}</p>
        <h3 className="card__title">{rec.title}</h3>
        <p className="card__reason">{rec.reason}</p>
      </div>
      <div className="card__footer">
        <span className="card__price">{rec.price}</span>
        <a
          href={rec.productUrl ?? "#"}
          className="card__cta"
          target={rec.productUrl ? "_blank" : undefined}
          rel="noopener noreferrer"
        >
          {ctaLabel}
        </a>
      </div>
    </article>
  );
}

export function App() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ShoppingBrainResponse | null>(null);

  async function submit(message: string) {
    const trimmed = message.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const data = await queryShoppingBrain(trimmed);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit(query);
  }

  function handleExample(example: string) {
    setQuery(example);
    submit(example);
  }

  const ctaLabel = result ? (CTA_LABELS[result.nextAction] ?? "View piece") : "View piece";
  const nextActionLabel = result ? (NEXT_ACTION_BTN[result.nextAction] ?? "Continue") : "Continue";
  const nextQuestion = result?.suggestedNextQuestion ?? result?.nextQuestion;

  return (
    <main className="page">
      <header className="masthead">
        <p className="masthead__eyebrow">Maison Bouchra Filali Lahlou</p>
        <h1 className="masthead__title">
          Your personal<br /><em>style advisor</em>
        </h1>
        <p className="masthead__sub">Describe the occasion. We curate the look.</p>
      </header>

      <div className="divider" />

      <form className="search-form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="search-input"
          placeholder="I need an elegant white outfit for a wedding..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={loading}
          autoFocus
        />
        <button type="submit" className="search-btn" disabled={loading || !query.trim()}>
          Discover
        </button>
      </form>

      {loading && (
        <div className="loading-state">
          <div className="loading-bar" />
          <p>Curating your selection&hellip;</p>
        </div>
      )}

      {error && !loading && (
        <div className="error-state">
          <p>{error}</p>
        </div>
      )}

      {result && !loading && (
        <section className="results">
          {result.assistantSummary && (
            <div className="summary">
              <p className="summary__label">Your advisor</p>
              <p className="summary__text">{result.assistantSummary}</p>
            </div>
          )}

          {result.recommendations.length > 0 && (
            <>
              <p className="cards-label">Selected for you</p>
              <div className="cards">
                {result.recommendations.slice(0, 3).map((rec) => (
                  <RecommendationCard key={rec.id} rec={rec} ctaLabel={ctaLabel} />
                ))}
              </div>
            </>
          )}

          {result.recommendations.length === 0 && (
            <div className="empty-state">
              <div className="empty-state__icon">BFL</div>
              <h2>Nothing matched quite yet</h2>
              <p>Try rephrasing your request or describe the occasion in more detail.</p>
            </div>
          )}

          <div className="next-action">
            {nextQuestion && (
              <p className="next-action__question">{nextQuestion}</p>
            )}
            <button
              className="next-action__btn"
              onClick={() => {
                if (nextQuestion) {
                  setQuery(nextQuestion);
                  submit(nextQuestion);
                }
              }}
            >
              {nextActionLabel}
            </button>
          </div>
        </section>
      )}

      {!loading && !result && !error && (
        <div className="empty-state">
          <div className="empty-state__icon">BFL</div>
          <h2>What are you looking for?</h2>
          <p>Tell us about the occasion, your style, or the piece you have in mind.</p>
          <div className="examples">
            {EXAMPLE_QUERIES.map((q) => (
              <button key={q} className="example-pill" onClick={() => handleExample(q)}>
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
