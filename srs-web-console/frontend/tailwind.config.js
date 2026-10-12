/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 科技蓝白主题（DEV_PLAN 5.1 色板）
        primary: {
          DEFAULT: '#1677ff',
          50: '#f0f7ff',
          100: '#e6f4ff',
          200: '#bae0ff',
          600: '#0958d9',
          700: '#003eb3',
        },
        success: { DEFAULT: '#10b981', 50: '#ecfdf5', 700: '#047857' },
        warning: '#f59e0b',
        danger: { DEFAULT: '#ef4444', 50: '#fef2f2', 700: '#b91c1c' },
        surface: {
          DEFAULT: '#ffffff',
          page: '#f5f7fa',
          hover: '#f1f5f9',
        },
        line: '#e5e7eb',
        ink: {
          DEFAULT: '#1f2937',
          subtle: '#526175',
          faint: '#64748b',
        },
      },
      fontFamily: {
        sans: ['Inter', '"Segoe UI"', '"PingFang SC"', '"Microsoft YaHei"', '"Noto Sans CJK SC"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        base: '6px',
        card: '8px',
        panel: '12px',
      },
      boxShadow: {
        card: '0 2px 8px rgba(0, 0, 0, 0.06)',
        modal: '0 10px 40px rgba(0, 0, 0, 0.15)',
      },
    },
  },
  plugins: [],
}
