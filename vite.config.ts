import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "markdown-vendor": ["react-markdown", "remark-gfm"],
          "base-ui-vendor": [
            "@base-ui/react/dialog",
            "@base-ui/react/popover",
            "@base-ui/react/select",
            "@base-ui/react/tooltip",
          ],
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:4175",
    },
  },
});
