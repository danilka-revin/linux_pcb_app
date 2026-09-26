// 3D предпросмотр платы — Three.js и типизированные OrbitControls.
import { useEffect, useRef, useState } from 'react';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as THREE from 'three';
import type { Comp, Doc } from '../pcb/model';
import { createComponentModel } from './component-model-3d';
import { compTF } from '../pcb/expand';
import { zOrdered } from '../pcb/render';
import { BOARD_2D_THEMES, drawBoard2D, type Board2DThemeId } from './board-preview-2d';
import { collectBoardHoles, createBoardGeometry } from './board-geometry-3d';
import { buildExportRoot, exportBaseName, exportGLB, exportOBJZip, type Model3DFormat } from './board-export-3d';
import { download } from '../pcb/zip';

/** Без полей и растяжения: вся текстура соответствует поверхности платы. */
export function createBoardTexture(doc: Doc, themeId: Board2DThemeId, side: 'top' | 'bottom'): THREE.CanvasTexture {
  const theme = BOARD_2D_THEMES.find(t => t.id === themeId) || BOARD_2D_THEMES[0];
  const scale = 2048 / Math.max(doc.w, doc.h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(doc.w * scale));
  canvas.height = Math.max(1, Math.round(doc.h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Не удалось создать текстуру платы.');
  // Компенсация округления размера canvas; геометрия остаётся в миллиметрах.
  ctx.setTransform(canvas.width / doc.w, 0, 0, canvas.height / doc.h, 0, 0);
  drawBoard2D(ctx, doc, zOrdered(doc), theme, {
    side, hidden: new Set(['outline']), showHoles: true, showMask: true, showGrid: false,
    scale: 1, offsetX: 0, offsetY: 0, width: doc.w, height: doc.h,
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Центр условного корпуса с учётом локального bbox, поворота и стороны. */
export function componentBody(e: Comp, thickness: number) {
  const w = Math.max(1, e.bl[2] - e.bl[0]);
  const h = Math.max(1, e.bl[3] - e.bl[1]);
  const depth = 2.5;
  const center = compTF(e)({ x: (e.bl[0] + e.bl[2]) / 2, y: (e.bl[1] + e.bl[3]) / 2 });
  return { w, h, depth, x: center.x, y: center.y, z: (e.side === 'bottom' ? -1 : 1) * (thickness + depth) / 2 };
}

/** Освобождаем и геометрию, и текстуры; общие материалы — только один раз. */
export function disposePreviewScene(scene: THREE.Scene): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  scene.traverse(obj => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
      geometries.add(obj.geometry);
      for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        materials.add(material);
        if (material instanceof THREE.MeshStandardMaterial && material.map) textures.add(material.map);
      }
    }
  });
  textures.forEach(texture => texture.dispose());
  materials.forEach(material => material.dispose());
  geometries.forEach(geometry => geometry.dispose());
  scene.clear();
}

export function BoardPreview3D({ doc, height = 520 }: { doc: Doc; width?: number; height?: number }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const componentsRef = useRef<THREE.Group | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const [themeId, setThemeId] = useState<Board2DThemeId>('green');
  const [thickness, setThickness] = useState(1.6);
  const [showComponents, setShowComponents] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [exporting, setExporting] = useState<Model3DFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const options = useRef({ showComponents, autoRotate, wireframe });
  options.current = { showComponents, autoRotate, wireframe };
  const theme = BOARD_2D_THEMES.find(t => t.id === themeId)!;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let cancelled = false;
    let raf = 0;
    let renderer: THREE.WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;
    let scene: THREE.Scene | null = null;
    let observer: ResizeObserver | null = null;
    setReady(false);
    setError(null);

    const dispose = () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      observer = null;
      if (controlsRef.current === controls) controlsRef.current = null;
      controls?.dispose();
      controls = null;
      if (sceneRef.current === scene) {
        sceneRef.current = null;
        componentsRef.current = null;
        resetRef.current = null;
      }
      if (scene) disposePreviewScene(scene);
      scene = null;
      if (renderer) {
        renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        renderer = null;
      }
    };
    const fail = (message: string) => {
      dispose();
      if (!cancelled) { setReady(false); setError(message); }
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      fail('Браузер потерял графический контекст. Попробуйте запустить 3D ещё раз.');
    };

    async function init() {
      try {
        // Нет any: неверную сигнатуру конструктора теперь поймает TypeScript.
        const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
        if (cancelled) return;
        if (!Number.isFinite(doc.w) || !Number.isFinite(doc.h) || doc.w <= 0 || doc.h <= 0) {
          throw new Error('Для 3D нужны положительные размеры платы.');
        }
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('webgl2', { antialias: true, alpha: false });
        if (!context) throw new Error('WebGL 2 недоступен. Включите аппаратное ускорение в браузере или откройте плату в браузере с поддержкой WebGL 2.');
        renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.domElement.setAttribute('aria-label', 'Объёмная модель платы');
        renderer.domElement.addEventListener('webglcontextlost', onContextLost);
        mount!.appendChild(renderer.domElement);

        scene = new THREE.Scene();
        scene.background = new THREE.Color(theme.bg);
        sceneRef.current = scene;
        const extent = Math.max(doc.w, doc.h, thickness, 1);
        const camera = new THREE.PerspectiveCamera(45, 1, Math.max(0.01, extent / 1000), extent * 100);
        camera.up.set(0, 0, 1);
        // Конструктор принимает только камеру и DOM-элемент, не свой класс.
        controls = new OrbitControls(camera, renderer.domElement);
        controlsRef.current = controls;
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.autoRotate = options.current.autoRotate;
        controls.autoRotateSpeed = 1.2;
        controls.minDistance = extent * 0.15;
        controls.maxDistance = extent * 12;
        const assemblyBounds = new THREE.Box3(new THREE.Vector3(0, 0, -thickness / 2), new THREE.Vector3(doc.w, doc.h, thickness / 2));
        const fit = () => {
          if (!controls) return;
          const fov = THREE.MathUtils.degToRad(camera.fov);
          const angle = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * camera.aspect));
          const distance = assemblyBounds.getSize(new THREE.Vector3()).length() / 2 / Math.sin(angle / 2) * 1.15;
          assemblyBounds.getCenter(controls.target);
          camera.position.copy(controls.target).add(new THREE.Vector3(0.3, -0.65, 1).normalize().multiplyScalar(distance));
          controls.update();
          controls.saveState();
        };
        resetRef.current = fit;
        scene.add(new THREE.AmbientLight(0xffffff, 1.5));
        const key = new THREE.DirectionalLight(0xffffff, 2.5);
        key.position.set(extent, -extent, extent * 2);
        scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 1.5);
        fill.position.set(-extent, extent, -extent * 2);
        scene.add(fill);

        // Имена материалов попадают в экспорт GLB/OBJ.
        const edgeMat = new THREE.MeshStandardMaterial({ name: 'pcb_edge', color: theme.boardEdge, roughness: 0.8 });
        const topMat = new THREE.MeshStandardMaterial({ name: 'pcb_top', roughness: 0.65, metalness: 0.1 });
        const bottomMat = new THREE.MeshStandardMaterial({ name: 'pcb_bottom', roughness: 0.65, metalness: 0.1 });
        // Металлизация стенок отверстий: лужёная медь, видна насквозь.
        const platedMat = new THREE.MeshStandardMaterial({ name: 'pcb_plating', color: '#c9a35a', metalness: 0.8, roughness: 0.35 });
        // Порядок материалов совпадает с BOARD_GROUP: верх, низ, торец/голые стенки, металлизация.
        const { geometry: boardGeometry, holes } = createBoardGeometry(doc.w, doc.h, thickness, collectBoardHoles(doc));
        const board = new THREE.Mesh(boardGeometry, [topMat, bottomMat, edgeMat, platedMat]);
        board.name = 'board';
        board.userData.holes = holes.length;
        // Присоединяем ресурсы до генерации текстур, чтобы catch их освободил.
        scene.add(board);
        topMat.map = createBoardTexture(doc, themeId, 'top');
        bottomMat.map = createBoardTexture(doc, themeId, 'bottom');
        for (const texture of [topMat.map, bottomMat.map]) texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());

        const components = new THREE.Group();
        components.visible = options.current.showComponents;
        componentsRef.current = components;
        scene.add(components);
        for (const e of doc.entities) {
          if (e.kind !== 'comp') continue;
          components.add(createComponentModel(e, thickness));
        }
        components.updateMatrixWorld(true);
        assemblyBounds.union(new THREE.Box3().setFromObject(components));
        scene.traverse(obj => {
          if (!(obj instanceof THREE.Mesh)) return;
          for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
            if (material instanceof THREE.MeshStandardMaterial) material.wireframe = options.current.wireframe;
          }
        });
        const resize = () => {
          if (!renderer) return;
          const w = Math.max(1, mount!.clientWidth), h = Math.max(1, mount!.clientHeight);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h, false);
        };
        resize();
        fit();
        observer = new ResizeObserver(() => { resize(); fit(); });
        observer.observe(mount!);
        let lastTime = performance.now();
        const animate = (time: number) => {
          if (cancelled || !renderer || !scene || !controls) return;
          try {
            controls.update(Math.min((time - lastTime) / 1000, 0.1));
            lastTime = time;
            renderer.render(scene, camera);
            raf = requestAnimationFrame(animate);
          } catch {
            fail('Не удалось отрисовать 3D. Попробуйте запустить просмотр ещё раз.');
          }
        };
        // Проверяем первый кадр до снятия индикатора загрузки.
        renderer.render(scene, camera);
        setReady(true);
        raf = requestAnimationFrame(animate);
      } catch (cause) {
        if (!cancelled) fail(cause instanceof Error ? cause.message : 'Не удалось запустить 3D-просмотр.');
      }
    }
    void init();
    return () => { cancelled = true; dispose(); };
  }, [doc, themeId, thickness, attempt, theme.bg, theme.boardEdge]);

  // Эти переключатели не пересоздают WebGL-контекст и не сбрасывают камеру.
  useEffect(() => {
    if (controlsRef.current) controlsRef.current.autoRotate = autoRotate;
    if (componentsRef.current) componentsRef.current.visible = showComponents;
    sceneRef.current?.traverse(obj => {
      if (!(obj instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        if (material instanceof THREE.MeshStandardMaterial) material.wireframe = wireframe;
      }
    });
  }, [autoRotate, showComponents, wireframe]);

  // Экспорт того, что на экране: плата, текстуры и (если включены) детали.
  const exportModel = async (format: Model3DFormat) => {
    const board = sceneRef.current?.getObjectByName('board');
    if (!board || exporting) return;
    setExporting(format);
    setExportError(null);
    try {
      const base = exportBaseName(doc.name);
      const root = buildExportRoot(doc, board, componentsRef.current, format === 'glb' ? 0.001 : 1);
      if (format === 'glb') download(`${base}_3d.glb`, await exportGLB(root));
      else download(`${base}_3d_obj.zip`, await exportOBJZip(root, base));
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : 'Не удалось экспортировать 3D-модель.');
    } finally {
      setExporting(null);
    }
  };

  return <div className="board-preview-3d">
    <div className="bp3d-toolbar">
      <div className="bp3d-row">
        <label>Тема:
          <select aria-label="Тема 3D-платы" value={themeId} onChange={e => setThemeId(e.target.value as Board2DThemeId)}>
            {BOARD_2D_THEMES.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label>Толщина:
          <select aria-label="Толщина 3D-платы" value={thickness} onChange={e => setThickness(Number(e.target.value))}>
            {[0.8, 1, 1.6, 2, 3].map(n => <option key={n} value={n}>{n} мм{n === 1.6 ? ' (станд.)' : ''}</option>)}
          </select>
        </label>
        <label className="chk"><input type="checkbox" checked={showComponents} onChange={e => setShowComponents(e.target.checked)} />Детали</label>
        <label className="chk"><input type="checkbox" checked={autoRotate} onChange={e => setAutoRotate(e.target.checked)} />Авто-вращение</label>
        <label className="chk"><input type="checkbox" checked={wireframe} onChange={e => setWireframe(e.target.checked)} />Каркас</label>
        <button className="btn" disabled={!ready} onClick={() => resetRef.current?.()}>Вписать 3D</button>
      </div>
      <div className="bp3d-row">
        <span className="bp3d-export-label">Экспорт модели с текстурами:</span>
        <button className="btn" disabled={!ready || !!exporting} onClick={() => void exportModel('glb')}
          title="glTF 2.0 одним файлом: Blender, Windows 3D Viewer, онлайн-просмотрщики. Единицы — метры, ось Y вверх.">
          {exporting === 'glb' ? 'Экспорт…' : 'GLB (glTF)'}
        </button>
        <button className="btn" disabled={!ready || !!exporting} onClick={() => void exportModel('obj')}
          title="ZIP: .obj + .mtl + текстуры PNG. Единицы — миллиметры, ось Y вверх.">
          {exporting === 'obj' ? 'Экспорт…' : 'OBJ + MTL (zip)'}
        </button>
        <span className="bp3d-export-note">{showComponents ? 'Плата и детали' : 'Только плата (детали скрыты)'}</span>
        {exportError && <span className="bp3d-export-error" role="alert">{exportError}</span>}
      </div>
      <div className="bp3d-hints">ЛКМ — вращение, ПКМ — панорама, колесо — масштаб. Плата {doc.w} × {doc.h} мм.</div>
    </div>
    <div className="bp3d-viewport" style={{ height: `min(${height}px, 50vh)` }}>
      <div ref={mountRef} className="bp3d-canvas-wrap" aria-busy={!ready && !error} />
      {!ready && <div className="bp3d-message" role={error ? 'alert' : 'status'}>
        <strong>{error ? '3D-просмотр недоступен' : 'Загрузка 3D-платы…'}</strong>
        {error && <><p>{error}</p><button className="btn" onClick={() => setAttempt(n => n + 1)}>Повторить запуск 3D</button><p>Послойный просмотр доступен на вкладке 2D.</p></>}
      </div>}
    </div>
    <div className="bp3d-legend">
      <span className="bp3d-swatch" style={{ background: theme.copperTop }} /> Медь K1
      <span className="bp3d-swatch" style={{ background: theme.copperBottom }} /> K2
      <span className="bp3d-swatch" style={{ background: theme.board }} /> Подложка
      <span>Корпуса с текстурами — приближённые, по типу и посадочному месту; не модели производителя. Отверстия сверловки — сквозные, металлизированные показаны медью.</span>
    </div>
  </div>;
}
