/**
 * Мини-роутер на hash-навигации (обязательно для GitHub Pages).
 * Состояние реактивное — компоненты читают router.route.name.
 */

export type Route =
  | { name: 'topics' }
  | { name: 'new-topic' }
  | { name: 'topic'; id: string; tab: TopicTab }
  | { name: 'library' }
  | { name: 'settings' };

export type TopicTab = 'plan' | 'chat' | 'notes';

const TABS: TopicTab[] = ['plan', 'chat', 'notes'];

function parse(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  const parts = clean.split('/').filter(Boolean);
  const head = parts[0] ?? '';

  if (head === 'new') return { name: 'new-topic' };
  if (head === 'library') return { name: 'library' };
  if (head === 'settings') return { name: 'settings' };
  if (head === 'topic' && parts[1]) {
    const tab = (parts[2] ?? 'plan') as TopicTab;
    return { name: 'topic', id: decodeURIComponent(parts[1]), tab: TABS.includes(tab) ? tab : 'plan' };
  }
  return { name: 'topics' };
}

class Router {
  route = $state<Route>(parse(typeof location === 'undefined' ? '' : location.hash));

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('hashchange', () => {
        this.route = parse(location.hash);
        window.scrollTo({ top: 0 });
      });
    }
  }

  go(path: string): void {
    const next = path.startsWith('#') ? path : `#${path.startsWith('/') ? '' : '/'}${path}`;
    if (location.hash === next) {
      this.route = parse(next);
      return;
    }
    location.hash = next;
  }

  topic(id: string, tab: TopicTab = 'plan'): void {
    this.go(`/topic/${encodeURIComponent(id)}/${tab}`);
  }

  /** Текущий «раздел» для подсветки нижней навигации */
  get section(): string {
    const r = this.route;
    if (r.name === 'topic') return 'topics';
    if (r.name === 'new-topic') return 'topics';
    return r.name;
  }
}

export const router = new Router();
