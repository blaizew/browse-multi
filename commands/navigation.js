// commands/navigation.js

export function register(registerFn) {
  registerFn('goto', async (args, ctx) => {
    const url = args[0];
    if (!url) throw new Error('Usage: goto <url>');
    ctx.clearRefs();
    ctx.clearBuffers();
    await ctx.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return `Navigated to ${ctx.page.url()}`;
  });

  registerFn('back', async (args, ctx) => {
    ctx.clearRefs();
    ctx.clearBuffers();
    await ctx.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
    return `Navigated back to ${ctx.page.url()}`;
  });

  registerFn('reload', async (args, ctx) => {
    ctx.clearRefs();
    ctx.clearBuffers();
    await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    return `Reloaded ${ctx.page.url()}`;
  });

  registerFn('url', async (args, ctx) => {
    return ctx.page.url();
  });
}
