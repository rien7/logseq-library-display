import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: "src/main.ts",
      formats: ["iife"],
      name: "LogseqLibraryDisplay",
      fileName: () => "index.js",
    },
    target: "esnext",
    minify: "esbuild",
  },
});
