/*
 * Apply the theme the person chose in the dashboard before the page paints.
 *
 * A classic (blocking) script on purpose: the page's Content Security Policy
 * forbids inline script, and a deferred module would let a light-theme user
 * see one dark frame first. It shares the dashboard's `jobagent-theme` key, so
 * the two pages always agree. With no saved choice the stylesheet follows the
 * operating system.
 */
(() => {
  try {
    const saved = localStorage.getItem('jobagent-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch { /* storage unavailable: follow the operating system */ }
})();
