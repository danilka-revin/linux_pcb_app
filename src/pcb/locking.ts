// Правила блокировки объектов слоями. Черезотверстные площадки/переходы
// пересекают обе медные стороны: замок любой из них защищает всю деталь.
import type { Entity, LayerId } from './model';
import { expandComp } from './expand';

/** Слои, которых касается объект. Сквозные отверстия принадлежат обеим меди. */
export function entityTouchesLayer(entity: Entity, layer: LayerId): boolean {
  if (entity.kind === 'comp') return expandComp(entity).some((part) => entityTouchesLayer(part, layer));
  if (entity.kind === 'pad' || entity.kind === 'via') return layer === 'k1' || layer === 'k2';
  if (entity.kind === 'hole') return false;
  return entity.layer === layer;
}

/** Замок слоя блокирует объект целиком — в том числе компонент с примитивом на этом слое. */
export function lockedByLayer(entity: Entity, lockedLayers: Set<LayerId>): boolean {
  if (!lockedLayers.size) return false;
  for (const layer of lockedLayers) if (entityTouchesLayer(entity, layer)) return true;
  return false;
}
