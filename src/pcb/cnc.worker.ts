// Построение CAM-траекторий вне UI-потока. Закрытие диалога прекращает Worker.
import { buildCncJob, type CncSettings } from './cnc';
import type { Doc } from './model';

self.onmessage = (event: MessageEvent<{ doc: Doc; settings: CncSettings }>) => {
  try {
    const job = buildCncJob(event.data.doc, event.data.settings);
    self.postMessage({ ok: true, job });
  } catch (e) {
    self.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
