// commands/content.js
import { buildSnapshot } from '../lib/refs.js';

export function register(registerFn) {
  registerFn('text', async (args, ctx) => {
    let limit = 50000;
    const limitIdx = args.indexOf('--limit');
    if (limitIdx !== -1 && args[limitIdx + 1]) {
      limit = parseInt(args[limitIdx + 1], 10);
    }
    let text = await ctx.page.evaluate(() => document.body.innerText);
    if (text.length > limit) {
      text = text.slice(0, limit) + '\n…truncated';
    }
    return text;
  });

  registerFn('html', async (args, ctx) => {
    const selector = args[0];
    if (selector) {
      return await ctx.page.locator(selector).innerHTML();
    }
    return await ctx.page.content();
  });

  registerFn('snapshot', async (args, ctx) => {
    const interactiveOnly = args.includes('-i');
    let selector = null;
    const sIdx = args.indexOf('-s');
    if (sIdx !== -1 && args[sIdx + 1]) {
      selector = args[sIdx + 1];
    }

    const { tree, refMap, refCounter } = await buildSnapshot(ctx.page, { interactiveOnly, selector });
    ctx.setRefMap(refMap, refCounter);
    return tree;
  });

  registerFn('scroll', async (args, ctx) => {
    const target = args[0];
    if (!target || target === 'down') {
      await ctx.page.evaluate(() => window.scrollBy(0, window.innerHeight));
      return 'Scrolled down one viewport';
    }
    if (target === 'up') {
      await ctx.page.evaluate(() => window.scrollBy(0, -window.innerHeight));
      return 'Scrolled up one viewport';
    }
    // Selector — scroll into view
    await ctx.page.locator(target).scrollIntoViewIfNeeded();
    return `Scrolled ${target} into view`;
  });
}
