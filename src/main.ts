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
} from '@speckle/viewer';

//import { makeMeasurementsUI } from './MeasurementsUI'; // Interface utilisateur pour les mesures
import { Box3 } from 'three'; // Utilisé pour gérer des boîtes englobantes en 3D
import { Pane } from 'tweakpane'; // Bibliothèque pour créer une interface utilisateur (boutons, menus, etc.)

interface Param {
  id: string;
  name: string;
  units: number;
  value: string;
  speckletype: string;
}

async function main() {
  let btnUrlDoc: any = null;

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
  const viewer = new Viewer(container, params);
  /** Initialise the viewer */
  await viewer.init();

  /** Add the stock camera controller extension */
  const cameraController: CameraController =
    viewer.createExtension(CameraController);

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
  const treeNodeMap = new Map<string, TreeNode>();
  //get all generic_models
  const tn_GenericModels: TreeNode[] = viewer
    .getWorldTree()
    .findAll((node: TreeNode) => {
      if (!node.model.raw.category) return null;
      if (!node.model.atomic) return null;
      return node.model.raw.category.includes('Generic Models');
    });

  // Remplir la Map
  tn_GenericModels.forEach((node) => {
    treeNodeMap.set(node.model.raw.elementId, node);
  });

  //#region Pane
  const pane = new Pane({ title: 'UI', expanded: true });
  (pane as any)
    .addBlade({
      view: 'list',
      label: 'Vues',
      options: [
        { text: 'General', value: 'general' },
        { text: 'Hall', value: 'hall' },
        { text: 'Scène', value: 'scene' },
        { text: 'Gradins', value: 'gradins' },
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
        case 'hall':
          // Rechercher dans cette liste le TreeNode avec l'elementId correspondant.
          tnFinded = treeNodeMap.get('1206565');
          break;
        case 'scene':
          // Rechercher dans cette liste le TreeNode avec l'elementId correspondant.
          tnFinded = treeNodeMap.get('1206442');
          break;
        case 'gradins':
          tnFinded = treeNodeMap.get('1206592');
          break;
      }

      if (tnFinded) {
        ZoomOnTreeNode(tnFinded);
        const id = tnFinded.model.id;
        console.log(`Id ${id} pour le node elementid ${elementid}`);
      } else {
        console.log(
          `Impossible de trouver le node pour l'elementid ${elementid}`
        );
      }
    });

  btnUrlDoc = (pane as any)
    .addButton({
      title: '...',
      disabled: true,
      label: 'panoramic', // optional
    })
    .on('click', () => {
      // L'action de clic initial est vide, car l'URL sera mise à jour plus tard
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
    const properties = targetTreeNode.model.raw;
    const parameterUrl: Param | null = findParameterByName(
      properties,
      'URL_PANO'
    );

    // Mettre à jour le bouton avec le nouveau paramètre URL_DOC trouvé
    updateButtonWithUrl(parameterUrl);
  }

  // Fonction pour rechercher récursivement une propriété dans un objet
  function findParameterByName(
    properties: { [key: string]: any },
    propertyName: string
  ): Param | null {
    // Vérifier si la propriété "parameters" existe
    if (properties.hasOwnProperty('parameters')) {
      const parameters = properties['parameters'];

      // Parcourir chaque clé dans 'parameters'
      for (const key in parameters) {
        if (parameters.hasOwnProperty(key)) {
          const param = parameters[key];

          // Vérifiez si la propriété 'name' de 'param' correspond à 'propertyName'
          if (
            param &&
            typeof param === 'object' &&
            param.name === propertyName
          ) {
            const foundParam: Param = {
              id: param.id || '',
              name: param.name || '',
              units: param.units || 0,
              value: param.value || '',
              speckletype: param.speckle_type || '',
            };
            return foundParam;
          }
        }
      }
    }
    return null; // Retourner null si la propriété recherchée n'est pas trouvée
  }

  // Fonction pour mettre à jour le bouton avec le paramètre URL_DOC trouvé
  function updateButtonWithUrl(parameterUrl: Param | null) {
    if (btnUrlDoc) {
      btnUrlDoc.dispose(); // Disposer du bouton précédent pour nettoyer les événements

      if (parameterUrl) {
        if (parameterUrl.value && parameterUrl.value.trim() !== '') {
          btnUrlDoc = (pane as any)
            .addButton({
              title: '...',
              disabled: false,
              index: 2,
              label: 'panoramic',
            })
            .on('click', () => {
              // Ouvre l'URL dans un nouvel
              window.open(parameterUrl.value, '_blank'); // Ouvre l'URL dans un nouvel onglet
            });
        } else {
          btnUrlDoc = (pane as any)
          .addButton({
            title: '...',
            disabled: true,
            index: 2,
            label: 'panoramic',
          });
        }
      } else {
        btnUrlDoc = (pane as any)
        .addButton({
          title: '...',
          disabled: true,
          index: 2,
          label: 'panoramic',
        });
      }
    }
  }
}

main();
