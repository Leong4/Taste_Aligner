import type { RunResponse } from '../types'

type CardPageProps = {
  result: RunResponse | null
  imageUrl: string | null
}

export default function CardPage({ result, imageUrl }: CardPageProps) {
  if (!result) {
    return (
      <section className="panel">
        <h2>No journey yet</h2>
        <p className="muted">Run the input step to generate a journey card.</p>
      </section>
    )
  }

  const output = result.output
  const cards = output?.cards ?? []
  const cz = output?.cz_used ?? []
  const ez = output?.ez_used ?? []

  return (
    <section className="panel">
      <div className="card-header">
        <div>
          <h2>Journey card</h2>
          <p className="muted">City: {output?.city ?? result.city ?? 'unknown'}</p>
        </div>
        <span className={`tag ${result.type}`}>{result.type}</span>
      </div>

      <div className="grid">
        <div className="block">
          <h3>CZ Block</h3>
          {cz.length === 0 ? (
            <p className="muted">No CZ items</p>
          ) : (
            <ul>
              {cz.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="block">
          <h3>EZ Block</h3>
          {ez.length === 0 ? (
            <p className="muted">No EZ items</p>
          ) : (
            <ul>
              {ez.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="block memory">
          <h3>Memory Anchor</h3>
          {imageUrl ? (
            <img src={imageUrl} alt="Memory anchor" />
          ) : (
            <div className="image-placeholder">Drop a demo image here</div>
          )}
        </div>
      </div>

      <div className="block">
        <h3>Cards</h3>
        {cards.length === 0 ? (
          <p className="muted">No cards returned</p>
        ) : (
          <ul className="cards">
            {cards.map((card) => (
              <li key={`${card.step}-${card.place}`}>
                <strong>Step {card.step}:</strong> {card.place}
              </li>
            ))}
          </ul>
        )}
      </div>

      <details className="raw">
        <summary>Raw JSON</summary>
        <pre>{JSON.stringify(result, null, 2)}</pre>
      </details>
    </section>
  )
}
