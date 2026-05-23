/**
 * NiftyVid proxy Worker.
 *
 * What it does:
 *   1. Receives a POST from the browser with a multipart form (image + JSON params).
 *   2. Uploads the image to the upstream Gradio Space's /gradio_api/upload endpoint.
 *   3. Calls /gradio_api/call/generate_video to queue a job and get an event_id.
 *   4. Opens the SSE event stream for that event_id, reads events until the job
 *      finishes ("complete") or errors out.
 *   5. Returns a JSON response with the absolute video URL on success.
 *
 * Why we need this:
 *   - HF Spaces don't reliably allow cross-origin requests from arbitrary domains,
 *     so the browser can't talk to them directly from GitHub Pages.
 *   - Even if CORS worked, putting the upstream URL in the static bundle would
 *     bake it in. With a Worker we control the endpoint and can swap backends
 *     (e.g. point at fal.ai later) by deploying the Worker, not the whole site.
 *   - We get one tidy place to set timeouts, retries, and origin allowlists.
 *
 * Design notes:
 *   - This is a single synchronous request: the browser sends one POST and waits
 *     for the video URL. Workers have a free-tier wall-clock budget that can be
 *     tight for very long video generations. If we ever need 90s+ generations,
 *     swap to a streaming response (Worker pipes the upstream SSE through to
 *     the browser) so the connection stays alive without accumulating CPU time.
 */

// Worker env vars come from wrangler.toml [vars]. Marked `readonly` since
// they're injected at deploy time, not mutated at runtime.
export interface Env {
  readonly ALLOWED_ORIGINS: string;
  readonly HF_SPACE_BASE: string;
  readonly HF_FN_NAME: string;
}

// Default negative prompt lifted from the upstream Space's app.py. Keeping it
// here means callers don't have to pass it on every request, and the model
// still gets the guidance it expects.
const DEFAULT_NEGATIVE_PROMPT =
  "色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 静止, 整体发灰, " +
  "最差质量, 低质量, JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, 画得不好的手部, " +
  "画得不好的脸部, 畸形的, 毁容的, 形态畸形的肢体, 手指融合, 静止不动的画面, " +
  "杂乱的背景, 三条腿, 背景人很多, 倒着走";

// User-tunable params with defaults. Anything not in this list is locked to
// what we think gives the best balance of speed and quality on a free Space.
interface UserParams {
  prompt?: string;
  duration_seconds?: number;
  steps?: number;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") ?? "";

    // CORS preflight. Any browser POST with a Content-Type other than the
    // three "simple" ones triggers a preflight, so we MUST answer this.
    if (req.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), origin, env);
    }

    if (req.method === "POST" && url.pathname === "/generate") {
      try {
        const result = await handleGenerate(req, env);
        return withCors(result, origin, env);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return withCors(jsonResponse({ error: msg }, 500), origin, env);
      }
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return withCors(jsonResponse({ ok: true }), origin, env);
    }

    return withCors(jsonResponse({ error: "Not found" }, 404), origin, env);
  },
} satisfies ExportedHandler<Env>;

/**
 * Core flow: upload image, submit job, then stream the upstream SSE through
 * to the browser. Worker does the fast bits (upload, submit) and then steps
 * out of the way for the slow bit (waiting for the video).
 *
 * Why streaming instead of holding the request: Cloudflare Workers count
 * wall-clock time when the Worker reads from a fetch response. For long
 * generations (5s+ video) that pushed us over the limit. By returning the
 * upstream body as our response body, Cloudflare just pipes bytes between
 * the upstream and the browser, no CPU charged to us, no timeout we can hit.
 * The browser then parses SSE events and finds the "complete" event to grab
 * the video URL.
 */
async function handleGenerate(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const image = form.get("image");
  const paramsRaw = form.get("params");

  if (!(image instanceof File)) {
    return jsonResponse({ error: "Missing 'image' form field" }, 400);
  }
  if (image.size > 8 * 1024 * 1024) {
    return jsonResponse({ error: "Image must be 8 MB or smaller" }, 413);
  }

  const userParams: UserParams =
    typeof paramsRaw === "string" ? safeJsonParse(paramsRaw) : {};

  // Fast steps. Each is a single short HTTP call, well under any limit.
  const imageRef = await uploadImageToSpace(image, env);
  const eventId = await submitJob(imageRef, image.name, userParams, env);

  // Open the SSE stream upstream. Don't consume the body — we hand it
  // straight to the browser.
  const upstream = await fetch(
    `${env.HF_SPACE_BASE}/gradio_api/call/${env.HF_FN_NAME}/${eventId}`,
    { method: "GET", headers: { Accept: "text/event-stream" } },
  );
  if (!upstream.ok || !upstream.body) {
    throw new Error(`Could not open result stream (${upstream.status}).`);
  }

  // Return the upstream body directly. Cloudflare will pipe it. We add the
  // right headers so EventSource-style readers Just Work, and we disable
  // proxy/CDN buffering so events arrive promptly.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Upload step. The Gradio /upload endpoint accepts multipart form data with
 * one or more files under the field name "files" and returns an array of
 * server-side paths like ["/tmp/gradio/abc.../filename.png"].
 *
 * We need that path in the next step because Gradio's /call endpoint expects
 * a "FileData" reference, not raw bytes.
 */
async function uploadImageToSpace(file: File, env: Env): Promise<string> {
  const fd = new FormData();
  fd.append("files", file, file.name || "input.png");

  const res = await fetch(`${env.HF_SPACE_BASE}/gradio_api/upload`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) {
    throw new Error(`Image upload failed (${res.status}). The Space may be sleeping or rate-limited.`);
  }
  const paths = (await res.json()) as string[];
  if (!Array.isArray(paths) || !paths[0]) {
    throw new Error("Upload returned an unexpected response shape.");
  }
  return paths[0];
}

/**
 * Submit the generation job. The data array must match the order of
 * `ui_inputs` in the Space's app.py. If the upstream Space ever reorders
 * its inputs, this list is the one place to fix.
 *
 * Sticking values into a named array first (rather than passing an object)
 * makes the order explicit and easy to audit against the upstream source.
 */
async function submitJob(
  imagePath: string,
  origName: string,
  params: UserParams,
  env: Env,
): Promise<string> {
  // FileData shape Gradio v4 expects when a path was returned by /upload.
  const inputImage = {
    path: imagePath,
    url: `${env.HF_SPACE_BASE}/gradio_api/file=${imagePath}`,
    orig_name: origName,
    size: null,
    mime_type: null,
    meta: { _type: "gradio.FileData" },
  };

  // Order matches Space's ui_inputs:
  // [input_image, last_image, prompt, steps, negative_prompt,
  //  duration_seconds, guidance_scale, guidance_scale_2, seed, randomize_seed,
  //  quality, scheduler, flow_shift, frame_multiplier, safe_mode, play_result_video]
  const data = [
    inputImage,
    null, // last_image, optional second keyframe, we don't expose this in the UI
    params.prompt?.trim() || "make this image come alive, cinematic motion, smooth animation",
    clampInt(params.steps ?? 6, 1, 12),
    DEFAULT_NEGATIVE_PROMPT,
    clampFloat(params.duration_seconds ?? 3.5, 0.5, 10),
    1,    // guidance_scale (kept at 1, higher values double GPU usage for marginal gains here)
    1,    // guidance_scale_2
    42,   // seed (ignored when randomize_seed=true)
    true, // randomize_seed
    6,    // quality
    "UniPCMultistep",
    3.0,  // flow_shift
    16,   // frame_multiplier (16 = no interpolation, the model's native FPS)
    false, // safe_mode
    true,  // play_result_video
  ];

  const res = await fetch(`${env.HF_SPACE_BASE}/gradio_api/call/${env.HF_FN_NAME}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) {
    throw new Error(`Job submission failed (${res.status}).`);
  }
  const body = (await res.json()) as { event_id?: string };
  if (!body.event_id) {
    throw new Error("Job submission returned no event_id.");
  }
  return body.event_id;
}

// SSE parsing and video-URL extraction used to live here, but they moved to
// the browser when we switched to streaming pass-through. Now the Worker just
// uploads, submits, and pipes; the browser does the SSE event parsing and
// finds the "complete" payload itself.

// ---------- Generic helpers ----------

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}
function clampFloat(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Attach CORS headers. We allow a configured set of origins via the
 * ALLOWED_ORIGINS env var (comma-separated). In production this should be
 * just the GitHub Pages URL; in dev it includes localhost.
 *
 * Echoing the request's Origin back (rather than a wildcard) lets the browser
 * send credentials if we ever need that, and keeps us off "tricked into being
 * an open proxy" Status Hacker News posts.
 */
function withCors(res: Response, origin: string, env: Env): Response {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  const headers = new Headers(res.headers);
  if (origin && allowed.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
