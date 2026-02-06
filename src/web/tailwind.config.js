/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/web/public/index.html',
    './src/web/public/app.js',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        spellbook: {
          bg: '#0a0a0f',
          card: '#14141f',
          border: '#1f1f2e',
          accent: '#00ff88',
          text: '#e0e0e0',
          muted: '#666680',
        }
      },
      fontFamily: {
        mono: ['Space Mono', 'Menlo', 'Monaco', 'monospace'],
      }
    }
  }
}
