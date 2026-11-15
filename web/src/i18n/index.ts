import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import he from "./he.json";

const saved = (() => {
  try {
    return localStorage.getItem("studio.lang");
  } catch {
    return null;
  }
})();

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, he: { translation: he } },
  lng: saved === "he" ? "he" : "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

/** Hebrew is right-to-left: the whole page flips. */
export function applyDirection(lang: string) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
}
applyDirection(i18n.language);
i18n.on("languageChanged", (lng) => {
  applyDirection(lng);
  try {
    localStorage.setItem("studio.lang", lng);
  } catch {
    /* ignore */
  }
});

export default i18n;
