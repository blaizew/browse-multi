// lib/refs.js
//
// @ref system: during snapshot, we inject data-browse-ref attributes on DOM
// elements and build a tree representation. Refs are resolved via CSS selector
// [data-browse-ref="eN"]. This avoids the ambiguity of getByRole and doesn't
// depend on the deprecated page.accessibility API.

export function resolveSelector(selectorOrRef, refMap) {
  if (typeof selectorOrRef === 'string' && selectorOrRef.startsWith('@e')) {
    const selector = refMap.get(selectorOrRef);
    if (!selector) throw new Error(`${selectorOrRef} not found. Refs may be stale — run snapshot again.`);
    return selector;
  }
  return selectorOrRef;
}

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, details, summary, ' +
  '[role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
  '[role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], ' +
  '[role="textbox"], [role="searchbox"], [role="slider"], [contenteditable="true"]';

export async function buildSnapshot(page, { interactiveOnly = false, selector = null } = {}) {
  // Inject data-browse-ref attributes and build tree in a single page.evaluate call
  const result = await page.evaluate(({ interactiveOnly, selector, interactiveSelector }) => {
    // Clean up previous refs
    document.querySelectorAll('[data-browse-ref]').forEach(el => el.removeAttribute('data-browse-ref'));

    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) return { tree: '(element not found)', refs: [] };

    const lines = [];
    const refs = [];
    let counter = 0;

    function getRole(el) {
      return el.getAttribute('role') || el.tagName.toLowerCase();
    }

    function getName(el) {
      return el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('alt') ||
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? '' :
          el.textContent?.trim().slice(0, 60)) || '';
    }

    function getValue(el) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        return el.value || '';
      }
      return '';
    }

    function isInteractive(el) {
      if (el.matches(interactiveSelector)) return true;
      if (el.getAttribute('contenteditable') === 'true') return true;
      if (el.onclick || el.getAttribute('onclick')) return true;
      return false;
    }

    function walk(el, depth) {
      if (el.nodeType !== 1) return; // Element nodes only
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript') return;

      const interactive = isInteractive(el);
      if (interactiveOnly && !interactive && !el.querySelector(interactiveSelector)) return;

      if (!interactiveOnly || interactive) {
        counter++;
        const ref = `e${counter}`;
        el.setAttribute('data-browse-ref', ref);

        const role = getRole(el);
        const name = getName(el);
        const value = getValue(el);
        const indent = '  '.repeat(depth);
        const nameStr = name ? ` "${name}"` : '';
        const valueStr = value ? ` value="${value}"` : '';
        lines.push(`${indent}@${ref}  ${role}${nameStr}${valueStr}`);
        refs.push({ ref: `@${ref}`, selector: `[data-browse-ref="${ref}"]` });
      }

      for (const child of el.children) {
        walk(child, depth + ((!interactiveOnly || interactive) ? 1 : 0));
      }
    }

    walk(root, 0);
    return { tree: lines.join('\n') || '(empty page)', refs };
  }, { interactiveOnly, selector, interactiveSelector: INTERACTIVE_SELECTOR });

  // Build refMap from results
  const refMap = new Map();
  for (const { ref, selector: sel } of result.refs) {
    refMap.set(ref, sel);
  }

  return { tree: result.tree, refMap, refCounter: result.refs.length };
}
