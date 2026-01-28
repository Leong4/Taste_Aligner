import { useState } from 'react'

type CityPageProps = {
  onRun: (city: string) => void
  loading: boolean
  error: string | null
}

export default function CityPage({ onRun, loading, error }: CityPageProps) {
  const [city, setCity] = useState('London')

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = city.trim()
    if (!trimmed) return
    onRun(trimmed)
  }

  return (
    <section className="panel">
      <h2>Choose a city</h2>
      <p className="muted">
        Enter a city name and generate a dummy journey plan from the local runtime.
      </p>
      <form className="city-form" onSubmit={handleSubmit}>
        <input
          value={city}
          onChange={(event) => setCity(event.target.value)}
          placeholder="e.g. London"
          aria-label="City"
        />
        <button type="submit" disabled={loading}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </form>
      {error && <p className="error">Error: {error}</p>}
    </section>
  )
}
