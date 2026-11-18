import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

/**
 * Dev server on https://localhost:3000: the redirect URI already registered for
 * CRE's Entra app (same sign-in as CRE). /api is proxied to the Studio API, so
 * the browser talks to one origin (no CORS), as in production.
 */
export default defineConfig({
  plugins: [react(), basicSsl()],
  // One React for the app and the test libraries (npm can hoist another copy).
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") },
    },
  },
  // Libraries change rarely: separate files stay cached across app updates.
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          msal: ["@azure/msal-browser"],
          i18n: ["i18next", "react-i18next"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
} as never);
