/**
 * Pure language-label table shared by the editor's language picker
 * (`codeLanguages.ts`) and the non-editor markdown renderer
 * (`markdownHighlight.ts`). Zero imports so the lazy highlight chunk and
 * tests can read display names without pulling in UI/i18n modules.
 */

export interface CodeLanguageEntry {
  fence: string;
  label: string;
  aliases?: string[];
}

/** Every grammar in lowlight's `common` set and in codeGrammars.ts, as the
 *  fence the menu writes and the name it shows. Order is the menu's order
 *  after the popular ones. */
export const CODE_LANGUAGES: readonly CodeLanguageEntry[] = [
  { fence: 'html', label: 'HTML', aliases: ['htm', 'xhtml'] },
  { fence: 'css', label: 'CSS' },
  { fence: 'javascript', label: 'JavaScript', aliases: ['js', 'jsx', 'mjs', 'cjs'] },
  { fence: 'typescript', label: 'TypeScript', aliases: ['ts', 'tsx', 'mts', 'cts'] },
  { fence: 'python', label: 'Python', aliases: ['py', 'gyp', 'ipython'] },
  { fence: 'json', label: 'JSON', aliases: ['jsonc'] },
  { fence: 'sql', label: 'SQL' },
  { fence: 'bash', label: 'Bash', aliases: ['sh', 'zsh'] },
  { fence: 'apache', label: 'Apache config', aliases: ['apacheconf'] },
  { fence: 'arduino', label: 'Arduino', aliases: ['ino'] },
  { fence: 'c', label: 'C', aliases: ['h'] },
  { fence: 'clojure', label: 'Clojure', aliases: ['clj', 'edn'] },
  { fence: 'cmake', label: 'CMake', aliases: ['cmake.in'] },
  { fence: 'cpp', label: 'C++', aliases: ['c++', 'cc', 'cxx', 'hpp'] },
  { fence: 'csharp', label: 'C#', aliases: ['cs', 'c#'] },
  { fence: 'dart', label: 'Dart' },
  { fence: 'diff', label: 'Diff', aliases: ['patch'] },
  { fence: 'dockerfile', label: 'Dockerfile', aliases: ['docker'] },
  { fence: 'dos', label: 'Batch (Windows)', aliases: ['bat', 'cmd'] },
  { fence: 'elixir', label: 'Elixir', aliases: ['ex', 'exs'] },
  { fence: 'go', label: 'Go', aliases: ['golang'] },
  { fence: 'graphql', label: 'GraphQL', aliases: ['gql'] },
  { fence: 'groovy', label: 'Groovy' },
  { fence: 'haskell', label: 'Haskell', aliases: ['hs'] },
  { fence: 'ini', label: 'INI / TOML', aliases: ['toml'] },
  { fence: 'java', label: 'Java', aliases: ['jsp'] },
  { fence: 'julia', label: 'Julia' },
  { fence: 'kotlin', label: 'Kotlin', aliases: ['kt', 'kts'] },
  { fence: 'latex', label: 'LaTeX', aliases: ['tex'] },
  { fence: 'less', label: 'Less' },
  { fence: 'lua', label: 'Lua' },
  { fence: 'makefile', label: 'Makefile', aliases: ['mk', 'mak', 'make'] },
  { fence: 'markdown', label: 'Markdown', aliases: ['md', 'mkdown', 'mkd'] },
  { fence: 'matlab', label: 'MATLAB' },
  { fence: 'nginx', label: 'Nginx config', aliases: ['nginxconf'] },
  { fence: 'objectivec', label: 'Objective-C', aliases: ['objc', 'mm', 'obj-c', 'objective-c'] },
  { fence: 'perl', label: 'Perl', aliases: ['pl', 'pm'] },
  { fence: 'php', label: 'PHP' },
  { fence: 'php-template', label: 'PHP template' },
  { fence: 'powershell', label: 'PowerShell', aliases: ['pwsh', 'ps', 'ps1'] },
  { fence: 'properties', label: 'Java properties' },
  { fence: 'protobuf', label: 'Protocol Buffers', aliases: ['proto'] },
  { fence: 'python-repl', label: 'Python REPL', aliases: ['pycon'] },
  { fence: 'r', label: 'R' },
  { fence: 'ruby', label: 'Ruby', aliases: ['rb', 'gemspec', 'podspec', 'thor', 'irb'] },
  { fence: 'rust', label: 'Rust', aliases: ['rs'] },
  { fence: 'scala', label: 'Scala' },
  { fence: 'scss', label: 'SCSS' },
  { fence: 'shell', label: 'Shell session', aliases: ['console', 'shellsession'] },
  { fence: 'swift', label: 'Swift' },
  { fence: 'vbnet', label: 'Visual Basic .NET', aliases: ['vb'] },
  { fence: 'wasm', label: 'WebAssembly' },
  { fence: 'xml', label: 'XML', aliases: ['rss', 'atom', 'xsl', 'plist', 'svg'] },
  { fence: 'yaml', label: 'YAML', aliases: ['yml'] },
];

/** The name a block's `language` attribute shows as: null for a plain block,
 *  the attribute itself for a fence the table does not know. */
export function codeLanguageLabel(language: string | null | undefined): string | null {
  if (!language || language === 'plaintext' || language === 'text' || language === 'txt') return null;
  const key = language.toLowerCase();
  return CODE_LANGUAGES.find((l) => l.fence === key || l.aliases?.includes(key))?.label ?? language;
}
