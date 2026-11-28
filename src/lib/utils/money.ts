/**
 * Деньги: копейки целыми числами, разбор ввода и форматирование.
 *
 * Модуль намеренно без Dexie, Svelte и сети: его проверяет `npm run test:budget`.
 * Плавающие числа в бюджете недопустимы (0,1 + 0,2 ≠ 0,3), поэтому все суммы
 * живут в копейках, а рубли появляются только на экране и при разборе ввода.
 */

/** Верхняя граница одной суммы: 1 млрд ₽ в копейках. Защита от «1000000000000». */
export const MONEY_MAX = 100_000_000_000;

const GROUP_RE = /\B(?=(\d{3})+(?!\d))/g;

function groupDigits(value: string): string {
  return value.replace(GROUP_RE, ' ');
}

/**
 * Разбор суммы в копейки. Соглашение: **число — уже копейки**, строка —
 * рубли с копейками после запятой («1 234,56 ₽», «1234.5»). Так UI и облако
 * передают целые копейки, а человек вводит рубли. Мусор, отрицательные
 * значения и переполнение приводятся к безопасному виду: 0 … `max`.
 */
export function toKopecks(value: unknown, max = MONEY_MAX): number {
  let kopecks = Number.NaN;
  if (typeof value === 'number') {
    kopecks = Math.round(value);
  } else if (typeof value === 'bigint') {
    kopecks = Number(value);
  } else if (typeof value === 'string') {
    const clean = value
      .replace(/[\s\u00A0\u202F]/g, '')
      .replace(/руб\.?/gi, '')
      .replace(/[₽р]/gi, '');
    const match = clean.match(/-?\d+(?:[.,]\d+)?/);
    if (match) kopecks = Math.round(Number(match[0].replace(',', '.')) * 100);
  }
  if (!Number.isFinite(kopecks) || kopecks <= 0) return 0;
  return Math.min(kopecks, Math.max(0, Math.trunc(max)));
}

/** Число рублей (ответ модели, ручной ввод) → копейки. */
export function rubToKopecks(value: unknown, max = MONEY_MAX): number {
  const num =
    typeof value === 'string' ? Number(value.replace(/[\s\u00A0]/g, '').replace(',', '.')) : Number(value);
  if (!Number.isFinite(num)) return 0;
  return toKopecks(Math.round(num * 100), max);
}

/**
 * Разбор поля ввода: null — пусто или не число (это не то же самое, что «0 ₽»),
 * иначе сумма в копейках.
 */
export function parseMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? toKopecks(value) : null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (!/\d/.test(raw)) return null;
  return toKopecks(raw);
}

/** Допустим ли текст в поле суммы на этапе набора: «1 234», «1234,5», «1234,». */
export function isMoneyInput(value: unknown): boolean {
  const raw = String(value ?? '').trim();
  if (raw === '') return true;
  return /^[\d\s\u00A0\u202F]*([.,]\d{0,2})?$/.test(raw);
}

/** «1 234,56 ₽». Копейки показываем, только если они есть (или `exact`). */
export function formatMoney(
  kopecks: number,
  opts: { sign?: boolean; exact?: boolean; currency?: boolean } = {}
): string {
  const value = Math.round(Number(kopecks) || 0);
  const abs = Math.abs(value);
  const rubles = Math.trunc(abs / 100);
  const cents = abs % 100;
  let body = groupDigits(String(rubles));
  if (cents > 0 || opts.exact) body += `,${String(cents).padStart(2, '0')}`;
  const prefix = value < 0 ? '−' : opts.sign && value > 0 ? '+' : '';
  return `${prefix}${body}${opts.currency === false ? '' : ' ₽'}`;
}

/** Компактная подпись для графиков: «950 ₽», «12,4 тыс ₽», «1,2 млн ₽». */
export function formatMoneyShort(kopecks: number): string {
  const value = Math.round(Number(kopecks) || 0);
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs < 100_000) return `${sign}${groupDigits(String(Math.trunc(abs / 100)))} ₽`;
  if (abs < 10_000_000) {
    return `${sign}${(abs / 100_000).toFixed(1).replace('.', ',')} тыс ₽`;
  }
  return `${sign}${(abs / 100_000_000).toFixed(1).replace('.', ',')} млн ₽`;
}

/** Значение для поля ввода: «1234,56» (без разрядов и символа валюты). */
export function moneyInputValue(kopecks: number): string {
  const value = Math.max(0, Math.round(Number(kopecks) || 0));
  const rubles = Math.trunc(value / 100);
  const cents = value % 100;
  return cents > 0 ? `${rubles},${String(cents).padStart(2, '0')}` : String(rubles);
}

/** Доля в процентах с одним знаком; при нулевом основании — 0, а не NaN. */
export function moneyPercent(part: number, total: number): number {
  const p = Number(part) || 0;
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  return Math.round((p / t) * 1000) / 10;
}
