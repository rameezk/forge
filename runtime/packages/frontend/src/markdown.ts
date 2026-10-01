import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

// ADR-0019: agent output is untrusted. No raw HTML, no auto-linking, no
// images, and only http, https and mailto links.
const SAFE_LINK = /^(?:https?:|mailto:)/i;

const md = new MarkdownIt({ html: false, linkify: false });

md.validateLink = (url) => SAFE_LINK.test(url.trim());

// An image is shown as its own markdown source instead of loading anything.
// The stock rule is run silently only to find where the image ends.
const stockImage = (md.inline.ruler as unknown as { __rules__: { name: string; fn: (state: StateInline, silent: boolean) => boolean }[] }).__rules__.find((rule) => rule.name === 'image')?.fn;
if (stockImage === undefined) {
  throw new Error('markdown-it has no image rule to replace');
}
md.inline.ruler.at('image', (state, silent) => {
  const start = state.pos;
  if (!stockImage(state, true)) {
    return false;
  }
  const end = state.pos;
  if (!silent) {
    state.push('text', '', 0).content = state.src.slice(start, end);
  }
  return true;
});

md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const token = tokens[index]!;
  token.attrSet('rel', 'noopener noreferrer nofollow');
  return self.renderToken(tokens, index, options);
};

// Wide tables scroll inside their own block, never the page body.
md.renderer.rules.table_open = () => '<div class="overflow-x-auto"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';

export const renderMarkdown = (text: string): string => md.render(text);
