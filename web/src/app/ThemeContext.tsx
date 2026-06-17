import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// Color theme: light, dark, RN (dark + Rosneft's yellow accent).
// The value is applied on <html data-theme>, color tokens live in index.css.
export type Theme = "light" | "dark" | "rn";

export const THEMES: Theme[] = ["light", "dark", "rn"];
export const THEME_LABELS: Record<Theme, string> = {
  light: "Светлая",
  dark: "Тёмная",
  rn: "РН",
};

const STORAGE_KEY = "idp-theme";

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (t && THEMES.includes(t)) return t;
  } catch {
    /* localStorage unavailable - default to light */
  }
  return "light";
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({
  theme: "light",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = (t: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* no localStorage - theme won't survive a reload, not critical */
    }
    setThemeState(t);
  };

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
