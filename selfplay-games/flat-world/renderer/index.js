import * as THREE from 'https://esm.sh/three@0.160.0'

function rotationToQuaternion(rot) {
  const m = new THREE.Matrix4()
  m.set(
    rot[0][0], rot[0][1], rot[0][2], 0,
    rot[1][0], rot[1][1], rot[1][2], 0,
    rot[2][0], rot[2][1], rot[2][2], 0,
    0, 0, 0, 1,
  )
  return new THREE.Quaternion().setFromRotationMatrix(m)
}

function createEntityVisual(entity) {
  const role = (entity.render && entity.render.role) || entity.name || ''
  const size = entity.size || [1, 1, 1]

  if (role === 'Ground') {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size[0], size[1], size[2]),
      new THREE.MeshStandardMaterial({ color: 0x78b450, roughness: 0.8 }),
    )
    mesh.receiveShadow = true
    return mesh
  }

  // Default: box with entity color
  const color = entity.render && entity.render.color
    ? (Math.round(entity.render.color[0] * 255) << 16) |
      (Math.round(entity.render.color[1] * 255) << 8) |
      Math.round(entity.render.color[2] * 255)
    : 0x999999

  let geometry
  const primitive = entity.render && entity.render.primitive
  if (primitive === 'cylinder') geometry = new THREE.CylinderGeometry(size[0] / 2, size[0] / 2, size[1], 16)
  else if (primitive === 'sphere') geometry = new THREE.SphereGeometry(size[0] / 2, 16, 16)
  else geometry = new THREE.BoxGeometry(size[0], size[1], size[2])

  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2 }))
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

export function createRenderer(ctx) {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x87ceeb)

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000)

  const renderer = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true })
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.2
  renderer.outputColorSpace = THREE.SRGBColorSpace

  // Lights
  scene.add(new THREE.AmbientLight(0xffffff, 0.5))
  scene.add(new THREE.HemisphereLight(0x87ceeb, 0x78b450, 0.4))

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.0)
  dirLight.position.set(20, 30, 10)
  dirLight.castShadow = true
  dirLight.shadow.mapSize.set(2048, 2048)
  dirLight.shadow.camera.left = -60
  dirLight.shadow.camera.right = 60
  dirLight.shadow.camera.top = 60
  dirLight.shadow.camera.bottom = -60
  dirLight.shadow.camera.near = 1
  dirLight.shadow.camera.far = 200
  dirLight.shadow.bias = -0.001
  scene.add(dirLight)
  scene.add(dirLight.target)

  const stateBuffer = ctx.runtime.state.createSnapshotBuffer({ maxSnapshots: 8, interpolationDelayMs: 100 })
  const entityObjects = new Map()

  let followTargetPos = new THREE.Vector3(0, 4, 0)
  let camPos = new THREE.Vector3(0, 15, -20)
  let camTarget = new THREE.Vector3(0, 2, 0)

  function updateCamera() {
    const tp = followTargetPos
    const ideal = new THREE.Vector3(tp.x, tp.y + 12, tp.z - 20)
    camPos.lerp(ideal, 0.05)
    camera.position.copy(camPos)
    camTarget.lerp(tp.clone().add(new THREE.Vector3(0, 2, 0)), 0.08)
    camera.lookAt(camTarget)
    dirLight.position.set(tp.x + 20, 30, tp.z + 10)
    dirLight.target.position.copy(tp)
  }

  function updateScene(obs) {
    const activeIds = new Set()

    for (const entity of obs.entities || []) {
      activeIds.add(entity.id)
      let obj = entityObjects.get(entity.id)
      if (!obj) {
        obj = createEntityVisual(entity)
        entityObjects.set(entity.id, obj)
        scene.add(obj)
      }

      obj.position.set(entity.position[0], entity.position[1], entity.position[2])
      if (entity.rotation) obj.quaternion.copy(rotationToQuaternion(entity.rotation))
      obj.visible = !(entity.render && entity.render.visible === false)
    }

    for (const [id, obj] of entityObjects.entries()) {
      if (!activeIds.has(id)) {
        scene.remove(obj)
        entityObjects.delete(id)
      }
    }

    const players = obs.players || []
    if (players.length > 0) {
      const target = players[0]
      followTargetPos.set(target.position[0], target.position[1], target.position[2])
    }
  }

  return {
    onResize({ width, height }) {
      camera.aspect = width / Math.max(1, height)
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
    },

    onState(state) {
      stateBuffer.push(state)
      const obs = stateBuffer.interpolated() || state
      updateScene(obs)
      updateCamera()
      renderer.render(scene, camera)
    },

    unmount() {
      for (const obj of entityObjects.values()) scene.remove(obj)
      entityObjects.clear()
      renderer.dispose()
    },
  }
}
