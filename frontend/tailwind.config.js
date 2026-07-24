/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "none" },
        },
      },
      animation: {
        fadeIn: "fadeIn 0.25s ease",
      },
    },
  },
  plugins: [],
};