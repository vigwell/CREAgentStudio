/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: "#4caf50", strong: "#2e7d32", soft: "#e8f5e9", lime: "#A4C639" },
      },
    },
  },
  plugins: [],
};
