import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";

// GitHub Pages serves project sites under a subpath like `https://igorcsis.github.io/nifty-vid/`.
// Astro needs to know that subpath so it can prepend it to every internal link and asset URL.
// In local dev we want the root path so things work at `http://localhost:4321/`.
const isProd = process.env.NODE_ENV === "production";

export default defineConfig({
  site: "https://igorcsis.github.io",
  base: isProd ? "/nifty-vid" : "/",
  integrations: [tailwind({
    // We use Tailwind's @tailwind directives inside our own CSS file rather than
    // letting the integration inject a default stylesheet. That gives us control
    // over the order custom CSS and Tailwind utilities are loaded in.
    applyBaseStyles: false,
  })],
});
