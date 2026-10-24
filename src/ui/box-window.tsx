// Генератор коробок — самостоятельное окно программы.
//
// Открывается из шапки PSBees в любом режиме и работает со своим листом: можно
// собрать коробку, покрутить её в 3D, посмотреть раскладку и забрать точный DXF
// или SVG, вообще не заходя в редактор чертежей. Кнопка «Перенести в рисовалку»
// отдаёт раскладку хозяину окна — тот переключает режим и помещает детали на
// лист редактора.
//
// Сообщения окна (файл сохранён, подобран лист, ошибка параметров) показываются
// своей плашкой: статус-бара редактора здесь нет.

import { useCallback, useEffect, useState } from 'react';
import { BoxStudio, type BoxApplyPayload } from './box-studio';
import { newLaserDoc } from '../laser/model';

/** Лист окна по умолчанию: 600×400 мм — ходовой стол, раскладка подбирается внутри. */
const BOX_SHEET = { w: 600, h: 400 };

export function BoxWindow({
  onPlace,
  onClose,
}: {
  /** Перенести раскладку в редактор чертежей. */
  onPlace: (p: BoxApplyPayload) => void;
  onClose: () => void;
}) {
  const [doc] = useState(() => newLaserDoc(BOX_SHEET.w, BOX_SHEET.h, 'Коробка'));
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Сообщение живёт пару секунд и гаснет само.
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  const onMsg = useCallback((m: { text: string; ok: boolean }) => setMsg(m), []);

  return (
    <>
      <BoxStudio
        doc={doc}
        onApply={onPlace}
        onClose={onClose}
        onMsg={onMsg}
        applyLabel="Перенести в рисовалку"
      />
      {msg && (
        <div className={'box-win-msg' + (msg.ok ? '' : ' bad')} role="status">
          {msg.text}
        </div>
      )}
    </>
  );
}
