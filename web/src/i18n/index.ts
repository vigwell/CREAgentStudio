import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import fr from "./fr.json";
import he from "./he.json";
import ar from "./ar.json";
import es from "./es.json";

/** Same UI languages, order and labels as the CRE Report Engine (constants/languages.js). */
export const UI_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "fr", label: "French" },
  { value: "he", label: "Hebrew" },
  { value: "ar", label: "Arabic" },
  { value: "es", label: "Spanish" },
] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number]["value"];
const CODES = UI_LANGUAGES.map((l) => l.value) as string[];
const RTL = new Set(["he", "ar"]);
const KEY = "studio.lang";

const saved = (() => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
})();

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr }, he: { translation: he }, ar: { translation: ar }, es: { translation: es } },
  lng: saved && CODES.includes(saved) ? saved : "en",
  supportedLngs: CODES,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

/** Hebrew and Arabic are right-to-left: the whole page flips. */
export function applyDirection(lang: string) {
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? "rtl" : "ltr";
}
applyDirection(i18n.language);
i18n.on("languageChanged", (lng) => {
  applyDirection(lng);
  try {
    localStorage.setItem(KEY, lng);
  } catch {
    /* ignore */
  }
});

export default i18n;
