import { createElement } from 'react';
import { renderToString } from 'react-dom/server.browser';
import App from '../src/App';
const html = renderToString(createElement(App));
console.log('SSR длина:', html.length);
if (!html.includes('toolbar') || !html.includes('status')) throw new Error('layout not rendered');
console.log('SSR OK');
