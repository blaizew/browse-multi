// commands/interaction.js
import { resolveSelector } from '../lib/refs.js';

export function register(registerFn) {
  registerFn('click', async (args, ctx) => {
    const target = args[0];
    if (!target) throw new Error('Usage: click <selector|@ref>');
    const selector = resolveSelector(target, ctx.refMap);
    await ctx.page.locator(selector).click();
    return `Clicked ${target}`;
  });

  registerFn('fill', async (args, ctx) => {
    const target = args[0];
    const value = args.slice(1).join(' ');
    if (!target || !value) throw new Error('Usage: fill <selector|@ref> <value>');
    const selector = resolveSelector(target, ctx.refMap);
    await ctx.page.locator(selector).fill(value);
    return `Filled ${target} with "${value}"`;
  });

  registerFn('type', async (args, ctx) => {
    const text = args.join(' ');
    if (!text) throw new Error('Usage: type <text>');
    await ctx.page.keyboard.type(text);
    return `Typed "${text}"`;
  });

  registerFn('press', async (args, ctx) => {
    const key = args[0];
    if (!key) throw new Error('Usage: press <key>');
    await ctx.page.keyboard.press(key);
    return `Pressed ${key}`;
  });

  registerFn('select', async (args, ctx) => {
    const selector = args[0];
    const value = args[1];
    if (!selector || !value) throw new Error('Usage: select <selector> <value>');
    await ctx.page.locator(selector).selectOption(value);
    return `Selected "${value}" in ${selector}`;
  });

  registerFn('hover', async (args, ctx) => {
    const target = args[0];
    if (!target) throw new Error('Usage: hover <selector|@ref>');
    const selector = resolveSelector(target, ctx.refMap);
    await ctx.page.locator(selector).hover();
    return `Hovered ${target}`;
  });

  registerFn('drag', async (args, ctx) => {
    const from = args[0];
    const to = args[1];
    if (!from || !to) throw new Error('Usage: drag <from-selector> <to-selector>');
    await ctx.page.locator(from).dragTo(ctx.page.locator(to));
    return `Dragged ${from} to ${to}`;
  });

  registerFn('wait', async (args, ctx) => {
    const selector = args[0];
    if (!selector) throw new Error('Usage: wait <selector> [--timeout <ms>]');
    let timeout = 10000;
    const tIdx = args.indexOf('--timeout');
    if (tIdx !== -1 && args[tIdx + 1]) {
      timeout = parseInt(args[tIdx + 1], 10);
    }
    await ctx.page.locator(selector).waitFor({ state: 'visible', timeout });
    return `Element ${selector} appeared`;
  });

  registerFn('dialog', async (args, ctx) => {
    const action = args[0];
    if (action !== 'accept' && action !== 'dismiss') throw new Error('Usage: dialog <accept|dismiss>');
    ctx.page.once('dialog', async dialog => {
      if (action === 'accept') await dialog.accept();
      else await dialog.dismiss();
    });
    return `Will ${action} next dialog`;
  });

  registerFn('upload', async (args, ctx) => {
    const selector = args[0];
    const filepath = args[1];
    if (!selector || !filepath) throw new Error('Usage: upload <selector> <filepath>');
    await ctx.page.locator(selector).setInputFiles(filepath);
    return `Uploaded ${filepath} to ${selector}`;
  });

  registerFn('resize', async (args, ctx) => {
    const size = args[0];
    if (!size || !size.includes('x')) throw new Error('Usage: resize <WxH> (e.g., 375x812)');
    const [w, h] = size.split('x').map(Number);
    if (!w || !h || w < 1 || h < 1 || !Number.isFinite(w) || !Number.isFinite(h)) {
      throw new Error('Width and height must be positive integers (e.g., 375x812)');
    }
    await ctx.page.setViewportSize({ width: Math.round(w), height: Math.round(h) });
    return `Viewport set to ${Math.round(w)}x${Math.round(h)}`;
  });
}
