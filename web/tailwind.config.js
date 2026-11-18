/**
 * Semantic colour tokens (values in src/index.css, light and dark). Components use
 * only these names, never raw hex. Accent = CRE green.
 */
/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;
const names = [
  "canvas", "surface", "surface-sunken", "ink", "ink-muted", "ink-subtle", "line", "line-strong",
  "accent", "accent-hover", "accent-ink", "accent-soft", "highlight",
  "success", "success-soft", "warning", "warning-soft", "danger", "danger-hover", "danger-ink", "danger-soft",
  "info", "info-soft", "ai", "ai-soft",
];
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: Object.fromEntries(names.map((n) => [n, token(n)])),
      borderRadius: { control: "6px", panel: "10px", sheet: "14px" },
      boxShadow: { float: "0 12px 32px -8px rgb(16 22 32 / 0.24), 0 2px 6px rgb(16 22 32 / 0.08)" },
      fontSize: { caption: ["13px", "18px"], body: ["15px", "22px"], title: ["18px", "26px"], heading: ["22px", "30px"] },
    },
  },
  plugins: [],
};
