import { defineConfig } from "vite";

// Config Vite minimale, adaptée aux conventions Tauri :
// - port fixe (doit correspondre à "devUrl" dans src-tauri/tauri.conf.json)
// - ne pas vider dist en cours de build Tauri (clearScreen: false)
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
  },
});
