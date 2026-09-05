import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" makes the build use relative asset paths, so it works
// whether the site is served from a custom domain, a GitHub Pages
// user/org root (username.github.io), or a project page
// (username.github.io/repo-name) — no repo-specific config needed.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
