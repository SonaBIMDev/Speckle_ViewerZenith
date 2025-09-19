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

// Ajouter cet import en haut avec les autres
import { PanoSphereOverlay } from './PanoSphereOverlay'

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
  canvas.width = 5800;
  canvas.height = 1000;
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
  const geometry = new THREE.PlaneGeometry(2.4, 1.6);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'DEBUG_PANEL';
  mesh.renderOrder = 500;
  
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
  
  if (newLines) {
    vrLogger.addLogs(newLines);
  }
  
  const canvas = document.createElement('canvas');
  canvas.width = 1600; // Augmenter la largeur
  canvas.height = 800;  // Augmenter la hauteur
  const ctx = canvas.getContext('2d')!;
  
  // Fond
  ctx.fillStyle = 'rgba(0,0,0,0.95)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Bordure
  ctx.strokeStyle = '#00ff00';
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  
  // Titre
  ctx.fillStyle = '#00ff00';
  ctx.font = 'bold 20px monospace';
  ctx.fillText(`DEBUG VR - Logs: ${vrLogger.getRecentLogs().length}`, 10, 25);
  
  // Lignes de debug
  ctx.font = '14px monospace'; // Police plus petite
  const allLogs = vrLogger.getRecentLogs();
  
  let yPosition = 45;
  const lineHeight = 20;
  const maxLines = Math.floor((canvas.height - 60) / lineHeight);
  
  allLogs.slice(0, maxLines).forEach((line, i) => {
    // Couleur selon le type
    if (line.includes('[PERSIST]')) {
      ctx.fillStyle = '#ff0000';
    } else if (line.includes('📷')) {
      ctx.fillStyle = '#ffff00'; // Jaune pour les logs image 360
    } else if (line.includes('[0.') || line.includes('[1.')) {
      ctx.fillStyle = '#00ff00';
    } else {
      ctx.fillStyle = '#888888';
    }
    
    // Tronquer si trop long mais garder plus de caractères
    const maxChars = Math.floor(canvas.width / 8); // ~200 caractères
    const displayLine = line.length > maxChars ? 
      line.substring(0, maxChars - 3) + '...' : 
      line;
    
    ctx.fillText(displayLine, 10, yPosition);
    yPosition += lineHeight;
  });
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  (debugMesh.material as THREE.MeshBasicMaterial).map = texture;
  (debugMesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
}

let panoOverlay: PanoSphereOverlay | null = null;

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

  let laserLine0: THREE.Line | null = null;
  let laserLine1: THREE.Line | null = null;

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

  // Créer l'overlay pour les images 360
  const panoOverlay = new PanoSphereOverlay(viewer);
  panoOverlay.attach(); // Important : attacher pour que ça suive la caméra

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
  type MenuMode = 'root' | 'tpList' | 'image360List';
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
    const baseButtons = [
      { id: 'teleport',  originalLabel: 'Téléportation', currentLabel: 'Téléportation', clicked: false, bounds: { x: 50, y: 160, width: 924, height: 100 } },
      { id: 'image360',  originalLabel: 'Images 360',    currentLabel: 'Images 360',    clicked: false, bounds: { x: 50, y: 300, width: 924, height: 100 } },
    ];
    
    // Vérifier si une image 360 est visible
    if (panoOverlay && panoOverlay.getIsVisible()) {
      baseButtons[1].originalLabel = '🚫 Masquer Image 360';
      baseButtons[1].currentLabel  = '🚫 Masquer Image 360';
    }
    
    return baseButtons;
  }

  // Version modifiée de buildTeleportButtons avec support du scroll
  function buildTeleportButtons(): VRMenuButton[] {
    const buttons: VRMenuButton[] = [];
    const buttonHeight = 80; // Réduit pour avoir plus de place
    const buttonSpacing = 90;
    const startY = 160;
    const endY = 580; // Zone visible jusqu'à 580px pour laisser de l'espace
    const maxVisibleButtons = Math.floor((endY - startY) / buttonSpacing); // Calcul dynamique
    
    // Calculer le scroll maximum
    const totalButtons = teleportPoints.length + 1; // +1 pour le bouton retour
    maxScrollOffset = Math.max(0, (totalButtons - maxVisibleButtons) * buttonSpacing + buttonSpacing); // +buttonSpacing pour l'espace en bas
    
    // Limiter le scroll dans les bornes
    menuScrollOffset = Math.max(0, Math.min(menuScrollOffset, maxScrollOffset));
    
    // Créer les boutons pour les points TP visibles
    let visibleIndex = 0;
    for (let i = 0; i < teleportPoints.length; i++) {
      const tp = teleportPoints[i];
      const buttonY = startY + (visibleIndex * buttonSpacing) - menuScrollOffset;
      
      // Ne créer le bouton que s'il est potentiellement visible (avec plus d'espace)
      if (buttonY > -buttonHeight && buttonY < endY + buttonHeight) {
        buttons.push({
          id: tp.id, // Utiliser l'ID direct du teleportPoint
          originalLabel: tp.label,
          currentLabel: tp.label,
          clicked: false,
          bounds: { x: 50, y: buttonY, width: 924, height: buttonHeight }
        });
      }
      visibleIndex++;
    }
    
    // Bouton retour
    const backButtonY = startY + (visibleIndex * buttonSpacing) - menuScrollOffset;
    if (backButtonY > -buttonHeight && backButtonY < endY + buttonHeight) {
      buttons.push({
        id: 'back',
        originalLabel: '← Retour',
        currentLabel: '← Retour',
        clicked: false,
        bounds: { x: 50, y: backButtonY, width: 924, height: buttonHeight }
      });
    }
    
    return buttons;
  }

  // Ajouter après buildTeleportButtons() :
  function buildImage360Buttons(): VRMenuButton[] {
    const buttons: VRMenuButton[] = [];
    const buttonHeight = 80;
    const buttonSpacing = 90;
    const startY = 160;
    const endY = 580;
    const maxVisibleButtons = Math.floor((endY - startY) / buttonSpacing);
    
    // Filtrer seulement les points qui ont des URLs d'images 360
    const pointsWithImages = teleportPoints.filter(tp => {
      // Récupérer l'ID original depuis l'ID du teleportPoint
      const originalId = tp.id.replace('tp_', '');
      const tn = treeNodeMap.get(originalId);
      if (!tn) return false;
      
      // Vérifier si ce point a une URL_PANO
      const props = tn?.model?.raw?.properties;
      const parameterUrl = findParameterByName(props, 'URL_PANO');
      return parameterUrl && parameterUrl.value && parameterUrl.value.trim() !== '';
    });
    
    // Calculer le scroll maximum
    const totalButtons = pointsWithImages.length + 1; // +1 pour le bouton retour
    maxScrollOffset = Math.max(0, (totalButtons - maxVisibleButtons) * buttonSpacing + buttonSpacing);
    
    // Limiter le scroll dans les bornes
    menuScrollOffset = Math.max(0, Math.min(menuScrollOffset, maxScrollOffset));
    
    // Créer les boutons pour les points avec images visibles
    let visibleIndex = 0;
    for (let i = 0; i < pointsWithImages.length; i++) {
      const tp = pointsWithImages[i];
      const buttonY = startY + (visibleIndex * buttonSpacing) - menuScrollOffset;
      
      if (buttonY > -buttonHeight && buttonY < endY + buttonHeight) {
        buttons.push({
          id: tp.id, // Garder l'ID du teleportPoint pour la cohérence
          originalLabel: `📷 ${tp.label}`, // Ajouter une icône pour différencier
          currentLabel: `📷 ${tp.label}`,
          clicked: false,
          bounds: { x: 50, y: buttonY, width: 924, height: buttonHeight }
        });
      }
      visibleIndex++;
    }
    
    // Bouton retour
    const backButtonY = startY + (visibleIndex * buttonSpacing) - menuScrollOffset;
    if (backButtonY > -buttonHeight && backButtonY < endY + buttonHeight) {
      buttons.push({
        id: 'back',
        originalLabel: '← Retour',
        currentLabel: '← Retour',
        clicked: false,
        bounds: { x: 50, y: backButtonY, width: 924, height: buttonHeight }
      });
    }
    
    return buttons;
  }

  // Remplacer la version existante de setMenuMode
  function setMenuMode(mode: MenuMode, vrMenu: THREE.Mesh | null) {
    menuMode = mode;
    menuScrollOffset = 0; // Reset scroll à chaque changement de mode
    
    if (mode === 'root') {
      menuState.buttons = buildRootButtons();
    } else if (mode === 'tpList') {
      menuState.buttons = buildTeleportButtons();
    } else if (mode === 'image360List') {
      menuState.buttons = buildImage360Buttons();
    }
    
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

  const TELEPORT_LOCATIONS = [
    { id: '1229389', label: 'Scène' },
    { id: '1228695', label: 'Régie' },
    { id: '1226120', label: 'Bar craft' },
    { id: '1226484', label: 'Bar étage' },
    { id: '1226626', label: 'Hall milieu' },
    { id: '1228946', label: 'Salle jardin' },
    { id: '1225014', label: 'Gradins cour' },
    { id: '1225435', label: 'Gradins salle' },
    { id: '1225954', label: 'Gradins jardin' },
    { id: '1227119', label: 'Passerelle' },
    { id: '1227371', label: 'Passerelle salle' }
  ];

  // Variables pour le système de scroll
  let menuScrollOffset = 0;
  let maxScrollOffset = 0;
  let menuScrollDisabled = false;

  // Fonction pour upsert tous les points de téléportation
  function upsertAllTeleportPoints(treeNodeMap: Map<string, any>, viewer: any) {
    //vrLogger.addPersistentLog('=== DEBUT UPSERT ALL TELEPORT POINTS ===');
    
    let successCount = 0;
    let failCount = 0;
    
    // Toujours ajouter/mettre à jour le spawn en premier
    upsertSpawnPoint();
    
    // Ajouter tous les points de la liste
    for (const location of TELEPORT_LOCATIONS) {
      try {
        const tn = treeNodeMap.get(location.id);
        if (!tn) {
          //vrLogger.addPersistentLog(`❌ TreeNode ${location.id} (${location.label}) non trouvé`);
          failCount++;
          continue;
        }

        const center = getWorldCenterOfTreeNode(tn, viewer);
        if (!center) {
          //vrLogger.addPersistentLog(`❌ Centre non calculable pour ${location.label}`);
          failCount++;
          continue;
        }

        const tpId = `tp_${location.id}`;
        const idx = teleportPoints.findIndex(p => p.id === tpId);
        
        if (idx === -1) {
          teleportPoints.push({ id: tpId, label: location.label, position: center.clone() });
          //vrLogger.addPersistentLog(`✅ Point TP ajouté: ${location.label}`);
        } else {
          teleportPoints[idx].position.copy(center);
          //vrLogger.addPersistentLog(`✅ Point TP mis à jour: ${location.label}`);
        }
        
        successCount++;
        
      } catch (error) {
        //vrLogger.addPersistentLog(`❌ Erreur pour ${location.label}: ${(error as Error).message}`);
        failCount++;
      }
    }
    
    //vrLogger.addPersistentLog(`=== FIN UPSERT: ${successCount} succès, ${failCount} échecs ===`);
    //vrLogger.addPersistentLog(`Total points TP: ${teleportPoints.length}`);
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

  // Calculer la transformation exacte basée sur vos données
  function calculateSpeckleToViewerTransform() {
    // Coordonnées du spawn dans les paramètres Speckle originaux
    const speckleOriginal = {
      x: 7310.294959203261,
      y: 5726.696462183248, 
      z: 1099.9999999999998
    };
    
    // Coordonnées utilisées pour le spawn dans le viewer (après transformation manuelle)
    const viewerTransformed = {
      x: 7310.294959203261,
      y: -1563.358968165413,
      z: 4290.0
    };
    
    // Calculer les offsets de transformation
    const transform = {
      x: viewerTransformed.x - speckleOriginal.x, // = 0
      y: (viewerTransformed.y - speckleOriginal.y), 
      z: (viewerTransformed.z - speckleOriginal.z)+ 250  
    };
    
    return transform;
  }

  // Fonction pour appliquer la transformation Speckle -> Viewer
  function applySpeckleTransform(originalCoords: {x: number, y: number, z: number}) {
    const transform = calculateSpeckleToViewerTransform();
    
    return {
      x: originalCoords.x + transform.x,
      y: originalCoords.y + transform.y,
      z: originalCoords.z + transform.z
    };
  }

  // Version simplifiée de getWorldCenterOfTreeNode
  function getWorldCenterOfTreeNode(tn: any, viewer: any): THREE.Vector3 | null {
    try {
      //vrLogger.addPersistentLog('[TP] === RECHERCHE POSITION DANS PARAMETRES SPECKLE ===');
      
      if (!tn?.model?.raw) {
        //vrLogger.addPersistentLog('[TP] ERREUR: TreeNode.model.raw manquant');
        return null;
      }

      const rawData = tn.model.raw;
      const properties = rawData.properties || {};
      
      //vrLogger.addPersistentLog(`[TP] Clés rawData: [${Object.keys(rawData).slice(0, 15).join(', ')}]`);
      //vrLogger.addPersistentLog(`[TP] Clés properties: [${Object.keys(properties).slice(0, 15).join(', ')}]`);

      // 1. Chercher d'abord dans les paramètres (comme pour le spawn)
      const parameterKeys = [
        'location', 'position', 'origin', 'basePoint', 'insertionPoint',
        'transform', 'placement', 'coordinate', 'point'
      ];

      // Chercher dans les propriétés directes
      for (const key of parameterKeys) {
        const posData = rawData[key] || properties[key];
        if (posData && typeof posData === 'object') {
          const coords = extractCoordinates(posData, key);
          if (coords) {
            //vrLogger.addPersistentLog(`[TP] Position trouvée via ${key}: x=${coords.x}, y=${coords.y}, z=${coords.z}`);
            
            // Appliquer la transformation Speckle -> Viewer
            const transformed = applySpeckleTransform(coords);
            //vrLogger.addPersistentLog(`[TP] Après transformation: x=${transformed.x}, y=${transformed.y}, z=${transformed.z}`);
            
            // Convertir en coordonnées Three.js
            const finalPos = specklePointToThreeMeters(viewer, transformed);
            //vrLogger.addPersistentLog(`[TP] ✅ Position finale: (${finalPos.x.toFixed(2)}, ${finalPos.y.toFixed(2)}, ${finalPos.z.toFixed(2)})`);
            
            return finalPos;
          }
        }
      }

      // 2. Chercher dans les paramètres Speckle (Instance/Type Parameters)
      const paramSources = [
        properties?.Parameters?.['Instance Parameters'],
        properties?.Parameters?.['Type Parameters'],
        rawData['Instance Parameters'],
        rawData['Type Parameters']
      ];

      for (const paramSource of paramSources) {
        if (!paramSource || typeof paramSource !== 'object') continue;
        
        //vrLogger.addPersistentLog(`[TP] Analyse paramètres, clés: [${Object.keys(paramSource).slice(0, 10).join(', ')}]`);
        
        for (const key in paramSource) {
          const param = paramSource[key];
          if (param && typeof param === 'object') {
            // Chercher des paramètres de position
            if (key.toLowerCase().includes('location') || 
                key.toLowerCase().includes('position') ||
                key.toLowerCase().includes('point')) {
              
              const coords = extractCoordinates(param, key);
              if (coords) {
                //vrLogger.addPersistentLog(`[TP] Position trouvée via paramètre ${key}: x=${coords.x}, y=${coords.y}, z=${coords.z}`);
                
                const transformed = applySpeckleTransform(coords);
                //vrLogger.addPersistentLog(`[TP] Après transformation: x=${transformed.x}, y=${transformed.y}, z=${transformed.z}`);
                
                const finalPos = specklePointToThreeMeters(viewer, transformed);
                //vrLogger.addPersistentLog(`[TP] ✅ Position finale via paramètre: (${finalPos.x.toFixed(2)}, ${finalPos.y.toFixed(2)}, ${finalPos.z.toFixed(2)})`);
                
                return finalPos;
              }
            }
          }
        }
      }

      // 3. Fallback: chercher toute propriété qui ressemble à des coordonnées
      function searchAllProperties(obj: any, path = ''): {x: number, y: number, z: number} | null {
        if (!obj || typeof obj !== 'object') return null;
        
        for (const key in obj) {
          const val = obj[key];
          const currentPath = path ? `${path}.${key}` : key;
          
          // Test direct si c'est des coordonnées
          const coords = extractCoordinates(val, currentPath);
          if (coords) {
            //vrLogger.addPersistentLog(`[TP] Coordonnées trouvées via ${currentPath}: x=${coords.x}, y=${coords.y}, z=${coords.z}`);
            return coords;
          }
          
          // Récursion limitée
          if (typeof val === 'object' && path.split('.').length < 3) {
            const result = searchAllProperties(val, currentPath);
            if (result) return result;
          }
        }
        return null;
      }

      const fallbackCoords = searchAllProperties(rawData);
      if (fallbackCoords) {
        const transformed = applySpeckleTransform(fallbackCoords);
        const finalPos = specklePointToThreeMeters(viewer, transformed);
        //vrLogger.addPersistentLog(`[TP] ✅ Position fallback: (${finalPos.x.toFixed(2)}, ${finalPos.y.toFixed(2)}, ${finalPos.z.toFixed(2)})`);
        return finalPos;
      }

      //vrLogger.addPersistentLog('[TP] ❌ Aucune position trouvée dans les paramètres Speckle');
      return null;

    } catch (error) {
      //vrLogger.addPersistentLog(`[TP] ERREUR: ${(error as Error).message}`);
      return null;
    }
  }

  // Fonction utilitaire pour extraire des coordonnées depuis différents formats
  function extractCoordinates(data: any, source: string): {x: number, y: number, z: number} | null {
    if (!data || typeof data !== 'object') return null;
    
    let x, y, z;
    
    // Format 1: {x, y, z}
    if (typeof data.x === 'number' && typeof data.y === 'number' && typeof data.z === 'number') {
      x = data.x; y = data.y; z = data.z;
    }
    // Format 2: {X, Y, Z}
    else if (typeof data.X === 'number' && typeof data.Y === 'number' && typeof data.Z === 'number') {
      x = data.X; y = data.Y; z = data.Z;
    }
    // Format 3: Tableau [x, y, z]
    else if (Array.isArray(data) && data.length >= 3 && 
            typeof data[0] === 'number' && typeof data[1] === 'number' && typeof data[2] === 'number') {
      x = data[0]; y = data[1]; z = data[2];
    }
    // Format 4: Propriété value imbriquée
    else if (data.value) {
      return extractCoordinates(data.value, source + '.value');
    }
    // Format 5: Paramètre Speckle avec propriété value
    else if (data.speckletype && data.value !== undefined) {
      if (typeof data.value === 'string') {
        // Parfois les coordonnées sont en string format "x,y,z"
        const parts = data.value.split(',').map((p: string) => parseFloat(p.trim()));
        if (parts.length >= 3 && parts.every((p: number) => !isNaN(p))) {
          x = parts[0]; y = parts[1]; z = parts[2];
        }
      } else {
        return extractCoordinates(data.value, source + '.speckleValue');
      }
    }
    
    // Validation finale
    if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number' && 
        !isNaN(x) && !isNaN(y) && !isNaN(z)) {
      return { x, y, z };
    }
    
    return null;
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

  // Version modifiée de updateVrMenuPlane avec indicateurs de scroll
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
    const headerText = menuMode === 'tpList' ? 'TELEPORTATION' : menuMode === 'image360List' ? 'IMAGES 360' : 'MENU VR ACTIF';
    ctx.fillText(headerText, canvas.width / 2, 85);
    ctx.textAlign = 'left';

    // Zone de clipping pour les boutons scrollables
    if (menuMode === 'tpList' || menuMode === 'image360List') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(40, 150, canvas.width - 80, 400);
      ctx.clip();
    }

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
      ctx.lineWidth = 4;
      ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
      
      ctx.fillStyle = textColor;
      ctx.font = 'bold 32px Arial';
      ctx.fillText(button.currentLabel, bounds.x + 20, bounds.y + 50);
    });

    if (menuMode === 'tpList') {
      ctx.restore();
      
      // Indicateurs de scroll
      if (maxScrollOffset > 0) {
        const scrollBarHeight = 300;
        const scrollBarY = 200;
        const scrollBarX = canvas.width - 40;
        
        // Barre de scroll background
        ctx.fillStyle = '#333333';
        ctx.fillRect(scrollBarX, scrollBarY, 20, scrollBarHeight);
        
        // Position du curseur de scroll
        const scrollRatio = menuScrollOffset / maxScrollOffset;
        const cursorHeight = Math.max(20, scrollBarHeight * (5 / (teleportPoints.length + 1)));
        const cursorY = scrollBarY + (scrollBarHeight - cursorHeight) * scrollRatio;
        
        ctx.fillStyle = '#ff6b00';
        ctx.fillRect(scrollBarX, cursorY, 20, cursorHeight);
        
        // Flèches de scroll
        ctx.fillStyle = menuScrollOffset > 0 ? '#00ff00' : '#666666';
        ctx.font = 'bold 24px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('▲', scrollBarX + 10, scrollBarY - 10);
        
        ctx.fillStyle = menuScrollOffset < maxScrollOffset ? '#00ff00' : '#666666';
        ctx.fillText('▼', scrollBarX + 10, scrollBarY + scrollBarHeight + 30);
      }
    }

    // Instructions en bas
    ctx.fillStyle = '#00ff00';
    ctx.font = 'bold 24px Arial';
    ctx.textAlign = 'left';
    if (menuMode === 'tpList' && maxScrollOffset > 0) {
      ctx.fillText('Stick droit: Scroll | Gâchette: Sélectionner', 50, canvas.height - 30);
    } else {
      ctx.fillText('Visez avec le contrôleur - Gâchette pour cliquer', 50, canvas.height - 30);
    }

    // Debug info
    ctx.fillStyle = '#888888';
    ctx.font = '16px Arial';
    ctx.fillText(`Survolé: ${menuState.hoveredButtonId || 'aucun'} | Scroll: ${menuScrollOffset}/${maxScrollOffset}`, 50, canvas.height - 60);

    // Mettre à jour la texture
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 16;
    tex.needsUpdate = true;
    (menuMesh.material as THREE.MeshBasicMaterial).map = tex;
    (menuMesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
  }

  // Fonction pour gérer le scroll du menu
  function handleMenuScroll(yInput: number) {
    if ((menuMode !== 'tpList' && menuMode !== 'image360List') || maxScrollOffset <= 0) return;
    
    const scrollSpeed = 30;
    const deadzone = 0.15;
    
    if (Math.abs(yInput) > deadzone) {
      const prevOffset = menuScrollOffset;
      menuScrollOffset -= yInput * scrollSpeed;
      menuScrollOffset = Math.max(0, Math.min(menuScrollOffset, maxScrollOffset));
      
      if (Math.abs(menuScrollOffset - prevOffset) > 1) {
        if (menuMode === 'tpList') {
          menuState.buttons = buildTeleportButtons();
        } else if (menuMode === 'image360List') {
          menuState.buttons = buildImage360Buttons();
        }
        return true;
      }
    }
    
    return false;
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

  function setAllCamerasClipping(renderer: any, near = 0.002, far = 2000) {
    // caméra XR (est un "ArrayCamera" contenant .cameras)
    const xrCam:any = renderer.xr.getCamera();
    const list: THREE.Camera[] =
      (xrCam && xrCam.cameras && Array.isArray(xrCam.cameras)) ? xrCam.cameras : (xrCam ? [xrCam] : []);
    for (const c of list) {
      if ('near' in c) (c as any).near = near;
      if ('far' in c)  (c as any).far = far;  // Augmenter cette valeur
      (c as any).updateProjectionMatrix?.();
    }
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

  // Fonction pour créer un laser visible
  function createLaser(color: number = 0xff0000): THREE.Line {
    const points = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -2)
    ];
    
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.8,
      depthTest: false,    
      depthWrite: false   
    });
    
    const line = new THREE.Line(geometry, material);
    line.name = 'VR_LASER';
    line.visible = true;
    line.frustumCulled = false;
    line.renderOrder = 1001; // Plus élevé que le menu (1000)
    
    return line;
  }

  // Fonction pour mettre à jour la longueur et la visibilité du laser
  function updateLaser(laser: THREE.Line, controller: THREE.Object3D, menuMesh: THREE.Mesh | null) {
    if (!laser || !controller) return;

    // Force la visibilité
    laser.visible = true;
    
    // Vérifier que le laser est bien attaché
    if (!controller.children.includes(laser)) {
      controller.add(laser);
    }
    
    // Créer un raycaster depuis le contrôleur
    const raycaster = new THREE.Raycaster();
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3(0, 0, -1);
    
    controller.getWorldPosition(origin);
    direction.transformDirection(controller.matrixWorld);
    raycaster.set(origin, direction);
    
    let intersectionDistance = 2; // Distance par défaut
    let laserColor = 0xff0000; // Rouge par défaut
    
    // Si le menu est visible, tester l'intersection
    if (menuMesh && menuMesh.visible) {
      const intersects = raycaster.intersectObject(menuMesh);
      if (intersects.length > 0) {
        intersectionDistance = intersects[0].distance;
        laserColor = 0x00ff00; // Vert quand on vise le menu
      }
    }
    
    // Mettre à jour la géométrie du laser
    const points = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -intersectionDistance)
    ];
    
    const geometry = laser.geometry as THREE.BufferGeometry;
    geometry.setFromPoints(points);
    geometry.attributes.position.needsUpdate = true;
    
    // Mettre à jour la couleur
    (laser.material as THREE.LineBasicMaterial).color.setHex(laserColor);
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

        setAllCamerasClipping(threeRenderer, 0.002, 5000);

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

        // Créer le panel de debug
        //debugText = createDebugPanel();
        //scene.add(debugText);

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

        const SPEED_BASE = 5.0;     // m/s (plus rapide qu’avant)
        const VERT_SPEED = 3.0;     // m/s montée/descente drone
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
              //vrLogger.addPersistentLog('🚀 XR SPAWN INITIALISE');
              vrLogger.addLog(`TreeNodeMap size: ${treeNodeMap?.size || 0}`);
              
              // FORCER l'appel sans condition
              upsertAllTeleportPoints(treeNodeMap, viewer);

              if (vrMenu) setMenuMode('tpList' === menuMode ? 'tpList' : 'root', vrMenu);
            }
          }

          const cam = threeRenderer.xr.getCamera();
          if (cam) {
            // Forcer des paramètres de clipping généreux
            const cameras = cam.cameras || [cam];
            for (const camera of cameras) {
              if (camera.near !== 0.001) {
                camera.near = 0.001;  // Très proche
                camera.far = 10000;   // Très loin
                camera.updateProjectionMatrix();
              }
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
                // Si le menu TP est ouvert, utiliser pour scroll
                if (vrMenuVisible && (menuMode === 'tpList' || menuMode === 'image360List')) {
                  const scrollChanged = handleMenuScroll(-y); 
                  if (scrollChanged && vrMenu) {
                    updateVrMenuPlane(vrMenu);
                  }
                } else {
                  // Mode vol normal
                  const dt = 1 / 60;
                  moveOffset.y += (-y) * VERT_SPEED * dt;
                }
              }
            }
            // === MISE À JOUR DES LASERS ===
            if (laserLine0 && controller0) {
              // Laser visible seulement si menu ouvert ou toujours (selon vos préférences)
              const shouldShowLaser = vrMenuVisible || true; // Mettre false si vous voulez masquer quand menu fermé
              laserLine0.visible = shouldShowLaser;
              
              if (shouldShowLaser) {
                updateLaser(laserLine0, controller0, vrMenu);
              }
            }

            if (laserLine1 && controller1) {
              const shouldShowLaser = vrMenuVisible || true; // Mettre false si vous voulez masquer quand menu fermé
              laserLine1.visible = shouldShowLaser;
              
              if (shouldShowLaser) {
                updateLaser(laserLine1, controller1, vrMenu);
              }
            }

            // Dans la section de nettoyage (session.addEventListener('end', ...)), ajoutez :
            // Nettoyer les lasers
            if (laserLine0) {
              controller0?.remove(laserLine0);
              laserLine0 = null;
            }
            if (laserLine1) {
              controller1?.remove(laserLine1);
              laserLine1 = null;
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
                case 'image360':
                  if (panoOverlay && panoOverlay.getIsVisible()) {
                    vrLogger.addPersistentLog('🚫 ACTION: Masquer Image 360');
                    panoOverlay.hide();
                    // Reconstruire le menu pour remettre le label "Images 360"
                    setMenuMode('root', vrMenu);
                  } else {
                    debugLines.push('Action: Ouvrir sous-menu Images 360');
                    setMenuMode('image360List', vrMenu);
                  }
                break;
                case 'back':
                  debugLines.push('Action: Retour au menu principal');
                  setMenuMode('root', vrMenu);
                  break;
                default:
                  const tp = teleportPoints.find(p => p.id === hoveredButtonId);
                  if (tp) {
                    if (menuMode === 'image360List') {
                      debugLines.push(`Action: Afficher image 360 pour ${tp.label}`);
                      vrLogger.addPersistentLog(`📷 DEBUT ACTION IMAGE 360 pour: ${tp.label}`);
                      
                      // Récupérer l'URL de l'image depuis les paramètres Speckle
                      const originalId = tp.id.replace('tp_', '');
                      vrLogger.addPersistentLog(`📷 ID original extrait: ${originalId}`);
                      
                      const tn = treeNodeMap.get(originalId);
                      
                      if (tn) {
                        const props = tn?.model?.raw?.properties;
                        
                        if (props) {
                          const parameterUrl = findParameterByName(props, 'URL_PANO');
                          
                          if (parameterUrl && parameterUrl.value) {
                            vrLogger.addPersistentLog(`📷 URL_PANO trouvée: ${parameterUrl.value}`);
                            
                            // Convertir l'URL pano.html en image.jpg
                            let imageUrl = parameterUrl.value;
                            if (imageUrl.includes('pano.html')) {
                              imageUrl = imageUrl.replace('pano.html', 'image.jpg');
                            }
                            
                            vrLogger.addPersistentLog(`📷 URL image convertie: ${imageUrl}`);
                            
                            // D'abord téléporter
                            teleportToWorldPosition(tp.position, threeRenderer);
                            
                            // Puis afficher l'image avec le nouveau système
                            setTimeout(() => {
                              vrLogger.addPersistentLog(`📷 Chargement image avec PanoSphereOverlay...`);
                              
                              panoOverlay.show(imageUrl)
                              .then(() => {
                                vrLogger.addPersistentLog(`📷 ✅ IMAGE 360 AFFICHÉE!`);
                                
                                // Forcer le rendu
                                viewer.requestRender();
                                
                                // IMPORTANT : Reconstruire le menu pour ajouter le bouton "Masquer"
                                if (vrMenu) {
                                  setMenuMode('root', vrMenu);
                                  vrLogger.addPersistentLog(`📷 Menu reconstruit avec bouton Masquer`);
                                }
                              })
                              .catch(error => {
                                vrLogger.addPersistentLog(`📷 ❌ ERREUR: ${error.message}`);
                              });                                
                            }, 100);
                            
                          } else {
                            vrLogger.addPersistentLog(`📷 ❌ URL_PANO non trouvée`);
                          }
                        }
                      } else {
                        vrLogger.addPersistentLog(`📷 ❌ TreeNode non trouvé pour ID: ${originalId}`);
                      }
                      
                      // Fermer le menu
                      vrMenuVisible = false;
                      if (vrMenu) vrMenu.visible = false;
                      
                    } else {
                      // Téléportation normale
                      debugLines.push(`Action: TP vers ${tp.label}`);
                      teleportToWorldPosition(tp.position, threeRenderer);
                      vrMenuVisible = false;
                      if (vrMenu) vrMenu.visible = false;
                    }
                  } else {
                    debugLines.push(`Bouton non géré: ${hoveredButtonId}`);
                    vrLogger.addPersistentLog(`⚠️ Bouton non géré: ${hoveredButtonId}`);
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

          // Créer les lasers seulement quand les contrôleurs sont prêts
          if (!laserLine0 && controller0 && controller0.visible) {
            laserLine0 = createLaser(0xff0000);
            controller0.add(laserLine0);
            debugLines.push('Laser 0 créé et attaché');
          }
          
          if (!laserLine1 && controller1 && controller1.visible) {
            laserLine1 = createLaser(0x00ff00);
            controller1.add(laserLine1);
            debugLines.push('Laser 1 créé et attaché');
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

          // Nettoyer les lasers
          if (laserLine0) {
            controller0?.remove(laserLine0);
            laserLine0 = null;
          }
          if (laserLine1) {
            controller1?.remove(laserLine1);
            laserLine1 = null;
          }
          
          // Retirer les contrôleurs
          scene.remove(controller0);
          scene.remove(controller1);
          scene.remove(controllerGrip0);
          scene.remove(controllerGrip1);
          
          viewer.requestRender();
        });


        // 🔢 tes coordonnées Speckle (en cm) lues dans properties.location
        const targetSpeckle = { x: 7310.294959203261, y: -1563.358968165413, z: 4290.0 };

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

    // // Bouton "Quitter la VR"
    // const btnExitVR: any = folderVR.addButton({ title: 'Quitter la VR' });
    // btnExitVR.on('click', () => {
    //   threeRenderer.xr.getSession?.()?.end();
    // });


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