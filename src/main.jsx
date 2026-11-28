import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";
// The shared controls (S3): after every component stylesheet, so their
// selector lists can re-skin the older class names; before buttons.css.
import "./components/chips.css";
import "./components/fields.css";
// Last, like the shared button block it replaces at the end of styles.css: a
// component rule of equal specificity does not override a variant's shape.
import "./components/buttons.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}
