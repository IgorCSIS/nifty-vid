/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

// Type-safety for the env vars we use on the client.
// Anything prefixed with PUBLIC_ is exposed to the browser; everything else
// stays server-only. We only need PUBLIC_WORKER_URL for this project.
interface ImportMetaEnv {
  readonly PUBLIC_WORKER_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
