import { routeNets } from './netroute';
import type { Doc } from './model';
import type { RouteOpts } from './autoroute';

self.onmessage = (event: MessageEvent<{ doc: Doc; opts: RouteOpts }>) => {
  try {
    const result = routeNets(event.data.doc, event.data.opts, (text) => self.postMessage({ type: 'progress', text }));
    self.postMessage({ type: 'done', result });
  } catch (error) {
    self.postMessage({ type: 'error', text: error instanceof Error ? error.message : 'Ошибка трассировки' });
  }
};
