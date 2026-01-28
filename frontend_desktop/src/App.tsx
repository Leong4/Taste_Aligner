import { useMemo, useState } from 'react'
import CityPage from './pages/CityPage'
import ImagePage from './pages/ImagePage'
import CardPage from './pages/CardPage'
import type { RunResponse } from './types'

type View = 'input' | 'image' | 'card'

const API_URL = 'http://localhost:8787/run'

export default function App() {
  const [view, setView] = useState<View>('input')
  const [runResult, setRunResult] = useState<RunResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)

  const headerTitle = useMemo(() => {
    if (view === 'input') return 'Taste Aligner · Input'
    if (view === 'image') return 'Taste Aligner · Image'
    return 'Taste Aligner · Cards'
  }, [view])

  const handleRun = async (city: string) => {
    const text = `I want to travel to ${city}`
    setLoading(true)
    setError(null)

    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })

      if (!resp.ok) {
        throw new Error(`Server error: ${resp.status}`)
      }

      const data = (await resp.json()) as RunResponse
      setRunResult(data)
      setView('card')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const handleImageChange = (file: File | null) => {
    if (!file) {
      setImageUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setImageUrl(url)
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <p className="app-kicker">Stage 4 MVP</p>
          <h1>{headerTitle}</h1>
        </div>
        <nav className="nav">
          <button
            className={view === 'input' ? 'nav-button active' : 'nav-button'}
            onClick={() => setView('input')}
          >
            Input
          </button>
          <button
            className={view === 'image' ? 'nav-button active' : 'nav-button'}
            onClick={() => setView('image')}
          >
            Image
          </button>
          <button
            className={view === 'card' ? 'nav-button active' : 'nav-button'}
            onClick={() => setView('card')}
            disabled={!runResult}
          >
            Card
          </button>
        </nav>
      </header>

      <main className="app-main">
        {view === 'input' && (
          <CityPage onRun={handleRun} loading={loading} error={error} />
        )}
        {view === 'image' && (
          <ImagePage imageUrl={imageUrl} onImageChange={handleImageChange} />
        )}
        {view === 'card' && (
          <CardPage result={runResult} imageUrl={imageUrl} />
        )}
      </main>
    </div>
  )
}
