import {
  Viewer,
  DefaultViewerParams,
  SpeckleLoader,
  UrlHelper,
  TreeNode, // Représente un nœud d'arbre dans le modèle 3D
  CameraController,
  SectionTool,
  SectionOutlines,
  SelectionExtension,
  WebXrViewer,
  NearPlaneCalculation,
  BatchObject,
  Extension,
  ViewerEvent
} from '@speckle/viewer';

//import { makeMeasurementsUI } from './MeasurementsUI'; // Interface utilisateur pour les mesures
import { Box3, Quaternion, Vector3, Euler } from 'three'; // Utilisé pour gérer des boîtes englobantes en 3D
import { Pane } from 'tweakpane'; // Bibliothèque pour créer une interface utilisateur (boutons, menus, etc.)
import * as THREE from 'three'; // on va créer un Group et l'utiliser
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory';



interface Param {
  id: string;
  name: string;
  units: number;
  value: string;
  speckletype: string;
  internalDefinitionName?: string;
}

// ===== App version (déclarée tout en haut) =====
export const APP_VERSION = 'V2.0.0';

// Ecrit la version dans le badge (dès que le DOM est prêt)
const putVersion = () => {
  const badge = document.getElementById('app-version');
  if (badge) badge.textContent = APP_VERSION;
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', putVersion, { once: true });
} else {
  putVersion();
}


// Petits helpers de type
type Dict = Record<string, unknown>;
function isObj(x: unknown): x is Dict { return !!x && typeof x === 'object' && !Array.isArray(x); }
function sameName(a: string, b: string) {
  const norm = (s: string) => String(s).toLowerCase().replace(/[\s_]/g, '');
  return norm(a) === norm(b);
}

// Convertit n’importe quel “param-like” Speckle vers TON interface Param
function toParam(found: unknown, fallbackName: string): Param {
  const o = isObj(found) ? found : {};
  const name = typeof o['name'] === 'string' ? (o['name'] as string) : fallbackName;

  const valueRaw =
    o['value'] ??
    // parfois c’est directement la valeur si clé = "URL_PANO": "http..."
    (typeof found !== 'object' ? found : undefined);

  const internal = typeof o['internalDefinitionName'] === 'string'
    ? (o['internalDefinitionName'] as string)
    : undefined;

  const id =
    (typeof o['id'] === 'string' && o['id']) ? (o['id'] as string)
    : internal && internal.trim() ? internal
    : name;

  const units =
    (typeof o['units'] === 'number' ? (o['units'] as number) : 0);

  const speckleType =
    (typeof o['speckle_type'] === 'string' ? (o['speckle_type'] as string)
     : typeof o['speckletype'] === 'string' ? (o['speckletype'] as string)
     : 'Objects.Other.Parameter');

  return {
    id,
    name,
    units,
    value: valueRaw != null ? String(valueRaw) : '',
    speckletype: speckleType,
    internalDefinitionName: internal
  };
}

// Ajouter une nouvelle liste déroulante dans le Pane
const downloadOptions = [
  {
    text: 'Revit',
    value: 'https://mega.nz/file/1SthTC4T#tg9PVrAJnxciXXn23FWxM4kIRjdEQFxineIrRjrYqMA',
  }, // Remplacez par l'URL réelle
  {
    text: 'Autocad',
    value:
      'https://mega.nz/file/MGUUBQDb#yi4V7tnzlpFqCSVkPcngjnrvJkGybriJ-qXAWMzgrW0',
  }, // Remplacez par l'URL réelle
  {
    text: 'Sketchup',
    value:
      'https://mega.nz/file/la0lDC4C#i3dX4ziBr0YU0e2-PCNJIaAkKpQtwZqLoSrM59DQ_20',
  }, // Remplacez par l'URL réelle
  {
    text: 'Ifc',
    value:
      'https://mega.nz/file/AL9U1DBY#MD1Vzb4VwfUGTycO0O65wCRKqqbYMbXRo-PNbl3qIhI',
  }, // Remplacez par l'URL réelle
];

function applyAxisFix(viewer: Viewer): boolean {
  try {
    console.log('[VR] Applying Z-up → Y-up axis fix...');

    const renderer = viewer.getRenderer();
    const objects = renderer.getObjects() as BatchObject[];
    console.log('[VR] Batch objects count =', objects?.length ?? 0);

    if (!objects?.length) {
      console.warn('[VR] No batch objects found; skip axis fix for now');
      return false;
    }

    const origin = new Vector3().copy((viewer as any).World?.worldOrigin ?? new Vector3());

    // Aligner Y (three) -> -Z (Speckle)  =>  Z-up -> Y-up
    const quat = new Quaternion().setFromUnitVectors(
      new Vector3(0, 1, 0),
      new Vector3(0, 0, -1)
    );
    const eul = new Euler().setFromQuaternion(quat);

    let count = 0;
    for (const obj of objects) {
      obj.transformTRS(
        new Vector3(0, 0, 0), // pos
        eul,                  // rot
        undefined,            // scale
        origin                // pivot
      );
      count++;
    }

    console.log(`[VR] Up-axis fix applied to ${count} objects (Z-up → Y-up).`);
    viewer.requestRender();
    return true;
  } catch (err) {
    console.error('[VR] Axis fix failed:', err);
    return false;
  }
}

// même quat que dans applyAxisFix (Y_three → -Z_speckle)
const AXIS_FIX_QUAT = new Quaternion().setFromUnitVectors(
  new Vector3(0, 1, 0),
  new Vector3(0, 0, -1)
);

// Speckle cm (Z-up) -> Three meters (Y-up), avec même pivot que l'axis-fix
function specklePointToThreeMeters(viewer: Viewer, locCm: {x:number;y:number;z:number}) {
  const origin = (viewer as any).World?.worldOrigin ?? new Vector3(); // en cm
  const p = new Vector3(locCm.x, locCm.y, locCm.z);
  p.sub(origin);                // même pivot que transformTRS(...)
  p.applyQuaternion(AXIS_FIX_QUAT); // même rotation (Z-up -> Y-up)
  p.multiplyScalar(0.01);       // cm -> m
  return p;
}

// Fonction pour créer un panneau de debug visible en VR
function createDebugPanel(): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  const ctx = canvas.getContext('2d')!;
  
  // Fond semi-transparent plus visible
  ctx.fillStyle = 'rgba(0,0,0,0.9)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Bordure
  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  
  ctx.fillStyle = '#00ff00';
  ctx.font = '32px monospace';
  ctx.fillText('DEBUG VR CONSOLE', 20, 40);
  
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.MeshBasicMaterial({ 
    map: texture, 
    transparent: true,
    depthTest: false,
    depthWrite: false
  });
  const geometry = new THREE.PlaneGeometry(1.6, 1.2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'DEBUG_PANEL';
  mesh.renderOrder = 999;
  
  return mesh;
}

// Système de logs persistants pour VR
class VRDebugLogger {
  private logs: Array<{ text: string; timestamp: number }> = [];
  private maxLogs = 50; // Nombre max de lignes
  private logLifetime = 10000; // 10 secondes de vie minimum

  addLog(text: string) {
    const now = Date.now();
    this.logs.push({ text, timestamp: now });
    
    // Nettoyer les vieux logs (mais garder au moins les 20 derniers)
    if (this.logs.length > this.maxLogs) {
      const cutoff = now - this.logLifetime;
      const oldLogs = this.logs.filter(log => log.timestamp < cutoff);
      const recentLogs = this.logs.filter(log => log.timestamp >= cutoff);
      
      // Garder 20 logs récents + les logs importants
      if (recentLogs.length > 20) {
        this.logs = recentLogs;
      } else {
        this.logs = [...oldLogs.slice(-10), ...recentLogs];
      }
    }
  }

  addLogs(texts: string[]) {
    texts.forEach(text => this.addLog(text));
  }

  getRecentLogs(): string[] {
    return this.logs.map(log => {
      const age = (Date.now() - log.timestamp) / 1000;
      return `[${age.toFixed(1)}s] ${log.text}`;
    });
  }

  addPersistentLog(text: string) {
    // Log qui ne sera jamais supprimé automatiquement
    this.logs.unshift({ text: `[PERSIST] ${text}`, timestamp: Date.now() + 999999999 });
  }
}

// Instance globale
const vrLogger = new VRDebugLogger();

// Fonction améliorée pour mettre à jour le debug
function updateDebugPanel(debugMesh: THREE.Mesh | null, newLines?: string[]) {
  if (!debugMesh) return;
  
  // Ajouter les nouveaux logs
  if (newLines) {
    vrLogger.addLogs(newLines);
  }
  
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  const ctx = canvas.getContext('2d')!;
  
  // Fond
  ctx.fillStyle = 'rgba(0,0,0,0.9)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Bordure
  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  
  // Titre
  ctx.fillStyle = '#00ff00';
  ctx.font = 'bold 24px monospace';
  ctx.fillText(`DEBUG VR - Total logs: ${vrLogger.getRecentLogs().length}`, 20, 30);
  
  // Lignes de debug persistantes
  ctx.font = '16px monospace';
  const allLogs = vrLogger.getRecentLogs();
  allLogs.forEach((line, i) => {
    if (i < 30) { // Afficher max 30 lignes
      // Couleur selon l'âge du log
      if (line.includes('[PERSIST]')) {
        ctx.fillStyle = '#ff0000'; // Rouge pour les logs persistants
      } else if (line.includes('[0.') || line.includes('[1.')) {
        ctx.fillStyle = '#00ff00'; // Vert pour les logs récents
      } else {
        ctx.fillStyle = '#888888'; // Gris pour les logs plus anciens
      }
      
      ctx.fillText(line.substring(0, 80), 10, 55 + (i * 18));
    }
  });
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  (debugMesh.material as THREE.MeshBasicMaterial).map = texture;
  (debugMesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
}

async function main() {
  let btnUrlDoc: any = null;
  // --- UI VR: état/menu ---
  let vrMenu: THREE.Mesh | null = null;
  let vrMenuNeedsAttach = false;  // pour l'ajouter à la scène après session
  let vrMenuVisible = false;

  // mémorisation de l'état précédent des boutons pour détecter l'appui (front montant)
  let prevRightA = false;
  let prevRightB = false;
  let debugText: THREE.Mesh | null = null; // Pour afficher du texte de debug en VR

   // Afficher le spinner au chargement initial
   const spinnerContainer = document.getElementById("spinner-container");
   if (spinnerContainer) {
     spinnerContainer.style.display = "block";
   }

  /** Get the HTML container */
  const container = document.getElementById('renderer') as HTMLElement;

  /** Configurer les paramètres du viewer */
  const params = DefaultViewerParams;
  params.verbose = true;
  /** Create Viewer instance */
  const viewer = new WebXrViewer(container, params);
  /** Initialise the viewer */
  await viewer.init();

  // Get the underlying Three.js renderer from the Speckle Viewer
  // @ts-ignore
  const threeRenderer = viewer.getRenderer().renderer;

  // @ts-ignore
  const threeScene = viewer.getRenderer().scene;
  if (threeScene) threeScene.background = new (await import('three')).Color(0xffffff);


  //Active WebXR coté Three
  threeRenderer.xr.enabled = true;
  threeRenderer.xr.setReferenceSpaceType?.('local-floor'); // important
  console.log('WebXR enabled:', threeRenderer.xr.enabled);
  console.log('WebXR reference space type:');
  const scene = viewer.getRenderer().scene;

  /** Add the stock camera controller extension */ 
  const cameraController: CameraController = 
  viewer.createExtension(CameraController); 
  (cameraController as any).options = { 
  nearPlaneCalculation: NearPlaneCalculation.EMPIRIC, 
  };

  // Structure pour gérer l'état des boutons du menu
  interface VRMenuButton {
    id: string;
    originalLabel: string;
    currentLabel: string;
    clicked: boolean;
    bounds: { x: number; y: number; width: number; height: number }; // en pixels canvas
  }

  // État du menu avec les boutons
  class VRMenuState {
    public buttons: VRMenuButton[] = [];
    public hoveredButtonId: string | null = null;
    
    constructor() {
      // Définir les boutons avec leurs positions sur le canvas
      this.buttons = [
        {
          id: 'teleport',
          originalLabel: 'Téléportation',
          currentLabel: 'Téléportation',
          clicked: false,
          bounds: { x: 50, y: 160, width: 924, height: 100 }
        },
        {
          id: 'settings',
          originalLabel: 'Paramètres',
          currentLabel: 'Paramètres',
          clicked: false,
          bounds: { x: 50, y: 300, width: 924, height: 100 }
        },
        {
          id: 'desktop',
          originalLabel: 'Retour Desktop',
          currentLabel: 'Retour Desktop',
          clicked: false,
          bounds: { x: 50, y: 440, width: 924, height: 100 }
        }
      ];
    }
    
    getButtonById(id: string): VRMenuButton | null {
      return this.buttons.find(b => b.id === id) || null;
    }
    
    clickButton(id: string) {
      const button = this.getButtonById(id);
      if (button) {
        button.clicked = true;
      }
    }
    
    resetButton(id: string) {
      const button = this.getButtonById(id);
      if (button) {
        button.clicked = false;
      }
    }
    
    setHovered(id: string | null) {
      this.hoveredButtonId = id;
    }
  }
  
  // Instance globale de l'état du menu
  const menuState = new VRMenuState();

  // --- Sous-menu Téléportation ---
  type MenuMode = 'root' | 'tpList';
  let menuMode: MenuMode = 'root';

  // Un “point de téléportation”
  interface TeleportPoint {
    id: string;
    label: string;
    position: THREE.Vector3;
  }

  const teleportPoints: TeleportPoint[] = [];
  let xrSpawn: THREE.Vector3 | null = null; // enregistré au 1er frame XR

  function buildRootButtons(): VRMenuButton[] {
    return [
      { id: 'teleport', originalLabel: 'Téléportation', currentLabel: 'Téléportation', clicked: false, bounds: { x: 50, y: 160, width: 924, height: 100 } },
      { id: 'settings', originalLabel: 'Paramètres', currentLabel: 'Paramètres', clicked: false, bounds: { x: 50, y: 300, width: 924, height: 100 } },
      { id: 'desktop',  originalLabel: 'Retour Desktop', currentLabel: 'Retour Desktop', clicked: false, bounds: { x: 50, y: 440, width: 924, height: 100 } },
    ];
  }

  function buildTeleportButtons(): VRMenuButton[] {
    const buttons: VRMenuButton[] = [];
    // On espace les items verticalement
    let y = 160;
    for (const tp of teleportPoints) {
      buttons.push({
        id: `tp_${tp.id}`,
        originalLabel: tp.label,
        currentLabel: tp.label,
        clicked: false,
        bounds: { x: 50, y, width: 924, height: 100 }
      });
      y += 140;
    }
    // Bouton retour
    buttons.push({
      id: 'back',
      originalLabel: '← Retour',
      currentLabel: '← Retour',
      clicked: false,
      bounds: { x: 50, y, width: 924, height: 100 }
    });
    return buttons;
  }

  function setMenuMode(mode: MenuMode, vrMenu: THREE.Mesh | null) {
    menuMode = mode;
    menuState.buttons = (mode === 'root') ? buildRootButtons() : buildTeleportButtons();
    if (vrMenu) updateVrMenuPlane(vrMenu);
  }

  // Enregistre/rafraîchit le point “Spawn”
  function upsertSpawnPoint() {
    if (!xrSpawn) return;
    const label = 'Spawn (point de départ)';
    const idx = teleportPoints.findIndex(p => p.id === 'spawn');
    if (idx === -1) teleportPoints.push({ id: 'spawn', label, position: xrSpawn.clone() });
    else teleportPoints[idx].position.copy(xrSpawn);
  }

  // Ajoute / met à jour le point "Scène (objet 1229389)" si le TreeNode est trouvé
  function upsertScenePoint(treeNodeMap: Map<string, any>, viewer: any) {
    vrLogger.addPersistentLog('=== DEBUT UPSERT SCENE ===');
    vrLogger.addPersistentLog(`TreeNodeMap size: ${treeNodeMap.size}`);
    
    const tn = treeNodeMap.get('1229389');
    vrLogger.addPersistentLog(`TreeNode 1229389: ${tn ? 'TROUVÉ ✓' : 'NON TROUVÉ ✗'}`);
    vrLogger.addPersistentLog(`Viewer: ${viewer ? 'TROUVÉ ✓' : 'NON TROUVÉ ✗'}`);
    
    if (!tn) {
      vrLogger.addPersistentLog('ERREUR: TreeNode 1229389 introuvable');
      return;
    }

    vrLogger.addPersistentLog(`TreeNode name: ${tn.model?.raw?.name || 'N/A'}`);

    const center = getWorldCenterOfTreeNode(tn, viewer);
    vrLogger.addPersistentLog(`Center: ${center ? `✓ (${center.x.toFixed(1)}, ${center.y.toFixed(1)}, ${center.z.toFixed(1)})` : '✗ NULL'}`);
    
    if (!center) {
      vrLogger.addPersistentLog('ERREUR: Centre non calculable');
      return;
    }

    const id = 'scene_1229389';
    const label = 'Scène (objet 1229389)';
    const idx = teleportPoints.findIndex(p => p.id === id);
    
    if (idx === -1) {
      teleportPoints.push({ id, label, position: center.clone() });
      vrLogger.addPersistentLog(`✓ Point TP ajouté: ${label}`);
      vrLogger.addPersistentLog(`Total points TP: ${teleportPoints.length}`);
    } else {
      teleportPoints[idx].position.copy(center);
      vrLogger.addPersistentLog(`✓ Point TP mis à jour: ${label}`);
    }
    
    vrLogger.addPersistentLog('=== FIN UPSERT SCENE ===');
  }

  // TP en VR: déplace le referenceSpace pour amener la tête au point cible
  function teleportToWorldPosition(target: THREE.Vector3, threeRenderer: any) {
    const cam: THREE.Camera | any = threeRenderer.xr.getCamera?.();
    if (!cam) return;
    const current = new THREE.Vector3();
    cam.getWorldPosition(current);

    // On déplace le monde de (current - target) pour que la tête arrive sur target
    const delta = current.sub(target);
    const base = threeRenderer.xr.getReferenceSpace?.();
    if (!base) return;

    const offset = base.getOffsetReferenceSpace(new XRRigidTransform({
      x: delta.x, y: delta.y, z: delta.z
    }));
    threeRenderer.xr.setReferenceSpace(offset);
  }

  // Retourne le centre monde d'un TreeNode (si possible)
    function getWorldCenterOfTreeNode(tn: any, viewer: any): THREE.Vector3 | null {
    try {
      const elementId = tn?.model?.raw?.properties?.elementId;
      const objectId  = tn?.model?.id;
      const rawId     = tn?.model?.raw?.id;
      const nodeId    = tn?.id;

      vrLogger.addPersistentLog(`[TP] center(): elementId=${elementId ?? 'N/A'} | objectId=${objectId ?? 'N/A'} | rawId=${rawId ?? 'N/A'} | nodeId=${nodeId ?? 'N/A'}`);

      // ---------- 1) API Speckle: getWorldBoundingBox ----------
      try {
        if (typeof viewer?.getWorldBoundingBox === 'function') {
          const idCandidates: any[] = [
            objectId,              // Speckle object id (souvent le bon)
            nodeId,                // id de TreeNode
            rawId,                 // parfois stocké dans raw.id
          ].filter(Boolean);

          for (const id of idCandidates) {
            const arr = Array.isArray(id) ? id : [id];
            const box = viewer.getWorldBoundingBox(arr);
            if (box && box.isEmpty() === false) {
              const c = new THREE.Vector3(); box.getCenter(c);
              vrLogger.addPersistentLog(`[TP] centre via getWorldBoundingBox([${typeof id}:${String(id)}]) ✓`);
              return c;
            } else {
              vrLogger.addPersistentLog(`[TP] getWorldBoundingBox vide pour id=${String(id)}`);
            }
          }

          // Compat: certaines versions acceptent le node directement
          const boxAlt = viewer.getWorldBoundingBox([tn]);
          if (boxAlt && boxAlt.isEmpty() === false) {
            const c = new THREE.Vector3(); boxAlt.getCenter(c);
            vrLogger.addPersistentLog('[TP] centre via getWorldBoundingBox([tn]) ✓');
            return c;
          } else {
            vrLogger.addPersistentLog('[TP] getWorldBoundingBox([tn]) vide');
          }
        } else {
          vrLogger.addPersistentLog('[TP] getWorldBoundingBox indisponible');
        }
      } catch {
        vrLogger.addPersistentLog('[TP] getWorldBoundingBox a levé une exception');
      }

      // ---------- 2) tn.worldBox / tn.bbox ----------
      try {
        const rawBox = (tn?.worldBox ?? tn?.bbox);
        if (rawBox?.min && rawBox?.max) {
          const box = new THREE.Box3(
            new THREE.Vector3(rawBox.min.x, rawBox.min.y, rawBox.min.z),
            new THREE.Vector3(rawBox.max.x, rawBox.max.y, rawBox.max.z)
          );
          if (!box.isEmpty()) {
            const c = new THREE.Vector3(); box.getCenter(c);
            vrLogger.addPersistentLog('[TP] centre via tn.worldBox/tn.bbox ✓');
            return c;
          } else {
            vrLogger.addPersistentLog('[TP] tn.worldBox/tn.bbox présent mais vide');
          }
        } else {
          vrLogger.addPersistentLog('[TP] tn.worldBox/tn.bbox indisponible');
        }
      } catch {
        vrLogger.addPersistentLog('[TP] lecture tn.bbox a échoué');
      }

      // ---------- 3) Fallback Three.js : scan de la scène ----------
      try {
        const three = (viewer as any).getRenderer?.() ?? (viewer as any).renderer ?? undefined;
        const scene: THREE.Scene | undefined =
          (three?.scene as THREE.Scene | undefined) ??
          (three?.renderer?.scene as THREE.Scene | undefined);

        if (!scene) {
          vrLogger.addPersistentLog('[TP] scène Three.js indisponible (fallback impossible)');
        } else {
          // on tente avec plusieurs clés connues
          const wantedStrings = new Set(
            [elementId, objectId, rawId, nodeId].filter(Boolean).map((x) => String(x))
          );

          let found: THREE.Object3D | undefined;
          scene.traverse((o: THREE.Object3D) => {
            if (found) return;
            const ud: any = (o as any).userData || {};
            const candidates: any[] = [
              ud.elementId, ud.id, ud.speckle_id, ud.object_id, ud.__objectId, ud.__treeNodeId
            ].filter(Boolean).map((x) => String(x));
            for (const s of candidates) {
              if (wantedStrings.has(s)) { found = o; break; }
            }
          });

          if (!found) {
            vrLogger.addPersistentLog('[TP] fallback Three.js: objet non trouvé (aucun userData id ne matche)');
          } else {
            (found as any).updateWorldMatrix?.(true, true);

            const globalBox = new THREE.Box3();
            const tmp = new THREE.Box3();

            found!.traverse((child: THREE.Object3D) => {
              const mesh = child as any;
              const geom = mesh?.geometry as THREE.BufferGeometry | undefined;
              if (!geom) return;
              if (!geom.boundingBox && typeof geom.computeBoundingBox === 'function') {
                geom.computeBoundingBox();
              }
              if (geom.boundingBox) {
                tmp.copy(geom.boundingBox);
                tmp.applyMatrix4((mesh as any).matrixWorld);
                globalBox.union(tmp);
              }
            });

            if (!globalBox.isEmpty()) {
              const c = new THREE.Vector3(); globalBox.getCenter(c);
              vrLogger.addPersistentLog('[TP] centre via fallback Three.js ✓');
              return c;
            } else {
              vrLogger.addPersistentLog('[TP] fallback Three.js: bbox vide');
            }
          }
        }
      } catch {
        vrLogger.addPersistentLog('[TP] fallback Three.js a levé une exception');
      }

      vrLogger.addPersistentLog('[TP] centre non calculable (tous essais KO)');
      return null;
    } catch {
      vrLogger.addPersistentLog('[TP] centre: exception inattendue');
      return null;
    }
  }

  // Crée un panneau 2D (plane) avec une texture canvas (titre + 3 items fictifs)
  // Fonction améliorée pour créer le menu avec état dynamique
  function createVrMenuPlane(): THREE.Mesh {
    const w = 2.0;
    const h = 1.2;

    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 768;
    const ctx = canvas.getContext('2d')!;

    // Fond
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Bordure
    ctx.strokeStyle = '#ff6b00';
    ctx.lineWidth = 12;
    ctx.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
    
    // Header
    ctx.fillStyle = '#ff6b00';
    ctx.fillRect(20, 20, canvas.width - 40, 100);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 52px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('MENU VR ACTIF', canvas.width / 2, 85);
    ctx.textAlign = 'left';

    // Dessiner les boutons selon l'état
    menuState.buttons.forEach((button, i) => {
      const bounds = button.bounds;
      
      // Couleur selon l'état
      let buttonColor = '#0066cc';
      let textColor = '#fff';
      
      // Gradient du bouton
      const gradient = ctx.createLinearGradient(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height);
      gradient.addColorStop(0, buttonColor);
      gradient.addColorStop(1, buttonColor + '88'); // Plus sombre
      ctx.fillStyle = gradient;
      ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
      
      // Bordure du bouton
      ctx.strokeStyle = textColor;
      ctx.lineWidth = 6;
      ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
      
      // Texte
      ctx.fillStyle = textColor;
      ctx.font = 'bold 42px Arial';
      ctx.fillText(button.currentLabel, bounds.x + 30, bounds.y + 65);
    });

    // Instructions en bas
    ctx.fillStyle = '#00ff00';
    ctx.font = 'bold 32px Arial';
    ctx.fillText('Visez avec le contrôleur - Gâchette pour cliquer', 50, canvas.height - 30);

    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 16;
    tex.needsUpdate = true;

    const mat = new THREE.MeshBasicMaterial({ 
      map: tex, 
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false
    });
    const geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'VR_MENU_PANEL';
    mesh.renderOrder = 1000;
    
    return mesh;
  }

  // Fonction pour mettre à jour le menu (redessiner avec le nouvel état)
  function updateVrMenuPlane(menuMesh: THREE.Mesh) {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 768;
    const ctx = canvas.getContext('2d')!;

    // Fond
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Bordure
    ctx.strokeStyle = '#ff6b00';
    ctx.lineWidth = 12;
    ctx.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
    
    // Header
    ctx.fillStyle = '#ff6b00';
    ctx.fillRect(20, 20, canvas.width - 40, 100);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 52px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('MENU VR ACTIF', canvas.width / 2, 85);
    ctx.textAlign = 'left';

    // Dessiner les boutons selon l'état actuel
    menuState.buttons.forEach((button) => {
      const bounds = button.bounds;
      
      let buttonColor = '#0066cc';
      let textColor = '#fff';      

      if (menuState.hoveredButtonId === button.id) {
        buttonColor = '#0088ff';
      }
      
      const gradient = ctx.createLinearGradient(bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height);
      gradient.addColorStop(0, buttonColor);
      gradient.addColorStop(1, buttonColor + '88');
      ctx.fillStyle = gradient;
      ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
      
      ctx.strokeStyle = textColor;
      ctx.lineWidth = 6;
      ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
      
      ctx.fillStyle = textColor;
      ctx.font = 'bold 42px Arial';
      ctx.fillText(button.currentLabel, bounds.x + 30, bounds.y + 65);
    });

    ctx.fillStyle = '#00ff00';
    ctx.font = 'bold 28px Arial';
    ctx.fillText(`Survolé: ${menuState.hoveredButtonId || 'aucun'}`, 50, canvas.height - 60);
    ctx.fillText('Visez avec le contrôleur - Gâchette pour cliquer', 50, canvas.height - 30);

    // Mettre à jour la texture
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 16;
    tex.needsUpdate = true;
    (menuMesh.material as THREE.MeshBasicMaterial).map = tex;
    (menuMesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
  }

  // Système de raycasting pour detecter sur quel bouton on pointe
  function checkMenuRaycast(controller: THREE.Object3D, menuMesh: THREE.Mesh): string | null {
    if (!menuMesh || !menuMesh.visible) return null;
    
    const raycaster = new THREE.Raycaster();
    
    // Position et direction du contrôleur
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3(0, 0, -1);
    
    controller.getWorldPosition(origin);
    direction.transformDirection(controller.matrixWorld);
    
    raycaster.set(origin, direction);
    
    // Test d'intersection avec le menu
    const intersects = raycaster.intersectObject(menuMesh);
    
    if (intersects.length > 0) {
      const intersection = intersects[0];
      const uv = intersection.uv;
      
      if (uv) {
        // Convertir les coordonnées UV en coordonnées pixel du canvas
        const canvasX = uv.x * 1024;
        const canvasY = (1 - uv.y) * 768; // Inverser Y car UV commence en bas
        
        // Vérifier quel bouton est touché
        for (const button of menuState.buttons) {
          const bounds = button.bounds;
          if (canvasX >= bounds.x && canvasX <= bounds.x + bounds.width &&
              canvasY >= bounds.y && canvasY <= bounds.y + bounds.height) {
            return button.id;
          }
        }
      }
    }
    
    return null;
  }

  // Distance/offsets centralisés
  const MENU_DISTANCE = 1.8;     // 1.8 m devant (au lieu de 1.0/1.5)
  const MENU_Y_OFFSET = +0.18;   // +18 cm (légèrement AU-DESSUS du regard)

  function positionMenuInFrontOfUser(menu: THREE.Object3D, renderer: any): boolean {
    if (!menu || !renderer.xr.isPresenting) return false;
    const cam = renderer.xr.getCamera();
    if (!cam) return false;

    const camPos = new THREE.Vector3(); cam.getWorldPosition(camPos);
    const fwd = new THREE.Vector3();    cam.getWorldDirection(fwd);

    // 1) place à une bonne distance + un léger lift pour éviter de "regarder vers le bas"
    const pos = camPos.clone().addScaledVector(fwd, MENU_DISTANCE);
    pos.y += MENU_Y_OFFSET;

    menu.position.copy(pos);
    menu.lookAt(camPos);
    return true;
  }

  // Système de détection des boutons amélioré
  class VRControllerManager {
    private previousStates = new Map<XRInputSource, Map<number, boolean>>();
    
    getButtonStates(inputSource: XRInputSource): { pressed: number[], justPressed: number[] } {
      const gamepad = (inputSource as any).gamepad as Gamepad | undefined;
      if (!gamepad?.buttons) return { pressed: [], justPressed: [] };
      
      const currentPressed: number[] = [];
      const justPressed: number[] = [];
      
      // État précédent pour cette source
      if (!this.previousStates.has(inputSource)) {
        this.previousStates.set(inputSource, new Map());
      }
      const prevState = this.previousStates.get(inputSource)!;
      
      // Vérifier chaque bouton
      for (let i = 0; i < gamepad.buttons.length; i++) {
        const isPressed = gamepad.buttons[i].pressed;
        const wasPressed = prevState.get(i) || false;
        
        if (isPressed) currentPressed.push(i);
        if (isPressed && !wasPressed) justPressed.push(i);
        
        prevState.set(i, isPressed);
      }
      
      return { pressed: currentPressed, justPressed };
    }
    
    cleanup() {
      this.previousStates.clear();
    }
  }

  // Dans votre fonction principale, remplacez la section VR par :
  const controllerManager = new VRControllerManager();

  /** Add the selection extension for extra interactivity */
  const selection: SelectionExtension =
    viewer.createExtension(SelectionExtension);

  /** Add the sectionTools extension for extra interactivity */
  const sections: SectionTool = viewer.createExtension(SectionTool);
  viewer.createExtension(SectionOutlines);

  
  /*
  const urls = await UrlHelper.getResourceUrls(
    'https://app.speckle.systems/projects/61c962b75e/models/f7bd3d6d20'
  );
  for (const url of urls) {
    const loader = new SpeckleLoader(viewer.getWorldTree(), url, '');    
    await viewer.loadObject(loader, true);
  }
  */

  const resource =
    "https://app.speckle.systems/projects/61c962b75e/models/f7bd3d6d20";

  try {
    /** Create a loader for the speckle stream */
    const urls = await UrlHelper.getResourceUrls(resource);

    // Fonction pour charger un objet Speckle
      async function loadSpeckleObject(url: string) {
        const loader = new SpeckleLoader(viewer.getWorldTree(), url, "");
        await viewer.loadObject(loader, true);
      }

      // Charge tous les objets Speckle en parallèle
      await Promise.all(urls.map(loadSpeckleObject));

      // Cache le spinner après le chargement
      if (spinnerContainer) {
        spinnerContainer.style.display = "none";
      }  
  }catch (error) {
    console.error("Erreur de chargement des données : ", error);
    // Gérer les erreurs de chargement
    // Exemple : Afficher un message d'erreur ou réessayer le chargement
  }

 
  // Map pour indexer les TreeNode par elementId
  const tn_GenericModels = viewer.getWorldTree().findAll(n => {
  if (!n.model.atomic) return false;
  const props = n.model.raw?.properties ?? {};
  return props.builtInCategory === "OST_GenericModel";
  });

  const treeNodeMap = new Map<string, any>();
  for (const n of tn_GenericModels) {
    const elId = n.model.raw?.properties?.elementId;
    if (elId != null) treeNodeMap.set(String(elId), n);
  }

  //#region Pane
  const pane = new Pane({ title: 'UI', expanded: true });
  
  const folderViews = (pane as any).addFolder({
    title: 'Views',
    expanded: true,
  });

  (pane as any).addBlade({
    view: 'separator',
  });

  const folderDownload = (pane as any).addFolder({
    title: 'Download',
    expanded: true,
  });

  // === VR (Quest) — même méthodo que le reste (addFolder/addBlade/addButton) ===
  const folderVR = (pane as any).addFolder({
    title: 'VR (Quest) [experimental]',
    expanded: true,
  });

  
  folderViews
    .addBlade({
      view: 'list',
      label: 'Views',
      options: [
        { text: 'General', value: 'general' },
        { text: 'Scène', value: 'scene' },
        { text: 'Régie', value: 'regie' },
        { text: 'Bar craft', value: 'bar-craft' },
        { text: 'Bar étage', value: 'bar-etage' },
        { text: 'Hall milieu', value: 'hall-milieu' },
        { text: 'Salle jardin', value: 'jardin' },
        { text: 'Gradins cour', value: 'gradins-cour' },
        { text: 'Gradins salle', value: 'gradins-salle' },
        { text: 'Gradins jardin', value: 'gradins-jardin' },
        { text: 'Passerelle', value: 'passerelle' },
        { text: 'Passerelle salle', value: 'passerelle-salle' },
      ],
      value: 'general',
    })
    .on('change', (ev: any) => {
      let elementid: string = '';
      let tnFinded: TreeNode = null;
      if (!tn_GenericModels) return;

      switch (ev.value) {
        case 'general':
          selection.clearSelection();
          cameraController.setCameraView([], false);
          // Mettre à jour le bouton avec le nouveau paramètre URL_DOC trouvé
          updateButtonWithUrl(null);
          break;
        case 'scene':
          // Rechercher dans cette liste le TreeNode avec l'elementId correspondant.
          tnFinded = treeNodeMap.get('1229389');
          break;
        case 'regie':
          // Rechercher dans cette liste le TreeNode avec l'elementId correspondant.
          tnFinded = treeNodeMap.get('1228695');
          break;
        case 'bar-craft':
          tnFinded = treeNodeMap.get('1226120');
          break;
        case 'bar-etage':
          tnFinded = treeNodeMap.get('1226484');
          break;
        case 'hall-milieu':
          tnFinded = treeNodeMap.get('1226626');
          break;
        case 'jardin':
          tnFinded = treeNodeMap.get('1228946');
          break;
        case 'gradins-cour':
          tnFinded = treeNodeMap.get('1225014');
          break;
        case 'gradins-salle':
          tnFinded = treeNodeMap.get('1225435');
          break;
        case 'radins-jardin':
          tnFinded = treeNodeMap.get('1225954');
          break;
        case 'passerelle':
          tnFinded = treeNodeMap.get('1227119');
          break;
        case 'passerelle-salle':
          tnFinded = treeNodeMap.get('1227371');
          break;
      }

      if (tnFinded) {
        const node = tnFinded;
        const raw = node?.model?.raw ?? {};
        const props = raw?.properties ?? {};

        console.groupCollapsed(
          "[Node trouvé]",
          "objectId:", node?.model?.id,
          "| elementId:", props?.elementId,
          "| builtInCategory:", props?.builtInCategory
        );
        
        // Résumé utile
        console.log("Résumé:", {
          objectId: node?.model?.id,
          atomic: node?.model?.atomic,
          name: raw?.name,
          type: raw?.type,
          family: raw?.family,
          level: raw?.level,
          category: raw?.category ?? props?.category,
          builtInCategory: props?.builtInCategory,
          elementId: props?.elementId
        });

        // Détail complet
        console.log("raw keys:", Object.keys(raw));
        console.log("raw:", raw);
        console.log("properties:", props);
        console.log("Parameters (clés):", props?.Parameters ? Object.keys(props.Parameters) : []);
        console.log("Instance Parameters:", raw?.["Instance Parameters"]);
        console.log("Type Parameters:", raw?.["Type Parameters"]);

        // pratique: garder une réf dans la console
        // @ts-ignore
        window.lastNode = node;

        console.groupEnd();


        ZoomOnTreeNode(tnFinded);
        //const id = tnFinded.model.id;
        //console.log(`Id ${id} pour le node elementid ${elementid}`);
      } else {
        console.log(
          `Impossible de trouver le node pour l'elementid ${elementid}`
        );
      }
    });
  
  (pane as any).addBlade({
    view: 'separator',
  });

  folderViews
    .addBlade({
      view: 'list',
      label: 'Gauges',
      options: [
        { text: 'General', value: 'general' },
        { text: '3000 Salle', value: '3000-salle' },
        { text: '3000 Scène', value: '3000-scene' },
        { text: '4000 Salle', value: '4000-salle' },
        { text: '4000 Scène', value: '4000-scene' },
        { text: '5000 Salle', value: '5000-salle' },
        { text: '5000 Scène', value: '5000-scene' },
        { text: '5500 Salle', value: '5500-salle' },
        { text: '5500 Scène', value: '5500-scene' },
        { text: '6500 Salle', value: '6500-salle' },
        { text: '6500 Scène', value: '6500-scene' },
        { text: '8500 Salle', value: '8500-salle' },
        { text: '8500 Placebo', value: '8500-placebo' },
        { text: '8500 Scène', value: '8500-scene' },
      ],
      value: 'general',
    })
    .on('change', (ev: any) => {
      let elementid: string = '';
      let tnFinded: TreeNode = null;
      if (!tn_GenericModels) return;

      switch (ev.value) {
        case 'general':
          selection.clearSelection();
          cameraController.setCameraView([], false);
          // Mettre à jour le bouton avec le nouveau paramètre URL_DOC trouvé
          updateButtonWithUrl(null);
          break;
        case '3000-salle':
          // Rechercher dans cette liste le TreeNode avec l'elementId correspondant.
          tnFinded = treeNodeMap.get('1229474');
          break;
        case '3000-scene':
          // Rechercher dans cette liste le TreeNode avec l'elementId correspondant.
          tnFinded = treeNodeMap.get('1229711');
          break;
        case '4000-salle':
          tnFinded = treeNodeMap.get('1229804');
          break;
        case '4000-scene':
          tnFinded = treeNodeMap.get('1229855');
          break;
        case '5000-salle':
          tnFinded = treeNodeMap.get('1229946');
          break;
        case '5000-scene':
          tnFinded = treeNodeMap.get('1230045');
          break;
        case '5500-salle':
          tnFinded = treeNodeMap.get('1230211');
          break;
        case '5500-scene':
          tnFinded = treeNodeMap.get('1230320');
          break;
        case '6500-salle':
          tnFinded = treeNodeMap.get('1230355');
          break;
        case '6500-scen':
          tnFinded = treeNodeMap.get('1230382');
          break;
        case '8500-salle':
          tnFinded = treeNodeMap.get('1230447');
          break;
        case '8500-placebo':
          tnFinded = treeNodeMap.get('1230502');
          break;
        case '8500-sceno':
          tnFinded = treeNodeMap.get('1230693');
          break;
      }

    if (tnFinded) {
            /*
            const props2 = tnFinded?.model?.raw?.properties;
            const parameterUrl: Param | null =
              findParameterByName(props2?.Parameters?.['Instance Parameters'], 'URL_PANO')
              ?? findParameterByName(props2?.Parameters?.['Type Parameters'], 'URL_PANO')
              ?? findParameterByName(props2, 'URL_PANO'); // fallback

            if (parameterUrl) {
              console.log('✅ URL_PANO =', parameterUrl.value);
            } else {
              console.warn('❌ URL_PANO introuvable');
            }
            */

            const node = tnFinded;
            const raw = node?.model?.raw ?? {};
            const props = raw?.properties ?? {};

            console.groupCollapsed(
              "[Node trouvé]",
              "objectId:", node?.model?.id,
              "| elementId:", props?.elementId,
              "| builtInCategory:", props?.builtInCategory
            );

            // Résumé utile
            console.log("Résumé:", {
              objectId: node?.model?.id,
              atomic: node?.model?.atomic,
              name: raw?.name,
              type: raw?.type,
              family: raw?.family,
              level: raw?.level,
              category: raw?.category ?? props?.category,
              builtInCategory: props?.builtInCategory,
              elementId: props?.elementId
            });

            // Détail complet
            console.log("raw keys:", Object.keys(raw));
            console.log("raw:", raw);
            console.log("properties:", props);
            console.log("Parameters (clés):", props?.Parameters ? Object.keys(props.Parameters) : []);
            console.log("Instance Parameters:", raw?.["Instance Parameters"]);
            console.log("Type Parameters:", raw?.["Type Parameters"]);

            // pratique: garder une réf dans la console
            // @ts-ignore
            window.lastNode = node;

            console.groupEnd();

            ZoomOnTreeNode(tnFinded);
            //const id = tnFinded.model.id;
            //console.log(`Id ${id} pour le node elementid ${elementid}`);
          } else {
            console.log(
              `Impossible de trouver le node pour l'elementid ${elementid}`
            );
          }
        });


  btnUrlDoc = folderViews
    .addButton({
      title: '...',
      disabled: true,
      label: 'Vue 360', // optional
    })
    .on('click', () => {
      // L'action de clic initial est vide, car l'URL sera mise à jour plus tarddhdhhdibdbfgdssdusqggg
    });

  
    const formatDropdown = folderDownload.addBlade({
      view: 'list',
      label: 'Format',
      options: downloadOptions,
      value: downloadOptions[0].value,
    });

    const btnDownload = folderDownload
    .addButton({
      title: '...',
      label: 'Save as', // optional
    })
    .on('click', () => {
      // L'action de clic initial est vide, car l'URL sera mise à jour plus tard
      const selectedValue = formatDropdown.value; // Accès direct à la valeur sélectionnée
      const selectedOption = downloadOptions.find(
        (opt) => opt.value === selectedValue
      );

      if (selectedOption && selectedOption.value) {
        // Ouvrir le lien dans un nouvel onglet
        window.open(selectedOption.value, '_blank');
      } else {
        console.error('Aucun format valide sélectionné.');
      }
    });

    // Bouton "Mode VR" (désactivé par défaut, on l'activera si WebXR est supporté)
    const btnEnterVR: any = folderVR.addButton({
      title: 'Entrer en VR',
      label: 'Mode VR'
    });

    // Handler du bouton (note: callback async pour pouvoir "await")
    btnEnterVR.on('click', async () => {
      try {
        // @ts-ignore
        if (!navigator.xr) { alert('WebXR non dispo (HTTPS + Meta Quest Browser).'); return; }
        // @ts-ignore
        const ok = await navigator.xr.isSessionSupported?.('immersive-vr');
        if (!ok) { alert('Immersive VR non supporté sur ce navigateur.'); return; }

        applyAxisFix(viewer);
        await new Promise(r => setTimeout(r, 1));

        // ensuite seulement, tu désactives les outils “desktop”
        try { sections.setBox?.(null as any); (sections as any).enabled = false; } catch {}
        try { (threeRenderer as any).localClippingEnabled = false; (threeRenderer as any).clippingPlanes = []; } catch {}
        try { (cameraController as any).enabled = false; } catch {}

        await new Promise(r => setTimeout(r, 1));

        // démarrer XR
        const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
        await threeRenderer.xr.setSession(session);

        function setAllCamerasClipping(renderer: any, near = 0.02, far = 2000) {
        // caméra XR (est un "ArrayCamera" contenant .cameras)
        const xrCam:any = renderer.xr.getCamera();
        const list: THREE.Camera[] =
          (xrCam && xrCam.cameras && Array.isArray(xrCam.cameras)) ? xrCam.cameras : (xrCam ? [xrCam] : []);
        for (const c of list) {
          if ('near' in c) (c as any).near = near;
          if ('far' in c)  (c as any).far = far;
          (c as any).updateProjectionMatrix?.();
        }
      }

      // juste après setSession(...)
      setAllCamerasClipping(threeRenderer, 0.002, 500);

      // === CRÉATION DES CONTRÔLEURS (CRUCIAL) ===
      const controller0 = threeRenderer.xr.getController(0);
      const controller1 = threeRenderer.xr.getController(1);
      const controllerGrip0 = threeRenderer.xr.getControllerGrip(0);
      const controllerGrip1 = threeRenderer.xr.getControllerGrip(1);

      // Ajouter les contrôleurs à la scène
      scene.add(controller0);
      scene.add(controller1);
      scene.add(controllerGrip0);
      scene.add(controllerGrip1);

      // Créer des géométries visuelles pour les contrôleurs (optionnel mais utile pour debug)
      const controllerModelFactory = new XRControllerModelFactory();
      const controllerGrip0Model = controllerModelFactory.createControllerModel(controllerGrip0);
      const controllerGrip1Model = controllerModelFactory.createControllerModel(controllerGrip1);
      controllerGrip0.add(controllerGrip0Model);
      controllerGrip1.add(controllerGrip1Model);

      // Créer des rayons visuels pour les contrôleurs
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1)
      ]);
      const line = new THREE.Line(geometry);
      const line2 = line.clone();
      
      // Matériaux pour les rayons
      line.material = new THREE.LineBasicMaterial({ color: 0xff0000 });
      line2.material = new THREE.LineBasicMaterial({ color: 0x00ff00 });
      
      controller0.add(line.clone());
      controller1.add(line2.clone());


        // Créer le panel de debug
        debugText = createDebugPanel();
        scene.add(debugText);

        // Prépare/ajoute le menu dans la scène une seule fois
        if (!vrMenu) {
          vrMenu = createVrMenuPlane();
          vrMenuNeedsAttach = true;
        }
        if (vrMenuNeedsAttach) {
          scene.add(vrMenu!);
          vrMenuNeedsAttach = false;
        }
        vrMenuVisible = false;
        if (vrMenu) vrMenu.visible = false;

        // reset des états boutons à l’entrée de session
        prevRightA = prevRightB = false;

        // === FONCTION DE RAYCASTING AMÉLIORÉE ===
        function checkMenuRaycastImproved(controller: THREE.Object3D, menuMesh: THREE.Mesh): string | null {
          if (!menuMesh || !menuMesh.visible) return null;
          
          const raycaster = new THREE.Raycaster();
          
          // Matrice du contrôleur
          const tempMatrix = new THREE.Matrix4();
          tempMatrix.identity().extractRotation(controller.matrixWorld);
          
          const raycasterOrigin = new THREE.Vector3();
          const raycasterDirection = new THREE.Vector3(0, 0, -1);
          
          controller.getWorldPosition(raycasterOrigin);
          raycasterDirection.applyMatrix4(tempMatrix);
          
          raycaster.set(raycasterOrigin, raycasterDirection);
          
          // Test d'intersection
          const intersects = raycaster.intersectObject(menuMesh);
          
          if (intersects.length > 0) {
            const intersection = intersects[0];
            const uv = intersection.uv;
            
            if (uv) {
              // Convertir UV en coordonnées canvas
              const canvasX = uv.x * 1024;
              const canvasY = (1 - uv.y) * 768;
              
              // Vérifier quel bouton est touché
              for (const button of menuState.buttons) {
                const bounds = button.bounds;
                if (canvasX >= bounds.x && canvasX <= bounds.x + bounds.width &&
                    canvasY >= bounds.y && canvasY <= bounds.y + bounds.height) {
                  return button.id;
                }
              }
            }
          }
          
          return null;
        }

        // --- RAF WebXR natif : manettes sans setAnimationLoop ---
        let xrAfId: number | null = null;

        const moveOffset = new THREE.Vector3();     // x,z pour marcher + y pour le drone
        const tmpDir     = new THREE.Vector3();
        const rightVec   = new THREE.Vector3();

        const SPEED_BASE = 3.0;     // m/s (plus rapide qu’avant)
        const VERT_SPEED = 2.0;     // m/s montée/descente drone
        const DZ         = 0.15;    // deadzone sticks

        function getAxes(src: XRInputSource): { x: number; y: number } {
          const gp = (src as any).gamepad as Gamepad | undefined;
          const ax0 = gp?.axes?.[0] ?? 0, ax1 = gp?.axes?.[1] ?? 0;
          const ax2 = gp?.axes?.[2] ?? 0, ax3 = gp?.axes?.[3] ?? 0;
          // Beaucoup de profils utilisent [2,3] pour le stick secondaire ; fallback sur [0,1]
          const x = Math.abs(ax2) + Math.abs(ax3) > Math.abs(ax0) + Math.abs(ax1) ? ax2 : ax0;
          const y = Math.abs(ax2) + Math.abs(ax3) > Math.abs(ax0) + Math.abs(ax1) ? ax3 : ax1;
          return { x, y };
        }        

        function onXRFrame(_time: DOMHighResTimeStamp, frame: XRFrame) {
          const session = frame.session;
          
          let debugLines: string[] = [];
          debugLines.push(`=== DEBUG VR FRAME ${Math.floor(_time)} ===`);
          debugLines.push(`Session active: ${session ? 'OUI' : 'NON'}`);
          debugLines.push(`InputSources: ${session.inputSources.length}`);
          
          let menuToggleRequested = false;
          let triggerPressed = false;
          let rightController: THREE.Object3D | null = null;

          // 1re pose XR disponible → on mémorise le spawn
          if (!xrSpawn) {
            const cam: THREE.Camera | any = threeRenderer.xr.getCamera?.();
            if (cam) {
              xrSpawn = new THREE.Vector3();
              cam.getWorldPosition(xrSpawn);
              upsertSpawnPoint();

              // Debug persistant
              vrLogger.addPersistentLog('🚀 XR SPAWN INITIALISE');
              vrLogger.addLog(`TreeNodeMap size: ${treeNodeMap?.size || 0}`);
              
              // FORCER l'appel sans condition
              upsertScenePoint(treeNodeMap, viewer);

              if (vrMenu) setMenuMode('tpList' === menuMode ? 'tpList' : 'root', vrMenu);
            }
          }
          // Analyser chaque contrôleur
          for (const [index, inputSource] of session.inputSources.entries()) {
            const hand = inputSource.handedness || 'unknown';
            debugLines.push(`--- Contrôleur ${index} (${hand}) ---`);
            
            const { pressed, justPressed } = controllerManager.getButtonStates(inputSource);
            
            debugLines.push(`Boutons pressés: [${pressed.join(', ')}]`);
            debugLines.push(`Nouveaux appuis: [${justPressed.join(', ')}]`);
            
            // Toggle menu avec A/B (boutons 4,5)
            if (hand === 'right') {
              const AB_INDICES = [4, 5];
              if (justPressed.some(i => AB_INDICES.includes(i))) {
                menuToggleRequested = true;
                debugLines.push(`>>> TOGGLE via A/B (indices ${justPressed.join(',')}) <<<`);
              }
              
              // Détecter gâchette (bouton 0) pour le clic
              if (justPressed.includes(0)) {
                triggerPressed = true;
                debugLines.push(`>>> GÂCHETTE PRESSÉE <<<`);
              }

              // IMPORTANT : Utiliser les vrais contrôleurs Three.js
              rightController = index === 0 ? controller0 : controller1;
            }
            
            // Déplacement et montée/descente (votre code existant)
            if (inputSource.handedness === 'left') {
              const { x, y } = getAxes(inputSource);
              if (Math.hypot(x, y) > DZ) {
                const cam = threeRenderer.xr.getCamera();
                cam.getWorldDirection(tmpDir);
                tmpDir.y = 0; tmpDir.normalize();
                rightVec.set(tmpDir.z, 0, -tmpDir.x);

                const dt = 1 / 60;
                moveOffset.addScaledVector(tmpDir, -y * SPEED_BASE * dt);
                moveOffset.addScaledVector(rightVec, -x * SPEED_BASE * dt);
              }
            }
            
            if (inputSource.handedness === 'right') {
              const { x, y } = getAxes(inputSource);
              if (Math.abs(y) > DZ) {
                const dt = 1 / 60;
                moveOffset.y += (-y) * VERT_SPEED * dt;
              }
            }
          }
          
          // Gestion du toggle menu
          if (menuToggleRequested) {
            vrMenuVisible = !vrMenuVisible;
            debugLines.push(`MENU ${vrMenuVisible ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`);
            
            if (!vrMenu) {
              vrMenu = createVrMenuPlane();
              scene.add(vrMenu);
              debugLines.push('Menu créé et ajouté à la scène');
            }
            
            if (vrMenu) {
              vrMenu.visible = vrMenuVisible;
              debugLines.push(`Menu.visible = ${vrMenu.visible}`);
            }
          }
          if (vrMenu && rightController) {
            checkMenuRaycast(rightController, vrMenu);
          }
          
          // === RAYCASTING ET INTERACTION AMÉLIORÉS ===
          let hoveredButtonId: string | null = null;
          if (vrMenu && vrMenuVisible && rightController) {
            // Utiliser la fonction de raycasting améliorée
            hoveredButtonId = checkMenuRaycastImproved(rightController, vrMenu);
            
            debugLines.push(`Raycasting avec contrôleur: ${rightController.name || 'unnamed'}`);
            debugLines.push(`Position contrôleur: ${rightController.position.x.toFixed(2)}, ${rightController.position.y.toFixed(2)}, ${rightController.position.z.toFixed(2)}`);
            
            if (hoveredButtonId !== menuState.hoveredButtonId) {
              menuState.setHovered(hoveredButtonId);
              updateVrMenuPlane(vrMenu);
              debugLines.push(`Survol changé: ${hoveredButtonId || 'aucun'}`);
            }
            
            // Clic sur bouton
            if (triggerPressed && hoveredButtonId) {
              menuState.clickButton(hoveredButtonId);
              updateVrMenuPlane(vrMenu);
              debugLines.push(`BOUTON CLIQUÉ: ${hoveredButtonId}`);
              
              // Actions spécifiques selon le bouton
              switch (hoveredButtonId) {
                case 'teleport':
                  debugLines.push('Action: Ouvrir sous-menu TP');
                  setMenuMode('tpList', vrMenu);
                  break;
                case 'settings':
                  debugLines.push('Action: Ouvrir paramètres');
                  break;
                case 'desktop':
                  debugLines.push('Action: Retour desktop');
                  break;

                case 'back':
                debugLines.push('Action: Retour au menu principal');
                setMenuMode('root', vrMenu);
                break;

              default:
                // Items dynamiques de TP : ids "tp_<id>"
                if (hoveredButtonId.startsWith('tp_')) {
                  const tpId = hoveredButtonId.substring(3);
                  const tp = teleportPoints.find(p => p.id === tpId);
                  if (tp) {
                    debugLines.push(`Action: TP vers ${tp.label}`);
                    teleportToWorldPosition(tp.position, threeRenderer);
                    menuToggleRequested = true;
                  }
                }
                break;
              }
              
              // Reset du bouton après 2 secondes
              setTimeout(() => {
                if (vrMenu && vrMenuVisible) {
                  menuState.resetButton(hoveredButtonId!);
                  updateVrMenuPlane(vrMenu);
                }
              }, 2000);
            }
          }
          
          debugLines.push(`--- Interaction Menu ---`);
          debugLines.push(`Contrôleur droit trouvé: ${rightController ? 'OUI' : 'NON'}`);
          debugLines.push(`Bouton survolé: ${hoveredButtonId || 'aucun'}`);
          debugLines.push(`Gâchette pressée: ${triggerPressed ? 'OUI' : 'NON'}`);
          
          // Positionner le menu
          if (vrMenu && vrMenuVisible) {
            const positioned = positionMenuInFrontOfUser(vrMenu, threeRenderer);
            debugLines.push(`Menu positionné: ${positioned ? 'OUI' : 'NON'}`);
          }
          
          // Positionner le debug panel (votre code existant)
          if (debugText) {
            const cam = threeRenderer.xr.getCamera();
            if (cam) {
              const camPos = new THREE.Vector3(); cam.getWorldPosition(camPos);
              const fwd   = new THREE.Vector3();  cam.getWorldDirection(fwd);
              
              const p = camPos.clone().addScaledVector(fwd, MENU_DISTANCE);
              p.y += MENU_Y_OFFSET-1;
              
              debugText.position.copy(p);
              debugText.lookAt(camPos);
            }
          }
          
          // Déplacement (votre code existant)
          if (moveOffset.lengthSq() > 0) {
            const base = threeRenderer.xr.getReferenceSpace();
            const xform = new XRRigidTransform({
              x: -moveOffset.x,
              y: -moveOffset.y,
              z: -moveOffset.z
            });
            const offset = base?.getOffsetReferenceSpace(xform);
            if (offset) threeRenderer.xr.setReferenceSpace(offset);
            moveOffset.set(0, 0, 0);
          }
          
          updateDebugPanel(debugText, debugLines);
          viewer.requestRender();
          xrAfId = session.requestAnimationFrame(onXRFrame);
        }

        // démarrer la boucle XR
        xrAfId = session.requestAnimationFrame(onXRFrame);


        // Nettoyage à la fermeture de session
        session.addEventListener('end', () => {
          controllerManager.cleanup();
          if (xrAfId !== null) {
            try { session.cancelAnimationFrame(xrAfId); } catch {}
          }
          xrAfId = null;
          
          // Nettoyer les objets VR de la scène
          if (vrMenu) {
            scene.remove(vrMenu);
            vrMenu = null;
          }
          if (debugText) {
            scene.remove(debugText);
            debugText = null;
          }
          
          // Retirer les contrôleurs
          scene.remove(controller0);
          scene.remove(controller1);
          scene.remove(controllerGrip0);
          scene.remove(controllerGrip1);
          
          viewer.requestRender();
        });


        // 🔢 tes coordonnées Speckle (en cm) lues dans properties.location
        const targetSpeckle = { x: 7310.294959203268, y: -1563.358968165413, z: 4290.0 };

        // ↪️ converties en coords Three (m) APRÈS axisFix
        const targetM = specklePointToThreeMeters(viewer, targetSpeckle);

        // hauteur yeux
        const eye = 1.65;
        // on veut que la tête soit à eye mètres au-dessus de ce point
        const spawn = new Vector3(targetM.x, targetM.y + eye, targetM.z);

        // (optionnel) orientation initiale
        const yawRad = 0; // mets ±Math.PI/2 si tu veux regarder dans une direction donnée
        const q = new Quaternion().setFromAxisAngle(new Vector3(0,1,0), yawRad);

        // ref space + offset (amène le monde à toi)
        const baseRef = await session.requestReferenceSpace('local-floor');
        const xrOffset = new XRRigidTransform(
          { x: -spawn.x, y: -spawn.y, z: -spawn.z },
          { x: q.x, y: q.y, z: q.z, w: q.w }
        );
        const offsetRef = baseRef.getOffsetReferenceSpace(xrOffset);
        threeRenderer.xr.setReferenceSpace(offsetRef);


      } catch (e) {
        console.error(e);
        alert(`Impossible de démarrer la session VR.${(e as any)?.message ? '\n' + (e as any).message : ''}`);
      }
    });

    // Bouton "Quitter la VR"
    const btnExitVR: any = folderVR.addButton({ title: 'Quitter la VR' });
    btnExitVR.on('click', () => {
      threeRenderer.xr.getSession?.()?.end();
    });


    //#endregion

  /** Enable the section tool */
  sections.toggle();
  /** Programatically apply a section box */
  const box = new Box3().copy(viewer.getRenderer().sceneBox);
  box.max.z *= 1;
  box.min.z = -1;
  sections.setBox(box);

  // Fonction pour obtenir un TreeNode par ID
  function ZoomOnTreeNode(targetTreeNode: TreeNode): void {
    selection.clearSelection();
    const ids = [targetTreeNode.model.id];
    //selection.selectObjects(ids);
    cameraController.setCameraView(ids, true);
    // Accéder aux propriétés brutes de l'élément sélectionné
    const properties = targetTreeNode?.model?.raw?.properties;
    //const properties = targetTreeNode.model.raw;
    const parameterUrl: Param | null = findParameterByName(
      properties,
      'URL_PANO'
    );

    // Mettre à jour le bouton avec le nouveau paramètre URL_DOC trouvé
    updateButtonWithUrl(parameterUrl);
  }  

  /** Recherche récursive d’un paramètre par nom (insensible casse/espaces/_)
   *  Retourne un Param (ton interface) ou null.
   *  Passe-lui en entrée typiquement: node.model.raw.properties
   */
  function findParameterByName(root: unknown, targetName: string): Param | null {
    const stack: unknown[] = [root];
    const seen = new Set<object>();

    while (stack.length) {
      const cur = stack.pop();
      if (!cur) continue;

      // Tableaux : parcourir
      if (Array.isArray(cur)) {
        for (const item of cur) {
          if (isObj(item)) {
            // Forme { name:'URL_PANO', value:'...' }
            if (typeof item.name === 'string' && sameName(item.name, targetName)) {
              return toParam(item, targetName);
            }
          }
          stack.push(item);
        }
        continue;
      }

      if (!isObj(cur) || seen.has(cur)) continue;
      seen.add(cur);

      // Objets : inspecter chaque clé
      for (const key in cur) {
        const v = cur[key];

        // 1) Clé directe qui matche le nom du paramètre
        if (sameName(key, targetName)) {
          // ex: { URL_PANO: { name:'URL_PANO', value:'...' } }
          if (isObj(v) && ('value' in v || 'name' in v)) {
            return toParam(v, key);
          }
          // ex: { URL_PANO: "http://..." }
          if (v == null || typeof v !== 'object') {
            return toParam(v, key);
          }
        }

        // 2) Valeur de type { name:'URL_PANO', value:'...' }
        if (isObj(v) && typeof v['name'] === 'string' && sameName(String(v['name']), targetName)) {
          return toParam(v, String(v['name']));
        }

        // 3) Descente récursive (inclut "Parameters" → "Instance Parameters" → "Identity Data")
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return null;
  }

  // Fonction pour mettre à jour le bouton avec le paramètre URL_DOC trouvé
  function updateButtonWithUrl(parameterUrl: Param | null) {
    if (btnUrlDoc) {
      btnUrlDoc.dispose(); // Disposer du bouton précédent pour nettoyer les événements

      if (parameterUrl) {
        if (parameterUrl.value && parameterUrl.value.trim() !== '') {
          btnUrlDoc = folderViews
          .addButton({
              title: '...',
              disabled: false,
              index: 3,
              label: 'Vue 360',
            })
            .on('click', () => {
              // Ouvre l'URL dans un nouvel
              window.open(parameterUrl.value, '_blank'); // Ouvre l'URL dans un nouvel onglet
            });
        } else {
          btnUrlDoc = folderViews
          .addButton({
            title: '...',
            disabled: true,
            index: 3,
            label: 'Vue 360',
          });
        }
      } else {
        btnUrlDoc = folderViews
        .addButton({
          title: '...',
          disabled: true,
          index: 3,
          label: 'Vue 360',
        });
      }
    }
  }
}

main();