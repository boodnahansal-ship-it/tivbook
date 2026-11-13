import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@tivbook/client";
import "@tivbook/client/src/theme.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
