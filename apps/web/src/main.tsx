import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { DRAFT_KEY, HowItWorks } from "./components/how-it-works";
import "./index.css";

const HOW_IT_WORKS = "#how-it-works";

/** Hash router: `#how-it-works` shows the guided demo, anything else is the workspace. */
function Root() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (hash === HOW_IT_WORKS) {
    return (
      <HowItWorks
        onTry={(prompt) => {
          try {
            sessionStorage.setItem(DRAFT_KEY, prompt);
          } catch {
            /* storage unavailable: the workspace just opens empty */
          }
          window.location.hash = "";
        }}
      />
    );
  }
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
