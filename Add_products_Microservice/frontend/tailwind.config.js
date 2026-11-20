/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          light: '#283593',
          DEFAULT: '#1a237e',
        }
      }
    },
  },
  plugins: [],
}
