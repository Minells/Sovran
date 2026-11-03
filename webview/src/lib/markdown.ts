import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const languages = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, python, ruby, rust, sql, swift, typescript, xml, yaml };
for (const [name, lang] of Object.entries(languages)) hljs.registerLanguage(name, lang);
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['html', 'svg', 'vue'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['cs'], { languageName: 'csharp' });
hljs.registerAliases(['toml'], { languageName: 'ini' });

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Raw HTML in model output is never rendered (html:false); DOMPurify runs on the result as defense in depth.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]!;
  const lang = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const code = token.content.replace(/\n$/, '');
  let highlighted: string;
  try {
    highlighted = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : escapeHtml(code);
  } catch {
    highlighted = escapeHtml(code);
  }
  return (
    `<div class="sv-code"><div class="sv-code__head"><span class="sv-code__lang">${escapeHtml(lang || 'text')}</span>` +
    `<button class="sv-icon-btn" data-action="insert" title="Insert at cursor" aria-label="Insert code at cursor"><i class="codicon codicon-insert"></i></button>` +
    `<button class="sv-icon-btn" data-action="copy" title="Copy" aria-label="Copy code"><i class="codicon codicon-copy"></i></button>` +
    `</div><pre><code>${highlighted}</code></pre></div>`
  );
};

const PATH_RE = /^(?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]{1,8}(?::(\d+))?$/;

md.renderer.rules.code_inline = (tokens, idx) => {
  const content = tokens[idx]!.content;
  const m = PATH_RE.exec(content);
  if (m && !/^\d/.test(content) && content.includes('/')) {
    const file = content.replace(/:\d+$/, '');
    const line = m[1] ? ` data-line="${m[1]}"` : '';
    return `<code class="sv-path" data-path="${escapeHtml(file)}"${line} title="Open ${escapeHtml(file)}">${escapeHtml(content)}</code>`;
  }
  return `<code>${escapeHtml(content)}</code>`;
};

const purifyConfig = {
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
  ADD_ATTR: ['data-action', 'data-path', 'data-line'],
  FORBID_TAGS: ['style', 'form', 'input', 'img', 'iframe', 'object', 'embed'],
};

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.render(text), purifyConfig) as string;
}
