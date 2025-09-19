// PanoSphereOverlay.ts
import * as THREE from 'three'
import type { Viewer } from '@speckle/viewer'

export class PanoSphereOverlay {
  private viewer: Viewer
  private scene: THREE.Scene
  private renderer: THREE.WebGLRenderer
  private sphere: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null = null
  private tex: THREE.Texture | null = null
  private radius = 10 // assez grand pour éviter le near-plane, mais on suit la caméra donc peu importe
  private onRenderBound: (() => void) | null = null
  private isVisible = false

  constructor(viewer: Viewer) {
    this.viewer = viewer
    // @ts-ignore
    this.scene = viewer.getRenderer().scene as THREE.Scene
    // @ts-ignore
    this.renderer = viewer.getRenderer().renderer as THREE.WebGLRenderer
  }

  /** Retourne true si une image 360 est actuellement affichée */
    getIsVisible(): boolean {
    return this.isVisible;
    }

  /** À appeler UNE fois après création pour brancher l’update par frame */
  attach() {
    if (this.onRenderBound) return
    this.onRenderBound = () => this.updateToCamera()
    // @ts-ignore
    this.viewer.on((THREE as any).ViewerEvent?.Render ?? 'render', this.onRenderBound)
  }

  /** Charge et affiche la sphère 360 */
  async show(imageUrl: string) {
    const loader = new THREE.TextureLoader()
    ;(loader as any).crossOrigin = 'anonymous'

    const tex = await new Promise<THREE.Texture>((resolve, reject) => {
      loader.load(
        imageUrl,
        (t) => resolve(t),
        undefined,
        (err) => reject(new Error(`Échec du chargement panorama: ${imageUrl} (${(err as any)?.message || err})`))
      )
    })

    // Réglages texture (équirectangulaire classique sur sphère UV)
    // NB: pas besoin d'EquirectangularMapping ici (utile surtout pour scene.background).
    ;(tex as any).colorSpace =
      (THREE as any).SRGBColorSpace ?? (tex as any).encoding ?? undefined
    tex.flipY = true
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    tex.needsUpdate = true
    this.tex = tex

    // Géométrie sphère
    const geom = new THREE.SphereGeometry(this.radius, 64, 48)
    // On rend l’intérieur visible
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      depthTest: false, // << clé: ne jamais être masquée par la maquette
      transparent: false
    })

    const sphere = new THREE.Mesh(geom, mat)
    sphere.frustumCulled = false
    sphere.matrixAutoUpdate = false
    sphere.renderOrder = 9999 // << passe après tout
    sphere.name = 'PANO_SPHERE_OVERLAY'

    this.sphere = sphere
    this.scene.add(sphere)

    // Positionner tout de suite au niveau caméra, puis suivra à chaque frame
    this.updateToCamera()

    this.isVisible = true
    this.requestRender()
  }

  /** Cache et détruit la sphère */
  hide() {
    if (this.sphere) {
      this.scene.remove(this.sphere)
      this.sphere.geometry.dispose()
      this.sphere.material.map?.dispose()
      this.sphere.material.dispose()
      this.sphere = null
    }
    this.tex = null
    this.isVisible = false
    this.requestRender()
  }

  /** À appeler si tu veux libérer complètement (détacher l’update) */
  detach() {
    if (this.onRenderBound) {
      // @ts-ignore
      this.viewer.off?.((THREE as any).ViewerEvent?.Render ?? 'render', this.onRenderBound)
      this.onRenderBound = null
    }
  }

  /** Suivre la caméra (desktop & WebXR) */
  private updateToCamera() {
    if (!this.sphere) return

    // En WebXR, Three fournit une ArrayCamera ; en desktop, c’est une PerspectiveCamera.
    // Le _vrai_ point de vue de rendu est le paramètre passé au renderer, donc on lit la caméra active via XR si possible :
    const xr = this.renderer.xr
    let activeCam: THREE.Camera | null = null
    if (xr && xr.isPresenting) {
      // Quand XR est actif, getCamera() retourne une ArrayCamera dont la matrice monde est la bonne.
      // On se cale sur SA position / quaternion.
      activeCam = xr.getCamera()
    } else {
      // @ts-ignore
      activeCam = this.viewer?.getRenderer()?.camera ?? null
    }
    if (!activeCam) return

    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    activeCam.getWorldPosition(pos)
    activeCam.getWorldQuaternion(quat)

    this.sphere.position.copy(pos)
    this.sphere.quaternion.copy(quat)
    this.sphere.updateMatrix()
  }

  private requestRender() {
    // @ts-ignore
    this.viewer.requestRender?.()
  }
}
