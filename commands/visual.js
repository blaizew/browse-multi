// commands/visual.js
import { defaultScreenshotPath } from '../lib/instance.js';

export function register(registerFn) {
  registerFn('screenshot', async (args, ctx) => {
    const path = args[0] || defaultScreenshotPath(ctx.NAME);
    await ctx.page.screenshot({ path, fullPage: false });
    return path;
  });
}
