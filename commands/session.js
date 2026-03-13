// commands/session.js

export function register(registerFn) {
  registerFn('export-session', async (args, ctx) => {
    const state = await ctx.context.storageState();
    return JSON.stringify(state, null, 2);
  });
}
