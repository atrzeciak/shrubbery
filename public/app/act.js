import { t } from "./i18n.js";

// Run a change, say it worked and redraw; on failure say why and leave the screen as it is.
export const act = (ctx, redraw) => async (fn, done = t("done")) => {
  try { await fn(); ctx.toast(done); await redraw(); } catch (e) { ctx.toast(ctx.errorText(e), "error"); }
};
