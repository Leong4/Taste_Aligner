import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme.css";
import "./App.css";

const savedTheme = localStorage.getItem("ta-theme");
document.documentElement.setAttribute("data-theme", savedTheme === "light" ? "light" : "dark");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
