import { useState } from "react";
import MapPage from "./pages/MapPage";
import ImportPage from "./pages/ImportPage";
import ExplorePage from "./pages/ExplorePage";
import LibraryPage from "./pages/LibraryPage";

type Tab = "map" | "import" | "explore" | "library";

export default function App() {
  const [tab, setTab] = useState<Tab>("map");

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-brand">Taste Aligner</div>
        <div className="nav-tabs">
          {(["map", "import", "explore", "library"] as Tab[]).map((t) => (
            <button
              key={t}
              className={`nav-tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "map" ? "Map" : t === "import" ? "Import" : t === "explore" ? "Explore" : "Library"}
            </button>
          ))}
        </div>
      </nav>
      <main className={`main ${tab === "map" ? "main-map" : ""}`}>
        {tab === "map" && <MapPage />}
        {tab === "import" && <ImportPage />}
        {tab === "explore" && <ExplorePage />}
        {tab === "library" && <LibraryPage />}
      </main>
    </div>
  );
}
