import { defineConfig } from "vite";

// Config Vite minimale, adaptée aux conventions Tauri :
// - port fixe (doit correspondre à "devUrl" dans src-tauri/tauri.conf.json)
// - ne pas vider dist en cours de build Tauri (clearScreen: false)
// - base relative ("./") : le même build "dist" fonctionne à la fois
//   servi par Tauri et déployé sur GitHub Pages sous un sous-chemin
//   (https://<user>.github.io/<repo>/), sans configuration spécifique.
export default defineConfig({
  base: "./",
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
  },
});
