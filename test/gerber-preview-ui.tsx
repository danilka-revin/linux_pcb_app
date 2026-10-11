import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server.browser';
import { GerberPreviewDialog } from '../src/ui/gerber-preview';
import { newBoard } from '../src/pcb/model';

const html = renderToString(createElement(GerberPreviewDialog, { doc: newBoard(30, 20), onClose: () => {} }));
assert(html.includes('Gerber и сверловка'));
assert(html.includes('Добавить Gerber / Excellon'));
assert(html.includes('type="file"') && html.includes('multiple'));
assert(html.includes('Предпросмотр Gerber-слоёв и сверловки'));
console.log('Gerber viewer UI SSR OK: generated CAM preview and multi-file Gerber/Excellon import controls');
