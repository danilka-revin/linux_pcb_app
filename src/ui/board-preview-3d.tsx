// 3D предпросмотр платы — Three.js, OrbitControls, реалистичные материалы.
import { useEffect, useRef, useState, useMemo } from 'react';
import type { Doc } from '../pcb/model';
import { BOARD_2D_THEMES, type Board2DThemeId } from './board-preview-2d';
import * as THREE from 'three';

// Динамический импорт OrbitControls чтобы не тянуть в SSR
let OrbitControls: any = null;

async function loadOrbitControls() {
  if (OrbitControls) return OrbitControls;
  const mod = await import('three/addons/controls/OrbitControls.js');
  OrbitControls = mod.OrbitControls;
  return OrbitControls;
}

function createBoardTexture(
  doc: Doc,
  themeId: Board2DThemeId,
  side: 'top' | 'bottom',
  width = 1024,
  height = 1024
): THREE.CanvasTexture {
  const theme = BOARD_2D_THEMES.find(t => t.id === themeId) || BOARD_2D_THEMES[0];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  // Фон — маска
  ctx.fillStyle = side === 'top' ? theme.maskTop : theme.maskBottom;
  // Для реалистичности — подложка маски уже содержит цвет платы
  // Рисуем плату
  const pad = 20;
  const scaleX = (width - pad * 2) / doc.w;
  const scaleY = (height - pad * 2) / doc.h;
  const scale = Math.min(scaleX, scaleY);
  const offX = (width - doc.w * scale) / 2;
  const offY = (height - doc.h * scale) / 2;

  // Board base
  ctx.fillStyle = theme.board;
  ctx.fillRect(0, 0, width, height);

  // Copper and silk from doc
  const drawEnt = (e: any) => {
    const layer = e.layer;
    let color: string | null = null;
    if (e.kind === 'pad' || e.kind === 'via') color = theme.copperBoth;
    else if (e.kind === 'hole') color = theme.hole;
    else if (layer === 'k1' && side === 'top') color = theme.copperTop;
    else if (layer === 'k2' && side === 'bottom') color = theme.copperBottom;
    else if (layer === 's1' && side === 'top') color = theme.silkTop;
    else if (layer === 's2' && side === 'bottom') color = theme.silkBottom;
    else if (layer === 'outline') color = theme.outline;
    else if (e.kind === 'track' && e.layer === (side === 'top' ? 'k1' : 'k2')) color = side === 'top' ? theme.copperTop : theme.copperBottom;
    else if (e.kind === 'smd' && e.layer === (side === 'top' ? 'k1' : 'k2')) color = side === 'top' ? theme.copperTop : theme.copperBottom;
    if (!color) return;

    const sx = (x: number) => offX + x * scale;
    const sy = (y: number) => offY + (doc.h - y) * scale;

    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    switch (e.kind) {
      case 'pad': {
        const x = sx(e.x), y = sy(e.y), r = (e.size / 2) * scale;
        ctx.beginPath();
        if (e.shape === 'square') ctx.rect(x - r, y - r, r * 2, r * 2);
        else ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'via': {
        ctx.beginPath();
        ctx.arc(sx(e.x), sy(e.y), (e.size / 2) * scale, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'smd': {
        const rot = ((Math.round(e.rot) % 180) + 180) % 180;
        const w = (rot === 0 ? e.w : e.h) * scale;
        const h = (rot === 0 ? e.h : e.w) * scale;
        ctx.fillRect(sx(e.x) - w / 2, sy(e.y) - h / 2, w, h);
        break;
      }
      case 'track': {
        if (e.pts.length < 2) break;
        ctx.lineWidth = Math.max(e.w * scale, 1.5);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(sx(e.pts[0].x), sy(e.pts[0].y));
        for (let i = 1; i < e.pts.length; i++) ctx.lineTo(sx(e.pts[i].x), sy(e.pts[i].y));
        ctx.stroke();
        break;
      }
      case 'line': {
        ctx.lineWidth = Math.max(e.w * scale, 1);
        ctx.beginPath();
        ctx.moveTo(sx(e.x1), sy(e.y1));
        ctx.lineTo(sx(e.x2), sy(e.y2));
        ctx.stroke();
        break;
      }
      case 'rect': {
        const x1 = sx(e.x), y1 = sy(e.y + e.h);
        const wpx = e.w * scale, hpx = e.h * scale;
        if (e.filled) ctx.fillRect(x1, y1, wpx, hpx);
        else {
          ctx.lineWidth = Math.max(e.th * scale, 1);
          ctx.strokeRect(x1, y1, wpx, hpx);
        }
        break;
      }
      case 'hole': {
        ctx.fillStyle = theme.hole;
        ctx.beginPath();
        ctx.arc(sx(e.x), sy(e.y), (e.d / 2) * scale, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'circle': {
        ctx.lineWidth = Math.max(e.w * scale, 1);
        ctx.beginPath();
        ctx.arc(sx(e.x), sy(e.y), e.r * scale, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'poly': {
        if (e.pts.length < 3) break;
        ctx.beginPath();
        ctx.moveTo(sx(e.pts[0].x), sy(e.pts[0].y));
        for (let i = 1; i < e.pts.length; i++) ctx.lineTo(sx(e.pts[i].x), sy(e.pts[i].y));
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'text': {
        if (!e.text) break;
        ctx.save();
        ctx.translate(sx(e.x), sy(e.y));
        ctx.rotate((-e.rot * Math.PI) / 180);
        ctx.font = `${e.size * scale}px sans-serif`;
        ctx.fillText(e.text, 0, 0);
        ctx.restore();
        break;
      }
    }
  };

  // Draw copper and silk
  for (const e of doc.entities) {
    if (e.kind === 'comp') {
      // Expand comp manually simple
      const comp = e as any;
      for (const sub of comp.ents || []) {
        // Transform sub by comp position/rot
        // Simplified: just offset
        const subCopy = { ...sub, x: sub.x + comp.x, y: sub.y + comp.y };
        if (sub.x1 !== undefined) {
          subCopy.x1 = sub.x1 + comp.x;
          subCopy.y1 = sub.y1 + comp.y;
          subCopy.x2 = sub.x2 + comp.x;
          subCopy.y2 = sub.y2 + comp.y;
        }
        if (sub.pts) {
          subCopy.pts = sub.pts.map((p: any) => ({ x: p.x + comp.x, y: p.y + comp.y }));
        }
        drawEnt(subCopy);
      }
    } else {
      drawEnt(e);
    }
  }

  // Outline
  ctx.strokeStyle = theme.outline;
  ctx.lineWidth = 2;
  ctx.strokeRect(offX, offY, doc.w * scale, doc.h * scale);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function BoardPreview3D({
  doc,
  width = 800,
  height = 600,
}: {
  doc: Doc;
  width?: number;
  height?: number;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const [themeId, setThemeId] = useState<Board2DThemeId>('green');
  const [thickness, setThickness] = useState(1.6);
  const [showComponents, setShowComponents] = useState(true);
  const [autoRotate, setAutoRotate] = useState(false);
  const [wireframe, setWireframe] = useState(false);

  const theme = useMemo(() => BOARD_2D_THEMES.find(t => t.id === themeId) || BOARD_2D_THEMES[0], [themeId]);

  useEffect(() => {
    let mounted = true;
    let raf = 0;
    let controls: any;
    let boardMesh: THREE.Mesh;

    async function init() {
      const Orbit = await loadOrbitControls();
      if (!mounted || !mountRef.current) return;

      // Scene
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(theme.bg);
      sceneRef.current = scene;

      // Camera
      const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
      camera.position.set(doc.w * 0.6, doc.h * 0.6, Math.max(doc.w, doc.h) * 1.2);

      // Renderer
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setSize(width, height);
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      mountRef.current.innerHTML = '';
      mountRef.current.appendChild(renderer.domElement);
      rendererRef.current = renderer;

      // Lights
      const ambient = new THREE.AmbientLight(0xffffff, 0.6);
      scene.add(ambient);
      const dir = new THREE.DirectionalLight(0xffffff, 0.9);
      dir.position.set(20, 30, 20);
      dir.castShadow = true;
      dir.shadow.mapSize.set(2048, 2048);
      scene.add(dir);
      const dir2 = new THREE.DirectionalLight(0xffffff, 0.4);
      dir2.position.set(-20, -10, -15);
      scene.add(dir2);

      // Controls
      controls = new Orbit(Orbit, camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.target.set(doc.w / 2, doc.h / 2, 0);

      // Board geometry
      const boardGeo = new THREE.BoxGeometry(doc.w, doc.h, thickness);
      // Create textures
      const topTex = createBoardTexture(doc, themeId, 'top', 1024, 1024);
      const bottomTex = createBoardTexture(doc, themeId, 'bottom', 1024, 1024);

      // Materials for 6 faces: right, left, top, bottom, front, back
      // BoxGeometry order: +x, -x, +y, -y, +z, -z
      // We want top/bottom to be textured, sides to be board edge color
      const edgeMat = new THREE.MeshStandardMaterial({ color: theme.boardEdge, roughness: 0.8, metalness: 0.1 });
      const topMat = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.6, metalness: 0.15 });
      const bottomMat = new THREE.MeshStandardMaterial({ map: bottomTex, roughness: 0.6, metalness: 0.15 });

      const materials = [
        edgeMat, // +x
        edgeMat, // -x
        edgeMat, // +y (board height y in Three = doc.h? Actually Box y = doc.h, but we map)
        edgeMat, // -y
        topMat, // +z = top
        bottomMat, // -z = bottom
      ];

      boardMesh = new THREE.Mesh(boardGeo, materials);
      boardMesh.position.set(doc.w / 2, doc.h / 2, 0);
      boardMesh.castShadow = true;
      boardMesh.receiveShadow = true;
      // Rotate so board lies flat: Box is already oriented with z as thickness
      scene.add(boardMesh);

      // Components as simple boxes
      if (showComponents) {
        for (const e of doc.entities) {
          if (e.kind !== 'comp') continue;
          const comp = e as any;
          const w = comp.bl ? comp.bl[2] - comp.bl[0] : 5;
          const h = comp.bl ? comp.bl[3] - comp.bl[1] : 5;
          const compGeo = new THREE.BoxGeometry(Math.max(1, w), Math.max(1, h), thickness * 0.8 + 1.2);
          const compMat = new THREE.MeshStandardMaterial({
            color: comp.side === 'bottom' ? '#222222' : '#1a1a1a',
            roughness: 0.7,
            metalness: 0.1,
          });
          const mesh = new THREE.Mesh(compGeo, compMat);
          mesh.position.set(comp.x, comp.y, comp.side === 'bottom' ? -thickness / 2 - 0.6 : thickness / 2 + 0.6);
          mesh.rotation.z = (comp.rot * Math.PI) / 180;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          scene.add(mesh);

          // Add small colored top for ICs
          if (w > 2 && h > 2) {
            const topGeo = new THREE.BoxGeometry(w * 0.9, h * 0.9, 0.3);
            const topMat = new THREE.MeshStandardMaterial({ color: '#333333', roughness: 0.5 });
            const topMesh = new THREE.Mesh(topGeo, topMat);
            topMesh.position.set(0, 0, 0.7);
            mesh.add(topMesh);
          }
        }
      }

      // Grid helper
      const grid = new THREE.GridHelper(Math.max(doc.w, doc.h) * 2, 20, 0x444444, 0x222222);
      grid.rotation.x = Math.PI / 2;
      grid.position.set(doc.w / 2, doc.h / 2, -thickness / 2 - 0.1);
      scene.add(grid);

      const animate = () => {
        raf = requestAnimationFrame(animate);
        if (autoRotate) {
          boardMesh.rotation.z += 0.003;
        }
        controls.update();
        renderer.render(scene, camera);
      };
      animate();

      const onResize = () => {
        if (!mountRef.current) return;
        const w = mountRef.current.clientWidth;
        const h = mountRef.current.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }

    init();

    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
      if (controls) controls.dispose();
      if (rendererRef.current) {
        rendererRef.current.dispose();
        rendererRef.current.domElement.remove();
      }
      if (sceneRef.current) {
        sceneRef.current.traverse((obj: any) => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose());
            else obj.material.dispose();
          }
        });
      }
    };
  }, [doc, themeId, thickness, showComponents, autoRotate, width, height, theme.bg, theme.boardEdge, doc.w, doc.h]);

  // Wireframe toggle effect
  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.traverse((obj: any) => {
      if (obj.isMesh && obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m: any) => {
          if (m.wireframe !== undefined) m.wireframe = wireframe;
        });
      }
    });
  }, [wireframe]);

  return (
    <div className="board-preview-3d">
      <div className="bp3d-toolbar">
        <div className="bp3d-row">
          <label>Тема:
            <select value={themeId} onChange={e => setThemeId(e.target.value as Board2DThemeId)}>
              {BOARD_2D_THEMES.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label>Толщина:
            <select value={thickness} onChange={e => setThickness(parseFloat(e.target.value))}>
              <option value="0.8">0.8 мм</option>
              <option value="1.0">1.0 мм</option>
              <option value="1.6">1.6 мм (станд.)</option>
              <option value="2.0">2.0 мм</option>
              <option value="3.0">3.0 мм</option>
            </select>
          </label>
          <label className="chk"><input type="checkbox" checked={showComponents} onChange={e => setShowComponents(e.target.checked)} />Детали</label>
          <label className="chk"><input type="checkbox" checked={autoRotate} onChange={e => setAutoRotate(e.target.checked)} />Авто-вращение</label>
          <label className="chk"><input type="checkbox" checked={wireframe} onChange={e => setWireframe(e.target.checked)} />Каркас</label>
        </div>
        <div className="bp3d-hints">ЛКМ — вращение, ПКМ — панорама, колесо — масштаб. Плата {doc.w}×{doc.h} мм, толщина {thickness} мм.</div>
      </div>
      <div ref={mountRef} className="bp3d-canvas-wrap" style={{ width, height, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line)' }} />
      <div className="bp3d-legend">
        <span className="bp3d-swatch" style={{ background: theme.copperTop }} /> Медь K1
        <span className="bp3d-swatch" style={{ background: theme.copperBottom }} /> K2
        <span className="bp3d-swatch" style={{ background: theme.board }} /> Подложка
      </div>
    </div>
  );
}
