/**
 * studio.ts, client-side wiring for the NiftyVid generator.
 *
 * Lifecycle:
 *   1. User drops or picks an image. We preview it and stash the File object.
 *   2. User types a prompt and tweaks duration/steps (optional).
 *   3. User clicks "Generate". We POST the image + prompt to our Worker.
 *   4. Worker returns a job id. We poll until status is "done", then show video.
 *
 * The Worker handles all the messy parts: uploading the image to the HF Space,
 * calling the Gradio API, polling the SSE event stream, and giving us back a
 * playable URL. From here the contract is clean JSON in, clean JSON out.
 *
 * Why no framework: this is one form with about five interactive elements.
 * A vanilla module is faster to load, easier to read, and forces us to
 * understand each DOM update instead of letting React paper over the details.
 */

// Type-safe handle on the Worker URL injected at build time via import.meta.env.
// Falls back to localhost so `pnpm dev` works without a .env file.
const WORKER_URL = import.meta.env.PUBLIC_WORKER_URL || "http://localhost:8787";

// ---------- DOM lookup helpers ----------

// querySelector with non-null assertion, every selector below is in our own
// HTML, so a missing element is a bug, not a runtime case we need to handle.
// Throwing early is more helpful than a silent null.
const $ = <T extends Element>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};

const dropzone     = $<HTMLLabelElement>("[data-dropzone]");
const fileInput    = $<HTMLInputElement>("[data-file-input]");
const dropEmpty    = $<HTMLDivElement>("[data-dropzone-empty]");
const dropPreview  = $<HTMLImageElement>("[data-dropzone-preview]");
const promptEl     = $<HTMLTextAreaElement>("[data-prompt]");
const durationEl   = $<HTMLInputElement>("[data-duration]");
const durationVal  = $<HTMLSpanElement>("[data-duration-value]");
const stepsEl      = $<HTMLInputElement>("[data-steps]");
const stepsVal     = $<HTMLSpanElement>("[data-steps-value]");
const generateBtn  = $<HTMLButtonElement>("[data-generate]");
const buttonLabel  = $<HTMLSpanElement>("[data-button-label]");
const spinnerEl    = $<HTMLSpanElement>("[data-spinner]");
const statusEl     = $<HTMLParagraphElement>("[data-status]");
const resultEmpty  = $<HTMLDivElement>("[data-result-empty]");
const resultLoad   = $<HTMLDivElement>("[data-result-loading]");
const loadingMsg   = $<HTMLParagraphElement>("[data-loading-message]");
const resultVideo  = $<HTMLVideoElement>("[data-result-video]");
const downloadLink = $<HTMLAnchorElement>("[data-download]");
const historyWrap  = $<HTMLDivElement>("[data-history-wrap]");
const historyList  = $<HTMLUListElement>("[data-history]");

// ---------- Local state ----------

// Kept in a tiny mutable object so handlers can read/write it without
// chasing globals. For one screen this is fine, a state machine would
// be overkill.
const state = {
  file: null as File | null,
  busy: false,
};

// ---------- File handling ----------

/**
 * Accept a File, validate it, and update the preview.
 * Rejecting early with a status message is friendlier than letting a bad
 * file reach the Worker and bouncing back as an opaque error.
 */
function acceptFile(file: File) {
  const MAX_BYTES = 8 * 1024 * 1024; // 8 MB. HF Spaces choke on much larger uploads.
  if (!file.type.startsWith("image/")) {
    setStatus("That doesn't look like an image. PNG, JPG, or WEBP please.", "error");
    return;
  }
  if (file.size > MAX_BYTES) {
    setStatus("Image is over 8 MB. Try compressing it.", "error");
    return;
  }

  state.file = file;

  // Show a preview by reading the file as a data URL.
  // URL.createObjectURL would be marginally faster, but a data URL means we
  // don't have to remember to revokeObjectURL later.
  const reader = new FileReader();
  reader.onload = () => {
    dropPreview.src = reader.result as string;
    dropPreview.classList.remove("hidden");
    dropEmpty.classList.add("hidden");
  };
  reader.readAsDataURL(file);

  refreshGenerateButton();
  setStatus("Ready. Write a prompt and click generate.");
}

// Click-to-browse (handled by the <input> being inside the <label>) just needs
// us to listen to the file input's change event.
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) acceptFile(f);
});

// Drag-and-drop. We prevent the default on dragover so the browser doesn't
// open the image in a new tab when dropped.
["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.setAttribute("data-active", "true");
  }),
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, () => dropzone.setAttribute("data-active", "false")),
);
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) acceptFile(f);
});

// Paste an image from the clipboard. Nice ergonomic win on Windows where you
// can hit Shift+Win+S and paste straight in.
window.addEventListener("paste", (e: ClipboardEvent) => {
  const f = e.clipboardData?.files?.[0];
  if (f) acceptFile(f);
});

// ---------- Slider value display ----------

// Wire the duration/steps sliders to their numeric readouts. Simple input
// listeners, but defined as a helper so we don't repeat ourselves.
function bindRange(input: HTMLInputElement, display: HTMLSpanElement, suffix = "") {
  const sync = () => (display.textContent = input.value + suffix);
  input.addEventListener("input", sync);
  sync();
}
bindRange(durationEl, durationVal, "s");
bindRange(stepsEl, stepsVal);

promptEl.addEventListener("input", refreshGenerateButton);

// ---------- UI state helpers ----------

function refreshGenerateButton() {
  const ready = !!state.file && promptEl.value.trim().length > 0 && !state.busy;
  generateBtn.disabled = !ready;
}

type StatusTone = "info" | "error" | "success";
function setStatus(text: string, tone: StatusTone = "info") {
  statusEl.textContent = text;
  statusEl.classList.remove("text-rose-400", "text-mint-glow", "text-slate-500");
  statusEl.classList.add(
    tone === "error" ? "text-rose-400" : tone === "success" ? "text-mint-glow" : "text-slate-500",
  );
}

function setBusy(busy: boolean) {
  state.busy = busy;
  spinnerEl.classList.toggle("hidden", !busy);
  buttonLabel.textContent = busy ? "Generating..." : "Generate video";
  refreshGenerateButton();
}

function showResultState(s: "empty" | "loading" | "ready") {
  resultEmpty.classList.toggle("hidden", s !== "empty");
  resultLoad.classList.toggle("hidden", s !== "loading");
  resultVideo.classList.toggle("hidden", s !== "ready");
  downloadLink.classList.toggle("hidden", s !== "ready");
}

// ---------- Generate flow ----------

generateBtn.addEventListener("click", async () => {
  if (!state.file) return;

  setBusy(true);
  showResultState("loading");
  setStatus("Submitting job to the GPU pool. This may take a minute or two.");

  // Rotate friendly loading messages on a timer. We don't get real-time
  // progress from the upstream Space in this design, so this is mostly a
  // "we're still alive" signal for the user. Two minutes of "Loading..."
  // feels broken; rotating text feels intentional.
  const stopMessages = startLoadingMessages();

  try {
    // Build the multipart payload. We send the raw file plus JSON params as
    // a single string field. The Worker parses both.
    const form = new FormData();
    form.append("image", state.file);
    form.append(
      "params",
      JSON.stringify({
        prompt: promptEl.value.trim(),
        duration_seconds: parseFloat(durationEl.value),
        steps: parseInt(stepsEl.value, 10),
      }),
    );

    // One shot. The Worker holds this connection open while the upstream
    // Space queues, runs, and finishes. When the response lands, we have
    // a playable URL. If the Worker times out, we'll catch it below and
    // surface a sensible retry suggestion.
    const res = await fetch(`${WORKER_URL}/generate`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      throw new Error(await readErrorMessage(res));
    }
    const { video_url } = (await res.json()) as { video_url: string };

    // Success.
    resultVideo.src = video_url;
    downloadLink.href = video_url;
    downloadLink.setAttribute("download", `nifty-vid-${Date.now()}.mp4`);
    showResultState("ready");
    setStatus("Done. Saved a thumb in history below.", "success");
    addToHistory(video_url);
  } catch (err) {
    // Surface the upstream message verbatim, for a single-purpose tool, the
    // actual failure ("queue full", "Space sleeping", "image too large") is
    // far more useful than a generic "something went wrong".
    const msg = err instanceof Error ? err.message : String(err);
    setStatus(`Failed: ${msg}. You can try again, long generations sometimes time out.`, "error");
    showResultState("empty");
  } finally {
    stopMessages();
    setBusy(false);
  }
});

/**
 * Rotate the loading message every few seconds so the UI doesn't look frozen.
 * Returns a stop() function that cancels the rotation, used in the finally
 * block above to clean up no matter what.
 */
function startLoadingMessages(): () => void {
  const messages = [
    "Uploading image...",
    "Waiting in the GPU queue...",
    "Warming up Wan 2.2 weights...",
    "Diffusing frames...",
    "Stitching the video together...",
    "Almost there. First runs can take a minute or two...",
  ];
  let i = 0;
  loadingMsg.textContent = messages[0]!;
  const handle = window.setInterval(() => {
    i = Math.min(i + 1, messages.length - 1);
    loadingMsg.textContent = messages[i]!;
  }, 8000);
  return () => window.clearInterval(handle);
}

/**
 * Read an error message from a Response. The Worker sends `{error: string}`
 * but if something deeper barfs (CORS, gateway, network), we'll just get text.
 * Either way, return something printable.
 */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.clone().json();
    if (body && typeof body.error === "string") return body.error;
  } catch {
    /* fallthrough */
  }
  const text = await res.text().catch(() => "");
  return text || `${res.status} ${res.statusText}`;
}

// ---------- History ----------

function addToHistory(url: string) {
  historyWrap.classList.remove("hidden");
  const li = document.createElement("li");
  li.className =
    "shrink-0 rounded-md border border-ink-700 overflow-hidden cursor-pointer hover:border-mint-dim transition";
  const v = document.createElement("video");
  v.src = url;
  v.muted = true;
  v.loop = true;
  v.playsInline = true;
  v.className = "w-32 h-20 object-cover";
  // Show a frame on hover. Cheap UX win, no thumbnailing required.
  li.addEventListener("mouseenter", () => v.play().catch(() => {}));
  li.addEventListener("mouseleave", () => {
    v.pause();
    v.currentTime = 0;
  });
  // Click to bring it back into the main result slot.
  li.addEventListener("click", () => {
    resultVideo.src = url;
    downloadLink.href = url;
    showResultState("ready");
  });
  li.appendChild(v);
  historyList.prepend(li);
}

// Initial UI state
showResultState("empty");
refreshGenerateButton();
