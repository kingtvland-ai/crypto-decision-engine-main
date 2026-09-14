import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: "/",
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    mode === 'development' &&
    componentTagger(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // `e2e/` uses Playwright's own `test`/`expect` (run via `npm run test:e2e`,
    // playwright.config.ts) — without this, vitest's default include glob
    // (`**/*.spec.ts`) picks those files up too and fails them immediately,
    // since they don't import from vitest.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
}));
