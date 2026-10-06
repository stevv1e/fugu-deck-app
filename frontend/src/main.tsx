import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ClusterApp from "./cluster/ClusterApp";
import { cp } from "./cp";
import "./styles.css";
import "./themes.css";
import { applyTheme, getTheme } from "./themes";

applyTheme(getTheme());

/** Один клиент на оба режима: если рядом есть control-plane — многопользовательский кластер. */
function Root() {
  const [mode, setMode] = useState<"loading" | "cluster" | "standalone">("loading");
  useEffect(() => {
    cp.detect().then((i) => setMode(i ? "cluster" : "standalone"));
  }, []);
  if (mode === "loading") return null;
  return mode === "cluster" ? <ClusterApp /> : <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
