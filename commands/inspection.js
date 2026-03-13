// commands/inspection.js

export function register(registerFn) {
  registerFn('js', async (args, ctx) => {
    const expr = args.join(' ');
    if (!expr) throw new Error('Usage: js <expression>');
    const result = await ctx.page.evaluate(expr);
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  });

  registerFn('eval', async (args, ctx) => {
    // Code comes via the args (client reads stdin and passes as single arg)
    const code = args[0];
    if (!code) throw new Error('Usage: echo "code" | browse-multi --name <n> eval');
    const result = await ctx.page.evaluate(code);
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  });

  registerFn('console', async (args, ctx) => {
    if (ctx.consoleBuffer.length === 0) return '(no console messages)';
    let header = '';
    if (ctx.consoleTotalCount > ctx.consoleBuffer.length) {
      header = `(showing last ${ctx.consoleBuffer.length} of ~${ctx.consoleTotalCount} entries)\n`;
    }
    return header + ctx.consoleBuffer.map(e =>
      `[${e.type}] ${e.text}`
    ).join('\n');
  });

  registerFn('network', async (args, ctx) => {
    if (ctx.networkBuffer.length === 0) return '(no network requests)';
    let header = '';
    if (ctx.networkTotalCount > ctx.networkBuffer.length) {
      header = `(showing last ${ctx.networkBuffer.length} of ~${ctx.networkTotalCount} entries)\n`;
    }
    return header + ctx.networkBuffer.map(e =>
      `${e.method} ${e.status} ${e.url}`
    ).join('\n');
  });
}
