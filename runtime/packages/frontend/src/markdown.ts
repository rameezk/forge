import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

const SAFE_LINK = /^(?:https?:|mailto:)/i;

const md = new MarkdownIt({ html: false, linkify: false });

md.validateLink = (url) => SAFE_LINK.test(url.trim());

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
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer nofollow');
  return self.renderToken(tokens, index, options);
};

md.renderer.rules.table_open = () => '<div class="overflow-x-auto"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';

export const renderMarkdown = (text: string): string => md.render(text);
