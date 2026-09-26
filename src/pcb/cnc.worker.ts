// Построение CAM-траекторий вне UI-потока. Закрытие диалога прекращает Worker.
import { analyzeCncBoard, buildCncJob, type CncSettings } from './cnc';
import type { Doc } from './model';

self.onmessage = (event: MessageEvent<{ op?: string; doc: Doc; settings?: CncSettings }>) => {
  try {
    if (event.data.op === 'analyze') {
      try {
        self.postMessage({ type: 'analysis', analysis: analyzeCncBoard(event.data.doc) });
      } catch (e) {
        self.postMessage({ type: 'analysis', error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (!event.data.settings) throw new Error('Не указаны параметры ЧПУ.');
    const job = buildCncJob(event.data.doc, event.data.settings,
      (stage, frac) => self.postMessage({ type: 'progress', stage, frac }));
    self.postMessage({ ok: true, job });
  } catch (e) {
    self.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
