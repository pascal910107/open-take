/**
 * Dark / light. The theme is a stored choice, not an OS media query — the
 * inline script in each page's <head> has already applied it before first
 * paint, so all this does is wire the button and keep anything that renders
 * its own colours (the WebGL stage) in step.
 */
export function initTheme(sync?: (light: boolean) => void): void {
  const btn = document.getElementById("theme-btn");

  const apply = (light: boolean): void => {
    if (light) document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    btn?.setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
    sync?.(light);
    try {
      localStorage.setItem("ot-theme", light ? "light" : "dark");
    } catch {
      /* private mode — the theme just won't persist */
    }
  };

  btn?.addEventListener("click", () => {
    apply(document.documentElement.dataset.theme !== "light");
  });

  if (document.documentElement.dataset.theme === "light") {
    btn?.setAttribute("aria-label", "Switch to dark theme");
    sync?.(true);
  }
}
