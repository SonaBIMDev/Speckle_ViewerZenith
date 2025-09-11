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

// Fonction améliorée pour mettre à jour le debug
function updateDebugPanel(debugMesh: THREE.Mesh | null, lines: string[]) {
  if (!debugMesh) return;
  
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
  ctx.font = 'bold 28px monospace';
  ctx.fillText('DEBUG VR CONSOLE', 20, 35);
  
  // Lignes de debug
  ctx.font = '20px monospace';
  lines.forEach((line, i) => {
    if (i < 25) { // Limiter le nombre de lignes
      ctx.fillText(line.substring(0, 60), 20, 70 + (i * 22)); // Limiter la longueur
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
  
  // Crée un panneau 2D (plane) avec une texture canvas (titre + 3 items fictifs)
  function createVrMenuPlane(): THREE.Mesh {
    const w = 2.0;   // Plus large pour être plus visible
    const h = 1.2;   // Plus haut

    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 768;
    const ctx = canvas.getContext('2d')!;

    // Fond avec couleur très contrastée
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Bordure très visible
    ctx.strokeStyle = '#ff6b00'; // Orange vif
    ctx.lineWidth = 12;
    ctx.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
    
    // Header très contrasté
    ctx.fillStyle = '#ff6b00';
    ctx.fillRect(20, 20, canvas.width - 40, 100);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 52px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('MENU VR ACTIF', canvas.width / 2, 85);

    // Reset text align
    ctx.textAlign = 'left';

    // Items avec couleurs très contrastées
    const items = ['Téléportation', 'Paramètres', 'Retour Desktop'];
    items.forEach((label, i) => {
      const y = 160 + i * 140;
      // Bouton avec gradient
      const gradient = ctx.createLinearGradient(50, y, canvas.width - 50, y + 100);
      gradient.addColorStop(0, '#0066cc');
      gradient.addColorStop(1, '#004499');
      ctx.fillStyle = gradient;
      ctx.fillRect(50, y, canvas.width - 100, 100);
      
      // Bordure du bouton
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 6;
      ctx.strokeRect(50, y, canvas.width - 100, 100);
      
      // Texte blanc
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 42px Arial';
      ctx.fillText(label, 80, y + 65);
    });

    // Indicateur d'état en bas
    ctx.fillStyle = '#00ff00';
    ctx.font = 'bold 32px Arial';
    ctx.fillText('MENU VISIBLE - Appuyez A/B pour fermer', 50, canvas.height - 30);

    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 16;
    tex.needsUpdate = true;

    const mat = new THREE.MeshBasicMaterial({ 
      map: tex, 
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: false,  // Toujours visible
      depthWrite: false
    });
    const geo = new THREE.PlaneGeometry(w, h);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'VR_MENU_PANEL';
    mesh.renderOrder = 1000; // S'assurer qu'il se rend en dernier
    
    return mesh;
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
    title: 'VR (Quest) V2',
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


        // --- RAF WebXR natif : manettes sans setAnimationLoop ---
        let xrAfId: number | null = null;

        const moveOffset = new THREE.Vector3();     // x,z pour marcher + y pour le drone
        const tmpDir     = new THREE.Vector3();
        const rightVec   = new THREE.Vector3();

        const SPEED_BASE = 3.0;     // m/s (plus rapide qu’avant)
        const VERT_SPEED = 2.0;     // m/s montée/descente drone
        const DZ         = 0.15;    // deadzone sticks

        const AB_INDICES = [4, 5];

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

          for (const [i, src] of session.inputSources.entries()) {
            debugLines.push(`Source ${i}: ${src.handedness || 'none'}`);
            
            if (!(src as any).gamepad) {
              debugLines.push(`  No gamepad`);
              continue;
            }
            
            const gp = (src as any).gamepad as Gamepad;
            debugLines.push(`  Gamepad: ${gp.buttons?.length || 0} buttons`);
            
            // Déplacement (stick gauche)
            if (src.handedness === 'left') {
              const { x, y } = getAxes(src);
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
            
            // Montée/descente (stick droit)
            if (src.handedness === 'right') {
              const { x, y } = getAxes(src);
              if (Math.abs(y) > DZ) {
                const dt = 1 / 60;
                moveOffset.y += (-y) * VERT_SPEED * dt;
              }
            }
          }

          // Déplacement
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
          
          // Analyser chaque contrôleur
          for (const [index, inputSource] of session.inputSources.entries()) {
            const hand = inputSource.handedness || 'unknown';
            debugLines.push(`--- Contrôleur ${index} (${hand}) ---`);
            
            const { pressed, justPressed } = controllerManager.getButtonStates(inputSource);
            
            debugLines.push(`Boutons pressés: [${pressed.join(', ')}]`);
            debugLines.push(`Nouveaux appuis: [${justPressed.join(', ')}]`);
            
            // Si n'importe quel bouton est pressé pour la première fois, toggle le menu
            if (hand === 'right') {
              if (justPressed.some(i => AB_INDICES.includes(i))) {
                menuToggleRequested = true;
                debugLines.push(`>>> TOGGLE via A/B (indices ${justPressed.join(',')}) <<<`);
              }
            }
            
            // Info sur le gamepad
            const gamepad = (inputSource as any).gamepad as Gamepad | undefined;
            if (gamepad) {
              debugLines.push(`Gamepad: ${gamepad.buttons?.length || 0} boutons`);
              if (gamepad.axes) {
                const axes = Array.from(gamepad.axes).map(a => a.toFixed(2));
                debugLines.push(`Axes: [${axes.join(', ')}]`);
              }
            } else {
              debugLines.push(`Aucun gamepad détecté`);
            }
          }
          
          // Gestion du menu
          if (menuToggleRequested) {
            vrMenuVisible = !vrMenuVisible;
            debugLines.push(`MENU ${vrMenuVisible ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`);
            
            // Créer le menu s'il n'existe pas
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
          
          debugLines.push(`--- État Menu ---`);
          debugLines.push(`Menu existe: ${vrMenu ? 'OUI' : 'NON'}`);
          debugLines.push(`Menu visible: ${vrMenuVisible}`);
          debugLines.push(`Menu dans scène: ${vrMenu && scene.children.includes(vrMenu) ? 'OUI' : 'NON'}`);
          
          // Positionner le menu
          if (vrMenu && vrMenuVisible) {
            const positioned = positionMenuInFrontOfUser(vrMenu, threeRenderer);
            debugLines.push(`Menu positionné: ${positioned ? 'OUI' : 'NON'}`);
          }
          
          // Positionner le debug panel
          if (debugText) {
            const cam = threeRenderer.xr.getCamera();
            if (cam) {
              const camPos = new THREE.Vector3(); cam.getWorldPosition(camPos);
              const fwd   = new THREE.Vector3();  cam.getWorldDirection(fwd);
              // const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0,1,0)).normalize();

              const p = camPos.clone().addScaledVector(fwd, MENU_DISTANCE);
              p.y += MENU_Y_OFFSET;

              debugText.position.copy(p);
              debugText.lookAt(camPos);
            }
          }
          
          // Mettre à jour l'affichage debug
          updateDebugPanel(debugText, debugLines);
          
          viewer.requestRender();
          xrAfId = session.requestAnimationFrame(onXRFrame);
        }

        // démarrer la boucle XR
        xrAfId = session.requestAnimationFrame(onXRFrame);


        // N'oubliez pas de nettoyer les états quand la session se ferme
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