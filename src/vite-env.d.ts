/// <reference types="vite/client" />

interface Window {
  aldunisDesktop?: {
    chooseDirectory: () => Promise<string | null>;
  };
}
