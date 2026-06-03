import { useState } from "react";
import MapPage from "./pages/MapPage";
import ImportPage from "./pages/ImportPage";
import ExplorePage from "./pages/ExplorePage";
import LibraryPage from "./pages/LibraryPage";

type Tab = "map" | "import" | "explore" | "library";
type Theme = "dark" | "light";
type IconName = "map" | "book" | "plus" | "compass";

const tabs: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: "map", label: "Atlas", icon: "map" },
  { id: "library", label: "Library", icon: "book" },
  { id: "import", label: "Import", icon: "plus" },
  { id: "explore", label: "Explore", icon: "compass" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("map");
  const [theme, setTheme] = useState<Theme>(
    document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
  );

  const toggleTheme = () => {
    const nextTheme: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", nextTheme);
    localStorage.setItem("ta-theme", nextTheme);
    setTheme(nextTheme);
  };

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-brand">Taste Aligner</div>
        <div className="nav-tabs">
          {tabs.map((item) => (
            <button
              key={item.id}
              className={`nav-tab ${tab === item.id ? "active" : ""}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          className="theme-toggle"
          type="button"
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          onClick={toggleTheme}
        >
          <ThemeIcon theme={theme} />
        </button>
      </nav>
      <main className={`main ${tab === "map" ? "main-map" : ""}`}>
        {tab === "map" && <MapPage />}
        {tab === "import" && <ImportPage />}
        {tab === "explore" && <ExplorePage />}
        {tab === "library" && <LibraryPage onNavigate={setTab} />}
      </main>
      <nav className="bottom-nav" aria-label="Primary">
        {tabs.map((item) => (
          <button
            key={item.id}
            className={`bottom-nav-item ${tab === item.id ? "active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            <span className="bottom-nav-icon" aria-hidden="true"><TabIcon name={item.icon} /></span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === "dark") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 4V2m0 20v-2m8-8h2M2 12h2m14.95-6.95 1.42-1.42M3.63 20.37l1.42-1.42m0-13.9L3.63 3.63m16.74 16.74-1.42-1.42" />
        <circle cx="12" cy="12" r="4" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.5 15.2A8.6 8.6 0 0 1 8.8 3.5 8.7 8.7 0 1 0 20.5 15.2Z" />
    </svg>
  );
}

function TabIcon({ name }: { name: IconName }) {
  if (name === "map") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="m3 6 5-2 8 2 5-2v14l-5 2-8-2-5 2V6Z" />
        <path d="M8 4v14m8-12v14" />
      </svg>
    );
  }
  if (name === "book") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5V5.5Z" />
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20M4 18.5A2.5 2.5 0 0 1 6.5 16H20" />
      </svg>
    );
  }
  if (name === "plus") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M12 5v14m7-7H5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24">
      <path d="M16.5 7.5 14 14l-6.5 2.5L10 10l6.5-2.5Z" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}
