import { autoPlaceVariants, type PlacementOpts } from './autoplace';
import type { Doc } from './model';

self.onmessage = (event: MessageEvent<{ doc: Doc; selected: string[]; opts: PlacementOpts }>) => {
  try {
    const result = autoPlaceVariants(
      event.data.doc, event.data.selected, event.data.opts,
      (text) => self.postMessage({ type: 'progress', text }),
    );
    self.postMessage({ type: 'done', result });
  } catch (error) {
    self.postMessage({ type: 'error', text: error instanceof Error ? error.message : 'Ошибка компоновки' });
  }
};
