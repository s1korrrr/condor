import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import "../../design-system/v5/app.css";
import { V5App } from "./V5App";

const root = document.getElementById("v5-root");
if (!root) throw new Error("RSI V5 root element is missing.");

createRoot(root).render(
  <StrictMode>
    <V5App />
  </StrictMode>,
);
