/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./src/renderer/**/*.{html,js}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Segoe UI Variable Text"',
          '"Segoe UI"',
          'Geist',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'sans-serif'
        ],
        mono: ['"Cascadia Code"', '"JetBrains Mono"', 'Consolas', 'monospace']
      },
      colors: {
        'surface-base': '#0c0d0e',
        'surface': '#121316',
        'surface-raised': '#16181c',
        'surface-card': '#181a1f',
        'surface-dim': '#111215',
        'surface-container': '#1d1f24',
        'surface-container-high': '#23262d',
        'border-subtle': 'rgba(255, 255, 255, 0.07)',
        'border-muted': 'rgba(255, 255, 255, 0.12)',
        'border-hover': 'rgba(255, 255, 255, 0.22)',
        'text-primary': '#f4f4f5',
        'text-secondary': '#a1a1aa',
        'text-tertiary': '#71717a',
        'accent-subtle': 'rgba(52, 211, 153, 0.08)',
        'accent-border': 'rgba(52, 211, 153, 0.25)',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          border: 'hsl(var(--sidebar-border))',
          accent: 'hsl(var(--sidebar-accent))'
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },
        live: {
          DEFAULT: 'hsl(var(--live))',
          foreground: '#ffffff'
        },
        // Obsidian Copilot surfaces. Every value comes from a CSS variable so the
        // same class works in the light and dark themes (see tailwind.input.css).
        app: {
          bg: 'hsl(var(--app-bg))',
          card: 'hsl(var(--app-card))',
          'card-hover': 'hsl(var(--app-card-hover))',
          surface: 'hsl(var(--app-surface))',
          border: 'hsl(var(--app-border))',
          'border-light': 'hsl(var(--app-border-light))',
          muted: 'hsl(var(--app-muted))',
          accent: 'hsl(var(--app-accent))',
          emerald: 'hsl(var(--app-emerald))',
          sidebar: 'hsl(var(--app-sidebar))',
          input: 'hsl(var(--app-input))',
          chip: 'hsl(var(--app-chip))',
          nubank: '#820ad1',
          ifood: '#ea1d2c',
          itau: '#ec7000',
          meli: '#ffe600'
        }
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      boxShadow: {
        shadcn: '0 1px 2px 0 rgba(0, 0, 0, 0.04), 0 1px 3px 0 rgba(0, 0, 0, 0.03)',
        'shadcn-md': '0 4px 12px -2px rgba(0, 0, 0, 0.06), 0 2px 4px -2px rgba(0, 0, 0, 0.04)'
      }
    }
  },
  plugins: []
};

