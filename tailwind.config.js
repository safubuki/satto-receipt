/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Manrope"', 'system-ui', 'sans-serif'],
        body: ['"Inter Tight"', 'system-ui', 'sans-serif'],
      },
      colors: {
        ink: '#0f172a',
        fog: '#0b1224',
        mint: '#3de0a2',
        sand: '#f7f2e8',
      },
      boxShadow: {
        soft: '0 15px 60px rgba(15, 23, 42, 0.25)',
      },
    },
  },
  plugins: [],
}
