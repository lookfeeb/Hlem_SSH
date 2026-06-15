import { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import "antd/dist/reset.css";
import "./styles.css";
import App from "./App";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";

const isEditorWindow = new URLSearchParams(window.location.search).has("editorWindow");
const isLogWindow = new URLSearchParams(window.location.search).has("logWindow");
const EditorWindowApp = lazy(() =>
  import("./components/EditorWindowApp").then((module) => ({ default: module.EditorWindowApp })),
);
const LogWindowApp = lazy(() =>
  import("./components/LogWindowApp").then((module) => ({ default: module.LogWindowApp })),
);

function BootFallback() {
  return (
    <div className="bootScreen" role="status" aria-live="polite">
      <img className="bootMark" src="./Helm_icon.svg" alt="" aria-hidden="true" />
      <div>
        <strong>HelM</strong>
        <span>正在启动...</span>
      </div>
    </div>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("HelM root element is missing");

ReactDOM.createRoot(rootElement).render(
  <ErrorBoundary>
    {isLogWindow ? (
      <Suspense fallback={<BootFallback />}>
        <LogWindowApp />
      </Suspense>
    ) : isEditorWindow ? (
      <Suspense fallback={<BootFallback />}>
        <EditorWindowApp />
      </Suspense>
    ) : (
      <App />
    )}
  </ErrorBoundary>,
);
