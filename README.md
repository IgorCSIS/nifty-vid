# NiftyVid

Image-to-video generator. Drop in a photo, write a prompt, get back a short video clip animated with Wan 2.2.

Part of the [NiftyAi](https://github.com/IgorCSIS/niftyai-portfolio) project family.

## How it works

NiftyVid is two pieces glued together:

1. **`web/`**, a static Astro + Tailwind site that lives on GitHub Pages. It's the UI: dropzone, prompt input, video preview.
2. **`worker/`**, a Cloudflare Worker that takes requests from the site and forwards them to a public Hugging Face Space running the Wan 2.2 image-to-video model.

We need the Worker as a middleman for two reasons. First, browsers can't usually call HF Spaces directly because of CORS. Second, the Worker is a stable URL we control, which means if the upstream Space ever moves or breaks, we only swap one file instead of redeploying the whole site.

```
[ browser ]  →  [ Cloudflare Worker ]  →  [ HF Space: Wan 2.2 ]
                  (free tier, ours)         (free, public)
```

## Inference backend

Currently pointed at the public Space `cbensimon/wan2-2-fp8da-aoti-preview2`. This is free but shared, so queues can be slow during peak hours and the upstream owner could change or remove it at any time. If that happens, point the Worker at any other public Wan 2.2 Space (search HF for `WanImageToVideoPipeline`).

If you ever want a paid, faster, more reliable backend, swap the Worker's fetch logic to hit fal.ai or Replicate. The frontend doesn't need to change.

## Local development

You need [pnpm](https://pnpm.io/) and a recent Node (20+).

```powershell
# Frontend dev server (http://localhost:4321)
cd web
pnpm install
pnpm dev

# Worker dev server (http://localhost:8787)
cd worker
pnpm install
pnpm dev
```

The frontend reads `PUBLIC_WORKER_URL` to know where to send requests. In dev that's `http://localhost:8787`. Set it in `web/.env`:

```
PUBLIC_WORKER_URL=http://localhost:8787
```

## Deploy

The frontend deploys automatically to GitHub Pages on push to `main` via `.github/workflows/deploy.yml`.

The Worker is deployed manually (one-time setup, then it just lives there):

```powershell
cd worker
pnpm wrangler login          # opens browser, signs into Cloudflare
pnpm wrangler deploy
```

Cloudflare gives you a URL like `nifty-vid.<your-subdomain>.workers.dev`. Update `PUBLIC_WORKER_URL` in the GitHub Pages deploy step (or `web/.env.production`) to that URL.

## Why the model isn't running on GitHub Pages

Wan 2.2 is a 14B-parameter video diffusion model. It needs a GPU and several gigabytes of VRAM. GitHub Pages serves static files only, so the inference has to happen somewhere else. That somewhere is the public HF Space, running on Hugging Face's free ZeroGPU pool.
