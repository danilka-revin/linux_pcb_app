import React from 'react';
import { createRoot } from 'react-dom/client';
import Workspace from './cloud/Workspace';
import { initPerf } from './perf';
import './styles.css';

// Профиль качества применяется до первого кадра: на слабых машинах тяжёлые
// эффекты (размытие панелей, декоративные анимации) не включаются вовсе.
initPerf();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Workspace />
  </React.StrictMode>
);
