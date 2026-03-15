// commands/session.js
import { writeFileSync } from 'node:fs';
import { sessionFilePath } from '../lib/instance.js';

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function register(registerFn) {
  registerFn('export-session', async (args, ctx) => {
    const state = await ctx.context.storageState();
    return JSON.stringify(state, null, 2);
  });

  registerFn('save-session', async (args, ctx) => {
    const currentUrl = ctx.page.url();
    const domain = args[0] || extractDomain(currentUrl);
    if (!domain) {
      throw new Error('Could not determine domain. Pass it as an argument: save-session example.com');
    }
    const state = await ctx.context.storageState();
    const savePath = sessionFilePath(domain);
    writeFileSync(savePath, JSON.stringify(state, null, 2));
    return `Session saved to ${savePath}`;
  });
}
