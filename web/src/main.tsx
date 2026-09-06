import React from "react";
import { createRoot } from "react-dom/client";
import "dockview/dist/styles/dockview.css";
import "@xterm/xterm/css/xterm.css";
import "./theme.css";
import { App } from "./App.js";
import { store } from "./store.js";

store.boot();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
