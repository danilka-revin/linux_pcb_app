import { autoPlace, type PlacementOpts } from './autoplace';
import type { Doc } from './model';

self.onmessage = (event: MessageEvent<{ doc: Doc; selected: string[]; opts: PlacementOpts }>) => {
  try {
    self.postMessage({ result: autoPlace(event.data.doc, event.data.selected, event.data.opts) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Ошибка компоновки' });
  }
};
