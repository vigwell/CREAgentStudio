import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./fonts";
import "./index.css";
import "./i18n";
import { App } from "./App";
import { TopProgress } from "./ui/TopProgress";
import { accessToken, initAuth } from "./auth/msal";
import { setTokenProvider } from "./api/client";
import { applyTheme, storedTheme } from "./ui/theme";

applyTheme(storedTheme());

setTokenProvider(accessToken);

void initAuth().then((account) => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <TopProgress />
      <BrowserRouter>
        <App initialAccount={account?.username ?? null} />
      </BrowserRouter>
    </React.StrictMode>,
  );
});
