/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/chat.html", "./src/notes.html"],
  theme: { extend: {} },
  plugins: [require("daisyui")],
  daisyui: {
    // 既存のダークパレットに合わせた専用テーマ（アクセントの青 #5b8cff を primary に）
    themes: [
      {
        aichat: {
          "primary": "#5b8cff",
          "primary-content": "#ffffff",
          "secondary": "#7c5cff",
          "secondary-content": "#ffffff",
          "accent": "#4ade80",
          "accent-content": "#0f1117",
          "neutral": "#1a1d27",
          "neutral-content": "#e6e8ee",
          "base-100": "#0f1117",
          "base-200": "#161922",
          "base-300": "#1a1d27",
          "base-content": "#e6e8ee",
          "info": "#5b8cff",
          "success": "#4ade80",
          "warning": "#fbbf24",
          "error": "#f87171",
          "--rounded-box": "0.9rem",
          "--rounded-btn": "0.55rem",
          "--rounded-badge": "0.5rem",
          "--border-btn": "1px",
          "--tab-radius": "0.5rem",
        },
      },
    ],
    logs: false,
  },
};
