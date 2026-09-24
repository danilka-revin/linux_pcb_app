import { createElement } from 'react';
import { renderToString } from 'react-dom/server.browser';
import App from '../src/App';
const html = renderToString(createElement(App));
console.log('SSR длина:', html.length);
if (!html.includes('toolbar') || !html.includes('status')) throw new Error('layout not rendered');
if (!html.includes('Bees')) throw new Error('brand not rendered');
if (!html.includes('ffd53f')) throw new Error('wasp mark not rendered');
console.log('SSR OK');
