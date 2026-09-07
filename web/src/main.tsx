import React from "react";
import { createRoot } from "react-dom/client";
import "dockview/dist/styles/dockview.css";
import "@xterm/xterm/css/xterm.css";
// Bundled fonts (Latin subsets, ~50 KB each): used on Windows by default and
// anywhere the user picks View → Appearance → Fonts → Bundled.
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/source-serif-4/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./theme.css";
import { App } from "./App.js";
import { store } from "./store.js";
import { installDiagListeners } from "./diag.js";

installDiagListeners();
store.boot();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
