import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@tivbook/client/src/theme.css";

const env = import.meta.env;
const configured = !!env.VITE_FIREBASE_API_KEY || env.VITE_USE_EMULATORS === "true";
const root = createRoot(document.getElementById("root")!);

if (!configured) {
  root.render(
    <div className="page" style={{ paddingTop: "20vh" }}>
      <div className="error">TiVBook is not configured yet. Run <code>npm run setup</code> before building.</div>
    </div>,
  );
} else {
  // Loaded only once configuration exists (Firebase starts on import).
  const Root = lazy(async () => {
    const [{ I18nProvider }, { App }] = await Promise.all([import("@tivbook/client"), import("./App")]);
    return { default: () => <I18nProvider><App /></I18nProvider> };
  });
  root.render(<StrictMode><Suspense fallback={null}><Root /></Suspense></StrictMode>);
}
