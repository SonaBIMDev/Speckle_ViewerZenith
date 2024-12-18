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
        ZoomOnTreeNode(tnFinded);
        const id = tnFinded.model.id;
        console.log(`Id ${id} pour le node elementid ${elementid}`);
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
        ZoomOnTreeNode(tnFinded);
        const id = tnFinded.model.id;
        console.log(`Id ${id} pour le node elementid ${elementid}`);
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
      // L'action de clic initial est vide, car l'URL sera mise à jour plus tard
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
