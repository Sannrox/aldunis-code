import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "markdown-vendor",
              test: /node_modules[\\/](?:react-markdown|remark-gfm)[\\/]/,
            },
            {
              name: "base-ui-vendor",
              test: /node_modules[\\/]@base-ui[\\/]react[\\/]/,
            },
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
