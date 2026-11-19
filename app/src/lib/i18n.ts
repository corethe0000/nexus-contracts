//texts in the wallet's language: the English text is the key, locales/<code>.json maps it to the translation, an
//entry that is missing shows English. {name} placeholders are filled from vars. Same languages as the wallet.
const packs = import.meta.glob<Record<string, string>>('../locales/*.json', { eager: true, import: 'default' });

export const languages = ['en', 'ar', 'de', 'es', 'fi', 'fr', 'ja', 'ko', 'no', 'nl', 'pl', 'pt', 'ru', 'sr', 'zh-cn', 'ro', 'hu', 'hr'] as const;
export type Lang = (typeof languages)[number];

let lang: Lang = 'en';
let pack: Record<string, string> = {};

export function setLanguage(code: unknown): Lang {
  //browsers say nb / nn for Norwegian, the wallet says no
  const c = String(code ?? 'en').toLowerCase().replace(/^(nb|nn)(?=-|$)/, 'no');
  const found = (languages as readonly string[]).includes(c) ? (c as Lang) : (languages.find((l) => l === c.split('-')[0]) ?? 'en');
  lang = found;
  pack = packs[`../locales/${found}.json`] ?? {};
  document.documentElement.lang = found;
  return found;
}

export const language = () => lang;

//Intl wants zh-CN, the wallet says zh-cn
export const intlLocale = () => (lang === 'zh-cn' ? 'zh-CN' : lang === 'no' ? 'nb' : lang);

export function t(text: string, vars?: Record<string, string | number>): string {
  const s = pack[text] || text;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}
