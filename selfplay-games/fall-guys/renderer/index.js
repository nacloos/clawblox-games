import * as THREE from 'https://esm.sh/three@0.160.0'
import { EffectComposer } from 'https://esm.sh/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'https://esm.sh/three@0.160.0/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'https://esm.sh/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js'
import { createJellybean, animateJellybean } from './jellybean.js'
import { buildSky, buildWater, buildClouds, buildDecorations, updateClouds, updateDecorations } from './course.js'
import { spawnConfetti, updateParticles } from './particles.js'

const AI_COLORS = [0xffd93d, 0x6c5ce7, 0x00b894, 0xe17055, 0x74b9ff, 0xa29bfe]
const AI_ACCESSORIES = ['crown', 'propeller', 'headband', 'cone']

function colorToHex(c) {
  if (!Array.isArray(c) || c.length !== 3) return 0x999999
  return (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255)
}

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

function classifyEntity(entity) {
  const role = (entity.render && entity.render.role) || entity.name || ''
  if (role.startsWith('Bot_')) return { type: 'bot', index: parseInt(role.split('_')[1], 10) || 0 }
  if (role.startsWith('SpinDisc_')) return { type: 'disc' }
  if (role.startsWith('HexTile_')) return { type: 'hex' }
  if (role.startsWith('PendBall_')) return { type: 'pendulum_ball' }
  if (role.startsWith('PendArm_')) return { type: 'pendulum_arm' }
  if (role.startsWith('PendPillar')) return { type: 'pendulum_pillar' }
  if (role.startsWith('PendBar_')) return { type: 'pendulum_bar' }
  if (role === 'Bridge') return { type: 'bridge' }
  if (role.startsWith('BridgeRail')) return { type: 'rail' }
  if (role.startsWith('Arch')) return { type: 'arch' }
  if (role.startsWith('Start') || role.startsWith('Transition') || role.startsWith('Finish')) return { type: 'platform' }
  return { type: 'generic' }
}

function resolveEntityModelUrl(entity) {
  if (typeof entity.model_url === 'string' && entity.model_url.length > 0) {
    return entity.model_url
  }
  const attrs = entity.attributes
  if (attrs && typeof attrs.ModelUrl === 'string' && attrs.ModelUrl.length > 0) {
    return attrs.ModelUrl
  }
  return null
}

function createEntityVisual(entity) {
  const cls = classifyEntity(entity)
  const size = entity.size || [1, 1, 1]
  const primitive = entity.render && entity.render.primitive
  const modelUrl = resolveEntityModelUrl(entity)

  if (modelUrl) {
    const root = new THREE.Group()
    root.userData.isModelEntity = true
    root.userData.modelUrl = modelUrl
    const fallback = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, 0.5, 8, 16),
      new THREE.MeshStandardMaterial({ color: 0xffa07a, roughness: 0.5, metalness: 0.05 }),
    )
    fallback.castShadow = true
    fallback.receiveShadow = true
    const scale = (size[1] || 5) / 1.3
    fallback.scale.setScalar(scale)
    root.add(fallback)
    return root
  }

  if (cls.type === 'bot') {
    const idx = Math.max(0, (cls.index || 1) - 1)
    const jelly = createJellybean(AI_COLORS[idx % AI_COLORS.length], AI_ACCESSORIES[idx % AI_ACCESSORIES.length])
    jelly.userData.isJellybean = true
    jelly.scale.setScalar((size[1] || 5) / 1.3)
    return jelly
  }

  if (cls.type === 'disc') {
    const group = new THREE.Group()
    const r = size[0] / 2
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, size[1], 32),
      new THREE.MeshStandardMaterial({ color: 0x74b9ff, roughness: 0.4, metalness: 0.1 }),
    )
    disc.castShadow = true
    disc.receiveShadow = true
    group.add(disc)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.3, r * 0.6, 32),
      new THREE.MeshStandardMaterial({ color: 0xdfe6e9, roughness: 0.5, side: THREE.DoubleSide }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = size[1] / 2 + 0.01
    group.add(ring)
    return group
  }

  if (cls.type === 'hex') {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(size[0] / 2, size[0] / 2, size[1], 6),
      new THREE.MeshStandardMaterial({ color: colorToHex(entity.render && entity.render.color), roughness: 0.4, metalness: 0.1 }),
    )
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.hex = true
    return mesh
  }

  if (cls.type === 'pendulum_ball') {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size[0] / 2, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0xe74c3c, roughness: 0.3, metalness: 0.3 }),
    )
    mesh.castShadow = true
    return mesh
  }

  const color = colorToHex(entity.render && entity.render.color)
  let geometry
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
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000)

  const renderer = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true })
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.2
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.4, 0.85))

  scene.add(new THREE.AmbientLight(0xffffff, 0.6))
  scene.add(new THREE.HemisphereLight(0x87ceeb, 0x98fb98, 0.4))

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
  dirLight.position.set(30, 50, 20)
  dirLight.castShadow = true
  dirLight.shadow.mapSize.set(2048, 2048)
  dirLight.shadow.camera.left = -80
  dirLight.shadow.camera.right = 80
  dirLight.shadow.camera.top = 80
  dirLight.shadow.camera.bottom = -80
  dirLight.shadow.camera.near = 1
  dirLight.shadow.camera.far = 200
  dirLight.shadow.bias = -0.001
  scene.add(dirLight)
  scene.add(dirLight.target)

  buildSky(scene)
  const waterMat = buildWater(scene)
  const clouds = buildClouds(scene)
  const decorations = buildDecorations(scene)

  const stateBuffer = ctx.runtime.state.createSnapshotBuffer({ maxSnapshots: 8, interpolationDelayMs: 100 })
  const entityObjects = new Map()
  const modelController = ctx.runtime.three.createModelEntityController(THREE, {
    onError(err, meta) {
      ctx.log('warn', 'Model entity load failed', { err: String(err), ...meta })
    },
  })

  let followTargetPos = new THREE.Vector3(0, 4, 20)
  let camPos = new THREE.Vector3(0, 16, -5)
  let camTarget = new THREE.Vector3(0, 6, 20)
  let finishTriggered = false
  const clock = new THREE.Clock()

  function updateCamera() {
    const tp = followTargetPos
    let ideal
    if (finishTriggered) {
      const t = performance.now() * 0.001
      ideal = new THREE.Vector3(tp.x + Math.sin(t * 0.5) * 30, tp.y + 15, tp.z + Math.cos(t * 0.5) * 30)
      camPos.lerp(ideal, 0.07)
    } else {
      ideal = new THREE.Vector3(tp.x * 0.3, tp.y + 12, tp.z - 25)
      camPos.lerp(ideal, 0.05)
    }

    camera.position.copy(camPos)
    camTarget.lerp(tp.clone().add(new THREE.Vector3(0, 4, 6)), 0.08)
    camera.lookAt(camTarget)
    dirLight.position.set(tp.x + 80, 120, tp.z + 60)
    dirLight.target.position.copy(tp)
  }

  function updateScene(obs, dt) {
    const activeIds = new Set()
    const stateByRootPartId = new Map()
    for (const player of obs.players || []) {
      if (typeof player.root_part_id === 'number' && typeof player.humanoid_state === 'string') {
        stateByRootPartId.set(player.root_part_id, player.humanoid_state)
      }
    }

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

      const prev = obj.userData.prevPos
      let speed = 0
      if (prev) {
        const dx = entity.position[0] - prev[0]
        const dz = entity.position[2] - prev[2]
        speed = Math.sqrt(dx * dx + dz * dz) / Math.max(dt, 0.001)
      }
      obj.userData.prevPos = [entity.position[0], entity.position[1], entity.position[2]]

      if (obj.userData && obj.userData.isJellybean) {
        animateJellybean(obj, speed, true, dt)
      }

      if (obj.userData && obj.userData.isModelEntity) {
        const modelUrl = resolveEntityModelUrl(entity)
        if (modelUrl) {
          void modelController.upsert({
            entityId: entity.id,
            root: obj,
            modelUrl,
            size: entity.size || [2, 5, 2],
            yawOffsetDeg: entity.model_yaw_offset_deg,
          })
          modelController.update(entity.id, {
            dt,
            speed,
            humanoidState: stateByRootPartId.get(entity.id) || null,
          })
        }
      }
    }

    for (const [id, obj] of entityObjects.entries()) {
      if (!activeIds.has(id)) {
        scene.remove(obj)
        modelController.remove(id)
        entityObjects.delete(id)
      }
    }

    const players = obs.players || []
    if (players.length > 0) {
      const target = players[0]
      followTargetPos.set(target.position[0], target.position[1], target.position[2])
      const state = target.attributes && target.attributes.GameState
      if (state === 'finished' && !finishTriggered) {
        finishTriggered = true
        spawnConfetti(scene, followTargetPos.clone().add(new THREE.Vector3(0, 3, 0)))
      }
    }
  }

  return {
    onResize({ width, height }) {
      camera.aspect = width / Math.max(1, height)
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
      composer.setSize(width, height)
    },

    onState(state) {
      stateBuffer.push(state)
      const obs = stateBuffer.interpolated() || state
      const dt = Math.min(clock.getDelta(), 0.05)
      const time = performance.now() * 0.001
      waterMat.uniforms.time.value = time
      updateClouds(clouds, dt)
      updateDecorations(decorations, time)
      updateParticles(scene, dt)
      updateScene(obs, dt)
      updateCamera()
      composer.render()
    },

    unmount() {
      for (const obj of entityObjects.values()) scene.remove(obj)
      entityObjects.clear()
      modelController.clear()
      renderer.dispose()
    },
  }
}
