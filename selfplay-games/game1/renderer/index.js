import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js'

export function createRenderer(ctx) {
  // -- Scene ------------------------------------------------------------------
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x1a1f33)
  scene.fog = new THREE.FogExp2(0x1a1f33, 0.01)

  // -- Camera -----------------------------------------------------------------
  const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 500)

  // -- WebGL ------------------------------------------------------------------
  const webgl = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true })
  webgl.shadowMap.enabled = true
  webgl.shadowMap.type = THREE.PCFSoftShadowMap
  webgl.toneMapping = THREE.ACESFilmicToneMapping
  webgl.toneMappingExposure = 1.45

  // -- Lighting ---------------------------------------------------------------
  // Dim ambient (night feel)
  const ambient = new THREE.AmbientLight(0x2f3657, 0.75)
  scene.add(ambient)

  // Moonlight from above-right
  const moon = new THREE.DirectionalLight(0x7ea3e8, 0.95)
  moon.position.set(30, 50, 20)
  moon.castShadow = true
  moon.shadow.mapSize.set(2048, 2048)
  moon.shadow.camera.left = -60
  moon.shadow.camera.right = 60
  moon.shadow.camera.top = 60
  moon.shadow.camera.bottom = -60
  moon.shadow.camera.near = 1
  moon.shadow.camera.far = 120
  scene.add(moon)

  // Warm point light that follows the player (torch effect)
  const torchLight = new THREE.PointLight(0xffaa44, 2.5, 28, 1.5)
  torchLight.position.set(0, 4, 0)
  scene.add(torchLight)

  // Cool point light on the goal
  const goalLight = new THREE.PointLight(0x00ffbb, 3, 35, 1.2)
  goalLight.position.set(0, 6, 0)
  scene.add(goalLight)

  // Faint hemisphere light for gentle sky/ground fill
  const hemi = new THREE.HemisphereLight(0x5f82bf, 0x2b2a24, 0.5)
  scene.add(hemi)

  // -- Starfield --------------------------------------------------------------
  const starCount = 800
  const starPos = new Float32Array(starCount * 3)
  const starAlpha = new Float32Array(starCount)
  for (let i = 0; i < starCount; i++) {
    const theta = Math.random() * Math.PI * 2
    const phi = Math.random() * Math.PI * 0.45
    const r = 180 + Math.random() * 60
    starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    starPos[i * 3 + 1] = r * Math.cos(phi) + 40
    starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    starAlpha[i] = 0.3 + Math.random() * 0.7
  }
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
  const starMat = new THREE.PointsMaterial({
    color: 0xddeeff,
    size: 0.6,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.85,
  })
  scene.add(new THREE.Points(starGeo, starMat))

  // -- Runtime helpers --------------------------------------------------------
  const stateBuffer = ctx.runtime.state.createSnapshotBuffer({
    maxSnapshots: 12,
    interpolationDelayMs: 90,
  })
  const cameraModes = ctx.runtime.three.createCameraModeController(THREE, camera, {
    follow: { followDistance: 11, followHeight: 9, shoulderOffset: 0 },
    firstPersonHeight: 1.7,
  })

  const presetLib = ctx.runtime.three.createPresetMaterialLibrary({
    'example/floor': { roughness: 0.92, metalness: 0.05 },
    'example/wall': { roughness: 0.75, metalness: 0.12 },
    'example/spawn': { roughness: 0.2, metalness: 0.3, emissiveIntensity: 0.6 },
  })

  const entities = ctx.runtime.three.createEntityStore(scene)
  const playerMeshes = new Map()
  const tmpForward = new THREE.Vector3(0, 0, 1)
  let inputBinding = null
  let inputClient = null
  let localControlPlayer = null
  let elapsed = 0

  function createPlayerMesh() {
    const group = new THREE.Group()

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, 3.6, 16),
      new THREE.MeshStandardMaterial({
        color: 0xff8a55,
        roughness: 0.45,
        metalness: 0.08,
        emissive: 0x1a0b06,
        emissiveIntensity: 0.35,
      }),
    )
    body.position.y = 1.8
    body.castShadow = true
    body.receiveShadow = true
    group.add(body)

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.65, 18, 14),
      new THREE.MeshStandardMaterial({
        color: 0xffc39f,
        roughness: 0.5,
        metalness: 0.02,
      }),
    )
    head.position.y = 4.2
    head.castShadow = true
    head.receiveShadow = true
    group.add(head)

    return group
  }

  function upsertPlayerMesh(player) {
    let mesh = playerMeshes.get(player.id)
    if (!mesh) {
      mesh = createPlayerMesh()
      playerMeshes.set(player.id, mesh)
      scene.add(mesh)
    }
    if (Array.isArray(player.position)) {
      mesh.position.set(player.position[0], player.position[1], player.position[2])
    }
  }

  function prunePlayerMeshes(activePlayerIds) {
    for (const [id, mesh] of playerMeshes.entries()) {
      if (!activePlayerIds.has(id)) {
        scene.remove(mesh)
        playerMeshes.delete(id)
      }
    }
  }

  return {
    mount() {
      inputClient = ctx.runtime.input.createLocalInputClient({ playerName: 'renderer-local' })
      inputBinding = ctx.runtime.input.bindKeyboardActions(inputClient, {
        Space: { mode: 'tap', type: 'Jump', data: {} },
      })
    },

    onResize({ width, height }) {
      camera.aspect = width / Math.max(1, height)
      camera.updateProjectionMatrix()
      webgl.setSize(width, height, false)
    },

    onState(state) {
      stateBuffer.push(state)
      const obs = stateBuffer.interpolated() || state
      const activeIds = new Set()
      elapsed += 1 / 60

      for (const entity of obs.entities || []) {
        activeIds.add(entity.id)
        entities.upsert(
          entity,
          (next) => ctx.runtime.three.buildEntityMesh(THREE, next, presetLib),
          (mesh, next) => ctx.runtime.three.applyEntityTransform(THREE, mesh, next),
        )
      }
      entities.prune(activeIds)

      const activePlayerIds = new Set()
      for (const player of obs.players || []) {
        activePlayerIds.add(player.id)
        upsertPlayerMesh(player)
      }
      prunePlayerMeshes(activePlayerIds)

      // Camera follows first player
      const target = (obs.players || [])[0]
      if (target && Array.isArray(target.position)) {
        const pos = new THREE.Vector3(...target.position)
        const trackState = ctx.runtime.three.classifyAnimationTracks(target)
        const mode = trackState.reload ? 'spectator' : 'follow'
        cameraModes.update({
          mode,
          targetPosition: pos,
          targetForward: tmpForward,
          dt: 1 / 60,
        })

        // Torch light follows player with slight flicker
        const flicker = 2.2 + Math.sin(elapsed * 12) * 0.15 + Math.sin(elapsed * 7.3) * 0.1
        torchLight.intensity = flicker
        torchLight.position.set(pos.x, 4.5, pos.z)

        if (inputClient && localControlPlayer !== target.id && inputClient.session()) {
          localControlPlayer = target.id
        }
      }

      // Animate goal light
      const goalEntity = (obs.entities || []).find(e => e.name === 'Goal')
      if (goalEntity && Array.isArray(goalEntity.position)) {
        goalLight.position.set(goalEntity.position[0], 5, goalEntity.position[2])
        goalLight.intensity = 2.5 + Math.sin(elapsed * 3) * 1.2
      }

      webgl.render(scene, camera)
    },

    unmount() {
      if (inputBinding) inputBinding.dispose()
      for (const mesh of playerMeshes.values()) {
        scene.remove(mesh)
      }
      playerMeshes.clear()
      entities.clear()
      webgl.dispose()
    },
  }
}
