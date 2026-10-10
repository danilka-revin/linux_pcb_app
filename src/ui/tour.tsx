// Интерактивное обучение — короткие туры по функциям приложения.
// Три тура: автороутинг, ЧПУ, генератор деталей — плюс общий обзор.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from './widgets';

export type TourId = 'overview' | 'autoroute' | 'cnc' | 'generator';

interface TourStep {
  title: string;
  text: ReactNode;
  /** Селектор элемента, который нужно подсветить (необязательно). */
  highlight?: string;
  /** Иконка из Ic (имя), показывается слева от заголовка шага. */
  icon?: string;
}

interface Tour {
  id: TourId;
  title: string;
  description: string;
  icon: string;
  steps: TourStep[];
}

export const TOURS: Tour[] = [
  {
    id: 'overview',
    title: 'Обзор интерфейса',
    description: 'Краткий тур по главным областям редактора: панели, инструменты, холст.',
    icon: 'fit',
    steps: [
      {
        title: 'Добро пожаловать в PSBees!',
        text: (
          <>
            <p>Этот короткий тур покажет основные возможности редактора. Вы можете пройти все туры или выбрать нужный раздел.</p>
            <p>Каждый тур — несколько шагов с описанием и подсветкой нужных кнопок. Можно пропустить тур в любой момент.</p>
          </>
        ),
      },
      {
        title: 'Верхняя панель',
        text: 'На верхней панели расположены кнопки для работы с файлами, генератор деталей, отмена/повтор, настройки сетки, слои меди и вид. Каждый блок можно скрыть через «Конструктор интерфейса».',
        highlight: '.toolbar',
      },
      {
        title: 'Вертикальный док инструментов',
        text: 'Слева у холста — инструменты рисования: выбор, дорожка, площадка, SMD, переход, отверстие, линия, прямоугольник, окружность, полигон, текст, линейка, автотрассировка и тест цепи. Горячие клавиши и подсказки — в свойствах справа.',
        highlight: '.dock',
      },
      {
        title: 'Левая вкладка — Детали, Генератор, Каталог',
        text: 'В левой панели три вкладки: «Детали» (личная библиотека), «Генератор» (корпус словами) и «Каталог» (PartReel и KiCad). Генератор — самый быстрый способ создать посадочное место.',
        highlight: '.left-tabs',
      },
      {
        title: 'Правая панель — свойства и слои',
        text: 'Справа показаны свойства выделенного объекта (координаты, размеры, слой), панель слоёв (видимость K1/K2/S1/S2/контур) и контроль зазора дорожек.',
        highlight: '.right-panel',
      },
      {
        title: 'Холст — ваше рабочее пространство',
        text: 'В центре — холст с платой. Колесо мыши — масштаб, средняя кнопка или Shift+ЛКМ — панорама. Привязка к сетке и объектам включена по умолчанию. Начните с создания новой платы или откройте файл.',
      },
      {
        title: 'Готово!',
        text: (
          <>
            <p>Вы прошли обзор интерфейса. Чтобы углубиться в конкретные функции, запустите один из тематических туров:</p>
            <ul>
              <li><b>Автотрассировка</b> — как прокладывать дорожки автоматически</li>
              <li><b>ЧПУ-экспорт</b> — как получить G-code для фрезеровки</li>
              <li><b>Генератор деталей</b> — как создать корпус строкой текста</li>
            </ul>
          </>
        ),
      },
    ],
  },
  {
    id: 'autoroute',
    title: 'Автотрассировка',
    description: 'Как прокладывать дорожки: вручную, «Две точки» и группами по всей плате.',
    icon: 'route',
    steps: [
      {
        title: 'Автотрассировка — обзор',
        text: (
          <>
            <p>PSBees предлагает три способа прокладки дорожек:</p>
            <ul>
              <li><b>Ручная дорожка</b> — рисуете каждый сегмент мышью</li>
              <li><b>«Две точки»</b> — указываете начало и конец, программа строит путь</li>
              <li><b>Группы соединений</b> — описываете электрические цепи, и программа разводит их сразу пачкой</li>
            </ul>
          </>
        ),
        icon: 'route',
      },
      {
        title: 'Шаг 1. Включите инструмент',
        text: 'Нажмите кнопку «Автотрассировка» (значок маршрута) в вертикальном доке слева у холста, или нажмите клавишу 9. Справа от холста появится панель выбора режима.',
        highlight: '.dock',
      },
      {
        title: 'Шаг 2. Режим «Две точки»',
        text: 'Выберите «Две точки» — кликните первую площадку (начало), затем вторую (конец). Программа автоматически проложит дорожку, переходя между слоями K1 и K2 при необходимости. Вход в THT-площадки — по нижнему краю (K2).',
      },
      {
        title: 'Шаг 3. Режим «Группы / вся плата»',
        text: 'Переключитесь на «Группы» — нажмите «+ Новая группа» и кликните все площадки, которые должны быть электрически связаны. Создайте столько групп, сколько цепей на плате. Каждая группа получает свою ширину дорожки, зазор и слой.',
      },
      {
        title: 'Шаг 4. Настройте правила группы',
        text: 'В строке каждой группы задайте ширину дорожки (по умолчанию — из общих настроек). Земле и питанию удобно поставить 1.0–1.5 мм, сигналам — 0.8 мм. Задайте зазор, размеры перехода и разрешённые слои.',
      },
      {
        title: 'Шаг 5. Рассчитать 3 варианта',
        text: 'Нажмите «Рассчитать 3 варианта». Программа построит три варианта разводки с разными стратегиями: «Меньше переходов», «Короче дорожки» и «Длинные связи первыми». Сравните карточки и выберите подходящий.',
      },
      {
        title: 'Шаг 6. Применить вариант',
        text: 'Нажмите «Применить вариант N» — новые дорожки появятся на плате одним действием Undo. Закрытие окна без применения не меняет плату. Расчёт идёт в фоне (Web Worker), можно отменить кнопкой Esc.',
      },
      {
        title: 'Полезные советы',
        text: (
          <>
            <ul>
              <li>Существующие дорожки не удаляются — повторный запуск достраивает только недостающее</li>
              <li>Цветные кольца на площадках показывают принадлежность группе</li>
              <li>Красный мигающий круг — контроль зазора дорожек (DRC)</li>
              <li>Компоновку компонентов лучше делать <b>до</b> трассировки</li>
            </ul>
          </>
        ),
      },
    ],
  },
  {
    id: 'cnc',
    title: 'ЧПУ-экспорт',
    description: 'Как получить G-code для фрезерного станка: контур, дорожки, сверловка.',
    icon: 'cnc',
    steps: [
      {
        title: 'ЧПУ-экспорт — обзор',
        text: (
          <>
            <p>PSBees умеет генерировать G-code для фрезерного станка. Поддерживаются:</p>
            <ul>
              <li><b>Фрезеровка контура</b> — вырезание платы по контуру</li>
              <li><b>Фрезеровка дорожек</b> — удаление меди вокруг дорожек</li>
              <li><b>Сверловка</b> — отверстия под выводы и крепёж</li>
            </ul>
            <p>Есть встроенная демонстрация и предпросмотр траекторий.</p>
          </>
        ),
        icon: 'cnc',
      },
      {
        title: 'Шаг 1. Откройте диалог ЧПУ',
        text: 'Нажмите «⋯» → «G-code для фрезерного станка…» в верхней панели (или «Экспорт Gerber / PNG / ЧПУ…» → «ЧПУ»). Откроется отдельное окно с настройками фрезеровки и предпросмотром.',
        highlight: '.toolbar',
      },
      {
        title: 'Шаг 2. Настройте параметры фрезы',
        text: 'Задайте диаметр фрезы, глубину фрезеровки и скорость подачи. Диаметр фрезы определяет минимальный зазор между дорожками: чем тоньше фреза, тем ближе дорожки можно расположить.',
      },
      {
        title: 'Шаг 3. Выберите слои для обработки',
        text: 'Укажите, какие слои фрезеровать: дорожки K1, дорожки K2, контур, сверловка. Для каждого прохода можно задать собственную глубину и количество проходов (для толстого текстолита).',
      },
      {
        title: 'Шаг 4. Проверьте предпросмотр',
        text: 'Справа от настроек — предпросмотр траекторий. Красным показаны проходы фрезы, синим — перемещения. Масштабируйте и перемещайте предпросмотр мышью. Проверьте, что нет пересечений и выхода за край платы.',
      },
      {
        title: 'Шаг 5. Экспорт G-code',
        text: 'Нажмите «Экспорт» — скачается файл .gcode (или .nc). Загрузите его в управляющую программу станка. Проверьте привязку нулевой точки перед запуском.',
      },
      {
        title: 'Советы по ЧПУ',
        text: (
          <>
            <ul>
              <li>Используйте «Схемы» — готовые профили настроек для типичных задач</li>
              <li>Демонстрация в диалоге показывает, как фреза обходит площадки и дорожки</li>
              <li>Контроль зазора в редакторе помогает избежать слишком узких промежутков</li>
              <li>Для двусторонних плат фрезеруют каждый слой отдельно, совмещая по отверстиям</li>
            </ul>
          </>
        ),
      },
    ],
  },
  {
    id: 'generator',
    title: 'Генератор деталей',
    description: 'Как создать посадочное место из текстового описания — быстро и точно.',
    icon: 'gen',
    steps: [
      {
        title: 'Генератор деталей — обзор',
        text: (
          <>
            <p>Генератор — самый быстрый способ создать посадочное место. Вместо черчения каждой площадки вручную вы пишете описание строкой, например:</p>
            <p style={{ fontFamily: 'monospace', fontSize: 12, background: 'var(--hover)', padding: '4px 8px', borderRadius: 4 }}>
              dip 8 шаг 2.54 2 крепёжных отверстия m3 подписи
            </p>
            <p>Программа создаст корпус: выводы, шелкографию, крепёжные отверстия, подписи и номинал.</p>
          </>
        ),
        icon: 'gen',
      },
      {
        title: 'Шаг 1. Откройте генератор',
        text: 'Нажмите кнопку «Генератор» (значок микросхемы) в верхней панели или перейдите на вкладку «Генератор» в левой панели. Появится поле ввода и область предпросмотра.',
        highlight: '.toolbar',
      },
      {
        title: 'Шаг 2. Опишите корпус',
        text: 'Введите строку описания. Поддерживаются 21 семейство: DIP, SOIC, TSSOP, QFN, QFP, SOT, чип-корпусы (0201…2512), выводные резисторы, конденсаторы, электролиты, кварцы, кнопки, клеммники, линейки, TO-220/247, Arduino/ESP32 и другие модули.',
      },
      {
        title: 'Шаг 3. Параметры',
        text: 'Укажите шаг выводов (например, 1.27), количество выводов, размер площадки, крепёжные отверстия (M3, M2.5), подписи и номинал. Каждый параметр — отдельное слово в строке.',
      },
      {
        title: 'Шаг 4. Предпросмотр',
        text: 'Справа от поля ввода — живой предпросмотр корпуса. Проверьте размеры, количество и расположение выводов. Предпросмотр обновляется по мере ввода.',
      },
      {
        title: 'Шаг 5. Размещение на плате',
        text: 'Нажмите «Добавить в библиотеку» или «Разместить на плате». Деталь появится на холсте — перетащите её в нужное место. Поворот — R, сторона — Q.',
      },
      {
        title: 'Шаг 6. Сохранение в библиотеку',
        text: 'После размещения деталь сохраняется в личную библиотеку (вкладка «Детали» слева). Можно сохранить в папку с вложенными папками. Резервная копия библиотеки — JSON-файл (экспорт/импорт).',
      },
      {
        title: 'Советы по генератору',
        text: (
          <>
            <ul>
              <li>Каталог PartReel и KiCad (вкладка «Каталог») — готовые корпуса без ввода строки</li>
              <li>Экспорт JSON PSBees — делиться корпусами между проектами</li>
              <li>Скачивание .kicad_mod — исходные файлы KiCad для проверки</li>
              <li>Строка генератора сохраняется для повторного редактирования</li>
            </ul>
          </>
        ),
      },
    ],
  },
];

const TOUR_KEY = 'psbees.tour.completed';

function loadCompleted(): Set<TourId> {
  try {
    const raw = localStorage.getItem(TOUR_KEY);
    if (raw) return new Set(JSON.parse(raw) as TourId[]);
  } catch { /* приватный режим */ }
  return new Set();
}

function saveCompleted(set: Set<TourId>) {
  try { localStorage.setItem(TOUR_KEY, JSON.stringify([...set])); } catch { /* приватный режим */ }
}

/** Главный компонент обучения — список туров или прохождение выбранного. */
export function TourDialog({ onClose }: { onClose: () => void }) {
  const [active, setActive] = useState<TourId | null>(null);
  const [step, setStep] = useState(0);
  const [completed, setCompleted] = useState<Set<TourId>>(loadCompleted);
  const highlightRef = useRef<HTMLElement | null>(null);

  const tour = active ? TOURS.find((t) => t.id === active) : null;

  const goNext = useCallback(() => {
    if (!tour) return;
    if (step < tour.steps.length - 1) {
      setStep(step + 1);
    } else {
      // Тур завершён
      const next = new Set(completed);
      next.add(tour.id);
      setCompleted(next);
      saveCompleted(next);
      setActive(null);
      setStep(0);
    }
  }, [tour, step, completed]);

  const goPrev = useCallback(() => {
    if (step > 0) setStep(step - 1);
  }, [step]);

  const skipTour = useCallback(() => {
    setActive(null);
    setStep(0);
  }, []);

  // Подсветка элемента по селектору
  useEffect(() => {
    if (highlightRef.current) {
      highlightRef.current.classList.remove('tour-highlight');
      highlightRef.current = null;
    }
    const s = tour?.steps[step];
    if (s?.highlight) {
      const el = document.querySelector(s.highlight) as HTMLElement | null;
      if (el) {
        el.classList.add('tour-highlight');
        highlightRef.current = el;
      }
    }
    return () => {
      if (highlightRef.current) {
        highlightRef.current.classList.remove('tour-highlight');
        highlightRef.current = null;
      }
    };
  }, [tour, step]);

  // Навигация клавишами
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!tour) return;
      if (e.key === 'ArrowRight' || e.key === 'Enter') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'Escape') skipTour();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tour, goNext, goPrev, skipTour]);

  // Список туров
  if (!active || !tour) {
    return (
      <Modal
        title="🎓 Обучение в приложении"
        className="tour-modal"
        onClose={onClose}
        foot={<button className="btn primary" onClick={onClose}>Закрыть</button>}
      >
        <p>Выберите тур, чтобы узнать о возможностях редактора. Каждый тур — несколько шагов с описанием.</p>
        <div className="tour-list">
          {TOURS.map((t) => (
            <button
              key={t.id}
              className={'tour-card' + (completed.has(t.id) ? ' done' : '')}
              onClick={() => { setActive(t.id); setStep(0); }}
            >
              <span className="tour-card-icon">
                {t.id === 'overview' ? '🏠' : t.id === 'autoroute' ? '⚡' : t.id === 'cnc' ? '🔧' : '🔲'}
              </span>
              <span className="tour-card-body">
                <b>{t.title}</b>
                <small>{t.description}</small>
              </span>
              {completed.has(t.id) && <span className="tour-card-badge">✓</span>}
            </button>
          ))}
        </div>
        {completed.size > 0 && (
          <button
            className="btn tour-reset"
            onClick={() => { setCompleted(new Set()); saveCompleted(new Set()); }}
            title="Сбросить отметки пройденных туров"
          >
            Сбросить прогресс
          </button>
        )}
      </Modal>
    );
  }

  const currentStep = tour.steps[step];
  const totalSteps = tour.steps.length;
  const progressPct = ((step + 1) / totalSteps) * 100;

  return (
    <Modal
      title={`${tour.title} — шаг ${step + 1} из ${totalSteps}`}
      className="tour-modal tour-active-modal"
      onClose={onClose}
      foot={
        <div className="tour-footer">
          <button className="btn" onClick={skipTour}>Пропустить тур</button>
          <div className="tour-nav">
            <button className="btn" onClick={goPrev} disabled={step === 0}>← Назад</button>
            <button className="btn primary" onClick={goNext}>
              {step < totalSteps - 1 ? 'Далее →' : 'Завершить ✓'}
            </button>
          </div>
        </div>
      }
    >
      {/* Прогресс-бар */}
      <div className="tour-progress">
        <div className="tour-progress-bar" style={{ width: `${progressPct}%` }} />
      </div>

      {/* Контент шага */}
      <div className="tour-step-content">
        {currentStep.icon && (
          <span className="tour-step-icon" aria-hidden="true">
            {tour.id === 'autoroute' ? '⚡' : tour.id === 'cnc' ? '🔧' : tour.id === 'generator' ? '🔲' : '🏠'}
          </span>
        )}
        <h3>{currentStep.title}</h3>
        <div className="tour-step-text">{currentStep.text}</div>
      </div>

      {/* Точки-индикаторы шагов */}
      <div className="tour-dots">
        {tour.steps.map((_, i) => (
          <button
            key={i}
            className={'tour-dot' + (i === step ? ' active' : '') + (i < step ? ' passed' : '')}
            onClick={() => setStep(i)}
            title={`Шаг ${i + 1}: ${tour.steps[i].title}`}
          />
        ))}
      </div>
    </Modal>
  );
}
