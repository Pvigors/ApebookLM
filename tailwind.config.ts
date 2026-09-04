import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  // Dark mode driven by [data-theme="dark"] on <html> (set pre-paint in layout).
  // Tokens below resolve to CSS channel vars that flip in that selector, so most
  // of the UI follows automatically; this also enables targeted `dark:` overrides.
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Semantic tokens → CSS channel vars (see app/globals.css :root). The
        // `rgb(var(--x) / <alpha-value>)` form keeps opacity modifiers working
        // (bg-panel2/50, border-accent/40, …) and flips automatically in dark.
        canvas: "rgb(var(--c-canvas) / <alpha-value>)", // app background
        panel: "rgb(var(--c-panel) / <alpha-value>)", // primary surface (cards, panels)
        panel2: "rgb(var(--c-panel2) / <alpha-value>)", // secondary surface / hover fill
        edge: "rgb(var(--c-edge) / <alpha-value>)", // hairline border
        accent: "rgb(var(--c-accent) / <alpha-value>)", // brand lavender
        accentSoft: "rgb(var(--c-accentSoft) / <alpha-value>)", // lavender tint (selected chips)
        onAccent: "rgb(var(--c-onAccent) / <alpha-value>)", // text/icons on lavender
        solid: "rgb(var(--c-solid) / <alpha-value>)", // primary "black" buttons (inverts in dark)
        onSolid: "rgb(var(--c-onSolid) / <alpha-value>)", // text/icons on solid buttons
        ink: "rgb(var(--c-ink) / <alpha-value>)", // primary text
        ink2: "rgb(var(--c-ink2) / <alpha-value>)", // secondary text
        muted: "rgb(var(--c-muted) / <alpha-value>)", // tertiary / placeholder text
        // Studio artifact accent hues — deeper so they read on light tints
        art: {
          audio: "#5466d8", // periwinkle/indigo
          video: "#d6568f", // pink
          mindmap: "#2aa178", // green
          report: "#cf7a36", // orange
          cards: "#7d5fd8", // lavender
          quiz: "#d6564e", // coral/red
          info: "#2f9bbc", // sky
          slides: "#c7912f", // amber
          table: "#5b76b7", // steel blue
          board: "#a94eb8", // orchid — 画板(与思维导图的绿明显区分,避开 sky/steel/lavender)
        },
      },
      keyframes: {
        floaty: {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-4px)" },
        },
        auroraShift: {
          "0%,100%": { transform: "translate3d(0,0,0) scale(1)" },
          "50%": { transform: "translate3d(2%, -2%, 0) scale(1.08)" },
        },
      },
      animation: {
        floaty: "floaty 6s ease-in-out infinite",
        aurora: "auroraShift 18s ease-in-out infinite",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
