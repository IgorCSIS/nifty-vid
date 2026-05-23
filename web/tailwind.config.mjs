/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}"],
  theme: {
    extend: {
      // Brand palette matches the NiftyAi family: slate-950 base with a single
      // emerald accent. Keeping this consistent across nifty-vid, niftystats,
      // and niftyai-portfolio so they feel like one product line.
      colors: {
        ink: {
          900: "#020617", // near-black background
          800: "#0b1220", // panels
          700: "#111827", // hover / borders
        },
        mint: {
          // emerald-500 family, our one accent
          DEFAULT: "#10b981",
          dim: "#059669",
          glow: "#34d399",
        },
      },
      fontFamily: {
        // System stack first for speed, then a clean geometric fallback.
        // Matches niftyai-portfolio's font choice.
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Inter",
          "system-ui",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        // Subtle mint glow used on the generate button and active states.
        glow: "0 0 0 1px rgba(16, 185, 129, 0.4), 0 0 24px -4px rgba(16, 185, 129, 0.35)",
      },
    },
  },
  plugins: [],
};
