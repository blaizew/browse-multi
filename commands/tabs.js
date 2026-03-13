// commands/tabs.js

export function register(registerFn) {
  registerFn('tabs', async (args, ctx) => {
    const pages = ctx.context.pages();
    const lines = await Promise.all(pages.map(async (p, i) => {
      const title = await p.title().catch(() => '(no title)');
      return `${i}\t${p.url()}\t${title || '(no title)'}`;
    }));
    return lines.join('\n') || '(no tabs)';
  });

  registerFn('tab', async (args, ctx) => {
    const id = parseInt(args[0], 10);
    const pages = ctx.context.pages();
    if (isNaN(id) || id < 0 || id >= pages.length) throw new Error(`Invalid tab id: ${args[0]}. Use 'tabs' to list.`);
    ctx.setPage(pages[id]);
    return `Switched to tab ${id}: ${pages[id].url()}`;
  });

  registerFn('newtab', async (args, ctx) => {
    const url = args[0];
    const newPage = await ctx.context.newPage();
    if (url) await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    ctx.setPage(newPage);
    const pages = ctx.context.pages();
    return `Opened tab ${pages.length - 1}${url ? `: ${url}` : ''}`;
  });

  registerFn('closetab', async (args, ctx) => {
    const id = args[0] !== undefined ? parseInt(args[0], 10) : null;
    const pages = ctx.context.pages();
    if (pages.length <= 1) throw new Error('Cannot close the last tab');
    const target = id !== null ? pages[id] : ctx.page;
    if (!target) throw new Error(`Invalid tab id: ${id}`);
    const targetUrl = target.url();
    await target.close();
    // Switch to first remaining page
    const remaining = ctx.context.pages();
    if (remaining.length > 0) ctx.setPage(remaining[0]);
    return `Closed tab: ${targetUrl}`;
  });
}
